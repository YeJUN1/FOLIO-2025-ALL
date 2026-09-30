import * as THREE from 'three/webgpu'
import { Game } from '../Game.js'

export class Spiderman
{
    constructor()
    {
        this.game = Game.getInstance()

        const resource = this.game.resources.spidermanModel
        const model = resource.scene

        // Prevent wrong culling with the skinned clap animation
        model.traverse((child) =>
        {
            if(child.isMesh)
                child.frustumCulled = false
        })

        // Scale the model to a sitting-ish height
        const targetHeight = 1.3
        let box = new THREE.Box3().setFromObject(model)
        const size = box.getSize(new THREE.Vector3())
        model.scale.setScalar(targetHeight / size.y)

        // Bottom of the model will sit on the bench seat, compute the offset to apply
        box = new THREE.Box3().setFromObject(model)
        const bottomOffset = - box.min.y

        // Sitting on the closest bench of the landing spawn (bench at 37.971, 35.979, yaw 42.6°)
        const position = { x: 37.971, z: 35.979 }
        const yaw = 0.7455
        model.rotation.y = yaw

        // Find the seat elevation with a physical ray
        const ray = new this.game.RAPIER.Ray(
            { x: position.x, y: 5, z: position.z },
            { x: 0, y: - 1, z: 0 }
        )
        const hit = this.game.physics.world.castRay(ray, 10, true)
        const seatY = hit ? 5 - hit.timeOfImpact : 0.6

        model.position.set(position.x, seatY + bottomOffset, position.z)

        // Visual only (no physical body, to keep the bench pushable)
        this.game.objects.add({
            model: model
        })

        /**
         * Clapping (Rokoko mocap, retargeted onto the statue's armature)
         * The statue claps a burst every now and then, then rests back on its cheeks
         */
        const clip = THREE.AnimationClip.findByName(resource.animations, 'Clap')

        if(clip)
        {
            this.mixer = new THREE.AnimationMixer(model)

            this.action = this.mixer.clipAction(clip)
            this.action.setLoop(THREE.LoopOnce, 1)
            this.action.clampWhenFinished = true

            // Ease back into the cheeks-resting pose once a burst is over
            this.mixer.addEventListener('finished', (event) =>
            {
                event.action.fadeOut(0.8)
            })

            this.nextClapAt = this.game.ticker.elapsed + 4 + Math.random() * 6

            this.game.ticker.events.on('tick', () =>
            {
                const elapsed = this.game.ticker.elapsed

                if(elapsed >= this.nextClapAt)
                {
                    this.action.reset()
                    this.action.fadeIn(0.6)
                    this.action.play()

                    this.nextClapAt = elapsed + clip.duration + 6 + Math.random() * 10
                }

                this.mixer.update(this.game.ticker.deltaScaled)
            }, 6)
        }
    }
}
