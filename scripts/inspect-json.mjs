import fs from 'fs'

const buffer = fs.readFileSync(process.argv[2])
const jsonLength = buffer.readUInt32LE(12)
const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength))

console.log('=== extensionsUsed ===', JSON.stringify(json.extensionsUsed || []))
console.log('=== extensionsRequired ===', JSON.stringify(json.extensionsRequired || []))

console.log('=== Materials alpha modes ===')
for(const m of json.materials || []) {
    const pbr = m.pbrMetallicRoughness || {}
    const alpha = pbr.baseColorFactor ? pbr.baseColorFactor[3] : 1
    console.log(` ${m.name} | alphaMode: ${m.alphaMode || 'OPAQUE'} | alphaFactor: ${alpha} | doubleSided: ${m.doubleSided || false} | ext: ${Object.keys(m.extensions || {}).join(',') || '-'}`)
}

// Buffer views stats: geometry vs textures
let imageBytes = 0, geomBytes = 0
for(const img of json.images || [])
    if(img.bufferView !== undefined) imageBytes += json.bufferViews[img.bufferView].byteLength

const imageBufferViews = new Set((json.images || []).map(i => i.bufferView).filter(v => v !== undefined))
for(const bv of json.bufferViews || [])
    if(!imageBufferViews.has(json.bufferViews.indexOf(bv))) geomBytes += bv.byteLength

console.log('=== Size: images =', (imageBytes / 1024 / 1024).toFixed(1), 'MB | geometry =', (geomBytes / 1024 / 1024).toFixed(1), 'MB')

// File size
console.log('=== Total file:', (buffer.length / 1024 / 1024).toFixed(1), 'MB')

// Node count / scene roots
console.log('=== Scenes ===', JSON.stringify((json.scenes || []).map(s => ({ name: s.name, roots: s.nodes.length }))))
console.log('=== Root nodes ===', (json.scenes?.[0]?.nodes || []).map(i => json.nodes[i].name || `#${i}`).join(', '))

// Mesh count and total primitives
let prims = 0
for(const m of json.meshes || []) prims += m.primitives.length
console.log('=== Meshes:', (json.meshes || []).length, '| Primitives:', prims)
