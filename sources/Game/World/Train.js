import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'
import { TrackPath } from './TrackPath.js'

export class Train
{
    constructor()
    {
        this.game = Game.getInstance()

        this.state = 'idle' // idle | running | paused | boarded
        this.speed = 12 // m/s 巡航速度
        this.speedTarget = 12
        this.acceleration = 2.5
        this.direction = 1 // 1 正向，-1 反向

        // 曲线上的位置（0~1）
        this.t = 0

        this.trackPath = new TrackPath()

        this.setVisual()
        this.setSound()

        // Tick 更新
        this.game.ticker.events.on('tick', () =>
        {
            this.update()
        }, 8)

        // 初始位姿
        this.applyPose()

        if(this.game.debug.active)
        {
            const panel = this.game.debug.panel.addFolder({ title: '🚆 Train', expanded: true })
            panel.addBinding(this, 'speedTarget', { min: 0, max: 30, step: 0.5 })
            panel.addBinding(this, 't', { min: 0, max: 1, step: 0.001 }).on('change', () => this.applyPose())
            panel.addButton({ title: 'toggleRun' }).on('click', () => this.toggleRun())
        }
    }

    setVisual()
    {
        this.group = new THREE.Group()
        this.group.name = 'Train'
        this.game.scene.add(this.group)

        // === 车头 ===
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcc3333, metalness: 0.4, roughness: 0.5 })
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.3 })
        const windowMat = new THREE.MeshStandardMaterial({ color: 0x334455, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.8 })
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.5, roughness: 0.4 })

        // 车头主体（x 轴为前后方向，沿曲线 tangent 前进）
        const bodyGeo = new THREE.BoxGeometry(6, 2, 2.8)
        const body = new THREE.Mesh(bodyGeo, bodyMat)
        body.position.y = 1.5
        body.castShadow = true
        body.receiveShadow = true
        this.group.add(body)

        // 车头驾驶舱（在前方 +x 端顶部）
        const cabGeo = new THREE.BoxGeometry(2, 1.3, 2.4)
        const cab = new THREE.Mesh(cabGeo, darkMat)
        cab.position.set(1.8, 2.9, 0)
        cab.castShadow = true
        this.group.add(cab)

        // 前挡风玻璃
        const windshieldGeo = new THREE.PlaneGeometry(1.8, 1.1)
        const windshield = new THREE.Mesh(windshieldGeo, windowMat)
        windshield.position.set(2.81, 2.9, 0)
        windshield.rotation.y = Math.PI * 0.5
        this.group.add(windshield)

        // 侧面窗户（2 个）
        const sideWinGeo = new THREE.PlaneGeometry(1.6, 0.7)
        const winL = new THREE.Mesh(sideWinGeo, windowMat)
        winL.position.set(1.8, 2.9, 1.21)
        winL.rotation.y = Math.PI
        this.group.add(winL)
        const winR = new THREE.Mesh(sideWinGeo, windowMat)
        winR.position.set(1.8, 2.9, -1.21)
        this.group.add(winR)

        // 烟囱
        const chimneyGeo = new THREE.CylinderGeometry(0.25, 0.3, 0.6, 12)
        const chimney = new THREE.Mesh(chimneyGeo, darkMat)
        chimney.position.set(-0.5, 2.9, 0)
        chimney.castShadow = true
        this.group.add(chimney)

        // === 乘客车厢（先 2 节原型）===
        const carriageMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.2, roughness: 0.5 })
        const carriageMat2 = new THREE.MeshStandardMaterial({ color: 0x5588bb, metalness: 0.2, roughness: 0.5 })

        const carriageLength = 5
        const carriageGap = 0.3
        const carriage1 = this.buildCarriage(carriageLength, bodyMat, windowMat, wheelMat)
        carriage1.position.x = -(carriageLength * 0.5 + carriageGap + 3)
        this.group.add(carriage1)

        const carriage2 = this.buildCarriage(carriageLength, carriageMat2, windowMat, wheelMat)
        carriage2.position.x = -(carriageLength * 1.5 + carriageGap * 2 + 3)
        this.group.add(carriage2)

        // === 轮子（车头 4 个，每节车厢 4 个）===
        // 我们用 InstancedMesh 一次性把所有轮子做出来 —— 简化：先车头 4 个
        this.setWheels()

        // === 座舱 Camera 挂点 ===
        this.cockpit = new THREE.Group()
        this.cockpit.position.set(1.5, 2.8, 0) // 驾驶舱内部
        this.group.add(this.cockpit)

        // 乘客座舱（挂在车厢 1 里）
        this.passengerCockpit = new THREE.Group()
        this.passengerCockpit.position.set(carriage1.position.x, 2.5, 0)
        this.group.add(this.passengerCockpit)

        this.setVisual = undefined // 只跑一次
    }

    buildCarriage(length, mat, windowMat, wheelMat)
    {
        const group = new THREE.Group()

        const bodyGeo = new THREE.BoxGeometry(length, 2.2, 2.8)
        const body = new THREE.Mesh(bodyGeo, mat)
        body.position.y = 1.5
        body.castShadow = true
        body.receiveShadow = true
        group.add(body)

        // 连续窗户
        const winCount = Math.floor(length / 1.2)
        for(let i = 0; i < winCount; i++)
        {
            const x = -length * 0.5 + 0.6 + i * 1.2
            const winGeo = new THREE.PlaneGeometry(0.8, 0.7)
            const winL = new THREE.Mesh(winGeo, windowMat)
            winL.position.set(x, 1.8, 1.41)
            winL.rotation.y = Math.PI
            group.add(winL)
            const winR = new THREE.Mesh(winGeo, windowMat)
            winR.position.set(x, 1.8, -1.41)
            group.add(winR)
        }

        return group
    }

    setWheels()
    {
        const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.3, 16)
        wheelGeo.rotateZ(Math.PI * 0.5) // 让 cylinder 的轴沿 x 方向（横向）
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.5, roughness: 0.4 })

        // 先只车头 4 个轮子，简化
        const wheelPositions = [
            { x: -2.0, z: 1.5 },
            { x: -2.0, z: -1.5 },
            { x: 2.0, z: 1.5 },
            { x: 2.0, z: -1.5 },
        ]

        for(const wp of wheelPositions)
        {
            const wheel = new THREE.Mesh(wheelGeo, wheelMat)
            wheel.position.set(wp.x, 0.45, wp.z)
            wheel.castShadow = true
            this.group.add(wheel)
        }
    }

    setSound()
    {
        // 预留：车轮滚动声等
    }

    toggleRun()
    {
        if(this.state === 'running')
            this.state = 'paused'
        else if(this.state === 'idle' || this.state === 'paused')
            this.state = 'running'
    }

    /**
     * 推进（或刹车）时调用
     */
    setRunning(running)
    {
        if(running)
            this.state = 'running'
        else if(this.state === 'running')
            this.state = 'paused'
    }

    update()
    {
        // 平滑加减速
        if(this.state === 'running')
        {
            this.speed += (this.speedTarget - this.speed) * Math.min(1, this.acceleration * this.game.ticker.deltaScaled)
        }
        else
        {
            // 刹车减速
            this.speed += (0 - this.speed) * Math.min(1, this.acceleration * 2 * this.game.ticker.deltaScaled)
            if(this.speed < 0.05) this.speed = 0
        }

        if(this.speed > 0.01)
        {
            // 沿轨道推进
            const distance = this.speed * this.game.ticker.deltaScaled * this.direction
            this.t = this.trackPath.advance(this.t, distance)
            this.applyPose()
        }
    }

    applyPose()
    {
        const { position, tangent } = this.trackPath.getPoseAt(this.t)

        // y 轴贴地（暂时假设地面 y ≈ 0，加个小偏移）
        position.y += 0.05

        this.group.position.copy(position)

        // 让火车 +x 轴对准 tangent（前进方向）
        // 先算一个临时"前方"向量 = tangent
        const tangent3 = tangent.clone() // 已经是世界空间方向
        tangent3.y = 0
        tangent3.normalize()

        // 火车 local +x 默认是前进方向，要把它转到 tangent 的世界方向
        // tangent = (tx, 0, tz)，需要让 local +x 指过去
        const angleY = Math.atan2(tangent3.x, tangent3.z)
        this.group.rotation.set(0, angleY - Math.PI * 0.5, 0)
    }

    /**
     * 把 camera 挂到火车座舱
     * @param {THREE.Object3D} camera 摄像机
     */
    attachCamera(camera)
    {
        // 记住原来的 parent 和位置
        this._savedCamParent = camera.parent
        this._savedCamPos = camera.position.clone()
        this._savedCamQuat = camera.quaternion.clone()

        // 挂到座舱
        this.passengerCockpit.add(camera)
        camera.position.set(0, 0.5, 3) // 在车厢里稍微偏后、偏高
        camera.rotation.set(0, 0, 0) // 坐面朝前方（车厢 +x 是前方，我们想让 camera 朝 +x）
        camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 0.5) // 让 camera lookAt +x 方向

        // View 系统中 camera.parent 变了，需要让 spherical 不覆盖位置
        if(this.game.view)
        {
            this.game.view.lockCamera = true
        }
    }

    /**
     * 把 camera 恢复到原来的 parent
     * @param {THREE.Object3D} camera
     */
    detachCamera(camera)
    {
        if(this._savedCamParent)
        {
            this._savedCamParent.add(camera)
            camera.position.copy(this._savedCamPos)
            camera.quaternion.copy(this._savedCamQuat)
        }
        this._savedCamParent = null
        this._savedCamPos = null
        this._savedCamQuat = null

        if(this.game.view)
        {
            this.game.view.lockCamera = false
        }
    }
}
