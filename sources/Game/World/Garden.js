import * as THREE from 'three/webgpu'
import { color, float, Fn, mix, positionLocal, sin, time, vec3 } from 'three/tsl'
import { Game } from '../Game.js'
import { MeshDefaultMaterial } from '../Materials/MeshDefaultMaterial.js'

/**
 * 苏州园林模块（数据驱动拼装）
 * 读取 static/garden/scene.json，按需懒加载 static/garden/ 下的 GLB 并自动物理落地。
 * 新增模块：manifest.json 生成资产 + scene.json 写一条摆放，无需修改任何代码。
 */
export class Garden
{
    constructor()
    {
        this.game = Game.getInstance()
        this.origin = new THREE.Vector3()
        this.scale = 1
        this.items = []
        this.ponds = []
        this.debugVisible = true

        this.setFromSceneDescription()
    }

    async setFromSceneDescription()
    {
        const cb = '?cb=1'

        // 场景描述
        let sceneDescription = null
        try
        {
            const response = await fetch(`garden/scene.json${cb}`)
            if(response.ok)
                sceneDescription = await response.json()
        }
        catch(error)
        {
            // 尚未配置花园，静默跳过
        }

        if(!sceneDescription || !sceneDescription.objects || !sceneDescription.objects.length)
            return

        const origin = sceneDescription.origin || [ 0, 0, 0 ]
        this.origin.set(origin[0], origin[1], origin[2])

        // 整体缩放（等比放大/缩小整个花园：视觉、碰撞体、相对布局一并缩放，资产本身保持真实尺寸）
        this.scale = sceneDescription.scale ?? 1

        // 按需加载所需资产（复用全局资源加载器与缓存）
        const compressed = !!import.meta.env.VITE_COMPRESSED
        const compressedSuffix = compressed ? '-compressed' : ''
        const keys = [ ...new Set(sceneDescription.objects.map(object => object.asset)) ]
        const files = keys.map(key => [ key, `garden/${key}${compressedSuffix}.glb${cb}`, 'gltf' ])

        let resources
        try
        {
            resources = await this.game.resourcesLoader.load(files)
        }
        catch(error)
        {
            console.log(`Garden > Couldn't load assets: ${error}`)
            return
        }

        // 摆放
        for(const objectDescription of sceneDescription.objects)
            this.addItem(objectDescription, resources[objectDescription.asset])

        // 池塘水面（纯视觉：多边形水面 + 池底，不创建物理体，玩家可涉水而过）
        if(sceneDescription.ponds)
        {
            for(const pondDescription of sceneDescription.ponds)
                this.addPond(pondDescription)
        }

        this.setDebug()
    }

    addItem(_description, _resource)
    {
        if(!_resource)
            return

        const model = _resource.scene.clone(true)

        const rotation = _description.rotation || [ 0, 0, 0 ]
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            rotation[0] * Math.PI / 180,
            rotation[1] * Math.PI / 180,
            rotation[2] * Math.PI / 180
        ))

        const scale = _description.scale ?? 1
        const scaleVector = (typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale)).multiplyScalar(this.scale)
        model.scale.copy(scaleVector)
        model.quaternion.copy(quaternion)
        model.position.copy(this.getWorldPosition(_description))

        // 碰撞体随整体缩放：Objects.getFromModel 只读取碰撞体子节点的局部 scale/position（不含 model.scale），
        // 故把缩放烘焙进 cuboid/tube/ball 等「尺寸驱动」的碰撞体节点，保证物理体与视觉一致。
        // （trimesh/hull 为顶点驱动，暂不支持运行时缩放；当前花园资产仅用 cuboid）
        if(scaleVector.x !== 1 || scaleVector.y !== 1 || scaleVector.z !== 1)
        {
            for(const child of model.children)
            {
                if(/^cuboid/i.test(child.name) || /^tube/i.test(child.name) || /^ball/i.test(child.name))
                {
                    child.scale.multiply(scaleVector)
                    child.position.multiply(scaleVector)
                }
            }
        }

        // 物理体（GLB 根节点含 physical 命名时自动创建 fixed 刚体，碰撞体来自 cuboid 子节点）
        const object = this.game.objects.addFromModel(
            model,
            {},
            {
                position: { x: model.position.x, y: model.position.y, z: model.position.z },
                rotation: quaternion,
                sleeping: true
            }
        )

        // 刷新查询管线：Rapier 仅在 world.step() 时重建查询结构，同一帧内新建的碰撞体
        // 对 castRay 不可见。不刷新会导致后续资产的贴地射线穿透刚建好的物理体
        // （如后摆放的物件沉入底座，而非站上台面）。update 只重建空间索引，不推进模拟。
        if(object.physical)
            this.game.physics.world.queryPipeline.update(this.game.physics.world.colliders)

        this.items.push({
            description: _description,
            model: model,
            object: object
        })
    }

    addPond(_description)
    {
        const polygon = _description.polygon || []
        if(polygon.length < 3)
            return

        const s = this.scale
        const waterLevel = _description.waterLevel ?? 0.02
        const bedLevel = _description.bedLevel ?? 0.001
        const colors = _description.colors ?? {}
        const opacity = _description.opacity ?? 0.85

        // 以多边形几何中心做一次贴地射线，水面整体对齐台面顶高
        let centerX = 0
        let centerZ = 0
        for(const point of polygon)
        {
            centerX += point[0]
            centerZ += point[1]
        }
        centerX = this.origin.x + (centerX / polygon.length) * s
        centerZ = this.origin.z + (centerZ / polygon.length) * s
        const groundY = this.getGroundElevation(centerX, centerZ) + this.origin.y

        // Shape 平面为 XY，rotateX(-90°) 后落到 XZ 平面：
        // 顶点 (px, pz) 写成 (px, -pz)，旋转后几何顶点即为 (px, 0, pz)
        const shape = new THREE.Shape()
        for(let i = 0; i < polygon.length; i++)
        {
            const x = polygon[i][0]
            const y = - polygon[i][1]

            if(i === 0)
                shape.moveTo(x, y)
            else
                shape.lineTo(x, y)
        }
        shape.closePath()

        const geometry = new THREE.ShapeGeometry(shape)
        geometry.rotateX(- Math.PI / 2)

        // 池底：深色平面衬出水深
        const bedMaterial = new MeshDefaultMaterial({
            colorNode: color(colors.bed ?? '#13282a'),
            hasWater: false,
            hasLightBounce: false,
            hasCoreShadows: false,
            hasDropShadows: false
        })

        const bed = new THREE.Mesh(geometry, bedMaterial)
        bed.scale.set(s, 1, s)
        bed.position.set(this.origin.x, groundY + bedLevel * s, this.origin.z)
        bed.receiveShadow = true
        this.game.scene.add(bed)

        // 水面：深浅色渐变 + 时间驱动波纹
        const shallowColor = color(colors.shallow ?? '#5a9490')
        const deepColor = color(colors.deep ?? '#1e4547')

        const colorNode = Fn(() =>
        {
            const waveA = sin(positionLocal.x.mul(7.5).add(time.mul(1.2)))
            const waveB = sin(positionLocal.z.mul(6.2).sub(time.mul(0.9)))
            const waveC = sin(positionLocal.x.mul(12).add(positionLocal.z.mul(10.5)).add(time.mul(1.6)))
            const ripple = waveA.mul(waveB).add(waveC.mul(0.5)).mul(0.5).add(0.5).clamp(0, 1)

            return mix(deepColor, shallowColor, ripple.mul(0.6).add(0.05))
        })()

        const normalNode = vec3(
            sin(positionLocal.x.mul(9).add(time.mul(1.1))).mul(0.06),
            1,
            sin(positionLocal.z.mul(8).sub(time.mul(0.8))).mul(0.06)
        ).normalize()

        const waterMaterial = new MeshDefaultMaterial({
            colorNode: colorNode,
            normalNode: normalNode,
            alphaNode: float(opacity),
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            hasWater: false,
            hasLightBounce: false
        })

        const water = new THREE.Mesh(geometry, waterMaterial)
        water.scale.set(s, 1, s)
        water.position.set(this.origin.x, groundY + waterLevel * s, this.origin.z)
        water.receiveShadow = true
        water.renderOrder = 1
        this.game.scene.add(water)

        this.ponds.push({ description: _description, water: water, bed: bed })
    }

    getWorldPosition(_description)
    {
        const position = _description.position || [ 0, 0, 0 ]
        const x = this.origin.x + position[0] * this.scale
        const z = this.origin.z + position[2] * this.scale
        const y = this.getGroundElevation(x, z) + position[1] * this.scale + this.origin.y

        return new THREE.Vector3(x, y, z)
    }

    getGroundElevation(_x, _z)
    {
        const startY = this.origin.y + 50
        const ray = new this.game.RAPIER.Ray({ x: _x, y: startY, z: _z }, { x: 0, y: - 1, z: 0 })
        const hit = this.game.physics.world.castRay(ray, 100, true)

        return hit ? startY - hit.timeOfImpact : 0
    }

    reposition()
    {
        for(const item of this.items)
        {
            const position = this.getWorldPosition(item.description)
            item.model.position.copy(position)

            if(item.object && item.object.physical)
            {
                item.object.physical.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true)

                if(item.object.visual)
                    item.object.visual.object3D.position.copy(position)
            }
        }
    }

    setDebug()
    {
        if(!this.game.debug.active)
            return

        const debugPanel = this.game.debug.panel.addFolder({
            title: '🌿 Garden',
            expanded: false
        })

        debugPanel.addBinding(this, 'debugVisible', { label: 'visible' }).on('change', () =>
        {
            for(const item of this.items)
                item.model.visible = this.debugVisible

            for(const pond of this.ponds)
            {
                pond.water.visible = this.debugVisible
                pond.bed.visible = this.debugVisible
            }
        })

        const originProxy = { x: this.origin.x, z: this.origin.z }
        const onOriginChange = () =>
        {
            this.origin.x = originProxy.x
            this.origin.z = originProxy.z
            this.reposition()
        }
        debugPanel.addBinding(originProxy, 'x', { min: - 96, max: 96, step: 0.5 }).on('change', onOriginChange)
        debugPanel.addBinding(originProxy, 'z', { min: - 96, max: 96, step: 0.5 }).on('change', onOriginChange)
    }
}
