import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/Lamborghini+Revuelto.glb')
const root = doc.getRoot()

// 车轮中心 (model space)
const wheels = {
    FL: { x: 0.852, y: 0.341, z: 1.393 },
    FR: { x: -0.853, y: 0.341, z: 1.393 },
    RL: { x: 0.852, y: 0.341, z: -1.388 },
    RR: { x: -0.853, y: 0.341, z: -1.388 },
}

// 遍历所有非车轮节点（GRP_* 下的 body 几何），找各轮拱内顶
const wheelNames = /Wheel|^CTRL/ 
const results = {}
const visit = (node, worldMat, isWheelSubtree) => {
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale()
    const m = [
        (1-2*(r[1]*r[1]+r[2]*r[2]))*s[0], (2*(r[0]*r[1]+r[2]*r[3]))*s[0], (2*(r[0]*r[2]-r[1]*r[3]))*s[0], 0,
        (2*(r[0]*r[1]-r[2]*r[3]))*s[1], (1-2*(r[0]*r[0]+r[2]*r[2]))*s[1], (2*(r[1]*r[2]+r[0]*r[3]))*s[1], 0,
        (2*(r[0]*r[2]+r[1]*r[3]))*s[2], (2*(r[1]*r[2]-r[0]*r[3]))*s[2], (1-2*(r[0]*r[0]+r[1]*r[1]))*s[2], 0,
        t[0], t[1], t[2], 1
    ]
    // m = world * local
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
        // 车轮上方 0.2 半径圆柱内的最低点
        for(const wheel of Object.values(wheels)) {
            let minY = Infinity
            for(const prim of mesh.listPrimitives()) {
                const pos = prim.getAttribute('POSITION')
                if(!pos) continue
                const arr = pos.getArray()
                for(let i = 0; i < arr.length; i += 3) {
                    const vx = wm[0]*arr[i] + wm[4]*arr[i+1] + wm[8]*arr[i+2] + wm[12]
                    const vy = wm[1]*arr[i] + wm[5]*arr[i+1] + wm[9]*arr[i+2] + wm[13]
                    const vz = wm[2]*arr[i] + wm[6]*arr[i+1] + wm[10]*arr[i+2] + wm[14]
                    const dx = vx - wheel.x, dz = vz - wheel.z
                    if(dx*dx + dz*dz < 0.04 && vy > wheel.y + 0.25) { // 半径0.2圆柱内, 高于轮轴0.25以上
                        if(vy < minY) minY = vy
                    }
                }
            }
            if(minY < Infinity) {
                const key = `wheel_${wheel.x.toFixed(0)}_${wheel.z.toFixed(0)}`
                results[key] = results[key] === undefined ? minY : Math.min(results[key], minY)
            }
        }
    }
    for(const child of node.listChildren()) visit(child, wm, inWheel)
}

const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
for(const scene of root.listScenes())
    for(const node of scene.listChildren()) visit(node, identity, false)

console.log('=== 各轮拱内顶 (model space y) ===')
for(const [k, v] of Object.entries(results)) {
    console.log(`${k}: 拱顶 y=${v.toFixed(3)}`)
}
