import bpy
import math
import mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)

glb = '/Users/junye/Documents/code/visualstudio/folio-2025/static/Lamborghini+Revuelto.glb'
bpy.ops.import_scene.gltf(filepath=glb)

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


# 正后方 (glTF 后 = -z)
render_from_gltf(0.2, 1.3, -6.5, 0, 0.5, -1.0, '/tmp/lambo-rear.png')
# 后 3/4 上方 (发动机舱方向)
render_from_gltf(-3.0, 3.0, -4.5, 0, 0.4, -1.0, '/tmp/lambo-rear34b.png')
# 正前方
render_from_gltf(0, 1.2, 6.5, 0, 0.45, 1.0, '/tmp/lambo-front.png')
# 前 3/4
render_from_gltf(3.6, 2.2, 5.0, 0, 0.45, 0.3, '/tmp/lambo-front34b.png')
