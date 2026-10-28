import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

export class TrackPath
{
    constructor()
    {
        this.game = Game.getInstance()

        // === 地块禁区（轨道不能穿进这些围栏）===
        // PlotFence 木栅栏: x∈[-6.5, 46.5], z∈[-73.3, -40.3]
        // PandoraFence 竹子围栏: x∈[16, 86], z∈[-37, 27.4]
        // TerritoryFence 石围栏: 左下不规则，近似 x∈[-85, -30], z∈[-20, 25]
        this.forbiddenZones = [
            { minX: -6.5, maxX: 46.5, minZ: -73.3, maxZ: -40.3, margin: 4 },  // PlotFence
            { minX: 16,   maxX: 86,   minZ: -37,   maxZ: 27.4,  margin: 4 },  // PandoraFence
            { minX: -85,  maxX: -30,  minZ: -20,   maxZ: 25,    margin: 3 },  // TerritoryFence（近似）
        ]

        // === 轨道控制点 —— 严格沿岛屿陆地海岸线走 ===
        // 岛屿陆地大致椭圆：x ∈ [-90, 120], z ∈ [-95, 92]
        // 用椭圆参数化：长边 a=105, 短边 b=93, 稍向内收缩确保 100% 在陆地上
        // 角度从 0°(东) 顺时针绕一圈 → 21 个点
        const rawPoints = []
        const a = 95        // 椭圆 x 半径（内缩 10m）
        const b = 88        // 椭圆 z 半径（内缩 5m）
        const cx = 12       // 椭圆中心（岛中心偏东 12m）
        const cz = -3       // 椭圆中心（岛中心偏北 3m）
        const N = 21
        for(let i = 0; i < N; i++)
        {
            // theta=0 在 x+ 方向，顺时针绕（-z 方向为正角度增长）
            const theta = (i / N) * Math.PI * 2
            const x = cx + Math.cos(theta) * a
            const z = cz + Math.sin(theta) * b * 0.95  // z 稍扁
            rawPoints.push(new THREE.Vector3(x, 0, z))
        }

        // === 避开禁区 + 射线贴地（没射中陆地就向内收缩）===
        this.sanitizePoints(rawPoints)
        this.setGroundHeight(rawPoints)

        // 构建闭合 CatmullRom 曲线
        this.curve = new THREE.CatmullRomCurve3(rawPoints, true, 'catmullrom', 0.5)

        // 生成密集采样点用于渲染
        this.samples = this.curve.getPoints(400)
        this.totalLength = this.curve.getLength()

        this.setVisual()
    }

    /**
     * 把落到禁区内的控制点向外推，同时射线贴地（避开水域则继续外推）
     */
    sanitizePoints(points)
    {
        for(const p of points)
        {
            for(const zone of this.forbiddenZones)
            {
                const m = zone.margin
                if(p.x > zone.minX - m && p.x < zone.maxX + m &&
                   p.z > zone.minZ - m && p.z < zone.maxZ + m)
                {
                    // 落在禁区里，向外推到禁区外 + margin
                    const cx = (zone.minX + zone.maxX) * 0.5
                    const cz = (zone.minZ + zone.maxZ) * 0.5
                    const dx = p.x - cx
                    const dz = p.z - cz
                    const len = Math.hypot(dx, dz) || 1

                    // 把点推到"远离中心 + 超出边界 + margin"的位置
                    const targetX = cx + (dx / len) * ((zone.maxX - zone.minX) * 0.5 + m + 3)
                    const targetZ = cz + (dz / len) * ((zone.maxZ - zone.minZ) * 0.5 + m + 3)

                    // 钳制到大致岛屿范围
                    p.x = THREE.MathUtils.clamp(targetX, -100, 135)
                    p.z = THREE.MathUtils.clamp(targetZ, -105, 100)
                }
            }
        }
    }

    /**
     * 射线贴地 —— 没击中地形（水域）就从原位置向椭圆中心逐步收缩，直到射中陆地
     */
    setGroundHeight(points)
    {
        const terrainMesh = this.game.resources.terrainModel.scene.children[0]
        const raycaster = new THREE.Raycaster()
        raycaster.far = 200

        // 椭圆中心（与控制点相同）
        const cx = 12, cz = -3

        for(const p of points)
        {
            // 从原位置开始，最多收缩 8 次，每次向中心推 10%
            let hit = null
            let px = p.x, pz = p.z
            for(let attempt = 0; attempt < 10; attempt++)
            {
                const origin = new THREE.Vector3(px, 100, pz)
                raycaster.set(origin, new THREE.Vector3(0, -1, 0))

                const hits = raycaster.intersectObject(terrainMesh, false)
                if(hits.length > 0 && hits[0].point.y > -1.5)  // 真正的陆地，不是海底
                {
                    hit = hits[0].point.y
                    break
                }

                // 没射中 → 向椭圆中心收缩
                const dx = cx - px, dz = cz - pz
                const len = Math.hypot(dx, dz) || 1
                px += (dx / len) * 3
                pz += (dz / len) * 3
            }

            p.x = px
            p.z = pz
            p.y = hit !== null ? hit : 0.5   // 实在没中，保底 0.5m（岛上最低点）
        }
    }

    setVisual()
    {
        const group = new THREE.Group()
        group.name = 'TrackPath'
        this.game.scene.add(group)
        this.group = group

        // 可视化：曲线线框（调试用）
        const curveGeo = new THREE.BufferGeometry().setFromPoints(this.samples)
        const curveMat = new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.7 })
        const curveLine = new THREE.Line(curveGeo, curveMat)
        curveLine.name = 'pathLine'
        curveLine.visible = false
        group.add(curveLine)
        this.curveLine = curveLine

        // 铁轨
        this.setRails()

        // Debug 开关
        if(this.game.debug.active)
        {
            const panel = this.game.debug.panel.addFolder({ title: '🛤️ Track Path', expanded: true })
            panel.addBinding(curveLine, 'visible', { label: 'showPathLine' })
            panel.addBlade({ view: 'separator' })
            panel.addButton({ title: 'teleportToTrack(t=0)' }).on('click', () =>
            {
                const p = this.curve.getPointAt(0); p.y = 5
                this.game.player.respawn(null, () => { this.game.physicalVehicle.moveTo(p, 0) })
            })
        }
    }

    setRails()
    {
        const railGap = 1.435
        const railHeight = 0.08
        const sleeperSpacing = 1.4
        const sleepers = []

        const stepCount = Math.floor(this.totalLength / sleeperSpacing)
        for(let i = 0; i < stepCount; i++)
        {
            const t = i / stepCount
            const p = this.curve.getPointAt(t)
            const tangent = this.curve.getTangentAt(t).normalize()
            const up = new THREE.Vector3(0, 1, 0)
            const side = new THREE.Vector3().crossVectors(tangent, up).normalize()
            sleepers.push({ p, tangent, side })
        }

        // 枕木（深色防腐木）
        const sleeperGeo = new THREE.BoxGeometry(railGap + 0.35, 0.09, 0.18)
        const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x3a2515, roughness: 0.95, metalness: 0.0 })

        const sleeperMesh = new THREE.InstancedMesh(sleeperGeo, sleeperMat, sleepers.length)
        sleeperMesh.castShadow = false
        sleeperMesh.receiveShadow = true

        const dummy = new THREE.Object3D()
        for(let i = 0; i < sleepers.length; i++)
        {
            const { p, side } = sleepers[i]
            dummy.position.set(p.x, p.y + 0.045, p.z)
            dummy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(side.x, side.z))
            dummy.updateMatrix()
            sleeperMesh.setMatrixAt(i, dummy.matrix)
        }
        sleeperMesh.instanceMatrix.needsUpdate = true
        this.group.add(sleeperMesh)

        // 两条钢轨（金属光泽）
        const railMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.85, roughness: 0.2 })

        const samplesCount = 500
        const leftOffsets = [], rightOffsets = []
        for(let i = 0; i < samplesCount; i++)
        {
            const t = i / samplesCount
            const p = this.curve.getPointAt(t)
            const tangent = this.curve.getTangentAt(t).normalize()
            const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize()
            const off = railGap * 0.5
            leftOffsets.push(new THREE.Vector3(p.x + side.x * off, p.y + railHeight, p.z + side.z * off))
            rightOffsets.push(new THREE.Vector3(p.x - side.x * off, p.y + railHeight, p.z - side.z * off))
        }

        const leftTube = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(leftOffsets, true, 'catmullrom', 0.5), 300, 0.045, 8, true),
            railMat
        )
        const rightTube = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rightOffsets, true, 'catmullrom', 0.5), 300, 0.045, 8, true),
            railMat
        )
        leftTube.castShadow = true; leftTube.receiveShadow = true
        rightTube.castShadow = true; rightTube.receiveShadow = true
        this.group.add(leftTube, rightTube)
    }

    getPoseAt(t)
    {
        const position = this.curve.getPointAt(t).clone()
        const tangent = this.curve.getTangentAt(t).clone().normalize()
        return { position, tangent }
    }

    advance(t, distance)
    {
        const deltaT = distance / this.totalLength
        let newT = (t + deltaT) % 1
        if(newT < 0) newT += 1
        return newT
    }

    /**
     * 在给定矩形 [minX, maxX] × [minZ, maxZ] 范围内，找到轨道经过的所有连通 t 区间
     * 返回 [{ t0, t1 }] —— 注意 t0/t1 可能跨 0/1 边界，调用方需自行处理
     */
    findTIntervalsInRect(minX, maxX, minZ, maxZ, gapPad = 0)
    {
        const N = 2000  // 高密度采样
        const inside = new Array(N)
        for(let i = 0; i < N; i++)
        {
            const t = i / N
            const p = this.curve.getPointAt(t)
            inside[i] = p.x >= minX - gapPad && p.x <= maxX + gapPad &&
                        p.z >= minZ - gapPad && p.z <= maxZ + gapPad
        }
        // 提取连续段
        const intervals = []
        let start = -1
        for(let i = 0; i < N; i++)
        {
            if(inside[i] && start === -1) start = i
            else if(!inside[i] && start !== -1)
            {
                intervals.push({ t0: start / N, t1: i / N })
                start = -1
            }
        }
        if(start !== -1) intervals.push({ t0: start / N, t1: 1 })
        return intervals
    }

    /**
     * 判定某点 (x, z) 是否离轨道在 gapRadius 以内
     * 用于围栏跳过 —— 点在轨道旁就跳过那段栅栏
     */
    isNearTrack(x, z, gapRadius = 2.5)
    {
        // 粗粒度采样找最近点
        const N = 300
        let bestDist = Infinity
        for(let i = 0; i < N; i++)
        {
            const p = this.curve.getPointAt(i / N)
            const dx = p.x - x, dz = p.z - z
            const d = dx * dx + dz * dz
            if(d < bestDist) bestDist = d
        }
        return Math.sqrt(bestDist) < gapRadius
    }
}
