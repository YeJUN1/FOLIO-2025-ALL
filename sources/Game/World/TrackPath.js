import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

export class TrackPath
{
    constructor()
    {
        this.game = Game.getInstance()

        // === 轨道控制点（绕小岛一圈，顺时针，避开已有地盘）===
        // 粗略围成一圈，CatmullRomCurve3 会平滑插值
        // PlotFence 木栅栏: x∈[-6.5, 46.5], z∈[-73.3, -40.3]（右下偏）
        // PandoraFence 竹子围栏: x∈[16, 86], z∈[-37, 27.4]（中下，横贯）
        // TerritoryFence 石围栏: 左下不规则
        // 轨道沿着岛的边缘走，避开中间和中下的地盘
        const rawPoints = [
            // 下方（PlotFence 以南，走 PlotFence 和岛南边之间）
            new THREE.Vector3(-15, 0, -90),
            new THREE.Vector3(15, 0, -95),
            new THREE.Vector3(50, 0, -90),
            // 右下 → 右上（PlotFence 以东，PandoraFence 东南）
            new THREE.Vector3(85, 0, -75),
            new THREE.Vector3(110, 0, -50),
            new THREE.Vector3(120, 0, -15),
            new THREE.Vector3(118, 0, 20),
            // 右上 → 左上（PandoraFence 以北）
            new THREE.Vector3(105, 0, 50),
            new THREE.Vector3(80, 0, 75),
            new THREE.Vector3(50, 0, 90),
            new THREE.Vector3(15, 0, 92),
            // 左上 → 左下（TerritoryFence 以北和以西）
            new THREE.Vector3(-20, 0, 88),
            new THREE.Vector3(-50, 0, 75),
            new THREE.Vector3(-75, 0, 50),
            new THREE.Vector3(-85, 0, 15),
            new THREE.Vector3(-85, 0, -20),
            new THREE.Vector3(-80, 0, -50),
            new THREE.Vector3(-60, 0, -75),
            // 连接回起点
        ]

        // 构建闭合 CatmullRom 曲线
        this.curve = new THREE.CatmullRomCurve3(rawPoints, true, 'catmullrom', 0.5)

        // 生成密集采样点用于渲染和测量
        this.samples = this.curve.getPoints(400)
        this.totalLength = this.curve.getLength()

        this.setVisual()
    }

    setVisual()
    {
        const group = new THREE.Group()
        group.name = 'TrackPath'
        this.game.scene.add(group)
        this.group = group

        // 可视化：曲线线框（调试用）
        const curveGeo = new THREE.BufferGeometry().setFromPoints(this.samples)
        const curveMat = new THREE.LineBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.5 })
        const curveLine = new THREE.Line(curveGeo, curveMat)
        curveLine.name = 'pathLine'
        curveLine.visible = false // 默认隐藏，debug 开关
        group.add(curveLine)
        this.curveLine = curveLine

        // 铁轨：两条平行的细长 Box 沿路径铺设
        this.setRails()

        // Debug 开关
        if(this.game.debug.active)
        {
            const panel = this.game.debug.panel.addFolder({ title: '🛤️ Track Path', expanded: true })
            panel.addBinding(curveLine, 'visible', { label: 'showPathLine' })
            panel.addBlade({ view: 'separator' })
            panel.addButton({ title: 'teleportToTrack' }).on('click', () =>
            {
                const p = this.curve.getPointAt(0)
                p.y = 5
                this.game.player.respawn(null, () =>
                {
                    this.game.physicalVehicle.moveTo(p, 0)
                })
            })
        }
    }

    setRails()
    {
        // 生成每 1m 一个枕木 + 两条长 rail
        const railGap = 1.435 // 标准轨距 m
        const railHeight = 0.1
        const railWidth = 0.08

        const sleeperSpacing = 1.5
        const sleepers = []

        // 按固定距离采样，得到均匀间距的点
        const stepCount = Math.floor(this.totalLength / sleeperSpacing)
        for(let i = 0; i < stepCount; i++)
        {
            const t = i / stepCount
            const p = this.curve.getPointAt(t)
            const tangent = this.curve.getTangentAt(t).normalize()

            // 世界 up = y，计算侧向量 = tangent × up
            const up = new THREE.Vector3(0, 1, 0)
            const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

            // 枕木中心在路径上，枕木方向 = side
            sleepers.push({ p, tangent, side })
        }

        // 枕木 BoxGeometry
        const sleeperGeo = new THREE.BoxGeometry(railGap + 0.4, 0.1, 0.2)
        const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1f, roughness: 0.9 })

        // 钢轨 BoxGeometry —— 每段 sleeper 之间一条短 rail
        const railMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.3 })

        // 用 InstancedMesh 做枕木
        const sleeperCount = sleepers.length
        const sleeperMesh = new THREE.InstancedMesh(sleeperGeo, sleeperMat, sleeperCount)
        sleeperMesh.castShadow = false
        sleeperMesh.receiveShadow = true

        const dummy = new THREE.Object3D()
        const axisY = new THREE.Vector3(0, 1, 0)

        for(let i = 0; i < sleeperCount; i++)
        {
            const { p, tangent } = sleepers[i]

            // 枕木贴地：y 给个小偏移，让它稍稍沉入地下看起来自然
            dummy.position.set(p.x, p.y + 0.05, p.z)

            // 旋转：让枕木的 length 方向（x 轴）对齐 tangent 的垂直方向（即 side）
            // 我们直接旋转让 x 轴对准 side
            const side = sleepers[i].side
            const quat = new THREE.Quaternion()
            quat.setFromUnitVectors(axisY, new THREE.Vector3(side.y, side.x * -1, side.z).normalize())

            // 更简单：让 dummy 的 +x 对准 side，+z 对准 tangent
            // dummy 默认 +x 长，+z 宽
            dummy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(side.x, side.z))

            dummy.updateMatrix()
            sleeperMesh.setMatrixAt(i, dummy.matrix)
        }
        sleeperMesh.instanceMatrix.needsUpdate = true
        this.group.add(sleeperMesh)

        // 两条连续钢轨 —— 用一条 TubeGeometry 沿 offset 后的 curve
        const leftOffsets = []
        const rightOffsets = []

        // 先对采样点做 side offset
        const samplesCount = 400
        for(let i = 0; i < samplesCount; i++)
        {
            const t = i / samplesCount
            const p = this.curve.getPointAt(t)
            const tangent = this.curve.getTangentAt(t).normalize()
            const up = new THREE.Vector3(0, 1, 0)
            const side = new THREE.Vector3().crossVectors(tangent, up).normalize()

            const offset = railGap * 0.5
            leftOffsets.push(new THREE.Vector3(
                p.x + side.x * offset,
                p.y + railHeight,
                p.z + side.z * offset
            ))
            rightOffsets.push(new THREE.Vector3(
                p.x - side.x * offset,
                p.y + railHeight,
                p.z - side.z * offset
            ))
        }

        const leftCurve = new THREE.CatmullRomCurve3(leftOffsets, true, 'catmullrom', 0.5)
        const rightCurve = new THREE.CatmullRomCurve3(rightOffsets, true, 'catmullrom', 0.5)

        const tubeSegments = 200
        const segments = 8
        const leftTube = new THREE.Mesh(
            new THREE.TubeGeometry(leftCurve, tubeSegments, 0.04, segments, true),
            railMat
        )
        const rightTube = new THREE.Mesh(
            new THREE.TubeGeometry(rightCurve, tubeSegments, 0.04, segments, true),
            railMat
        )
        leftTube.castShadow = true
        rightTube.castShadow = true
        leftTube.receiveShadow = true
        rightTube.receiveShadow = true

        this.group.add(leftTube, rightTube)
    }

    /**
     * 获取轨道上某 t 值的位置和朝向
     * @param {number} t 0~1
     * @returns {{ position: THREE.Vector3, tangent: THREE.Vector3 }}
     */
    getPoseAt(t)
    {
        const position = this.curve.getPointAt(t).clone()
        const tangent = this.curve.getTangentAt(t).clone().normalize()
        return { position, tangent }
    }

    /**
     * 沿轨道推进 t
     * @param {number} t 当前 t
     * @param {number} distance 推进的距离（米）
     * @returns {number} 新的 t（0~1 循环）
     */
    advance(t, distance)
    {
        // 近似：用 totalLength 换算
        const deltaT = distance / this.totalLength
        let newT = (t + deltaT) % 1
        if(newT < 0) newT += 1
        return newT
    }
}
