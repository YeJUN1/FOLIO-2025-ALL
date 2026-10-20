import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

// A bamboo fence enclosing a rectangular part of the map,
// built by repeating the Hunyuan3D generated fence segment as instances.
// Every run gets its own InstancedMesh so it can be frustum culled,
// and a chain of cuboid colliders stops the car from driving through.
export class PandoraFence
{
    constructor()
    {
        this.game = Game.getInstance()
        this.owner = 'peterzhang'

        // Enclosed area (world units, matching the region the user highlighted).
        // The z = - 14 edge used to be pulled in that far to keep the neighbours'
        // Suzhou garden (scene.json origin 29,-45, scale 5) outside the fence, which
        // left Altar (74.8, - 14.1) and Social (25.7, - 14.5) stranded just outside.
        // That garden has been removed, so the edge now runs at z = - 37 and both
        // locations, with their surroundings, end up inside.
        this.min = { x: 16, z: - 37 }
        this.max = { x: 86, z: 27.4 }

        // Fence height in meters (the segment is scaled up to reach it)
        this.height = 1.8

        // How deep the posts are pushed into the ground
        this.sink = 0.2

        // The single gap left in the fence, on the north side, so the car can
        // drive in and out while being blocked everywhere else. The car is 3m
        // wide including its bumper, so the opening has to be wider than that.
        this.gate = { x: 55, width: 6 }

        this.group = new THREE.Group()
        this.game.scene.add(this.group)

        this.colliders = []

        this.setPrototype()
        this.build()
        this.setPhysical()
    }

    setPrototype()
    {
        const prototype = this.game.resources.pandoraFenceModel.scene.clone(true)

        prototype.traverse((child) =>
        {
            if(child.isMesh)
            {
                child.castShadow = true
                child.receiveShadow = true

                child.material = child.material.clone()
                child.material.name = 'pandora_fence'

                this.mesh = child
            }
        })

        this.game.materials.updateObject(prototype)

        const box = new THREE.Box3().setFromObject(prototype)
        const size = box.getSize(new THREE.Vector3())

        // The segment runs along Z, so its Z size is the length of one unit
        this.scale = this.height / size.y
        this.segmentLength = size.z * this.scale
        this.thickness = size.x * this.scale
        this.bottomOffset = box.min.y * this.scale

        // The exported mesh node carries its own rotation, which instancing
        // doesn't apply on its own, so keep it to combine with each placement
        this.mesh.updateMatrix()
        this.meshMatrix = this.mesh.matrix.clone()
    }

    getGroundHeight(x, z)
    {
        // Read the terrain heightfield directly instead of raycasting: the
        // physics world hasn't stepped yet while the world is still being
        // built, so its raycast doesn't know about the terrain and would
        // return nothing at all.
        const heights = this.game.world.floor.physical.colliders[0].shape.heights
        const rows = Math.round(Math.sqrt(heights.length))
        const size = this.game.terrain.size
        const indexX = Math.round(((x / size) + 0.5) * (rows - 1))
        const indexZ = Math.round(((z / size) + 0.5) * (rows - 1))

        return heights[indexZ + indexX * rows]
    }

    build()
    {
        const { min, max, gate } = this
        const gateMin = gate.x - gate.width * 0.5
        const gateMax = gate.x + gate.width * 0.5

        // The scenery's basalt columns (x 21.7 -> 27.1, z 26.3 -> 33.8) straddle
        // the north edge, so the north stretch above them is pulled south of the
        // rocks: they end up outside the fence instead of being cut by it.
        const rockGapX = 30
        const rockGapZ = 25.5

        this.buildRun({ x: min.x, z: min.z }, { x: max.x, z: min.z })
        this.buildRun({ x: max.x, z: min.z }, { x: max.x, z: max.z })
        this.buildRun({ x: max.x, z: max.z }, { x: gateMax, z: max.z })
        this.buildRun({ x: gateMin, z: max.z }, { x: rockGapX, z: max.z })
        this.buildRun({ x: rockGapX, z: max.z }, { x: rockGapX, z: rockGapZ })
        this.buildRun({ x: rockGapX, z: rockGapZ }, { x: min.x, z: rockGapZ })
        this.buildRun({ x: min.x, z: rockGapZ }, { x: min.x, z: min.z })
    }

    buildRun(from, to)
    {
        const dx = to.x - from.x
        const dz = to.z - from.z
        const length = Math.hypot(dx, dz)

        // Segments are spread evenly along the run so they tile end to end
        const count = Math.max(1, Math.round(length / this.segmentLength))
        const step = length / count
        const rotationY = Math.atan2(dx, dz)
        const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY)

        const instance = new THREE.InstancedMesh(this.mesh.geometry, this.mesh.material, count)
        instance.castShadow = true
        instance.receiveShadow = true
        instance.frustumCulled = true

        const dummy = new THREE.Object3D()
        const matrix = new THREE.Matrix4()

        for(let i = 0; i < count; i++)
        {
            const ratio = (i + 0.5) / count
            const x = from.x + dx * ratio
            const z = from.z + dz * ratio
            const groundY = this.getGroundHeight(x, z)

            dummy.position.set(x, groundY - this.bottomOffset - this.sink, z)
            dummy.rotation.set(0, rotationY, 0)
            dummy.scale.setScalar(this.scale)
            dummy.updateMatrix()

            matrix.copy(this.meshMatrix).premultiply(dummy.matrix)
            instance.setMatrixAt(i, matrix)

            // Collider reaches well below the fence base so a dip in the
            // terrain can't leave a hole for the car to squeeze through.
            // Each one overlaps its neighbour, leaving no seam either.
            this.colliders.push({
                shape: 'cuboid',
                parameters: [
                    Math.max(0.25, this.thickness * 0.5),
                    this.height * 0.5 + 0.6,
                    step * 0.5 + 0.05,
                ],
                position: { x, y: groundY + this.height * 0.5 - 0.6, z },
                quaternion,
                category: 'object'
            })
        }

        instance.instanceMatrix.needsUpdate = true
        instance.computeBoundingSphere()

        this.group.add(instance)
    }

    setPhysical()
    {
        this.object = this.game.objects.add(
            null,
            {
                type: 'fixed',
                friction: 0.4,
                restitution: 0,
                colliders: this.colliders
            }
        )
    }
}
