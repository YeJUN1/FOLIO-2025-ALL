import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'
import { PeterSignature } from './PeterSignature.js'

/**
 * 「划地盘」领地围栏（数据驱动、纯视觉）
 * 读取 static/territory/territory.json，把 static/territory/fence.glb（竖立的木板栏杆件，
 * 宽沿局部 X、底面在 y=0）沿每一块地盘的矩形四周首尾相接摆成一圈。
 *
 * - territories[] 里可以有多块地盘；只写顶层 rect 时仍按旧的单矩形处理
 * - 每件用 physics 射线贴地（复用 Floor.js 的 heightfield 碰撞体），落不到地面时兜底到水面高度
 * - 纯视觉：模型名不含 physical，addFromModel 不创建碰撞体，玩家可穿过
 * - 两条地盘重合的边只铺一次。须翊恒排在数组最前，且不裁剪，周长算法与原来的单矩形一致
 * - clipClearances 的地盘会跳过穿过 clearances 的边段（竹篱院子），避免栏杆插进已有场景
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()
        this.items = []
        this.sign = null
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

        const territories = this.getTerritories(description)
        if(!description || (!territories.length && !description.signature))
            return

        let resource = null
        if(territories.length)
        {
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
            }
        }

        if(resource)
        {
            const bounds = new THREE.Box3().setFromObject(resource.scene)
            const pieceLength = bounds.max.x - bounds.min.x
            const occupied = []
            const clearances = description.clearances || []

            for(const territory of territories)
                this.buildTerritory(resource, territory, description, pieceLength, occupied, clearances)
        }

        if(description.signature)
        {
            try
            {
                this.sign = new PeterSignature(description.signature)
            }
            catch(error)
            {
                console.log(`Territory > Couldn't build signature: ${error}`)
            }
        }

        this.setDebug()
    }

    getTerritories(description)
    {
        if(!description)
            return []

        if(Array.isArray(description.territories) && description.territories.length)
            return description.territories.filter((territory) => territory && territory.rect)

        if(description.rect)
            return [ description ]

        return []
    }

    buildTerritory(resource, territory, defaults, pieceLength, occupied, clearances)
    {
        const scale = territory.scale ?? defaults.scale ?? 1
        const overlap = territory.overlap ?? defaults.overlap ?? 1
        const step = pieceLength * scale * overlap
        const layout = {
            minAboveWater: territory.minAboveWater ?? defaults.minAboveWater,
            yOffset: territory.yOffset ?? defaults.yOffset,
        }
        const rect = territory.rect
        const clips = territory.clipClearances ? clearances : []

        const edges = [
            { axis: 'z', fixed: rect.minZ, min: rect.minX, max: rect.maxX, rotationY: 0 },
            { axis: 'z', fixed: rect.maxZ, min: rect.minX, max: rect.maxX, rotationY: 0 },
            { axis: 'x', fixed: rect.minX, min: rect.minZ, max: rect.maxZ, rotationY: Math.PI / 2 },
            { axis: 'x', fixed: rect.maxX, min: rect.minZ, max: rect.maxZ, rotationY: Math.PI / 2 },
        ]

        for(const edge of edges)
        {
            let parts = [ [ edge.min, edge.max ] ]
            parts = this.subtractClearances(edge, parts, clips)
            parts = this.subtractOccupied(edge, parts, occupied)

            for(const [ start, end ] of parts)
                this.addEdgePoints(resource.scene, edge, start, end, step, scale, layout)

            occupied.push(edge)
        }
    }

    subtractClearances(edge, parts, clearances)
    {
        let next = parts

        for(const clearance of clearances)
        {
            const rect = clearance.rect
            if(!rect)
                continue

            if(edge.axis === 'z')
            {
                if(edge.fixed < rect.minZ || edge.fixed > rect.maxZ)
                    continue

                next = this.subtractIntervals(next, rect.minX, rect.maxX)
            }
            else
            {
                if(edge.fixed < rect.minX || edge.fixed > rect.maxX)
                    continue

                next = this.subtractIntervals(next, rect.minZ, rect.maxZ)
            }
        }

        return next
    }

    subtractOccupied(edge, parts, occupied)
    {
        let next = parts

        for(const other of occupied)
        {
            if(other.axis !== edge.axis)
                continue

            if(Math.abs(other.fixed - edge.fixed) > 0.08)
                continue

            next = this.subtractIntervals(next, other.min, other.max)
        }

        return next
    }

    subtractIntervals(parts, cutMin, cutMax)
    {
        const next = []

        for(const [ start, end ] of parts)
        {
            if(cutMax <= start + 1e-4 || cutMin >= end - 1e-4)
            {
                next.push([ start, end ])
                continue
            }

            if(cutMin > start + 1e-4)
                next.push([ start, Math.min(end, cutMin) ])

            if(cutMax < end - 1e-4)
                next.push([ Math.max(start, cutMax), end ])
        }

        return next.filter(([ start, end ]) => end - start > 0.35)
    }

    addEdgePoints(source, edge, start, end, step, scale, layout)
    {
        for(let cursor = start; cursor <= end + 1e-6; cursor += step)
        {
            const point = edge.axis === 'z'
                ? { x: cursor, z: edge.fixed, rotationY: edge.rotationY }
                : { x: edge.fixed, z: cursor, rotationY: edge.rotationY }

            this.addSegment(source, point, scale, layout)
        }
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

        if(this.sign)
            this.sign.setVisible(_visible)
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
