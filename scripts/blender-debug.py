import bpy, mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath="/Users/junye/Documents/code/visualstudio/folio-2025/static/spiderman/spiderman-rigged.glb")

scene = bpy.context.scene
for obj in scene.objects:
    if obj.type == 'ARMATURE':
        print("ARMATURE:", obj.name, "bones:", len(obj.data.bones))
        ad = obj.animation_data
        if ad and ad.action:
            act = ad.action
            fcs = []
            for layer in act.layers:
                for strip in layer.strips:
                    for slot in strip.slots:
                        fcs.extend(slot.fcurves)
            print("  action:", act.name, "fcurves:", len(fcs))
            for c in fcs[:8]:
                print("   ", c.array_identifier, c.data_path, c.array_index, "keys:", len(c.keyframe_points))
        else:
            print("  NO ACTION")
    if obj.type == 'MESH':
        print("MESH:", obj.name, "groups:", len(obj.vertex_groups))

# sample hand world positions at first/last frame
arm = [o for o in scene.objects if o.type == 'ARMATURE'][0]
for f in (int(scene.frame_start), int(scene.frame_end)):
    scene.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    ea = arm.evaluated_get(dg)
    for bn in ('hand_l', 'hand_r'):
        try:
            m = ea.matrix_world @ ea.pose.bones[bn].matrix
            print(f"frame {f} {bn}:", tuple(round(v,3) for v in m.translation))
        except KeyError:
            print("no bone", bn)
