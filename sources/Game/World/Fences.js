import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'
import { InstancedGroup } from '../InstancedGroup.js'
import { fenceEnclosureUnits } from '../../data/fenceEnclosure.js'

export class Fences
{
    constructor()
    {
        this.game = Game.getInstance()

        // Base and references
        const [ base, references ] = InstancedGroup.getBaseAndReferencesFromInstances(this.game.resources.fencesModel.scene.children)
        base.castShadow = true
        base.receiveShadow = true
        base.frustumCulled = true

        // Descriptions > To extract colliders
        const descriptions = this.game.objects.getFromModel(base, {}, {})
        
        // Update materials 
        this.game.materials.updateObject(base)

        // Setup base
        for(const child of base.children)
            child.name = child.name.replace(/[0-9]+$/i, '') // Set clear name to retrieve it later as instances

        // Objects
        this.objects = []
        for(const reference of references)
        {
            this.objects.push(this.game.objects.add(
                {
                    model: reference,
                    updateMaterials: false,
                    parent: null,
                },
                {
                    type: 'dynamic',
                    position: reference.position,
                    rotation: reference.quaternion,
                    friction: 0.7,
                    mass: 0.1,
                    sleeping: true,
                    colliders: descriptions[1].colliders,
                    waterGravityMultiplier: - 1,
                    contactThreshold: 10,
                    onCollision: (force, position) =>
                    {
                        // this.game.audio.groups.get('hitMetal').playRandomNext(force, position)
                    }
                },
            ))
        }

        // Fenced area drawn on the map (baked by scripts/fence-enclosure.mjs --strict --write)
        // Visual: pushed in the references so the InstancedGroup draws everything in one shot
        // Physical: a single fixed body carrying one cuboid per unit, because that many knockable
        //           dynamic bodies would be tested every tick by Objects.update()
        this.enclosure = this.setEnclosure(references, descriptions[1].colliders[0])

        // Instanced group
        this.instancedGroup = new InstancedGroup(references, base)

        // Tick update
        this.game.ticker.events.on('tick', () =>
        {
            for(const object of this.objects)
            {
                if(!object.physical.body.isSleeping() && object.physical.body.isEnabled())
                    object.visual.object3D.needsUpdate = true
            }
        }, 10)
    }

    setEnclosure(_references, _colliderTemplate)
    {
        const colliders = []
        const axis = new THREE.Vector3(0, 1, 0)

        for(const [ x, y, z, yaw ] of fenceEnclosureUnits)
        {
            const reference = new THREE.Object3D()
            reference.position.set(x, y, z)
            reference.rotation.set(0, yaw, 0)
            reference.needsUpdate = true
            _references.push(reference)

            // Colliders are relative to the body, which stays at the world origin
            const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, yaw)
            const translation = _colliderTemplate.position.clone().applyQuaternion(quaternion)

            colliders.push({
                shape: _colliderTemplate.shape,
                parameters: _colliderTemplate.parameters,
                position: { x: x + translation.x, y: y + translation.y, z: z + translation.z },
                quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
            })
        }

        return this.game.objects.add(null, {
            type: 'fixed',
            friction: 0.7,
            colliders: colliders,
        })
    }
}