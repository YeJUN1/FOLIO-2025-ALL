import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(process.argv[2])
const root = doc.getRoot()

console.log('=== Nodes with meshes (top level structure) ===')
const printNode = (node, depth) => {
    if(depth <= 3) {
        const mesh = node.getMesh()
        if(mesh || depth <= 1)
            console.log('  '.repeat(depth) + '- ' + (node.getName() || '(unnamed)') + (mesh ? ' [MESH]' : ''))
    }
    for(const child of node.listChildren()) printNode(child, depth + 1)
}
for(const scene of root.listScenes())
    for(const node of scene.listChildren()) printNode(node, 0)

// Compute world-space bounds
const worldBounds = (() => {
    const results = []
    for(const scene of root.listScenes()) {
        const visit = (node, matrix) => {
            const local = node.getMatrix()
            const t = node.getTranslation(), r = node.getRotation(), s = node.getScale()
            // build local matrix from TRS
            const lm = [
                (1 - 2*(r[1]*r[1] + r[2]*r[2])) * s[0], (2*(r[0]*r[1] + r[2]*r[3])) * s[0], (2*(r[0]*r[2] - r[1]*r[3])) * s[0], 0,
                (2*(r[0]*r[1] - r[2]*r[3])) * s[1], (1 - 2*(r[0]*r[0] + r[2]*r[2])) * s[1], (2*(r[1]*r[2] + r[0]*r[3])) * s[1], 0,
                (2*(r[0]*r[2] + r[1]*r[3])) * s[2], (2*(r[1]*r[2] - r[0]*r[3])) * s[2], (1 - 2*(r[0]*r[0] + r[1]*r[1])) * s[2], 0,
                t[0], t[1], t[2], 1
            ]
            const mul = (a, b) => {
                const o = new Array(16).fill(0)
                for(let i = 0; i < 4; i++) for(let j = 0; j < 4; j++) for(let k = 0; k < 4; k++)
                    o[i*4+j] += a[k*4+j] * b[i*4+k]
                return o
            }
            const m = mul(matrix, lm)
            const mesh = node.getMesh()
            if(mesh) {
                for(const prim of mesh.listPrimitives()) {
                    const pos = prim.getAttribute('POSITION')
                    if(!pos) continue
                    const min = pos.getMin([]), max = pos.getMax([])
                    if(!min) continue
                    // 8 corners
                    for(const x of [min[0], max[0]]) for(const y of [min[1], max[1]]) for(const z of [min[2], max[2]]) {
                        const wx = m[0]*x + m[4]*y + m[8]*z + m[12]
                        const wy = m[1]*x + m[5]*y + m[9]*z + m[13]
                        const wz = m[2]*x + m[6]*y + m[10]*z + m[14]
                        results.push([wx, wy, wz])
                    }
                }
            }
            for(const child of node.listChildren()) visit(child, m)
        }
        const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
        for(const node of scene.listChildren()) visit(node, identity)
    }
    return results
})()

const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity]
for(const p of worldBounds) for(let i = 0; i < 3; i++) { mins[i] = Math.min(mins[i], p[i]); maxs[i] = Math.max(maxs[i], p[i]) }
console.log('=== World bounds ===')
console.log(' min:', mins.map(v => v.toFixed(3)).join(', '))
console.log(' max:', maxs.map(v => v.toFixed(3)).join(', '))
console.log(' size:', maxs.map((v, i) => (v - mins[i]).toFixed(3)).join(' x '))
