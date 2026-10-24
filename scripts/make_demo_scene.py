"""Build the demo scene for task blender-render-v1. It runs inside Blender:

    blender -b --factory-startup --python scripts/make_demo_scene.py -- assets/demo_scene.blend

(scripts/demo.py and scripts/calibrate_render.py call this for you when the scene is missing.)

The scene is deliberately tiny so a CPU renders a frame in about a second: a red cube turning a
quarter turn over 12 frames on a grey floor, lit by a sun, 128 x 72 pixels, 32 Cycles samples,
with every resource packed into the .blend file.
"""

import math
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 32
scene.cycles.use_adaptive_sampling = False
scene.render.resolution_x = 128
scene.render.resolution_y = 72
scene.render.resolution_percentage = 100
scene.frame_start = 1
scene.frame_end = 12

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6

bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
floor = bpy.context.active_object
floor_mat = bpy.data.materials.new("Floor")
floor_mat.use_nodes = True
floor_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
floor.data.materials.append(floor_mat)

bpy.ops.mesh.primitive_cube_add(size=1.6, location=(0, 0, 0.8))
cube = bpy.context.active_object
cube_mat = bpy.data.materials.new("Cube")
cube_mat.use_nodes = True
cube_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.15, 0.1, 1)
cube.data.materials.append(cube_mat)
cube.rotation_euler = (0, 0, 0)
cube.keyframe_insert("rotation_euler", frame=1)
cube.rotation_euler = (0, 0, math.radians(90))
cube.keyframe_insert("rotation_euler", frame=12)

bpy.ops.object.light_add(type="SUN", location=(4, -4, 6))
bpy.context.active_object.data.energy = 3.0

bpy.ops.object.camera_add(location=(4.5, -4.5, 3.5))
camera = bpy.context.active_object
track = camera.constraints.new(type="TRACK_TO")
track.target = cube
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"
scene.camera = camera

bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=out)
print(f"saved {out}")
