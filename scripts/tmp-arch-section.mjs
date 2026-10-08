import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/Lamborghini+Revuelto.glb')
const root = doc.getRoot()

// 车轮中心 (model space)
const wheels = {
    FL: { x: 0.852, y: 0.341, z: 1.393 },
    RL: { x: 0.852, y: 0.341, z: -1.388 },
}

// 断面: z = 轮心 z ± 0.04, x ∈ [0.5, 1.2], y ∈ [0.3, 1.1]
// 按 x 分桶打印最小 y -> 轮廓剖面
const visit = (node, worldMat, isWheelSubtree) => {
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale()
    const m = [
        (1-2*(r[1]*r[1]+r[2]*r[2]))*s[0], (2*(r[0]*r[1]+r[2]*r[3]))*s[0], (2*(r[0]*r[2]-r[1]*r[3]))*s[0], 0,
        (2*(r[0]*r[1]-r[2]*r[3]))*s[1], (1-2*(r[0]*r[0]+r[2]*r[2]))*s[1], (2*(r[1]*r[2]+r[0]*r[3]))*s[1], 0,
        (2*(r[0]*r[2]+r[1]*r[3]))*s[2], (2*(r[1]*r[2]-r[0]*r[3]))*s[2], (1-2*(r[0]*r[0]+r[1]*r[1]))*s[2], 0,
        t[0], t[1], t[2], 1
    ]
    const mul = (a, b) => {
        const o = new Array(16).fill(0)
        for(let i = 0; i < 4; i++) for(let j = 0; j < 4; j++) for(let k = 0; k < 4; k++)
            o[i*4+j] += a[k*4+j] * b[i*4+k]
        return o
    }
    const wm = mul(worldMat, m)
    const inWheel = isWheelSubtree || /^CTRL_Wheel|^Wheel_/.test(node.getName() || '')

    const mesh = node.getMesh()
    if(mesh && !inWheel) {
        for(const [label, wheel] of Object.entries(wheels)) {
            const bins = new Array(28).fill(Infinity) // x: 0.50..1.20, 步 0.025
            for(const prim of mesh.listPrimitives()) {
                const pos = prim.getAttribute('POSITION')
                if(!pos) continue
                const arr = pos.getArray()
                for(let i = 0; i < arr.length; i += 3) {
                    const vx = wm[0]*arr[i] + wm[4]*arr[i+1] + wm[8]*arr[i+2] + wm[12]
                    const vy = wm[1]*arr[i] + wm[5]*arr[i+1] + wm[9]*arr[i+2] + wm[13]
                    const vz = wm[2]*arr[i] + wm[6]*arr[i+1] + wm[10]*arr[i+2] + wm[14]
                    if(Math.abs(vz - wheel.z) > 0.04) continue
                    if(vx < 0.5 || vx > 1.2) continue
                    if(vy < 0.3 || vy > 1.1) continue
                    const bin = Math.min(27, Math.max(0, Math.floor((vx - 0.5) / 0.025)))
                    if(vy < bins[bin]) bins[bin] = vy
                }
            }
            if(label === 'FL' || label === 'RL') {
                console.log(`=== ${label} 断面 (z=${wheel.z}) x 从 0.50 到 1.20, bin=0.025 ===`)
                for(let b = 0; b < 28; b++) {
                    if(bins[b] < Infinity)
                        console.log(`x=${(0.5 + b*0.025).toFixed(3)}~${(0.5 + (b+1)*0.025).toFixed(3)}  minY=${bins[b].toFixed(3)}`)
                }
            }
        }
    }
    for(const child of node.listChildren()) visit(child, wm, inWheel)
}

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
for(const scene of root.listScenes())
    for(const node of scene.listChildren()) visit(node, identity, false)
