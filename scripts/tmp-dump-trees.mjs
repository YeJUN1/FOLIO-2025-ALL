/* dump default.glb 与 revuelto.glb 的节点树（含 wheelContainer 位置），确认运行时布局 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

for(const file of ['static/vehicle/default.glb', 'static/vehicle/revuelto.glb']) {
    const doc = await io.read(file)
    console.log(`\n========== ${file} ==========`)
    const txt = (v) => `[${Array.from(v).map(x => x.toFixed(3)).join(', ')}]`
    const dump = (node, depth) => {
        const mesh = node.getMesh()
        console.log(`${'  '.repeat(depth)}${node.getName() || '(unnamed)'}  t=${txt(node.getTranslation())} s=${txt(node.getScale())}${mesh ? `  [mesh: ${mesh.listPrimitives().length} prim]` : ''}`)
        if(depth < 3)
            for(const c of node.listChildren()) dump(c, depth + 1)
    }
    for(const scene of doc.getRoot().listScenes())
        for(const n of scene.listChildren())
            dump(n, 0)
}
