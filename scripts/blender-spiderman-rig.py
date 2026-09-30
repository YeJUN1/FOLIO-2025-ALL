import bpy, mathutils

# ---------------- config ----------------
FBX_PATH = "/Users/junye/Library/Application Support/com.RokokoElectronics.RokokoStudio/Exports/Clapping.fbx"
GLB_PATH = "/Users/junye/Documents/code/visualstudio/folio-2025/static/spiderman/spiderman.glb"
OUT_PATH = "/Users/junye/Documents/code/visualstudio/folio-2025/static/spiderman/spiderman-rigged.glb"
NEUTRAL_START = 150  # average hand-in-chest-space over the clapping burst = oscillation center
NEUTRAL_END = 230
LOOP_START = 133
LOOP_END = 232       # stay inside the clap oscillation, before the arms-cross release
MOTION_SCALE = 1.15  # amplify the subtle mocap clap oscillation so it reads on the statue
MAX_OFFSET = 0.065   # statue forearm is short; clamp so IK never flips

J = {
    "pelvis":     (0.00, 0.10, 0.38),
    "spine_01":   (0.00, 0.07, 0.50),
    "spine_02":   (0.00, 0.03, 0.62),
    "spine_03":   (0.00, -0.01, 0.72),
    "neck":       (0.00, -0.03, 0.82),
    "head":       (0.00, -0.04, 0.90),
    "head_top":   (0.00, -0.04, 1.03),
    "clavicle_l": (0.05, -0.02, 0.70),
    "upperarm_l": (0.115, -0.03, 0.68),
    "forearm_l":  (0.195, -0.145, 0.50),
    "hand_l":     (0.115, -0.125, 0.72),
    "handtip_l":  (0.095, -0.115, 0.86),
    "clavicle_r": (-0.05, -0.02, 0.70),
    "upperarm_r": (-0.115, -0.03, 0.68),
    "forearm_r":  (-0.195, -0.145, 0.50),
    "hand_r":     (-0.115, -0.125, 0.72),
    "handtip_r":  (-0.095, -0.115, 0.86),
    "thigh_l":    (0.10, 0.06, 0.36),
    "knee_l":     (0.17, -0.14, 0.50),
    "ankle_l":    (0.15, -0.05, 0.07),
    "toe_l":      (0.15, -0.18, 0.05),
    "thigh_r":    (-0.10, 0.06, 0.36),
    "knee_r":     (-0.17, -0.14, 0.50),
    "ankle_r":    (-0.15, -0.05, 0.07),
    "toe_r":      (-0.15, -0.18, 0.05),
}

# parent, head, tail
BONES = {
    "pelvis":     (None, J["pelvis"], J["spine_01"]),
    "spine_01":   ("pelvis", J["spine_01"], J["spine_02"]),
    "spine_02":   ("spine_01", J["spine_02"], J["spine_03"]),
    "spine_03":   ("spine_02", J["spine_03"], J["neck"]),
    "neck":       ("spine_03", J["neck"], J["head"]),
    "head":       ("neck", J["head"], J["head_top"]),
    "clavicle_l": ("spine_03", J["clavicle_l"], J["upperarm_l"]),
    "upperarm_l": ("clavicle_l", J["upperarm_l"], J["forearm_l"]),
    "forearm_l":  ("upperarm_l", J["forearm_l"], J["hand_l"]),
    "hand_l":     ("forearm_l", J["hand_l"], J["handtip_l"]),
    "clavicle_r": ("spine_03", J["clavicle_r"], J["upperarm_r"]),
    "upperarm_r": ("clavicle_r", J["upperarm_r"], J["forearm_r"]),
    "forearm_r":  ("upperarm_r", J["forearm_r"], J["hand_r"]),
    "hand_r":     ("forearm_r", J["hand_r"], J["handtip_r"]),
    "thigh_l":    ("pelvis", J["thigh_l"], J["knee_l"]),
    "calf_l":     ("thigh_l", J["knee_l"], J["ankle_l"]),
    "foot_l":     ("calf_l", J["ankle_l"], J["toe_l"]),
    "thigh_r":    ("pelvis", J["thigh_r"], J["knee_r"]),
    "calf_r":     ("thigh_r", J["knee_r"], J["ankle_r"]),
    "foot_r":     ("calf_r", J["ankle_r"], J["toe_r"]),
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB_PATH)
scene = bpy.context.scene
mesh = [o for o in scene.objects if o.type == 'MESH'][0]

# ---------------- build armature ----------------
arm_data = bpy.data.armatures.new("SpidermanRig")
rig = bpy.data.objects.new("SpidermanRig", arm_data)
scene.collection.objects.link(rig)

bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
edit_bones = {}
for name, (parent, head, tail) in BONES.items():
    eb = arm_data.edit_bones.new(name)
    eb.head = head
    eb.tail = tail
    edit_bones[name] = eb
for name, (parent, _, _) in BONES.items():
    if parent:
        edit_bones[name].parent = edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')

# ---------------- skin (proximity weights, heat map fails on this non-manifold mesh) ----------------
import numpy as np

mod = mesh.modifiers.new("Armature", 'ARMATURE')
mod.object = rig
mesh.parent = rig

def add_weights(mesh, rig, sigma=0.022):
    n = len(mesh.data.vertices)
    co = np.empty(n * 3)
    mesh.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    co = (np.array(mesh.matrix_world) @ np.hstack([co, np.ones((n,1))]).T).T[:, :3]
    names = [b.name for b in rig.data.bones]
    segs = []
    for b in rig.data.bones:
        h = np.array(b.head_local); t = np.array(b.tail_local)
        segs.append((h, t))
    W = np.zeros((n, len(names)))
    D2 = np.zeros((n, len(names)))
    # per-bone influence radius: elbow rests on the knees, keep arm bones off the legs
    cutoffs = {}
    for i, b in enumerate(rig.data.bones):
        r = 2.6 * sigma
        if b.name.startswith(('upperarm', 'forearm', 'hand', 'clavicle')):
            r = 0.042
        cutoffs[i] = r
    for i, (h, t) in enumerate(segs):
        d = t - h
        L2 = d @ d
        if L2 < 1e-12:
            dist2 = ((co - h) ** 2).sum(axis=1)
        else:
            s = np.clip(((co - h) @ d) / L2, 0, 1)
            proj = h + d * s[:, None]
            dist2 = ((co - proj) ** 2).sum(axis=1)
        D2[:, i] = dist2
        W[:, i] = np.exp(-dist2 / (2 * sigma * sigma))
    # hard cutoff: a bone only influences vertices close to its tube
    for i in range(len(names)):
        W[D2[:, i] > cutoffs[i] ** 2, i] = 0
    # keep top 2 influences
    idx = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, dtype=bool)
    np.put_along_axis(keep, idx[:, :2], True, axis=1)
    W[~keep] = 0
    sums = W.sum(axis=1)
    # vertices with no influence at all -> bind to nearest bone fully
    lonely = sums < 1e-9
    if lonely.any():
        lonely_idx = np.nonzero(lonely)[0]
        nearest = np.argmin(D2[lonely_idx], axis=1)
        W[lonely_idx, :] = 0
        W[lonely_idx, nearest] = 1.0
        sums = W.sum(axis=1)
    W = W / sums[:, None]
    for i, name in enumerate(names):
        vg = mesh.vertex_groups.get(name) or mesh.vertex_groups.new(name=name)
        nz = np.nonzero(W[:, i] > 0.01)[0]
        wq = np.round(W[nz, i] * 100) / 100
        # batch by quantized weight (VertexGroup.add takes a single float)
        for w in np.unique(wq):
            ids = nz[wq == w]
            vg.add(ids.tolist(), float(w), 'REPLACE')

add_weights(mesh, rig)
wcount = sum(1 for v in mesh.data.vertices if len(v.groups) > 0)
print("SKIN DONE, weighted verts:", wcount)

# ---------------- import FBX ----------------
bpy.ops.import_scene.fbx(filepath=FBX_PATH)
src = [o for o in scene.objects if o.type == 'ARMATURE' and o.name == 'Root'][0]
src_action = bpy.data.actions.get('Root|clip|Base_Layer')
scene.frame_start = int(src_action.frame_range[0])
scene.frame_end = int(src_action.frame_range[1])

# ---------------- IK setup on rig ----------------
def make_empty(name, matrix_world):
    e = bpy.data.objects.new(name, None)
    scene.collection.objects.link(e)
    e.empty_display_size = 0.03
    e.matrix_world = matrix_world
    return e

rest = {}
for name in BONES:
    rest[name] = rig.matrix_world @ arm_data.bones[name].matrix_local.copy()

targets = {}
for side, src_bone in (("l", "LeftHand"), ("r", "RightHand")):
    e = make_empty(f"ik_hand_{side}", rest[f"hand_{side}"])
    pb = rig.pose.bones[f"hand_{side}"]
    ik = pb.constraints.new('IK')
    ik.target = e
    ik.chain_count = 2
    ik.use_tail = False
    targets[side] = (e, src_bone)

bpy.context.view_layer.update()

# ---------------- retarget loop ----------------
def bone_world(armature_obj, bone_name):
    scene.frame_set(bpy.context.scene.frame_current)
    dg = bpy.context.evaluated_depsgraph_get()
    ea = armature_obj.evaluated_get(dg)
    m = ea.matrix_world @ ea.pose.bones[bone_name].matrix
    # strip the FBX 0.01 unit scale, otherwise matrix inversion explodes translations
    loc, rot, scl = m.decompose()
    return mathutils.Matrix.Translation(loc) @ rot.to_matrix().to_4x4()

def decompose_scaled(m, s):
    loc, rot, scl = m.decompose()
    return mathutils.Matrix.Translation(loc * s) @ rot.to_matrix().to_4x4()

# neutral = average hand-relative-to-chest over the clapping burst (oscillation center)
neutral = {}
acc = {src_bone: [mathutils.Vector((0, 0, 0)), 0] for _, src_bone in targets.values()}
for nf in range(NEUTRAL_START, NEUTRAL_END + 1):
    scene.frame_set(nf)
    C_f = bone_world(src, "Spine3")
    for _, src_bone in targets.values():
        H_f = bone_world(src, src_bone)
        acc[src_bone][0] += H_f.translation - C_f.translation
        acc[src_bone][1] += 1
neutral = {bn: (mathutils.Matrix.Translation(v / c)) for bn, (v, c) in acc.items()}

frame_map = []
for f in range(LOOP_START, LOOP_END + 1):
    scene.frame_set(f)
    for side, (e, src_bone) in targets.items():
        rel_n = neutral[src_bone].translation
        H_f = bone_world(src, src_bone)
        C_f = bone_world(src, "Spine3")
        rel_f = H_f.translation - C_f.translation
        # pure translation delta around the oscillation center (no rotation: FBX hand
        # rotations around the chest pivot explode on the short statue arms)
        offset = (rel_f - rel_n) * MOTION_SCALE
        if offset.length > MAX_OFFSET:
            offset *= MAX_OFFSET / offset.length
        hand_rest = rest[f"hand_{side}"]
        target_world = hand_rest.copy()
        # at LOOP_START the hands are still apart: blend from rest into oscillation
        intro = min(1.0, max(0.0, (f - LOOP_START) / 12.0))
        target_world.translation = hand_rest.translation + mathutils.Vector(offset) * intro
        # keep the hand rest orientation in rotation part (copy above) so IK only drives position
        e.matrix_world = target_world
        e.keyframe_insert('location', frame=f)
        e.keyframe_insert('rotation_euler', frame=f)
        e.keyframe_insert('scale', frame=f)
    frame_map.append(f)
    if f % 30 == 0:
        print("baked frame", f)

# ---------------- bake to FK action ----------------
scene.frame_start = LOOP_START
scene.frame_end = LOOP_END
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.select_all(action='SELECT')
bpy.ops.nla.bake(frame_start=LOOP_START, frame_end=LOOP_END, only_selected=False,
                 visual_keying=True, clear_constraints=False, use_current_action=False,
                 bake_types={'POSE'})
bpy.ops.object.mode_set(mode='OBJECT')

baked = rig.animation_data.action
baked.name = "Clap"
# remove IK + empties
for side, (e, _) in targets.items():
    pb = rig.pose.bones[f"hand_{side}"]
    for c in list(pb.constraints):
        pb.constraints.remove(c)
    bpy.data.objects.remove(e, do_unlink=True)
bpy.context.view_layer.update()

# ---------------- render check frames ----------------
cam_data = bpy.data.cameras.new('Cam')
cam = bpy.data.objects.new('Cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x = 600
scene.render.resolution_y = 600
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'

src.hide_set(True)
src.hide_render = True
target_pt = mathutils.Vector((0, -0.05, 0.6))
for tag, loc in {'side': mathutils.Vector((2.0, -0.3, 0.85)), 'front': mathutils.Vector((0.3, -2.0, 0.85))}.items():
    for f in (LOOP_START, 145, 175, LOOP_END):
        scene.frame_set(f)
        cam.location = loc
        d = target_pt - cam.location
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = f'/tmp/clap_{tag}_{f}.png'
        bpy.ops.render.render(write_still=True)
print("RENDER DONE")

# ---------------- export ----------------
bpy.ops.object.select_all(action='DESELECT')
mesh.select_set(True)
rig.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT_PATH,
    export_format='GLB',
    use_selection=True,
    export_apply=False,
    export_animations=True,
    export_skins=True,
    export_yup=True,
)
print("EXPORTED", OUT_PATH)
