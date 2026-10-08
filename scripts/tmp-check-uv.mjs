import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(process.argv[2] ?? 'static/vehicle/revuelto.glb')
const root = doc.getRoot()

console.log('=== Primitive semantics per mesh ===')
for(const mesh of root.listMeshes()) {
    for(const prim of mesh.listPrimitives()) {
        const sem = prim.listSemantics().sort().join(',')
        const mat = prim.getMaterial()?.getName() ?? '(none)'
        console.log(` ${mesh.getName().padEnd(18)} [${mat.padEnd(34)}] ${sem}`)
    }
}
