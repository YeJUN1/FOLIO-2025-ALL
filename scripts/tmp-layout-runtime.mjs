/* 生成"运行时布局"预览：模拟 VisualVehicle.setWheels 把 wheelContainer 克隆 4 份摆到车轮位置 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/vehicle/revuelto.glb')
const root = doc.getRoot()

const chassis = root.listNodes().find(n => n.getName() === 'chassis')
if(!chassis) throw new Error('chassis 未找到')
const src = root.listNodes().find(n => n.getName() === 'wheelContainer')
if(!src) throw new Error('wheelContainer 未找到')

const copyNode = (n) =>
{
    const c = doc.createNode(n.getName())
    c.setMesh(n.getMesh())
    c.setTranslation(n.getTranslation())
    c.setRotation(n.getRotation())
    c.setScale(n.getScale())
    for(const ch of n.listChildren())
        c.addChild(copyNode(ch))
    return c
}

// 物理车轮位置（chassis 局部）: i=0(+x,+z) 1(+x,-z) 2(-x,+z) 3(-x,-z)
const X = 0.8430, Z = 0.5166, Y = -0.7876
const quatY180 = [0, 1, 0, 0]
const positions = [
    { t: [X, Y, Z], q: quatY180 },
    { t: [X, Y, -Z], q: [0, 0, 0, 1] },
    { t: [-X, Y, Z], q: quatY180 },
    { t: [-X, Y, -Z], q: [0, 0, 0, 1] },
]

// 先克隆 4 份
for(let i = 0; i < 4; i++)
{
    const w = copyNode(src)
    w.setName(`wheelContainer_${i}`)
    w.setTranslation(positions[i].t)
    w.setRotation(positions[i].q)
    chassis.addChild(w)
}

// 再移除源模板（对应运行时：源容器不挂入游戏场景）
chassis.removeChild(src)
src.dispose()

await io.write('/tmp/revuelto-runtime.glb', doc)
console.log('写入 /tmp/revuelto-runtime.glb')
