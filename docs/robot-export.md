# Robot export: URDF and USD for Isaac Sim / Isaac Lab

**Export Robot (URDF / USD for Isaac Sim)** is in File and in INSERT. It turns the assembly (`doc.assembly`, see `docs/assembly.md`) into a robot package folder:

```
<robot name>/
  robot.usda     USD stage: UsdPhysics articulation with the meshes embedded
  robot.urdf     URDF that points at meshes/ with relative paths
  meshes/        one mesh per body, in metres and in its link's frame (.obj + .mtl, or binary .stl)
  README.txt     how to load it in Isaac Sim (USD or URDF importer) and an Isaac Lab ArticulationCfg with the real joint names
```

The desktop app asks for a parent folder and writes `<picked>/<robot name>/` (`platform.saveFolder`, `electron/folder-writer.cjs`). Files with the same names are overwritten, so re-exporting keeps Isaac's paths valid. The browser build downloads `<robot name>.zip` instead (a STORE-only zip from `src/zip.js`).

| File | Role |
|---|---|
| `src/robotexport.js` | DOM-free and Node-testable. `describeRobot` (topology and frames only, cheap) and `buildRobot(doc, state, opts)`, which returns `{ files, links, joints, warnings, summary }` in memory |
| `src/robotexportui.js` / `.css` | The dialog and the `window.__robot` debug hook |
| `src/zip.js` | STORE-only zip writer (browser fallback) |
| `electron/folder-writer.cjs` | Validated folder writer used by the `desktop:saveFolder` IPC handler: no `..`, no absolute paths or drive letters, no reserved names, and every path must stay inside the target folder |
| `tools/check_robot_usd.py` | Validator (see below) |
| `tests/robotexport.test.mjs` | Builds a base and a 3-link arm plus a joint zoo, writes them, and runs the validator |

## Mapping

| CAD Modeler | URDF | USD (UsdPhysics) |
|---|---|---|
| component | `<link>` | `Xform` with `PhysicsRigidBodyAPI` + `PhysicsMassAPI` |
| bodies in no component (visible ones) | the `base_link` | same |
| rigid joint | `fixed` | `PhysicsFixedJoint` |
| revolute, both limits set | `revolute` (rad) | `PhysicsRevoluteJoint`, limits in **degrees** |
| revolute, no limits (or only one limit) | `continuous` | `PhysicsRevoluteJoint` with no limits |
| slider | `prismatic` (m) | `PhysicsPrismaticJoint` (m). With no limits, URDF gets ±10 m (URDF requires limits) and USD is unlimited |
| cylindrical | `revolute`/`continuous` `<name>_rot` + `prismatic` `<name>_slide`, through a dummy link `<child>_cyl` | same |
| ball | three `continuous` joints `<name>_x`, `_y`, `_z` through dummy links `<child>_ball_x`, `_ball_y` | same |

* **Ball joints** are three revolutes in both formats. Isaac Sim's URDF importer has no spherical joint, and Isaac Lab's actuator API addresses single-DOF joints, so `PhysicsSphericalJoint` was not used.
* **Dummy links** (cylindrical and ball intermediates, and empty links) get `dummyMass` = 1 g with inertia 1e-7 kg·m². PhysX articulation links need a positive mass.
* **Root:** with no loose bodies and exactly one root component, that component is the root link. Otherwise a `base_link` holds the loose bodies, and every root component is welded to it with a fixed joint (a warning is shown for free, ungrounded ones). Joints that drive a grounded component, give a component a second parent or close a loop are skipped with a warning, as `assembly.js` does.
* **No assembly yet:** all visible bodies become a single fixed link, `base_link`, and the dialog says so.
* **Fixed or floating base:** fixed when the root is grounded (the loose-body `base_link` always counts as grounded). The dialog can force either. In USD the fixed base is a `PhysicsFixedJoint` `/<robot>/joints/root_joint` with `body0` unset (world) and `body1` = root link. This matches what Isaac Sim's URDF importer produces. `physxArticulation:fixedBase` is not used: it is not an attribute in the UsdPhysics or PhysX schemas.
* **Articulation root:** `PhysicsArticulationRootAPI` + `PhysxArticulationAPI` go on the robot's default prim, an ancestor Xform of all links, with self-collisions off. Links are flat siblings under it, and joints are in `/<robot>/joints`.

## Frames and units (the transform chain)

All values are in metres, kilograms and seconds with Z up (`metersPerUnit = 1`, `kilogramsPerUnit = 1`, `upAxis = "Z"`). Matrices are column-major 4×4 in mm in the modelled coordinates, as in the contract.

* **Link frame.** A child link's frame is its joint's `frameChild`, so `F(child) = frameChild`. Root links use the component's modelled origin, so `F = I`. Mesh vertices and mass properties are written in the link frame: `v_link = F⁻¹ · v_model`, then mm × 0.001.
* **Joint origin** in the parent link frame: `origin = F(parent)⁻¹ · frameParent`. URDF writes it as `<origin xyz rpy>`, where rpy is fixed-axis X, Y, Z with `R = Rz(yaw)·Ry(pitch)·Rx(roll)`. USD writes it as `localPos0` / `localRot0`, with `localPos1 = 0` and `localRot1 = identity`, because the child frame is the joint frame. The axis is the joint frame's +Z (X, Y or Z for the ball sub-joints).
* **Export pose.** The package is in the **zero configuration** (every joint value 0): `W(child) = W(parent) · origin`, and a root's `W` is its component transform `T(root)`. The USD link Xforms (`xformOp:translate` + `xformOp:orient`) are these world poses. The current joint values (clamped to their limits, in rad or m) go into README.txt's Isaac Lab `init_state.joint_pos`. Motion `M(q)` follows the contract: revolute = rotation about +z, slider = translation along +z.
* **Mass properties.** For each body, OCCT `BRepGProp::VolumeProperties` gives the volume and centre of mass. This WASM build doesn't bind `GProp_GProps::MatrixOfInertia` (its `gp_Mat` return type is unbound), and the static is `BRepGProp.VolumeProperties`, not `VolumeProperties_1`. So the full tensor about the COM is assembled from six `MomentOfInertia(gp_Ax1 through the COM)` calls: `I_ii` from the coordinate axes, and `I_ij = I_(eᵢ+eⱼ)/√2 − (I_ii + I_jj)/2`. Next, the tensor is multiplied by density (mm⁵ → kg·m² is × ρ × 1e-15), rotated into the link frame (`R I Rᵀ`), and combined across bodies with the parallel-axis theorem.
  * URDF gets the full tensor (`ixx … izz`, tensor elements, so `ixy = −∫xy dm`) at `<inertial><origin xyz=COM>`.
  * USD gets `physics:mass`, `physics:centerOfMass`, and `physics:diagonalInertia` + `physics:principalAxes` (a Jacobi eigen-decomposition; the quaternion's columns are the eigenvectors, det +1).
* **Density.** Density comes from the body's material (`doc.appearances[id].materialId` → `physical.density_kg_m3`). A body with **no appearance** gets aluminium, 2700 kg/m³. That isn't the app's "generic" steel default, so set a material on steel parts. Bodies with no closed volume add no mass and produce a warning.
* **Drives** (USD only; URDF has no drive gains): `PhysicsDriveAPI:angular` / `:linear` with type `force` and target 0, `maxForce` = joint effort (default 100), and `physxJoint:maxJointVelocity`. The dialog takes stiffness and damping per **radian** or per metre, the same as Isaac Lab's actuator configs. UsdPhysics angular drives are per **degree**, so angular gains are multiplied by π/180 on the way out. Defaults: revolute 100 N·m/rad and 10 N·m·s/rad; slider 1000 N/m and 100 N·s/m.
* **Meshes and colours.** There is one mesh per body (so per-body colours survive), tessellated with the chosen quality: 0.1, 0.05 or 0.01 mm chordal tolerance. Bodies with modeled threads mesh at their display tolerance (about 40 k triangles for an M6 bolt). Use cosmetic threads for robot exports.
  * USD: `Mesh` prims with points, triangle faceVertexCounts and faceVertexIndices, vertex normals, `subdivisionScheme = "none"`, constant `primvars:displayColor`, and a bound `UsdPreviewSurface` material (colour converted from sRGB to linear, plus metallic and roughness from the appearance).
  * URDF: one `<visual>` and one `<collision>` per body pointing at the same file, with a named `<material>` rgba. OBJ files also carry an .mtl.
* **Collision.** USD applies `PhysicsCollisionAPI` + `PhysicsMeshCollisionAPI` on the visual mesh itself with `physics:approximation` = `convexHull` (default), `convexDecomposition` or `boundingCube`, or no collision. URDF collisions are the same meshes, and Isaac's URDF importer convex-hulls them (or decomposes them if you tick that in the importer).
* `PhysicsScene` (gravity −Z, 9.81 m/s²) is optional and is written at `/physicsScene`, outside the default prim, so referencing the robot into another stage doesn't bring a second scene.

## Validation status

**Verified on this machine** (`node tests/robotexport.test.mjs`, which runs `python tools/check_robot_usd.py <package>`; needs `pip install usd-core`):
* The stage opens in Pixar USD 26.08 (`usd-core`) with no Tf errors. Metadata checked: Z up, metersPerUnit 1, kilogramsPerUnit 1, defaultPrim.
* `UsdPhysics.LoadUsdPhysicsFromRange` (UsdPhysics' reference parser) finds every rigid body, every joint and exactly one articulation covering all bodies.
* For every joint, the joint frame computed from `body0 · localPos0/Rot0` equals `body1 · localPos1/Rot1` in the exported pose (to 1e-8 m). A deliberately broken frame is caught.
* The joints form one tree from the root, and masses, principal moments (triangle inequality) and quaternions are sane.
* The URDF parses, all mesh files exist and are non-empty with relative paths, and the links form a tree. Zero-pose forward kinematics from the URDF matches the USD link poses, and URDF masses and full tensors match USD's diagonalInertia/principalAxes.
* Mass properties match a box's analytic inertia and a rotated box's products of inertia.

**Not verified (Isaac Sim and Isaac Lab are not installed here):**
* That Isaac Sim's URDF importer accepts the file with no edits. It uses only `fixed`, `revolute`, `continuous` and `prismatic` joints, relative mesh paths, OBJ or STL, and named materials, which are the conservative subset.
* How PhysX actually behaves: drive gains, the 1 g dummy links for cylindrical and ball joints, solver iterations (32/1), and whether convex hulls of the per-body meshes collide well.
* That RTX renders `UsdPreviewSurface` / `displayColor` as expected.
* That `PhysxArticulationAPI` / `PhysxJointAPI` attributes (`physxArticulation:*`, `physxJoint:maxJointVelocity`) are picked up. usd-core doesn't ship the PhysX schemas, so these were only checked to parse.
* **Isaac Lab cloning with `root_joint`.** The world-anchored fixed joint stores the root pose in `localPos0`. If cloned environments get pulled to the world origin, delete `root_joint` and use `ArticulationRootPropertiesCfg(fix_root_link=True)`. The README says this.
* Import paths: the snippets cover `isaacsim.asset.importer.urdf` (Isaac Sim 4.5) and `omni.importer.urdf` (4.0–4.2), and `isaaclab` (2.x) or `omni.isaac.lab` (1.x).

## Scripting (debug hook)
In the running app (DevTools console or a test script):
```js
const r = await __robot.build({ name: "arm", formats: ["usd", "urdf"], meshFormat: "obj" }); // no saving
r.summary; r.files;      // [{ path, bytes }]
r.pkg.files["robot.usda"] // the text
await __robot.export({ name: "arm" }) // same, plus r.path (desktop: folder picker; browser: downloads arm.zip)
__robot.describe(); __robot.open();
```
Options are `DEFAULTS` in `src/robotexport.js`: `name, formats, meshFormat, quality, collision, fixedBase (null|true|false), angularStiffness, angularDamping, linearStiffness, linearDamping, defaultEffort, defaultVelocity, physicsScene, dummyMass, includeHidden, defaultDensity`.
