import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

/**
 * 一条可以开的船。
 *
 * 关键：它刻意长得跟 `physicalVehicle` 一模一样（position / forward / upward /
 * sideward / quaternion / yRotation / speed / xzSpeed / velocity / moveTo / activate），
 * 这样相机（View）、地图（Map）、玩家（Player）都能不改逻辑直接把它当车来跟随。
 *
 * 但它不走物理引擎：纯运动学贴水面。y 永远 = 水面高度 + 一点浮浪，
 * 开起来是"街机式"——油门给前进、方向给转向、转向有效性跟速度挂钩。
 *
 * probe：由 Boats 传进来的水域探针，接口 { isWater(x, z) => boolean, bedHeightAt(x, z) => number }，
 * 前者挡住船不让它开上岸，后者保证船底不插进河床。
 */
export class Boat
{
    // 目标船身长度（世界单位），加载后按包围盒缩放到这个长度。
    // 5.5 米摆在这张图里比一辆车还小，看着就像个玩具，放到 10 米
    static TARGET_LENGTH = 10
    /**
     * 吃水比例：船体总高的这么多部分留在水线以下。原点烘到水线上，
     * 所以船的 position.y 直接就等于水面高度。
     * 这只是个名义值，真正定盘的是下面的 DRY_MARGIN 钳制：
     * 加载时会量一遍每个部件的高度，水线永远压在上层部件最低点以下。
     * 写 0.22（0.66 米）时水线已经漫过压条、骑到甲板下沿上头去了，看着就是船在沉、舱里在进水。
     */
    static DRAFT_RATIO = 0.15
    // 水线跟上层部件最低点之间至少留这么多干舷，给浮浪和倾角余够裕量（见 setModel 里的钳制）
    static DRY_MARGIN = 0.10
    // 浮浪：幅度压到十几厘米，再大就会把船头一下按进水里
    static WAVE_BOB = 0.035
    static WAVE_TILT = 0.008
    // 滑行姿态：船速越快越抬船头（既好看，也保证船头不喝水）
    static TRIM_PER_SPEED = 0.001
    static MAX_TRIM = 0.008
    // 街机手感
    static ACCEL = 9
    static MAX_SPEED = 14
    static MAX_REVERSE = -6
    static DRAG = 1.6
    static TURN_RATE = 1.7
    static BRAKE = 16
    /**
     * 顶岸 / 搁浅时的兜底舵效。没它的话会死锁：船头插上滩 → 速度被打到接近 0 →
     * 舵效跟着速度走也变 0 → 油门和方向全白搭，船焊在岸上“开不动”，只能靠 REFRESH / R 救。
     */
    static IDLE_STEER = 0.45
    static SAND_DRAG = 2.2     // 蹭上沙滩时的速度衰减（按秒，不是按帧）
    static BLOCKED_DRAG = 3    // 彻底顶住岸时的速度衰减（按秒）

    constructor(id, spawnPoint, probe)
    {
        this.game = Game.getInstance()

        this.id = id
        this.probe = probe
        this.spawnPoint = spawnPoint.clone ? spawnPoint.clone() : new THREE.Vector3().copy(spawnPoint)
        this.spawnRotation = 0

        // ———— 与 physicalVehicle 对齐的对外只读接口 ————
        this.position = new THREE.Vector3()
        this.velocity = new THREE.Vector3()
        this.direction = new THREE.Vector3(1, 0, 0)
        this.quaternion = new THREE.Quaternion()
        // 给倾角复用的两个四元数（refreshPose 每帧都跑，不要在里面 new）
        this.tiltRollQuat = new THREE.Quaternion()
        this.tiltPitchQuat = new THREE.Quaternion()
        this.sideward = new THREE.Vector3(0, 0, 1)
        this.upward = new THREE.Vector3(0, 1, 0)
        this.forward = new THREE.Vector3(1, 0, 0)
        this.yRotation = 0
        this.speed = 0
        this.xzSpeed = 0

        // ———— 内部运动状态 ————
        this.heading = 0
        this.forwardSpeed = 0
        this.steer = 0
        // 此刻是不是顶在岸上 / 坐在河床上（决定要不要给兜底舵效，见 IDLE_STEER）
        this.blocked = false
        this.grounded = false

        // 谁在开这条船：null = 空船；否则是玩家 id（联机记账 / 判断空船用）
        this.driverId = null
        // 本地专属：这条船此刻是不是由本机玩家踩油门模拟（离线/联机都靠它，不依赖 id）
        this.localDriven = false
        // 远端驾驶员广播过来的目标位姿（本地插值跟上）
        this.netTarget = null

        this.lastPosition = this.position.clone()

        this.setModel()

        // 复位到刷新点
        this.moveTo(this.spawnPoint, this.spawnRotation)

        this.tickCallback = () =>
        {
            this.update()
        }
        this.game.ticker.events.on('tick', this.tickCallback, 7)
    }

    destroy()
    {
        this.game.ticker.events.off('tick', this.tickCallback)

        if(this.mesh)
            this.mesh.removeFromParent()
    }

    setModel()
    {
        const template = this.game.resources.boatModel.scene

        // 克隆一份，多条船互不影响
        this.mesh = template.clone(true)
        this.mesh.name = `boat_${this.id}`

        // 先上色再转卡通材质（材质名字必须唯一，不然后面的缓存会跟别的资源撞车）
        this.paintMaterials()

        // 卡通材质 + 阴影
        this.game.materials.updateObject(this.mesh)
        this.mesh.traverse((child) =>
        {
            if(child.isMesh)
            {
                child.castShadow = true
                child.receiveShadow = true

                /**
                 * 船壳必须双面渲染：这个 GLB 是个壳，没有底板。默认只画正面，从上面望进船腔就
                 * 直接看穿船壳、看到底下那张平铺的水面——于是“船在漏水”。改成双面后舱壁是实心的，
                 * 无论从哪个角度看船里都是干的。
                 */
                const materials = Array.isArray(child.material) ? child.material : [child.material]

                for(const material of materials)
                {
                    if(material)
                        material.side = THREE.DoubleSide
                }
            }
        })

        // 按包围盒把船缩放到目标长度
        const box = new THREE.Box3().setFromObject(this.mesh)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())

        /**
         * 缩放前先顺手量一遍每个部件的最低点（此时四个部件还是未缩放的原始坐标，跟单位一致）。
         * 吃水不能只按比例拍：水线必须压在所有上层部件（压条 / 甲板 / 舱室）最低点以下，
         * 不然水面会直接切进船壳里，看着就是船在沉、水在往舱里灌。
         */
        let structureMin = Infinity

        this.mesh.traverse((child) =>
        {
            if(!child.isMesh)
                return

            const part = new THREE.Box3().setFromObject(child)

            // 船壳自己就是最低那一个（它就是该吃水的部分），只认比它高的部件
            if(part.min.y <= box.min.y + 1e-4)
                return

            structureMin = Math.min(structureMin, part.min.y)
        })

        const longest = Math.max(size.x, size.y, size.z) || 1
        this.scale = Boat.TARGET_LENGTH / longest
        this.mesh.scale.setScalar(this.scale)

        // 记下船身平面尺寸（碰撞 / 上船判定用）：forward 是 +X，X 半长 = 船长一半，Z 半宽 = 船宽一半
        this.halfLength = size.x * this.scale * 0.5
        this.halfWidth = size.z * this.scale * 0.5

        /**
         * 把原点烘到“水线”上：横向居中，纵向只把吃水那部分留在原点以下。
         * 之前原点落在几何正中心，等于把一半船壳（这条船是 1.5 米）压到水面以里，
         * 水浅一点船底就直接插进河床——这就是“船入土了”。
         */
        const minY = box.min.y * this.scale
        const height = size.y * this.scale

        this.draft = height * Boat.DRAFT_RATIO        // 吃水：水线以下多深

        /**
         * 水线钳制：按量出来的部件高度，把吃水收到“上层结构最低点 - 安全干舷”以下。
         * 这条船量出来（都是离船底的高度）：船壳顶 1.29 米、压条下沿 0.40 米、甲板下沿 0.47 米，
         * 于是吃水从名义 0.45 被钳到 0.30 米：静态时水线在压条以下，浮浪加倾角全叠到最坏一边时
         * 水线也只爬到 0.44 米，始终够不到甲板下沿——船看着浮得高，舱里也再不会显出进水。
         */
        if(structureMin < Infinity)
        {
            const structureFromKeel = (structureMin - box.min.y) * this.scale
            this.draft = Math.min(this.draft, Math.max(0, structureFromKeel - Boat.DRY_MARGIN))
        }

        this.freeboard = height - this.draft          // 干舷：水线以上多高

        this.mesh.position.set(
            -center.x * this.scale,
            -(minY + this.draft),
            -center.z * this.scale
        )

        // 包一层 group，方便整体摆放
        this.group = new THREE.Group()
        this.group.add(this.mesh)
        this.game.scene.add(this.group)
    }

    /**
     * 这个 GLB 是 FBX 直转的：四个材质槽全叫 Dagger Metal / Material / Material.001…，
     * baseColor 一律 0.8 的灰，既没贴图也没顶点色——不改就是一条灰糊糊的船。
     * 按几何量出来的分工涂一套卡通船配色：
     *   槽 0 船底 / 船体（最低、全船）  槽 1 吃水线压条  槽 2 船尾机座  槽 3 甲板 + 舱室（最高）
     */
    paintMaterials()
    {
        const slots = [
            { name: 'boatHull',   color: 0xe04a3c },  // 船体：红
            { name: 'boatStripe', color: 0x324a6b },  // 压条：深蓝
            { name: 'boatStern',  color: 0x5d5470 },  // 船尾机座：深紫灰
            { name: 'boatDeck',   color: 0xfdf4e3 },  // 甲板与上层建筑：奶白
        ]

        /**
         * 关键：槽位得按“这是第几个 mesh”认，不能只按 child.material 数组里的下标。
         * glTF 里这一个 mesh 带了 4 个 primitive，但四个的属性对不上，GLTFLoader 合并不了，
         * 就拆成 4 个兄弟节点：Cube / Cube_1 / Cube_2 / Cube_3，每个只挂 1 个材质。
         * 之前按数组下标取槽，四个 mesh 都拿到下标 0 ⇒ 四个槽全被命名成 boatHull，
         * 而 Materials 是按名字缓存材质的，四次命中同一个实例 ⇒ 整条船涂成一个红色（“颜色不对劲”）。
         */
        let meshIndex = 0

        this.mesh.traverse((child) =>
        {
            if(!child.isMesh)
                return

            const named = /^Cube_(\d+)$/.exec(child.name)
            const base = named ? Number(named[1]) : meshIndex
            meshIndex++

            const wasArray = Array.isArray(child.material)
            const materials = wasArray ? child.material : [child.material]

            for(let i = 0; i < materials.length; i++)
            {
                const material = materials[i]

                if(!material)
                    continue

                // 没拆分的理想情况（一个 mesh 挂四个材质）也能走对：下标 i 接在 base 后面排
                const slot = slots[(base + (named ? 0 : i)) % slots.length]

                material.name = slot.name

                if(material.color)
                    material.color.setHex(slot.color)
            }

            child.material = wasArray ? materials : materials[0]
        })
    }

    // physicalVehicle 有这个空实现，船也留一个，调用方无需分支
    activate() {}

    /**
     * 瞬移（R 召回、REFRESH 召回、上船初始化都走它）。
     * 瞬移到水面之上，速度清零、朝向重置。
     */
    moveTo(position, rotation = 0)
    {
        this.position.set(position.x, 0, position.z)
        this.heading = rotation
        this.forwardSpeed = 0
        this.velocity.set(0, 0, 0)
        this.netTarget = null

        // 贴水 + 更新姿态，下一帧视觉立刻一致
        this.refreshPose(true)
    }

    // ———— 谁是本地驾驶员 ————
    isLocalDriven()
    {
        return this.localDriven
    }

    update()
    {
        const dt = this.game.ticker.deltaScaled
        const localDriven = this.isLocalDriven()

        // 没被远端广播位姿时，本地（含空船）自己算位姿
        if(localDriven)
            this.drive(dt)
        else if(this.netTarget)
            this.interpolate(dt)
        else
            this.forwardSpeed = this.forwardSpeed * (1 - Math.min(1, dt * 2))

        this.refreshPose(false)

        // 速度量（供相机 / 地图 / speedLines 用，语义与车一致）
        this.velocity.set(
            this.position.x - this.lastPosition.x,
            this.position.y - this.lastPosition.y,
            this.position.z - this.lastPosition.z
        )
        this.lastPosition.copy(this.position)

        this.xzSpeed = Math.hypot(this.velocity.x, this.velocity.z) / Math.max(dt, 1e-4)
        this.speed = this.velocity.length() / Math.max(dt, 1e-4)

        // 视觉同步
        this.group.position.copy(this.position)
        this.group.quaternion.copy(this.quaternion)
    }

    /**
     * 街机驾驶：直接读按键（Player 在 MODE_BOAT 下会早返回、不碰车）。
     * forward/backward 给油，left/right 打舵，brake 刹车。
     */
    drive(dt)
    {
        const actions = this.game.inputs.actions

        // 油门
        let throttle = 0
        if(actions.get('forward').active)
            throttle += actions.get('forward').value
        if(actions.get('backward').active)
            throttle -= actions.get('backward').value

        if(throttle !== 0)
            this.forwardSpeed += throttle * Boat.ACCEL * dt
        else
        {
            // 无输入时朝 0 阻尼
            const drag = Boat.DRAG * dt
            if(Math.abs(this.forwardSpeed) <= drag)
                this.forwardSpeed = 0
            else
                this.forwardSpeed -= Math.sign(this.forwardSpeed) * drag
        }

        // 刹车
        if(actions.get('brake').active)
        {
            const b = Boat.BRAKE * dt
            if(Math.abs(this.forwardSpeed) <= b)
                this.forwardSpeed = 0
            else
                this.forwardSpeed -= Math.sign(this.forwardSpeed) * b
        }

        // 限速
        this.forwardSpeed = Math.max(Boat.MAX_REVERSE, Math.min(Boat.MAX_SPEED, this.forwardSpeed))

        // 转向：打舵有效性随速度增大而趋满，倒车反向
        let steer = 0
        if(actions.get('left').active)
            steer += 1
        if(actions.get('right').active)
            steer -= 1
        this.steer = steer

        // 船基本静止时不给转（像真船），速度越大越灵（到 6 就吃满）
        let speedFactor = Math.min(1, Math.abs(this.forwardSpeed) / 6)

        // 顶岸 / 搁浅时把舵效托个底，不然低速 = 没舵，船就再也摆不出来了
        if(this.blocked || this.grounded)
            speedFactor = Math.max(speedFactor, Boat.IDLE_STEER)

        // left(+1) => heading 减小（前面推导过：+Z 为左，yaw 减小才往 +Z 转）；倒车反向
        this.heading -= steer * Boat.TURN_RATE * dt * speedFactor * Math.sign(this.forwardSpeed || 1)

        // 前进位移
        const fx = Math.cos(this.heading)
        const fz = -Math.sin(this.heading)
        const stepX = fx * this.forwardSpeed * dt
        const stepZ = fz * this.forwardSpeed * dt

        const nextX = this.position.x + stepX
        const nextZ = this.position.z + stepZ

        /**
         * 岸的判定：水面随便开，滩让船蹭上去一小段（Boats.BEACH_DEPTH），但不许开到地上。
         * 之前只按“是不是水”硬挡，船头离看得见的沙滩还有好几米就撞上一堵隐形墙，
         * 再叠上“低速没舵”，就成了“船离岸边一定距离就开不动了”。
         */
        const canSail = this.probe.canSail
        const nextDepth = this.probe.depthAt(nextX, nextZ)

        this.blocked = false

        if(canSail(nextX, nextZ))
        {
            this.position.x = nextX
            this.position.z = nextZ

            // 滩上磨着沙子走：速度掉得快但不归零，松油门就能退回到水里
            if(nextDepth <= 0)
                this.forwardSpeed *= Math.max(0, 1 - dt * Boat.SAND_DRAG)
        }
        else if(canSail(nextX, this.position.z))
        {
            this.position.x = nextX
            this.forwardSpeed *= 0.5
        }
        else if(canSail(this.position.x, nextZ))
        {
            this.position.z = nextZ
            this.forwardSpeed *= 0.5
        }
        else
        {
            // 完全顶住岸：按秒衰减速度（不是按帧乘 0.3，那样一帧就死），留着转舵退开的余地
            this.forwardSpeed *= Math.max(0, 1 - dt * Boat.BLOCKED_DRAG)
            this.blocked = true
        }
    }

    /**
     * 远端驾驶员的船：往广播目标位姿插值，最小朝向走最短弧。
     */
    interpolate(dt)
    {
        const t = this.netTarget
        const lerp = Math.min(1, dt * 12)

        this.position.x += (t.x - this.position.x) * lerp
        this.position.z += (t.z - this.position.z) * lerp

        let d = t.rotY - this.heading
        while(d > Math.PI) d -= Math.PI * 2
        while(d < -Math.PI) d += Math.PI * 2
        this.heading += d * lerp
    }

    /**
     * 由 heading + 波浪起伏算出最终 position.y / quaternion / forward 等派生量。
     */
    refreshPose(hard)
    {
        const time = this.game.ticker.elapsed

        // 确定性浮浪：同一 (x,z,t) 各端算出一致高度（空船无需广播也基本同步）
        const bob =
            Math.sin(time * 1.1 + this.position.x * 0.15 + this.position.z * 0.1) * Boat.WAVE_BOB +
            Math.sin(time * 0.7 - this.position.x * 0.08 + this.position.z * 0.13) * Boat.WAVE_BOB * 0.6

        // 原点已经烘在水线上，所以这里 y 就等于水面高度 + 浮浪；
        // 不需要再加 FLOAT_OFFSET（那会把船往上顶，看着像漂在水面上方）
        let targetY = this.game.water.surfaceElevation + bob

        /**
         * 河床钳制：水浅到吃水以下时，船就结结实实地坐在河床上，而不是把船底插进地里。
         * 浅滩、入海口、靠岸那一带都会走到这个分支——没它的话船看起来就是“入土了”。
         */
        if(this.probe?.bedHeightAt)
        {
            const bedY = this.probe.bedHeightAt(this.position.x, this.position.z)

            // 河床比“水线 + 吃水”还高 = 船是坐在滩上而不是浮在水里（搁浅）
            this.grounded = bedY + this.draft > this.game.water.surfaceElevation

            targetY = Math.max(targetY, bedY + this.draft)
        }

        if(hard)
            this.position.y = targetY
        else
            this.position.y += (targetY - this.position.y) * Math.min(1, this.game.ticker.deltaScaled * 12)

        /**
         * 倾角：横摇 / 纵摇都只由浮浪给一点点，外加一个“滑行姿态”——跑得越快越抬船头。
         * 之前两个方向各 0.03 弧度（单程 5 米的船长等于船头能上下刷 0.15 米），
         * 再叠上吃水 0.66 米，水线最狠时能漫到 0.9 米以上，直接没进上层建筑——这就是“漏水”。
         * 这里用本地轴直接搭四元数，不走欧拉角：绕本地 +X（船头方向）= 横摇，
         * 绕本地 +Z 正角 = 把船头往上抬，意思写死在轴上不会认反。
         */
        const roll = Math.sin(time * 0.9 + this.position.z * 0.12) * Boat.WAVE_TILT
        const trim = Math.min(Boat.MAX_TRIM, this.xzSpeed * Boat.TRIM_PER_SPEED)
        const pitch = Math.sin(time * 1.3 + this.position.x * 0.12) * Boat.WAVE_TILT + trim

        // yaw * roll/pitch 组合成最终朝向
        this.quaternion.setFromAxisAngle(Boat.Y_AXIS, this.heading)
        this.tiltRollQuat.setFromAxisAngle(Boat.ROLL_AXIS, roll)
        this.tiltPitchQuat.setFromAxisAngle(Boat.PITCH_AXIS, pitch)
        this.quaternion.multiply(this.tiltRollQuat).multiply(this.tiltPitchQuat)

        this.sideward.set(0, 0, 1).applyQuaternion(this.quaternion)
        this.upward.set(0, 1, 0).applyQuaternion(this.quaternion)
        this.forward.set(1, 0, 0).applyQuaternion(this.quaternion)

        // 只有 yaw 参与跟随（相机 / 地图），等价于以前每帧 new 一个 Euler 去反解 y
        this.yRotation = this.heading
    }

    // ———— 碰撞判定 ————

    /**
     * 世界平面点落在船身矩形里吗（沿船的 forward/sideward 轴投影，pad 是额外余量）。
     */
    hitsPoint(x, z, pad = 0)
    {
        const dx = x - this.position.x
        const dz = z - this.position.z

        const along = dx * this.forward.x + dz * this.forward.z
        const side = dx * this.sideward.x + dz * this.sideward.z

        return Math.abs(along) <= this.halfLength + pad && Math.abs(side) <= this.halfWidth + pad
    }

    // 被船头撞中：猛地刹停（撞击手感靠 view.roll.kick，爆炸系统自带）
    applyHit()
    {
        this.forwardSpeed = 0
    }

    // ———— 联机收发 ————

    // 驾驶员把自己的位姿打成一个极小的包
    getNetPose()
    {
        return {
            x: +this.position.x.toFixed(2),
            z: +this.position.z.toFixed(2),
            rotY: +this.heading.toFixed(3),
        }
    }

    // 收到远端驾驶员广播
    setNetPose(x, z, rotY)
    {
        this.netTarget = { x, z, rotY }
    }
}

Boat.Y_AXIS = new THREE.Vector3(0, 1, 0)
Boat.ROLL_AXIS = new THREE.Vector3(1, 0, 0)   // 船头方向：绕它转 = 横摇
Boat.PITCH_AXIS = new THREE.Vector3(0, 0, 1)  // 正角把船头往上抬
