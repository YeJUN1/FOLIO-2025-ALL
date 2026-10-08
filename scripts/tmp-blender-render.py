import bpy
import math
import mathutils

# 清空场景
bpy.ops.wm.read_factory_settings(use_empty=True)

# 导入 GLB
glb = '/Users/junye/Documents/code/visualstudio/folio-2025/static/Lamborghini+Revuelto.glb'
bpy.ops.import_scene.gltf(filepath=glb)

# 包围盒
min_v = mathutils.Vector((1e9, 1e9, 1e9))
max_v = mathutils.Vector((-1e9, -1e9, -1e9))
for obj in bpy.context.scene.objects:
    if obj.type == 'MESH':
        for corner in obj.bound_box:
            w = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                min_v[i] = min(min_v[i], w[i])
                max_v[i] = max(max_v[i], w[i])
print('BOUNDS', tuple(round(v, 3) for v in min_v), tuple(round(v, 3) for v in max_v))

# 灯光
sun_data = bpy.data.lights.new('sun', 'SUN')
sun_data.energy = 4
sun = bpy.data.objects.new('sun', sun_data)
bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(45), math.radians(-15), math.radians(35))

fill_data = bpy.data.lights.new('fill', 'SUN')
fill_data.energy = 1.5
fill = bpy.data.objects.new('fill', fill_data)
bpy.context.scene.collection.objects.link(fill)
fill.rotation_euler = (math.radians(60), math.radians(20), math.radians(-140))

# 世界光
world = bpy.data.worlds.new('world')
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.55, 0.6, 0.65, 1)
bg.inputs[1].default_value = 1.2

# 渲染设置
scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception:
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except Exception:
        scene.render.engine = 'CYCLES'
scene.render.resolution_x = 1000
scene.render.resolution_y = 640
if scene.render.engine == 'CYCLES':
    scene.cycles.samples = 24
else:
    try:
        scene.eevee.taa_render_samples = 16
    except Exception:
        pass


def render_from(loc, target, path):
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('cam', cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    direction = mathutils.Vector(target) - mathutils.Vector(loc)
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('RENDERED', path)

# 前3/4
render_from((3.2, 2.0, 5.4), (0, 0.45, 0.2), '/tmp/lambo-front34.png')
# 侧面
render_from((6.8, 1.1, 0.05), (0, 0.5, -0.1), '/tmp/lambo-side.png')
# 后3/4
render_from((-3.2, 2.2, -5.6), (0, 0.45, -0.3), '/tmp/lambo-rear34.png')
# 顶部后(发动机舱)
render_from((-2.0, 3.4, -3.6), (0, 0.3, -0.8), '/tmp/lambo-top-rear.png')
