// 离线生成「围栏区」栏杆摆放数据 → sources/data/fenceEnclosure.js
//
// 为什么离线烘焙：栏杆要贴着地面，而地形高度在运行时只存在于 GPU 纹理（terrain.ktx）
// 或 terrain.glb 顶点里。这里直接读 terrain.glb 顶点，拿到与物理 heightfield
// （Floor.setPhysical 用的就是这份几何）一致的高度场；再用俯视图渲染结果
// （map-topdown-2048.png）逐点取色，判断栏杆有没有压在柏油路面上。
//
// 用法：
//   node scripts/fence-enclosure.mjs                # 打印诊断（高度剖面 + 压路检查）
//   node scripts/fence-enclosure.mjs --strict       # 严格按画线（不退路肩、不给赛道留路口）
//   node scripts/fence-enclosure.mjs --preview      # 额外输出走向图 scripts/tmp-fence-preview.png
//   node scripts/fence-enclosure.mjs --write        # 写出 sources/data/fenceEnclosure.js
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TERRAIN_SIZE = 192
const WATER_LEVEL = -0.3      // Water.surfaceElevation
const DEEP_WATER_LEVEL = -0.5 // 低于这个深度的地方不立栏杆（海里立栏杆没有意义）
const FENCE_LIFT = 1.04       // 栏杆原点相对地面的抬升（与 fences.glb 里作者摆放的 y 一致）
const SPACING = 2.14          // 单片栏杆长度（碰撞体 half-extent 1.067 × 2）

// 用户在地图上圈出的矩形（世界坐标，图幅 = ±96），与 Map.js 画的标注框同一个数据
const ZONE = { west: -96, east: -33.5, north: -33, south: 16 }
// 圆角跟标注框对齐：map.styl 里 .fenced-zone 的 border-radius 12px，@1024px 宽 = 2.25 世界单位
const CORNER_RADIUS = 2.25

// 严格模式：栏杆一律压在画线上，不为避让赛道而挪位或留缺口（深水段仍然跳过）
const STRICT = process.argv.includes('--strict')

/**
 * 地形高度场：读 terrain.glb 顶点（129 × 129 网格），双线性采样
 */
function loadTerrain(file = 'static/terrain/terrain.glb')
{
    const buf = fs.readFileSync(path.join(root, file))
    const jsonLength = buf.readUInt32LE(12)
    const json = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'))
    const binOffset = 20 + jsonLength + 8

    const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION]
    const view = json.bufferViews[accessor.bufferView]
    const start = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const positions = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + accessor.count * 12))

    const side = Math.round(Math.sqrt(accessor.count))
    const heights = new Float32Array(side * side)

    for(let i = 0; i < accessor.count; i++)
    {
        const x = positions[i * 3 + 0]
        const y = positions[i * 3 + 1]
        const z = positions[i * 3 + 2]
        const ix = Math.round((x / TERRAIN_SIZE + 0.5) * (side - 1))
        const iz = Math.round((z / TERRAIN_SIZE + 0.5) * (side - 1))
        heights[iz * side + ix] = y
    }

    const heightAt = (x, z) =>
    {
        const fx = (x / TERRAIN_SIZE + 0.5) * (side - 1)
        const fz = (z / TERRAIN_SIZE + 0.5) * (side - 1)
        const x0 = Math.max(0, Math.min(side - 2, Math.floor(fx)))
        const z0 = Math.max(0, Math.min(side - 2, Math.floor(fz)))
        const tx = Math.min(1, Math.max(0, fx - x0))
        const tz = Math.min(1, Math.max(0, fz - z0))
        const h00 = heights[z0 * side + x0]
        const h10 = heights[z0 * side + x0 + 1]
        const h01 = heights[(z0 + 1) * side + x0]
        const h11 = heights[(z0 + 1) * side + x0 + 1]

        return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz
    }

    return { heightAt, side }
}

/**
 * 俯视图取色：用来判断某个世界坐标是否落在柏油路面上
 * 这张渲染图走过调色板量化，路面 = #1a0c39 (26,12,57)
 */
async function loadMapSampler(file = 'map-topdown-2048.png')
{
    const fullPath = path.join(root, file)
    if(!fs.existsSync(fullPath))
        return null

    const image = await sharp(fullPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { width, height } = image.info
    const px = image.data

    const colorAt = (x, z) =>
    {
        const cx = Math.round((x / TERRAIN_SIZE + 0.5) * (width - 1))
        const cy = Math.round((z / TERRAIN_SIZE + 0.5) * (height - 1))
        if(cx < 0 || cy < 0 || cx >= width || cy >= height)
            return null
        const i = (cy * width + cx) * 4
        return [ px[i], px[i + 1], px[i + 2] ]
    }

    colorAt.isAsphalt = (x, z) =>
    {
        const rgb = colorAt(x, z)
        if(!rgb)
            return false
        return Math.abs(rgb[0] - 26) < 20 && Math.abs(rgb[1] - 12) < 20 && Math.abs(rgb[2] - 57) < 24
    }

    return colorAt
}

/**
 * 圆角矩形周长折线（XZ 平面，顺时针：北 → 东 → 南 → 西）
 * 只输出四段圆弧的采样点，相邻弧端点之间的直线段就是四条边
 */
function roundedRectPolyline(zone, radius, segment = 10)
{
    const corners = [
        { cx: zone.west + radius, cz: zone.north + radius, from: Math.PI, to: Math.PI * 1.5 },       // 西北
        { cx: zone.east - radius, cz: zone.north + radius, from: Math.PI * 1.5, to: Math.PI * 2 },   // 东北
        { cx: zone.east - radius, cz: zone.south - radius, from: 0, to: Math.PI * 0.5 },             // 东南
        { cx: zone.west + radius, cz: zone.south - radius, from: Math.PI * 0.5, to: Math.PI },       // 西南
    ]

    const points = []
    for(const corner of corners)
        for(let i = 0; i <= segment; i++)
        {
            const a = corner.from + (corner.to - corner.from) * (i / segment)
            points.push({ x: corner.cx + Math.cos(a) * radius, z: corner.cz + Math.sin(a) * radius })
        }

    points.push({ ...points[0] }) // 闭合
    return points
}

/**
 * 沿折线按固定间距取样，输出位置 + 朝向
 */
function samplePath(points, spacing)
{
    const samples = []
    let carry = 0
    let current = points[0]
    let index = 0

    const last = points.length - 1
    while(index < last)
    {
        const next = points[index + 1]
        const dx = next.x - current.x
        const dz = next.z - current.z
        const segmentLength = Math.hypot(dx, dz)
        const ux = dx / segmentLength
        const uz = dz / segmentLength

        if(carry + segmentLength < spacing)
        {
            carry += segmentLength
            current = next
            index++
            continue
        }

        const along = spacing - carry
        const x = current.x + ux * along
        const z = current.z + uz * along
        samples.push({ x, z, yaw: Math.atan2(-uz, ux) })

        carry = 0
        current = { x, z }
        // 同一段继续取样：不推进 index
    }

    return samples
}

const terrain = loadTerrain()
const sampleMap = await loadMapSampler()
const ZONE_CENTER = { x: (ZONE.west + ZONE.east) / 2, z: (ZONE.north + ZONE.south) / 2 }

// 注意：海面和柏油在这张渲染图里是同一个调色板颜色，靠高度区分（海面 h < -0.5）
const isOnRoad = sampleMap ? (x, z) => sampleMap.isAsphalt(x, z) && terrain.heightAt(x, z) >= DEEP_WATER_LEVEL : null

/**
 * 逐片把栏杆从柏油里挑到最近的路肩，躲不开的就留缺口（赛道路口）
 *
 * 用户画的矩形边界相当地形熟悉：北边贴着发卡弯直道的北边缘、东边贴着竖直道的右边缘、
 * 南边则穿过 S 弯。所以不能简单往一侧平移（会越移越深），而是向内/向外两个方向各探一步，
 * 取能离开路面的那个位移；两边都超出 maxOffset 说明这条路正好横穿围栏线，呰掉形成缺口。
 */
function routeUnits(points, isOnRoad, maxOffset = 6, step = 0.5, margin = 0.6, maxPasses = 3)
{
    if(!isOnRoad)
        return { points: points.map((point) => ({ ...point, offset: 0 })), moved: 0, gaps: 0 }

    let moved = 0
    let gaps = 0

    const result = points.map((point) =>
    {
        // 路径切线（yaw = atan2(-uz, ux) → ux = cos, uz = -sin）与两个法线方向
        const ux = Math.cos(point.yaw)
        const uz = -Math.sin(point.yaw)
        const nx = uz
        const nz = -ux

        const clearAt = (x, z, sign) =>
        {
            for(let d = step; d <= maxOffset; d += step)
                if(!isOnRoad(x + nx * sign * d, z + nz * sign * d))
                    return d + margin
            return null
        }

        let { x, z } = point
        let offset = 0

        // 退到路肩后，因为画线在圆角处是斜穿路面的，可能又落回柏油，所以最多细化三轮
        for(let pass = 0; pass < maxPasses && isOnRoad(x, z); pass++)
        {
            const inward = clearAt(x, z, -1)   // 区域内侧
            const outward = clearAt(x, z, 1)   // 区域外侧

            let best = null
            if(inward !== null && (outward === null || inward <= outward))
                best = -inward
            else if(outward !== null)
                best = outward

            if(best === null) // 赛道横穿：不立栏杆，留作路口
            {
                gaps++
                return null
            }

            x += nx * best
            z += nz * best
            offset += best
        }

        if(isOnRoad(x, z))
        {
            gaps++
            return null
        }

        if(offset !== 0)
            moved++

        return { ...point, x, z, offset: +offset.toFixed(2) }
    }).filter((point) => point !== null)

    return { points: result, moved, gaps }
}

// 按栏杆间距采样画线 → 逐片避开路面（strict 下直接压线）
const spacedSamples = samplePath(roundedRectPolyline(ZONE, CORNER_RADIUS, 24), SPACING)
const routed = STRICT
    ? { points: spacedSamples.map((point) => ({ ...point, offset: 0 })), moved: 0, gaps: 0 }
    : routeUnits(spacedSamples, isOnRoad)
const { points: routedSamples, moved: movedCount, gaps: gapCount } = routed

// 深水的样本丢掉（西侧本来就是海），其余贴地
const units = []
let skipped = 0
for(const sample of routedSamples)
{
    const h = terrain.heightAt(sample.x, sample.z)
    if(h < DEEP_WATER_LEVEL)
    {
        skipped++
        continue
    }

    units.push({
        x: +sample.x.toFixed(2),
        y: +(h + FENCE_LIFT).toFixed(2),
        z: +sample.z.toFixed(2),
        yaw: +sample.yaw.toFixed(4),
        h: +h.toFixed(2),
    })
}

console.log(`${STRICT ? '【strict 严格按线】' : ''}画线上采样 ${spacedSamples.length} 片：${movedCount} 片退到路肩，${gapCount} 片因赛道横穿被留作路口，落在深水的 ${skipped} 片跳过，实际摆放 ${units.length} 片`)

if(sampleMap)
{
    const onRoad = units.filter((unit) => isOnRoad(unit.x, unit.z))
    console.log(STRICT ? `压在赛道上的栏杆：${onRoad.length} 片（strict 模式预期如此）` : `仍然压在路面上的栏杆：${onRoad.length} 片`)
    for(const unit of onRoad.slice(0, 10))
        console.log(`   (${unit.x}, ${unit.z}) h=${unit.h} rgb=${sampleMap(unit.x, unit.z).join(',')}`)

    // 预览：把最终围栏走向画到俯视图上，并裁出局部图供人工核对
    if(process.argv.includes('--preview'))
    {
        const toPx = (p) => `${((p.x / TERRAIN_SIZE + 0.5) * 2048).toFixed(1)},${((p.z / TERRAIN_SIZE + 0.5) * 2048).toFixed(1)}`
        const polyline = units.map(toPx).join(' ')
        const marks = units.map((unit) => `<circle cx="${toPx(unit).split(',')[0]}" cy="${toPx(unit).split(',')[1]}" r="13" fill="none" stroke="#00ff00" stroke-width="6"/>`).join('')
        const svg = `<svg width="2048" height="2048"><polyline points="${polyline}" fill="none" stroke="#00ff00" stroke-width="9" stroke-linejoin="round"/>${marks}</svg>`
        const overlay = await sharp(Buffer.from(svg)).resize(2048, 2048, { fit: 'fill' }).png().toBuffer()

        const composed = await sharp(path.join(root, 'map-topdown-2048.png'))
            .composite([ { input: overlay, blend: 'over' } ])
            .png()
            .toBuffer()

        await sharp(composed).png().toFile(path.join(root, 'scripts/tmp-fence-full.png'))
        await sharp(composed).extract({ left: 0, top: 541, width: 960, height: 803 }).png().toFile(path.join(root, 'scripts/tmp-fence-preview.png'))
        console.log('已输出 scripts/tmp-fence-preview.png（绿线 = 最终围栏走向）')
    }
}
else
{
    console.log('未找到 map-topdown-2048.png，跳过压路检查')
}

if(process.argv.includes('--write'))
{
    const rows = units.map((unit) => `    [ ${unit.x}, ${unit.y}, ${unit.z}, ${unit.yaw} ],`)
    const content = `// 由 scripts/fence-enclosure.mjs 离线生成（node scripts/fence-enclosure.mjs${STRICT ? ' --strict' : ''} --write）
// 数据 = 用户在地图上圈出的矩形区域周长上的栏杆摆放：每片 [ x, y, z, yaw ]
// y 已按 terrain.glb 的高度烘焙过，yaw 让栏杆局部 +X 朝向路径切线
// ${STRICT
        ? 'strict：栏杆一律压在标注框的线上（含压在赛道上的那几段），只有落在深海的片跳过'
        : '避让模式：压在赛道上的栏杆退到路肩，躲不开的删掉留成路口，落在深海的片也跳过'}
export const fenceEnclosureZone = ${JSON.stringify(ZONE)}

export const fenceEnclosureUnits = [
${rows.join('\n')}
]
`

    const target = path.join(root, 'sources/data/fenceEnclosure.js')
    fs.writeFileSync(target, content)
    console.log(`\n已写出 ${path.relative(root, target)}（${units.length} 片）`)
}
