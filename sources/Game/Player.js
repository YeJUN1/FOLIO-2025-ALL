import { Game } from './Game.js'
import gsap from 'gsap'
import { remapClamp, smallestAngle } from './utilities/maths.js'
import * as THREE from 'three/webgpu'
import { Inputs } from './Inputs/Inputs.js'
import { clamp } from 'three/src/math/MathUtils.js'

export class Player
{
    static STATE_DEFAULT = 1
    static STATE_LOCKED = 2

    // 当前坐着的是车还是船（船是运动学贴水，与 car 共享同一套相机/地图接口）
    static MODE_DRIVE = 1
    static MODE_BOAT = 2

    // 上船：人得到船边才算够得着（量的是“到船身表面”的距离，不是到中心的距离）。
    // 12 米不是拍脑袋，是两个实测数叠加：
    //   船刷新点被要求“周围 5×5 格都够深”（一格 3 米），最近陆地到船身表面 8.35 米；
    //   而 Character.exitVehicle() 把人放在车左侧 2.1 米处，下车点偏离落脚点到船就是 10.02 米。
    // 拿 4 米（原仓库值）站在滩上永远上不了船；拿 9 米则下车偏移一点就出圈。
    static BOAT_BOARDING_DISTANCE = 12
    // 人与船的高度差超过这个就不算站在船旁边（船开到桥上、人站在堤下时别把人吸上去）
    static BOARDING_HEIGHT = 3
    // 车身的半长 / 半宽（含保险杠）：没自带尺寸的物体才用这套默认值
    static VEHICLE_HALF_LENGTH = 1.7
    static VEHICLE_HALF_WIDTH = 0.95

    constructor()
    {
        this.game = Game.getInstance()
        
        this.state = Player.STATE_DEFAULT
        this.mode = Player.MODE_DRIVE
        this.accelerating = 0
        this.steering = 0
        this.boosting = 0
        this.braking = 0
        this.suspensions = ['low', 'low', 'low', 'low']

        // 开船：我正驾驶的那条船（null = 没在开船）
        this.activeBoat = null
        // 已经报给服务器、正在等回执的那条船（防抢船失败时回滚）
        this.pendingBoat = null

        const respawn = this.game.respawns.getDefault()

        this.position = respawn.position.clone()
        this.basePosition = this.position.clone()
        this.position2 = new THREE.Vector2(this.position.x, this.position.z)
        this.rotationY = 0

        this.setSounds()
        this.setInputs()
        this.setDistanceDriven()
        this.setUnstuck()
        // this.setBackWheel()
        this.setFlip()
        this.setTimePlayed()

        this.game.physicalVehicle.chassis.physical.initialState.position.x = respawn.position.x
        this.game.physicalVehicle.chassis.physical.initialState.position.y = respawn.position.y
        this.game.physicalVehicle.chassis.physical.initialState.position.z = respawn.position.z
        this.game.physicalVehicle.moveTo(respawn.position, respawn.rotation)

        this.game.ticker.events.on('tick', () =>
        {
            this.updatePrePhysics()
        }, 1)

        this.game.ticker.events.on('tick', () =>
        {
            this.updatePostPhysics()
        }, 6)
    }

    setSounds()
    {
        this.sounds = {}
        this.sounds.suspensions = this.game.audio.register({
            path: 'sounds/vehicle/suspensions/Robotic_Lifeforms_2_-_Air_Source_-_Piston_Studio_Chair_07.mp3',
            autoplay: false,
            loop: false,
            volume: 0.4,
            antiSpam: 0.1,
            onPlay: (item, count) =>
            {
                item.volume = 0.3 + count * 0.08
                item.rate = 0.9 + Math.random() * 0.2
            }
        })
        this.sounds.honk = this.game.audio.register(
        {
            path: 'sounds/vehicle/honk/Car Horn Long 4.mp3',
            autoplay: true,
            loop: true,
            volume: 0.4,
            antiSpam: 0.1,
            onPlaying: (item) =>
            {
                item.volume = this.game.inputs.actions.get('honk').active ? 0.5 : 0
            }
        })
        this.sounds.spring1 = this.game.audio.register({
            path: 'sounds/vehicle/springs/HandleSqueak_BW.60329.mp3',
            autoplay: false,
            loop: false,
            volume: 0.4,
            antiSpam: 1,
            onPlay: (item, count) =>
            {
                item.volume = 0.05 + count * 0.02
                item.rate = 1 + Math.random() * 0.1
            }
        })
        this.sounds.spring2 = this.game.audio.register({
            path: 'sounds/vehicle/springs/SpringMetalMovements_1u54Y_01.mp3',
            autoplay: false,
            loop: false,
            volume: 0.4,
            antiSpam: 0.2,
            onPlay: (item, count) =>
            {
                item.volume = 0.05 + count * 0.1
                item.rate = 0.9 + Math.random() * 0.4
            }
        })

        // Wheels on floor
        {
            // Default pebbles
            this.game.audio.register({
                group: 'wheelsOnFloor',
                path: 'sounds/vehicle/floor/wheels-on-pebbles-road.mp3',
                autoplay: true,
                loop: true,
                volume: 0,
                onPlaying: (item) =>
                {
                    const defaultElevation = 1.08
                    const inAirEffect = remapClamp(Math.abs(this.game.physicalVehicle.position.y - defaultElevation), 0, 2, 1, 0)
                    const speedEffect = Math.min(1, this.game.physicalVehicle.xzSpeed * 0.1)
                    item.volume = inAirEffect * speedEffect * 0.25
                }
            })

            // Brake pebbles
            this.game.audio.register({
                group: 'wheelsOnFloor',
                path: 'sounds/vehicle/floor/Source Stone Loop Small Rubbing Pebbles On Concrete 02.mp3',
                autoplay: true,
                loop: true,
                volume: 0,
                onPlaying: (item) =>
                {
                    const directionRatio = (1 - Math.abs(this.game.physicalVehicle.forwardRatio)) * 0.6
                    
                    let brakeEffect = Math.max(directionRatio, this.game.player.braking) * this.game.physicalVehicle.xzSpeed * 0.15 * this.game.physicalVehicle.wheels.inContactCount / 4
                    brakeEffect = clamp(brakeEffect, 0, 1)

                    const volume = brakeEffect * 0.4
                    const delta = volume - item.volume

                    if(delta > 0)
                        item.volume += delta * this.game.ticker.deltaScaled * 20
                    else
                        item.volume += delta * this.game.ticker.deltaScaled * 5
                    
                    item.rate = 0.8
                }
            })
        }

        // Engine and speed
        {
            // Engine
            this.game.audio.register({
                path: 'sounds/vehicle/engine/muscle car engine loop idle.mp3',
                autoplay: true,
                loop: true,
                volume: 0,
                onPlaying: (item) =>
                {
                    const accelerating = Math.abs(this.game.player.accelerating) * 0.5
                    const boosting = this.game.player.boosting + 1
                    const volume = Math.max(0.05, accelerating * boosting * 0.8)
                    const delta = volume - item.volume
                    const easing = delta > 0 ? 10 : 2.5
                    
                    item.volume += delta * this.game.ticker.deltaScaled * easing

                    const rate = remapClamp(accelerating * boosting, 0, 1, 0.6, 1.1)
                    item.rate += (rate - item.rate) * this.game.ticker.deltaScaled * 5
                }
            })

            // Spin and wind
            this.game.audio.register({
                path: 'sounds/vehicle/spin/41051 Glass stone turning loop 09-full.mp3',
                autoplay: true,
                loop: true,
                volume: 0,
                onPlaying: (item) =>
                {
                    const speedEffect = clamp(this.game.physicalVehicle.xzSpeed * 0.1, 0, 1)
                    const volume = speedEffect * 0.3
                    const delta = volume - item.volume
                    const easing = delta > 0 ? 10 : 2.5
                    
                    item.volume += delta * this.game.ticker.deltaScaled * easing

                    const rate = remapClamp(speedEffect, 0, 1, 1, 2)
                    item.rate += (rate - item.rate) * this.game.ticker.deltaScaled * 5
                }
            })
        }

        // Boost
        this.game.audio.register({
            path: 'sounds/vehicle/energy/Energy_-_force_field_8_loop.mp3',
            autoplay: true,
            loop: true,
            volume: 0,
            onPlaying: (item) =>
            {
                const accelerating = 0.5 + Math.abs(this.game.player.accelerating) * 0.5
                const boosting = this.game.player.boosting
                const volume = accelerating * boosting * 0.3
                const delta = volume - item.volume
                const easing = delta > 0 ? 10 : 1
                
                item.volume += delta * this.game.ticker.deltaScaled * easing

                const rate = 0.95 + Math.abs(this.game.player.accelerating) * 2
                item.rate += (rate - item.rate) * this.game.ticker.deltaScaled * 5
            }
        })
    }

    setInputs()
    {
        this.game.inputs.addActions([
            { name: 'forward',               categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.ArrowUp', 'Keyboard.KeyW', 'Gamepad.up', 'Gamepad.r2' ] },
            { name: 'right',                 categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.ArrowRight', 'Keyboard.KeyD', 'Gamepad.right' ] },
            { name: 'backward',              categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.ArrowDown', 'Keyboard.KeyS', 'Gamepad.down', 'Gamepad.l2' ] },
            { name: 'left',                  categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.ArrowLeft', 'Keyboard.KeyA', 'Gamepad.left' ] },
            { name: 'boost',                 categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.ShiftLeft', 'Keyboard.ShiftRight', 'Gamepad.circle' ] },
            { name: 'brake',                 categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.KeyB', 'Keyboard.ControlLeft', 'Gamepad.square' ] },
            { name: 'respawn',               categories: [ 'wandering',                       ], keys: [ 'Keyboard.KeyR', 'Gamepad.select' ] },
            { name: 'suspensions',           categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad5', 'Keyboard.Space', 'Gamepad.triangle' ] },
            { name: 'suspensionsFront',      categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad8' ] },
            { name: 'suspensionsBack',       categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad2' ] },
            { name: 'suspensionsRight',      categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad6', 'Gamepad.r1' ] },
            { name: 'suspensionsLeft',       categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad4', 'Gamepad.l1' ] },
            { name: 'suspensionsFrontLeft',  categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad7', 'Keyboard.Digit2' ] },
            { name: 'suspensionsFrontRight', categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad9', 'Keyboard.Digit3' ] },
            { name: 'suspensionsBackRight',  categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad3', 'Keyboard.Digit4' ] },
            { name: 'suspensionsBackLeft',   categories: [ 'wandering', 'racing'              ], keys: [ 'Keyboard.Numpad1', 'Keyboard.Digit1' ] },
            { name: 'interact',              categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.Enter', 'Keyboard.KeyE', 'Keyboard.KeyF', 'Gamepad.cross' ] },
            { name: 'honk',                  categories: [ 'wandering', 'racing', 'cinematic' ], keys: [ 'Keyboard.KeyH', 'Gamepad.l3' ] },
            // 上船 / 下船（E、回车、F 都被场景里的互动点占着，C 又是下车，所以用 G）
            // 走路时 filter 是 'walking'，两个类别都得挂，否则人在岸上按 G 根本不会响应
            { name: 'vehicleToggle',         categories: [ 'wandering', 'walking' ], keys: [ 'Keyboard.KeyG' ] },
        ])

        // Respawn
        this.game.inputs.events.on('respawn', (action) =>
        {
            if(this.state !== Player.STATE_DEFAULT)
                return

            if(action.active)
            {
                // 开船时按 R：把船传送回它的刷新点，人还留在船上
                if(this.mode === Player.MODE_BOAT && this.activeBoat)
                    this.game.boats.resetBoat(this.activeBoat)
                else
                    this.respawn()
            }
        })

        // Honk
        this.game.inputs.events.on('honk', (action) =>
        {
            if(action.active)
                this.honk()
        })

        // 上船 / 下船
        this.game.inputs.events.on('vehicleToggle', (action) =>
        {
            if(!action.active)
                return

            // 人在船上时 state 是 DEFAULT，下面的 die()/演出状态仍然能锁住这个键
            if(this.state !== Player.STATE_DEFAULT && !this.game.character?.active)
                return

            if(this.mode === Player.MODE_BOAT)
                this.getOffBoat()
            else
                this.tryBoardBoat()
        })

        // Suspensions
        const suspensionsUpdate = () =>
        {
            if(this.state !== Player.STATE_DEFAULT)
                return

            const activeSuspensions = [
                this.game.inputs.actions.get('suspensions').active || this.game.inputs.actions.get('suspensionsFront').active || this.game.inputs.actions.get('suspensionsRight').active || this.game.inputs.actions.get('suspensionsFrontRight').active, // front right
                this.game.inputs.actions.get('suspensions').active || this.game.inputs.actions.get('suspensionsFront').active || this.game.inputs.actions.get('suspensionsLeft').active || this.game.inputs.actions.get('suspensionsFrontLeft').active, // front left
                this.game.inputs.actions.get('suspensions').active || this.game.inputs.actions.get('suspensionsBack').active || this.game.inputs.actions.get('suspensionsRight').active || this.game.inputs.actions.get('suspensionsBackRight').active, // back right
                this.game.inputs.actions.get('suspensions').active || this.game.inputs.actions.get('suspensionsBack').active || this.game.inputs.actions.get('suspensionsLeft').active || this.game.inputs.actions.get('suspensionsBackLeft').active, // back left
            ]

            const activeState = this.game.inputs.actions.get('suspensions').active ? 'high' : 'mid' // high = jump, mid = lowride

            for(let i = 0; i < 4; i++)
                this.suspensions[i] = activeSuspensions[i] ? activeState : 'low'

            const activeCount = activeSuspensions[0] + activeSuspensions[1] + activeSuspensions[2] + activeSuspensions[3]
            

            if(activeCount)
            {
                // Sound
                this.sounds.suspensions.play(activeCount)

                // Not a jump => Achievement
                if(!this.game.inputs.actions.get('suspensions').active)
                    this.game.achievements.addProgress('suspensions')
            }
                
        }

        this.game.inputs.events.on('suspensions', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsFront', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsBack', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsRight', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsLeft', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsFrontLeft', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsFrontRight', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsBackRight', suspensionsUpdate)
        this.game.inputs.events.on('suspensionsBackLeft', suspensionsUpdate)

        this.game.inputs.events.on('suspensions', () =>
        {
            if(this.game.inputs.mode === Inputs.MODE_TOUCH)
                this.game.inputs.nipple.jump()
        })

        // Nipple tap jump
        let nippleJumpTimeout = null
        this.game.inputs.nipple.events.on('tap', () =>
        {
            this.game.inputs.nipple.jump()

            for(let i = 0; i < 4; i++)
                this.suspensions[i] = 'high'

            if(nippleJumpTimeout)
                clearTimeout(nippleJumpTimeout)
            
            nippleJumpTimeout = setTimeout(() =>
            {
                for(let i = 0; i < 4; i++)
                    this.suspensions[i] = 'low'
            }, 200)
        })
    }

    setDistanceDriven()
    {
        this.distanceDriven = {}

        const localDistanceDriven = localStorage.getItem('distanceDriven')
        this.distanceDriven.value = localDistanceDriven ? parseInt(localDistanceDriven) : 0
        this.distanceDriven.floored = Math.floor(this.distanceDriven.value)
        this.distanceDriven.reset = () =>
        {
            localStorage.removeItem('distanceDriven')
            this.distanceDriven.value = 0
            this.distanceDriven.floored = 0
        }
        
    }

    setUnstuck()
    {
        this.unstuck = {}
        this.unstuck.duration = 3
        this.unstuck.delay = null

        this.game.physicalVehicle.events.on('rightSideUp', () =>
        {
            // Reset delay
            if(this.unstuck.delay)
                this.unstuck.delay.kill()
        })

        const waitAndTest = () =>
        {
            this.unstuck.delay = gsap.delayedCall(this.unstuck.duration, () =>
            {
                this.unstuck.delay = null

                if(this.state !== Player.STATE_DEFAULT)
                    return

                // Still upside down => Flip back
                if(this.game.physicalVehicle.upsideDown.active)
                {
                    this.game.physicalVehicle.flip.jump()
                    
                    // Sound
                    this.sounds.suspensions.play(4)

                    // Achievement
                    if(this.game.physicalVehicle.upsideDown.ratio > 0.75)
                        this.game.achievements.setProgress('upsideDown', 1)

                    // Again in case it didn't work
                    waitAndTest()
                }
            })
        }

        this.game.physicalVehicle.events.on('upsideDown', (ratio) =>
        {
            // Reset delay
            if(this.unstuck.delay)
                this.unstuck.delay.kill()

            // Wait a moment
            waitAndTest()
        })

        this.game.physicalVehicle.events.on('stuck', () =>
        {
            this.game.inputs.interactiveButtons.addItems(['unstuck'])
        })

        this.game.physicalVehicle.events.on('unstuck', () =>
        {
            this.game.inputs.interactiveButtons.removeItems(['unstuck'])
        })

        this.game.inputs.interactiveButtons.events.on('unstuck', () =>
        {
            this.game.inputs.interactiveButtons.removeItems(['unstuck'])
            this.respawn()
        })
    }

    // setBackWheel()
    // {
    //     let delay = null
    //     let startTime = null

    //     this.game.physicalVehicle.events.on('backWheel', (_active) =>
    //     {
    //         if(_active)
    //         {
    //             startTime = this.game.ticker.elapsed

    //             if(delay)
    //             {
    //                 delay.kill()
    //                 delay = null
    //             }
    //         }
    //         else
    //         {
    //             delay = gsap.delayedCall(0.1, () =>
    //             {
    //                 delay = null

    //                 const duration = this.game.ticker.elapsed - startTime

    //                 if(duration > 5)
    //                     this.game.achievements.setProgress('backWheel', 1)
    //             })
    //         }
    //     })
    // }

    setFlip()
    {
        this.game.physicalVehicle.events.on('flip', (direction) =>
        {
            if(direction > 0)
                this.game.achievements.setProgress('frontFlip', 1)
            else
                this.game.achievements.setProgress('backFlip', 1)
        })
    }

    setTimePlayed()
    {
        const localTimePlayed = localStorage.getItem('timePlayed')
        this.timePlayed = {}
        this.timePlayed.all = localTimePlayed ? parseFloat(localTimePlayed) : 0
        this.timePlayed.session = 0
        this.timePlayed.achieved = false

        setInterval(() =>
        {
            localStorage.setItem('timePlayed', this.timePlayed.all)
        }, 1000)
    }

    respawn(respawnName = null, callback = null)
    {
        this.game.overlay.show(() =>
        {
            if(typeof callback === 'function')
                callback()

            // 正在开船：先把船席位让出去（船留在原地），人直接回到车里。
            // 不然传送只拉车不拉船，人和船会被各拉向不同的地方
            if(this.mode === Player.MODE_BOAT)
            {
                if(this.activeBoat)
                    this.game.boats.localLeave(this.activeBoat)

                this.activeBoat = null
                this.pendingBoat = null
                this.mode = Player.MODE_DRIVE

                // 上船时人是被“收起来”的，这里确认一下别留一个可见的人偶站在旧坐标上
                this.game.character?.deactivate()
            }

            // Find respawn
            let respawn = respawnName ? this.game.respawns.getByName(respawnName) : this.game.respawns.getClosest(this.position)

            // Update physical vehicle
            this.game.physicalVehicle.moveTo(
                respawn.position,
                respawn.rotation
            )
            
            this.state = Player.STATE_DEFAULT
            this.game.overlay.hide()
        })
    }

    die()
    {
        this.state = Player.STATE_LOCKED
        
        gsap.delayedCall(2, () =>
        {
            this.respawn(null, () =>
            {
                this.state = Player.STATE_DEFAULT
            })
        })
    }

    honk()
    {
        // Suspensions
        const randomWheelIndex = Math.floor(Math.random() * 4)
        const previousState = this.suspensions[randomWheelIndex]
        this.suspensions[ randomWheelIndex ] = 'mid'

        gsap.delayedCall(0.15, () =>
        {
            if(this.suspensions[ randomWheelIndex ] === 'mid')
            {
                this.suspensions[ randomWheelIndex ] = previousState
            }
        })

        // Achievement
        this.game.achievements.addProgress('honk')
    }

    // ———— 船钥匙：上船、下船 ————

    /**
     * 联机时我的编号。没连服务器（纯单机）就是 null：
     * Boat/Boats 里所有联网分支都以它为开关，null 时自动退化成纯本地模拟。
     */
    getMyId()
    {
        return this.game.remotePlayers?.id ?? null
    }

    /**
     * 相机/地图/音效跟着走的“当前交通工具”。
     * 船已 duck-type 成与 physicalVehicle 同名接口，调用方无需分支。
     */
    getActiveVehicle()
    {
        if(this.mode === Player.MODE_BOAT && this.activeBoat)
            return this.activeBoat

        return this.game.physicalVehicle
    }

    /**
     * 人到交通工具表面的距离（0 = 正贴着）。
     * 不能拿“到中心的距离”来判：船有十米长，站在船头船尾离中心就有五六米。
     * 所以把人到中心的位移投影到“前后 / 左右”两个方向，减掉车身自己的半长半宽。
     */
    static vehicleSurfaceDistance(vehicle, position)
    {
        const forward = vehicle.forward.clone().setY(0).normalize()

        if(forward.lengthSq() < 0.01)
            forward.set(1, 0, 0)

        // 车/船自己的尺寸：船有 10 米长，拿车的半长去量会把“明明贴在船边”算成离船好几米
        const halfLength = vehicle.halfLength ?? Player.VEHICLE_HALF_LENGTH
        const halfWidth = vehicle.halfWidth ?? Player.VEHICLE_HALF_WIDTH

        // 左右方向：车头朝 +X 时，左右是 +Z
        const sidewardX = -forward.z
        const sidewardZ = forward.x

        const offsetX = position.x - vehicle.position.x
        const offsetZ = position.z - vehicle.position.z

        const alongForward = offsetX * forward.x + offsetZ * forward.z
        const alongSideward = offsetX * sidewardX + offsetZ * sidewardZ

        const beyondForward = Math.max(0, Math.abs(alongForward) - halfLength)
        const beyondSideward = Math.max(0, Math.abs(alongSideward) - halfWidth)

        return Math.hypot(beyondForward, beyondSideward)
    }

    static isNearVehicle(vehicle, position)
    {
        // 船漂在下游、人站在堤上时别把人吸下去
        if(Math.abs(position.y - vehicle.position.y) > Player.BOARDING_HEIGHT)
            return false

        return Player.vehicleSurfaceDistance(vehicle, position) <= Player.BOAT_BOARDING_DISTANCE
    }

    // 最近的一条空船（有人开的不能抢）
    findBoardingBoat()
    {
        const boats = this.game.boats

        if(!boats)
            return null

        // 人在岸上就走人的位置，还坐在车里就以车为锚
        const position = this.game.character?.active
            ? this.game.character.position
            : this.game.physicalVehicle.position

        let best = null
        let bestDistance = Player.BOAT_BOARDING_DISTANCE

        for(const boat of boats.list)
        {
            if(boat.driverId)
                continue

            if(!Player.isNearVehicle(boat, position))
                continue

            const distance = Player.vehicleSurfaceDistance(boat, position)

            if(distance < bestDistance)
            {
                bestDistance = distance
                best = boat
            }
        }

        return best
    }

    /**
     * 按 G 上船。人可能正在开车，也可能正在岸上走：
     * 先按当前位置量一次（走路以人为锚、开车以车为锚），量得着船才把车停在原地、人下车进船。
     * 量不着就不要把人扔在荒野里，只给一句提示。
     */
    tryBoardBoat()
    {
        if(!this.game.boats)
            return

        const boat = this.findBoardingBoat()

        if(!boat)
        {
            this.game.notifications.show(
                /* html */`
                    <div class="top">
                        <div class="title">No boat within reach</div>
                    </div>
                    <div class="bottom">
                        <div class="description">Park next to the water and press G</div>
                    </div>
                `,
                '',
                2.5,
                null,
                'boatTooFar'
            )
            return
        }

        // 还坐在车里：先下车（车就地冻住），人站在车边被收进船里
        if(!this.game.character?.active)
            this.game.character?.exitVehicle()

        this.boardBoat(boat)
    }

    /**
     * 上船：船是单人座，有人开就不能抢。
     * 本地先上（手感瞬快），同时报给服务器裁决；若被抢则回执会把我请下来。
     */
    boardBoat(boat)
    {
        if(!boat || boat.driverId)
            return false

        this.boardBoatLocal(boat)

        if(this.getMyId())
        {
            this.pendingBoat = boat.id
            this.game.remotePlayers?.sendBoatBoard(boat.id)
        }

        return true
    }

    // 只在本地坐进去（服务器回执 / 离线都走这里，不发网络）
    boardBoatLocal(boat)
    {
        if(!boat)
            return false

        if(this.mode === Player.MODE_BOAT && this.activeBoat === boat)
            return true

        // 人在岸上走着：把他收进船里。车不用碰——走路状态下它本来就是冻住的
        this.game.character?.deactivate()

        this.activeBoat = boat
        this.game.boats.localBoard(boat, this.getMyId())
        this.mode = Player.MODE_BOAT

        // 输入切回开车那一套（Boat 直读 forward/left/right/brake），同时把车钥匙拔了
        this.accelerating = 0
        this.steering = 0
        this.boosting = 0
        this.braking = 0
        this.state = Player.STATE_DEFAULT
        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('wandering')

        return true
    }

    // 服务器确认我就是这条船的驾驶员
    onBoatConfirmed(boatId)
    {
        if(this.pendingBoat === boatId)
            this.pendingBoat = null
    }

    // 服务器说这条船被别人抢了：把我刚乐观上进去的那条退下来
    onBoatBusy(boatId)
    {
        if(this.pendingBoat !== boatId)
            return

        this.pendingBoat = null

        if(this.activeBoat && this.activeBoat.id === boatId)
            this.forceOffBoat(this.activeBoat, false)
    }

    // 被服务器/回执请下船（sendLeave=false 代表示我本来就没坐上）
    forceOffBoat(boat, sendLeave = true)
    {
        if(!boat)
            return

        if(sendLeave && this.getMyId())
            this.game.remotePlayers?.sendBoatLeave(boat.id)

        if(boat.localDriven)
            this.game.boats.localLeave(boat)

        if(this.activeBoat === boat)
        {
            this.activeBoat = null
            this.backOnShore(boat)
        }

        if(this.pendingBoat === boat.id)
            this.pendingBoat = null
    }

    /**
     * 下船时人落在哪：优先放到最近的岸上。
     * 这张图的水最深才 1.2 米，角色又没有游泳动画，直接扔在水里会一直沉到河底，
     * 看着就站在水底。真找不到岸（理论上不会）才退回“船头上方一点”。
     */
    boatDropPosition(boat)
    {
        if(boat)
        {
            const shore = this.game.boats?.getShoreDrop(boat.position.x, boat.position.z)

            if(shore)
                return shore
        }

        const position = boat
            ? boat.position.clone()
            : this.position.clone()

        position.y += 1

        return position
    }

    /**
     * 回到陆地：人放到最近的岸上走路，船留在原地（搁在滩上也没关系——这正是 REFRESH 的用途），
     * 车仍然冻在上船的地方，走回車边按 C 就能开。
     */
    backOnShore(boat)
    {
        this.mode = Player.MODE_DRIVE

        const drop = this.boatDropPosition(boat)
        const character = this.game.character

        if(character)
        {
            character.activateAt(drop, this.rotationY)
            return
        }

        // 极端兼容：这个构建没有走路角色时，把人交还给车，并把车搬到最近的岸上解冻
        this.game.physicalVehicle.moveTo(drop, this.rotationY)
        this.game.physicalVehicle.activate()
        this.state = Player.STATE_DEFAULT
        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('wandering')
    }

    /**
     * 下船（按 G）：先把座位让给服务器，免得别人以为车里还坐着人。
     */
    getOffBoat()
    {
        if(this.mode !== Player.MODE_BOAT)
            return

        const boat = this.activeBoat
        this.pendingBoat = null

        if(boat && this.getMyId())
            this.game.remotePlayers?.sendBoatLeave(boat.id)

        if(boat)
            this.game.boats.localLeave(boat)

        this.activeBoat = null
        this.backOnShore(boat)
    }

    updatePrePhysics()
    {
        this.accelerating = 0
        this.steering = 0
        this.boosting = 0
        this.braking = 0

        if(this.state !== Player.STATE_DEFAULT)
            return

        // 开船时：WASD 由 Boat 自己直读，Player 这边必须早返回（保持 accelerating/steering=0），
        // 不然冻在岸上的车会跟着我的按键自己跑
        if(this.mode === Player.MODE_BOAT)
            return

        /**
         * Accelerating
         */
        if(this.game.inputs.actions.get('forward').active)
            this.accelerating += this.game.inputs.actions.get('forward').value

        if(this.game.inputs.actions.get('backward').active)
            this.accelerating -= this.game.inputs.actions.get('backward').value

        /**
         * Boosting
         */
        if(this.game.inputs.actions.get('boost').active)
            this.boosting = 1

        /**
         * Braking
         */
        if(this.game.inputs.actions.get('brake').active)
        {
            this.accelerating = 0
            this.braking = 1
        }

        /**
         * Steering
         */
        // Left / right actions
        if(this.game.inputs.actions.get('right').active)
            this.steering -= 1
        if(this.game.inputs.actions.get('left').active)
            this.steering += 1

        // Gamepad joystick
        if(this.steering === 0 && this.game.inputs.gamepad.joysticks.left.active)
            this.steering = - this.game.inputs.gamepad.joysticks.left.safeX

        /**
         * Nipple
         */
        if(this.game.inputs.nipple.active && this.game.inputs.nipple.progress > 0)
        {
            if(!this.game.view.focusPoint.isTracking)
            {
                // Wait a few frames in case it a multi-touch
                this.game.ticker.wait(5, () =>
                {
                    if(this.game.inputs.nipple.active)
                        this.game.view.focusPoint.isTracking = true
                })
            }
            this.accelerating = Math.pow(this.game.inputs.nipple.progress, 3)
            // this.boosting = this.game.inputs.nipple.progress > 0.999

            const angleDeltaAbs = Math.abs(this.game.inputs.nipple.smallestAngle)
            const angleDeltaAbsNormalized = angleDeltaAbs / ((Math.PI * 2 - this.game.inputs.nipple.forwardAmplitude) / 2)
            const angleDeltaSign = Math.sign(this.game.inputs.nipple.smallestAngle)
            const steering = - Math.min(angleDeltaAbsNormalized, 1) * angleDeltaSign

            this.steering = steering

            if(!this.game.inputs.nipple.forward)
            {
                this.accelerating *= -1
                this.steering *= -1
            }
        }
    }

    updatePostPhysics()
    {
        // 当前交通工具：开车时是车，开船时是船（接口同名，下面无需分支）
        const vehicle = this.getActiveVehicle()

        // Position
        this.position.copy(vehicle.position)
        this.position2 = new THREE.Vector2(this.position.x, this.position.z)
        
        // View > Focus point
        this.game.view.focusPoint.trackedPosition.copy(this.position)

        // View > Speed lines
        if(this.boosting && this.accelerating && vehicle.speed > 15)
            this.game.view.speedLines.strength = 1
        else
            this.game.view.speedLines.strength = 0

        this.game.view.speedLines.worldTarget.copy(this.position)

        // Tracks > Focus point
        this.game.tracks.focusPoint.set(this.position.x, this.position.z)

        // Inputs touch joystick
        this.rotationY = Math.atan2(vehicle.forward.z, vehicle.forward.x)
        this.game.inputs.nipple.setCoordinates(this.position.x, this.position.y, this.position.z, this.rotationY)

        // Sound
        if(vehicle.wheels && vehicle.wheels.justTouchedCount > 1)
        {
            this.sounds.spring1.play(vehicle.wheels.justTouchedCount)
            this.sounds.spring2.play(vehicle.wheels.justTouchedCount)
        }

        // Time played
        this.timePlayed.all += this.game.ticker.delta
        this.timePlayed.session += this.game.ticker.delta

        if(!this.timePlayed.achieved && this.timePlayed.session > this.game.dayCycles.duration)
        {
            this.timePlayed.achieved = true
            this.game.achievements.setProgress('fullDay', 1)
        }

        // Sea achievement
        const distanceToCenter = this.position2.length()
        if(distanceToCenter > 120)
            this.game.achievements.setProgress('sea', 1)

        // Go high achievements
        const elevation = Math.floor(this.position.y)
        if(this.game.achievements.groups.get('goHigh') && elevation > this.game.achievements.groups.get('goHigh').progress)
            this.game.achievements.setProgress('goHigh', elevation)

        // // Speed achievement
        // const speedKmPerHour = Math.floor(this.game.physicalVehicle.xzSpeed / 1000 * 3600)

        // if(this.game.achievements.groups.get('speed') && speedKmPerHour > this.game.achievements.groups.get('speed').progress)
        //     this.game.achievements.setProgress('speed', speedKmPerHour)

        // Distance driven
        this.distanceDriven.value += vehicle.xzSpeed * this.game.ticker.deltaScaled
        const flooredDistanceDriven = Math.floor(this.distanceDriven.value)

        if(flooredDistanceDriven !== this.distanceDriven.floored)
        {
            localStorage.setItem('distanceDriven', flooredDistanceDriven)
            this.distanceDriven.floored = flooredDistanceDriven
        }
        
        // Achievement
        const distanceDrivenKm = Math.floor(this.distanceDriven.value / 1000)

        if(this.game.achievements.groups.get('distanceDriven') && distanceDrivenKm > this.game.achievements.groups.get('distanceDriven').progress)
        {
            this.game.achievements.setProgress('distanceDriven', distanceDrivenKm)

        }
    }
}