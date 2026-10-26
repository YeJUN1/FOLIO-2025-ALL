import * as THREE from 'three/webgpu'
import { Game } from './Game.js'

export class Respawns
{
    constructor(defaultName = 'landing')
    {
        this.game = Game.getInstance()
        this.defaultName = defaultName

        this.setItems()
    }

    setItems()
    {
        this.items = new Map()

        for(const child of this.game.resources.respawnsReferencesModel.scene.children)
        {
            child.rotation.reorder('YXZ')

            let name = child.name.replace(/^respawn(.+)$/i, '$1')

            name = name.charAt(0).toLowerCase() + name.slice(1)

            const item = {
                name: name,
                position: new THREE.Vector3(
                    child.position.x,
                    4,
                    child.position.z
                ),
                rotation: child.rotation.y
            }

            this.items.set(name, item)
        }

        // 「划地盘」额外命名出生点：落在各地块的陆地中心（坐标取自 terrain.glb 高度采样，见 docs/划地盘.md）
        // 供 .env 的 VITE_PLAYER_SPAWN 或地图传送使用；y 由物理自由落体到地面，此处给 4 即可
        this.items.set('territoryChenAilin', {
            name: 'territoryChenAilin',
            position: new THREE.Vector3(-51, 4, 21),
            rotation: 0,
        })

        // 丁浩宸 PlotFence 木栅栏地块中心出生点（x∈[-6.5,46.5], z∈[-73.3,-40.3]）
        this.items.set('fence', {
            name: 'fence',
            position: new THREE.Vector3(20, 4, -57),
            rotation: 0,
        })
    }

    getByName(name)
    {
        return this.items.get(name)
    }

    getDefault()
    {
        return this.items.get(this.defaultName)
    }

    getClosest(position)
    {
        let closestItem = null
        let closestDistance = Infinity

        this.items.forEach((item) =>
        {
            const distance = Math.hypot(item.position.x - position.x, item.position.z - position.z)

            if(distance < closestDistance)
            {
                closestDistance = distance
                closestItem = item
            }
        })

        return closestItem
    }
}