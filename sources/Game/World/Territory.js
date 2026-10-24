import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

/**
 * 「划地盘」领地围栏（数据驱动、纯视觉）
 * 读取 static/territory/territory.json，把 static/territory/fence.glb（竖立的木板栏杆件，
 * 宽沿局部 X、底面在 y=0）沿每块领地矩形四周首尾相接摆成一圈，并在游戏地图（M 键）
 * 上为每块领地加上主人名字标注（所有人共享同一份 static 数据，天然同步）。
 *
 * - 每件用 physics 射线贴地（复用 Floor.js 的 heightfield 碰撞体），落不到地面时兜底到水面高度
 * - 纯视觉：模型名不含 physical，addFromModel 不创建碰撞体，玩家可穿过（性能与实现最简）
 * - 改围栏范围/密度/领地列表：只改 territory.json，无需动代码；重跑 scripts/territory-prepare.js 换件
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()
        this.items = []
        this.visible = true

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

        // 领地列表：territories 数组优先，兼容旧版单 rect（视作无名领地，只围不标）
        const territories = description.territories ?? [{ rect: description.rect, fence: true, label: false }]

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
        const pieceLength = bounds.max.x - bounds.min.x
        const scale = description.scale ?? 1
        const step = pieceLength * scale * (description.overlap ?? 1)

        for(const territory of territories)
        {
            if(territory.fence ?? true)
            {
                const points = this.getPerimeterPoints(territory.rect, step)

                for(const point of points)
                    this.addSegment(resource.scene, point, scale, description)
            }

            if((territory.label ?? true) && territory.name && this.game.map)
                this.game.map.addTerritoryLabel(territory)
        }

        this.setDebug()
    }

    getPerimeterPoints(_rect, _step)
    {
        const { minX, maxX, minZ, maxZ } = _rect
        const points = []

        // 上/下两条边：沿世界 X 排布，件宽轴(X)对齐 X → rotationY = 0
        for(let x = minX; x <= maxX + 1e-6; x += _step)
        {
            points.push({ x: x, z: minZ, rotationY: 0 })
            points.push({ x: x, z: maxZ, rotationY: 0 })
        }

        // 左/右两条边：沿世界 Z 排布，件宽轴需转到 Z → rotationY = 90°
        for(let z = minZ; z <= maxZ + 1e-6; z += _step)
        {
            points.push({ x: minX, z: z, rotationY: Math.PI / 2 })
            points.push({ x: maxX, z: z, rotationY: Math.PI / 2 })
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
    }

    getGroundElevation(_x, _z)
    {
        const startY = 50
        const ray = new this.game.RAPIER.Ray({ x: _x, y: startY, z: _z }, { x: 0, y: - 1, z: 0 })
        const hit = this.game.physics.world.castRay(ray, 100, true)

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
