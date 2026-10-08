/* dump 车身各组 bbox（chassis 局部坐标），用于物理碰撞体设计 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/vehicle/revuelto.glb')
const root = doc.getRoot()
const chassis = root.listNodes().find(n => n.getName() === 'chassis')

const overall = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
const merge = (b, min, max) => {
    for(let k = 0; k < 3; k++) {
        b.min[k] = Math.min(b.min[k], min[k])
        b.max[k] = Math.max(b.max[k], max[k])
    }
}

for(const child of chassis.listChildren()) {
    const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    const t = child.getTranslation()
    for(const grandChild of child.listChildren()) {
        const mesh = grandChild.getMesh()
        if(!mesh) continue
        for(const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION')
            const min = pos.getMin([]), max = pos.getMax([])
            merge(bbox, [min[0]+t[0], min[1]+t[1], min[2]+t[2]], [max[0]+t[0], max[1]+t[1], max[2]+t[2]])
        }
    }
    // 自身 mesh 情况（车身组直接挂 mesh）
    const ownMesh = child.getMesh()
    if(ownMesh) {
        for(const prim of ownMesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION')
            const min = pos.getMin([]), max = pos.getMax([])
            merge(bbox, [min[0]+t[0], min[1]+t[1], min[2]+t[2]], [max[0]+t[0], max[1]+t[1], max[2]+t[2]])
        }
    }
    if(bbox.min[0] === Infinity) continue
    console.log(child.getName().padEnd(16),
        'x:[' + bbox.min[0].toFixed(2) + ',' + bbox.max[0].toFixed(2) + ']',
        'y:[' + bbox.min[1].toFixed(2) + ',' + bbox.max[1].toFixed(2) + ']',
        'z:[' + bbox.min[2].toFixed(2) + ',' + bbox.max[2].toFixed(2) + ']')
    if(child.getName() !== 'wheelContainer')
        merge(overall, bbox.min, bbox.max)
}

console.log('---')
console.log('车身整体',
    'x:[' + overall.min[0].toFixed(3) + ',' + overall.max[0].toFixed(3) + ']',
    'y:[' + overall.min[1].toFixed(3) + ',' + overall.max[1].toFixed(3) + ']',
    'z:[' + overall.min[2].toFixed(3) + ',' + overall.max[2].toFixed(3) + ']')
console.log('尺寸: 长', (overall.max[0]-overall.min[0]).toFixed(3), '高', (overall.max[1]-overall.min[1]).toFixed(3), '宽', (overall.max[2]-overall.min[2]).toFixed(3))
