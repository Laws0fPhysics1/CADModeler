// Assembly kinematics tests: node tests/assembly.test.mjs
import assert from "node:assert/strict";
import * as A from "../src/assembly.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
const close = (a, b, eps = 1e-9, msg = "") => {
  if (Array.isArray(b) || ArrayBuffer.isView(b)) { assert.equal(a.length, b.length, msg); for (let i = 0; i < b.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${msg} [${i}] ${a[i]} != ${b[i]}`); }
  else assert.ok(Math.abs(a - b) < eps, `${msg} ${a} != ${b}`);
};
const I = () => A.toArray(A.identity());
const comp = (id, bodies, extra = {}) => ({ id, name: id, bodies, grounded: false, transform: I(), color: null, ...extra });
const joint = (id, type, parent, child, fp, fc, extra = {}) => ({ id, name: id, type, parent, child, frameParent: A.toArray(fp), frameChild: A.toArray(fc), value: 0, value2: 0, limits: { lower: null, upper: null }, effort: null, velocity: null, ...extra });

t("mat4 helpers", () => {
  const m = A.mulAll(A.translation(1, 2, 3), A.rotZ(90));
  close(A.applyToPoint(m, [1, 0, 0]), [1, 3, 3]);
  const inv = A.invert(m);
  close(A.mul(m, inv), A.identity(), 1e-12);
  close(A.applyToPoint(A.rotX(90), [0, 1, 0]), [0, 0, 1], 1e-12);
  close(A.applyToPoint(A.rotY(90), [0, 0, 1]), [1, 0, 0], 1e-12);
  close(A.applyToPoint(A.transZ(5), [0, 0, 0]), [0, 0, 5]);
  assert.ok(A.isIdentity(A.mul(A.rotZ(30), A.rotZ(-30))));
  assert.equal(A.invert(new Float64Array(16)), null);
});

t("frameFromPoint is orthonormal and right-handed", () => {
  for (const z of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [1, 2, 3], [0, -1, 0]]) {
    const f = A.frameFromPoint([5, 6, 7], z);
    const { origin, x, y, z: zz } = A.frameAxes(f);
    close(origin, [5, 6, 7]);
    const l = Math.hypot(...z);
    close(zz, z.map((v) => v / l), 1e-12, "z");
    close(x[0] * zz[0] + x[1] * zz[1] + x[2] * zz[2], 0, 1e-12, "x.z");
    close(x[0] * y[0] + x[1] * y[1] + x[2] * y[2], 0, 1e-12, "x.y");
    // x cross y == z
    close([x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]], zz, 1e-12, "handed");
  }
  const f = A.frameFromPoint([0, 0, 0], [0, 0, 1], [0, 1, 0]);
  close(A.frameAxes(f).x, [0, 1, 0], 1e-12, "x hint");
});

t("empty / normalize / old documents", () => {
  assert.deepEqual(A.emptyAssembly(), { components: [], joints: [], links: [] });
  const n0 = A.normalizeAssembly(undefined);
  assert.deepEqual(n0.components, []); assert.deepEqual(n0.joints, []);
  const n1 = A.normalizeAssembly({ components: [{ id: "c1", bodies: ["B1"] }], joints: [{ id: "j1", type: "weird", parent: "c1", child: "c2" }] });
  assert.equal(n1.components[0].transform.length, 16);
  assert.equal(n1.joints[0].type, "rigid");
  assert.deepEqual(n1.joints[0].limits, { lower: null, upper: null });
  const s = A.solveAssembly({});
  assert.equal(s.transforms.size, 0); assert.equal(s.errors.length, 0);
});

t("revolute at 90 deg moves a known point", () => {
  // base grounded; arm modelled lying along +X from the origin, hinge at its own origin about +Z.
  // Parent frame: hinge at (10, 0, 5) on the base, axis +Z.
  const asm = {
    components: [comp("base", ["B1"], { grounded: true }), comp("arm", ["B2"])],
    joints: [joint("j1", "revolute", "base", "arm", A.frameFromPoint([10, 0, 5], [0, 0, 1]), A.frameFromPoint([0, 0, 0], [0, 0, 1]), { value: 90 })],
  };
  const s = A.solveAssembly(asm);
  assert.equal(s.errors.length, 0);
  const T = s.transforms.get("arm");
  // the arm tip (20, 0, 0) swings to (10, 20, 5)
  close(A.applyToPoint(T, [20, 0, 0]), [10, 20, 5], 1e-9);
  const bt = A.bodyTransforms(asm, ["B1", "B2", "B9"]);
  close(bt.get("B2"), T); assert.ok(A.isIdentity(bt.get("B1"))); assert.ok(A.isIdentity(bt.get("B9")));
  assert.equal(A.componentOfBody(asm, "B2").id, "arm");
  assert.equal(A.componentOfBody(asm, "B9"), null);
});

t("value 0 snaps the child frame onto the parent frame", () => {
  // child frame sits at (3, 4, 0) in the child's own coordinates, z = -Y (mate).
  const fp = A.frameFromPoint([100, 0, 50], [0, 0, 1]);
  const fc = A.frameFromPoint([3, 4, 0], [0, -1, 0]);
  const asm = { components: [comp("p", [], { grounded: true }), comp("c", [])], joints: [joint("j", "rigid", "p", "c", fp, fc)] };
  const T = A.solveAssembly(asm).transforms.get("c");
  close(A.mul(T, fc), fp, 1e-9, "frames coincide");
  close(A.applyToPoint(T, [3, 4, 0]), [100, 0, 50], 1e-9);
});

t("grounded component with a placement", () => {
  const asm = { components: [comp("g", [], { grounded: true, transform: A.toArray(A.translation(0, 0, 10)) }), comp("c", [])], joints: [joint("j", "rigid", "g", "c", A.identity(), A.identity())] };
  const s = A.solveAssembly(asm);
  close(A.applyToPoint(s.transforms.get("c"), [1, 1, 1]), [1, 1, 11]);
});

t("chain of 3 joints (2-link planar arm + wrist slider)", () => {
  // base -> upper (revolute about Z at origin) -> fore (revolute at upper's x=100) -> tool (slider along fore's x at x=80)
  const asm = {
    components: [comp("base", [], { grounded: true }), comp("upper", []), comp("fore", []), comp("tool", [])],
    joints: [
      joint("j1", "revolute", "base", "upper", A.identity(), A.identity(), { value: 90 }),
      joint("j2", "revolute", "upper", "fore", A.frameFromPoint([100, 0, 0], [0, 0, 1]), A.identity(), { value: 90 }),
      // slider axis along the forearm's +X: frame z = +X
      joint("j3", "slider", "fore", "tool", A.frameFromPoint([80, 0, 0], [1, 0, 0]), A.frameFromPoint([0, 0, 0], [1, 0, 0]), { value: 15 }),
    ],
  };
  const s = A.solveAssembly(asm);
  assert.equal(s.errors.length, 0);
  // upper rotated 90: its x=100 point at (0,100,0). fore rotated 180 total: fore x=80 -> (0-80, 100, 0) = (-80, 100, 0)
  close(A.applyToPoint(s.transforms.get("fore"), [80, 0, 0]), [-80, 100, 0], 1e-9);
  // tool's origin = fore's (80 + 15, 0, 0) -> (-95, 100, 0)
  close(A.applyToPoint(s.transforms.get("tool"), [0, 0, 0]), [-95, 100, 0], 1e-9);
  // descendants
  assert.deepEqual([...A.descendants(asm, "upper")].sort(), ["fore", "tool"]);
  assert.equal(A.parentJointOf(asm, "fore").id, "j2");
});

t("slider and cylindrical", () => {
  const sl = { components: [comp("a", [], { grounded: true }), comp("b", [])], joints: [joint("s", "slider", "a", "b", A.frameFromPoint([0, 0, 0], [0, 1, 0]), A.identity(), { value: 25 })] };
  // child frame identity: child z (0,0,1) aligns with parent frame z (= world +Y); child origin moves 25 along +Y
  close(A.applyToPoint(A.solveAssembly(sl).transforms.get("b"), [0, 0, 0]), [0, 25, 0], 1e-9);
  const cy = { components: [comp("a", [], { grounded: true }), comp("b", [])], joints: [joint("c", "cylindrical", "a", "b", A.identity(), A.identity(), { value: 90, value2: 7 })] };
  close(A.applyToPoint(A.solveAssembly(cy).transforms.get("b"), [1, 0, 0]), [0, 1, 7], 1e-9);
  const ball = { components: [comp("a", [], { grounded: true }), comp("b", [])], joints: [joint("x", "ball", "a", "b", A.translation(1, 2, 3), A.identity(), { value: 45 })] };
  close(A.applyToPoint(A.solveAssembly(ball).transforms.get("b"), [0, 0, 0]), [1, 2, 3], 1e-9);
});

t("limits clamp the value", () => {
  const asm = { components: [comp("a", [], { grounded: true }), comp("b", [])], joints: [joint("r", "revolute", "a", "b", A.identity(), A.identity(), { value: 170, limits: { lower: -45, upper: 90 } })] };
  const s = A.solveAssembly(asm);
  assert.equal(s.values.get("r"), 90);
  close(A.applyToPoint(s.transforms.get("b"), [1, 0, 0]), [0, 1, 0], 1e-9);
  assert.equal(A.clampToLimits(-100, { lower: -45, upper: null }), -45);
  assert.equal(A.clampToLimits(5, { lower: null, upper: null }), 5);
  const sl = { components: [comp("a", [], { grounded: true }), comp("b", [])], joints: [joint("s", "slider", "a", "b", A.identity(), A.identity(), { value: -5, limits: { lower: 0, upper: 50 } })] };
  close(A.applyToPoint(A.solveAssembly(sl).transforms.get("b"), [0, 0, 0]), [0, 0, 0]);
});

t("errors: missing component, self joint, second parent, grounded child", () => {
  const asm = {
    components: [comp("a", ["B1"], { grounded: true }), comp("b", ["B2"]), comp("c", ["B3"]), comp("g", [], { grounded: true })],
    joints: [
      joint("ok", "rigid", "a", "b", A.translation(5, 0, 0), A.identity()),
      joint("missing", "rigid", "a", "zzz", A.identity(), A.identity()),
      joint("self", "rigid", "c", "c", A.identity(), A.identity()),
      joint("second", "rigid", "c", "b", A.translation(0, 9, 0), A.identity()),
      joint("ground", "rigid", "a", "g", A.identity(), A.identity()),
    ],
  };
  const s = A.solveAssembly(asm);
  const bad = s.errors.map((e) => e.joint).sort();
  assert.deepEqual(bad, ["ground", "missing", "second", "self"]);
  // the first joint still drives b
  close(A.applyToPoint(s.transforms.get("b"), [0, 0, 0]), [5, 0, 0]);
  assert.ok(s.badJoints.has("second"));
});

t("errors: loops are detected and broken", () => {
  const asm = {
    components: [comp("a", []), comp("b", []), comp("c", []), comp("d", [])],
    joints: [
      joint("ab", "rigid", "a", "b", A.translation(1, 0, 0), A.identity()),
      joint("bc", "rigid", "b", "c", A.translation(1, 0, 0), A.identity()),
      joint("ca", "rigid", "c", "a", A.translation(1, 0, 0), A.identity()),
      joint("cd", "rigid", "c", "d", A.translation(1, 0, 0), A.identity()),
    ],
  };
  const s = A.solveAssembly(asm);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].message, /loop/);
  assert.equal(s.transforms.size, 4);
  for (const T of s.transforms.values()) assert.ok(T.every(Number.isFinite));
});

t("missing bodies are reported, never fatal", () => {
  const asm = { components: [comp("a", ["B1", "B2"], { grounded: true }), comp("b", ["B3"])], joints: [joint("j", "revolute", "a", "b", A.identity(), A.identity(), { value: 10 })] };
  const s = A.solveAssembly(asm, { bodyIds: ["B1"] });
  assert.equal(s.transforms.size, 2);
  assert.ok(s.errors.some((e) => e.component === "b" && /none of its bodies/.test(e.message)));
  assert.ok(s.errors.some((e) => e.component === "a" && e.warning));
  const bt = A.bodyTransforms(asm, ["B1"]);
  assert.equal(bt.size, 1);
});

t("add / remove component and bake", () => {
  const asm = A.emptyAssembly();
  const c1 = A.addComponent(asm, ["B1", "B2"], { grounded: true });
  const c2 = A.addComponent(asm, ["B2", "B3"]);
  assert.equal(c1.id, "c1"); assert.equal(c2.id, "c2");
  assert.deepEqual(c1.bodies, ["B1"], "a body belongs to one component");
  asm.joints.push(joint("j1", "slider", "c1", "c2", A.identity(), A.identity(), { value: 12 }));
  A.bakeTransforms(asm);
  close(A.applyToPoint(A.toMat(c2.transform), [0, 0, 0]), [0, 0, 12]);
  A.removeComponent(asm, "c1");
  assert.equal(asm.components.length, 1); assert.equal(asm.joints.length, 0);
  // free component keeps the baked placement
  close(A.applyToPoint(A.solveAssembly(asm).transforms.get("c2"), [0, 0, 0]), [0, 0, 12]);
  assert.equal(A.nextId([{ id: "j1" }, { id: "j3" }], "j"), "j2");
  assert.deepEqual(A.jointDofs("cylindrical").map((d) => d.key), ["value", "value2"]);
  assert.equal(A.jointDofs("rigid").length, 0);
});

// ---- snapping on real kernel geometry (OCCT) ----
const K = await import("../src/kernel.js");
await K.initKernel();
const st = K.evaluate([
  { id: "b", type: "box", length: 40, width: 20, height: 10, operation: "new" },
  { id: "c", type: "cylinder", radius: 5, height: 30, operation: "new" },
]);
t("snap: planar face centre, circle edge, cylinder rim, vertex", () => {
  assert.equal(st.bodies.length, 2, JSON.stringify(st.errors));
  const [box, cyl] = st.bodies.map((b) => b.shape);
  const top = box.faces.findIndex((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 10) < 1e-6);
  const s1 = A.snapToGeometry(box, { kind: "face", idx: top });
  close(s1.origin, [0, 0, 10], 1e-6); close(s1.z, [0, 0, 1], 1e-9); assert.equal(s1.what, "face centre");
  const rimTop = cyl.edges.findIndex((e) => e.geomType === "CIRCLE" && Math.abs(e.pointAt(0.5).z - 30) < 1e-6);
  const s2 = A.snapToGeometry(cyl, { kind: "edge", idx: rimTop });
  close(s2.origin, [0, 0, 30], 1e-6); close(s2.z, [0, 0, 1], 1e-6, "outward normal");
  const wall = cyl.faces.findIndex((f) => f.geomType === "CYLINDRE");
  const s3 = A.snapToGeometry(cyl, { kind: "face", idx: wall, localPoint: [5, 0, 2] });
  close(s3.origin, [0, 0, 0], 1e-6); close(s3.z, [0, 0, -1], 1e-6, "bottom rim points down");
  const line = box.edges.findIndex((e) => e.geomType === "LINE");
  const e = box.edges[line], a = [e.startPoint.x, e.startPoint.y, e.startPoint.z];
  const s4 = A.snapToGeometry(box, { kind: "edge", idx: line, localPoint: a.map((x) => x + 0.3) });
  close(s4.origin, a, 1e-9); assert.equal(s4.what, "vertex");
  // mate the cylinder's bottom onto the box top: the child frame's z is its reversed outward normal
  const sb = A.snapToGeometry(cyl, { kind: "face", idx: cyl.faces.findIndex((f) => f.geomType === "PLANE" && Math.abs(f.center.z) < 1e-6) });
  const asm = { components: [comp("base", [st.bodies[0].id], { grounded: true }), comp("pin", [st.bodies[1].id])],
    joints: [joint("j", "revolute", "base", "pin", A.frameFromPoint(s1.origin, s1.z), A.frameFromPoint(sb.origin, sb.z.map((x) => -x)), { value: 30 })] };
  const T = A.solveAssembly(asm).transforms.get("pin");
  close(A.applyToPoint(T, [0, 0, 0]), [0, 0, 10], 1e-6, "pin stands on the box");
  close(A.applyToPoint(T, [0, 0, 30]), [0, 0, 40], 1e-6);
});

console.log(`\n${n} assembly tests passed`);
