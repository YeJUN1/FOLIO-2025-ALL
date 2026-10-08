/**
 * 车辆资产流水线：Lamborghini Revuelto -> folio-2025 游戏车辆
 *
 * 用法: node scripts/vehicle-revuelto.mjs [input.glb] [output.glb]
 *
 * 处理内容：
 *  - 变换烘焙：模型空间(z 前向, 贴地) -> 游戏空间(x 前向, chassis 原点)
 *  - 四轮取一（FL 保留为 wheelCylinder 模板，其余删除），车轮几何以轮心为原点
 *  - 全车型材质合并为 ~24 个游戏材质组，按 车身/转动/静止 三个桶重建节点树
 *  - 尾灯透镜生成 stopLights / backLights 发光壳（平面 UV，供径向渐变）
 *  - bodyPainted 生成高度归一化 UV（uv0 渐变 + uv1 火焰）
 *  - weld + simplify 精简，纹理最大 1024
 *  - chassis extras 携带 wheelLimit 与 boostTrails（运行时由 VisualVehicle 读取）
 */
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { weldPrimitive, simplifyPrimitive, transformMesh, prune, compressTexture } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

/* ============================== 配置 ============================== */

const INPUT_CANDIDATES = [
    'resources/models/Lamborghini+Revuelto.glb',
    'static/Lamborghini+Revuelto.glb',
]
const OUTPUT = process.argv[3] ?? 'static/vehicle/revuelto.glb'

// 模型 -> 游戏 变换常数
const SCALE = 0.6063              // 4.948m 车长 -> 3.0m
const AXLE_MID_Z = 0.0025         // 模型前后轴中点 z（居中用）
const STATIC_WHEEL_Y = -0.7876    // 游戏内静止悬挂车轮中心 y（相对 chassis；复刻游戏 'low' 悬挂 restLength 0.88 + stiffness 20 仿真实测：前 -0.7809 后 -0.7943，取均值）
const MODEL_WHEEL_RADIUS = 0.341  // 模型空间轮胎半径（= 轮心高度）
const Y_SHIFT = STATIC_WHEEL_Y - SCALE * MODEL_WHEEL_RADIUS // = -(L + r) = -0.9568

// chassis extras
const WHEEL_LIMIT = -0.7625       // 防穿轮拱：各方向腔顶（射线实测）与轮胎球面高度配对，最严约束 -0.7575，取 5mm 余量
const BOOST_TRAILS = { x: -1.47, y: -0.709, z: 0.1 } // 排气口位置（y 随 STATIC_WHEEL_Y 基准换算）
const WHEEL_CONTAINER_POS = [0.8430, STATIC_WHEEL_Y, -0.5166] // 与 i=1（+x,-z）车轮同位；源容器不挂场景树，仅作克隆源（同 default.glb 约定）

// 尾灯透镜（stopLights / backLights 的几何来源）
const STOP_SOURCE = /^(GlassLTL_GlassRed|GlassRTL_GlassRed|GlassCHMSL_GlassRed)$/
const STOP_SHELL_SCALE = 1.004
const BACK_SHELL_SCALE = 1.008

/* ------------------------------ builders ------------------------------ */
// parent: chassis(默认) | wheelCylinder | caliper
const BUILDERS = [
    { id: 'bodyPainted', node: 'bodyPainted', mat: 'Revuelto_bodyPainted', simplify: [0.35, 0.002], bodyUV: true },
    { id: 'M_Black', node: 'M_Black', mat: 'Revuelto_M_Black', simplify: [0.2, 0.003] },
    { id: 'M_Carbon', node: 'M_Carbon', mat: 'Revuelto_M_Carbon', simplify: [0.3, 0.002] },
    { id: 'M_Satin', node: 'M_Satin', mat: 'Revuelto_M_Satin', simplify: [0.25, 0.002] },
    { id: 'M_Metal', node: 'M_Metal', mat: 'Revuelto_M_Metal', simplify: [0.3, 0.002] },
    { id: 'M_Chrome', node: 'M_Chrome', mat: 'Revuelto_M_Chrome', simplify: [0.45, 0.002] },
    { id: 'M_Interior', node: 'M_Interior', mat: 'Revuelto_M_Interior', simplify: [0.3, 0.002] },
    { id: 'M_Glass', node: 'M_Glass', mat: 'Revuelto_M_Glass', simplify: [0.5, 0.002] },
    { id: 'M_RedLens', node: 'M_RedLens', mat: 'Revuelto_M_RedLens', simplify: [0.5, 0.0015] },
    { id: 'M_Headlight', node: 'M_Headlight', mat: 'Revuelto_M_Headlight', simplify: [0.8, 0.001] },
    { id: 'M_Badge', node: 'M_Badge', mat: 'Revuelto_M_Badge', simplify: [1, 0] },
    { id: 'M_Label', node: 'M_Label', mat: 'Revuelto_M_Label', simplify: [1, 0], texture: true },
    { id: 'M_Grille', node: 'M_Grille', mat: 'Revuelto_M_Grille', simplify: [1, 0], texture: true },
    { id: 'M_Steel', node: 'M_Steel', mat: 'Revuelto_M_Steel', simplify: [0.6, 0.002], texture: true },
    { id: 'M_Exhaust', node: 'M_Exhaust', mat: 'Revuelto_M_Exhaust', simplify: [0.6, 0.002], texture: true },
    { id: 'M_Undercarriage', node: 'M_Undercarriage', mat: 'Revuelto_M_Undercarriage', simplify: [1, 0], texture: true },
    { id: 'M_PlateShadow', node: 'M_PlateShadow', mat: 'Revuelto_M_PlateShadow', simplify: [1, 0], texture: true },

    { id: 'wheelTire', node: 'M_Tire', mat: 'Revuelto_M_Tire', simplify: [0.8, 0.001], texture: true, parent: 'wheelCylinder' },
    { id: 'wheelRim', node: 'M_WheelRim', mat: 'Revuelto_M_WheelRim', simplify: [0.55, 0.001], parent: 'wheelCylinder' },
    { id: 'wheelBrakeRotor', node: 'M_BrakeRotor', mat: 'Revuelto_M_BrakeRotor', simplify: [0.8, 0.001], parent: 'wheelCylinder' },
    { id: 'wheelDark', node: 'M_WheelDark', mat: 'Revuelto_M_WheelDark', simplify: [0.8, 0.001], parent: 'wheelCylinder' },
    { id: 'wheelDecal', node: 'M_Decal', mat: 'Revuelto_M_Decal', simplify: [1, 0], texture: true, parent: 'wheelCylinder' },
    { id: 'wheelBadge', node: 'M_Badge', mat: 'Revuelto_M_Badge', simplify: [1, 0], parent: 'wheelCylinder' },

    { id: 'wheelCaliper', node: 'M_Caliper', mat: 'Revuelto_M_Caliper', simplify: [0.5, 0.001], parent: 'caliper' },
    { id: 'wheelSteel', node: 'M_Steel', mat: 'Revuelto_M_Steel', simplify: [0.7, 0.001], texture: true, parent: 'caliper' },
    { id: 'wheelSatin', node: 'M_Satin', mat: 'Revuelto_M_Satin', simplify: [0.6, 0.001], parent: 'caliper' },
    { id: 'wheelBlack', node: 'M_Black', mat: 'Revuelto_M_Black', simplify: [0.6, 0.001], parent: 'caliper' },

    { id: 'stopLights', node: 'stopLights', mat: 'emissiveOrangeRadialGradient', simplify: [1, 0], shell: true },
    { id: 'backLights', node: 'backLights', mat: 'emissiveOrangeRadialGradient', simplify: [1, 0], shell: true },
]

/* --------------------------- 源材质映射表 --------------------------- */
const BODY_MAP = {
    'car_paint_v3_03': 'bodyPainted',
    'M_CarPaint': 'bodyPainted',

    'M_PlasticBlack': 'M_Black', 'M_BlackFrame': 'M_Black', 'M_BlackHole': 'M_Black',
    'M_Carpet': 'M_Black', 'M_GlassDark': 'M_Black', 'M_Screen': 'M_Black',
    'M_PlateBase': 'M_Black', 'M_Seatbelt': 'M_Black', 'M_Seatbelt_Plastic': 'M_Black',
    'M_Rubber': 'M_Black', 'Material': 'M_Black', '': 'M_Black',

    'M_CarbonFiber': 'M_Carbon', 'M_CarbonFiber.001': 'M_Carbon',

    'M_PaintedMetal': 'M_Satin', 'M_Anodized': 'M_Satin', 'M_GunMetal': 'M_Satin',
    'M_Detail': 'M_Satin', 'M_DetailMetallic': 'M_Satin',

    'M_Aluminum': 'M_Metal', 'M_Titanium': 'M_Metal', 'M_Screw': 'M_Metal',
    'M_Chrome': 'M_Chrome', 'M_Mirror': 'M_Chrome',

    'M_Alcantara': 'M_Interior', 'M_Leather': 'M_Interior', 'M_Stitch': 'M_Interior',

    'M_GlassClear': 'M_Glass', 'M_GlassSide': 'M_Glass',
    'M_GlassRed': 'M_RedLens', 'Emission Red': 'M_RedLens',
    'HeadLights': 'M_Headlight', 'M_Emitter': 'M_Headlight',

    'M_Badge': 'M_Badge',
    'M_Label': 'M_Label',
    'M_Grille': 'M_Grille',
    'M_Steel': 'M_Steel',
    'M_HeatTreated': 'M_Exhaust',
    'M_Undercarriage': 'M_Undercarriage',
    'M_PlateShadow': 'M_PlateShadow',
}

// FL 车轮内部材质映射（随轮旋转 / 静止 由 builder 归属决定）
const WHEEL_MAP = {
    'Wheel.001': 'wheelTire',
    'M_WheelRim': 'wheelRim',
    'M_BrakeRotor': 'wheelBrakeRotor', 'M_RotorEdge': 'wheelBrakeRotor',
    'M_DarkMetal': 'wheelDark', 'M_Screw': 'wheelDark', 'M_Rubber': 'wheelDark',
    'M_Badge.001': 'wheelBadge',
    'M_Label.001': 'wheelDecal',

    'M_Caliper': 'wheelCaliper',
    'M_Steel': 'wheelSteel',
    'M_PaintedMetal': 'wheelSatin', 'M_GunMetal': 'wheelSatin', 'M_Detail': 'wheelSatin',
    'M_PlasticBlack': 'wheelBlack',
}

/* ------------------------------ 材质定义 ------------------------------ */
const MAT_DEFS = {
    'Revuelto_bodyPainted': { color: [1, 0.094, 0, 1] },
    'Revuelto_M_Black': { color: [0.02, 0.02, 0.024, 1] },
    'Revuelto_M_Carbon': { color: [0.055, 0.058, 0.065, 1] },
    'Revuelto_M_Satin': { color: [0.06, 0.063, 0.068, 1] },
    'Revuelto_M_Metal': { color: [0.4, 0.41, 0.44, 1] },
    'Revuelto_M_Chrome': { color: [0.79, 0.79, 0.79, 1] },
    'Revuelto_M_Interior': { color: [0.015, 0.013, 0.012, 1] },
    'Revuelto_M_Glass': { color: [0.13, 0.15, 0.17, 1] },
    'Revuelto_M_RedLens': { color: [0.5, 0.015, 0.02, 1] },
    'Revuelto_M_Headlight': { color: [0.85, 0.88, 0.92, 1] },
    'Revuelto_M_Badge': { color: [0.578, 0.397, 0.076, 1] },
    'Revuelto_M_Label': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_Grille': { color: [0.02, 0.02, 0.022, 1], texture: true },
    'Revuelto_M_Steel': { color: [0.55, 0.57, 0.6, 1], texture: true },
    'Revuelto_M_Exhaust': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_Undercarriage': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_PlateShadow': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_Tire': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_Decal': { color: [1, 1, 1, 1], texture: true },
    'Revuelto_M_WheelRim': { color: [0.03, 0.031, 0.036, 1] },
    'Revuelto_M_BrakeRotor': { color: [0.055, 0.055, 0.058, 1] },
    'Revuelto_M_WheelDark': { color: [0.035, 0.036, 0.04, 1] },
    'Revuelto_M_Caliper': { color: [0.02, 0.02, 0.022, 1] },
    'emissiveOrangeRadialGradient': { color: [0, 0, 0, 1] },
}

/* ============================== 矩阵工具（列主序） ============================== */

const mIdent = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function mMul(a, b) {
    const o = new Array(16)
    for(let c = 0; c < 4; c++)
        for(let r = 0; r < 4; r++)
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    return o
}

const mTrans = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const mScale = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]

function mRotY(angle) {
    const c = Math.cos(angle), s = Math.sin(angle)
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

function composeTRS(t, q, s) {
    const [x, y, z, w] = q
    const [sx, sy, sz] = s
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2
    const yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1,
    ]
}

function nodeLocalMatrix(node) {
    const m = node.getMatrix()
    if(m)
        return Array.from(m)
    return composeTRS(node.getTranslation(), node.getRotation(), node.getScale())
}

const det3 = (m) =>
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5])

/* ============================== 收集器 ============================== */

class Builder {
    constructor(def) {
        this.def = def
        this.positions = []
        this.normals = []
        this.uvs0 = null
        this.uvs1 = null
        this.indices = []
        this.vCount = 0
        this.min = [Infinity, Infinity, Infinity]
        this.max = [-Infinity, -Infinity, -Infinity]
        this.sourceTexture = null
        this.collectedTris = 0
    }
    bumpBounds(x, y, z) {
        if(x < this.min[0]) this.min[0] = x
        if(y < this.min[1]) this.min[1] = y
        if(z < this.min[2]) this.min[2] = z
        if(x > this.max[0]) this.max[0] = x
        if(y > this.max[1]) this.max[1] = y
        if(z > this.max[2]) this.max[2] = z
    }
}

function resolveUVInfo(prim) {
    const material = prim.getMaterial()
    const texInfo = material?.getBaseColorTextureInfo?.() ?? null
    if(!texInfo)
        return { uvAttrName: null, uvTransform: null, texture: null }
    let texCoord = texInfo.getTexCoord()
    let uvTransform = null
    const tt = texInfo.getExtension('KHR_texture_transform')
    if(tt) {
        uvTransform = { offset: tt.getOffset(), rotation: tt.getRotation(), scale: tt.getScale() }
        const ttTexCoord = tt.getTexCoord()
        if(ttTexCoord !== null)
            texCoord = ttTexCoord
    }
    return { uvAttrName: `TEXCOORD_${texCoord}`, uvTransform, texture: material.getBaseColorTexture() }
}

function applyUVTransform(u, v, transform) {
    if(!transform)
        return [u, v]
    let su = u * transform.scale[0]
    let sv = v * transform.scale[1]
    if(transform.rotation) {
        const cos = Math.cos(transform.rotation), sin = Math.sin(transform.rotation)
        const ru = cos * su - sin * sv
        const rv = sin * su + cos * sv
        su = ru
        sv = rv
    }
    return [su + transform.offset[0], sv + transform.offset[1]]
}

function copyPrim(b, prim, { flipNormals = false, texture = false } = {}) {
    const posAttr = prim.getAttribute('POSITION')
    const norAttr = prim.getAttribute('NORMAL')
    const posArr = posAttr.getArray()
    const norArr = norAttr ? norAttr.getArray() : null
    const count = posAttr.getCount()
    const base = b.vCount

    let uvArr = null
    let uvTransform = null
    if(texture) {
        const info = resolveUVInfo(prim)
        if(info.texture && !b.sourceTexture)
            b.sourceTexture = info.texture
        if(info.uvAttrName) {
            const attr = prim.getAttribute(info.uvAttrName)
            if(attr) {
                uvArr = attr.getArray()
                uvTransform = info.uvTransform
            }
            else
                console.warn(`  [warn] ${b.def.id}: 缺少 ${info.uvAttrName} (节点 ${prim.getMesh()?.getName()})`)
        }
        if(!b.uvs0)
            b.uvs0 = []
    }

    for(let i = 0; i < count; i++) {
        const x = posArr[i * 3], y = posArr[i * 3 + 1], z = posArr[i * 3 + 2]
        b.positions.push(x, y, z)
        b.bumpBounds(x, y, z)
        if(norArr) {
            const nx = norArr[i * 3], ny = norArr[i * 3 + 1], nz = norArr[i * 3 + 2]
            if(flipNormals)
                b.normals.push(-nx, -ny, -nz)
            else
                b.normals.push(nx, ny, nz)
        }
        else
            b.normals.push(0, 1, 0)
        if(b.uvs0) {
            if(uvArr) {
                const [u, v] = applyUVTransform(uvArr[i * 2], uvArr[i * 2 + 1], uvTransform)
                b.uvs0.push(u, v)
            }
            else
                b.uvs0.push(0, 0)
        }
    }

    const idxAttr = prim.getIndices()
    const idxCount = idxAttr ? idxAttr.getCount() : count
    const idxArr = idxAttr ? idxAttr.getArray() : null
    for(let i = 0; i < idxCount; i += 3) {
        const a = (idxArr ? idxArr[i] : i) + base
        const c = (idxArr ? idxArr[i + 1] : i + 1) + base
        const d = (idxArr ? idxArr[i + 2] : i + 2) + base
        if(flipNormals)
            b.indices.push(a, d, c)
        else
            b.indices.push(a, c, d)
    }

    b.vCount += count
    b.collectedTris += idxCount / 3
}

// 尾灯发光壳：绕片自身包围盒中心微缩放 + 平面投影 UV（供径向渐变）
function copyShell(b, prim, scale) {
    const posAttr = prim.getAttribute('POSITION')
    const posArr = posAttr.getArray()
    const count = posAttr.getCount()

    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for(let i = 0; i < count; i++)
        for(let k = 0; k < 3; k++) {
            const value = posArr[i * 3 + k]
            if(value < mn[k]) mn[k] = value
            if(value > mx[k]) mx[k] = value
        }
    const center = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2)

    // 最薄轴为法向，其余两轴做平面 UV
    const sizes = [0, 1, 2].map((k) => mx[k] - mn[k])
    const thin = sizes.indexOf(Math.min(...sizes))
    const uvAxes = [0, 1, 2].filter((k) => k !== thin)

    const base = b.vCount
    if(!b.uvs0)
        b.uvs0 = []
    for(let i = 0; i < count; i++) {
        const x = center[0] + (posArr[i * 3] - center[0]) * scale
        const y = center[1] + (posArr[i * 3 + 1] - center[1]) * scale
        const z = center[2] + (posArr[i * 3 + 2] - center[2]) * scale
        b.positions.push(x, y, z)
        b.bumpBounds(x, y, z)
        b.normals.push(0, 1, 0)
        const u = sizes[uvAxes[0]] > 1e-6 ? (posArr[i * 3 + uvAxes[0]] - mn[uvAxes[0]]) / sizes[uvAxes[0]] : 0.5
        const v = sizes[uvAxes[1]] > 1e-6 ? (posArr[i * 3 + uvAxes[1]] - mn[uvAxes[1]]) / sizes[uvAxes[1]] : 0.5
        b.uvs0.push(u, v)
    }

    const idxAttr = prim.getIndices()
    const idxCount = idxAttr ? idxAttr.getCount() : count
    const idxArr = idxAttr ? idxAttr.getArray() : null
    for(let i = 0; i < idxCount; i += 3) {
        const a = (idxArr ? idxArr[i] : i) + base
        const c = (idxArr ? idxArr[i + 1] : i + 1) + base
        const d = (idxArr ? idxArr[i + 2] : i + 2) + base
        b.indices.push(a, c, d)
    }
    b.vCount += count
    b.collectedTris += idxCount / 3
}

/* ============================== 主流程 ============================== */

async function main() {
    const input = process.argv[2] ?? INPUT_CANDIDATES.find((candidate) => fs.existsSync(candidate))
    if(!input || !fs.existsSync(input))
        throw new Error(`找不到输入文件: ${input ?? INPUT_CANDIDATES.join(' | ')}`)

    console.log(`输入: ${input}`)
    const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
    const document = await io.read(input)
    const root = document.getRoot()
    const scene = root.getDefaultScene() ?? root.listScenes()[0]

    await MeshoptSimplifier.ready

    /* ---------- 1. mesh 共享隔离 ---------- */
    {
        const usage = new Map()
        for(const node of root.listNodes()) {
            const mesh = node.getMesh()
            if(mesh)
                usage.set(mesh, (usage.get(mesh) ?? 0) + 1)
        }
        const firstUser = new Map()
        for(const node of root.listNodes()) {
            const mesh = node.getMesh()
            if(!mesh || (usage.get(mesh) ?? 0) <= 1)
                continue
            if(!firstUser.has(mesh)) {
                firstUser.set(mesh, node)
                continue
            }
            const clone = mesh.clone()
            clone.setName(`${mesh.getName()}_c${firstUser.size}`)
            node.setMesh(clone)
        }
    }

    /* ---------- 2. 世界矩阵 ---------- */
    const world = new Map()
    {
        const walk = (node, parentMatrix) => {
            const matrix = mMul(parentMatrix, nodeLocalMatrix(node))
            world.set(node, matrix)
            for(const child of node.listChildren())
                walk(child, matrix)
        }
        for(const s of root.listScenes())
            for(const node of s.listChildren())
                walk(node, mIdent())
    }

    /* ---------- 3. 定位车轮子树 ---------- */
    const ctrlWheels = root.listNodes().filter((node) => /^CTRL_Wheel_/i.test(node.getName()))
    if(ctrlWheels.length !== 4)
        throw new Error(`CTRL_Wheel_ 节点数量异常: ${ctrlWheels.length}`)
    const ctrlFL = ctrlWheels.find((node) => /FL$/i.test(node.getName()))
    if(!ctrlFL)
        throw new Error('找不到 CTRL_Wheel_FL')

    const subtreeMeshes = (node, out = new Set()) => {
        if(node.getMesh())
            out.add(node)
        for(const child of node.listChildren())
            subtreeMeshes(child, out)
        return out
    }
    const flMeshes = subtreeMeshes(ctrlFL)
    const otherWheelMeshes = new Set()
    for(const ctrl of ctrlWheels)
        if(ctrl !== ctrlFL)
            subtreeMeshes(ctrl, otherWheelMeshes)

    /* ---------- 4. 变换烘焙 ---------- */
    // F = T(0, Y_SHIFT, 0) * Ry(+90°) * S(SCALE) * T(0, 0, -AXLE_MID_Z)
    const F = mMul(
        mMul(mMul(mTrans(0, Y_SHIFT, 0), mRotY(Math.PI / 2)), mScale(SCALE)),
        mTrans(0, 0, -AXLE_MID_Z)
    )
    const nodeDet = new Map()
    const wheelAnchor = mMul(F, world.get(ctrlFL))

    for(const node of root.listNodes()) {
        const mesh = node.getMesh()
        if(!mesh || !world.has(node))
            continue
        if(otherWheelMeshes.has(node))
            continue // FR / RL / RR 将整体删除

        const full = mMul(F, world.get(node))
        if(flMeshes.has(node)) {
            // 车轮：以轮心为原点
            const rel = full.slice()
            rel[12] -= wheelAnchor[12]
            rel[13] -= wheelAnchor[13]
            rel[14] -= wheelAnchor[14]
            transformMesh(mesh, rel)
            nodeDet.set(node, det3(rel))
        }
        else {
            transformMesh(mesh, full)
            nodeDet.set(node, det3(full))
        }
    }

    /* ---------- 5. 数据收集 ---------- */
    const builders = {}
    for(const def of BUILDERS)
        builders[def.id] = new Builder(def)

    const unmapped = new Set()
    for(const node of root.listNodes()) {
        const mesh = node.getMesh()
        if(!mesh || !world.has(node) || otherWheelMeshes.has(node))
            continue
        const flip = (nodeDet.get(node) ?? 1) < 0
        const inWheel = flMeshes.has(node)
        const isStopSource = !inWheel && STOP_SOURCE.test(node.getName())

        for(const prim of mesh.listPrimitives()) {
            if(isStopSource) {
                copyPrim(builders.M_RedLens, prim, { flipNormals: flip })
                copyShell(builders.stopLights, prim, STOP_SHELL_SCALE)
                copyShell(builders.backLights, prim, BACK_SHELL_SCALE)
                continue
            }
            const materialName = prim.getMaterial()?.getName() ?? ''
            const targetId = inWheel ? WHEEL_MAP[materialName] : BODY_MAP[materialName]
            if(!targetId) {
                unmapped.add(`${materialName} (${node.getName()})`)
                continue
            }
            const builder = builders[targetId]
            copyPrim(builder, prim, { flipNormals: flip, texture: !!builder.def.texture })
        }
    }
    if(unmapped.size)
        throw new Error(`存在未映射材质:\n  ${[...unmapped].join('\n  ')}`)

    /* ---------- 6. bodyPainted 高度归一化 UV ---------- */
    {
        const b = builders.bodyPainted
        const sizeX = Math.max(1e-6, b.max[0] - b.min[0])
        const sizeY = Math.max(1e-6, b.max[1] - b.min[1])
        b.uvs0 = []
        b.uvs1 = []
        for(let i = 0; i < b.vCount; i++) {
            const u = (b.positions[i * 3] - b.min[0]) / sizeX
            const v = 1 - (b.positions[i * 3 + 1] - b.min[1]) / sizeY
            b.uvs0.push(u, v)
            b.uvs1.push(u, v)
        }
    }

    /* ---------- 7. 构建新网格与材质 ---------- */
    const outMaterials = new Map()
    const getMaterial = (name, def, builder) => {
        if(outMaterials.has(name))
            return outMaterials.get(name)
        const material = document.createMaterial(name)
        material.setBaseColorFactor(def.color)
        material.setMetallicFactor(0)
        material.setRoughnessFactor(1)
        if(def.texture) {
            if(!builder?.sourceTexture)
                throw new Error(`材质 ${name} 需要贴图但未找到源纹理`)
            material.setBaseColorTexture(builder.sourceTexture)
        }
        outMaterials.set(name, material)
        return material
    }
    // 先创建全部材质（共享名字自动复用）
    for(const def of BUILDERS) {
        const builder = builders[def.id]
        const matDef = MAT_DEFS[def.mat]
        if(!matDef)
            throw new Error(`缺少材质定义: ${def.mat}`)
        builder.material = getMaterial(def.mat, matDef, builder)
    }

    const buildMesh = (builder) => {
        const b = builder
        const mesh = document.createMesh(b.def.node)
        const prim = document.createPrimitive()

        const posAcc = document.createAccessor(`${b.def.node}_pos`)
            .setType('VEC3')
            .setArray(new Float32Array(b.positions))
        prim.setAttribute('POSITION', posAcc)

        prim.setAttribute('NORMAL', document.createAccessor(`${b.def.node}_nor`)
            .setType('VEC3')
            .setArray(new Float32Array(b.normals)))

        if(b.uvs0)
            prim.setAttribute('TEXCOORD_0', document.createAccessor(`${b.def.node}_uv`)
                .setType('VEC2')
                .setArray(new Float32Array(b.uvs0)))
        if(b.uvs1)
            prim.setAttribute('TEXCOORD_1', document.createAccessor(`${b.def.node}_uv1`)
                .setType('VEC2')
                .setArray(new Float32Array(b.uvs1)))

        prim.setIndices(document.createAccessor(`${b.def.node}_idx`)
            .setArray(new Uint32Array(b.indices)))
        prim.setMaterial(b.material)
        mesh.addPrimitive(prim)
        b.mesh = mesh
        b.prim = prim
    }
    for(const def of BUILDERS) {
        const builder = builders[def.id]
        if(builder.vCount === 0) {
            console.warn(`  [warn] builder ${def.id} 没有收集到几何，跳过`)
            continue
        }
        buildMesh(builder)
    }

    /* ---------- 8. weld + simplify ---------- */
    for(const def of BUILDERS) {
        const builder = builders[def.id]
        if(!builder.prim)
            continue
        const before = builder.prim.getIndices().getCount() / 3
        weldPrimitive(builder.prim)
        const [ratio, error] = def.simplify
        if(ratio < 1)
            simplifyPrimitive(builder.prim, { simplifier: MeshoptSimplifier, ratio, error })
        builder.finalTris = builder.prim.getIndices().getCount() / 3
        builder.ratioActual = before > 0 ? builder.finalTris / before : 1
    }

    /* ---------- 9. 重建节点树 ---------- */
    const chassis = document.createNode('chassis')
    chassis.setExtras({ wheelLimit: WHEEL_LIMIT, boostTrails: BOOST_TRAILS })

    const wheelContainer = document.createNode('wheelContainer')
    wheelContainer.setTranslation(WHEEL_CONTAINER_POS)

    const wheelCylinder = document.createNode('wheelCylinder')
    const caliper = document.createNode('caliper')
    wheelContainer.addChild(wheelCylinder)
    wheelContainer.addChild(caliper)

    const parents = { chassis, wheelCylinder, caliper }
    for(const def of BUILDERS) {
        const builder = builders[def.id]
        if(!builder.mesh)
            continue
        const node = document.createNode(def.node)
        node.setMesh(builder.mesh)
        parents[def.parent ?? 'chassis'].addChild(node)
        builder.node = node
    }

    /* ---------- 10. 清理旧节点 ---------- */
    {
        const keep = new Set()
        const keepWalk = (node) => {
            keep.add(node)
            for(const child of node.listChildren())
                keepWalk(child)
        }
        keepWalk(chassis)
        keepWalk(wheelContainer)
        for(const node of root.listNodes())
            if(!keep.has(node))
                node.dispose()
        scene.addChild(chassis)
        scene.addChild(wheelContainer)

        // 可达性校验：确保全部新网格都挂在场景树上
        for(const def of BUILDERS) {
            const builder = builders[def.id]
            if(builder.mesh && !keep.has(builder.node))
                throw new Error(`节点 ${def.node} 不在场景树上（构建错误）`)
        }
    }

    /* ---------- 11. prune ---------- */
    await document.transform(prune({ keepExtras: true, keepAttributes: true }))

    /* ---------- 12. 纹理：resize 上限 1024，无 alpha → JPEG q85（与 hunyuan/process.js 一致） ---------- */
    for(const texture of root.listTextures()) {
        const image = texture.getImage()
        if(!image)
            continue
        const metadata = await sharp(Buffer.from(image)).metadata()
        await compressTexture(texture, {
            encoder: sharp,
            targetFormat: metadata.hasAlpha ? 'png' : 'jpeg',
            resize: [1024, 1024],
            quality: 85,
        })
    }

    /* ---------- 13. 统计与写出 ---------- */
    let totalTris = 0
    const lines = []
    for(const def of BUILDERS) {
        const builder = builders[def.id]
        if(!builder.mesh)
            continue
        totalTris += builder.finalTris
        lines.push(`  ${def.node.padEnd(18)} tris ${String(Math.round(builder.finalTris)).padStart(6)}  (收集 ${Math.round(builder.collectedTris)}, 实际比 ${builder.ratioActual.toFixed(2)})`)
    }
    console.log('===== 组统计 =====')
    console.log(lines.join('\n'))
    console.log(`总三角面: ${Math.round(totalTris)}`)

    // 车轮几何自检（应以原点为中心、直径约 0.41、轴沿 Z）
    {
        const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
        for(const def of BUILDERS) {
            if(!def.parent)
                continue
            const builder = builders[def.id]
            if(!builder.mesh)
                continue
            for(let k = 0; k < 3; k++) {
                bounds.min[k] = Math.min(bounds.min[k], builder.min[k])
                bounds.max[k] = Math.max(bounds.max[k], builder.max[k])
            }
        }
        const center = [0, 1, 2].map((k) => (bounds.min[k] + bounds.max[k]) / 2)
        const size = [0, 1, 2].map((k) => bounds.max[k] - bounds.min[k])
        console.log(`车轮 bbox 中心 [${center.map((v) => v.toFixed(3)).join(', ')}] 尺寸 [${size.map((v) => v.toFixed(3)).join(', ')}]`)
    }

    for(const texture of root.listTextures()) {
        const size = texture.getSize()
        console.log(`  纹理 ${texture.getName()} ${size ? `${size[0]}x${size[1]}` : '?'} ${texture.getMimeType()}`)
    }

    fs.mkdirSync(OUTPUT.split('/').slice(0, -1).join('/'), { recursive: true })
    await io.write(OUTPUT, document)
    console.log(`写入: ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
