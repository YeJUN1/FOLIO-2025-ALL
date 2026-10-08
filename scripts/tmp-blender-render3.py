import bpy
import math
import mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)

GLB = '/tmp/revuelto-runtime.glb'
bpy.ops.import_scene.gltf(filepath=GLB)

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

world = bpy.data.worlds.new('world')
bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.55, 0.6, 0.65, 1)
bg.inputs[1].default_value = 1.2

# 地面板：glTF y = -0.9944 (车轮底部) -> Blender z = -0.9944
mesh = bpy.data.meshes.new('ground')
ground = bpy.data.objects.new('ground', mesh)
bpy.context.scene.collection.objects.link(ground)
verts = [(-8, -8, -0.9944), (8, -8, -0.9944), (8, 8, -0.9944), (-8, 8, -0.9944)]
faces = [(0, 1, 2, 3)]
mesh.from_pydata(verts, [], faces)
mat = bpy.data.materials.new('groundmat')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.34, 0.36, 1)
mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
mesh.materials.append(mat)

scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception:
    scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 1000
scene.render.resolution_y = 640
try:
    scene.eevee.taa_render_samples = 16
except Exception:
    pass


def render_from_gltf(gx, gy, gz, tx, ty, tz, path):
    # glTF 坐标 -> Blender 坐标: (x, -z, y)
    loc = (gx, -gz, gy)
    target = (tx, -tz, ty)
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


# 车头 +X、右侧 +Z
# 前 3/4 右上
render_from_gltf(4.6, 2.4, 3.4, 0.2, 0.2, 0, '/tmp/revuelto2-front34.png')
# 后 3/4 左下
render_from_gltf(-4.6, 2.4, -3.4, 0, 0.2, 0, '/tmp/revuelto2-rear34.png')
# 正侧
render_from_gltf(0, 1.0, 5.2, 0, 0.2, 0, '/tmp/revuelto2-side.png')
# 前轮特写 (前轮中心 ≈ (±0.843, -0.7876, ±0.5166))
render_from_gltf(1.85, -0.15, 1.45, 0.84, -0.72, 0.5, '/tmp/revuelto2-wheel.png')
