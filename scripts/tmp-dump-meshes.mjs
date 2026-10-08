import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/Lamborghini+Revuelto.glb')
const root = doc.getRoot()

const rows = []
const visit = (node, trail) => {
    const mesh = node.getMesh()
    if(mesh) {
        for(const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION')
            const tris = prim.getIndices() ? Math.round(prim.getIndices().getCount() / 3) : 0
            const mat = prim.getMaterial()
            const attrs = prim.listSemantics()
            rows.push({ node: node.getName() || '(unnamed)', trail: trail.join('/'), mat: mat?.getName() || '-', tris, attrs: attrs.join('+') })
        }
    }
    for(const child of node.listChildren()) visit(child, [ ...trail, node.getName() ])
}
for(const scene of root.listScenes())
    for(const node of scene.listChildren()) visit(node, [])

// 按材质聚合
const byMaterial = {}
for(const r of rows) {
    if(!byMaterial[r.mat]) byMaterial[r.mat] = { tris: 0, prims: 0, nodes: [] }
    byMaterial[r.mat].tris += r.tris
    byMaterial[r.mat].prims++
    byMaterial[r.mat].nodes.push(r.node)
}
console.log('=== 按材质聚合 (材质: 面数 | 原始数 | 涉及节点示例) ===')
for(const [mat, info] of Object.entries(byMaterial).sort((a, b) => b[1].tris - a[1].tris))
    console.log(`${mat}: ${info.tris} | ${info.prims} | ${info.nodes.slice(0, 4).join(', ')}`)

console.log('\n=== 属性组合 ===')
const attrSets = new Set(rows.map(r => r.attrs))
console.log([ ...attrSets ].join('\n'))

console.log('\n=== emission/label 相关材质细节 ===')
for(const mat of root.listMaterials()) {
    const name = mat.getName()
    if(/emission|emitter|headlight|label|badge|glass/i.test(name)) {
        console.log(`${name}: emissive=${JSON.stringify(mat.getEmissiveFactor())} baseColor=${JSON.stringify(mat.getBaseColorFactor())}`)
    }
}
