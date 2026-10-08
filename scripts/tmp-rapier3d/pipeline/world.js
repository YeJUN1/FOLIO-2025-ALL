import { BroadPhase, ColliderSet, NarrowPhase, } from "../geometry/index.js";
import { CCDSolver, IntegrationParameters, IslandManager, ImpulseJointSet, MultibodyJointSet, RigidBodySet, } from "../dynamics/index.js";
import { VectorOps } from "../math.js";
import { PhysicsPipeline } from "./physics_pipeline.js";
import { QueryPipeline } from "./query_pipeline.js";
import { SerializationPipeline } from "./serialization_pipeline.js";
import { DebugRenderBuffers, DebugRenderPipeline } from "./debug_render_pipeline.js";
import { KinematicCharacterController, PidController, } from "../control/index.js";
// #if DIM3
import { DynamicRayCastVehicleController } from "../control/index.js";
// #endif
/**
 * The physics world.
 *
 * This contains all the data-structures necessary for creating and simulating
 * bodies with contacts, joints, and external forces.
 */
export class World {
    // #endif
    /**
     * Release the WASM memory occupied by this physics world.
     *
     * All the fields of this physics world will be freed as well,
     * so there is no need to call their `.free()` methods individually.
     */
    free() {
        this.integrationParameters.free();
        this.islands.free();
        this.broadPhase.free();
        this.narrowPhase.free();
        this.bodies.free();
        this.colliders.free();
        this.impulseJoints.free();
        this.multibodyJoints.free();
        this.ccdSolver.free();
        this.queryPipeline.free();
        this.physicsPipeline.free();
        this.serializationPipeline.free();
        this.debugRenderPipeline.free();
        this.characterControllers.forEach((controller) => controller.free());
        this.pidControllers.forEach((controller) => controller.free());
        // #if DIM3
        this.vehicleControllers.forEach((controller) => controller.free());
        // #endif
        this.integrationParameters = undefined;
        this.islands = undefined;
        this.broadPhase = undefined;
        this.narrowPhase = undefined;
        this.bodies = undefined;
        this.colliders = undefined;
        this.ccdSolver = undefined;
        this.impulseJoints = undefined;
        this.multibodyJoints = undefined;
        this.queryPipeline = undefined;
        this.physicsPipeline = undefined;
        this.serializationPipeline = undefined;
        this.debugRenderPipeline = undefined;
        this.characterControllers = undefined;
        this.pidControllers = undefined;
        // #if DIM3
        this.vehicleControllers = undefined;
        // #endif
    }
    constructor(gravity, rawIntegrationParameters, rawIslands, rawBroadPhase, rawNarrowPhase, rawBodies, rawColliders, rawImpulseJoints, rawMultibodyJoints, rawCCDSolver, rawQueryPipeline, rawPhysicsPipeline, rawSerializationPipeline, rawDebugRenderPipeline) {
        this.gravity = gravity;
        this.integrationParameters = new IntegrationParameters(rawIntegrationParameters);
        this.islands = new IslandManager(rawIslands);
        this.broadPhase = new BroadPhase(rawBroadPhase);
        this.narrowPhase = new NarrowPhase(rawNarrowPhase);
        this.bodies = new RigidBodySet(rawBodies);
        this.colliders = new ColliderSet(rawColliders);
        this.impulseJoints = new ImpulseJointSet(rawImpulseJoints);
        this.multibodyJoints = new MultibodyJointSet(rawMultibodyJoints);
        this.ccdSolver = new CCDSolver(rawCCDSolver);
        this.queryPipeline = new QueryPipeline(rawQueryPipeline);
        this.physicsPipeline = new PhysicsPipeline(rawPhysicsPipeline);
        this.serializationPipeline = new SerializationPipeline(rawSerializationPipeline);
        this.debugRenderPipeline = new DebugRenderPipeline(rawDebugRenderPipeline);
        this.characterControllers = new Set();
        this.pidControllers = new Set();
        // #if DIM3
        this.vehicleControllers = new Set();
        // #endif
        this.impulseJoints.finalizeDeserialization(this.bodies);
        this.bodies.finalizeDeserialization(this.colliders);
        this.colliders.finalizeDeserialization(this.bodies);
    }
    static fromRaw(raw) {
        if (!raw)
            return null;
        return new World(VectorOps.fromRaw(raw.takeGravity()), raw.takeIntegrationParameters(), raw.takeIslandManager(), raw.takeBroadPhase(), raw.takeNarrowPhase(), raw.takeBodies(), raw.takeColliders(), raw.takeImpulseJoints(), raw.takeMultibodyJoints());
    }
    /**
     * Takes a snapshot of this world.
     *
     * Use `World.restoreSnapshot` to create a new physics world with a state identical to
     * the state when `.takeSnapshot()` is called.
     */
    takeSnapshot() {
        return this.serializationPipeline.serializeAll(this.gravity, this.integrationParameters, this.islands, this.broadPhase, this.narrowPhase, this.bodies, this.colliders, this.impulseJoints, this.multibodyJoints);
    }
    /**
     * Creates a new physics world from a snapshot.
     *
     * This new physics world will be an identical copy of the snapshoted physics world.
     */
    static restoreSnapshot(data) {
        let deser = new SerializationPipeline();
        return deser.deserializeAll(data);
    }
    /**
     * Computes all the lines (and their colors) needed to render the scene.
     *
     * @param filterFlags - Flags for excluding whole subsets of colliders from rendering.
     * @param filterPredicate - Any collider for which this closure returns `false` will be excluded from the
     *                          debug rendering.
     */
    debugRender(filterFlags, filterPredicate) {
        this.debugRenderPipeline.render(this.bodies, this.colliders, this.impulseJoints, this.multibodyJoints, this.narrowPhase, filterFlags, filterPredicate);
        return new DebugRenderBuffers(this.debugRenderPipeline.vertices, this.debugRenderPipeline.colors);
    }
    /**
     * Advance the simulation by one time step.
     *
     * All events generated by the physics engine are ignored.
     *
     * @param EventQueue - (optional) structure responsible for collecting
     *   events generated by the physics engine.
     */
    step(eventQueue, hooks) {
        this.physicsPipeline.step(this.gravity, this.integrationParameters, this.islands, this.broadPhase, this.narrowPhase, this.bodies, this.colliders, this.impulseJoints, this.multibodyJoints, this.ccdSolver, eventQueue, hooks);
        this.queryPipeline.update(this.colliders);
    }
    /**
     * Update colliders positions after rigid-bodies moved.
     *
     * When a rigid-body moves, the positions of the colliders attached to it need to be updated. This update is
     * generally automatically done at the beginning and the end of each simulation step with World.step.
     * If the positions need to be updated without running a simulation step this method can be called manually.
     */
    propagateModifiedBodyPositionsToColliders() {
        this.bodies.raw.propagateModifiedBodyPositionsToColliders(this.colliders.raw);
    }
    /**
     * Ensure subsequent scene queries take into account the collider positions set before this method is called.
     *
     * This does not step the physics simulation forward.
     */
    updateSceneQueries() {
        this.propagateModifiedBodyPositionsToColliders();
        this.queryPipeline.update(this.colliders);
    }
    /**
     * The current simulation timestep.
     */
    get timestep() {
        return this.integrationParameters.dt;
    }
    /**
     * Sets the new simulation timestep.
     *
     * The simulation timestep governs by how much the physics state of the world will
     * be integrated. A simulation timestep should:
     * - be as small as possible. Typical values evolve around 0.016 (assuming the chosen unit is milliseconds,
     * corresponds to the time between two frames of a game running at 60FPS).
     * - not vary too much during the course of the simulation. A timestep with large variations may
     * cause instabilities in the simulation.
     *
     * @param dt - The timestep length, in seconds.
     */
    set timestep(dt) {
        this.integrationParameters.dt = dt;
    }
    /**
     * The approximate size of most dynamic objects in the scene.
     *
     * See the documentation of the `World.lengthUnit` setter for further details.
     */
    get lengthUnit() {
        return this.integrationParameters.lengthUnit;
    }
    /**
     * The approximate size of most dynamic objects in the scene.
     *
     * This value is used internally to estimate some length-based tolerance. In particular, the
     * values `IntegrationParameters.allowedLinearError`,
     * `IntegrationParameters.maxPenetrationCorrection`,
     * `IntegrationParameters.predictionDistance`, `RigidBodyActivation.linearThreshold`
     * are scaled by this value implicitly.
     *
     * This value can be understood as the number of units-per-meter in your physical world compared
     * to a human-sized world in meter. For example, in a 2d game, if your typical object size is 100
     * pixels, set the `[`Self::length_unit`]` parameter to 100.0. The physics engine will interpret
     * it as if 100 pixels is equivalent to 1 meter in its various internal threshold.
     * (default `1.0`).
     */
    set lengthUnit(unitsPerMeter) {
        this.integrationParameters.lengthUnit = unitsPerMeter;
    }
    /**
     * The number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     */
    get numSolverIterations() {
        return this.integrationParameters.numSolverIterations;
    }
    /**
     * Sets the number of solver iterations run by the constraints solver for calculating forces (default: `4`).
     *
     * The greater this value is, the most rigid and realistic the physics simulation will be.
     * However a greater number of iterations is more computationally intensive.
     *
     * @param niter - The new number of solver iterations.
     */
    set numSolverIterations(niter) {
        this.integrationParameters.numSolverIterations = niter;
    }
    /**
     * Number of addition friction resolution iteration run during the last solver sub-step (default: `4`).
     */
    get numAdditionalFrictionIterations() {
        return this.integrationParameters.numAdditionalFrictionIterations;
    }
    /**
     * Sets the number of addition friction resolution iteration run during the last solver sub-step (default: `4`).
     *
     * The greater this value is, the most realistic friction will be.
     * However a greater number of iterations is more computationally intensive.
     *
     * @param niter - The new number of additional friction iterations.
     */
    set numAdditionalFrictionIterations(niter) {
        this.integrationParameters.numAdditionalFrictionIterations = niter;
    }
    /**
     * Number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     */
    get numInternalPgsIterations() {
        return this.integrationParameters.numInternalPgsIterations;
    }
    /**
     * Sets the Number of internal Project Gauss Seidel (PGS) iterations run at each solver iteration (default: `1`).
     *
     * Increasing this parameter will improve stability of the simulation. It will have a lesser effect than
     * increasing `numSolverIterations` but is also less computationally expensive.
     *
     * @param niter - The new number of internal PGS iterations.
     */
    set numInternalPgsIterations(niter) {
        this.integrationParameters.numInternalPgsIterations = niter;
    }
    /// Configures the integration parameters to match the old PGS solver
    /// from Rapier JS version <= 0.11.
    ///
    /// This solver was slightly faster than the new one but resulted
    /// in less stable joints and worse convergence rates.
    ///
    /// This should only be used for comparison purpose or if you are
    /// experiencing problems with the new solver.
    ///
    /// NOTE: this does not affect any `RigidBody.additional_solver_iterations` that will
    ///       still create solver iterations based on the new "small-steps" PGS solver.
    switchToStandardPgsSolver() {
        this.integrationParameters.switchToStandardPgsSolver();
    }
    /// Configures the integration parameters to match the new "small-steps" PGS solver
    /// from Rapier version >= 0.12.
    ///
    /// The "small-steps" PGS solver is the default one when creating the physics world. So
    /// calling this function is generally not needed unless `World.switch_to_standard_pgs_solver`
    /// was called.
    ///
    /// This solver results in more stable joints and significantly better convergence
    /// rates but is slightly slower in its default settings.
    switchToSmallStepsPgsSolver() {
        this.integrationParameters.switchToSmallStepsPgsSolver();
    }
    /// Configures the integration parameters to match the new "small-steps" PGS solver
    /// from Rapier version >= 0.12. Warmstarting is disabled.
    ///
    /// The "small-steps" PGS solver is the default one when creating the physics world. So
    /// calling this function is generally not needed unless `World.switch_to_standard_pgs_solver`
    /// was called.
    ///
    /// This solver results in more stable joints and significantly better convergence
    /// rates but is slightly slower in its default settings.
    switchToSmallStepsPgsSolverWithoutWarmstart() {
        this.integrationParameters.switchToSmallStepsPgsSolverWithoutWarmstart();
    }
    /**
     * Creates a new rigid-body from the given rigid-body descriptor.
     *
     * @param body - The description of the rigid-body to create.
     */
    createRigidBody(body) {
        return this.bodies.createRigidBody(this.colliders, body);
    }
    /**
     * Creates a new character controller.
     *
     * @param offset - The artificial gap added between the character’s chape and its environment.
     */
    createCharacterController(offset) {
        let controller = new KinematicCharacterController(offset, this.integrationParameters, this.bodies, this.colliders, this.queryPipeline);
        this.characterControllers.add(controller);
        return controller;
    }
    /**
     * Removes a character controller from this world.
     *
     * @param controller - The character controller to remove.
     */
    removeCharacterController(controller) {
        this.characterControllers.delete(controller);
        controller.free();
    }
    /**
     * Creates a new PID (Proportional-Integral-Derivative) controller.
     *
     * @param kp - The Proportional gain applied to the instantaneous linear position errors.
     *             This is usually set to a multiple of the inverse of simulation step time
     *             (e.g. `60` if the delta-time is `1.0 / 60.0`).
     * @param ki - The linear gain applied to the Integral part of the PID controller.
     * @param kd - The Derivative gain applied to the instantaneous linear velocity errors.
     *             This is usually set to a value in `[0.0, 1.0]` where `0.0` implies no damping
     *             (no correction of velocity errors) and `1.0` implies complete damping (velocity errors
     *             are corrected in a single simulation step).
     * @param axes - The axes affected by this controller.
     *               Only coordinate axes with a bit flags set to `true` will be taken into
     *               account when calculating the errors and corrections.
     */
    createPidController(kp, ki, kd, axes) {
        let controller = new PidController(this.integrationParameters, this.bodies, kp, ki, kd, axes);
        this.pidControllers.add(controller);
        return controller;
    }
    /**
     * Removes a PID controller from this world.
     *
     * @param controller - The PID controller to remove.
     */
    removePidController(controller) {
        this.pidControllers.delete(controller);
        controller.free();
    }
    // #if DIM3
    /**
     * Creates a new vehicle controller.
     *
     * @param chassis - The rigid-body used as the chassis of the vehicle controller. When the vehicle
     *                  controller is updated, it will change directly the rigid-body’s velocity. This
     *                  rigid-body must be a dynamic or kinematic-velocity-based rigid-body.
     */
    createVehicleController(chassis) {
        let controller = new DynamicRayCastVehicleController(chassis, this.bodies, this.colliders, this.queryPipeline);
        this.vehicleControllers.add(controller);
        return controller;
    }
    /**
     * Removes a vehicle controller from this world.
     *
     * @param controller - The vehicle controller to remove.
     */
    removeVehicleController(controller) {
        this.vehicleControllers.delete(controller);
        controller.free();
    }
    // #endif
    /**
     * Creates a new collider.
     *
     * @param desc - The description of the collider.
     * @param parent - The rigid-body this collider is attached to.
     */
    createCollider(desc, parent) {
        let parentHandle = parent ? parent.handle : undefined;
        return this.colliders.createCollider(this.bodies, desc, parentHandle);
    }
    /**
     * Creates a new impulse joint from the given joint descriptor.
     *
     * @param params - The description of the joint to create.
     * @param parent1 - The first rigid-body attached to this joint.
     * @param parent2 - The second rigid-body attached to this joint.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createImpulseJoint(params, parent1, parent2, wakeUp) {
        return this.impulseJoints.createJoint(this.bodies, params, parent1.handle, parent2.handle, wakeUp);
    }
    /**
     * Creates a new multibody joint from the given joint descriptor.
     *
     * @param params - The description of the joint to create.
     * @param parent1 - The first rigid-body attached to this joint.
     * @param parent2 - The second rigid-body attached to this joint.
     * @param wakeUp - Should the attached rigid-bodies be awakened?
     */
    createMultibodyJoint(params, parent1, parent2, wakeUp) {
        return this.multibodyJoints.createJoint(params, parent1.handle, parent2.handle, wakeUp);
    }
    /**
     * Retrieves a rigid-body from its handle.
     *
     * @param handle - The integer handle of the rigid-body to retrieve.
     */
    getRigidBody(handle) {
        return this.bodies.get(handle);
    }
    /**
     * Retrieves a collider from its handle.
     *
     * @param handle - The integer handle of the collider to retrieve.
     */
    getCollider(handle) {
        return this.colliders.get(handle);
    }
    /**
     * Retrieves an impulse joint from its handle.
     *
     * @param handle - The integer handle of the impulse joint to retrieve.
     */
    getImpulseJoint(handle) {
        return this.impulseJoints.get(handle);
    }
    /**
     * Retrieves an multibody joint from its handle.
     *
     * @param handle - The integer handle of the multibody joint to retrieve.
     */
    getMultibodyJoint(handle) {
        return this.multibodyJoints.get(handle);
    }
    /**
     * Removes the given rigid-body from this physics world.
     *
     * This will remove this rigid-body as well as all its attached colliders and joints.
     * Every other bodies touching or attached by joints to this rigid-body will be woken-up.
     *
     * @param body - The rigid-body to remove.
     */
    removeRigidBody(body) {
        if (this.bodies) {
            this.bodies.remove(body.handle, this.islands, this.colliders, this.impulseJoints, this.multibodyJoints);
        }
    }
    /**
     * Removes the given collider from this physics world.
     *
     * @param collider - The collider to remove.
     * @param wakeUp - If set to `true`, the rigid-body this collider is attached to will be awaken.
     */
    removeCollider(collider, wakeUp) {
        if (this.colliders) {
            this.colliders.remove(collider.handle, this.islands, this.bodies, wakeUp);
        }
    }
    /**
     * Removes the given impulse joint from this physics world.
     *
     * @param joint - The impulse joint to remove.
     * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
     */
    removeImpulseJoint(joint, wakeUp) {
        if (this.impulseJoints) {
            this.impulseJoints.remove(joint.handle, wakeUp);
        }
    }
    /**
     * Removes the given multibody joint from this physics world.
     *
     * @param joint - The multibody joint to remove.
     * @param wakeUp - If set to `true`, the rigid-bodies attached by this joint will be awaken.
     */
    removeMultibodyJoint(joint, wakeUp) {
        if (this.impulseJoints) {
            this.multibodyJoints.remove(joint.handle, wakeUp);
        }
    }
    /**
     * Applies the given closure to each collider managed by this physics world.
     *
     * @param f(collider) - The function to apply to each collider managed by this physics world. Called as `f(collider)`.
     */
    forEachCollider(f) {
        this.colliders.forEach(f);
    }
    /**
     * Applies the given closure to each rigid-body managed by this physics world.
     *
     * @param f(body) - The function to apply to each rigid-body managed by this physics world. Called as `f(collider)`.
     */
    forEachRigidBody(f) {
        this.bodies.forEach(f);
    }
    /**
     * Applies the given closure to each active rigid-body managed by this physics world.
     *
     * After a short time of inactivity, a rigid-body is automatically deactivated ("asleep") by
     * the physics engine in order to save computational power. A sleeping rigid-body never moves
     * unless it is moved manually by the user.
     *
     * @param f - The function to apply to each active rigid-body managed by this physics world. Called as `f(collider)`.
     */
    forEachActiveRigidBody(f) {
        this.bodies.forEachActiveRigidBody(this.islands, f);
    }
    /**
     * Find the closest intersection between a ray and the physics world.
     *
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param filter - The callback to filter out which collider will be hit.
     */
    castRay(ray, maxToi, solid, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        return this.queryPipeline.castRay(this.bodies, this.colliders, ray, maxToi, solid, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Find the closest intersection between a ray and the physics world.
     *
     * This also computes the normal at the hit point.
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     */
    castRayAndGetNormal(ray, maxToi, solid, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        return this.queryPipeline.castRayAndGetNormal(this.bodies, this.colliders, ray, maxToi, solid, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Cast a ray and collects all the intersections between a ray and the scene.
     *
     * @param ray - The ray to cast.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the length of the ray to `ray.dir.norm() * maxToi`.
     * @param solid - If `false` then the ray will attempt to hit the boundary of a shape, even if its
     *   origin already lies inside of a shape. In other terms, `true` implies that all shapes are plain,
     *   whereas `false` implies that all shapes are hollow for this ray-cast.
     * @param groups - Used to filter the colliders that can or cannot be hit by the ray.
     * @param callback - The callback called once per hit (in no particular order) between a ray and a collider.
     *   If this callback returns `false`, then the cast will stop and no further hits will be detected/reported.
     */
    intersectionsWithRay(ray, maxToi, solid, callback, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        this.queryPipeline.intersectionsWithRay(this.bodies, this.colliders, ray, maxToi, solid, callback, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Gets the handle of up to one collider intersecting the given shape.
     *
     * @param shapePos - The position of the shape used for the intersection test.
     * @param shapeRot - The orientation of the shape used for the intersection test.
     * @param shape - The shape used for the intersection test.
     * @param groups - The bit groups and filter associated to the ray, in order to only
     *   hit the colliders with collision groups compatible with the ray's group.
     */
    intersectionWithShape(shapePos, shapeRot, shape, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        let handle = this.queryPipeline.intersectionWithShape(this.bodies, this.colliders, shapePos, shapeRot, shape, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
        return handle != null ? this.colliders.get(handle) : null;
    }
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param point - The point to project.
     * @param solid - If this is set to `true` then the collider shapes are considered to
     *   be plain (if the point is located inside of a plain shape, its projection is the point
     *   itself). If it is set to `false` the collider shapes are considered to be hollow
     *   (if the point is located inside of an hollow shape, it is projected on the shape's
     *   boundary).
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPoint(point, solid, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        return this.queryPipeline.projectPoint(this.bodies, this.colliders, point, solid, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Find the projection of a point on the closest collider.
     *
     * @param point - The point to project.
     * @param groups - The bit groups and filter associated to the point to project, in order to only
     *   project on colliders with collision groups compatible with the ray's group.
     */
    projectPointAndGetFeature(point, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        return this.queryPipeline.projectPointAndGetFeature(this.bodies, this.colliders, point, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Find all the colliders containing the given point.
     *
     * @param point - The point used for the containment test.
     * @param groups - The bit groups and filter associated to the point to test, in order to only
     *   test on colliders with collision groups compatible with the ray's group.
     * @param callback - A function called with the handles of each collider with a shape
     *   containing the `point`.
     */
    intersectionsWithPoint(point, callback, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        this.queryPipeline.intersectionsWithPoint(this.bodies, this.colliders, point, this.colliders.castClosure(callback), filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Casts a shape at a constant linear velocity and retrieve the first collider it hits.
     * This is similar to ray-casting except that we are casting a whole shape instead of
     * just a point (the ray origin).
     *
     * @param shapePos - The initial position of the shape to cast.
     * @param shapeRot - The initial rotation of the shape to cast.
     * @param shapeVel - The constant velocity of the shape to cast (i.e. the cast direction).
     * @param shape - The shape to cast.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time-of-impact that can be reported by this cast. This effectively
     *   limits the distance traveled by the shape to `shapeVel.norm() * maxToi`.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @param groups - The bit groups and filter associated to the shape to cast, in order to only
     *   test on colliders with collision groups compatible with this group.
     */
    castShape(shapePos, shapeRot, shapeVel, shape, targetDistance, maxToi, stopAtPenetration, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        return this.queryPipeline.castShape(this.bodies, this.colliders, shapePos, shapeRot, shapeVel, shape, targetDistance, maxToi, stopAtPenetration, filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Retrieve all the colliders intersecting the given shape.
     *
     * @param shapePos - The position of the shape to test.
     * @param shapeRot - The orientation of the shape to test.
     * @param shape - The shape to test.
     * @param groups - The bit groups and filter associated to the shape to test, in order to only
     *   test on colliders with collision groups compatible with this group.
     * @param callback - A function called with the handles of each collider intersecting the `shape`.
     */
    intersectionsWithShape(shapePos, shapeRot, shape, callback, filterFlags, filterGroups, filterExcludeCollider, filterExcludeRigidBody, filterPredicate) {
        this.queryPipeline.intersectionsWithShape(this.bodies, this.colliders, shapePos, shapeRot, shape, this.colliders.castClosure(callback), filterFlags, filterGroups, filterExcludeCollider ? filterExcludeCollider.handle : null, filterExcludeRigidBody ? filterExcludeRigidBody.handle : null, this.colliders.castClosure(filterPredicate));
    }
    /**
     * Finds the handles of all the colliders with an AABB intersecting the given AABB.
     *
     * @param aabbCenter - The center of the AABB to test.
     * @param aabbHalfExtents - The half-extents of the AABB to test.
     * @param callback - The callback that will be called with the handles of all the colliders
     *                   currently intersecting the given AABB.
     */
    collidersWithAabbIntersectingAabb(aabbCenter, aabbHalfExtents, callback) {
        this.queryPipeline.collidersWithAabbIntersectingAabb(aabbCenter, aabbHalfExtents, this.colliders.castClosure(callback));
    }
    /**
     * Enumerates all the colliders potentially in contact with the given collider.
     *
     * @param collider1 - The second collider involved in the contact.
     * @param f - Closure that will be called on each collider that is in contact with `collider1`.
     */
    contactPairsWith(collider1, f) {
        this.narrowPhase.contactPairsWith(collider1.handle, this.colliders.castClosure(f));
    }
    /**
     * Enumerates all the colliders intersecting the given colliders, assuming one of them
     * is a sensor.
     */
    intersectionPairsWith(collider1, f) {
        this.narrowPhase.intersectionPairsWith(collider1.handle, this.colliders.castClosure(f));
    }
    /**
     * Iterates through all the contact manifolds between the given pair of colliders.
     *
     * @param collider1 - The first collider involved in the contact.
     * @param collider2 - The second collider involved in the contact.
     * @param f - Closure that will be called on each contact manifold between the two colliders. If the second argument
     *            passed to this closure is `true`, then the contact manifold data is flipped, i.e., methods like `localNormal1`
     *            actually apply to the `collider2` and fields like `localNormal2` apply to the `collider1`.
     */
    contactPair(collider1, collider2, f) {
        this.narrowPhase.contactPair(collider1.handle, collider2.handle, f);
    }
    /**
     * Returns `true` if `collider1` and `collider2` intersect and at least one of them is a sensor.
     * @param collider1 − The first collider involved in the intersection.
     * @param collider2 − The second collider involved in the intersection.
     */
    intersectionPair(collider1, collider2) {
        return this.narrowPhase.intersectionPair(collider1.handle, collider2.handle);
    }
}
//# sourceMappingURL=world.js.map