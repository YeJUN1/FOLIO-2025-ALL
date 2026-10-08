import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Logger, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { clearNodeTransform, compressTexture, dedup, getBounds, prune, simplify, transformMesh, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

/**
 * 规范化后处理：resources/hunyuan-raw/<key>.glb → static/garden/<key>.glb
 * 步骤：清理 → 压平层级(顶点化) → 尺寸归一(manifest.normalize) → 旋转修正(rotationFix)
 *      → Pivot 归零(底面中心=原点) → 减面(meshoptimizer) → 贴图压缩(sharp)
 *      → 注入物理碰撞体(collider=cuboid 时) → 材质唯一命名
 * 用法:
 *   node scripts/hunyuan/process.js                # 处理所有存在原始文件的资产
 *   node scripts/hunyuan/process.js --only key1,key2
 *   node scripts/hunyuan/process.js --compress     # 额外生成 <key>-compressed.glb (Draco)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')

const args = process.argv.slice(2)
const getFlag = name => args.includes(`--${name}`)
const getValue = name => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : null }

const options = {
    compress: getFlag('compress'),
    only: getValue('only') ? getValue('only').split(',').map(s => s.trim()) : null
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))
const rawDirectory = path.join(projectRoot, 'resources', 'hunyuan-raw')
const outputDirectory = path.join(projectRoot, 'static', 'garden')
const gltfTransformBin = path.join(projectRoot, 'node_modules', '.bin', 'gltf-transform')

// 减面默认参数（可被 manifest.defaults.simplify 或资产级 simplify 覆盖，资产级 simplify:false 可禁用）：
// 混元高模约 50 万三角形/件，实时渲染时主画面 + 阴影贴图两份顶点吞吐是最大性能瓶颈。
// ratio 为目标保留比例；error 为相对模型半径的误差上限（过大可见形变，过小减不下去）。
const defaultSimplify = { ratio: 0.05, error: 0.002 }

// 贴图压缩默认参数（可被 manifest.defaults.texture 或资产级 texture 覆盖，资产级 texture:false 可禁用）：
// 混元原贴图 4096×4096 PNG（3 张约 31MB/资产，解码后 192MB 显存），远超游戏内观看需要。
// 限制最大边长并转 JPEG（有 alpha 通道的保留 PNG），大幅降低加载体积与显存占用。
const defaultTexture = { resize: [ 1024, 1024 ], quality: 85 }

await MeshoptSimplifier.ready

const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule()
    })

/**
 * 迷你 mat4（列主序，与 gl-matrix 约定一致，供 transformMesh 使用）
 */
function createMatrix()
{
    return new Float32Array([ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ])
}

function multiplyMatrices(_a, _b)
{
    const out = createMatrix()
    for(let column = 0; column < 4; column++)
        for(let row = 0; row < 4; row++)
            out[column * 4 + row] =
                _a[row] * _b[column * 4] +
                _a[4 + row] * _b[column * 4 + 1] +
                _a[8 + row] * _b[column * 4 + 2] +
                _a[12 + row] * _b[column * 4 + 3]
    return out
}

function fromTranslation(_x, _y, _z)
{
    const out = createMatrix()
    out[12] = _x
    out[13] = _y
    out[14] = _z
    return out
}

function fromScaling(_scale)
{
    const out = createMatrix()
    out[0] = _scale
    out[5] = _scale
    out[10] = _scale
    return out
}

// 欧拉角旋转（three.js 'XYZ' 顺序），单位弧度
function fromEuler(_x, _y, _z)
{
    const a = Math.cos(_x), b = Math.sin(_x)
    const c = Math.cos(_y), d = Math.sin(_y)
    const e = Math.cos(_z), f = Math.sin(_z)

    const out = createMatrix()
    out[0] = c * e
    out[4] = - c * f
    out[8] = d
    out[1] = a * f + b * e * d
    out[5] = a * e - b * f * d
    out[9] = - b * c
    out[2] = b * f - a * e * d
    out[6] = b * e + a * f * d
    out[10] = a * c
    return out
}

function transformBounds(_bounds, _matrix)
{
    const min = [ Infinity, Infinity, Infinity ]
    const max = [ - Infinity, - Infinity, - Infinity ]

    for(let i = 0; i < 8; i++)
    {
        const x = (i & 1) ? _bounds.max[0] : _bounds.min[0]
        const y = (i & 2) ? _bounds.max[1] : _bounds.min[1]
        const z = (i & 4) ? _bounds.max[2] : _bounds.min[2]

        const transformed = [
            _matrix[0] * x + _matrix[4] * y + _matrix[8] * z + _matrix[12],
            _matrix[1] * x + _matrix[5] * y + _matrix[9] * z + _matrix[13],
            _matrix[2] * x + _matrix[6] * y + _matrix[10] * z + _matrix[14],
        ]

        for(let axis = 0; axis < 3; axis++)
        {
            min[axis] = Math.min(min[axis], transformed[axis])
            max[axis] = Math.max(max[axis], transformed[axis])
        }
    }

    return { min, max }
}

function getSize(_bounds)
{
    return [ _bounds.max[0] - _bounds.min[0], _bounds.max[1] - _bounds.min[1], _bounds.max[2] - _bounds.min[2] ]
}

function round3(_value)
{
    return Math.round(_value * 1000) / 1000
}

function formatSize(_bytes)
{
    return _bytes >= 1024 * 1024 ? `${(_bytes / 1024 / 1024).toFixed(1)} MB` : `${(_bytes / 1024).toFixed(1)} KB`
}

function countTriangles(_document)
{
    let count = 0
    for(const mesh of _document.getRoot().listMeshes())
    {
        for(const primitive of mesh.listPrimitives())
        {
            const indices = primitive.getIndices()
            if(indices)
                count += indices.getCount() / 3
            else
                count += primitive.getAttribute('POSITION').getCount() / 3
        }
    }
    return Math.round(count)
}

async function processAsset(asset)
{
    const input = path.join(rawDirectory, `${asset.key}.glb`)

    if(!fs.existsSync(input))
    {
        if(asset.enabled)
            console.log(`… 跳过 ${asset.key}: 缺少 ${path.relative(projectRoot, input)}（先运行 generate.js）`)
        return null
    }

    const doc = await io.read(input)
    await doc.transform(dedup(), prune())

    const scene = doc.getRoot().listScenes()[0]
    const meshes = doc.getRoot().listMeshes()
    if(!scene || !meshes.length)
        throw new Error(`${asset.key}: 模型没有网格内容`)

    if(doc.getRoot().listSkins().length)
        console.log(`  ⚠ ${asset.key}: 含蒙皮（骨骼），顶点烘焙可能破坏绑定，建议改用 Blender 流程`)

    // 1. 压平节点层级：把所有节点变换烘焙进顶点（自顶向下）
    const flatten = node =>
    {
        clearNodeTransform(node)
        for(const child of node.listChildren())
            flatten(child)
    }
    for(const node of scene.listChildren())
        flatten(node)

    // 2. 计算归一化矩阵：旋转修正 → 等比缩放 → Pivot 归零（底面中心）
    const bounds = getBounds(scene)
    if(!isFinite(bounds.min[0]) || !isFinite(bounds.max[0]))
        throw new Error(`${asset.key}: 包围盒无效`)

    const rotationFix = asset.rotationFix || [ 0, 0, 0 ]
    const rotationMatrix = fromEuler(...rotationFix.map(degrees => degrees * Math.PI / 180))
    const rotatedBounds = transformBounds(bounds, rotationMatrix)
    const rotatedSize = getSize(rotatedBounds)

    let scale = 1
    if(asset.normalize)
    {
        const axis = { x: 0, y: 1, z: 2 }[asset.normalize.axis || 'y']
        if(rotatedSize[axis] > 1e-5)
            scale = asset.normalize.target / rotatedSize[axis]
    }

    const pivotX = (rotatedBounds.min[0] + rotatedBounds.max[0]) / 2
    const pivotZ = (rotatedBounds.min[2] + rotatedBounds.max[2]) / 2
    const pivotY = rotatedBounds.min[1]

    const matrix = multiplyMatrices(
        fromTranslation(- pivotX * scale, - pivotY * scale, - pivotZ * scale),
        multiplyMatrices(fromScaling(scale), rotationMatrix)
    )

    // 3. 应用矩阵（单次顶点遍历）
    for(const mesh of meshes)
        transformMesh(mesh, matrix)

    // 3.5 减面：归一化后按目标比例简化，weld 先合并拆分顶点提高简化质量
    const simplifySettings = asset.simplify === false
        ? null
        : { ...defaultSimplify, ...(manifest.defaults.simplify || {}), ...(typeof asset.simplify === 'object' ? asset.simplify : {}) }

    const trianglesBefore = countTriangles(doc)
    let trianglesAfter = trianglesBefore

    if(simplifySettings)
    {
        await doc.transform(
            weld({ tolerance: 0.0001 }),
            simplify({
                simplifier: MeshoptSimplifier,
                ratio: simplifySettings.ratio,
                error: simplifySettings.error,
                lockBorder: false
            })
        )
        trianglesAfter = countTriangles(doc)
    }

    // 3.6 贴图压缩：限制最大边长 + 无 alpha 转 JPEG（有 alpha 保留 PNG）
    const textureSettings = asset.texture === false
        ? null
        : { ...defaultTexture, ...(manifest.defaults.texture || {}), ...(typeof asset.texture === 'object' ? asset.texture : {}) }

    let textureBytesBefore = 0
    let textureBytesAfter = 0

    if(textureSettings)
    {
        for(const texture of doc.getRoot().listTextures())
        {
            const image = texture.getImage()
            if(!image)
                continue

            textureBytesBefore += image.byteLength
            const metadata = await sharp(Buffer.from(image)).metadata()
            await compressTexture(texture, {
                encoder: sharp,
                targetFormat: metadata.hasAlpha ? 'png' : 'jpeg',
                resize: textureSettings.resize,
                quality: textureSettings.quality
            })
            textureBytesAfter += texture.getImage().byteLength
        }
    }

    // 4. 最终包围盒（减面后顶点略有变化，重新计算保证碰撞体贴合）
    const finalBounds = getBounds(scene)
    const finalSize = getSize(finalBounds)

    // 5. 场景根命名 + 注入碰撞体
    // THREE 的 gltf.scene 名称取自 glTF 场景名（而非根节点名）：游戏侧 Objects.getFromModel
    // 依据该名称含 "physical" 创建 fixed 刚体，且只扫描模型的直接子节点收集 cuboid 碰撞体。
    // 故把场景本身命名为 "<key> physical fixed"，碰撞体挂为场景的直接子节点
    // （层级已全部烘焙进顶点，无需包装节点）。
    scene.setName(`${asset.key}${asset.collider === 'cuboid' ? ' physical fixed' : ''}`)

    if(asset.collider === 'cuboid')
    {
        const colliderNode = doc.createNode('cuboid')
        colliderNode.setTranslation([ 0, finalSize[1] / 2, 0 ])
        colliderNode.setScale([
            Math.max(finalSize[0], 0.02),
            Math.max(finalSize[1], 0.02),
            Math.max(finalSize[2], 0.02)
        ])
        scene.addChild(colliderNode)
    }

    // 5.5 材质唯一命名
    // 游戏 Materials.getFromName 按材质名作转换缓存键（同名跨对象共享，给同资产克隆体复用）；
    // 混元导出默认名（如 Material.001）会在不同资产间撞名，导致贴图/材质串用，必须改为全局唯一。
    const materials = doc.getRoot().listMaterials()
    materials.forEach((material, index) =>
    {
        material.setName(materials.length > 1 ? `${asset.key}_${index}` : asset.key)
    })

    // 6. 导出（读取时注册过 draco 扩展会导致写回自动保留压缩，
    //    这里移除它使普通版保持未压缩，-compressed 版由 CLI 重新压缩）
    for(const extension of doc.getRoot().listExtensionsUsed())
    {
        if(extension instanceof KHRDracoMeshCompression)
            extension.dispose()
    }

    fs.mkdirSync(outputDirectory, { recursive: true })
    const output = path.join(outputDirectory, `${asset.key}.glb`)
    await io.write(output, doc)

    // 7. 校验
    const issues = []
    if(Math.abs(finalBounds.min[1]) > 0.01)
        issues.push(`底部未归零 (min.y=${round3(finalBounds.min[1])})`)
    if(Math.abs((finalBounds.min[0] + finalBounds.max[0]) / 2) > 0.01 || Math.abs((finalBounds.min[2] + finalBounds.max[2]) / 2) > 0.01)
        issues.push('中心未归零')

    const reduction = simplifySettings ? ` | 面数 ${trianglesBefore.toLocaleString()} → ${trianglesAfter.toLocaleString()} (x${round3(trianglesAfter / trianglesBefore)})` : ''
    const textureReduction = textureBytesBefore > 0 ? ` | 贴图 ${formatSize(textureBytesBefore)} → ${formatSize(textureBytesAfter)}` : ''
    console.log(`✔ ${asset.key} → ${path.relative(projectRoot, output)} | 尺寸 ${finalSize.map(round3).join(' × ')} m | 缩放 x${round3(scale)} | 碰撞体 ${asset.collider || 'none'}${reduction}${textureReduction}`)
    if(issues.length)
        console.log(`  ⚠ ${asset.key}: ${issues.join('；')}（可用 rotationFix/normalize 调整）`)

    return { asset, output, finalSize }
}

async function compress(asset)
{
    const input = path.join(outputDirectory, `${asset.key}.glb`)
    const output = path.join(outputDirectory, `${asset.key}-compressed.glb`)

    if(!fs.existsSync(input))
        return

    await new Promise((resolve, reject) =>
    {
        const command = spawn(gltfTransformBin,
            [
                'draco',
                input,
                output,
                '--method', 'edgebreaker',
                '--quantization-volume', 'mesh',
                '--quantize-position', '12',
                '--quantize-normal', '6',
                '--quantize-texcoord', '6',
                '--quantize-color', '2',
                '--quantize-generic', '2'
            ],
            { cwd: projectRoot }
        )

        command.stdout.on('data', data => console.log(`  ${data.toString().trim()}`))
        command.stderr.on('data', data => console.error(`  ${data.toString().trim()}`))
        command.on('close', code => code === 0 ? resolve() : reject(new Error(`gltf-transform 退出码 ${code}`)))
    })

    const inputSize = fs.statSync(input).size
    const outputSize = fs.statSync(output).size
    console.log(`  ⇩ ${asset.key}-compressed.glb ${formatSize(inputSize)} → ${formatSize(outputSize)}`)
}

async function main()
{
    let assets = manifest.assets

    if(options.only)
    {
        const missing = options.only.filter(key => !manifest.assets.some(asset => asset.key === key))
        if(missing.length)
        {
            console.error(`✘ manifest 中不存在这些 key: ${missing.join(', ')}`)
            process.exit(1)
        }
        assets = manifest.assets.filter(asset => options.only.includes(asset.key))
    }

    const processed = []
    for(const asset of assets)
    {
        try
        {
            const result = await processAsset(asset)
            if(result)
                processed.push(result)
        }
        catch(error)
        {
            console.error(`✘ ${asset.key} 处理失败: ${error.message || error}`)
            process.exitCode = 1
        }
    }

    if(options.compress)
    {
        console.log('\nDraco 压缩中...')
        for(const result of processed)
            await compress(result.asset)
    }

    console.log(`\n完成 ${processed.length} 个资产 → static/garden/`)
    if(processed.length)
        console.log('下一步：编辑 static/garden/scene.json 摆放布局，然后 npm run dev 查看')
}

main().catch(error =>
{
    console.error('✘ 脚本异常:', error)
    process.exitCode = 1
})
