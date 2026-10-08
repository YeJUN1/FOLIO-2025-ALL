import { RawPidController } from "../raw.js";
import { RotationOps, VectorOps } from "../math.js";
// TODO: unify with the JointAxesMask
/**
 * An enum representing the possible joint axes controlled by a PidController.
 * They can be ORed together, like:
 * PidAxesMask.LinX || PidAxesMask.LinY
 * to get a pid controller that only constraints the translational X and Y axes.
 *
 * Possible axes are:
 *
 * - `X`: X translation axis
 * - `Y`: Y translation axis
 * - `Z`: Z translation axis
 * - `AngX`: X angular rotation axis (3D only)
 * - `AngY`: Y angular rotation axis (3D only)
 * - `AngZ`: Z angular rotation axis
 */
export var PidAxesMask;
(function (PidAxesMask) {
    PidAxesMask[PidAxesMask["None"] = 0] = "None";
    PidAxesMask[PidAxesMask["LinX"] = 1] = "LinX";
    PidAxesMask[PidAxesMask["LinY"] = 2] = "LinY";
    PidAxesMask[PidAxesMask["LinZ"] = 4] = "LinZ";
    // #if DIM3
    PidAxesMask[PidAxesMask["AngX"] = 8] = "AngX";
    PidAxesMask[PidAxesMask["AngY"] = 16] = "AngY";
    // #endif
    PidAxesMask[PidAxesMask["AngZ"] = 32] = "AngZ";
    // #if DIM3
    PidAxesMask[PidAxesMask["AllLin"] = 7] = "AllLin";
    PidAxesMask[PidAxesMask["AllAng"] = 56] = "AllAng";
    // #endif
    PidAxesMask[PidAxesMask["All"] = 63] = "All";
})(PidAxesMask || (PidAxesMask = {}));
/**
 * A controller for controlling dynamic bodies using the
 * Proportional-Integral-Derivative correction model.
 */
export class PidController {
    constructor(params, bodies, kp, ki, kd, axes) {
        this.params = params;
        this.bodies = bodies;
        this.raw = new RawPidController(kp, ki, kd, axes);
    }
    /** @internal */
    free() {
        if (!!this.raw) {
            this.raw.free();
        }
        this.raw = undefined;
    }
    setKp(kp, axes) {
        this.raw.set_kp(kp, axes);
    }
    setKi(ki, axes) {
        this.raw.set_kp(ki, axes);
    }
    setKd(kd, axes) {
        this.raw.set_kp(kd, axes);
    }
    setAxes(axes) {
        this.raw.set_axes_mask(axes);
    }
    resetIntegrals() {
        this.raw.reset_integrals();
    }
    applyLinearCorrection(body, targetPosition, targetLinvel) {
        let rawPos = VectorOps.intoRaw(targetPosition);
        let rawVel = VectorOps.intoRaw(targetLinvel);
        this.raw.apply_linear_correction(this.params.dt, this.bodies.raw, body.handle, rawPos, rawVel);
        rawPos.free();
        rawVel.free();
    }
    // #if DIM3
    applyAngularCorrection(body, targetRotation, targetAngVel) {
        let rawPos = RotationOps.intoRaw(targetRotation);
        let rawVel = VectorOps.intoRaw(targetAngVel);
        this.raw.apply_angular_correction(this.params.dt, this.bodies.raw, body.handle, rawPos, rawVel);
        rawPos.free();
        rawVel.free();
    }
    // #endif
    linearCorrection(body, targetPosition, targetLinvel) {
        let rawPos = VectorOps.intoRaw(targetPosition);
        let rawVel = VectorOps.intoRaw(targetLinvel);
        let correction = this.raw.linear_correction(this.params.dt, this.bodies.raw, body.handle, rawPos, rawVel);
        rawPos.free();
        rawVel.free();
        return VectorOps.fromRaw(correction);
    }
    // #if DIM3
    angularCorrection(body, targetRotation, targetAngVel) {
        let rawPos = RotationOps.intoRaw(targetRotation);
        let rawVel = VectorOps.intoRaw(targetAngVel);
        let correction = this.raw.angular_correction(this.params.dt, this.bodies.raw, body.handle, rawPos, rawVel);
        rawPos.free();
        rawVel.free();
        return VectorOps.fromRaw(correction);
    }
}
//# sourceMappingURL=pid_controller.js.map