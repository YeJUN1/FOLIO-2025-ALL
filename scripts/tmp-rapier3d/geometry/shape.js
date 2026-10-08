import { VectorOps, RotationOps } from "../math.js";
import { RawShape, RawShapeType } from "../raw.js";
import { ShapeContact } from "./contact.js";
import { PointProjection } from "./point.js";
import { RayIntersection } from "./ray.js";
import { ShapeCastHit } from "./toi.js";
export class Shape {
    /**
     * instant mode without cache
     */
    static fromRaw(rawSet, handle) {
        const rawType = rawSet.coShapeType(handle);
        let extents;
        let borderRadius;
        let vs;
        let indices;
        let halfHeight;
        let radius;
        let normal;
        switch (rawType) {
            case RawShapeType.Ball:
                return new Ball(rawSet.coRadius(handle));
            case RawShapeType.Cuboid:
                extents = rawSet.coHalfExtents(handle);
                // #if DIM3
                return new Cuboid(extents.x, extents.y, extents.z);
            // #endif
            case RawShapeType.RoundCuboid:
                extents = rawSet.coHalfExtents(handle);
                borderRadius = rawSet.coRoundRadius(handle);
                // #if DIM3
                return new RoundCuboid(extents.x, extents.y, extents.z, borderRadius);
            // #endif
            case RawShapeType.Capsule:
                halfHeight = rawSet.coHalfHeight(handle);
                radius = rawSet.coRadius(handle);
                return new Capsule(halfHeight, radius);
            case RawShapeType.Segment:
                vs = rawSet.coVertices(handle);
                // #if DIM3
                return new Segment(VectorOps.new(vs[0], vs[1], vs[2]), VectorOps.new(vs[3], vs[4], vs[5]));
            // #endif
            case RawShapeType.Polyline:
                vs = rawSet.coVertices(handle);
                indices = rawSet.coIndices(handle);
                return new Polyline(vs, indices);
            case RawShapeType.Triangle:
                vs = rawSet.coVertices(handle);
                // #if DIM3
                return new Triangle(VectorOps.new(vs[0], vs[1], vs[2]), VectorOps.new(vs[3], vs[4], vs[5]), VectorOps.new(vs[6], vs[7], vs[8]));
            // #endif
            case RawShapeType.RoundTriangle:
                vs = rawSet.coVertices(handle);
                borderRadius = rawSet.coRoundRadius(handle);
                // #if DIM3
                return new RoundTriangle(VectorOps.new(vs[0], vs[1], vs[2]), VectorOps.new(vs[3], vs[4], vs[5]), VectorOps.new(vs[6], vs[7], vs[8]), borderRadius);
            // #endif
            case RawShapeType.HalfSpace:
                normal = VectorOps.fromRaw(rawSet.coHalfspaceNormal(handle));
                return new HalfSpace(normal);
            case RawShapeType.Voxels:
                const vox_data = rawSet.coVoxelData(handle);
                const vox_size = rawSet.coVoxelSize(handle);
                return new Voxels(vox_data, vox_size);
            case RawShapeType.TriMesh:
                vs = rawSet.coVertices(handle);
                indices = rawSet.coIndices(handle);
                const tri_flags = rawSet.coTriMeshFlags(handle);
                return new TriMesh(vs, indices, tri_flags);
            case RawShapeType.HeightField:
                const scale = rawSet.coHeightfieldScale(handle);
                const heights = rawSet.coHeightfieldHeights(handle);
                // #if DIM3
                const nrows = rawSet.coHeightfieldNRows(handle);
                const ncols = rawSet.coHeightfieldNCols(handle);
                const hf_flags = rawSet.coHeightFieldFlags(handle);
                return new Heightfield(nrows, ncols, heights, scale, hf_flags);
            // #endif
            // #if DIM3
            case RawShapeType.ConvexPolyhedron:
                vs = rawSet.coVertices(handle);
                indices = rawSet.coIndices(handle);
                return new ConvexPolyhedron(vs, indices);
            case RawShapeType.RoundConvexPolyhedron:
                vs = rawSet.coVertices(handle);
                indices = rawSet.coIndices(handle);
                borderRadius = rawSet.coRoundRadius(handle);
                return new RoundConvexPolyhedron(vs, indices, borderRadius);
            case RawShapeType.Cylinder:
                halfHeight = rawSet.coHalfHeight(handle);
                radius = rawSet.coRadius(handle);
                return new Cylinder(halfHeight, radius);
            case RawShapeType.RoundCylinder:
                halfHeight = rawSet.coHalfHeight(handle);
                radius = rawSet.coRadius(handle);
                borderRadius = rawSet.coRoundRadius(handle);
                return new RoundCylinder(halfHeight, radius, borderRadius);
            case RawShapeType.Cone:
                halfHeight = rawSet.coHalfHeight(handle);
                radius = rawSet.coRadius(handle);
                return new Cone(halfHeight, radius);
            case RawShapeType.RoundCone:
                halfHeight = rawSet.coHalfHeight(handle);
                radius = rawSet.coRadius(handle);
                borderRadius = rawSet.coRoundRadius(handle);
                return new RoundCone(halfHeight, radius, borderRadius);
            // #endif
            default:
                throw new Error("unknown shape type: " + rawType);
        }
    }
    /**
     * Computes the time of impact between two moving shapes.
     * @param shapePos1 - The initial position of this sahpe.
     * @param shapeRot1 - The rotation of this shape.
     * @param shapeVel1 - The velocity of this shape.
     * @param shape2 - The second moving shape.
     * @param shapePos2 - The initial position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @param shapeVel2 - The velocity of the second shape.
     * @param targetDistance − If the shape moves closer to this distance from a collider, a hit
     *                         will be returned.
     * @param maxToi - The maximum time when the impact can happen.
     * @param stopAtPenetration - If set to `false`, the linear shape-cast won’t immediately stop if
     *   the shape is penetrating another shape at its starting point **and** its trajectory is such
     *   that it’s on a path to exit that penetration state.
     * @returns If the two moving shapes collider at some point along their trajectories, this returns the
     *  time at which the two shape collider as well as the contact information during the impact. Returns
     *  `null`if the two shapes never collide along their paths.
     */
    castShape(shapePos1, shapeRot1, shapeVel1, shape2, shapePos2, shapeRot2, shapeVel2, targetDistance, maxToi, stopAtPenetration) {
        let rawPos1 = VectorOps.intoRaw(shapePos1);
        let rawRot1 = RotationOps.intoRaw(shapeRot1);
        let rawVel1 = VectorOps.intoRaw(shapeVel1);
        let rawPos2 = VectorOps.intoRaw(shapePos2);
        let rawRot2 = RotationOps.intoRaw(shapeRot2);
        let rawVel2 = VectorOps.intoRaw(shapeVel2);
        let rawShape1 = this.intoRaw();
        let rawShape2 = shape2.intoRaw();
        let result = ShapeCastHit.fromRaw(null, rawShape1.castShape(rawPos1, rawRot1, rawVel1, rawShape2, rawPos2, rawRot2, rawVel2, targetDistance, maxToi, stopAtPenetration));
        rawPos1.free();
        rawRot1.free();
        rawVel1.free();
        rawPos2.free();
        rawRot2.free();
        rawVel2.free();
        rawShape1.free();
        rawShape2.free();
        return result;
    }
    /**
     * Tests if this shape intersects another shape.
     *
     * @param shapePos1 - The position of this shape.
     * @param shapeRot1 - The rotation of this shape.
     * @param shape2  - The second shape to test.
     * @param shapePos2 - The position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @returns `true` if the two shapes intersect, `false` if they don’t.
     */
    intersectsShape(shapePos1, shapeRot1, shape2, shapePos2, shapeRot2) {
        let rawPos1 = VectorOps.intoRaw(shapePos1);
        let rawRot1 = RotationOps.intoRaw(shapeRot1);
        let rawPos2 = VectorOps.intoRaw(shapePos2);
        let rawRot2 = RotationOps.intoRaw(shapeRot2);
        let rawShape1 = this.intoRaw();
        let rawShape2 = shape2.intoRaw();
        let result = rawShape1.intersectsShape(rawPos1, rawRot1, rawShape2, rawPos2, rawRot2);
        rawPos1.free();
        rawRot1.free();
        rawPos2.free();
        rawRot2.free();
        rawShape1.free();
        rawShape2.free();
        return result;
    }
    /**
     * Computes one pair of contact points between two shapes.
     *
     * @param shapePos1 - The initial position of this sahpe.
     * @param shapeRot1 - The rotation of this shape.
     * @param shape2 - The second shape.
     * @param shapePos2 - The initial position of the second shape.
     * @param shapeRot2 - The rotation of the second shape.
     * @param prediction - The prediction value, if the shapes are separated by a distance greater than this value, test will fail.
     * @returns `null` if the shapes are separated by a distance greater than prediction, otherwise contact details. The result is given in world-space.
     */
    contactShape(shapePos1, shapeRot1, shape2, shapePos2, shapeRot2, prediction) {
        let rawPos1 = VectorOps.intoRaw(shapePos1);
        let rawRot1 = RotationOps.intoRaw(shapeRot1);
        let rawPos2 = VectorOps.intoRaw(shapePos2);
        let rawRot2 = RotationOps.intoRaw(shapeRot2);
        let rawShape1 = this.intoRaw();
        let rawShape2 = shape2.intoRaw();
        let result = ShapeContact.fromRaw(rawShape1.contactShape(rawPos1, rawRot1, rawShape2, rawPos2, rawRot2, prediction));
        rawPos1.free();
        rawRot1.free();
        rawPos2.free();
        rawRot2.free();
        rawShape1.free();
        rawShape2.free();
        return result;
    }
    containsPoint(shapePos, shapeRot, point) {
        let rawPos = VectorOps.intoRaw(shapePos);
        let rawRot = RotationOps.intoRaw(shapeRot);
        let rawPoint = VectorOps.intoRaw(point);
        let rawShape = this.intoRaw();
        let result = rawShape.containsPoint(rawPos, rawRot, rawPoint);
        rawPos.free();
        rawRot.free();
        rawPoint.free();
        rawShape.free();
        return result;
    }
    projectPoint(shapePos, shapeRot, point, solid) {
        let rawPos = VectorOps.intoRaw(shapePos);
        let rawRot = RotationOps.intoRaw(shapeRot);
        let rawPoint = VectorOps.intoRaw(point);
        let rawShape = this.intoRaw();
        let result = PointProjection.fromRaw(rawShape.projectPoint(rawPos, rawRot, rawPoint, solid));
        rawPos.free();
        rawRot.free();
        rawPoint.free();
        rawShape.free();
        return result;
    }
    intersectsRay(ray, shapePos, shapeRot, maxToi) {
        let rawPos = VectorOps.intoRaw(shapePos);
        let rawRot = RotationOps.intoRaw(shapeRot);
        let rawRayOrig = VectorOps.intoRaw(ray.origin);
        let rawRayDir = VectorOps.intoRaw(ray.dir);
        let rawShape = this.intoRaw();
        let result = rawShape.intersectsRay(rawPos, rawRot, rawRayOrig, rawRayDir, maxToi);
        rawPos.free();
        rawRot.free();
        rawRayOrig.free();
        rawRayDir.free();
        rawShape.free();
        return result;
    }
    castRay(ray, shapePos, shapeRot, maxToi, solid) {
        let rawPos = VectorOps.intoRaw(shapePos);
        let rawRot = RotationOps.intoRaw(shapeRot);
        let rawRayOrig = VectorOps.intoRaw(ray.origin);
        let rawRayDir = VectorOps.intoRaw(ray.dir);
        let rawShape = this.intoRaw();
        let result = rawShape.castRay(rawPos, rawRot, rawRayOrig, rawRayDir, maxToi, solid);
        rawPos.free();
        rawRot.free();
        rawRayOrig.free();
        rawRayDir.free();
        rawShape.free();
        return result;
    }
    castRayAndGetNormal(ray, shapePos, shapeRot, maxToi, solid) {
        let rawPos = VectorOps.intoRaw(shapePos);
        let rawRot = RotationOps.intoRaw(shapeRot);
        let rawRayOrig = VectorOps.intoRaw(ray.origin);
        let rawRayDir = VectorOps.intoRaw(ray.dir);
        let rawShape = this.intoRaw();
        let result = RayIntersection.fromRaw(rawShape.castRayAndGetNormal(rawPos, rawRot, rawRayOrig, rawRayDir, maxToi, solid));
        rawPos.free();
        rawRot.free();
        rawRayOrig.free();
        rawRayDir.free();
        rawShape.free();
        return result;
    }
}
// #if DIM3
/**
 * An enumeration representing the type of a shape.
 */
export var ShapeType;
(function (ShapeType) {
    ShapeType[ShapeType["Ball"] = 0] = "Ball";
    ShapeType[ShapeType["Cuboid"] = 1] = "Cuboid";
    ShapeType[ShapeType["Capsule"] = 2] = "Capsule";
    ShapeType[ShapeType["Segment"] = 3] = "Segment";
    ShapeType[ShapeType["Polyline"] = 4] = "Polyline";
    ShapeType[ShapeType["Triangle"] = 5] = "Triangle";
    ShapeType[ShapeType["TriMesh"] = 6] = "TriMesh";
    ShapeType[ShapeType["HeightField"] = 7] = "HeightField";
    // Compound = 8,
    ShapeType[ShapeType["ConvexPolyhedron"] = 9] = "ConvexPolyhedron";
    ShapeType[ShapeType["Cylinder"] = 10] = "Cylinder";
    ShapeType[ShapeType["Cone"] = 11] = "Cone";
    ShapeType[ShapeType["RoundCuboid"] = 12] = "RoundCuboid";
    ShapeType[ShapeType["RoundTriangle"] = 13] = "RoundTriangle";
    ShapeType[ShapeType["RoundCylinder"] = 14] = "RoundCylinder";
    ShapeType[ShapeType["RoundCone"] = 15] = "RoundCone";
    ShapeType[ShapeType["RoundConvexPolyhedron"] = 16] = "RoundConvexPolyhedron";
    ShapeType[ShapeType["HalfSpace"] = 17] = "HalfSpace";
    ShapeType[ShapeType["Voxels"] = 18] = "Voxels";
})(ShapeType || (ShapeType = {}));
// NOTE: this **must** match the bits in the HeightFieldFlags on the rust side.
/**
 * Flags controlling the behavior of some operations involving heightfields.
 */
export var HeightFieldFlags;
(function (HeightFieldFlags) {
    /**
     * If set, a special treatment will be applied to contact manifold calculation to eliminate
     * or fix contacts normals that could lead to incorrect bumps in physics simulation (especially
     * on flat surfaces).
     *
     * This is achieved by taking into account adjacent triangle normals when computing contact
     * points for a given triangle.
     */
    HeightFieldFlags[HeightFieldFlags["FIX_INTERNAL_EDGES"] = 1] = "FIX_INTERNAL_EDGES";
})(HeightFieldFlags || (HeightFieldFlags = {}));
// #endif
// NOTE: this **must** match the TriMeshFlags on the rust side.
/**
 * Flags controlling the behavior of the triangle mesh creation and of some
 * operations involving triangle meshes.
 */
export var TriMeshFlags;
(function (TriMeshFlags) {
    // NOTE: these two flags are not really useful in JS.
    //
    // /**
    //  * If set, the half-edge topology of the trimesh will be computed if possible.
    //  */
    // HALF_EDGE_TOPOLOGY = 0b0000_0001,
    // /** If set, the half-edge topology and connected components of the trimesh will be computed if possible.
    //  *
    //  * Because of the way it is currently implemented, connected components can only be computed on
    //  * a mesh where the half-edge topology computation succeeds. It will no longer be the case in the
    //  * future once we decouple the computations.
    //  */
    // CONNECTED_COMPONENTS = 0b0000_0010,
    /**
     * If set, any triangle that results in a failing half-hedge topology computation will be deleted.
     */
    TriMeshFlags[TriMeshFlags["DELETE_BAD_TOPOLOGY_TRIANGLES"] = 4] = "DELETE_BAD_TOPOLOGY_TRIANGLES";
    /**
     * If set, the trimesh will be assumed to be oriented (with outward normals).
     *
     * The pseudo-normals of its vertices and edges will be computed.
     */
    TriMeshFlags[TriMeshFlags["ORIENTED"] = 8] = "ORIENTED";
    /**
     * If set, the duplicate vertices of the trimesh will be merged.
     *
     * Two vertices with the exact same coordinates will share the same entry on the
     * vertex buffer and the index buffer is adjusted accordingly.
     */
    TriMeshFlags[TriMeshFlags["MERGE_DUPLICATE_VERTICES"] = 16] = "MERGE_DUPLICATE_VERTICES";
    /**
     * If set, the triangles sharing two vertices with identical index values will be removed.
     *
     * Because of the way it is currently implemented, this methods implies that duplicate
     * vertices will be merged. It will no longer be the case in the future once we decouple
     * the computations.
     */
    TriMeshFlags[TriMeshFlags["DELETE_DEGENERATE_TRIANGLES"] = 32] = "DELETE_DEGENERATE_TRIANGLES";
    /**
     * If set, two triangles sharing three vertices with identical index values (in any order)
     * will be removed.
     *
     * Because of the way it is currently implemented, this methods implies that duplicate
     * vertices will be merged. It will no longer be the case in the future once we decouple
     * the computations.
     */
    TriMeshFlags[TriMeshFlags["DELETE_DUPLICATE_TRIANGLES"] = 64] = "DELETE_DUPLICATE_TRIANGLES";
    /**
     * If set, a special treatment will be applied to contact manifold calculation to eliminate
     * or fix contacts normals that could lead to incorrect bumps in physics simulation
     * (especially on flat surfaces).
     *
     * This is achieved by taking into account adjacent triangle normals when computing contact
     * points for a given triangle.
     *
     * /!\ NOT SUPPORTED IN THE 2D VERSION OF RAPIER.
     */
    TriMeshFlags[TriMeshFlags["FIX_INTERNAL_EDGES"] = 144] = "FIX_INTERNAL_EDGES";
})(TriMeshFlags || (TriMeshFlags = {}));
/**
 * A shape that is a sphere in 3D and a circle in 2D.
 */
export class Ball extends Shape {
    /**
     * Creates a new ball with the given radius.
     * @param radius - The balls radius.
     */
    constructor(radius) {
        super();
        this.type = ShapeType.Ball;
        this.radius = radius;
    }
    intoRaw() {
        return RawShape.ball(this.radius);
    }
}
export class HalfSpace extends Shape {
    /**
     * Creates a new halfspace delimited by an infinite plane.
     *
     * @param normal - The outward normal of the plane.
     */
    constructor(normal) {
        super();
        this.type = ShapeType.HalfSpace;
        this.normal = normal;
    }
    intoRaw() {
        let n = VectorOps.intoRaw(this.normal);
        let result = RawShape.halfspace(n);
        n.free();
        return result;
    }
}
/**
 * A shape that is a box in 3D and a rectangle in 2D.
 */
export class Cuboid extends Shape {
    // #if DIM3
    /**
     * Creates a new 3D cuboid.
     * @param hx - The half width of the cuboid.
     * @param hy - The half height of the cuboid.
     * @param hz - The half depth of the cuboid.
     */
    constructor(hx, hy, hz) {
        super();
        this.type = ShapeType.Cuboid;
        this.halfExtents = VectorOps.new(hx, hy, hz);
    }
    // #endif
    intoRaw() {
        // #if DIM3
        return RawShape.cuboid(this.halfExtents.x, this.halfExtents.y, this.halfExtents.z);
        // #endif
    }
}
/**
 * A shape that is a box in 3D and a rectangle in 2D, with round corners.
 */
export class RoundCuboid extends Shape {
    // #if DIM3
    /**
     * Creates a new 3D cuboid.
     * @param hx - The half width of the cuboid.
     * @param hy - The half height of the cuboid.
     * @param hz - The half depth of the cuboid.
     * @param borderRadius - The radius of the borders of this cuboid. This will
     *   effectively increase the half-extents of the cuboid by this radius.
     */
    constructor(hx, hy, hz, borderRadius) {
        super();
        this.type = ShapeType.RoundCuboid;
        this.halfExtents = VectorOps.new(hx, hy, hz);
        this.borderRadius = borderRadius;
    }
    // #endif
    intoRaw() {
        // #if DIM3
        return RawShape.roundCuboid(this.halfExtents.x, this.halfExtents.y, this.halfExtents.z, this.borderRadius);
        // #endif
    }
}
/**
 * A shape that is a capsule.
 */
export class Capsule extends Shape {
    /**
     * Creates a new capsule with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight, radius) {
        super();
        this.type = ShapeType.Capsule;
        this.halfHeight = halfHeight;
        this.radius = radius;
    }
    intoRaw() {
        return RawShape.capsule(this.halfHeight, this.radius);
    }
}
/**
 * A shape that is a segment.
 */
export class Segment extends Shape {
    /**
     * Creates a new segment shape.
     * @param a - The first point of the segment.
     * @param b - The second point of the segment.
     */
    constructor(a, b) {
        super();
        this.type = ShapeType.Segment;
        this.a = a;
        this.b = b;
    }
    intoRaw() {
        let ra = VectorOps.intoRaw(this.a);
        let rb = VectorOps.intoRaw(this.b);
        let result = RawShape.segment(ra, rb);
        ra.free();
        rb.free();
        return result;
    }
}
/**
 * A shape that is a segment.
 */
export class Triangle extends Shape {
    /**
     * Creates a new triangle shape.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     */
    constructor(a, b, c) {
        super();
        this.type = ShapeType.Triangle;
        this.a = a;
        this.b = b;
        this.c = c;
    }
    intoRaw() {
        let ra = VectorOps.intoRaw(this.a);
        let rb = VectorOps.intoRaw(this.b);
        let rc = VectorOps.intoRaw(this.c);
        let result = RawShape.triangle(ra, rb, rc);
        ra.free();
        rb.free();
        rc.free();
        return result;
    }
}
/**
 * A shape that is a triangle with round borders and a non-zero thickness.
 */
export class RoundTriangle extends Shape {
    /**
     * Creates a new triangle shape with round corners.
     *
     * @param a - The first point of the triangle.
     * @param b - The second point of the triangle.
     * @param c - The third point of the triangle.
     * @param borderRadius - The radius of the borders of this triangle. In 3D,
     *   this is also equal to half the thickness of the triangle.
     */
    constructor(a, b, c, borderRadius) {
        super();
        this.type = ShapeType.RoundTriangle;
        this.a = a;
        this.b = b;
        this.c = c;
        this.borderRadius = borderRadius;
    }
    intoRaw() {
        let ra = VectorOps.intoRaw(this.a);
        let rb = VectorOps.intoRaw(this.b);
        let rc = VectorOps.intoRaw(this.c);
        let result = RawShape.roundTriangle(ra, rb, rc, this.borderRadius);
        ra.free();
        rb.free();
        rc.free();
        return result;
    }
}
/**
 * A shape that is a triangle mesh.
 */
export class Polyline extends Shape {
    /**
     * Creates a new polyline shape.
     *
     * @param vertices - The coordinates of the polyline's vertices.
     * @param indices - The indices of the polyline's segments. If this is `null` or not provided, then
     *    the vertices are assumed to form a line strip.
     */
    constructor(vertices, indices) {
        super();
        this.type = ShapeType.Polyline;
        this.vertices = vertices;
        this.indices = indices !== null && indices !== void 0 ? indices : new Uint32Array(0);
    }
    intoRaw() {
        return RawShape.polyline(this.vertices, this.indices);
    }
}
/**
 * A shape made of voxels.
 */
export class Voxels extends Shape {
    /**
     * Creates a new shape made of voxels.
     *
     * @param data - Defines the set of voxels. If this is a `Int32Array` then
     *               each voxel is defined from its (signed) grid coordinates,
     *               with 3 (resp 2) contiguous integers per voxel in 3D (resp 2D).
     *               If this is a `Float32Array`, each voxel will be such that
     *               they contain at least one point from this array (where each
     *               point is defined from 3 (resp 2) contiguous numbers per point
     *               in 3D (resp 2D).
     * @param voxelSize - The size of each voxel.
     */
    constructor(data, voxelSize) {
        super();
        this.type = ShapeType.Voxels;
        this.data = data;
        this.voxelSize = voxelSize;
    }
    intoRaw() {
        let voxelSize = VectorOps.intoRaw(this.voxelSize);
        let result;
        if (this.data instanceof Int32Array) {
            result = RawShape.voxels(voxelSize, this.data);
        }
        else {
            result = RawShape.voxelsFromPoints(voxelSize, this.data);
        }
        voxelSize.free();
        return result;
    }
}
/**
 * A shape that is a triangle mesh.
 */
export class TriMesh extends Shape {
    /**
     * Creates a new triangle mesh shape.
     *
     * @param vertices - The coordinates of the triangle mesh's vertices.
     * @param indices - The indices of the triangle mesh's triangles.
     */
    constructor(vertices, indices, flags) {
        super();
        this.type = ShapeType.TriMesh;
        this.vertices = vertices;
        this.indices = indices;
        this.flags = flags;
    }
    intoRaw() {
        return RawShape.trimesh(this.vertices, this.indices, this.flags);
    }
}
// #if DIM3
/**
 * A shape that is a convex polygon.
 */
export class ConvexPolyhedron extends Shape {
    /**
     * Creates a new convex polygon shape.
     *
     * @param vertices - The coordinates of the convex polygon's vertices.
     * @param indices - The index buffer of this convex mesh. If this is `null`
     *   or `undefined`, the convex-hull of the input vertices will be computed
     *   automatically. Otherwise, it will be assumed that the mesh you provide
     *   is already convex.
     */
    constructor(vertices, indices) {
        super();
        this.type = ShapeType.ConvexPolyhedron;
        this.vertices = vertices;
        this.indices = indices;
    }
    intoRaw() {
        if (!!this.indices) {
            return RawShape.convexMesh(this.vertices, this.indices);
        }
        else {
            return RawShape.convexHull(this.vertices);
        }
    }
}
/**
 * A shape that is a convex polygon.
 */
export class RoundConvexPolyhedron extends Shape {
    /**
     * Creates a new convex polygon shape.
     *
     * @param vertices - The coordinates of the convex polygon's vertices.
     * @param indices - The index buffer of this convex mesh. If this is `null`
     *   or `undefined`, the convex-hull of the input vertices will be computed
     *   automatically. Otherwise, it will be assumed that the mesh you provide
     *   is already convex.
     * @param borderRadius - The radius of the borders of this convex polyhedron.
     */
    constructor(vertices, indices, borderRadius) {
        super();
        this.type = ShapeType.RoundConvexPolyhedron;
        this.vertices = vertices;
        this.indices = indices;
        this.borderRadius = borderRadius;
    }
    intoRaw() {
        if (!!this.indices) {
            return RawShape.roundConvexMesh(this.vertices, this.indices, this.borderRadius);
        }
        else {
            return RawShape.roundConvexHull(this.vertices, this.borderRadius);
        }
    }
}
/**
 * A shape that is a heightfield.
 */
export class Heightfield extends Shape {
    /**
     * Creates a new heightfield shape.
     *
     * @param nrows − The number of rows in the heights matrix.
     * @param ncols - The number of columns in the heights matrix.
     * @param heights - The heights of the heightfield along its local `y` axis,
     *                  provided as a matrix stored in column-major order.
     * @param scale - The dimensions of the heightfield's local `x,z` plane.
     */
    constructor(nrows, ncols, heights, scale, flags) {
        super();
        this.type = ShapeType.HeightField;
        this.nrows = nrows;
        this.ncols = ncols;
        this.heights = heights;
        this.scale = scale;
        this.flags = flags;
    }
    intoRaw() {
        let rawScale = VectorOps.intoRaw(this.scale);
        let rawShape = RawShape.heightfield(this.nrows, this.ncols, this.heights, rawScale, this.flags);
        rawScale.free();
        return rawShape;
    }
}
/**
 * A shape that is a 3D cylinder.
 */
export class Cylinder extends Shape {
    /**
     * Creates a new cylinder with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight, radius) {
        super();
        this.type = ShapeType.Cylinder;
        this.halfHeight = halfHeight;
        this.radius = radius;
    }
    intoRaw() {
        return RawShape.cylinder(this.halfHeight, this.radius);
    }
}
/**
 * A shape that is a 3D cylinder with round corners.
 */
export class RoundCylinder extends Shape {
    /**
     * Creates a new cylinder with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     * @param borderRadius - The radius of the borders of this cylinder.
     */
    constructor(halfHeight, radius, borderRadius) {
        super();
        this.type = ShapeType.RoundCylinder;
        this.borderRadius = borderRadius;
        this.halfHeight = halfHeight;
        this.radius = radius;
    }
    intoRaw() {
        return RawShape.roundCylinder(this.halfHeight, this.radius, this.borderRadius);
    }
}
/**
 * A shape that is a 3D cone.
 */
export class Cone extends Shape {
    /**
     * Creates a new cone with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     */
    constructor(halfHeight, radius) {
        super();
        this.type = ShapeType.Cone;
        this.halfHeight = halfHeight;
        this.radius = radius;
    }
    intoRaw() {
        return RawShape.cone(this.halfHeight, this.radius);
    }
}
/**
 * A shape that is a 3D cone with round corners.
 */
export class RoundCone extends Shape {
    /**
     * Creates a new cone with the given radius and half-height.
     * @param halfHeight - The balls half-height along the `y` axis.
     * @param radius - The balls radius.
     * @param borderRadius - The radius of the borders of this cone.
     */
    constructor(halfHeight, radius, borderRadius) {
        super();
        this.type = ShapeType.RoundCone;
        this.halfHeight = halfHeight;
        this.radius = radius;
        this.borderRadius = borderRadius;
    }
    intoRaw() {
        return RawShape.roundCone(this.halfHeight, this.radius, this.borderRadius);
    }
}
// #endif
//# sourceMappingURL=shape.js.map