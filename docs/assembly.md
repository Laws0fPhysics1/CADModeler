# Assemblies: data model and kinematics (contract)

The assembly agent (`src/assembly.js`, UI in main.js / viewport.js) and the robot-export agent (`src/robotexport.js`) both build against this. Change it only by agreement, and keep this file in step with the code.

## Model

CAD Modeler stays a single design file. An **assembly** is a set of **components**, each one a group of bodies from the timeline, plus **joints** between components (Fusion-style). Bodies keep the coordinates they were modelled in; a component's world placement is a 4×4 transform applied on top, so moving or articulating a component never rebuilds geometry.

```jsonc
doc.assembly = {
  "components": [
    {
      "id": "c1", "name": "Base",
      "bodies": ["Body1", "Body3"],          // body ids from the timeline (state.bodies[].id)
      "grounded": true,                      // fixed to the world; at least one component should be
      "transform": [16 numbers],             // free placement (column-major 4x4, mm), used when the component
                                             // is not driven by a joint (Move command). Identity = as modelled.
      "color": null                          // optional tint in the browser
    }
  ],
  "joints": [
    {
      "id": "j1", "name": "Shoulder",
      "type": "rigid" | "revolute" | "slider" | "cylindrical" | "ball",
      "parent": "c1", "child": "c2",
      "frameParent": [16 numbers],           // joint frame in the PARENT's modelled coordinates (mm; z = joint axis)
      "frameChild":  [16 numbers],           // joint frame in the CHILD's modelled coordinates (mm; z = joint axis)
      "value": 0,                            // current position: degrees (revolute / cylindrical rotation) or mm (slider)
      "value2": 0,                           // cylindrical: the slide in mm
      "limits": { "lower": null, "upper": null },   // same units as value; null = unlimited (revolute -> continuous)
      "effort": null, "velocity": null,      // optional, for robot export (N·m or N; deg/s or mm/s)
      "ui": {                                // optional, UI only (re-editing in the Joint dialog); exporters ignore it
        "baseParent": [16], "baseChild": [16],   // frames as snapped, before Angle / Offset / Flip
        "angle": 0, "offset": 0, "flip": false   // frameParent = baseParent · rotZ(angle) · transZ(offset);
      }                                          // frameChild = flip ? baseChild · rotX(180) : baseChild
    }
  ],
  "links": [                                 // motion links (gears, rack and pinion); optional, [] when absent
    {
      "id": "ml1", "name": "Motion Link 1",
      "type": "gear" | "rack" | "ratio",
      "driver": "j1", "driven": "j2",        // joint ids; the driven joint's own `value` is ignored
      "ratio": -0.5,                         // driven.value = offset + ratio * driver.value (deg/deg, or mm/deg for a rack)
      "offset": 0,
      "teeth": [20, 40]                      // optional, display only
    }
  ]
}
```

Motion links are resolved before placement (`resolveLinks`): a joint can be driven by one link, links may chain (gear trains) but not loop, and the computed value is clamped to the driven joint's limits. Bad links are reported in `errors` as `{link, message}` and skipped. Components with `keep: true` (Gear Frame, planetary Carrier) are mounts and are not pruned when empty. Robot export writes each link as a URDF `<mimic>` (multiplier converted to rad/rad or m/rad).

Bodies that belong to no component are the implicit **root** of the design: they are fixed, and the export treats them as part of the base link.

## Kinematics

Let `T(c)` be component c's world transform. Then:

* grounded: `T(c) = c.transform`
* joint child: `T(child) = T(parent) · frameParent · M(joint) · inverse(frameChild)`
* not grounded and not the child of any joint: `T(c) = c.transform`

`M(joint)` is the joint motion in the joint frame:

| type | M |
|---|---|
| rigid | identity |
| revolute | rotation about +z by `value` degrees |
| slider | translation along +z by `value` mm |
| cylindrical | rotation about z by `value`, then translation along z by `value2` |
| ball | identity for now (three rotations later) |

Each component is the child of at most one joint, and joints form a tree (no loops) whose roots are grounded or free components. `assembly.js` validates this and reports the offending joint.

Validation rules in `solveAssembly` (each bad joint is skipped and reported in `errors`; the child then sits at its own `transform`):
* parent or child component missing, or parent === child;
* the child is **grounded** (a grounded component never moves);
* the child already has a parent joint (the first joint in the list wins);
* a loop: the joint that closes it is dropped.

`value` is clamped to `limits` (lower / upper, either may be null) before `M` is built; `value2` is not limited. A body id listed in a component but missing from the timeline (rolled back, removed) is ignored when placing bodies, never fatal; with `opts.bodyIds` the solver reports it (`{component, message, warning?}`). Components are never pruned automatically, so rolling the marker forward brings those bodies back into place.

When a joint is created, `frameParent` and `frameChild` come from the two picked geometry points, both in modelled coordinates (`snapToGeometry`):

| pick | origin | z |
|---|---|---|
| circular edge | circle centre | outward normal of the planar face it bounds (else the circle axis) |
| cylindrical face | centre of the rim nearest the cursor | outward axis at that rim |
| planar face | face centre | face normal |
| straight edge | nearest of midpoint / start vertex / end vertex | along the edge |
| other face | the picked point | surface normal |

The UI picks **Component 1 = the child (moves)** first, then **Component 2 = the parent (stays)**, as in Fusion. The child frame is **mated**: its z is the reversed outward normal, so the two picked faces end up face to face. With `value = 0` the child snaps so the two frames coincide. Joining a body that is not in a component creates a component for it. If nothing is grounded when a joint is made, the root of the parent's chain is grounded.

Component visibility uses `doc.hidden` with the key `asm:<componentId>` (bodies of a hidden component are hidden).

## API (`src/assembly.js`, DOM-free and Node-testable)

```js
export function emptyAssembly()                         // { components: [], joints: [], links: [] }
export function resolveLinks(asm, errors?) -> Map<drivenJointId, value>
export function solveAssembly(asm, opts?) -> { transforms: Map<componentId, Float64Array(16)>, errors: [{joint?, component?, message, warning?}],
                                               values: Map<jointId, clampedValue>, badJoints: Set<jointId> }   // opts.bodyIds: report missing bodies
export function bodyTransforms(asm, bodyIds, solved?) -> Map<bodyId, Float64Array(16)>   // world transform for each body (identity if the body is in no component)
export function componentOfBody(asm, bodyId) -> component | null
export function frameFromPoint(origin, zAxis, xHint?) -> Float64Array(16)        // build a joint frame (x = xHint projected, else the world axis least aligned with z)
// small mat4 helpers (column-major): mul, mulAll, invert, rotZ/rotX/rotY(deg), transZ(mm), translation, identity, applyToPoint, applyToDir,
//                                     toMat (array -> Float64Array, identity if malformed), toArray, isIdentity, frameAxes
// additive helpers used by the UI:
export function normalizeAssembly(asm)                  // safe copy for old / hand-edited documents
export function clampToLimits(v, limits), jointMotion(joint), jointDofs(type)   // dofs: [{key: "value"|"value2", unit: "deg"|"mm"}]
export function addComponent(asm, bodyIds, {name, grounded, transform, id}), removeComponent(asm, id), bakeTransforms(asm, ids?)
export function parentJointOf(asm, compId), descendants(asm, compId), nextId(list, prefix)
export function snapToGeometry(shape, {kind: "edge"|"face", idx, localPoint?}) -> {origin, z, what}   // replicad shape, modelled coords
```

UI: `src/assemblyui.js` (dialogs, browser rows, viewport placement). The viewport takes per-body matrices through `vp.setBodyTransforms(Map<bodyId, 16 numbers>)`; geometry is never re-meshed. Script hooks (`window.__asm`, each mutation is one undo step):

```js
__asm.makeComponent(bodyIds, name?, { grounded? }) -> componentId   // grounded defaults to "no component is grounded yet"
__asm.addJoint({ type, parent, child, parentPoint, parentAxis, childPoint, childAxis?, parentX?, childX?, value?, value2?, lower?, upper?, name? })
                                       // or { frameParent, frameChild } directly; childAxis defaults to parentAxis (frames aligned, not mated)
__asm.setJointValue(jointId, value, value2?, live?)   // live = no undo step (for animation)
__asm.ground(componentId, on), __asm.deleteJoint(id), __asm.deleteComponent(id)
__asm.solve() -> { transforms: {compId: [16]}, errors, values }   __asm.bodyTransform(bodyId) -> [16]   __asm.state()
__asm.newComponent(), joint(editId?), move(compId?), drive(jointId?), groundSelected()   // open the dialogs
```

## Units and axes for robot export
CAD works in mm with Z up. URDF and USD exports write **metres** with Z up (`metersPerUnit = 1`, `upAxis = "Z"`), which is what Isaac Sim and Isaac Lab expect. Revolute joint values convert to radians; slider values convert to metres.
