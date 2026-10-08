/* 干净静置测试：v 2 [orig|revuelto] [mass] — 车从空中落到平地，静置 10 秒，观察 L 与 chassisY 的稳定值 */
import * as RAPIER from './tmp-rapier3d/rapier.js'

const mode = process.argv[2] ?? 'revuelto'
const mass = process.argv[3] ? parseFloat(process.argv[3]) : 2.5
const isOrig = mode === 'orig'

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
const dt = 1 / 60
world.timestep = dt

const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
world.createCollider(RAPIER.ColliderDesc.cuboid(200, 1, 200), groundBody)

const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0).setLinearDamping(0.1).setAngularDamping(0.1))
let mainBottomMin = Infinity

const radius = isOrig ? 0.4 : 0.2068
const offX = isOrig ? 0.90 : 0.8430
const offZ = isOrig ? 0.75 : 0.5166
const comY = isOrig ? -0.5 : -0.88
const mainH = isOrig ? [1.3, 0.4, 0.85] : [1.32, 0.29, 0.60]
const mainP = isOrig ? [0, -0.1, 0] : [0.05, -0.58, 0]
const topH = isOrig ? [0.5, 0.15, 0.65] : [0.90, 0.14, 0.50]
const topP = isOrig ? [0, 0.4, 0] : [-0.15, -0.40, 0]
const bumpH = isOrig ? [1.5, 0.5, 0.9] : [1.45, 0.33, 0.64]
const bumpP = isOrig ? [0.1, -0.2, 0] : [0.06, -0.6177, 0]

world.createCollider(RAPIER.ColliderDesc.cuboid(...mainH).setTranslation(...mainP)
    .setMassProperties(mass, { x: 0, y: comY, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0, w: 1 })
    .setFriction(0.4).setRestitution(0.15), body)
world.createCollider(RAPIER.ColliderDesc.cuboid(...topH).setTranslation(...topP).setMass(0).setFriction(0.4).setRestitution(0.15), body)
world.createCollider(RAPIER.ColliderDesc.cuboid(...bumpH).setTranslation(...bumpP).setMass(0).setFriction(0.4).setRestitution(0.15), body)

const controller = world.createVehicleController(body)
const wheelPositions = [
    { x: +offX, y: 0, z: +offZ }, { x: +offX, y: 0, z: -offZ },
    { x: -offX, y: 0, z: +offZ }, { x: -offX, y: 0, z: -offZ },
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

for(let f = 0; f < 720; f++)
{
    controller.updateVehicle(dt)
    world.step()
    const yTrack = body.translation().y
    if(!isOrig)
        mainBottomMin = Math.min(mainBottomMin, yTrack - (mainP[1] + mainH[1]))
    if(f % 120 === 0 || f === 719)
    {
        const y = body.translation().y
        const ls = [0,1,2,3].map(i => controller.wheelSuspensionLength(i).toFixed(4)).join('/')
        const contacts = [0,1,2,3].map(i => controller.wheelIsInContact(i) ? 1 : 0).join('')
        console.log(`f=${String(f).padStart(3)} chassisY=${y.toFixed(4)} L=${ls} 接触=${contacts} 轮底=${(y - parseFloat(ls.split('/')[0]) - radius).toFixed(4)}`)
    }
}
if(!isOrig)
    console.log(`main 底世界最低值: ${mainBottomMin.toFixed(4)} (负=触地/穿地)`)

