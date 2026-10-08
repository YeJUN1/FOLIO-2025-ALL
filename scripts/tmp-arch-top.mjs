/* 轮拱腔顶射线分析：从车轮轴心区域垂直向上打射线，取车身最近命中点（真腔顶） */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/vehicle/revuelto.glb')
const root = doc.getRoot()
const chassis = root.listNodes().find(n => n.getName() === 'chassis')

const AXLE_X = 0.843
const AXLE_Z = 0.5166
const WHEEL_R = 0.2068
const RAY_START_Y = -0.75 // 从轮心向上打

// 采样：轴心周围 ±0.07（x 前后 / z 轮宽方向）
const samples = []
for(const dx of [-0.07, 0, 0.07])
    for(const dz of [-0.07, 0, 0.07])
        samples.push([AXLE_X + dx, AXLE_Z + dz])

// 收集车身三角形（排除车轮/车灯壳节点）
const EXCLUDE = new Set(['wheelContainer', 'stopLights', 'backLights'])
const tris = []
for(const node of chassis.listChildren()) {
    if(EXCLUDE.has(node.getName()))
        continue
    const mesh = node.getMesh()
    if(!mesh)
        continue
    for(const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION').getArray()
        const idx = prim.getIndices()?.getArray()
        const count = idx ? idx.length : pos.length / 3
        for(let i = 0; i < count; i += 3) {
            const a = (idx ? idx[i] : i) * 3
            const b = (idx ? idx[i + 1] : i + 1) * 3
            const c = (idx ? idx[i + 2] : i + 2) * 3
            tris.push([pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2], node.getName()])
        }
    }
}
console.log(`车身三角形总数 ${tris.length}`)

// Möller–Trumbore（方向 d=(0,1,0) 特化，起点 y=RAY_START_Y，返回命中 y 或 null）
function hit(sx, sz, t) {
    const ax = t[0], ay = t[1], az = t[2], bx = t[3], by = t[4], bz = t[5], cx = t[6], cy = t[7], cz = t[8]
    const e1x = bx - ax, e1z = bz - az
    const e2x = cx - ax, e2z = cz - az
    const det = e1x * e2z - e1z * e2x
    if(Math.abs(det) < 1e-12)
        return null
    const inv = 1 / det
    const tx = sx - ax, ty = RAY_START_Y - ay, tz = sz - az
    const u = (tx * e2z - tz * e2x) * inv
    if(u < 0 || u > 1)
        return null
    const qx = ty * e1z - tz * (by - ay)
    const qy = tz * e1x - tx * e1z
    const qz = tx * (by - ay) - ty * e1x
    const v = qy * inv
    if(v < 0 || u + v > 1)
        return null
    const tHit = (e2x * qx + (cy - ay) * qy + e2z * qz) * inv
    return tHit > 0 ? RAY_START_Y + tHit : null
}

console.log('===== 各采样点腔顶（垂直射线第一命中 y） =====')
let minCeil = Infinity
for(const [sx, sz] of samples) {
    let best = Infinity, bestName = ''
    for(const tri of tris) {
        const y = hit(sx, sz, tri)
        if(y !== null && y < best) {
            best = y
            bestName = tri[9]
        }
    }
    console.log(`  (x=${sx.toFixed(3)}, z=${sz.toFixed(3)})  腔顶 y = ${best === Infinity ? '无命中' : `${best.toFixed(4)}  [${bestName}]`}`)
    if(best < minCeil)
        minCeil = best
}

console.log(`\n全采样最低腔顶 = ${minCeil.toFixed(4)}`)
console.log(`轮半径 = ${WHEEL_R}，轮顶（静止，轮心 -0.75）= ${(-0.75 + WHEEL_R).toFixed(4)}`)
for(const margin of [0.01, 0.015, 0.02])
    console.log(`  防穿 margin ${margin} → wheelLimit ≤ ${(minCeil - WHEEL_R - margin).toFixed(4)}`)
