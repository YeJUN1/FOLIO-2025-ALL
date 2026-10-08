import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read('static/Lamborghini+Revuelto.glb')
const root = doc.getRoot()

const fmt = (n) => Math.round(n * 1000) / 1000

// ===== 1. 材质聚合 =====
const mats = new Map()
const visitMat = (node, isWheel) => {
    const mesh = node.getMesh()
    if(mesh) {
        for(const prim of mesh.listPrimitives()) {
            const mat = prim.getMaterial()
            const key = (isWheel ? 'W:' : 'B:') + (mat ? mat.getName() : '(none)')
            if(!mats.has(key)) mats.set(key, { tris: 0, prims: 0, mat, nodes: new Set() })
            const e = mats.get(key)
            e.tris += (prim.getIndices() ? prim.getIndices().getCount() : prim.getAttribute('POSITION').getCount()) / 3
            e.prims++
            if(e.nodes.size < 3) e.nodes.add(node.getName())
        }
    }
    for(const c of node.listChildren()) visitMat(c, isWheel || /CTRL_Wheel|^Wheel_/.test(c.getName() || ''))
}
for(const s of root.listScenes()) for(const n of s.listChildren()) visitMat(n, false)

console.log('===== 材质清单 (按三角面排序) =====')
const sorted = [...mats.entries()].sort((a, b) => b[1].tris - a[1].tris)
for(const [key, e] of sorted) {
    const m = e.mat
    if(!m) { console.log(`${key}  tris=${Math.round(e.tris)} prims=${e.prims} (无材质)`); continue }
    const map = m.getBaseColorTexture()
    const em = m.getEmissiveTexture()
    const alpha = m.getAlphaMode()
    const parts = [
        `tris=${Math.round(e.tris)}`,
        `prims=${e.prims}`,
        `color=[${m.getBaseColorFactor().map(fmt).join(',')}]`,
        map ? `map=${map.getName() || map.getURI()}(${map.getSize()?.[0]}x${map.getSize()?.[1]},tc${m.getBaseColorTextureInfo().getTexCoord()},${map.getMimeType()})` : `map=no`,
        em ? `emissiveMap=${em.getName() || em.getURI()}(${em.getSize()?.[0]}x${em.getSize()?.[1]},tc${m.getEmissiveTextureInfo().getTexCoord()})` : '',
        `emissive=[${m.getEmissiveFactor().map(fmt).join(',')}]`,
        alpha !== 'OPAQUE' ? `alpha=${alpha}(${m.getAlphaCutoff()})` : '',
        m.getDoubleSided() ? 'doubleSided' : '',
        `extras=${JSON.stringify(m.getExtras() || {})}`,
        `nodes=${[...e.nodes].join('|')}`,
    ].filter(Boolean)
    console.log(`${key}  ${parts.join(' ')}`)
}

// ===== 2. 节点层级 (带 mesh/材质 标注, 有名字才打印) =====
console.log('\n===== 节点层级 =====')
const walk = (node, depth) => {
    const name = node.getName() || '(unnamed)'
    const mesh = node.getMesh()
    let meshInfo = ''
    if(mesh) {
        const t = mesh.listPrimitives().map(p => p.getMaterial()?.getName()).filter((v, i, a) => a.indexOf(v) === i).join(',')
        meshInfo = `  [${t}]`
    }
    const t = node.getTranslation(), s = node.getScale(), r = node.getRotation()
    const tf = []
    if(t.some(v => Math.abs(v) > 1e-6)) tf.push(`t=[${t.map(fmt)}]`)
    if(s.some(v => Math.abs(v - 1) > 1e-6)) tf.push(`s=[${s.map(fmt)}]`)
    if(r[0] || r[1] || r[2]) tf.push(`r=[${r.map(fmt)}]`)
    if(name !== '(unnamed)' || meshInfo)
        console.log(`${'  '.repeat(depth)}${name}${tf.length ? ' ' + tf.join(' ') : ''}${meshInfo}`)
    for(const c of node.listChildren()) walk(c, depth + 1)
}
for(const s of root.listScenes()) for(const n of s.listChildren()) walk(n, 0)
