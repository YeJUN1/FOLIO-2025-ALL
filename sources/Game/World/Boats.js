import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'
import { Boat } from './Boat.js'
import { InteractivePoints } from '../InteractivePoints.js'
import { Player } from '../Player.js'

/**
 * 船管理器：
 * - 开局在地图边缘水域随机挑 2 个彼此远离的刷新点，各放一条船
 * - 提供 isWater(x, z) / bedHeightAt(x, z) 探针（船靠它们挡岸、不刮底）
 * - 供 Player / RemotePlayers / Map / View 查询船只
 *
 * 水域数据：运行时直接读地形网格顶点算水深，64×64 的格子上存“水线 - 河床”。
 * 世界 x = (i + 0.5) / 64 * 192 - 96；z 同理。
 */
export class Boats
{
    static WORLD_SIZE = 192
    static MASK_N = 64
    static MIN_SPAWN_DIST = 90   // 两个刷新点至少要隔这么远
    static BOARD_RADIUS = 12     // 人站在这个范围内才算够得着船（与 Player.BOAT_BOARDING_DISTANCE 对齐）
    static NAV_EDGE_MARGIN = 2.5 // 离地形边界留这么点，别让船开出地图外
    static BEACH_DEPTH = 0.15    // 允许船蹭上多深的滩：河床高出水面这么多以内还算能过
    static HIT_MIN_SPEED = 2     // 船速至少多快才算"撞"
    static HIT_PAD = 0.6         // 撞击矩形比船身多出的余量
    static HIT_RADIUS = 3.5      // 撞中时的掠飞半径（复用爆炸系统）
    static HIT_COOLDOWN = 1.2    // 同一条船两次起爆之间的最短间隔，防每帧连环触发

    // 刷新点的水深门槛：船吃水约 0.66，再浅就要坐在河床上难看
    static SPAWN_MIN_DEPTH = 0.6
    static SPAWN_DEPTH_RING = 2  // 刷新点周围 (2×2+1)² 格都得够深，别贴着浅滩摆
    static SPAWN_SHORE_REACH = 3 // 但也不能离岸太远：玩家站在滩上要能够得着 REFRESH

    // REFRESH 点的触发圈。默认 2.5 米在这儿不管用：刷新点被要求“周围 5×5 格都够深”，
    // 一格 192/64 = 3 米，于是它天生就在离岸好几米的水里，人站岸上永远跨不进那个 2.5 米的圈，
    // 按钮不算“够得着”，按下去什么也不会发生（这就是之前 REFRESH 点了没反应的原因之一）。
    static POINT_RADIUS_REFRESH = 9   // 放大到 9 米，站滩上就能够到

    constructor()
    {
        this.game = Game.getInstance()

        // 水深数据（必须在 floor 之后：它直接吃 floor 的地形顶点）
        this.setWaterData()

        // 挑两个彼此远离的边缘水点
        const spawns = this.pickSpawns()

        this.list = []
        for(let i = 0; i < 2; i++)
        {
            const spawn = spawns[i] ?? Boats.FALLBACK_SPAWNS[i]
            const boat = new Boat(i, spawn, {
                isWater: (x, z) => this.isWater(x, z),
                canSail: (x, z) => this.canSail(x, z),
                depthAt: (x, z) => this.depthAt(x, z),
                bedHeightAt: (x, z) => this.bedHeightAt(x, z),
            })
            this.list.push(boat)
        }

        // 供外部（RemotePlayers / Map）遍历
        this.byId = {}
        for(const boat of this.list)
            this.byId[boat.id] = boat

        this.setPoints()

        this.tickCallback = () =>
        {
            this.update()
        }
        this.game.ticker.events.on('tick', this.tickCallback, 7)
    }

    /**
     * 水深数据：读地形网格的顶点高度（game.world.floor.geometry，跟 Floor.setPhysical 用同一套
     * 顶点排布），双线性采样后烘成 64×64 的“水深”网格：depth = 水线高度 - 河床高度，>0 就是水。
     *
     * 这里原来是一张离线用 terrain.png 烘出来的 base64 掩码，那张图是错的：
     * 掩码说有 2817 格水，实测其中 2704 格河床在水线以上（纯陆地）；真正有水的 1392 格里
     * 又漏掉 1279 格。于是 pickSpawns 一个候选都挑不出来，永远走兜底点，而兜底点
     * (37.5,-79.5) / (-37.5,79.5) 的河床高是 0.00 / -0.30 —— 干脆在旱地上，
     * 这就是“船入土了”的真凶。顺带那条 base64 还短了 6 个字节（4090/4096），末尾 24 格不存在。
     * 改成运行时按真地形算，视觉、物理碰撞和水面三方永远是同一套数据。
     */
    setWaterData()
    {
        const n = Boats.MASK_N
        this.depth = new Float32Array(n * n)
        this.bed = null

        const position = this.game.world?.floor?.geometry?.attributes?.position

        if(position)
        {
            const count = position.count
            const rows = Math.round(Math.sqrt(count))

            // 顶点必须正好是 rows×rows 的规则网格才能这样摊平（地形是 PlaneGeometry 细分出来的）
            if(rows * rows === count)
            {
                const heights = new Float32Array(count)
                const array = position.array

                for(let i = 0; i < count; i++)
                {
                    const ix = Math.round((array[i * 3] / Boats.WORLD_SIZE + 0.5) * (rows - 1))
                    const iz = Math.round((array[i * 3 + 2] / Boats.WORLD_SIZE + 0.5) * (rows - 1))

                    heights[iz * rows + ix] = array[i * 3 + 1]
                }

                this.bed = { heights, rows }
            }
        }

        for(let j = 0; j < n; j++)
            for(let i = 0; i < n; i++)
            {
                const p = this.cellToWorld(i, j)
                this.depth[j * n + i] = this.depthAt(p.x, p.z)
            }
    }

    // 河床高度：双线性插值，别用最近顶点，否则船开过去会一阶一阶地跳
    bedHeightAt(x, z)
    {
        if(!this.bed)
            return 0

        const heights = this.bed.heights
        const rows = this.bed.rows

        const gx = (x / Boats.WORLD_SIZE + 0.5) * (rows - 1)
        const gz = (z / Boats.WORLD_SIZE + 0.5) * (rows - 1)

        const ix = Math.min(rows - 2, Math.max(0, Math.floor(gx)))
        const iz = Math.min(rows - 2, Math.max(0, Math.floor(gz)))
        const fx = Math.min(1, Math.max(0, gx - ix))
        const fz = Math.min(1, Math.max(0, gz - iz))

        const h00 = heights[iz * rows + ix]
        const h10 = heights[iz * rows + ix + 1]
        const h01 = heights[(iz + 1) * rows + ix]
        const h11 = heights[(iz + 1) * rows + ix + 1]

        return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz
    }

    // 水深（水线 - 河床）：负数就是陆地
    depthAt(x, z)
    {
        return this.game.water.surfaceElevation - this.bedHeightAt(x, z)
    }

    // 世界坐标这里是不是水（超出地形边界一律算陆地，免得船开出地图）
    isWater(x, z)
    {
        const limit = Boats.WORLD_SIZE / 2 - Boats.NAV_EDGE_MARGIN

        if(Math.abs(x) > limit || Math.abs(z) > limit)
            return false

        return this.depthAt(x, z) > 0
    }

    /**
     * 船能不能开到 (x, z)：水面自由航行，再加一小段“滩”——河床高出水面不超 BEACH_DEPTH 也算能过。
     *
     * 为什么不直接拿 isWater 当墙：这张图整体只有 1.5 米落差，水面以下很平，
     * 按 isWater 硬挡，船中心一碰到水陆分界就停（船头已经插进滩里 5 米），
     * 离玩家看得见的那片沙滩还差着几米，看起来就是撞了隐形墙；
     * 加上“低速就没舵”，船就再也摆不出来——这就是“船离岸边一定距离就开不动了”。
     * 数据实测：BEACH_DEPTH = 0.15 米只多开放 167 格（每格 3 米）的环岸浅滩，
     * 而全图高地（平放在水面以上 0.3 米）依旧进不去，船不会顺着这条缝开遍全图。
     */
    canSail(x, z)
    {
        const limit = Boats.WORLD_SIZE / 2 - Boats.NAV_EDGE_MARGIN

        if(Math.abs(x) > limit || Math.abs(z) > limit)
            return false

        return this.depthAt(x, z) > -Boats.BEACH_DEPTH
    }

    /**
     * 离 (x, z) 最近的岸：在水深网格里一圈圈往外找第一块陆地（水深 <= 0），
     * 拿到一个能站人的落脚位（河床面 + 1 米，交给重力自己落下去）。
     *
     * 下船要靠它：这张图的水最深才 1.2 米，角色又没有游泳动画，直接扔在水里
     * 就会一直往下沉（实测 2 秒后停在 y=-1.45，人整个浸在水面下），看着就站在水底。
     * 所以下船 = 把人放到最近的一片滩上。
     * 真找不到岸（理论上不会）就返回 null，调用方退回“原地扔下”。
     */
    getShoreDrop(x, z, maxRings = 12)
    {
        const n = Boats.MASK_N
        const cell = Boats.WORLD_SIZE / n

        const ci = Math.min(n - 1, Math.max(0, Math.floor((x + Boats.WORLD_SIZE / 2) / cell)))
        const cj = Math.min(n - 1, Math.max(0, Math.floor((z + Boats.WORLD_SIZE / 2) / cell)))

        let best = null
        let bestDist = Infinity

        for(let r = 1; r <= maxRings; r++)
        {
            for(let dj = -r; dj <= r; dj++)
                for(let di = -r; di <= r; di++)
                {
                    // 只查这一圈的外框，内圈上一轮已经查过
                    if(Math.max(Math.abs(di), Math.abs(dj)) !== r)
                        continue

                    const ni = ci + di, nj = cj + dj
                    if(ni < 0 || ni >= n || nj < 0 || nj >= n)
                        continue

                    if(this.depth[nj * n + ni] > 0)
                        continue

                    const p = this.cellToWorld(ni, nj)
                    const d = Math.hypot(p.x - x, p.z - z)

                    if(d < bestDist)
                    {
                        bestDist = d
                        best = p
                    }
                }

            // 这一圈里已经找到岸就够了，别再往外找
            if(best)
                break
        }

        if(!best)
            return null

        return new THREE.Vector3(best.x, this.bedHeightAt(best.x, best.z) + 1, best.z)
    }

    cellToWorld(i, j)
    {
        const x = (i + 0.5) / Boats.MASK_N * Boats.WORLD_SIZE - Boats.WORLD_SIZE / 2
        const z = (j + 0.5) / Boats.MASK_N * Boats.WORLD_SIZE - Boats.WORLD_SIZE / 2
        return new THREE.Vector3(x, 0, z)
    }

    /**
     * 这一格适合当船的刷新点吗：
     * - 周围 (2r+1)² 格都要够深 => 船摆下去不刮底，也有的开
     * - 又得离最近的水线不超过 SPAWN_SHORE_REACH 格 => 玩家站在滩上才能够得着旁边的 REFRESH
     */
    isSpawnCell(i, j)
    {
        const n = Boats.MASK_N
        const ring = Boats.SPAWN_DEPTH_RING

        for(let dj = -ring; dj <= ring; dj++)
            for(let di = -ring; di <= ring; di++)
            {
                const ni = i + di, nj = j + dj
                if(ni < 0 || ni >= n || nj < 0 || nj >= n)
                    return false
                if(this.depth[nj * n + ni] < Boats.SPAWN_MIN_DEPTH)
                    return false
            }

        return this.shoreDistanceCells(i, j) <= Boats.SPAWN_SHORE_REACH
    }

    // 到最近一块陆地（水深 <= 0）的格距（切比雪夫），找不到就 99
    shoreDistanceCells(i, j)
    {
        const n = Boats.MASK_N
        const max = Boats.SPAWN_SHORE_REACH + 1

        for(let r = 1; r <= max; r++)
            for(let dj = -r; dj <= r; dj++)
                for(let di = -r; di <= r; di++)
                {
                    // 只看这一圈的外框，内圈上一轮已经查过了
                    if(Math.max(Math.abs(di), Math.abs(dj)) !== r)
                        continue

                    const ni = i + di, nj = j + dj
                    if(ni < 0 || ni >= n || nj < 0 || nj >= n)
                        continue

                    if(this.depth[nj * n + ni] <= 0)
                        return r
                }

        return 99
    }

    // 收集合格刷新点 -> 随机打乱 -> 挑两个彼此最远的
    pickSpawns()
    {
        const n = Boats.MASK_N
        const candidates = []

        for(let j = 0; j < n; j++)
            for(let i = 0; i < n; i++)
            {
                if(!this.isSpawnCell(i, j))
                    continue

                const p = this.cellToWorld(i, j)

                // 太靠中心（湖心有岛/建筑）
                if(Math.hypot(p.x, p.z) < 30)
                    continue

                candidates.push(p)
            }

        // 洗牌，让每次开局刷新位置不同
        for(let i = candidates.length - 1; i > 0; i--)
        {
            const k = Math.floor(Math.random() * (i + 1))
            ;[candidates[i], candidates[k]] = [candidates[k], candidates[i]]
        }

        if(candidates.length < 2)
            return Boats.FALLBACK_SPAWNS.map((p) => p.clone())

        // 以第一个候选为锚，找离它最远的作为第二个；若仍不够远就全对扫描取最远
        let best = null
        let bestDist = -1

        for(let a = 0; a < candidates.length; a++)
            for(let b = a + 1; b < candidates.length; b++)
            {
                const d = candidates[a].distanceTo(candidates[b])
                if(d > bestDist)
                {
                    bestDist = d
                    best = [candidates[a], candidates[b]]
                }
            }

        if(!best || bestDist < Boats.MIN_SPAWN_DIST)
            return Boats.FALLBACK_SPAWNS.map((p) => p.clone())

        return best
    }

    // ———— 查询 ————

    // 距离某个世界点最近、且在 radius 内的船（上船检测用）
    getBoatNear(position, radius = Boats.BOARD_RADIUS)
    {
        let best = null
        let bestDist = radius

        for(const boat of this.list)
        {
            const d = Math.hypot(boat.position.x - position.x, boat.position.z - position.z)
            if(d <= bestDist)
            {
                bestDist = d
                best = boat
            }
        }

        return best
    }

    getEmptyBoatNear(position, radius = Boats.BOARD_RADIUS)
    {
        const boat = this.getBoatNear(position, radius)
        return boat && !boat.driverId ? boat : null
    }

    getBoatById(id)
    {
        return this.byId[id] ?? null
    }

    // ———— 驾驶员 ————

    // 本地玩家上船：本船由我模拟，其余船的本机模拟关掉
    localBoard(boat, myId)
    {
        for(const other of this.list)
            other.localDriven = false

        boat.localDriven = true
        boat.driverId = myId ?? 'local'
    }

    // 本地玩家下船
    localLeave(boat)
    {
        boat.localDriven = false
        boat.driverId = null
        boat.netTarget = null
    }

    // 把某条船复位到它的刷新点（R / REFRESH 都用它）
    resetBoat(boat)
    {
        boat.moveTo(boat.spawnPoint, boat.spawnRotation)
    }

    // ———— 联机收发（RemotePlayers 调用） ————

    // 收到远端驾驶员广播的位姿
    onNetPose(boatId, driverId, pose)
    {
        const boat = this.getBoatById(boatId)
        if(!boat || boat.localDriven)
            return

        boat.driverId = driverId
        boat.setNetPose(pose.x, pose.z, pose.rotY)
    }

    // 服务器说这条船空了：清掉本地对远端驾驶员的记忆
    onNetEmpty(boatId)
    {
        const boat = this.getBoatById(boatId)
        if(!boat || boat.localDriven)
            return

        boat.driverId = null
        boat.netTarget = null
    }

    /**
     * welcome 里带下来的服务器权威船只状态：
     * 用服务器的刷新点覆盖本地随机选的（保证各端一致）、对齐驾驶员与当前位姿。
     * 本机正在模拟的船不被踩掉。
     */
    applyServerBoat(state)
    {
        if(!state)
            return

        const boat = this.getBoatById(state.id)
        if(!boat)
            return

        // 服务器统一给的刷新点：覆盖本地随机结果，并把 REFRESH 点也搬过去
        if(state.spawn)
        {
            boat.spawnPoint.set(state.spawn.x, 0, state.spawn.z)
            boat.spawnRotation = state.spawn.rot ?? 0

            const refreshEntry = this.points?.find((e) => e.kind === 'refresh' && e.boat === boat)

            if(refreshEntry)
                this.game.interactivePoints.moveItem(
                    refreshEntry.item,
                    boat.spawnPoint.x, boat.spawnPoint.y + 1.5, boat.spawnPoint.z
                )
        }

        // 我正在开着这条船：别让服务器快照把本地模拟打断
        if(boat.localDriven)
            return

        const myId = this.game.player?.getMyId()

        // 驾驶员：只记别人的，我自己的上船流程交给 onBoatState 回执
        boat.driverId = state.driver && state.driver !== myId ? state.driver : null

        // 当前位姿：瞬移到服务器记下的位置（初次对齐）
        if(state.pose)
            boat.moveTo({ x: state.pose.x, z: state.pose.z }, state.pose.rotY ?? boat.heading)
        else
            boat.moveTo(boat.spawnPoint, boat.spawnRotation)
    }

    /**
     * 服务器对“谁在驾驶”的权威裁决广播（上船/下船/被抢都会发）。
     */
    onBoatState(data)
    {
        if(!data)
            return

        const boat = this.getBoatById(data.boatId)
        if(!boat)
            return

        const myId = this.game.player?.getMyId()
        const driver = data.driver ?? null

        if(driver && driver === myId)
        {
            // 确认我就是司机：已乐观坐上→回执确认；还没坐上→补上（安全网）
            if(boat.localDriven)
                this.game.player?.onBoatConfirmed(boat.id)
            else
                this.game.player?.boardBoatLocal(boat)
        }
        else if(driver)
        {
            // 别人在开：记下司机；若我本机正在模拟则被请下船
            boat.driverId = driver

            if(boat.localDriven)
                this.game.player?.forceOffBoat(boat, false)
        }
        else
        {
            // 空了：清掉本地对远端驾驶员的记忆
            if(!boat.localDriven)
            {
                boat.driverId = null
                boat.netTarget = null
            }
        }
    }

    /**
     * 服务器广播“某条空船已召回刷新点”（REFRESH 按钮触发）。
     * 非本机模拟的船只管瞬移过去；本机模拟的（我自己刚按）已在 requestReset 乐观做过。
     */
    onNetReset(data)
    {
        if(!data)
            return

        const boat = this.getBoatById(data.boatId)
        if(!boat || boat.localDriven)
            return

        const x = data.x ?? boat.spawnPoint.x
        const z = data.z ?? boat.spawnPoint.z
        boat.moveTo({ x, z }, data.rotY ?? boat.spawnRotation)

        boat.driverId = null
        boat.netTarget = null
    }

    /**
     * 召回一条空船（REFRESH 按钮）：本地乐观瞬移回刷新点；在线则请服务器裁决并广播。
     * 不管成没成都给个提示：之前按下去静悄悄，没人知道到底是触发了还是没触发。
     */
    requestReset(boat)
    {
        if(!boat)
            return

        if(boat.driverId)
        {
            this.notify('Boat is in use', 'boat-reset')
            return
        }

        this.resetBoat(boat)
        this.notify('Boat recalled to its spawn', 'boat-reset')

        if(this.game.player?.getMyId())
            this.game.remotePlayers?.sendBoatReset(boat.id)
    }

    // 右上角弹一句短提示（复用通知系统；带 id 防连点刷屏）
    notify(text, id)
    {
        const notifications = this.game.notifications

        if(!notifications)
            return

        notifications.show(
            /* html */`
                <div class="top">
                    <div class="title">${text}</div>
                </div>
            `,
            id,
            2.5,
            null,
            id
        )
    }

    // 驾驶员每帧（限频）把自己的位姿广播出去
    update()
    {
        this.updatePoints()

        // 碰撞由驾驶仓那条船的本机判定（驾驶员才是权威，和"谁模拟船"同一套规矩）
        for(const boat of this.list)
            if(boat.localDriven)
                this.checkHits(boat)

        const now = this.game.ticker.elapsed
        const remotePlayers = this.game.remotePlayers
        const myId = this.game.player?.getMyId()

        if(!myId || !remotePlayers)
            return

        // 约 25Hz
        if(this.nextBroadcastAt && now < this.nextBroadcastAt)
            return
        this.nextBroadcastAt = now + 0.04

        for(const boat of this.list)
            if(boat.localDriven)
                remotePlayers.sendBoatPose(boat.id, boat.getNetPose())
    }

    /**
     * 船头撞判定：把船身当一块矩形（hitsPoint），谁落在里面就算撞。
     * 顺序：本地走路的人 → 联机走路的人 → 另一条船 → 动态物体（箱子/家具/车）。
     * 撞中复用现成爆炸系统掠飞 + 镜头震颤，船急停，并把起爆点广播给其他人。
     */
    checkHits(boat)
    {
        // 得是"开过去"才算撞，慢慢蹭的不算
        const speed = Math.abs(boat.forwardSpeed)

        if(speed < Boats.HIT_MIN_SPEED)
            return

        const now = this.game.ticker.elapsed

        if(boat.nextHitAt && now < boat.nextHitAt)
            return

        const pad = Boats.HIT_PAD
        let hit = false

        // 1) 本地下车走路的人（自己开船时 character 处于 deactivate，撞不到自己）
        const character = this.game.character

        if(character && character.active && boat.hitsPoint(character.position.x, character.position.z, pad))
            hit = true

        // 2) 联机里下车走路的人
        if(!hit && this.game.remotePlayers?.remotes)
        {
            for(const remote of this.game.remotePlayers.remotes.values())
            {
                if(!remote.personWanted || !remote.character)
                    continue

                const p = remote.character.mesh.position

                if(boat.hitsPoint(p.x, p.z, pad))
                {
                    hit = true
                    break
                }
            }
        }

        // 3) 船撞船：两船互撞时各自驾驶员本机都能判到，不需要额外广播谁停
        if(!hit)
        {
            for(const other of this.list)
            {
                if(other === boat)
                    continue

                if(boat.hitsPoint(other.position.x, other.position.z, pad))
                {
                    hit = true
                    break
                }
            }
        }

        // 4) 动态物体（爆炸箱/家具/车——谁被扔进水里都能撞上）
        if(!hit)
        {
            // game.objects.list 是个 Map（key -> object），直接 for..of 拿到的是 [key, value] 数组
            for(const object of this.game.objects.list.values())
            {
                const physical = object.physical

                if(!physical || physical.type !== 'dynamic' || !physical.body.isEnabled())
                    continue

                const t = physical.body.translation()

                if(boat.hitsPoint(t.x, t.z, pad))
                {
                    hit = true
                    break
                }
            }
        }

        if(!hit)
            return

        boat.nextHitAt = now + Boats.HIT_COOLDOWN

        // 撞得越狠掠得越高；复用爆炸：范围内人/箱子/玩家的车都会被掀飞
        const strength = Math.min(5, Math.max(2, speed * 0.35))
        this.game.explosions.explode(boat.position, Boats.HIT_RADIUS, strength)

        boat.applyHit()

        // 联机：告诉其他人同一个点也来一发（各自端的各自人和物才会被掀）
        if(this.game.player?.getMyId())
            this.game.remotePlayers?.sendBoatHit(boat.id, boat.position, strength)
    }

    /**
     * 别人的船撞了东西：本地同点起爆，自己这边的人和物也会被掀飞。
     * 谁在驾驶谁判定、谁挨炸自己本地掀，和车撞人同一套规矩。
     */
    onNetHit(data)
    {
        if(!data)
            return

        const position = new THREE.Vector3(data.x || 0, data.y || 0, data.z || 0)

        this.game.explosions.explode(position, Boats.HIT_RADIUS, data.s || 3)
    }

    /**
     * 只在每个刷新点放一个 REFRESH 召回点。
     * 上船不再走交互点：船就浮在水上，人走到旁边按 G（Player.getInVehicle 把车和船放一起比谁近）。
     * 之前每条船还挂着一个“Board”点，跟场景里那一推 E/回车互动点抢焦点，而且它老因为
     * 触发半径不够而根本上不去——用户明确说了不要 Board 按钮，就留一个 REFRESH。
     * 用 STATE_OPEN 创建，交给 intro 结束时的 recover() 统一亮起来（与“Start race!”一致）。
     */
    setPoints()
    {
        this.points = []

        const points = this.game.interactivePoints

        for(const boat of this.list)
        {
            const refresh = points.create(
                boat.spawnPoint.clone().setY(boat.spawnPoint.y + 1.5),
                'REFRESH',
                InteractivePoints.ALIGN_LEFT,
                InteractivePoints.STATE_OPEN,
                () =>
                {
                    // 只有空船才能召回（有人开时该点本来就是隐藏的），走带联网的召回
                    this.requestReset(boat)
                }
            )
            refresh.triggerRadius = Boats.POINT_RADIUS_REFRESH
            // 显隐完全交给 updatePoints 这个状态机，创建时不要偷着把它标成“已显示”：
            // 那样第一帧就会直接 hide()，把 recover() 刚给它的状态抹掉
            refresh.isShown = false
            this.points.push({ kind: 'refresh', boat, item: refresh })
        }
    }

    // 每帧：空船就亮出刷新点旁的 REFRESH（船被人开着就藏起来）
    updatePoints()
    {
        const points = this.game.interactivePoints
        const player = this.game.player

        if(!points || !player)
            return

        const playable = player.state === Player.STATE_DEFAULT

        for(const entry of this.points)
        {
            const boat = entry.boat
            const item = entry.item

            // 不再要求“船已经开离开过”：船卡住、搁浅、被人丢在海对岸的时候，
            // 玩家需要的恰恰是“在出生点旁直接把它拉回来”
            const visible = playable && !boat.driverId

            if(visible && !item.isShown)
            {
                item.isShown = true
                item.show()
            }
            else if(!visible && item.isShown)
            {
                item.isShown = false
                item.hide()
            }
        }
    }

    destroy()
    {
        this.game.ticker.events.off('tick', this.tickCallback)
        for(const boat of this.list)
            boat.destroy()
    }
}

// 兜底刷新点：按真地形顶点量出来的两个深水点（水深≈1.2，离岸 9 米，相隔约 197）
// 只在“一格合格候选都没”时才会读到（地形正常时不会）
Boats.FALLBACK_SPAWNS = [
    new THREE.Vector3(85.5, 0, -82.5),
    new THREE.Vector3(-13.5, 0, 88.5),
]

