import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Logger, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { compressTexture, dedup, listTextureSlots, prune, simplify, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

/**
 * 模型减面 + 贴图压缩（供非流水线资产手动使用，如 spiderman.glb）
 *
 * 用法:
 *   node scripts/simplify-model.js <input.glb> [--ratio 0.15] [--error 0.001] [--texture 2048] [--quality 90] [--compressed]
 *
 * 流程:
 *   1. 备份原文件到 resources/backups/<name>-<时间戳>.glb
 *   2. dedup → weld → meshoptimizer 减面（只重索引三角形，逐顶点保留原属性值
 *      —— JOINTS_0/WEIGHTS_0 不做插值，蒙皮动画安全）→ prune
 *   3. 贴图压缩：法线贴图保留 PNG（对 JPEG 伪影敏感），其余无 alpha 转 JPEG；
 *      尺寸上限 --texture（默认 2048，小图不放大）
 *   4. 原地覆盖 input；--compressed 时额外用 gltf-transform CLI 生成 <name>-compressed.glb (Draco)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const getFlag = name => args.includes(`--${name}`)
const getValue = name => { const i = args.indexOf(`--${name}`); return i !== -1 ? parseFloat(args[i + 1]) : null }

const input = args.find(arg => !arg.startsWith('--') && (arg.endsWith('.glb') || arg.endsWith('.gltf')))
if(!input)
{
    console.error('用法: node scripts/simplify-model.js <input.glb> [--ratio 0.15] [--error 0.001] [--texture 2048] [--quality 90] [--compressed]')
    process.exit(1)
}

const options = {
    ratio: getValue('ratio') ?? 0.15,
    error: getValue('error') ?? 0.001,
    texture: getValue('texture') ?? 2048,
    quality: getValue('quality') ?? 90,
    compressed: getFlag('compressed')
}

const inputPath = path.resolve(projectRoot, input)
const outputPath = path.resolve(projectRoot, input)

function formatSize(bytes)
{
    if(bytes > 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)}MB`
    return `${(bytes / 1024).toFixed(0)}KB`
}

function countTriangles(doc)
{
    let total = 0
    for(const mesh of doc.getRoot().listMeshes())
    {
        for(const prim of mesh.listPrimitives())
        {
            const indices = prim.getIndices()
            if(indices)
                total += indices.getCount() / 3
            else
            {
                const position = prim.getAttribute('POSITION')
                if(position)
                    total += position.getCount() / 3
            }
        }
    }
    return Math.round(total)
}

await MeshoptSimplifier.ready

const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule()
    })

// 1. 备份
const backupDirectory = path.join(projectRoot, 'resources', 'backups')
fs.mkdirSync(backupDirectory, { recursive: true })
const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
const backupPath = path.join(backupDirectory, `${path.basename(inputPath, '.glb')}-${timestamp}.glb`)
fs.copyFileSync(inputPath, backupPath)
console.log(`⛑ 已备份 → ${path.relative(projectRoot, backupPath)} (${formatSize(fs.statSync(backupPath).size)})`)

// 2. 读取
const inputSize = fs.statSync(inputPath).size
const doc = await io.read(inputPath)

const trianglesBefore = countTriangles(doc)

// 3. 减面
await doc.transform(
    dedup(),
    weld({ tolerance: 0.0001 }),
    simplify({ simplifier: MeshoptSimplifier, ratio: options.ratio, error: options.error, lockBorder: false }),
    prune()
)
const trianglesAfter = countTriangles(doc)

// 4. 贴图压缩
let bytesBefore = 0
let bytesAfter = 0
for(const texture of doc.getRoot().listTextures())
{
    const image = texture.getImage()
    if(!image)
        continue

    bytesBefore += image.byteLength

    const slots = listTextureSlots(texture)
    const isNormal = slots.includes('normalTexture')
    const metadata = await sharp(Buffer.from(image)).metadata()
    const targetFormat = (isNormal || metadata.hasAlpha) ? 'png' : 'jpeg'

    await compressTexture(texture, {
        encoder: sharp,
        targetFormat,
        resize: [ options.texture, options.texture ],
        quality: options.quality
    })
    bytesAfter += texture.getImage().byteLength
}

// 5. 写回（读取时注册过 draco 扩展会导致写回自动保留压缩，统一移除保持普通版未压缩）
for(const extension of doc.getRoot().listExtensionsUsed())
{
    if(extension instanceof KHRDracoMeshCompression)
        extension.dispose()
}

await io.write(outputPath, doc)

const outputSize = fs.statSync(outputPath).size
console.log(`✔ ${path.basename(inputPath)}`)
console.log(`  面数 ${trianglesBefore.toLocaleString()} → ${trianglesAfter.toLocaleString()} (x${(trianglesAfter / trianglesBefore).toFixed(3)})`)
console.log(`  文件 ${formatSize(inputSize)} → ${formatSize(outputSize)}`)
if(bytesBefore > 0)
    console.log(`  贴图 ${formatSize(bytesBefore)} → ${formatSize(bytesAfter)}`)

// 6. 可选：Draco 压缩版（与 scripts/hunyuan/process.js --compress 相同参数）
if(options.compressed)
{
    const compressedPath = outputPath.replace(/\.glb$/, '-compressed.glb')
    const gltfTransformBin = path.join(projectRoot, 'node_modules', '.bin', 'gltf-transform')

    await new Promise((resolve, reject) =>
    {
        const command = spawn(gltfTransformBin,
            [
                'draco',
                outputPath,
                compressedPath,
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

    const compressedSize = fs.statSync(compressedPath).size
    console.log(`  ⇩ ${path.basename(compressedPath)} ${formatSize(compressedSize)}`)
}
