// FEA case exchange test: node tests/fealink.test.mjs
// 1. pure case building / validation / viz parsing (always)
// 2. end to end (when python + gmsh + FEA Sim are installed): a real kernel body -> K.exportSTEP ->
//    buildCase -> electron/fea-runner.cjs runs FEA Sim -> results.json + viz/ parsed and checked
//    against beam theory. Skip with FEA_SKIP_E2E=1.
import * as L from "../src/fealink.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok  " + m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- pure
const fx0 = { body: "Body1", idx: 0, pt: [0, 10, 5], n: [-1, 0, 0], area_mm2: 200 };
const fxL = { body: "Body1", idx: 1, pt: [200, 10, 5], n: [1, 0, 0], area_mm2: 200 };
const top = { body: "Body1", idx: 5, pt: [100, 10, 10], n: [0, 0, 1], area_mm2: 4000 };
assert(L.forceVector({ magnitude: 100, direction: "-Z" }).join() === "0,0,-100", "force along an axis");
assert(L.forceVector({ magnitude: 100, direction: "normal", faces: [fxL] }).join() === "-100,0,0", "force along the face normal pushes into the face");
assert(L.forceVector({ magnitude: 100, direction: "normal", flip: true, faces: [fxL] }).join() === "100,0,0", "flip reverses it");
assert(L.gravityVector("-Z").join() === `0,0,${-L.G0}`, "gravity -Z");
let threw = false; try { L.forceVector({ magnitude: 1, direction: "normal", faces: [fx0, fxL] }); } catch { threw = true; }
assert(threw, "opposite normals have no common direction");

const stepBytes = new TextEncoder().encode("ISO-10303-21;\nEND-ISO-10303-21;\n");
const materials = { steel: { id: "steel", name: "Steel", physical: { density_kg_m3: 7850, youngs_modulus_Pa: 200e9, poissons_ratio: 0.3, yield_strength_Pa: 250e6 } } };
const date = new Date(2026, 9, 8, 9, 30, 0);
const built = await L.buildCase({
  designName: "Beam / v2", bodies: [{ id: "Body1", name: "Body1", volume_mm3: 40000, bbox: { min: [0, 0, 0], max: [200, 20, 10] }, faces: [fx0, fxL, top] }],
  stepBytes, appearances: { Body1: { materialId: "steel", color: "#888888" } }, materials,
  study: {
    fixtures: [{ faces: [fx0] }],
    loads: [{ type: "force", faces: [fxL], magnitude: 100, direction: "-Z" }, { type: "pressure", faces: [top], magnitude: 2e5 }],
    gravity: { enabled: true }, mesh: { quality: "fine" },
  },
  appVersion: "0.2.0", date,
});
const c = JSON.parse(built.files["case.json"]);
assert(built.folderName === "Beam_v2_FEA_20261008-093000", `folder name ${built.folderName}`);
assert(built.files["geometry.step"].byteLength === stepBytes.byteLength, "geometry.step passed through");
assert(L.validateCase(c).ok, "case validates");
assert(c.format === "cadmodeler-fea-case" && c.version === 1 && c.units === "mm" && c.analysis === "static-stress", "format / version / units");
assert(c.geometry.bodies[0].material.youngs_modulus_Pa === 200e9 && c.geometry.bodies[0].material.density_kg_m3 === 7850, "material physical props carried");
assert(near(c.geometry.bodies[0].mass_kg, 0.314, 1e-9), "mass = density x volume");
assert(c.geometry.bodies[0].faces.length === 3 && !("body" in c.geometry.bodies[0].faces[0]), "body face list (without the redundant body id)");
assert(c.loads[0].vector_N.join() === "0,0,-100" && c.loads[0].magnitude_N === 100, "force load vector");
assert(c.loads[1].type === "pressure" && c.loads[1].magnitude_Pa === 2e5, "pressure load");
assert(c.gravity.enabled && c.gravity.vector_m_s2[2] === -L.G0, "gravity");
assert(c.mesh.quality === "fine" && c.solver.method === "auto", "mesh + solver");
const bad = JSON.parse(built.files["case.json"]);
bad.fixtures = []; bad.loads[0].vector_N = [1, 2]; bad.mesh.quality = "ultra";
assert(L.validateCase(bad).errors.length === 3, "validator: " + L.validateCase(bad).errors.join(" | "));
threw = false;
try { await L.buildCase({ designName: "x", bodies: [{ id: "a" }], stepBytes, study: { fixtures: [], loads: [] } }); } catch { threw = true; }
assert(threw, "buildCase refuses a study without fixtures");
// pin support + bearing load (feature request 2026-10-21 20:47: a shaft in the hole, not a weld)
const hole = { body: "Body1", idx: 6, pt: [56, 10, 5], n: [1, 0, 0], area_mm2: 377 };
const pinCase = JSON.parse((await L.buildCase({
  designName: "Arm", bodies: [{ id: "Body1" }], stepBytes,
  study: { fixtures: [{ type: "pin", faces: [hole], radial: true, tangential: true }], loads: [{ type: "bearing", faces: [hole], magnitude: 500, direction: "+X" }] },
})).files["case.json"]);
assert(pinCase.fixtures[0].type === "pin" && pinCase.fixtures[0].radial && !pinCase.fixtures[0].axial && pinCase.fixtures[0].tangential, "pin support fixture");
assert(pinCase.loads[0].type === "bearing" && pinCase.loads[0].vector_N.join() === "500,0,0", "bearing load vector");
const badPin = JSON.parse(JSON.stringify(pinCase)); badPin.fixtures[0].radial = badPin.fixtures[0].tangential = false;
assert(!L.validateCase(badPin).ok, "a pin that holds nothing is refused");
assert(L.resultSummary({ minSafetyFactor: 4.24, maxVonMises_MPa: 58.96 }) === "FOS 4.2 · 59 MPa", "result summary");
assert(near(L.adjustedScale(0.8, 200), 12.5, 1e-12), "adjusted deformation scale");

// FSF1 round trip
{
  const n = 3, m = 1, buf = new ArrayBuffer(12 + 12 * n + 16 * m), dv = new DataView(buf);
  [70, 83, 70, 49].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint32(4, n, true); dv.setUint32(8, m, true);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => dv.setFloat32(12 + 4 * i, v, true));
  [0, 1, 2].forEach((v, i) => dv.setUint32(12 + 12 * n + 4 * i, v, true));
  dv.setInt32(12 + 12 * n + 12 * m, 7, true);
  const s = L.parseSurface(new Uint8Array(buf));
  assert(s.count === 3 && s.triangles === 1 && s.positions[3] === 1 && s.index[2] === 2 && s.surface[0] === 7, "parseSurface FSF1");
}

// ---------------------------------------------------------------- end to end
const feaDir = process.env.CAD_FEA_DIR || path.join(os.homedir(), "Documents", "FEA Sim");
const py = process.env.CAD_FEA_PYTHON || "python";
const haveSolver = !process.env.FEA_SKIP_E2E && fs.existsSync(path.join(feaDir, "main.py")) &&
  spawnSync(py, ["-c", "import gmsh, scipy"], { windowsHide: true }).status === 0;
if (!haveSolver) {
  console.log("skip end-to-end FEA run (FEA Sim / python / gmsh not available, or FEA_SKIP_E2E set)");
} else {
  const K = await import("../src/kernel.js");
  await K.initKernel();
  // 200 x 20 x 10 mm cantilever with a Ø8 hole near the root (curved faces exercise face matching)
  const Ln = (a, b) => ({ id: Math.random() + "", type: "line", a, b });
  const sk = { id: "s1", type: "sketch", name: "Sketch1", plane: K.ORIGIN_PLANES.XY,
    entities: [Ln([0, 0], [200, 0]), Ln([200, 0], [200, 20]), Ln([200, 20], [0, 20]), Ln([0, 20], [0, 0]), { id: "h", type: "circle", c: [150, 10], r: 4 }] };
  let st = K.evaluate([sk]);
  const prof = st.sketches.s1.profiles.reduce((a, b) => (a.area > b.area ? a : b));
  st = K.evaluate([sk, { id: "e1", type: "extrude", profiles: [{ kind: "profile", sketch: "s1", pt: prof.center2d, area: prof.area }], distance: 10, direction: "one", operation: "auto" }]);
  const body = st.bodies[0];
  const faces = body.shape.faces;
  const ref = (i) => { const fi = K.faceInfo(body.shape, i); return { ...K.faceRef(st, body.id, i), area_mm2: fi.area, type: fi.type }; };
  const iRoot = faces.findIndex((f) => f.geomType === "PLANE" && near(f.center.x, 0, 1e-6));
  const iTip = faces.findIndex((f) => f.geomType === "PLANE" && near(f.center.x, 200, 1e-6));
  assert(iRoot >= 0 && iTip >= 0, `kernel body: ${faces.length} faces, root face ${iRoot}, tip face ${iTip}`);
  const info = K.bodyInfo(body.shape);
  const { folderName, files } = await L.buildCase({
    designName: "FEA e2e", bodies: [{ id: body.id, name: body.name, volume_mm3: info.volume, faces: faces.map((_, i) => ref(i)) }],
    stepBytes: K.exportSTEP([body]), appearances: { [body.id]: { materialId: "steel" } }, materials,
    study: { fixtures: [{ faces: [ref(iRoot)] }], loads: [{ type: "force", faces: [ref(iTip)], magnitude: 100, direction: "-Z" }], mesh: { quality: "medium" } },
  });
  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-fea-exchange-"));
  const { createFeaRunner } = require("../electron/fea-runner.cjs");
  const runner = createFeaRunner({ getConfig: () => ({ feaDir, pythonCmd: py, exchangeDir }) });
  const casePath = await runner.writeCase(folderName, files);
  const t0 = Date.now();
  const r0 = await runner.run(casePath);
  assert(r0.ok, "runner started FEA Sim " + (r0.error || ""));
  while (runner.status(casePath).running && Date.now() - t0 < 180000) await new Promise((r) => setTimeout(r, 250));
  const rb = L.normalizeReadback(await runner.readResults(casePath));
  const res = rb.results;
  assert(res && res.status === "completed", `solve completed in ${((Date.now() - t0) / 1000).toFixed(1)} s ${res && res.error ? res.error.split("\n")[0] : ""}`);
  // hole near the tip barely changes the stiffness: EB deflection PL^3/3EI = 0.8 mm (I of the full section)
  assert(near(res.maxDisplacement_mm, 0.8, 0.8 * 0.03), `tip deflection ${res.maxDisplacement_mm.toFixed(4)} mm ≈ PL³/3EI = 0.8 mm`);
  assert(near(res.reactions[0].force_N[2], 100, 1e-4), `fixture reaction ${res.reactions[0].force_N[2].toFixed(6)} N balances the 100 N load`);
  assert(res.faceMap.length === faces.length && res.faceMap.every((m) => m.distance_mm < 1e-3), `all ${faces.length} CAD faces map onto gmsh surfaces`);
  assert(new Set(res.faceMap.map((m) => m.surface)).size === faces.length, "face map is one-to-one");
  assert(res.faceMap.every((m) => m.surface === m.face + 1), "gmsh kept the replicad face order (surface = idx + 1)");
  const man = JSON.parse(new TextDecoder().decode(await runner.readFile(casePath, "viz/manifest.json")));
  const surf = L.parseSurface(new Uint8Array(await runner.readFile(casePath, "viz/surface.bin")));
  const disp = L.parseField(new Uint8Array(await runner.readFile(casePath, "viz/displacement.bin")), surf.count, 3);
  const vm = L.parseField(new Uint8Array(await runner.readFile(casePath, "viz/vonmises.bin")), surf.count);
  assert(man.format === L.VIZ_FORMAT && man.surface.vertices === surf.count, `viz manifest + surface (${surf.count} vertices, ${surf.triangles} triangles)`);
  let dmax = 0, vmax = 0;
  for (let i = 0; i < surf.count; i++) { dmax = Math.max(dmax, Math.hypot(disp[3 * i], disp[3 * i + 1], disp[3 * i + 2])); vmax = Math.max(vmax, vm[i]); }
  assert(near(dmax, res.maxDisplacement_mm, 1e-4) && near(vmax, res.maxVonMises_MPa, 1e-3 * vmax), "viz fields match results.json maxima");
  fs.rmSync(exchangeDir, { recursive: true, force: true });
}
console.log("fealink tests passed");
