import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const SIZE = 192
const W = 1024
const toPx = v => (v / SIZE + 0.5) * W

// 登记册：origin/main 的 docs/划地盘.md「地盘登记册」表（唐一琳那份与代码一致）
const others = [
    { name: '舒雯', minX: -96, maxX: -37.2, minZ: -96, maxZ: -16.2, color: '#b06cff' },
    { name: '唐一琳', minX: 16, maxX: 86, minZ: -37, maxZ: 27.4, color: '#00e0ff' },
    { name: '丁浩宸', minX: -6.5, maxX: 46.5, minZ: -73.3, maxZ: -40.3, color: '#7CFC91' },
    { name: '龚浩翔', minX: -96, maxX: -13.5, minZ: 23, maxZ: 80, color: '#ff6ec7' },
    { name: '中西部（无署名）', minX: -42, maxX: 10, minZ: -8, maxZ: 22, color: '#9aa0a6' },
]

const drawn = { minX: -18.6, maxX: 96.0, minZ: 28.7, maxZ: 94.8 } // 手绘红框原样
const mine = { minX: -13.5, maxX: 95.1, minZ: 28.7, maxZ: 94.4 } // 收边后落地
const old = { minX: 18.6, maxX: 95.1, minZ: 26.3, maxZ: 94.4 } // 10-17 旧范围

const glb = readFileSync('static/respawns/respawnsReferences.glb')
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
const spawns = {}
json.nodes.forEach(n => { if(n.name?.startsWith('respawn') && n.translation) spawns[n.name.slice(7).toLowerCase()] = n.translation })

const rect = (r, stroke, width, dash, fill) =>
    `<rect x="${toPx(r.minX)}" y="${toPx(r.minZ)}" width="${toPx(r.maxX) - toPx(r.minX)}" height="${toPx(r.maxZ) - toPx(r.minZ)}" fill="${fill ?? 'none'}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`

const plate = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="rgba(0,0,0,0.72)" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>`
const label = (x, y, size, color, text, anchor = 'start', weight = 'bold') =>
    `<text x="${x}" y="${y}" font-family="PingFang SC, Hiragino Sans GB, Heiti SC, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" stroke="rgba(0,0,0,0.85)" stroke-width="3" paint-order="stroke">${text}</text>`

const parts = []

for(let g = -96; g <= 96; g += 24)
{
    parts.push(`<line x1="${toPx(g)}" y1="0" x2="${toPx(g)}" y2="${W}" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>`)
    parts.push(`<line x1="0" y1="${toPx(g)}" x2="${W}" y2="${toPx(g)}" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>`)
    if(g !== -96) parts.push(label(toPx(g) - 3, 16, 12, 'rgba(255,255,255,0.5)', g, 'end', 'normal'))
    if(g !== 96) parts.push(label(4, toPx(g) + 13, 12, 'rgba(255,255,255,0.5)', g, 'start', 'normal'))
}

// 别人的地盘
for(const p of others)
{
    parts.push(rect(p, p.color, 2.5, null, `${p.color}14`))
    parts.push(label(toPx(p.minX) + 6, toPx(p.minZ) + 17, 15, p.color, `${p.name}  x ${p.minX}~${p.maxX} z ${p.minZ}~${p.maxZ}`))
}

// 三个框：手绘原样（红虚线）→ 落地（橙实线）→ 旧范围（灰虚线）
parts.push(rect(drawn, '#ff2a2a', 4, '18,12'))
parts.push(rect(old, '#cccccc', 2, '6,8'))
parts.push(rect(mine, '#ffb300', 5, null, 'rgba(255,179,0,0.20)'))

// 被收掉的那一条：手绘西界 -18.6 到落地西界 -13.5
const strip = { minX: drawn.minX, maxX: mine.minX, minZ: mine.minZ, maxZ: mine.maxZ }
parts.push(`<defs><pattern id="hatch" width="14" height="14" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,42,42,0.85)" stroke-width="5"/></pattern></defs>`)
parts.push(rect(strip, '#ff2a2a', 2, null, 'url(#hatch)'))
parts.push(plate(toPx(strip.minX) - 96, toPx(56) - 13, 300, 46))
parts.push(label(toPx(strip.minX) + 196, toPx(56) + 5, 15, '#ff8080', '手绘西界超出 5.1m：撞龚浩翔围栏区', 'end'))
parts.push(label(toPx(strip.minX) + 196, toPx(56) + 25, 15, '#ffffff', '262 m²，按规则收边到共边', 'end'))

// 出生点
const pin = (x, y, color, text) =>
{
    parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="#000" stroke-width="2"/>`)
    parts.push(label(x + 13, y + 6, 16, '#ffffff', text))
}
pin(toPx(spawns.landing[0]), toPx(spawns.landing[2]), '#ffb300', '我的出生点 landing')
pin(toPx(spawns.behindthescene[0]), toPx(spawns.behindthescene[2]), '#00e0ff', '唐一琳出生点')

// 图例
parts.push(plate(8, W - 132, 470, 124))
const legend = [
    [ '#ffb300', `须翊恒 新（落地）：x ${mine.minX}~${mine.maxX}, z ${mine.minZ}~${mine.maxZ} = ${(mine.maxX - mine.minX).toFixed(1)}m × ${(mine.maxZ - mine.minZ).toFixed(1)}m ≈ 7135 m²` ],
    [ '#ff2a2a', `手绘红框原样：x ${drawn.minX}~${drawn.maxX}, z ${drawn.minZ}~${drawn.maxZ}（西多出的 5.1m 已收边）` ],
    [ '#cccccc', `旧范围 10-17：x 18.6~95.1, z 26.3~94.4（北界压唐一琳 1.1m，本次一并躲开）` ],
    [ '#00e0ff', '唐一琳 x 16~86, z -37~27.4 —— 新北界 28.7 > 27.4，不重叠，留 1.3m 缝' ],
    [ '#ff6ec7', '龚浩翔 x -96~-13.5, z 23~80 —— 10-21 已南移东扩，新地盘只能共边 x=-13.5' ],
]
legend.forEach(([ color, text ], i) =>
{
    const y = W - 112 + i * 23
    parts.push(`<rect x="18" y="${y - 11}" width="20" height="13" fill="${color}"/>`)
    parts.push(label(46, y, 15, '#ffffff', text, 'start', 'normal'))
})

const svg = `<svg width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg"><g>${parts.join('')}</g></svg>`
await sharp('static/ui/map/map-day.png')
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png({ quality: 92 })
    .toFile('docs/地盘分布图.png')

console.log('已生成 docs/地盘分布图.png')
