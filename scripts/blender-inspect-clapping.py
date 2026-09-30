import bpy, mathutils, json

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath="/Users/junye/Library/Application Support/com.RokokoElectronics.RokokoStudio/Exports/Clapping.fbx")

scene = bpy.context.scene
print("FPS:", scene.render.fps)
print("frame range:", scene.frame_start, scene.frame_end)

act = bpy.data.actions.get('Root|clip|Base_Layer')
print("clip frames:", tuple(act.frame_range))

arm = [o for o in scene.objects if o.type == 'ARMATURE'][0]

# sample hand distance + head position over frames
depsgraph = bpy.context.evaluated_depsgraph_get()
rows = []
for f in range(int(scene.frame_start), int(scene.frame_end) + 1, 3):
    scene.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    ea = arm.evaluated_get(dg)
    mw = ea.matrix_world
    lh = (mw @ ea.pose.bones['LeftHand'].matrix).translation
    rh = (mw @ ea.pose.bones['RightHand'].matrix).translation
    hd = (mw @ ea.pose.bones['Head'].matrix).translation
    rows.append((f, round((lh - rh).length, 3), round(hd.z, 3), round(lh.z, 3)))
for r in rows:
    print("frame=%d handDist=%.3f headZ=%.3f handZ=%.3f" % r)

# rest pose height
scene.frame_set(scene.frame_start)
dg = bpy.context.evaluated_depsgraph_get()
ea = arm.evaluated_get(dg)
top = (ea.matrix_world @ ea.pose.bones['Head'].matrix).translation
hips = (ea.matrix_world @ ea.pose.bones['Hips'].matrix).translation
print("head top:", tuple(round(v,2) for v in top), "hips:", tuple(round(v,2) for v in hips))
