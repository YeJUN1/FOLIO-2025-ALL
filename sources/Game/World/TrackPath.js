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

        // === 轨道控制点 —— 紧贴岛屿陆地边缘，顺时针绕一圈 ===
        // 岛屿大致是一个椭圆：x∈[-90, 130], z∈[-100, 95]
        // 控制点沿边缘摆，避开中间的地盘区
        const rawPoints = [
            // 【起点】岛的东南海岸线（PlotFence 以东、PandoraFence 以南）
            new THREE.Vector3(60, 0, -78),
            // 右下：PlotFence 以南，贴着陆地
            new THREE.Vector3(40, 0, -95),
            new THREE.Vector3(10, 0, -98),
            new THREE.Vector3(-20, 0, -95),
            new THREE.Vector3(-45, 0, -88),
            // 左下：TerritoryFence 以西/以南
            new THREE.Vector3(-65, 0, -75),
            new THREE.Vector3(-80, 0, -55),
            new THREE.Vector3(-88, 0, -30),
            new THREE.Vector3(-88, 0, 0),
            new THREE.Vector3(-85, 0, 30),
            // 左上：TerritoryFence 以北
            new THREE.Vector3(-75, 0, 55),
            new THREE.Vector3(-55, 0, 78),
            new THREE.Vector3(-30, 0, 90),
            new THREE.Vector3(0, 0, 95),
            new THREE.Vector3(30, 0, 92),
            // 右上：PandoraFence 以北
            new THREE.Vector3(55, 0, 85),
            new THREE.Vector3(80, 0, 70),
            new THREE.Vector3(100, 0, 45),
            new THREE.Vector3(115, 0, 15),
            new THREE.Vector3(120, 0, -15),
            new THREE.Vector3(115, 0, -45),
            new THREE.Vector3(100, 0, -68),
            // 回到起点
        ]

        // === 避开禁区 + 射线贴地 ===
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

    setGroundHeight(points)
    {
        const terrainMesh = this.game.resources.terrainModel.scene.children[0]
        const raycaster = new THREE.Raycaster()
        raycaster.far = 200

        for(const p of points)
        {
            // 从高空往下射
            const origin = new THREE.Vector3(p.x, 100, p.z)
            raycaster.set(origin, new THREE.Vector3(0, -1, 0))

            const hits = raycaster.intersectObject(terrainMesh, false)
            if(hits.length > 0)
            {
                p.y = hits[0].point.y
            }
            else
            {
                // 没击中地形（可能是水域），保底高一点让它不沉水
                p.y = 2
            }
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
}
