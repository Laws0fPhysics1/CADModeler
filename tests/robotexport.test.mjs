// Robot export (URDF / USD for Isaac Sim): node tests/robotexport.test.mjs
// Builds a base + 3-link arm (revolute, continuous revolute, slider) from kernel features, a hand-made
// doc.assembly per docs/assembly.md, writes the package to a temp folder and runs tools/check_robot_usd.py
// on it (skipped with a warning when Python or pxr is missing). Also: mass properties against a box's
// analytic inertia, rpy / quaternion round trips, cylindrical + ball joints, the no-assembly fallback,
// the STORE zip writer and the folder writer's path guards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as K from "../src/kernel.js";
import * as RX from "../src/robotexport.js";
import { makeZip } from "../src/zip.js";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

await K.initKernel();

// ---------- geometry: base plate, upper arm (cylinder), forearm (box), tool (box) ----------
const features = [
  { id: "f1", type: "box", length: 100, width: 100, height: 20, operation: "new" },   // Body1 base, x,y in ±50, z 0..20
  { id: "f2", type: "cylinder", radius: 10, height: 200, operation: "new" },           // Body2 upper arm, z 0..200
  { id: "f3", type: "box", length: 20, width: 20, height: 150, operation: "new" },     // Body3 forearm, z 0..150
  { id: "f4", type: "box", length: 10, width: 10, height: 40, operation: "new" },      // Body4 tool, z 0..40
];
const state = K.evaluate(features);
ok(state.bodies.length === 4 && !Object.keys(state.errors).length, `4 bodies built (${state.bodies.map((b) => b.id).join(", ")})`);

// joint frames, column-major 4x4 in mm (z = joint axis)
const frame = (o, z, x) => {
  const n = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
  const Z = n(z), X = n(x), Y = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
  return [...X, 0, ...Y, 0, ...Z, 0, ...o, 1];
};
const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const assembly = {
  components: [
    { id: "c1", name: "Base", bodies: ["Body1"], grounded: true, transform: I16, color: null },
    { id: "c2", name: "Upper Arm", bodies: ["Body2"], grounded: false, transform: I16, color: null },
    { id: "c3", name: "Forearm", bodies: ["Body3"], grounded: false, transform: I16, color: null },
    { id: "c4", name: "Tool", bodies: ["Body4"], grounded: false, transform: I16, color: null },
  ],
  joints: [
    { id: "j1", name: "Shoulder", type: "revolute", parent: "c1", child: "c2", frameParent: frame([0, 0, 20], [0, 0, 1], [1, 0, 0]), frameChild: frame([0, 0, 0], [0, 0, 1], [1, 0, 0]), value: 30, value2: 0, limits: { lower: -90, upper: 90 }, effort: 20, velocity: 180 },
    // elbow axis = world/modelled +X at the top of the upper arm; forearm hinges at its bottom face about its own +X
    { id: "j2", name: "Elbow", type: "revolute", parent: "c2", child: "c3", frameParent: frame([0, 0, 200], [1, 0, 0], [0, 1, 0]), frameChild: frame([0, 0, 0], [1, 0, 0], [0, 1, 0]), value: -45, value2: 0, limits: { lower: null, upper: null }, effort: null, velocity: null },
    { id: "j3", name: "Tool Slide", type: "slider", parent: "c3", child: "c4", frameParent: frame([0, 0, 150], [0, 0, 1], [1, 0, 0]), frameChild: frame([0, 0, 0], [0, 0, 1], [1, 0, 0]), value: 10, value2: 0, limits: { lower: 0, upper: 50 }, effort: 50, velocity: 100 },
  ],
};
const doc = { name: "Test Arm", features, hidden: [], appearances: { Body3: { materialId: "steel-mild", color: "#c0392b" }, Body2: { materialId: "aluminum-anodized" } }, assembly };

// ---------- mass properties vs analytic ----------
{
  const p = RX.volumeProperties(state.bodies[0].shape); // 100 x 100 x 20 mm box
  const V = 100 * 100 * 20, Ixx = (V / 12) * (100 ** 2 + 20 ** 2), Izz = (V / 12) * (100 ** 2 + 100 ** 2);
  ok(near(p.volume, V, 1e-9) && near(p.com[2], 10, 1e-9), `box volume ${p.volume} mm³, COM z ${p.com[2]} mm`);
  ok(near(p.inertia[0][0], Ixx, 1e-9) && near(p.inertia[1][1], Ixx, 1e-9) && near(p.inertia[2][2], Izz, 1e-9), `box inertia (mm^5) matches V/12(b²+c²): ${p.inertia[0][0].toExponential(6)} vs ${Ixx.toExponential(6)}`);
  ok(Math.abs(p.inertia[0][1]) + Math.abs(p.inertia[0][2]) + Math.abs(p.inertia[1][2]) < 1e-6 * Ixx, "box products of inertia are 0");
  // an off-axis box: products of inertia appear and match the analytic tensor
  const R = await import("replicad");
  const tilted = R.makeBox([0, 0, 0], [40, 10, 10]).rotate(30, [0, 0, 0], [0, 0, 1]);
  const q = RX.volumeProperties(tilted);
  const m = 4000, a = (m / 12) * (10 ** 2 + 10 ** 2), b = (m / 12) * (40 ** 2 + 10 ** 2);
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  // body-frame diag(a, b, b) rotated by 30° about z: Ixy = (a - b) c s
  ok(near(q.inertia[0][1], (a - b) * c * s, 1e-7) && near(q.inertia[0][0], a * c * c + b * s * s, 1e-7), `rotated box Ixy ${q.inertia[0][1].toFixed(2)} vs analytic ${((a - b) * c * s).toFixed(2)}`);
  const e = RX.eigenSym3(q.inertia);
  const ev = e.values.slice().sort((x, y) => x - y);
  ok(near(ev[0], a, 1e-7) && near(ev[1], b, 1e-7) && near(ev[2], b, 1e-7), "eigenSym3 recovers the principal moments");
}

// ---------- rotation helpers ----------
{
  const rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  let worst = 0;
  for (const [r, p, y] of [[0.3, -0.7, 2.1], [0, Math.PI / 2, 0.4], [-1.2, 0.1, -3]]) {
    const Rm = mm(rz(y), mm(ry(p), rx(r)));
    const [r2, p2, y2] = RX.rpyFromMat3(Rm);
    const R2 = mm(rz(y2), mm(ry(p2), rx(r2)));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(Rm[i][j] - R2[i][j]));
  }
  ok(worst < 1e-9, `rpy round trip (incl. gimbal lock) max error ${worst.toExponential(1)}`);
}

// ---------- cross-check the kinematics with src/assembly.js when it exists ----------
try {
  const A = await import("../src/assembly.js");
  const mine = RX.solveTransforms(assembly).transforms, theirs = A.solveAssembly(assembly).transforms;
  let worst = 0;
  for (const [id, m] of mine) for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(m[i] - theirs.get(id)[i]));
  ok(worst < 1e-9, `robotexport.solveTransforms matches assembly.js solveAssembly (max diff ${worst.toExponential(1)})`);
} catch (e) { console.log(`skip assembly.js cross-check (${e.message})`); }

// ---------- build the package ----------
const t0 = Date.now();
const pkg = RX.buildRobot(doc, state, { name: "test_arm", formats: ["usd", "urdf"], meshFormat: "obj", physicsScene: true });
console.log(`built in ${Date.now() - t0} ms: ${pkg.summary}`);
for (const w of pkg.warnings) console.log(`  warning: ${w}`);
ok(pkg.links.map((l) => l.name).join(",") === "Base,Upper_Arm,Forearm,Tool", `links ${pkg.links.map((l) => l.name).join(", ")}`);
ok(pkg.joints.map((j) => `${j.name}:${j.type}`).join(",") === "Shoulder:revolute,Elbow:continuous,Tool_Slide:prismatic", `joints ${pkg.joints.map((j) => `${j.name}:${j.type}`).join(", ")}`);
ok(pkg.fixedBase === true, "grounded base -> fixed base");
const base = pkg.links[0];
ok(near(base.mass, 0.1 * 0.1 * 0.02 * 2700, 1e-9), `base mass ${base.mass} kg (aluminium default, no appearance)`);
ok(near(base.inertia[0][0], (0.54 / 12) * (0.1 ** 2 + 0.02 ** 2), 1e-9) && near(base.inertia[2][2], (0.54 / 12) * (0.1 ** 2 + 0.1 ** 2), 1e-9), `base inertia kg·m² ${base.inertia[0][0].toExponential(5)} / ${base.inertia[2][2].toExponential(5)}`);
const fore = pkg.links[2];
ok(near(fore.mass, 0.02 * 0.02 * 0.15 * 7870, 1e-9), `forearm mass ${fore.mass.toFixed(4)} kg (mild steel appearance)`);
// forearm link frame: z = modelled +X, x = modelled +Y, so its long axis (modelled z) is link-frame y
ok(near(fore.com[1], 0.075, 1e-9) && Math.abs(fore.com[0]) < 1e-12 && Math.abs(fore.com[2]) < 1e-12, `forearm COM in its link frame ${fore.com.map((x) => x.toFixed(4))}`);
const Ilong = (fore.mass / 12) * (0.02 ** 2 + 0.02 ** 2), Iside = (fore.mass / 12) * (0.02 ** 2 + 0.15 ** 2);
ok(near(fore.inertia[1][1], Ilong, 1e-9) && near(fore.inertia[0][0], Iside, 1e-9) && near(fore.inertia[2][2], Iside, 1e-9), "forearm inertia rotated into the link frame");

const urdf = pkg.files["robot.urdf"], usda = pkg.files["robot.usda"];
ok(/<joint name="Shoulder" type="revolute">[\s\S]*?<origin xyz="0 0 0.02" rpy="0 0 0"\/>[\s\S]*?<limit lower="-1.570796" upper="1.570796"/.test(urdf), "URDF shoulder origin 0.02 m, limits ±π/2 rad");
ok(/<joint name="Elbow" type="continuous">[\s\S]*?<origin xyz="0 0 0.2" rpy="/.test(urdf), "URDF elbow continuous at 0.2 m");
ok(/def PhysicsRevoluteJoint "Shoulder"[\s\S]*?float physics:lowerLimit = -90\n\s*float physics:upperLimit = 90/.test(usda), "USD revolute limits in degrees");
ok(/upAxis = "Z"/.test(usda) && /metersPerUnit = 1/.test(usda) && /kilogramsPerUnit = 1/.test(usda), "USD stage metadata");
ok(/PhysicsArticulationRootAPI/.test(usda) && /def PhysicsFixedJoint "root_joint"/.test(usda) && /def PhysicsScene "physicsScene"/.test(usda), "articulation root, root_joint, physics scene");
ok(/"Shoulder": 0.5236/.test(pkg.files["README.txt"]) && /"Tool_Slide": 0.01/.test(pkg.files["README.txt"]), "README Isaac Lab init_state uses the posed joint values (rad / m)");
console.log("files:", RX.fileList(pkg.files).map((f) => `${f.path} (${f.bytes} B)`).join(", "));

// ---------- write and run the Python checker ----------
const { writeFolder } = require("../electron/folder-writer.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadm-robot-"));
const dir = await writeFolder(tmp, "test_arm", pkg.files);
ok(fs.existsSync(path.join(dir, "robot.usda")) && fs.existsSync(path.join(dir, "meshes")), `package written to ${dir}`);

function runChecker(folder, label) {
  const py = spawnSync(process.env.PYTHON || "python", [path.join(ROOT, "tools", "check_robot_usd.py"), folder], { encoding: "utf8" });
  if (py.error) { console.log(`WARNING: Python not found (${py.error.message}); skipped the ${label} checker`); return; }
  const out = (py.stdout || "") + (py.stderr || "");
  console.log(out.trim().split("\n").map((l) => `  | ${l}`).join("\n"));
  if (/SKIP pxr is not installed/.test(out)) console.log("WARNING: pxr (usd-core) missing: only the URDF was checked. pip install usd-core");
  ok(py.status === 0 && /CHECK OK/.test(out), `${label}: tools/check_robot_usd.py passes`);
}
runChecker(dir, "arm package");
// the checker must catch a wrong joint frame
{
  const bad = pkg.files["robot.usda"].replace(/(def PhysicsRevoluteJoint "Shoulder"[\s\S]*?localPos0 = )\(0, 0, 0\.02\)/, "$1(0, 0, 0.03)");
  ok(bad !== pkg.files["robot.usda"], "mutated the Shoulder frame for a negative check");
  const d = await writeFolder(tmp, "broken", { "robot.usda": bad });
  const py = spawnSync(process.env.PYTHON || "python", [path.join(ROOT, "tools", "check_robot_usd.py"), d], { encoding: "utf8" });
  if (!py.error && !/SKIP pxr/.test(py.stdout)) ok(py.status === 1 && /Shoulder: frames from body0 and body1 disagree/.test(py.stdout), "checker rejects a joint whose frames disagree");
}

// ---------- cylindrical + ball joints, STL meshes, floating base ----------
{
  const asm2 = {
    components: [
      { id: "a", name: "Hub", bodies: ["Body1"], grounded: false, transform: I16 },
      { id: "b", name: "Spindle", bodies: ["Body2"], grounded: false, transform: I16 },
      { id: "c", name: "Wrist", bodies: ["Body4"], grounded: false, transform: I16 },
    ],
    joints: [
      { id: "k1", name: "Spin", type: "cylindrical", parent: "a", child: "b", frameParent: frame([10, 0, 20], [0, 0, 1], [1, 0, 0]), frameChild: frame([0, 0, 0], [0, 0, 1], [1, 0, 0]), value: 15, value2: 5, limits: { lower: null, upper: null } },
      { id: "k2", name: "Ball", type: "ball", parent: "b", child: "c", frameParent: frame([0, 0, 200], [0, 1, 1], [1, 0, 0]), frameChild: frame([0, 0, 0], [0, 0, 1], [1, 0, 0]), value: 0, value2: 0, limits: { lower: null, upper: null } },
    ],
  };
  const doc2 = { name: "joints", hidden: ["Body3"], appearances: {}, assembly: asm2 };
  const p2 = RX.buildRobot(doc2, state, { name: "joint_zoo", meshFormat: "stl", collision: "convexDecomposition" });
  ok(p2.links.length === 6 && p2.joints.length === 5, `cylindrical -> revolute+prismatic, ball -> 3 revolutes: ${p2.joints.map((j) => `${j.name}:${j.type}`).join(", ")}`);
  ok(p2.fixedBase === false, "no grounded component -> floating base");
  ok(Object.keys(p2.files).filter((f) => f.endsWith(".stl")).length === 3, "STL meshes, one per body");
  const d2 = await writeFolder(tmp, "joint_zoo", p2.files);
  runChecker(d2, "joint-zoo package");
}

// ---------- no assembly: one fixed link ----------
{
  const p3 = RX.buildRobot({ name: "plain", hidden: ["Body4"], appearances: {} }, state, { name: "plain", formats: ["urdf"] });
  ok(p3.links.length === 1 && p3.joints.length === 0 && p3.links[0].bodies.length === 3 && !p3.files["robot.usda"], "no assembly -> one base_link with the visible bodies, URDF only");
  ok(p3.warnings.some((w) => /No assembly yet/.test(w)), "and says so");
}

// ---------- zip writer (checked with Python's zipfile) and folder-writer guards ----------
{
  const enc = new TextEncoder();
  const zip = makeZip([{ path: "pkg/robot.urdf", data: enc.encode("<robot/>") }, { path: "pkg/meshes/a.stl", data: new Uint8Array([1, 2, 3]) }]);
  const zf = path.join(tmp, "t.zip");
  fs.writeFileSync(zf, zip);
  const py = spawnSync(process.env.PYTHON || "python", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(),sorted(z.namelist()),z.read('pkg/robot.urdf').decode())", zf], { encoding: "utf8" });
  if (py.error) console.log("skip zip check (no Python)");
  else ok(py.stdout.trim() === "None ['pkg/meshes/a.stl', 'pkg/robot.urdf'] <robot/>", `STORE zip opens with zipfile: ${py.stdout.trim()}`);
  const bad = async (folder, files) => { try { await writeFolder(tmp, folder, files); return false; } catch { return true; } };
  ok(await bad("../escape", { "a.txt": "x" }), "folder name '..' rejected");
  ok(await bad("x", { "../a.txt": "x" }), "file '../a.txt' rejected");
  ok(await bad("x", { "C:/Windows/a.txt": "x" }), "absolute file path rejected");
  ok(await bad("x", { "/etc/a.txt": "x" }), "rooted file path rejected");
  ok(await bad("x", { "meshes/con.obj": "x" }), "reserved device name rejected");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall robot export tests passed");
process.exit(failures ? 1 : 0);
