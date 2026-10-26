import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

/**
 * 「划地盘」领地围栏（数据驱动）
 * 读取 static/territory/territory.json，把 static/territory/fence.glb（竖立的木板栏杆件，
 * 宽沿局部 X、底面在 y=0）沿红框矩形四周首尾相接摆成一圈，作为"我的地盘"边界。
 *
 * - 每件用 physics 射线贴地（复用 Floor.js 的 heightfield 碰撞体），落不到地面时兜底到水面高度
 * - 碰撞：每件一个 fixed cuboid（`colliders` 开关），车撞得上、开不出去，只能走门
 * - 门：`gate` 指定一个世界坐标点 + 宽度，落在那个圈里的件直接不摆（碰撞箱跟着件一起没有）
 * - 改范围/密度/门/碰撞：只改 territory.json，无需动代码；重跑 scripts/territory-prepare.js 换件
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()
        this.items = []
        this.colliders = []
        this.visible = true
        this.rect = null
        this.gate = null
        this.setFromDescription()
    }

    async setFromDescription()
    {
        const cb = '?cb=1'

        let description = null
        try
        {
            const response = await fetch(`territory/territory.json${cb}`)
            if(response.ok)
                description = await response.json()
        }
        catch(error)
        {
            // 尚未配置领地，静默跳过
        }

        if(!description || !description.rect)
            return

        // 对外暴露矩形，供导弹防御系统判定「是否进入地盘」
        this.rect = description.rect
        this.gate = description.gate || null

        // 懒加载栏杆件
        let resource
        try
        {
            const resources = await this.game.resourcesLoader.load([
                [ 'territoryFence', `territory/fence.glb${cb}`, 'gltf' ],
            ])
            resource = resources.territoryFence
        }
        catch(error)
        {
            console.log(`Territory > Couldn't load fence: ${error}`)
            return
        }

        if(!resource)
            return

        // 量出栏杆件的"件长"（局部 X 包围盒宽度），据此决定首尾相接的间距
        const bounds = new THREE.Box3().setFromObject(resource.scene)
        this.bounds = bounds
        const pieceLength = bounds.max.x - bounds.min.x
        const scale = description.scale ?? 1
        const step = pieceLength * scale * (description.overlap ?? 1)

        const points = this.getPerimeterPoints(description.rect, step, description)

        for(const point of points)
            this.addSegment(resource.scene, point, scale, description)

        this.setDebug()
    }

    /**
     * 这件栏杆是不是落在门里。判据用的是「件中心到门中心的圆距离」而不是「在哪条边上」：
     * 门总是开在四条直边之一上，同边的件沿边距离 = 直线距离，这样不用重复存一份 side 信息，
     * 也不会因为把门改到另一条边就默默失效。
     */
    isInGate(_x, _z)
    {
        const gate = this.gate

        if(!gate)
            return false

        const radius = (gate.width ?? 6) * 0.5

        return Math.hypot(_x - gate.x, _z - gate.z) < radius
    }

    getPerimeterPoints(_rect, _step, _description = {})
    {
        const { minX, maxX, minZ, maxZ } = _rect
        const points = []

        const push = (x, z, rotationY) =>
        {
            // 跳过这一件，就自动在墙上留出一段缺口（碰撞箱是逐件建的，跟着一起没）
            if(this.isInGate(x, z))
                return

            points.push({ x: x, z: z, rotationY: rotationY })
        }

        // 上/下两条边：沿世界 X 排布，件宽轴(X)对齐 X → rotationY = 0
        for(let x = minX; x <= maxX + 1e-6; x += _step)
        {
            push(x, minZ, 0)
            push(x, maxZ, 0)
        }

        // 左/右两条边：沿世界 Z 排布，件宽轴需转到 Z → rotationY = 90°
        for(let z = minZ; z <= maxZ + 1e-6; z += _step)
        {
            push(minX, z, Math.PI / 2)
            push(maxX, z, Math.PI / 2)
        }

        return points
    }

    addSegment(_source, _point, _scale, _description)
    {
        const model = _source.clone(true)
        model.scale.setScalar(_scale)
        model.rotation.y = _point.rotationY

        const groundY = this.getGroundElevation(_point.x, _point.z)
        const minY = this.game.water.surfaceElevation + (_description.minAboveWater ?? 0)
        const y = Math.max(groundY, minY) + (_description.yOffset ?? 0)
        model.position.set(_point.x, y, _point.z)

        const object = this.game.objects.addFromModel(model, {}, {})
        this.items.push({ model: model, object: object })

        // 碰撞箱默认开，territory.json 里写 "colliders": false 可以整圈关掉
        if(_description.colliders !== false)
            this.addCollider(_point, y, _scale)
    }

    /**
     * 给一件栏杆配一个固定碰撞箱（贴着件的包围盒，尺寸、中心、转角都按件来）。
     *
     * 这里直接走 game.physics.getPhysical 而不走 objects.add，两个原因：
     * - objects.add 对 fixed 物体每帧会把 visual 的 position/quaternion 拷到 body 上，
     *   而我们的件是贴地射线摆的，不能被物理再写回去（而且白干 166 次/件）
     * - 静态件不需要任何逐帧同步，也不应该出现在 game.objects.list 里（船的撞物检测会遍历它）
     */
    addCollider(_point, _y, _scale)
    {
        const size = this.bounds.getSize(new THREE.Vector3())
        const center = this.bounds.getCenter(new THREE.Vector3())
        const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), _point.rotationY)

        const physical = this.game.physics.getPhysical({
            type: 'fixed',
            position: { x: _point.x, y: _y, z: _point.z },
            rotation: rotation,
            colliders: [
                {
                    shape: 'cuboid',
                    parameters: [ size.x * 0.5 * _scale, size.y * 0.5 * _scale, size.z * 0.5 * _scale ],
                    position: { x: center.x * _scale, y: center.y * _scale, z: center.z * _scale },
                },
            ],
        })

        this.colliders.push(physical)
    }

    /**
     * 射线贴地。必须只取 floor 分类：围栏件自己已经有碰撞箱了，
     * 不过滤的话后摆的件会打在前一件的箱顶上，越摆越高（TerritoryDefense 里同一个坑的写法）。
     */
    getGroundElevation(_x, _z)
    {
        const startY = 50
        const ray = new this.game.RAPIER.Ray({ x: _x, y: startY, z: _z }, { x: 0, y: - 1, z: 0 })
        const floorGroups = this.game.physics.categories.floor
        const hit = this.game.physics.world.castRay(
            ray, 100, true,
            undefined, undefined, undefined, undefined,
            (collider) => collider.collisionGroups() === floorGroups
        )

        return hit ? startY - hit.timeOfImpact : 0
    }

    setVisible(_visible)
    {
        this.visible = _visible
        for(const item of this.items)
            item.model.visible = _visible
    }

    setDebug()
    {
        if(!this.game.debug.active)
            return

        const debugPanel = this.game.debug.panel.addFolder({
            title: '🚧 Territory',
            expanded: false
        })

        debugPanel.addBinding(this, 'visible', { label: 'visible' }).on('change', () =>
        {
            this.setVisible(this.visible)
        })
    }
}
