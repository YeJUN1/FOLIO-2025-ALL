import * as THREE from 'three/webgpu'
import gsap from 'gsap'
import { Game } from '../Game.js'
import { Account } from '../Account.js'

/**
 * 领地防御：闯进「我的地盘」→ 约 3 秒后导弹从正上方垂直落下 → 炸弹效果炸飞 → 送回出生点
 *
 * - 每帧用 territory.json 的 rect 判断车辆是否在地盘内
 * - 进入即开始倒计时，倒计时中离开 → 取消，导弹与警告环消失
 * - 倒计时结束 → 在车辆当前位置引爆，复用爆炸箱的 fireballs（火焰球 + 冲击波，会把车炸飞）
 * - 引爆后延迟片刻把车传送回默认出生点；出生点就在地盘内，于是自动开始下一轮，循环被炸
 * - 账号名里含连续的 william（不分大小写）不攻击：在盘内也一直免疫
 *
 * 参数见 static/territory/territory.json 的 defense 字段
 */
export class TerritoryDefense
{
    constructor()
    {
        this.game = Game.getInstance()

        this.state = 'idle' // idle | countdown | impact
        this.elapsed = 0
        this.enabled = true
        this.settings = null

        this.missileResource = null
        this.missile = null
        this.warning = null

        this.loadMissile()
        this.setSounds()
        this.setDebug()

        this.game.ticker.events.on('tick', () =>
        {
            this.update()
        }, 9)
    }

    async loadMissile()
    {
        try
        {
            const resources = await this.game.resourcesLoader.load([
                [ 'missile', 'territory/missile.glb?cb=1', 'gltf' ],
            ])

            this.missileResource = resources.missile
        }
        catch(error)
        {
            console.log(`TerritoryDefense > Couldn't load missile: ${error}`)
        }
    }

    setSounds()
    {
        this.sounds = {}
        this.sounds.explosions = []

        const paths = [
            'sounds/explosions/SmallImpactMediumE PE281202.mp3',
            'sounds/explosions/SmallImpactMediumE PE281203.mp3'
        ]

        for(const path of paths)
        {
            this.sounds.explosions.push(
                this.game.audio.register({
                    path: path,
                    autoplay: false,
                    loop: false,
                    volume: 0.4,
                    antiSpam: 0.2,
                    positions: new THREE.Vector3(),
                    distanceFade: 25,
                    onPlay: (item, coordinates) =>
                    {
                        item.positions[0].copy(coordinates)
                        item.volume = 1
                        item.rate = 0.9 + Math.random() * 0.3
                    }
                })
            )
        }
    }

    setDebug()
    {
        if(!this.game.debug.active)
            return

        const debugPanel = this.game.debug.panel.addFolder({
            title: '🚀 Territory defense',
            expanded: false
        })

        debugPanel.addBinding(this, 'enabled', { label: 'enabled' })
        debugPanel.addButton({ title: 'drop now' }).on('click', () =>
        {
            if(this.settings && this.state === 'idle')
                this.start()
        })
    }

    setSettings(_defense)
    {
        const defense = _defense || {}

        this.settings = {
            countdown: defense.countdown ?? 3,
            skyHeight: defense.skyHeight ?? 50,
            missileScale: defense.missileScale ?? 4,
            respawnDelay: defense.respawnDelay ?? 1.2,
        }
        this.enabled = defense.enabled ?? true
    }

    isProtected()
    {
        const account = Account.getInstance()
        const username = account ? account.getUsername() : ''

        // 必须是连续的 william（w-i-l-l-i-a-m 这个顺序），不分大小写；
        // 拆开写成 w-i-l-l-i-a-m 不算
        return username.toLowerCase().includes('william')
    }

    update()
    {
        const player = this.game.player
        const territory = this.game.world?.territory

        // 领地配置（territory.json）与玩家都就绪后才开始防御
        if(!player || !territory || !territory.rect)
            return

        if(!this.settings)
            this.setSettings(territory.defense)

        // 账号名含 william → 免疫，永远不攻击
        if(this.isProtected())
        {
            if(this.state !== 'idle')
                this.cancel()

            return
        }

        if(!this.enabled)
        {
            if(this.state !== 'idle')
                this.cancel()

            return
        }

        const rect = territory.rect
        const position = player.position
        const inside =
            position.x >= rect.minX && position.x <= rect.maxX &&
            position.z >= rect.minZ && position.z <= rect.maxZ

        if(this.state === 'idle')
        {
            if(inside)
                this.start()
        }
        else if(this.state === 'countdown')
        {
            // 3 秒内离开地盘：取消打击
            if(!inside)
            {
                this.cancel()
                return
            }

            this.elapsed += this.game.ticker.delta
            this.updateMissile()

            if(this.elapsed >= this.settings.countdown)
                this.impact()
        }
    }

    start()
    {
        if(this.state !== 'idle')
            return

        this.state = 'countdown'
        this.elapsed = 0

        this.createWarning()
        this.createMissile()
        this.updateMissile()
    }

    cancel()
    {
        this.removeMissile()
        this.removeWarning()

        this.state = 'idle'
        this.elapsed = 0
    }

    createMissile()
    {
        if(this.missile || !this.missileResource)
            return

        // GLB 里弹头在局部 -Z；节点自带 +90°X 已把弹头转成朝上，
        // 这里再绕 X 翻 180° 让弹头朝下，并把弹体整体抬到锚点（弹头尖）上方
        const modelHeight = 1.198
        const scale = this.settings.missileScale
        const model = this.missileResource.scene.clone(true)

        model.rotation.x = Math.PI
        model.scale.setScalar(scale)
        model.position.y = modelHeight * scale

        model.traverse((child) =>
        {
            if(child.isMesh)
            {
                child.castShadow = true
                child.receiveShadow = true

                // 原材质名 "Material.001" 太通用，会与场景里其它材质串用
                child.material.name = 'missileMaterial'
            }
        })
        this.game.materials.updateObject(model)

        const wrapper = new THREE.Group()
        wrapper.add(model)
        this.game.scene.add(wrapper)

        this.missile = wrapper
    }

    updateMissile()
    {
        if(!this.missile)
            this.createMissile()

        const player = this.game.player
        const progress = Math.min(this.elapsed / this.settings.countdown, 1)
        const fall = progress * progress // 越接近地面掉得越快

        const x = player.position.x
        const z = player.position.z
        const y = player.position.y + this.settings.skyHeight * (1 - fall)

        // 锚点是弹头尖，直接对准目标点
        if(this.missile)
            this.missile.position.set(x, y, z)

        // 地面警告环：随时间收紧并变淡
        if(this.warning)
        {
            this.warning.position.set(x, this.getGroundElevation(x, z) + 0.06, z)
            this.warning.scale.setScalar(1 - progress * 0.55)
            this.warning.material.opacity = 0.25 + 0.4 * (1 - progress)
        }
    }

    impact()
    {
        const position = this.game.player.position.clone()
        position.y += 0.3

        // 炸弹效果：火焰球 + 冲击波（把车炸飞，命中车辆时还会触发子弹时间）
        this.game.world.fireballs.create(position)

        // 爆炸音效
        this.sounds.explosions[Math.floor(Math.random() * this.sounds.explosions.length)].play(position)

        this.removeMissile()
        this.removeWarning()

        this.state = 'impact'
        this.elapsed = 0

        gsap.delayedCall(this.settings.respawnDelay, () =>
        {
            this.respawnPlayer()
        })
    }

    respawnPlayer()
    {
        if(!this.game.player)
            return

        // 出生点（默认 landing，就在地盘内 → 会被循环炸）
        const respawn = this.game.respawns.getDefault()

        this.game.physicalVehicle.moveTo(respawn.position, respawn.rotation)

        this.game.player.position.copy(respawn.position)
        this.game.player.position2.set(respawn.position.x, respawn.position.z)

        // 镜头瞬时跟到出生点，否则会从地盘横穿整张地图追过去
        const focusPoint = this.game.view.focusPoint
        focusPoint.trackedPosition.copy(respawn.position)
        focusPoint.position.copy(respawn.position)
        focusPoint.smoothedPosition.copy(respawn.position)

        this.state = 'idle'
        this.elapsed = 0
    }

    createWarning()
    {
        if(this.warning)
            return

        const geometry = new THREE.RingGeometry(1.6, 2, 48)
        const material = new THREE.MeshBasicNodeMaterial({
            color: new THREE.Color('#ff3b1f').multiplyScalar(2),
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide
        })

        const mesh = new THREE.Mesh(geometry, material)
        mesh.rotation.x = - Math.PI * 0.5
        this.game.scene.add(mesh)

        this.warning = mesh
    }

    removeMissile()
    {
        if(!this.missile)
            return

        this.missile.removeFromParent()
        this.missile = null
    }

    removeWarning()
    {
        if(!this.warning)
            return

        this.warning.removeFromParent()
        this.warning.geometry.dispose()
        this.warning.material.dispose()
        this.warning = null
    }

    getGroundElevation(_x, _z)
    {
        const startY = 50
        const ray = new this.game.RAPIER.Ray({ x: _x, y: startY, z: _z }, { x: 0, y: - 1, z: 0 })

        // 只取「地面」分类，避免打到车辆、围栏等物件顶面
        const floorGroups = this.game.physics.categories.floor
        const hit = this.game.physics.world.castRay(
            ray, 100, true,
            undefined, undefined, undefined, undefined,
            (collider) => collider.collisionGroups() === floorGroups
        )

        return hit ? startY - hit.timeOfImpact : 0
    }
}
