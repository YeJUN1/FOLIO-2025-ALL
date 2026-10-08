/**
 * 载具物理标定：无头 Rapier 仿真
 * 复刻 PhysicsVehicle 的底盘 + 车轮设置，测量悬挂静止长度等参数，
 * 用于确定替换模型时的落地偏移与碰撞体布局。
 *
 * 用法: node scripts/vehicle-calibrate.mjs [radius] [offsetX] [offsetZ]
 */
import * as RAPIER from './tmp-rapier3d/rapier.js'

const radius = process.argv[2] ? parseFloat(process.argv[2]) : 0.4
const offsetX = process.argv[3] ? parseFloat(process.argv[3]) : 0.90
const offsetZ = process.argv[4] ? parseFloat(process.argv[4]) : 0.75

// Physics.js: new RAPIER.World({ x: 0, y: -9.81, z: 0 })
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
const dt = 1 / 60
world.timestep = dt

// 地面
{
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    world.createCollider(RAPIER.ColliderDesc.cuboid(100, 1, 100), groundBody)
}

// 底盘（PhysicsVehicle.setChassis 的复刻）
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 4, 0).setLinearDamping(0.1).setAngularDamping(0.1))
{
    // Main: mass 2.5, centerOfMass (0, -0.5, 0)
    const main = RAPIER.ColliderDesc.cuboid(1.3, 0.4, 0.85)
        .setTranslation(0, -0.1, 0)
        .setMassProperties(2.5, { x: 0, y: -0.5, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.4)
        .setRestitution(0.15)
    world.createCollider(main, body)

    // Top: mass 0
    const top = RAPIER.ColliderDesc.cuboid(0.5, 0.15, 0.65)
        .setTranslation(0, 0.4, 0)
        .setMass(0)
        .setFriction(0.4)
        .setRestitution(0.15)
    world.createCollider(top, body)

    // Bumper: mass 0
    const bumper = RAPIER.ColliderDesc.cuboid(1.5, 0.5, 0.9)
        .setTranslation(0.1, -0.2, 0)
        .setMass(0)
        .setFriction(0.4)
        .setRestitution(0.15)
    world.createCollider(bumper, body)
}

// 载具控制器（复刻 setWheels）
const controller = world.createVehicleController(body)
const wheelPositions = [
    { x: +offsetX, y: 0, z: +offsetZ },
    { x: +offsetX, y: 0, z: -offsetZ },
    { x: -offsetX, y: 0, z: +offsetZ },
    { x: -offsetX, y: 0, z: -offsetZ },
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
    // 默认 Player.suspensions = ['low','low','low','low']
    controller.setWheelSuspensionRestLength(i, 0.88)
    controller.setWheelSuspensionStiffness(i, 20)
}

// 运行到静止
let previousY = Infinity
let stable = 0
for(let step = 0; step < 1200; step++)
{
    for(let i = 0; i < 4; i++)
    {
        controller.setWheelBrake(i, 0)
        controller.setWheelEngineForce(i, 0)
    }
    controller.updateVehicle(dt)
    world.step()

    const y = body.translation().y
    if(Math.abs(y - previousY) < 1e-6)
        stable++
    else
        stable = 0
    previousY = y
    if(stable > 120)
        break
}

const y = body.translation().y
console.log(`参数: radius=${radius} offsetX=${offsetX} offsetZ=${offsetZ}`)
console.log(`底盘静止高度: ${y.toFixed(4)}`)
for(let i = 0; i < 4; i++)
{
    const l = controller.wheelSuspensionLength(i)
    const contact = controller.wheelIsInContact(i)
    const point = controller.wheelContactPoint(i)
    console.log(`轮 ${i}: 悬挂长度=${l.toFixed(4)} 接触=${contact} 接触点y=${point ? point.y.toFixed(4) : '-'}`)
}
console.log(`=> 视觉车轮中心(未截断): ${(-controller.wheelSuspensionLength(0)).toFixed(4)}`)
console.log(`=> 物理接触面: 底盘y - 悬挂长度 - radius = ${(y - controller.wheelSuspensionLength(0) - radius).toFixed(4)}`)
