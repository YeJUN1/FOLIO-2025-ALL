import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'


const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)



const doc = await io.read(process.argv[2])
const root = doc.getRoot()

console.log('=== Scenes ===')
for(const scene of root.listScenes()) console.log(' Scene:', scene.getName() || '(unnamed)')

console.log('=== Nodes (hierarchy) ===')
const printNode = (node, depth) => {
    const mesh = node.getMesh()
    const t = node.getTranslation()
    const s = node.getScale()
    const extras = []
    if(mesh) {
        const prims = mesh.listPrimitives().length
        const triCount = mesh.listPrimitives().reduce((sum, p) => sum + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0)
        extras.push(`mesh:${mesh.getName() || '?'} prims:${prims} tris:${Math.round(triCount)}`)
    }
    extras.push(`t:[${t.map(v=>v.toFixed(3)).join(',')}] s:[${s.map(v=>v.toFixed(3)).join(',')}]`)
    console.log(' '.repeat(depth * 2) + '- ' + (node.getName() || '(unnamed)') + ' | ' + extras.join(' | '))
    for(const child of node.listChildren()) printNode(child, depth + 1)
}
for(const scene of root.listScenes())
    for(const node of scene.listChildren()) printNode(node, 1)

console.log('=== Meshes ===')
for(const mesh of root.listMeshes()) {
    const triCount = mesh.listPrimitives().reduce((sum, p) => sum + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0)
    console.log(` Mesh: ${mesh.getName() || '(unnamed)'} tris: ${Math.round(triCount)}`)
}

console.log('=== Materials ===')
for(const mat of root.listMaterials()) {
    console.log(` Material: ${mat.getName() || '(unnamed)'} metallic: ${mat.getMetallicFactor()} roughness: ${mat.getRoughnessFactor()} baseColor: [${mat.getBaseColorFactor().map(v=>v.toFixed(2))}]`)
    const bcTex = mat.getBaseColorTexture()
    const mrTex = mat.getMetallicRoughnessTexture()
    const nTex = mat.getNormalTexture()
    if(bcTex) console.log(`   baseColorTex: ${bcTex.getName() || '?'} ${bcTex.getSize().join('x')} mime: ${bcTex.getMimeType()}`)
    if(mrTex) console.log(`   metallicRoughnessTex: ${mrTex.getName() || '?'} ${mrTex.getSize().join('x')}`)
    if(nTex) console.log(`   normalTex: ${nTex.getName() || '?'} ${nTex.getSize().join('x')}`)
}

console.log('=== Textures ===')
for(const tex of root.listTextures()) {
    console.log(` Texture: ${tex.getName() || '(unnamed)'} ${tex.getSize().join('x')} mime: ${tex.getMimeType()}`)
}

console.log('=== Animations ===')
for(const anim of root.listAnimations()) console.log(` Animation: ${anim.getName() || '(unnamed)'} channels: ${anim.listChannels().length}`)

console.log('=== Skins ===')
for(const skin of root.listSkins()) console.log(` Skin: ${skin.getName() || '(unnamed)'}`)
