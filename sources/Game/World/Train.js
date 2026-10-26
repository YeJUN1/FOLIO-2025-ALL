import * as THREE from 'three/webgpu'
import { clamp } from '../utilities/maths.js'
import { Game } from '../Game.js'
import { TrackPath } from './TrackPath.js'

export class Train
{
    constructor()
    {
        this.game = Game.getInstance()

        this.state = 'idle'           // idle | running | paused | boarding
        this.speed = 0
        this.cruiseSpeed = 14          // m/s 巡航速度
        this.stopSpeed = 0.5           // 站台附近自动减速的低速
        this.acceleration = 1.8
        this.direction = 1
        this.t = 0

        // 站台在 t=0 附近，±0.005 范围内自动减速停靠
        this.stationT = 0
        this.stationHalfRange = 0.008
        this.stopDuration = 4          // 停靠秒数
        this.stopTimer = 0

        // === 乘客视角偏移（鼠标可左右/上下看风景）===
        this.viewYaw = 0               // 水平旋转（弧度）
        this.viewPitch = 0             // 垂直旋转（弧度，正=抬头）
        this.viewSensitivity = 0.0025
        this.viewPitchClamp = 0.8      // ±0.8 rad ≈ ±46° 上下范围
        this.viewDecay = 0.3           // 每帧自动归零的比例（松手后视角慢慢回到正前方）

        this.trackPath = new TrackPath()
        this.setVisual()

        this.game.ticker.events.on('tick', () => { this.update() }, 8)
        this.applyPose()

        if(this.game.debug.active)
        {
            const panel = this.game.debug.panel.addFolder({ title: '🚆 Train', expanded: true })
            panel.addBinding(this, 'cruiseSpeed', { min: 2, max: 25, step: 0.5 })
            panel.addBinding(this, 't', { min: 0, max: 1, step: 0.0005 }).on('change', () => this.applyPose())
            panel.addButton({ title: 'toggleRun' }).on('click', () => this.toggleRun())
        }
    }

    toggleRun()
    {
        if(this.state === 'running') this.state = 'paused'
        else if(this.state === 'idle' || this.state === 'paused') this.state = 'running'
    }

    setRunning(running)
    {
        if(running) this.state = 'running'
        else if(this.state === 'running') this.state = 'paused'
    }

    /**
     * 玩家请求上车 —— 把火车派到站台等
     */
    requestPickup()
    {
        // 直接把火车定位到站台（t=0），停稳
        this.t = this.stationT
        this.applyPose()
        this.state = 'paused'
        this.speed = 0
        this.stopTimer = 0
    }

    /**
     * 上车成功后启动
     */
    startMoving()
    {
        this.state = 'running'
    }

    setVisual()
    {
        this.group = new THREE.Group()
        this.group.name = 'Train'
        this.game.scene.add(this.group)

        // 材质
        const redMat      = new THREE.MeshStandardMaterial({ color: 0xc8102e, metalness: 0.5, roughness: 0.4 })
        const redDarkMat  = new THREE.MeshStandardMaterial({ color: 0x8a0a20, metalness: 0.6, roughness: 0.35 })
        const creamMat    = new THREE.MeshStandardMaterial({ color: 0xf5f0d8, metalness: 0.15, roughness: 0.5 })
        const grayMat     = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, metalness: 0.6, roughness: 0.3 })
        const blackMat    = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.7, roughness: 0.3 })
        const wheelMat    = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, metalness: 0.5, roughness: 0.4 })
        const windowMat   = new THREE.MeshStandardMaterial({ color: 0x1a2535, metalness: 0.4, roughness: 0.15, transparent: true, opacity: 0.85 })
        const glassMat    = new THREE.MeshStandardMaterial({ color: 0x88bbff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.3 })
        const chromeMat   = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.1 })
        const brassMat    = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.85, roughness: 0.25 })
        const coalMat     = new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.2, roughness: 0.9 })

        // === 车头（蒸汽机车风格，x+ 为前方）===
        const loco = new THREE.Group()

        // 锅炉主体（圆柱 + 半球头）
        const boilerCyl = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4.2, 20), redMat)
        boilerCyl.rotation.z = Math.PI * 0.5
        boilerCyl.position.set(0.5, 1.6, 0)
        boilerCyl.castShadow = true; boilerCyl.receiveShadow = true
        loco.add(boilerCyl)

        const boilerCap = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12, 0, Math.PI), redMat)
        boilerCap.rotation.z = Math.PI * 0.5
        boilerCap.position.set(2.6, 1.6, 0)
        boilerCap.castShadow = true
        loco.add(boilerCap)

        // 锅炉细条纹（金属带）
        for(let i = -1; i <= 1; i++)
        {
            const band = new THREE.Mesh(
                new THREE.TorusGeometry(1.12, 0.06, 6, 20),
                redDarkMat
            )
            band.rotation.y = Math.PI * 0.5
            band.position.set(0.5 + i * 1.2, 1.6, 0)
            loco.add(band)
        }

        // 烟囱
        const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.2, 16), blackMat)
        chimney.position.set(-1.2, 3.2, 0)
        chimney.castShadow = true
        loco.add(chimney)
        const chimneyTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 16), brassMat)
        chimneyTop.position.set(-1.2, 3.9, 0)
        loco.add(chimneyTop)

        // 驾驶舱（驾驶室）— 在锅炉后方
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 2.5), blackMat)
        cab.position.set(-2.4, 2.7, 0)
        cab.castShadow = true
        loco.add(cab)

        // 驾驶室两侧窗户
        {
            const winGeo = new THREE.PlaneGeometry(1.3, 1.1)
            const winL = new THREE.Mesh(winGeo, glassMat)
            winL.position.set(-2.4, 2.9, 1.26); winL.rotation.y = Math.PI; loco.add(winL)
            const winR = new THREE.Mesh(winGeo, glassMat)
            winR.position.set(-2.4, 2.9, -1.26); loco.add(winR)
        }

        // 前挡风玻璃（半球头前方）
        const windshield = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.9), glassMat)
        windshield.position.set(3.1, 2.1, 0)
        windshield.rotation.y = Math.PI * 0.5
        loco.add(windshield)

        // 前灯（车头正前方）
        const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), brassMat)
        headlight.position.set(3.3, 1.8, 0)
        loco.add(headlight)

        // 车灯光源（真正照亮前方）
        const headLight = new THREE.PointLight(0xfff0c0, 1.2, 20, 1.5)
        headLight.position.set(3.5, 1.8, 0)
        loco.add(headLight)
        this.headLight = headLight

        // 挂钩（前后）
        const couplerFront = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.3), grayMat)
        couplerFront.position.set(3.4, 0.55, 0); loco.add(couplerFront)
        const couplerBack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.3), grayMat)
        couplerBack.position.set(-3.5, 0.55, 0); loco.add(couplerBack)

        // 底盘（连接锅炉和轮子）
        const frame = new THREE.Mesh(new THREE.BoxGeometry(6.2, 0.4, 2.4), blackMat)
        frame.position.set(0.3, 0.7, 0); frame.castShadow = true; frame.receiveShadow = true
        loco.add(frame)

        // 轮子 —— 4 个大驱动轮 + 2 个前轮
        this._wheels = []
        const bigWheelGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.35, 20)
        bigWheelGeo.rotateZ(Math.PI * 0.5)
        const smallWheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.25, 16)
        smallWheelGeo.rotateZ(Math.PI * 0.5)
        const rimGeo = new THREE.TorusGeometry(0.9, 0.05, 4, 20)

        const bigWp = [ { x: 0.5 }, { x: -0.8 }, { x: -2.1 }, { x: 1.8 } ]
        for(const w of bigWp)
        {
            for(const zoff of [1.3, -1.3])
            {
                const wheel = new THREE.Mesh(bigWheelGeo, wheelMat)
                wheel.position.set(w.x, 0.9, zoff)
                wheel.castShadow = true
                loco.add(wheel)
                // 金属 rim
                const rim = new THREE.Mesh(rimGeo, chromeMat)
                rim.position.set(w.x, 0.9, zoff + (zoff > 0 ? 0.18 : -0.18))
                rim.rotation.y = Math.PI * 0.5
                loco.add(rim)
                this._wheels.push(wheel)
            }
        }

        // 前轮（转向架）
        for(const zoff of [1.3, -1.3])
        {
            const wheel = new THREE.Mesh(smallWheelGeo, wheelMat)
            wheel.position.set(2.9, 0.45, zoff); wheel.castShadow = true
            loco.add(wheel); this._wheels.push(wheel)
        }

        loco.position.set(0, 0, 0)
        this.group.add(loco)
        this.loco = loco

        // === 煤水车（车头后面，装煤和水）===
        const tender = this.buildTender()
        tender.position.x = -6.0
        this.group.add(tender)
        this.tender = tender

        // === 3 节乘客车厢 ===
        const cars = []
        for(let i = 0; i < 3; i++)
        {
            const car = this.buildPassengerCar(i)
            car.position.x = -(9.0 + i * 6.0)
            cars.push(car)
            this.group.add(car)
        }
        this.passengerCars = cars

        // === 挂点 ===
        // 驾驶员视角（驾驶室里）
        this.driverSeat = new THREE.Group()
        this.driverSeat.position.set(-2.4, 2.6, 0)
        loco.add(this.driverSeat)

        // 乘客视角（第一节车厢中间）
        this.passengerSeat = new THREE.Group()
        this.passengerSeat.position.set(cars[0].position.x, 2.3, 0)
        this.group.add(this.passengerSeat)
    }

    buildTender()
    {
        const g = new THREE.Group()
        const blackMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.5, roughness: 0.5 })
        const coalMat  = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.1, roughness: 0.95 })
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, metalness: 0.5, roughness: 0.4 })
        const chromeMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.9, roughness: 0.1 })

        // 煤水车车身
        const body = new THREE.Mesh(new THREE.BoxGeometry(4, 2.2, 2.4), blackMat)
        body.position.y = 1.3; body.castShadow = true; body.receiveShadow = true
        g.add(body)

        // 煤堆（顶部一滩黑色三角体）
        const coal = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.2, 6), coalMat)
        coal.position.y = 2.5; g.add(coal)

        // 水罐（旁边的圆罐）
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.5, 14), chromeMat)
        tank.rotation.z = Math.PI * 0.5
        tank.position.set(0, 1.3, 1.1)
        g.add(tank)

        // 轮子（4 个小轮）
        const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.25, 14)
        wheelGeo.rotateZ(Math.PI * 0.5)
        const wps = [ { x: -1.2 }, { x: 1.2 } ]
        for(const w of wps)
        {
            for(const zoff of [1.2, -1.2])
            {
                const wheel = new THREE.Mesh(wheelGeo, wheelMat)
                wheel.position.set(w.x, 0.4, zoff); wheel.castShadow = true
                g.add(wheel); this._wheels.push(wheel)
            }
        }

        return g
    }

    buildPassengerCar(index)
    {
        const g = new THREE.Group()

        const schemes = [
            { body: 0xc8102e, stripe: 0xffd54a, roof: 0x2a2a2a },  // 红底金条纹
            { body: 0x1f5fa0, stripe: 0xf5f0d8, roof: 0x2a2a2a },  // 蓝底奶白条纹
            { body: 0x2a2a2a, stripe: 0xc8102e, roof: 0x151515 },  // 黑底红条纹
        ]
        const s = schemes[index % schemes.length]

        const bodyMat = new THREE.MeshStandardMaterial({ color: s.body, metalness: 0.3, roughness: 0.5 })
        const stripeMat = new THREE.MeshStandardMaterial({ color: s.stripe, metalness: 0.4, roughness: 0.4 })
        const roofMat = new THREE.MeshStandardMaterial({ color: s.roof, metalness: 0.5, roughness: 0.4 })
        const glassMat = new THREE.MeshStandardMaterial({ color: 0x88bbff, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.35 })
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, metalness: 0.5, roughness: 0.4 })

        const carLen = 5.5

        // 车身（下部矩形 + 上部圆角）
        const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(carLen, 1.5, 2.6), bodyMat)
        lowerBody.position.y = 1.2; lowerBody.castShadow = true; lowerBody.receiveShadow = true
        g.add(lowerBody)

        const upperBody = new THREE.Mesh(new THREE.BoxGeometry(carLen - 0.2, 1.2, 2.4), bodyMat)
        upperBody.position.y = 2.55; upperBody.castShadow = true
        g.add(upperBody)

        // 车顶（圆管）
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.22, 1.22, carLen - 0.3, 16), roofMat)
        roof.rotation.z = Math.PI * 0.5
        roof.position.y = 3.15
        g.add(roof)

        // 车身中部金色横条纹
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(carLen + 0.01, 0.18, 2.61), stripeMat)
        stripe.position.y = 1.9; g.add(stripe)

        // 窗户 —— 每侧 4 扇
        const winCount = 4
        for(let i = 0; i < winCount; i++)
        {
            const x = -carLen * 0.5 + 0.7 + i * ((carLen - 1.4) / (winCount - 1 || 1))
            const winGeo = new THREE.PlaneGeometry(0.9, 0.75)

            const winL = new THREE.Mesh(winGeo, glassMat)
            winL.position.set(x, 2.6, 1.21); winL.rotation.y = Math.PI
            g.add(winL)

            const winR = new THREE.Mesh(winGeo, glassMat)
            winR.position.set(x, 2.6, -1.21)
            g.add(winR)
        }

        // 车门（前后两端）
        const doorMat = new THREE.MeshStandardMaterial({ color: s.stripe, metalness: 0.4, roughness: 0.4 })
        const doorGeo = new THREE.BoxGeometry(0.08, 1.2, 0.7)
        const doorF = new THREE.Mesh(doorGeo, doorMat)
        doorF.position.set(carLen * 0.5 + 0.04, 1.9, 0); doorF.rotation.y = Math.PI * 0.5
        g.add(doorF)
        const doorB = new THREE.Mesh(doorGeo, doorMat)
        doorB.position.set(-carLen * 0.5 - 0.04, 1.9, 0); doorB.rotation.y = -Math.PI * 0.5
        g.add(doorB)

        // 轮子（8 个：每端 4 个转向架）
        const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.25, 16)
        wheelGeo.rotateZ(Math.PI * 0.5)
        const wheelPositions = [
            { x: -carLen * 0.5 + 0.6 }, { x: -carLen * 0.5 + 1.4 },
            { x:  carLen * 0.5 - 0.6 }, { x:  carLen * 0.5 - 1.4 },
        ]
        for(const wp of wheelPositions)
        {
            for(const zoff of [1.25, -1.25])
            {
                const wheel = new THREE.Mesh(wheelGeo, wheelMat)
                wheel.position.set(wp.x, 0.45, zoff)
                wheel.castShadow = true
                g.add(wheel)
                this._wheels.push(wheel)
            }
        }

        return g
    }

    update()
    {
        // === 站台检测 —— 接近 t=0 时自动减速 ===
        const distToStation = Math.min(Math.abs(this.t - this.stationT), Math.abs(this.t - this.stationT + 1))
        const nearStation = distToStation < this.stationHalfRange
        let targetSpeed = this.cruiseSpeed

        if(this.state === 'running')
        {
            if(nearStation) targetSpeed = this.stopSpeed
            this.speed += (targetSpeed - this.speed) * Math.min(1, this.acceleration * this.game.ticker.deltaScaled)
        }
        else if(this.state === 'boarding')
        {
            this.speed += (0 - this.speed) * Math.min(1, this.acceleration * 3 * this.game.ticker.deltaScaled)
            if(this.speed < 0.05) this.speed = 0
            this.stopTimer += this.game.ticker.deltaScaled
            if(this.stopTimer > this.stopDuration) { this.state = 'running'; this.stopTimer = 0 }
        }
        else
        {
            this.speed += (0 - this.speed) * Math.min(1, this.acceleration * 2 * this.game.ticker.deltaScaled)
            if(this.speed < 0.05) this.speed = 0
        }

        // === 推进 ===
        if(this.speed > 0.01)
        {
            const distance = this.speed * this.game.ticker.deltaScaled * this.direction
            this.t = this.trackPath.advance(this.t, distance)
            this.applyPose()
        }

        // === 轮子旋转 ===
        const wheelSpin = (this.speed / 0.9) * this.game.ticker.deltaScaled * this.direction
        for(const w of (this._wheels || []))
            w.rotation.x += wheelSpin

        // === 乘客 camera 跟随（第三人称，从火车后上方看）===
        if(this._boardedCamera)
        {
            this.updateCameraFollow()
        }
    }

    /**
     * 第三人称跟车 —— 手动设位置避免穿箱；朝向叠加玩家鼠标偏移
     */
    updateCameraFollow()
    {
        const cam = this._boardedCamera
        if(!cam) return

        const { position, tangent } = this.trackPath.getPoseAt(this.t)
        const trainPos = this.group.position.clone()

        // tangent.y 取 0 避免坡度影响 camera offset
        const t = tangent.clone(); t.y = 0; t.normalize()

        // camera 位置：火车后上方 22m + 7m
        const backOffset = t.clone().multiplyScalar(-22)
        const upOffset = new THREE.Vector3(0, 7, 0)
        const desiredPos = trainPos.clone().add(backOffset).add(upOffset)

        // 平滑过渡
        const lerpK = Math.min(1, 8 * this.game.ticker.deltaScaled)
        cam.position.lerp(desiredPos, lerpK)

        // === 朝向：基础 lookAt 火车中心 + 玩家 yaw/pitch 偏移 ===
        const lookAtBase = trainPos.clone().add(new THREE.Vector3(0, 2.5, 0))
        const baseDir = lookAtBase.sub(cam.position).normalize()

        // 基础方向旋转玩家的 yaw（Y轴）和 pitch（X轴）
        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.viewYaw)
        const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.viewPitch)
        const finalDir = baseDir.applyQuaternion(qYaw).applyQuaternion(qPitch)

        const lookTarget = cam.position.clone().add(finalDir)
        cam.lookAt(lookTarget)

        // === 视角衰减：松手后慢慢归正前方 ===
        const decayK = 1 - Math.exp(-this.viewDecay * this.game.ticker.deltaScaled * 60)
        this.viewYaw *= (1 - decayK * 0.5)
        this.viewPitch *= (1 - decayK * 0.8)  // pitch 回正更快
    }

    applyPose()
    {
        const { position, tangent } = this.trackPath.getPoseAt(this.t)

        position.y += 0.05
        this.group.position.copy(position)

        // tangent.y 取 0 避免上下坡导致火车翻
        const t = tangent.clone(); t.y = 0; t.normalize()
        const angleY = Math.atan2(t.x, t.z)
        this.group.rotation.set(0, angleY - Math.PI * 0.5, 0)
    }

    // ==================== Camera attach / detach ====================

    attachCamera(camera, seat = 'passenger')
    {
        // 保存原来的 parent 和变换 —— camera 不 parent 到火车上（避免穿进车厢 Box）
        this._savedCamParent = camera.parent
        this._savedCamPos = camera.position.clone()
        this._savedCamQuat = camera.quaternion.clone()

        this._boardedCamera = camera
        this._cameraTarget = new THREE.Vector3()

        // 立即把 camera 放到跟车起始位置
        this.updateCameraFollow()

        // === 安装鼠标监听：让玩家在火车上自由看风景 ===
        // 注意：不解锁 pointerLock —— 继续让游戏的键盘/输入系统保持工作；
        // mousemove 的 movementX/movementY 在 pointerLock 下依然能正常给 document 事件
        this._onBoardMouseMove = (e) =>
        {
            this.viewYaw -= e.movementX * this.viewSensitivity
            this.viewPitch -= e.movementY * this.viewSensitivity
            this.viewPitch = clamp(this.viewPitch, -this.viewPitchClamp, this.viewPitchClamp)
        }
        document.addEventListener('mousemove', this._onBoardMouseMove)

        if(this.game.view) this.game.view.lockCamera = true
    }

    detachCamera(camera)
    {
        this._boardedCamera = null
        this._cameraTarget = null

        // 卸载鼠标监听
        if(this._onBoardMouseMove)
        {
            document.removeEventListener('mousemove', this._onBoardMouseMove)
            this._onBoardMouseMove = null
        }
        // 视角归零
        this.viewYaw = 0
        this.viewPitch = 0

        if(this._savedCamParent)
        {
            this._savedCamParent.add(camera)
            camera.position.copy(this._savedCamPos)
            camera.quaternion.copy(this._savedCamQuat)
        }
        this._savedCamParent = null
        this._savedCamPos = null
        this._savedCamQuat = null

        if(this.game.view) this.game.view.lockCamera = false
    }
}
