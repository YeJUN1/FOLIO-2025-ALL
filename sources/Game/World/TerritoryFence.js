import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

/**
 * 领地围栏：沿 Territory.bounds 的矩形四边逐段首尾拼接石栏板，把整块领地围起来
 *
 * 资产 static/garden/stoneFence.glb（manifest key = stoneFence）经 process.js 归一化后为
 * 2 × 0.773 × 0.216 m，长度轴为局部 X、底面中心为原点，故按各边方向绕 Y 旋转后逐段摆放。
 *
 * 若某段查不到地面（地图边缘）或地面低于水面（海里），栏板改坐在 y = 0（水面之上），
 * 使整圈围栏首尾连续、且不会沉到水下。
 */
export class TerritoryFence
{
    constructor()
    {
        this.game = Game.getInstance()

        // 单段栏板长度，需与 manifest stoneFence 的 normalize.target 保持一致
        this.segmentLength = 2

        this.setFromBounds()
    }

    async setFromBounds()
    {
        const bounds = this.game.territory.bounds
        if(!bounds)
            return

        const compressed = !!import.meta.env.VITE_COMPRESSED
        const compressedSuffix = compressed ? '-compressed' : ''

        let resource = null
        try
        {
            const resources = await this.game.resourcesLoader.load([
                [ 'stoneFence', `garden/stoneFence${compressedSuffix}.glb?cb=1`, 'gltf' ]
            ])
            resource = resources.stoneFence
        }
        catch(error)
        {
            console.log(`TerritoryFence > Couldn't load stoneFence: ${error}`)
            return
        }

        if(!resource)
            return

        // 矩形四角，按顺时针首尾相连（北 → 东 → 南 → 西）
        const corners = [
            { x: bounds.minX, z: bounds.minZ },
            { x: bounds.maxX, z: bounds.minZ },
            { x: bounds.maxX, z: bounds.maxZ },
            { x: bounds.minX, z: bounds.maxZ },
        ]

        for(let i = 0; i < corners.length; i++)
            this.addEdge(corners[i], corners[(i + 1) % corners.length], resource)
    }

    addEdge(_start, _end, _resource)
    {
        const directionX = _end.x - _start.x
        const directionZ = _end.z - _start.z
        const lineLength = Math.hypot(directionX, directionZ)

        // 按单段长度等分数，步长用实际等分长度（与 2m 的差可忽略），保证首尾相接
        const count = Math.max(1, Math.round(lineLength / this.segmentLength))
        const stepX = directionX / count
        const stepZ = directionZ / count

        // 绕 Y 旋转使栏板局部 +X（长度轴）对齐该边方向
        const rotation = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, Math.atan2(- directionZ, directionX), 0)
        )

        for(let i = 0; i < count; i++)
        {
            const x = _start.x + stepX * (i + 0.5)
            const z = _start.z + stepZ * (i + 0.5)
            let y = this.getGroundElevation(x, z)

            // 没有地面（地图边缘）或地面低于水面（在海里）：栏板改坐在 y = 0，
            // 与岸边陆地上的段落（y ≈ 0）平齐，整圈连续且不会沉到水下
            if(y === null || y < this.game.water.surfaceElevation)
                y = 0

            const model = _resource.scene.clone(true)
            model.quaternion.copy(rotation)
            model.position.set(x, y, z)

            // 模型名含 physical fixed，Objects 据此建 fixed 刚体
            const descriptions = this.game.objects.getFromModel(
                model,
                {},
                {
                    position: { x: x, y: y, z: z },
                    rotation: rotation,
                    sleeping: true
                }
            )

            // 用更高、更厚、且下探到地面以下的碰撞体，替换 GLB 自带的薄 cuboid：
            //  · 高到 y = 1.5m —— 车辆高速冲撞也翻不过去
            //  · 下探到 y = -0.5m —— 车头无法从栏板下方钻过
            //  · 厚 0.3m —— 降低高速穿透，且相邻两段在转角处互相咬合不留缝
            // 视觉上仍是一块 0.773m 高的石栏板
            descriptions[1].colliders = [
                {
                    shape: 'cuboid',
                    parameters: [ 1, 1, 0.15 ],
                    position: { x: 0, y: 0.5, z: 0 }
                }
            ]

            this.game.objects.add(...descriptions)
        }
    }

    getGroundElevation(_x, _z)
    {
        const startY = 50

        // 采样点正好落在地形边界（±96）时，竖直射线会擦不到 heightfield 而查不到地面。
        // 故把采样点向内收 0.5m（只影响取高度，栏板仍摆在原坐标 _x/_z）。
        const halfSize = this.game.terrain.size * 0.5
        const inset = 0.5
        const sampleX = Math.min(Math.max(_x, - halfSize + inset), halfSize - inset)
        const sampleZ = Math.min(Math.max(_z, - halfSize + inset), halfSize - inset)

        const ray = new this.game.RAPIER.Ray({ x: sampleX, y: startY, z: sampleZ }, { x: 0, y: - 1, z: 0 })

        // 只接受「地面」分类的碰撞体（heightfield 大地 + 地基），否则射线会打到边界线上
        // 的其它固定物件（场景装饰等）或已摆好的栏板顶面，导致栏板被架在半空
        const floorGroups = this.game.physics.categories.floor
        const hit = this.game.physics.world.castRay(
            ray, 100, true,
            undefined, undefined, undefined, undefined,
            (collider) => collider.collisionGroups() === floorGroups
        )

        return hit ? startY - hit.timeOfImpact : null
    }
}
