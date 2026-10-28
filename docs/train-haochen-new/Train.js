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

        // === 乘客视角（鼠标左右/上下看风景，叠加到跟车基础角度上）===
        this.viewSensitivity = 0.0025
        this.viewPitchClamp = 0.6       // pitch ±0.6 rad ≈ ±34° 上下范围
        this.viewDecay = 0.3            // 松手后角度回正速度

        this.trackPath = new TrackPath()

        // 烟系统
        this._smokes = []
        this._smokeSpawnAcc = 0
        this._smokeMax = 60
        this._smokeCanvasTex = this._makeSmokeTexture()

        // 过弯倾斜：记录上一帧切线方向
        this._prevAngleY = 0

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

        // 车灯光源（真正照亮前方）—— 加强到 2.5
        const headLight = new THREE.PointLight(0xfff0c0, 2.5, 30, 1.2)
        headLight.position.set(3.5, 1.8, 0)
        loco.add(headLight)
        this.headLight = headLight

        // 驾驶室内部暖色灯（驾驶舱里透出的温暖光）
        const cabinLight = new THREE.PointLight(0xffb060, 0.6, 8, 2)
        cabinLight.position.set(-2.4, 2.7, 0)
        loco.add(cabinLight)
        this.cabinLight = cabinLight

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
        }

        // === 无论是否推进都更新 pose（过弯倾斜需要每帧记录 angleY）===
        this.applyPose()

        // === 轮子旋转 ===
        const wheelSpin = (this.speed / 0.9) * this.game.ticker.deltaScaled * this.direction
        for(const w of (this._wheels || []))
            w.rotation.x += wheelSpin

        // === 车厢摆动（被动悬挂模拟）===
        const time = performance.now() * 0.001
        for(let i = 0; i < (this.passengerCars || []).length; i++)
        {
            const car = this.passengerCars[i]
            car.rotation.z = Math.sin(time * 1.4 + i * 1.2) * 0.012   // 左右 ~0.7°
            car.rotation.x = Math.sin(time * 1.8 + i * 0.8) * 0.006   // 上下 ~0.35°
        }

        // === 烟系统 ===
        this.updateSmoke(this.game.ticker.deltaScaled)

        // === 乘客 camera 跟随（第三人称，从火车后上方看）===
        if(this._boardedCamera)
        {
            this.updateCameraFollow()
        }
    }

    /**
     * 第三人称跟车 —— 完全复用 View.js 的 spherical + smoothedFocusPoint 套路
     * 跟开车手感一模一样：focusPoint 平滑追火车 forward，spherical 算相机偏移，
     * 用户鼠标改 thetaOffset/pitchOffset 叠加到基础角度上
     */
    updateCameraFollow()
    {
        const cam = this._boardedCamera
        if(!cam) return

        const dt = this.game.ticker.deltaScaled

        // === 1. 更新 focusPoint（火车当前位置）===
        this._focusPoint.copy(this.group.position)
        this._focusPointSmoothed.lerp(this._focusPoint, Math.min(1, this._focusLerpSpeed * dt))

        // === 2. 更新 baseTheta（火车 forward → spherical theta）===
        const { tangent } = this.trackPath.getPoseAt(this.t)
        const fwdX = tangent.x
        const fwdZ = tangent.z
        // THREE.Vector3.setFromSphericalCoords 的 theta 就是 atan2(x, z)
        const targetTheta = Math.atan2(fwdX, fwdZ)

        // 角度 lerp（处理 ±PI 跳变）
        let dTheta = targetTheta - this._baseThetaSmoothed
        while(dTheta > Math.PI)  dTheta -= Math.PI * 2
        while(dTheta < -Math.PI) dTheta += Math.PI * 2
        this._baseThetaSmoothed += dTheta * Math.min(1, this._thetaLerpSpeed * dt)

        // === 3. 视角衰减（松手后慢慢归正）===
        const decayK = 1 - Math.exp(-this.viewDecay * dt * 60)
        this._thetaOffset *= (1 - decayK * 0.5)
        this._pitchOffset *= (1 - decayK * 0.8)

        // === 4. spherical 算相机偏移（跟 View.js 完全一样）===
        const theta = this._baseThetaSmoothed + this._thetaOffset
        const phi   = this._sphericalPhi + this._pitchOffset

        const offset = new THREE.Vector3()
        offset.setFromSphericalCoords(this._sphericalRadius, phi, theta)

        // === 5. 应用到 camera ===
        cam.position.copy(this._focusPointSmoothed).add(offset)
        cam.lookAt(this._focusPointSmoothed)
    }

    applyPose()
    {
        const { position, tangent } = this.trackPath.getPoseAt(this.t)

        position.y += 0.05
        this.group.position.copy(position)

        // tangent.y 取 0 避免上下坡导致火车翻
        const t = tangent.clone(); t.y = 0; t.normalize()
        const angleY = Math.atan2(t.x, t.z)
        this.group.rotation.y = angleY - Math.PI * 0.5

        // === 过弯倾斜（离心力模拟）===
        // 计算本帧切线方向相对上一帧的变化（deltaAngle）
        let dAngle = angleY - (this._prevAngleY ?? angleY)
        while(dAngle >  Math.PI) dAngle -= Math.PI * 2
        while(dAngle < -Math.PI) dAngle += Math.PI * 2
        this._prevAngleY = angleY

        // 倾斜方向：向弯道内侧倾斜（跟真实火车一样）
        // dAngle > 0 表示向右转 → 车身向左倾（rotation.z 负）
        // dAngle < 0 表示向左转 → 车身向右倾（rotation.z 正）
        const targetRoll = -dAngle * 3.5   // 系数：转得快倾斜多
        const clampedRoll = clamp(targetRoll, -0.18, 0.18)  // ±10° 封顶
        // 平滑过渡，避免突然抖动
        const rollLerpK = Math.min(1, 6 * this.game.ticker.deltaScaled)
        this.group.rotation.z = (this.group.rotation.z || 0) + (clampedRoll - (this.group.rotation.z || 0)) * rollLerpK
    }

    // ==================== Camera attach / detach ====================

    attachCamera(camera, seat = 'passenger')
    {
        // 保存原来的 parent 和变换 —— camera 不 parent 到火车上（避免穿进车厢 Box）
        this._savedCamParent = camera.parent
        this._savedCamPos = camera.position.clone()
        this._savedCamQuat = camera.quaternion.clone()

        this._boardedCamera = camera

        // === 复用 View.js 的 spherical + smoothedFocusPoint 套路 ===
        // 跟开车完全一样的手感：focusPoint 平滑追火车，spherical 算相机偏移
        // 用户鼠标改 thetaOffset/pitchOffset，叠加到 baseTheta 上
        this._focusPoint = this.group.position.clone()
        this._focusPointSmoothed = this.group.position.clone()
        this._baseTheta = 0                  // 火车 forward 方向对应的 theta
        this._baseThetaSmoothed = 0
        this._thetaOffset = 0                // 用户左右看风景
        this._pitchOffset = 0                // 用户上下看风景

        // 第三人称参数（跟开车差不多）
        this._sphericalRadius = 22
        this._sphericalPhi = Math.PI * 0.32  // 俯角 ~58°（俯视角度）
        this._focusLerpSpeed = 10            // focusPoint 平滑速度（跟 View 的 lerp 一样）
        this._thetaLerpSpeed = 6             // baseTheta 追 forward 的平滑速度

        // 立即把 camera 放到起始位置
        this.updateCameraFollow()

        // === 安装鼠标监听：让玩家在火车上自由看风景 ===
        this._onBoardMouseMove = (e) =>
        {
            this._thetaOffset -= e.movementX * this.viewSensitivity
            this._pitchOffset -= e.movementY * this.viewSensitivity
            this._pitchOffset = clamp(this._pitchOffset, -this.viewPitchClamp, this.viewPitchClamp)
        }
        document.addEventListener('mousemove', this._onBoardMouseMove)

        if(this.game.view) this.game.view.lockCamera = true
    }

    detachCamera(camera)
    {
        this._boardedCamera = null

        // 卸载鼠标监听
        if(this._onBoardMouseMove)
        {
            document.removeEventListener('mousemove', this._onBoardMouseMove)
            this._onBoardMouseMove = null
        }

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

    // ==================== 烟系统 ====================

    /**
     * 用 Canvas 画一个径向渐变的烟纹理（中心白 → 边缘透明灰）
     */
    _makeSmokeTexture()
    {
        const size = 128
        const canvas = document.createElement('canvas')
        canvas.width = size; canvas.height = size
        const ctx = canvas.getContext('2d')

        const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
        grad.addColorStop(0.0, 'rgba(230, 230, 230, 0.9)')
        grad.addColorStop(0.3, 'rgba(200, 200, 200, 0.6)')
        grad.addColorStop(0.7, 'rgba(150, 150, 150, 0.25)')
        grad.addColorStop(1.0, 'rgba(100, 100, 100, 0.0)')

        ctx.fillStyle = grad
        ctx.fillRect(0, 0, size, size)

        const tex = new THREE.CanvasTexture(canvas)
        tex.colorSpace = THREE.SRGBColorSpace
        return tex
    }

    /**
     * 每帧更新烟粒：spawn + 飘升 + scale 变大 + alpha 降低 + 到期移除
     */
    updateSmoke(dt)
    {
        // 预计算本帧烟囱在世界坐标下的位置（烟的起点）
        const chimneyWorld = new THREE.Vector3(-1.2, 3.9, 0)
        chimneyWorld.applyMatrix4(this.loco.matrixWorld)

        // 1) Spawn —— 速度越快 spawn 越快；stationary 时几乎不冒
        this._smokeSpawnAcc += dt
        const spawnInterval = Math.max(0.06, 0.35 - this.speed * 0.018)
        while(this._smokeSpawnAcc >= spawnInterval && this._smokes.length < this._smokeMax)
        {
            this._smokeSpawnAcc -= spawnInterval
            this._spawnSmoke(chimneyWorld)
        }

        // 2) 更新现有烟粒
        const toRemove = []
        for(let i = 0; i < this._smokes.length; i++)
        {
            const s = this._smokes[i]
            s.life += dt
            const t = s.life / s.maxLife   // 0 → 1

            // 位置：从"当前烟囱位置 + 初始散布"开始，向上飘 + 水平飘散
            s.mesh.position.copy(chimneyWorld)
                .add(s.seedOffset)
            s.mesh.position.y += s.life * 2.5                // 上升速度 ~2.5 m/s
            s.mesh.position.x -= 0.3 * s.life                // 微微飘开（恒定方向足够，火车椭圆路线会自然交错）

            // scale 逐渐变大（烟扩散）
            const scale = 0.3 + t * 3.5
            s.mesh.scale.setScalar(scale)

            // alpha 从 0.85 → 0
            s.material.opacity = Math.max(0, (1 - t) * 0.75)

            // 轻微随机旋转
            s.mesh.rotation.z += dt * 0.8 + s.seed

            if(t >= 1) toRemove.push(i)
        }

        // 3) 清理到期的
        for(let i = toRemove.length - 1; i >= 0; i--)
        {
            const idx = toRemove[i]
            const s = this._smokes.splice(idx, 1)[0]
            this.game.scene.remove(s.mesh)
            s.material.dispose()
        }
    }

    _spawnSmoke(chimneyWorld)
    {
        const mat = new THREE.SpriteMaterial({
            map: this._smokeCanvasTex,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            blending: THREE.NormalBlending,
        })
        const sprite = new THREE.Sprite(mat)

        // 初始随机散布（烟从烟囱周边一点点冒出来，不是一个点）
        const seedOffset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.4,
            0,
            (Math.random() - 0.5) * 0.4
        )

        sprite.position.copy(chimneyWorld).add(seedOffset)
        sprite.scale.setScalar(0.35)

        this.game.scene.add(sprite)

        this._smokes.push({
            mesh: sprite,
            material: mat,
            seedOffset,
            life: 0,
            maxLife: 2.2 + Math.random() * 1.5,   // 2.2~3.7 秒
            seed: Math.random() * Math.PI * 2,
        })
    }
}
