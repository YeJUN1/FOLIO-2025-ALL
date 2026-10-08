import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/vehicle/default.glb')
const root = doc.getRoot()

// Per-node info: transform + own mesh bounds + subtree bounds
const printNode = (node, depth, parentMatrix) => {
    if(depth > 3) return
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale()
    console.log('  '.repeat(depth) + `- ${node.getName()} | t:[${t.map(v=>+v.toFixed(3))}] q:[${r.map(v=>+v.toFixed(3))}] s:[${s.map(v=>+v.toFixed(3))}]`)
    const mesh = node.getMesh()
    if(mesh) {
        // own bounds (local space of node)
        let min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity]
        for(const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION')
            if(!pos) continue
            const pmin = pos.getMin([]), pmax = pos.getMax([])
            for(let i=0;i<3;i++){ min[i]=Math.min(min[i],pmin[i]); max[i]=Math.max(max[i],pmax[i]) }
        }
        const matNames = mesh.listPrimitives().map(p => p.getMaterial()?.getName()).join(',')
        console.log('  '.repeat(depth + 1) + `  [mesh bounds min:${min.map(v=>+v.toFixed(3))} max:${max.map(v=>+v.toFixed(3))} mats: ${matNames}]`)
    }
    for(const child of node.listChildren()) printNode(child, depth + 1, null)
}

for(const scene of root.listScenes())
    for(const node of scene.listChildren()) printNode(node, 0, null)

console.log('=== Materials ===')
for(const mat of root.listMaterials()) {
    const tex = mat.getBaseColorTexture()
    console.log(` ${mat.getName()} | baseColor:[${mat.getBaseColorFactor().map(v=>+v.toFixed(2))}] | metal:${mat.getMetallicFactor()} rough:${mat.getRoughnessFactor()} | tex:${tex ? tex.getName() : '-'}`)
}
