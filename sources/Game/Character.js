import * as THREE from 'three/webgpu'
import { Game } from './Game.js'
import { Player } from './Player.js'
import { clamp, smallestAngle } from './utilities/maths.js'

export class Character
{
    constructor()
    {
        this.game = Game.getInstance()

        // State
        this.active = false
        this.grounded = false
        this.verticalVelocity = 0
        this.speed = 0
        this.animationSpeed = 0
        this.rotationY = 0
        this.jumpHeld = false
        this.fallStart = null
        this.current = null

        // Settings
        this.settings = {}
        this.settings.capsuleRadius = 0.3
        this.settings.capsuleHalfHeight = 0.6
        this.settings.walkSpeed = 1.6
        this.settings.jogSpeed = 4.2
        this.settings.sprintSpeed = 8.5
        this.settings.speedEasing = 8
        this.settings.rotationEasing = 12
        this.settings.jumpVelocity = 5.2
        this.settings.gravity = - 9.81
        this.settings.enterDistance = 5
        this.settings.facingOffset = 0

        this.upAxis = new THREE.Vector3(0, 1, 0)
        this.position = new THREE.Vector3()

        this.setVisual()
        this.setPhysical()
        this.setAnimations()
        this.setInputs()

        this.game.ticker.events.on('tick', () =>
        {
            this.updatePrePhysics()
        }, 2)

        this.game.ticker.events.on('tick', () =>
        {
            this.updatePostPhysics()
        }, 6)

        this.setDebug()
    }

    setVisual()
    {
        const model = this.game.resources.characterModel.scene

        // Prevent wrong culling with skinned meshes
        model.traverse((child) =>
        {
            if(child.isMesh)
                child.frustumCulled = false
        })

        this.object = this.game.objects.add({
            model: model
        })
        this.object3D = this.object.visual.object3D
        this.object3D.visible = false
    }

    setPhysical()
    {
        const spawnPosition = this.game.physicalVehicle.position

        const rigidBodyDesc = this.game.RAPIER.RigidBodyDesc
            .kinematicPositionBased()
            .setTranslation(spawnPosition.x, spawnPosition.y, spawnPosition.z)

        this.body = this.game.physics.world.createRigidBody(rigidBodyDesc)

        const colliderDesc = this.game.RAPIER.ColliderDesc
            .capsule(this.settings.capsuleHalfHeight, this.settings.capsuleRadius)
            .setCollisionGroups(this.game.physics.categories.object)

        this.collider = this.game.physics.world.createCollider(colliderDesc, this.body)

        this.body.setEnabled(false)

        this.controller = this.game.physics.world.createCharacterController(0.02)
        this.controller.setUp({ x: 0, y: 1, z: 0 })
        this.controller.enableAutostep(0.4, 0.2, true)
        this.controller.enableSnapToGround(0.5)
        this.controller.setMaxSlopeClimbAngle(0.9)
        this.controller.setMinSlopeSlideAngle(0.7)
        this.controller.setApplyImpulsesToDynamicBodies(true)
        this.controller.setCharacterMass(1)

        this.position.copy(spawnPosition)
    }

    setAnimations()
    {
        const resource = this.game.resources.characterModel

        this.mixer = new THREE.AnimationMixer(resource.scene)

        // Clip names from the Universal Animation Library
        this.clipNames = {
            idle: 'Idle_Loop',
            walk: 'Walk_Loop',
            jog: 'Jog_Fwd_Loop',
            sprint: 'Sprint_Loop',
            jumpStart: 'Jump_Start',
            jumpLoop: 'Jump_Loop',
            jumpLand: 'Jump_Land'
        }

        this.referenceSpeeds = {
            walk: this.settings.walkSpeed,
            jog: this.settings.jogSpeed,
            sprint: this.settings.sprintSpeed
        }

        this.animations = {}

        for(const name in this.clipNames)
        {
            const clip = THREE.AnimationClip.findByName(resource.animations, this.clipNames[name])

            if(! clip)
                continue

            const action = this.mixer.clipAction(clip)
            action.__name = name
            this.animations[name] = action
        }

        this.mixer.addEventListener('finished', (event) =>
        {
            const name = event.action.__name

            if(name === 'jumpStart')
            {
                if(this.current !== 'jumpStart')
                    return

                if(! this.grounded)
                    this.setAnimation('jumpLoop')
                else
                    this.updateLocomotion()
            }
            else if(name === 'jumpLand' && this.current === 'jumpLand')
            {
                this.updateLocomotion()
            }
        })
    }

    setInputs()
    {
        this.game.inputs.addActions([
            { name: 'characterToggle',   categories: [ 'wandering', 'walking' ], keys: [ 'Keyboard.KeyC' ] },
            { name: 'characterForward',  categories: [ 'walking' ], keys: [ 'Keyboard.ArrowUp', 'Keyboard.KeyW', 'Gamepad.up' ] },
            { name: 'characterBackward', categories: [ 'walking' ], keys: [ 'Keyboard.ArrowDown', 'Keyboard.KeyS', 'Gamepad.down' ] },
            { name: 'characterLeft',     categories: [ 'walking' ], keys: [ 'Keyboard.ArrowLeft', 'Keyboard.KeyA', 'Gamepad.left' ] },
            { name: 'characterRight',    categories: [ 'walking' ], keys: [ 'Keyboard.ArrowRight', 'Keyboard.KeyD', 'Gamepad.right' ] },
            { name: 'characterBoost',    categories: [ 'walking' ], keys: [ 'Keyboard.ShiftLeft', 'Keyboard.ShiftRight', 'Gamepad.circle' ] },
            { name: 'characterSlow',     categories: [ 'walking' ], keys: [ 'Keyboard.ControlLeft', 'Keyboard.ControlRight', 'Keyboard.KeyB', 'Gamepad.square' ] },
            { name: 'characterJump',     categories: [ 'walking' ], keys: [ 'Keyboard.Space', 'Gamepad.cross' ] },
        ])

        this.game.inputs.events.on('characterToggle', (action) =>
        {
            if(action.active)
                this.toggle()
        })
    }

    toggle()
    {
        if(this.active)
        {
            // Character is out => Try to enter the vehicle
            this.enterVehicle()
        }
        else
        {
            // In vehicle => Only exit when the player is in a normal state (e.g. not dying)
            if(this.game.player.state !== Player.STATE_DEFAULT)
                return

            this.exitVehicle()
        }
    }

    exitVehicle()
    {
        // Compute position on the left side of the vehicle
        const vehiclePosition = this.game.physicalVehicle.position
        const vehicleForward = this.game.physicalVehicle.forward
        const side = new THREE.Vector3(vehicleForward.z, 0, - vehicleForward.x).normalize()

        this.position.set(
            vehiclePosition.x + side.x * 2.1,
            vehiclePosition.y,
            vehiclePosition.z + side.z * 2.1
        )

        // Freeze vehicle
        this.game.physicalVehicle.deactivate()
        this.game.player.state = Player.STATE_LOCKED

        // Activate character
        this.active = true
        this.body.setEnabled(true)
        this.body.setTranslation(this.position, true)
        this.verticalVelocity = 0
        this.speed = 0
        this.animationSpeed = 0
        this.grounded = false
        this.fallStart = null
        this.rotationY = Math.atan2(vehicleForward.x, vehicleForward.z)
        this.object3D.visible = true
        this.object3D.position.set(
            this.position.x,
            this.position.y - this.settings.capsuleRadius - this.settings.capsuleHalfHeight,
            this.position.z
        )
        this.object3D.quaternion.setFromAxisAngle(this.upAxis, this.rotationY + this.settings.facingOffset)
        this.setAnimation('idle')

        // Inputs
        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('walking')

        // View > Focus point
        this.game.view.focusPoint.isTracking = true
        this.game.view.focusPoint.trackedPosition.copy(this.position)
    }

    enterVehicle()
    {
        // Distance to vehicle
        const vehiclePosition = this.game.physicalVehicle.position
        const distance = Math.hypot(vehiclePosition.x - this.position.x, vehiclePosition.z - this.position.z)

        if(distance > this.settings.enterDistance)
        {
            this.game.notifications.show(
                /* html */`
                    <div class="top">
                        <div class="title">Too far away</div>
                    </div>
                    <div class="bottom">
                        <div class="description">Get closer to your car</div>
                    </div>
                `,
                '',
                3,
                null,
                'characterTooFar'
            )
            return
        }

        // Deactivate character
        this.active = false
        this.object3D.visible = false
        this.body.setEnabled(false)
        this.speed = 0
        this.animationSpeed = 0
        this.verticalVelocity = 0

        // Unfreeze vehicle
        this.game.physicalVehicle.activate()
        this.game.player.state = Player.STATE_DEFAULT

        // Inputs
        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('wandering')
    }

    setAnimation(name, options = {})
    {
        if(this.current === name || ! this.animations[name])
            return

        const action = this.animations[name]
        const previousAction = this.animations[this.current]
        const loop = typeof options.loop !== 'undefined' ? options.loop : true
        const fade = typeof options.fade !== 'undefined' ? options.fade : 0.2
        const timeScale = typeof options.timeScale !== 'undefined' ? options.timeScale : 1

        action.reset()
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
        action.clampWhenFinished = ! loop
        action.timeScale = timeScale
        action.setEffectiveWeight(1)
        action.fadeIn(fade)
        action.play()

        if(previousAction)
            previousAction.fadeOut(fade)

        this.current = name
    }

    updateLocomotion()
    {
        const speed = this.animationSpeed

        let name = 'idle'

        if(speed > this.settings.jogSpeed + 2.4)
            name = 'sprint'
        else if(speed > this.settings.walkSpeed + 1.3)
            name = 'jog'
        else if(speed > 0.15)
            name = 'walk'

        this.setAnimation(name)

        if(name !== 'idle' && this.animations[name])
            this.animations[name].timeScale = clamp(speed / this.referenceSpeeds[name], 0.5, 1.75)
    }

    updatePrePhysics()
    {
        if(! this.active)
            return

        const delta = this.game.ticker.deltaScaled

        /**
         * Inputs
         */
        let inputX = 0
        let inputY = 0

        if(this.game.inputs.actions.get('characterForward').active)
            inputY += 1
        if(this.game.inputs.actions.get('characterBackward').active)
            inputY -= 1
        if(this.game.inputs.actions.get('characterRight').active)
            inputX += 1
        if(this.game.inputs.actions.get('characterLeft').active)
            inputX -= 1

        // Gamepad joystick
        const joystick = this.game.inputs.gamepad.joysticks.left

        if(inputX === 0 && inputY === 0 && joystick.active)
        {
            inputX = joystick.safeX
            inputY = - joystick.safeY
        }

        // Direction (relative to the camera)
        const inputLength = Math.hypot(inputX, inputY)
        let direction = null
        let targetSpeed = 0

        if(inputLength > 0.01)
        {
            const theta = this.game.view.spherical.theta
            const forward = new THREE.Vector3(- Math.sin(theta), 0, - Math.cos(theta))
            const right = new THREE.Vector3(Math.cos(theta), 0, - Math.sin(theta))

            direction = forward.multiplyScalar(inputY / inputLength).add(right.multiplyScalar(inputX / inputLength)).normalize()

            // Speed
            if(this.game.inputs.actions.get('characterBoost').active)
                targetSpeed = this.settings.sprintSpeed
            else if(this.game.inputs.actions.get('characterSlow').active)
                targetSpeed = this.settings.walkSpeed
            else
                targetSpeed = this.settings.jogSpeed

            targetSpeed *= Math.min(1, inputLength)
        }

        /**
         * Speed
         */
        this.speed += (targetSpeed - this.speed) * Math.min(1, delta * this.settings.speedEasing)

        if(this.speed < 0.005)
            this.speed = 0

        /**
         * Rotation
         */
        if(direction)
        {
            const targetRotationY = Math.atan2(direction.x, direction.z)

            this.rotationY += smallestAngle(this.rotationY, targetRotationY) * Math.min(1, delta * this.settings.rotationEasing)
        }

        /**
         * Jump
         */
        const jumpAction = this.game.inputs.actions.get('characterJump')

        if(this.grounded && this.verticalVelocity <= 0 && jumpAction.active && ! this.jumpHeld)
        {
            this.verticalVelocity = this.settings.jumpVelocity
            this.grounded = false
            this.fallStart = this.game.ticker.elapsed

            this.setAnimation('jumpStart', { loop: false, fade: 0.1, timeScale: 1.6 })
        }

        this.jumpHeld = jumpAction.active

        /**
         * Gravity
         */
        this.verticalVelocity += this.settings.gravity * delta

        /**
         * Collisions
         */
        const desiredMovement = {
            x: direction ? direction.x * this.speed * delta : 0,
            y: this.verticalVelocity * delta,
            z: direction ? direction.z * this.speed * delta : 0
        }

        this.controller.computeColliderMovement(this.collider, desiredMovement)
        const correctedMovement = this.controller.computedMovement()

        /**
         * Grounded
         */
        const grounded = this.controller.computedGrounded()

        if(grounded && this.verticalVelocity <= 0)
        {
            if(! this.grounded)
                this.onLand()

            this.verticalVelocity = 0
            this.grounded = true
        }
        else
        {
            this.grounded = false
        }

        if(this.grounded)
            this.fallStart = null
        else if(this.fallStart === null)
            this.fallStart = this.game.ticker.elapsed

        /**
         * Animation speed (theoretical speed capped by actual movement)
         */
        const actualSpeed = Math.hypot(correctedMovement.x, correctedMovement.z) / delta
        this.animationSpeed += (Math.min(actualSpeed, this.speed) - this.animationSpeed) * Math.min(1, delta * 10)

        /**
         * Apply to body
         */
        const translation = this.body.translation()
        this.body.setNextKinematicTranslation({
            x: translation.x + correctedMovement.x,
            y: translation.y + correctedMovement.y,
            z: translation.z + correctedMovement.z
        })
    }

    updatePostPhysics()
    {
        if(! this.active)
            return

        /**
         * Animations
         */
        this.mixer.update(this.game.ticker.deltaScaled)

        if(this.grounded)
        {
            if(this.current !== 'jumpStart' && this.current !== 'jumpLand')
                this.updateLocomotion()
        }
        else if(this.current !== 'jumpStart' && this.current !== 'jumpLand' && this.current !== 'jumpLoop')
        {
            const fallDuration = this.fallStart !== null ? this.game.ticker.elapsed - this.fallStart : 0

            if(fallDuration > 0.5)
                this.setAnimation('jumpLoop')
        }

        /**
         * Visual
         */
        const translation = this.body.translation()

        this.position.set(translation.x, translation.y, translation.z)

        this.object3D.position.set(
            translation.x,
            translation.y - this.settings.capsuleRadius - this.settings.capsuleHalfHeight,
            translation.z
        )
        this.object3D.quaternion.setFromAxisAngle(this.upAxis, this.rotationY + this.settings.facingOffset)

        /**
         * View > Focus point
         */
        this.game.view.focusPoint.trackedPosition.copy(this.position)

        /**
         * Tracks > Focus point
         */
        this.game.tracks.focusPoint.set(this.position.x, this.position.z)
    }

    onLand()
    {
        const fallDuration = this.fallStart !== null ? this.game.ticker.elapsed - this.fallStart : 0

        if(this.current === 'jumpStart' || this.current === 'jumpLoop' || fallDuration > 0.4)
            this.setAnimation('jumpLand', { loop: false, fade: 0.15, timeScale: 1.6 })
    }

    setDebug()
    {
        if(this.game.debug.active)
        {
            const debugPanel = this.game.debug.panel.addFolder({
                title: '🚶 Character',
                expanded: false,
            })

            debugPanel.addBinding(this.settings, 'walkSpeed', { min: 0, max: 16, step: 0.1 })
            debugPanel.addBinding(this.settings, 'jogSpeed', { min: 0, max: 16, step: 0.1 })
            debugPanel.addBinding(this.settings, 'sprintSpeed', { min: 0, max: 16, step: 0.1 })
            debugPanel.addBinding(this.settings, 'jumpVelocity', { min: 0, max: 12, step: 0.1 })
            debugPanel.addButton({ title: 'Toggle' }).on('click', () =>
            {
                this.toggle()
            })
        }
    }
}
