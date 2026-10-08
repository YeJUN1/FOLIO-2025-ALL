import * as RAPIER from './tmp-rapier3d/rapier.js'

const radius = process.argv[2] ? parseFloat(process.argv[2]) : 0.4
const offsetX = process.argv[3] ? parseFloat(process.argv[3]) : 0.90
const offsetZ = process.argv[4] ? parseFloat(process.argv[4]) : 0.75

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
{
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.3, 0.4, 0.85).setTranslation(0, -0.1, 0)
        .setMassProperties(2.5, { x: 0, y: -0.5, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4).setRestitution(0.15), body)
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.15, 0.65).setTranslation(0, 0.4, 0).setMass(0).setFriction(0.4).setRestitution(0.15), body)
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 0.5, 0.9).setTranslation(0.1, -0.2, 0).setMass(0).setFriction(0.4).setRestitution(0.15), body)
}

const controller = world.createVehicleController(body)
const wheelPositions = [
    { x: +offsetX, y: 0, z: +offsetZ }, { x: +offsetX, y: 0, z: -offsetZ },
    { x: -offsetX, y: 0, z: +offsetZ }, { x: -offsetX, y: 0, z: -offsetZ },
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
    controller.setWheelSuspensionRestLength(i, 0.88)
    controller.setWheelSuspensionStiffness(i, 20)
}

const stats = () => ({ min: [Infinity, Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity, -Infinity] })
const record = (s) => {
    for(let i = 0; i < 4; i++) {
        const l = controller.wheelSuspensionLength(i)
        s.min[i] = Math.min(s.min[i], l)
        s.max[i] = Math.max(s.max[i], l)
    }
}
const step = (engineForce = 0, brake = 0) => {
    for(let i = 0; i < 4; i++) { controller.setWheelEngineForce(i, engineForce); controller.setWheelBrake(i, brake) }
    controller.updateVehicle(dt)
    world.step()
}

// 阶段1: 落地冲击 (从 y=6 落到地面)
let s1 = stats()
for(let f = 0; f < 240; f++) { step(); record(s1) }
console.log(`落地冲击 L范围: ${s1.min.map(v=>v.toFixed(3)).join('/')} ~ ${s1.max.map(v=>v.toFixed(3)).join('/')}`)

// 阶段2: 加速巡航 + 越过凸起 (模拟游戏 engineForce ~5/帧)
let s2 = stats()
for(let f = 0; f < 480; f++) { step(5); record(s2) }
console.log(`巡航+颠簸 L范围: ${s2.min.map(v=>v.toFixed(3)).join('/')} ~ ${s2.max.map(v=>v.toFixed(3)).join('/')}`)

// 阶段3: 刹车俯冲 (brake ~0.58/帧)
let s3 = stats()
for(let f = 0; f < 120; f++) { step(0, 0.58); record(s3) }
console.log(`刹车俯冲 L范围: ${s3.min.map(v=>v.toFixed(3)).join('/')} ~ ${s3.max.map(v=>v.toFixed(3)).join('/')}`)

// 阶段4: 静止重新平衡
for(let f = 0; f < 180; f++) step()
console.log(`静止 L: ${[0,1,2,3].map(i=>controller.wheelSuspensionLength(i).toFixed(3)).join('/')}`)
