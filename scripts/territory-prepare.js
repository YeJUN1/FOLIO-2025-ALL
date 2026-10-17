import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from '@gltf-transform/extensions'
import { clearNodeTransform, compressTexture, dedup, getBounds, prune, simplify, transformMesh, weld } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

/**
 * 「划地盘」栏杆资产准备：把外部高模（AI 生成，约 9 万三角形 / 41MB / 3×4096² PNG）
 * 规范化为可沿红框四周大量克隆摆放的轻量栏杆件。
 *
 * 仅做「减重」：清理 → 压平层级 → 减面(meshoptimizer) → 贴图压缩(sharp) → 材质唯一命名(防串用) → 导出。
 * 保留模型原始尺寸与朝向（约 1.11 × 0.09 × 0.53 的扁平木板件），
 * 立起、缩放、贴地、沿边旋转等摆放变换全部交给运行期 Territory.js 用 THREE 处理（更可靠）。
 * 纯视觉件：不注入 physical 命名，游戏侧不创建碰撞体（玩家可穿过）。
 *
 * 用法:
 *   node scripts/territory-prepare.js [输入glb路径]
 *   默认输入 = ~/Desktop/30954c88932dfcdda0babea299042f41.glb
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const defaultInput = path.join(process.env.HOME || '', 'Desktop', '30954c88932dfcdda0babea299042f41.glb')
const input = process.argv[2] ? path.resolve(process.argv[2]) : defaultInput
const outputDirectory = path.join(projectRoot, 'static', 'territory')
const output = path.join(outputDirectory, 'fence.glb')

// 减重参数
const simplifySettings = { ratio: 0.02, error: 0.008 }   // 约 9 万 → 约 1 万三角形/件（要大量克隆，留性能余量）
const textureSettings = { resize: [ 1024, 1024 ], quality: 80 }
const materialName = 'territoryFence'

if(!fs.existsSync(input))
{
    console.error(`✗ 找不到输入模型: ${input}`)
    process.exit(1)
}

await MeshoptSimplifier.ready

const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)

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
                _a[row] * _b[column * 4] + _a[4 + row] * _b[column * 4 + 1] +
                _a[8 + row] * _b[column * 4 + 2] + _a[12 + row] * _b[column * 4 + 3]
    return out
}
function fromTranslation(_x, _y, _z)
{
    const out = createMatrix(); out[12] = _x; out[13] = _y; out[14] = _z; return out
}
function fromScaling(_scale)
{
    const out = createMatrix(); out[0] = _scale; out[5] = _scale; out[10] = _scale; return out
}
function fromEuler(_x, _y, _z)
{
    const a = Math.cos(_x), b = Math.sin(_x)
    const c = Math.cos(_y), d = Math.sin(_y)
    const e = Math.cos(_z), f = Math.sin(_z)
    const out = createMatrix()
    out[0] = c * e; out[4] = - c * f; out[8] = d
    out[1] = a * f + b * e * d; out[5] = a * e - b * f * d; out[9] = - b * c
    out[2] = b * f - a * e * d; out[6] = b * e + a * f * d; out[10] = a * c
    return out
}
function transformBounds(_bounds, _matrix)
{
    const min = [ Infinity, Infinity, Infinity ]; const max = [ - Infinity, - Infinity, - Infinity ]
    for(let i = 0; i < 8; i++)
    {
        const x = (i & 1) ? _bounds.max[0] : _bounds.min[0]
        const y = (i & 2) ? _bounds.max[1] : _bounds.min[1]
        const z = (i & 4) ? _bounds.max[2] : _bounds.min[2]
        const t = [
            _matrix[0] * x + _matrix[4] * y + _matrix[8] * z + _matrix[12],
            _matrix[1] * x + _matrix[5] * y + _matrix[9] * z + _matrix[13],
            _matrix[2] * x + _matrix[6] * y + _matrix[10] * z + _matrix[14],
        ]
        for(let axis = 0; axis < 3; axis++)
        {
            min[axis] = Math.min(min[axis], t[axis]); max[axis] = Math.max(max[axis], t[axis])
        }
    }
    return { min, max }
}
function getSize(_bounds)
{
    return [ _bounds.max[0] - _bounds.min[0], _bounds.max[1] - _bounds.min[1], _bounds.max[2] - _bounds.min[2] ]
}
function countTriangles(_doc)
{
    let count = 0
    for(const mesh of _doc.getRoot().listMeshes())
        for(const primitive of mesh.listPrimitives())
        {
            const indices = primitive.getIndices()
            count += indices ? indices.getCount() / 3 : primitive.getAttribute('POSITION').getCount() / 3
        }
    return Math.round(count)
}

console.log(`→ 读取 ${path.relative(projectRoot, input)}`)
const doc = await io.read(input)
await doc.transform(dedup(), prune())

const scene = doc.getRoot().listScenes()[0]
const meshes = doc.getRoot().listMeshes()
if(!scene || !meshes.length)
    throw new Error('模型没有网格内容')

// 1. 压平层级（变换烘焙进顶点），保留原始尺寸与朝向
const flatten = node => { clearNodeTransform(node); for(const child of node.listChildren()) flatten(child) }
for(const node of scene.listChildren())
    flatten(node)

// 2. 减面
const trianglesBefore = countTriangles(doc)
await doc.transform(
    weld({ tolerance: 0.0001 }),
    simplify({ simplifier: MeshoptSimplifier, ratio: simplifySettings.ratio, error: simplifySettings.error, lockBorder: false })
)
const trianglesAfter = countTriangles(doc)

// 3. 贴图压缩
for(const texture of doc.getRoot().listTextures())
{
    const image = texture.getImage()
    if(!image) continue
    const metadata = await sharp(Buffer.from(image)).metadata()
    await compressTexture(texture, {
        encoder: sharp,
        targetFormat: metadata.hasAlpha ? 'png' : 'jpeg',
        resize: textureSettings.resize,
        quality: textureSettings.quality
    })
}

// 4. 材质唯一命名（防跨资产串用，见记忆 2.1.3）
doc.getRoot().listMaterials().forEach((material, index) => material.setName(`${materialName}_${index}`))

// 5. 导出（移除 draco 扩展保持普通未压缩版）
for(const extension of doc.getRoot().listExtensionsUsed())
    if(extension instanceof KHRDracoMeshCompression)
        extension.dispose()

fs.mkdirSync(outputDirectory, { recursive: true })
await io.write(output, doc)

const finalBounds = getBounds(scene)
const finalSize = [ finalBounds.max[0] - finalBounds.min[0], finalBounds.max[1] - finalBounds.min[1], finalBounds.max[2] - finalBounds.min[2] ]
const sizeMB = (fs.statSync(output).size / 1024 / 1024).toFixed(2)
console.log(`✓ 导出 ${path.relative(projectRoot, output)}`)
console.log(`  三角形 ${trianglesBefore} → ${trianglesAfter} (${(trianglesAfter / trianglesBefore * 100).toFixed(1)}%)`)
console.log(`  原始尺寸(未改朝向) 长×高×厚 ≈ ${finalSize.map(v => v.toFixed(2)).join(' × ')} m`)
console.log(`  文件体积 ${sizeMB} MB`)
