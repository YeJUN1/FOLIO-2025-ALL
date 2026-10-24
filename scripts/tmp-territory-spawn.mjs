import { NodeIO } from '@gltf-transform/core'

// 采样 terrain.glb 顶点高度，在指定矩形内找稳在陆地上的出生点
// 用法：node scripts/tmp-territory-spawn.mjs [minX maxX minZ maxZ]
const io = new NodeIO()
const doc = await io.read('static/terrain/terrain.glb')

const rect = {
    minX: Number(process.argv[2] ?? -96),
    maxX: Number(process.argv[3] ?? -37.2),
    minZ: Number(process.argv[4] ?? -16.2),
    maxZ: Number(process.argv[5] ?? 26.3),
}
const WATER = -0.3

const points = []
for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION')
        if (!pos) continue
        const arr = pos.getArray()
        for (let i = 0; i < pos.getCount(); i++) {
            const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2]
            if (x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ)
                points.push({ x, y, z })
        }
    }
}

const land = points.filter(p => p.y > WATER)
console.log(`矩形 x[${rect.minX},${rect.maxX}] z[${rect.minZ},${rect.maxZ}] 顶点 ${points.length}，陆地(y>${WATER}) ${land.length}`)

if (land.length) {
    // 取矩形中心附近、且是陆地的最高代表点
    const cx = (rect.minX + rect.maxX) / 2, cz = (rect.minZ + rect.maxZ) / 2
    land.sort((a, b) => (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz)))
    const near = land.slice(0, 20)
    const best = near.reduce((m, p) => p.y > m.y ? p : m, near[0])
    console.log('中心最近的陆地顶点(前20里最高的):', JSON.stringify({ x: +best.x.toFixed(2), y: +best.y.toFixed(2), z: +best.z.toFixed(2) }))
    // 报告中心点附近陆地的 x/z 分布范围
    const landX = land.map(p => p.x), landZ = land.map(p => p.z)
    console.log('陆地 x 范围', Math.min(...landX).toFixed(1), '~', Math.max(...landX).toFixed(1))
    console.log('陆地 z 范围', Math.min(...landZ).toFixed(1), '~', Math.max(...landZ).toFixed(1))
} else {
    console.log('⚠️ 该矩形内没有高于水面的陆地顶点')
}
