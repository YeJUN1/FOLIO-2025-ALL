/* Revuelto 物理参数校验：复刻游戏 updateSettings 的真实调用（无 restLength/stiffness，用 Rapier 默认）
 * 验证：静止悬挂 L / 落地冲击压缩 / main 碰撞体是否穿地 */
import * as RAPIER from './tmp-rapier3d/rapier.js'

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
const dt = 1 / 60
world.timestep = dt

{
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200), groundBody)
    // 路面小凸起（模拟颠簸）: 高 0.15
    const bump = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(12, 0.075, 0))
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.075, 3), bump)
}

const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 6, 0).setLinearDamping(0.1).setAngularDamping(0.1))

// === 候选碰撞体布局（main 留 0.17 压缩间隙，bumper 贴视觉但只撞 object 组） ===
const MAIN = { h: [1.32, 0.25, 0.60], p: [0.05, -0.565, 0] } // y:[-0.815,-0.315]
const TOP  = { h: [0.90, 0.14, 0.50], p: [-0.15, -0.42, 0] } // y:[-0.56,-0.28]
const BUMPER = { h: [1.45, 0.29, 0.64], p: [0.06, -0.68, 0] } // y:[-0.97,-0.39]

{
    world.createCollider(RAPIER.ColliderDesc.cuboid(...MAIN.h).setTranslation(...MAIN.p)
        .setMassProperties(2.5, { x: 0, y: -0.90, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4).setRestitution(0.15), body)
    world.createCollider(RAPIER.ColliderDesc.cuboid(...TOP.h).setTranslation(...TOP.p).setMass(0).setFriction(0.4).setRestitution(0.15), body)
    world.createCollider(RAPIER.ColliderDesc.cuboid(...BUMPER.h).setTranslation(...BUMPER.p).setMass(0).setFriction(0.4).setRestitution(0.15), body)
}

// === 车轮：与游戏 updateSettings 完全一致（不设 restLength / stiffness） ===
const radius = 0.2068
const offset = { x: 0.8430, z: 0.5166 }
const controller = world.createVehicleController(body)
const wheelPositions = [
    { x: +offset.x, y: 0, z: +offset.z }, { x: +offset.x, y: 0, z: -offset.z },
    { x: -offset.x, y: 0, z: +offset.z }, { x: -offset.x, y: 0, z: -offset.z },
]
for(let i = 0; i < 4; i++)
{
    controller.addWheel({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, 1, radius)
    controller.setWheelChassisConnectionPointCs(i, wheelPositions[i])
    controller.setWheelDirectionCs(i, { x: 0, y: -1, z: 0 })
    controller.setWheelAxleCs(i, { x: 0, y: 0, z: 1 })
    controller.setWheelRadius(i, radius)
    controller.setWheelFrictionSlip(i, 0.9)
    controller.setWheelMaxSuspensionForce(i, 150)
    controller.setWheelMaxSuspensionTravel(i, 2)
    controller.setWheelSideFrictionStiffness(i, 3)
    controller.setWheelSuspensionCompression(i, 10)
    controller.setWheelSuspensionRelaxation(i, 2.7)
}

const stats = () => ({ min: [Infinity, Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity, -Infinity], chassisMinY: Infinity, chassisMaxY: -Infinity })
const record = (s) => {
    for(let i = 0; i < 4; i++) {
        const l = controller.wheelSuspensionLength(i)
        s.min[i] = Math.min(s.min[i], l)
        s.max[i] = Math.max(s.max[i], l)
    }
    const y = body.translation().y
    s.chassisMinY = Math.min(s.chassisMinY, y)
    s.chassisMaxY = Math.max(s.chassisMaxY, y)
}
const step = (engineForce = 0, brake = 0) => {
    for(let i = 0; i < 4; i++) { controller.setWheelEngineForce(i, engineForce); controller.setWheelBrake(i, brake) }
    controller.updateVehicle(dt)
    world.step()
}
// 阶段1: 落地冲击
let s1 = stats()
for(let f = 0; f < 240; f++) { step(); record(s1) }
console.log(`落地冲击  L: ${s1.min.map(v=>v.toFixed(3)).join('/')} ~ ${s1.max.map(v=>v.toFixed(3)).join('/')}  chassisY: ${s1.chassisMinY.toFixed(3)}~${s1.chassisMaxY.toFixed(3)}`)

// 阶段2: 加速巡航 + 越过凸起
let s2 = stats()
for(let f = 0; f < 480; f++) { step(5); record(s2) }
console.log(`巡航+颠簸 L: ${s2.min.map(v=>v.toFixed(3)).join('/')} ~ ${s2.max.map(v=>v.toFixed(3)).join('/')}  chassisY: ${s2.chassisMinY.toFixed(3)}~${s2.chassisMaxY.toFixed(3)}`)

// 阶段3: 刹车俯冲
let s3 = stats()
for(let f = 0; f < 120; f++) { step(0, 0.58); record(s3) }
console.log(`刹车俯冲  L: ${s3.min.map(v=>v.toFixed(3)).join('/')} ~ ${s3.max.map(v=>v.toFixed(3)).join('/')}  chassisY: ${s3.chassisMinY.toFixed(3)}~${s3.chassisMaxY.toFixed(3)}`)

// 阶段4: 静止
for(let f = 0; f < 180; f++) step()
const chassisY = body.translation().y
const wheels = [0,1,2,3].map(i => controller.wheelSuspensionLength(i))
console.log(`静止 L: ${wheels.map(v=>v.toFixed(3)).join('/')}  chassisY: ${chassisY.toFixed(4)}`)
console.log(`静止时: 轮底世界 ${(chassisY - wheels[0] - radius).toFixed(4)} | main底 ${(chassisY - (MAIN.p[1] + MAIN.h[1])).toFixed(4)} | bumper底 ${(chassisY - (BUMPER.p[1] + BUMPER.h[1])).toFixed(4)}`)
console.log(`全程 chassisY 最小值: ${Math.min(s1.chassisMinY, s2.chassisMinY, s3.chassisMinY).toFixed(4)} -> main底 ${(Math.min(s1.chassisMinY, s2.chassisMinY, s3.chassisMinY) - (MAIN.p[1] + MAIN.h[1])).toFixed(4)} (负=穿地)`)
