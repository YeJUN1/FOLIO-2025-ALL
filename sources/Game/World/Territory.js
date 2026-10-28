import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

/**
 * 「划地盘」领地围栏（数据驱动）
 * 读取 static/territory/territory.json，把 static/territory/fence.glb（竖立的木板栏杆件，
 * 宽沿局部 X、底面在 y=0）沿红框矩形四周首尾相接摆成一圈，作为"我的地盘"边界。
 *
 * - 每件用 physics 射线贴地（复用 Floor.js 的 heightfield 碰撞体），落不到地面时兜底到水面高度
 * - 碰撞：每件一个 fixed cuboid（`colliders` 开关），车撞得上、开不出去，只能走门
 * - 空气墙：`wall.height` 在每件栏杆正上方再叠一段无视觉的碰撞盒，拦住「一跳就翻进来」
 * - 水下裙边：`wall.depth` 在每件栏杆正下方再叠一段无视觉碰撞盒，扎进海底以下，拦住「从海里贴着海底穿到围栏下面进来」
 * - 门：`gates` 支持多扇门。写 `{ auto: "midpoints", width }` 自动在四条边的中点各开一扇（共 4 扇，改 rect 会自动跟）；也可写 `[{x,z,width},…]` 或旧的单个 `{x,z,width}`。落进任一门圈的件直接不摆（碰撞箱、空气墙、裙边跟着件一起没有）
 * - 出生点：`spawn` 把 glb 里写死的命名 respawn 点（默认 landing）的坐标覆盖成指定 x/z（`applySpawn`，数据驱动、不动二进制模型）
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
        this.defense = null
        this.gates = []
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
        this.defense = description.defense || null
        this.gates = this.buildGates(description.gates ?? description.gate, description.rect)

        // 出生点覆盖：把 glb 里的命名 respawn 点挪到 territory.json 指定的坐标（数据驱动，不动二进制模型）
        this.applySpawn(description.spawn)

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
     * 把 territory.json 的 gates 配置归一成一个门数组。
     * - `{ auto: "midpoints", width }`：自动取四条边中点各开一扇（改 rect 会跟着重算）
     * - `[{x,z,width},…]`：显式多门
     * - 旧的单个 `{x,z,width}`：也兼容，当成一扇
     */
    buildGates(_conf, _rect)
    {
        if(!_conf || !_rect)
            return []

        // 显式列表
        if(Array.isArray(_conf))
            return _conf.map((gate) => ({ x: gate.x, z: gate.z, width: gate.width ?? 6 }))

        const width = _conf.width ?? 6

        // 自动四边中点（可用 override 把某一扇钉到指定坐标，其余仍跟随 rect 中点）
        if(_conf.auto === 'midpoints')
        {
            const cx = (_rect.minX + _rect.maxX) * 0.5
            const cz = (_rect.minZ + _rect.maxZ) * 0.5
            const override = _conf.override || {}

            const gates = [
                { side: 'south', x: cx, z: _rect.minZ, width: width }, // 南
                { side: 'north', x: cx, z: _rect.maxZ, width: width }, // 北
                { side: 'west', x: _rect.minX, z: cz, width: width }, // 西
                { side: 'east', x: _rect.maxX, z: cz, width: width }, // 东
            ]

            return gates.map((gate) =>
            {
                const o = override[gate.side] || {}

                return {
                    x: o.x ?? gate.x,
                    z: o.z ?? gate.z,
                    width: o.width ?? gate.width,
                }
            })
        }

        // 单个点（向后兼容）
        if(typeof _conf.x === 'number' && typeof _conf.z === 'number')
            return [ { x: _conf.x, z: _conf.z, width: width } ]

        return []
    }

    /**
     * 把某个出生点（默认 landing）的坐标覆盖成 territory.json 里 `spawn` 指定的值。
     * glb 里的 respawn 位置是写死的二进制，改它麻烦；这里在运行时直接改 Respawns 缓存的 item，
     * Player 首次出生、地图 pin、导弹 respawnPlayer 读的都是同一个 item，改一处全生效。
     * 只改 x/z（y 由 Respawns 固定为 4，从空中落下）；rotation 可选。
     */
    applySpawn(_spawn)
    {
        if(!_spawn)
            return

        const name = _spawn.name ?? 'landing'
        const item = this.game.respawns?.getByName(name)

        if(!item)
        {
            console.log(`Territory > spawn: 找不到出生点「${name}」，跳过覆盖`)
            return
        }

        if(typeof _spawn.x === 'number')
            item.position.x = _spawn.x

        if(typeof _spawn.z === 'number')
            item.position.z = _spawn.z

        if(typeof _spawn.rotation === 'number')
            item.rotation = _spawn.rotation

        this.spawn = item

        // 开场圆环/标签在 World 构造时就按老出生点定死了（比本方法早），这里同步把它搬过来
        this.game.world?.intro?.recenter(item.position)

        // 揭示圈（着色器环心）+ 点击判定球在 Reveal 构造时（比 World 还早）也锁了老出生点，一并搬
        this.game.reveal?.recenter(item.position)
    }

    /**
     * 这件栏杆是不是落在任意一扇门里。判据用的是「件中心到门中心的圆距离」而不是「在哪条边上」：
     * 门总是开在四条直边之一上，同边的件沿边距离 = 直线距离，这样不用重复存一份 side 信息，
     * 也不会因为把门改到另一条边就默默失效。
     */
    isInGate(_x, _z)
    {
        for(const gate of this.gates)
        {
            const radius = (gate.width ?? 6) * 0.5

            if(Math.hypot(_x - gate.x, _z - gate.z) < radius)
                return true
        }

        return false
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
            this.addCollider(_point, y, _scale, _description)
    }

    /**
     * 给一件栏杆配一个固定碰撞箱（贴着件的包围盒，尺寸、中心、转角都按件来）。
     *
     * 这里直接走 game.physics.getPhysical 而不走 objects.add，两个原因：
     * - objects.add 对 fixed 物体每帧会把 visual 的 position/quaternion 拷到 body 上，
     *   而我们的件是贴地射线摆的，不能被物理再写回去（而且白干 166 次/件）
     * - 静态件不需要任何逐帧同步，也不应该出现在 game.objects.list 里（船的撞物检测会遍历它）
     */
    addCollider(_point, _y, _scale, _description = {})
    {
        const size = this.bounds.getSize(new THREE.Vector3())
        const center = this.bounds.getCenter(new THREE.Vector3())
        const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), _point.rotationY)

        // 栏杆件底面在局部 y=0，所以件顶高度就是这一件缩放后的包围盒高
        const fenceTop = size.y * _scale

        // 空气墙：正上方再叠一段纯碰撞盒（无视觉），拦住「一跳就翻进来」。0 / 缺省 = 不加
        const wallHeight = _description.wall?.height ?? _description.wall ?? 0
        const wallThickness = _description.wall?.thickness ?? 1
        // 水下裙边：正下方再叠一段纯碰撞盒，从件底扎到 depth 米以下。0 / 缺省 = 不加
        // （海面上那几件的底被抬到水线附近，件底到海底之间是空的，不堵就能贴着海底钻进来）
        const wallDepth = _description.wall?.depth ?? 0

        const colliders = [
            {
                shape: 'cuboid',
                parameters: [ size.x * 0.5 * _scale, size.y * 0.5 * _scale, size.z * 0.5 * _scale ],
                position: { x: center.x * _scale, y: center.y * _scale, z: center.z * _scale },
            },
        ]

        if(wallHeight > 0)
        {
            // 和栏杆同样的 X 跨度（沿边方向连成一整堵），Z 向按 thickness 米居中加厚，
            // 免得只有 0.18 米薄薄一片被人从箱棱上擦过去；底边下探 0.5 米压住件顶接缝
            colliders.push({
                shape: 'cuboid',
                parameters: [ size.x * 0.5 * _scale, wallHeight * 0.5, wallThickness * 0.5 ],
                position: { x: center.x * _scale, y: fenceTop + wallHeight * 0.5 - 0.5, z: center.z * _scale },
            })
        }

        if(wallDepth > 0)
        {
            // 与空气墙镜像：顶边上伸 0.5 米压进件底接缝，往下一直扎到 depth 以下；
            // 陆地那段扎进实心地面、海面那段（件底≈-0.25）扎到基岩(-2.0)以下，都是 fixed 撞 fixed，无害
            colliders.push({
                shape: 'cuboid',
                parameters: [ size.x * 0.5 * _scale, wallDepth * 0.5, wallThickness * 0.5 ],
                position: { x: center.x * _scale, y: -wallDepth * 0.5 + 0.5, z: center.z * _scale },
            })
        }

        const physical = this.game.physics.getPhysical({
            type: 'fixed',
            position: { x: _point.x, y: _y, z: _point.z },
            rotation: rotation,
            colliders: colliders,
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
