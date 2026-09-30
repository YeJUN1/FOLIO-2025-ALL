import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

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
        this.items = []
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
        model.scale.copy(typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(...scale))
        model.quaternion.copy(quaternion)
        model.position.copy(this.getWorldPosition(_description))

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

        this.items.push({
            description: _description,
            model: model,
            object: object
        })
    }

    getWorldPosition(_description)
    {
        const position = _description.position || [ 0, 0, 0 ]
        const x = this.origin.x + position[0]
        const z = this.origin.z + position[2]
        const y = this.getGroundElevation(x, z) + position[1] + this.origin.y

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
