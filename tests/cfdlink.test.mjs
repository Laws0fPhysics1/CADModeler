// CFD case exchange test: node tests/cfdlink.test.mjs
import * as L from "../src/cfdlink.js";

const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok  " + m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Binary STL of an axis-aligned box [x0,x1]x[y0,y1]x[z0,z1] (12 triangles).
function boxSTL([x0, y0, z0], [x1, y1, z1]) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + F.length * 50), dv = new DataView(buf);
  dv.setUint32(80, F.length, true);
  F.forEach((f, t) => f.forEach((vi, v) => P[vi].forEach((x, k) => dv.setFloat32(84 + t * 50 + 12 + v * 12 + k * 4, x, true))));
  return new Uint8Array(buf);
}

const stl = boxSTL([-50, -20, 0], [50, 20, 30]); // 100 x 40 x 30 mm
const info = L.stlInfo(stl);
assert(info.triangles === 12 && info.min.join() === "-50,-20,0" && info.max.join() === "50,20,30", "stlInfo reads bbox + triangle count");
assert(near(L.frontalAreaMm2(stl, "+X"), 40 * 30, 40 * 30 * 0.02), "frontal area along X ~ 1200 mm²");
assert(near(L.frontalAreaMm2(stl, "-Y"), 100 * 30, 3000 * 0.02), "frontal area along Y ~ 3000 mm²");
assert(L.safeName("My wing / v2 (final)") === "My_wing_v2_final", "safeName");
assert(L.normColor(0xff8800) === "#ff8800" && L.normColor("#F80") === "#ff8800" && L.normColor({ r: 1, g: 0, b: 0 }) === "#ff0000", "normColor");
assert(L.upAxisFor("+X") === "+Z" && L.upAxisFor("-Z") === "+Y", "up axis for horizontal / vertical flow");

const materials = { al6061: { id: "al6061", name: "Aluminium 6061", physical: { density: 2700, youngsModulus_GPa: 68.9, poisson: 0.33 } } };
const appearances = { b1: { materialId: "al6061", color: 0xcc2222 }, b2: { materialId: null, color: "#ff8800" } };
const date = new Date(2026, 9, 7, 14, 5, 9);
for (const data of [stl, new Blob([stl])]) {
  const { folderName, files, caseData, summary } = await L.buildCase({
    designName: "Test Box", bodies: [{ id: "b1", name: "Body1", volume_mm3: 120000 }, { id: "b2", name: "Body2" }], stlBytes: data,
    appearances, materials: (id) => materials[id], options: { direction: "+X", speed: 30, fluid: "Air (20°C)", ground: { enabled: true, gap_mm: 5 }, solver: { quality: "draft" }, appVersion: "0.1.0", date },
  });
  assert(folderName === "Test_Box_20261007-140509", `folder name ${folderName}`);
  assert(files["geometry.stl"] instanceof Uint8Array && files["geometry.stl"].byteLength === stl.byteLength, "geometry.stl bytes passed through");
  const c = JSON.parse(files["case.json"]);
  const v = L.validateCase(c);
  assert(v.ok, "case.json validates " + JSON.stringify(v.errors));
  assert(c.format === "cadmodeler-cfd-case" && c.version === 1 && c.units === "mm", "format/version/units");
  assert(c.geometry.lengthMm === 100 && c.geometry.size.join() === "100,40,30", "lengthMm = max extent");
  assert(c.geometry.bodies[0].material.density_kg_m3 === 2700 && c.geometry.bodies[0].material.youngsModulus_GPa === 68.9, "material props flattened");
  assert(c.geometry.bodies[0].color === "#cc2222" && c.geometry.bodies[1].material === null, "colors + missing material");
  assert(near(c.geometry.bodies[0].mass_kg, 0.324, 1e-9), "mass from density x volume");
  assert(c.flow.up === "+Z" && c.flow.nu === 1.5e-5 && c.flow.rho === 1.204, "flow fluid props");
  assert(c.ground.enabled && c.ground.gap_mm === 5 && c.ground.moving === true, "ground");
  assert(c.solver.quality === "draft" && c.solver.levels === 4 && c.solver.precision === "fp16c" && c.solver.flowThroughs === 3, "solver defaults");
  assert(near(summary.reynolds, (30 * 0.1) / 1.5e-5, 1) && near(summary.frontalM2, 0.0012, 0.0012 * 0.02), `summary Re ${summary.reynolds.toFixed(0)}, A ${summary.frontalM2}`);
  assert(caseData.results.results === "results.json" && caseData.results.progress === "progress.json", "results hooks");
}

// vertical flow drops the ground plane and picks a perpendicular up axis
const vz = await L.buildCase({ designName: "", bodies: [], stlBytes: stl, options: { direction: "-Z", ground: { enabled: true } } });
const cz = JSON.parse(vz.files["case.json"]);
assert(cz.flow.up === "+Y" && cz.ground.enabled === false && vz.folderName.startsWith("Design_"), "vertical flow");

// validator catches errors
const bad = JSON.parse(vz.files["case.json"]);
bad.flow.direction = "+W"; bad.units = "m"; bad.solver.levels = 9; delete bad.results;
const bv = L.validateCase(bad);
assert(!bv.ok && bv.errors.length === 4, "validator reports 4 errors: " + bv.errors.join(" | "));
assert(!L.validateCase("{nope").ok, "validator rejects bad JSON");
let threw = false;
try { await L.buildCase({ designName: "x", stlBytes: new Uint8Array(10) }); } catch { threw = true; }
assert(threw, "buildCase rejects a non-STL");
assert(L.normalizeReadback({ progress: { status: "running" }, results: null }).progress.status === "running", "readback {progress, results}");
assert(L.normalizeReadback({ kind: "results", status: "completed", Cd: 1 }).results.Cd === 1, "readback bare results");
console.log("all cfdlink tests passed");
