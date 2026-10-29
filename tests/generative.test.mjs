// NACA airfoils, 2D flow (CPU lattice Boltzmann + panel method) and shape optimization:
// node tests/generative.test.mjs   (about 40 s)
import assert from "node:assert/strict";
import { parseNaca, nacaEntities, unitArea } from "../src/airfoil.js";
import { setupCase, LBM2D, entitiesToLoops, panelMethod, rasterize } from "../src/cfd2d.js";
import * as T from "../src/topo.js";

let n = 0;
const t = (name, fn) => { const t0 = Date.now(); fn(); n++; console.log("ok -", name, `(${Date.now() - t0} ms)`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ±${tol}`);

// ---------------------------------------------------------------- airfoils
t("NACA parsing", () => {
  assert.deepEqual(parseNaca("NACA 2412"), { series: 4, code: "2412", m: 0.02, p: 0.4, t: 0.12 });
  assert.equal(parseNaca("23012").series, 5);
  assert.throws(() => parseNaca("23112"), /Reflexed/);
  assert.throws(() => parseNaca("12"), /4- or 5-digit/);
  assert.throws(() => parseNaca("2400"), /Thickness/);
});
t("NACA 0012 area matches the published 0.0822 c^2 (closed TE slightly less)", () => {
  near(unitArea("0012", { n: 100, closedTE: false }), 0.0822, 0.0005, "blunt");
  near(unitArea("0012", { n: 100 }), 0.0817, 0.0005, "closed");
});
t("airfoil sketch entities form one closed loop with a construction chord", () => {
  const r = nacaEntities("4415", { chord: 250, alpha: 3, origin: [10, 5], n: 50 });
  const lines = r.entities.filter((e) => !e.construction);
  assert.equal(lines.length, 100);
  assert.equal(r.entities.filter((e) => e.construction).length, 1);
  for (let i = 0; i < lines.length; i++) assert.deepEqual(lines[i].b, lines[(i + 1) % lines.length].a);
  assert.equal(entitiesToLoops(r.entities).length, 1);
});

// ---------------------------------------------------------------- 2D flow
t("panel method: inviscid lift matches thin-airfoil / XFOIL-inviscid values", () => {
  const cl = (code, a) => panelMethod(entitiesToLoops(nacaEntities(code, { n: 80 }).entities)[0], a).cl;
  near(cl("0012", 0), 0, 1e-6, "0012 @0");
  near(cl("0012", 5), 0.605, 0.015, "0012 @5");
  near(cl("2412", 0), 0.26, 0.015, "2412 @0");
  near(cl("4412", 0), 0.52, 0.02, "4412 @0");
});
t("panel method: a blunt trailing edge lifts like the sharp one (Kutta on the surface panels, not the base)", () => {
  const cl = (code, a, closedTE) => panelMethod(entitiesToLoops(nacaEntities(code, { n: 80, closedTE }).entities)[0], a).cl;
  near(cl("0012", 0, false), 0, 1e-6, "blunt 0012 @0");
  for (const [code, a] of [["0012", 5], ["2412", 0], ["2412", 5], ["4412", 0], ["4412", 10]]) {
    const sharp = cl(code, a, true), blunt = cl(code, a, false);
    near(blunt, sharp, 0.03 * Math.abs(sharp), `blunt ${code} @${a}`);
  }
  near(cl("2412", 5, false), 0.864, 0.02, "blunt 2412 @5 vs XFOIL inviscid");
});
t("rasterize: even-odd fill of a square with a hole", () => {
  const sq = (c, r) => [[c - r, c - r], [c + r, c - r], [c + r, c + r], [c - r, c + r]];
  const s = rasterize([sq(10, 8), sq(10, 3)], 20, 20, 0, 0, 1);
  const filled = s.reduce((a, b) => a + b, 0);
  assert.equal(filled, 16 * 16 - 6 * 6);
});
t("lattice Boltzmann: cylinder at Re 40 holds the free stream and matches the literature drag", () => {
  // Tritton 1959 1.59, Dennis & Chang 1970 1.52. A coarse 10-cell cylinder at 3 % blockage reads
  // ~1.65; at 20 cells 1.62 (box 1) / 1.59 (box 1.5)
  const loops = entitiesToLoops([{ type: "circle", c: [0, 0], r: 10 }], 24);
  const cs = setupCase(loops, { fluid: "air", speed: (40 * 1.516e-5) / 0.02, resolution: 10 });
  near(cs.Re, 40, 0.01, "Re");
  const s = new LBM2D(cs);
  while (s.passes < 42) s.step(200); // the start-up ramp takes ~26 passes of this long box
  const m = s.mean(6);
  assert.ok(m.cd > 1.5 && m.cd < 1.72, `Cd ${m.cd} (literature 1.52-1.60)`);
  near(m.cl, 0, 0.02, "steady wake has no lift");
  // velocity inlet and pressure outlet: the inlet column is at U and the mean density stays 1
  const F = s.fields();
  let u = 0, r = 0, nf = 0;
  for (let j = 0; j < cs.ny; j++) u += F.ux[j * cs.nx];
  for (let k = 0; k < cs.nx * cs.ny; k++) if (!cs.solid[k]) { r += F.rho[k]; nf++; }
  near(u / cs.ny / cs.U, 1, 0.01, "inlet u / U");
  near(r / nf, 1, 0.005, "mean density");
});

// ---------------------------------------------------------------- shape optimization
function box(L, B, H) {
  const v = [[0, 0, 0], [L, 0, 0], [L, B, 0], [0, B, 0], [0, 0, H], [L, 0, H], [L, B, H], [0, B, H]];
  const quads = [[0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2], [0, 3, 2, 1], [4, 5, 6, 7]];
  const tris = [], groups = [];
  for (const q of quads) { groups.push([tris.length, 6]); tris.push(q[0], q[1], q[2], q[0], q[2], q[3]); }
  return { mesh: { vertices: v.flat(), triangles: tris }, groups };
}
const signedVolume = (P, I) => { let s = 0; for (let k = 0; k < I.length; k += 3) { const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2]; s += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]); } return s / 6; };
const { mesh, groups } = box(100, 20, 20);
const vox = T.voxelize(mesh, 2.5);
const fixed = T.markTriangles(mesh, [groups[0]], vox), load = T.markTriangles(mesh, [groups[1]], vox);
const problem = () => new T.TopoProblem({ vox, fixed, loads: [{ mark: load, force: [0, 0, -1000] }], preserve: new Uint8Array(vox.solid.length), E: 200000, nu: 0.3, yield: 250 });

t("voxelize a closed box exactly", () => {
  assert.deepEqual([vox.nx, vox.ny, vox.nz], [40, 8, 8]);
  assert.equal(vox.solid.reduce((a, b) => a + b, 0), 2560);
  assert.equal(fixed.reduce((a, b) => a + b, 0), 64);
});
t("hex FE cantilever: tip deflection within 10 % of Timoshenko beam theory", () => {
  const P = problem();
  P.solve(new Float64Array(P.ne).fill(1), { tol: 1e-8, maxIt: 5000 });
  let s = 0, c = 0;
  for (let q = 0; q < P.ne; q++) if (load[P.elems[q]]) for (let a = 0; a < 8; a++) { const d = P.edof[q * 24 + 3 * a + 2]; if (d >= 0) { s += P.u[d]; c++; } }
  const L = 100 - 2.5, I = 20 ** 4 / 12, G = 200000 / 2.6;
  const theory = (1000 * L ** 3) / (3 * 200000 * I) + (1000 * L) / ((5 / 6) * 400 * G);
  near(-s / c, theory, 0.1 * theory, "tip deflection");
});
t("optimization reaches the target mass and gives a closed, outward surface", () => {
  const P = problem();
  const info = T.optimize(P, { mode: "mass", targetMass: 0.5, maxIter: 60 });
  near(info.volume, 0.5, 0.03, "volume");
  const s = T.densitySurface(vox, P.elems, info.rho, 0.5, 2);
  const edges = new Map();
  for (let k = 0; k < s.indices.length; k += 3) for (let e = 0; e < 3; e++) { const a = s.indices[k + e], b = s.indices[k + ((e + 1) % 3)]; const key = a < b ? `${a},${b}` : `${b},${a}`; edges.set(key, (edges.get(key) || 0) + 1); }
  assert.ok([...edges.values()].every((v) => v === 2), "watertight");
  assert.ok(signedVolume(s.positions, s.indices) > 0.3 * 40000, "outward and roughly the kept volume");
  const stl = T.meshToSTL(s.positions, s.indices);
  assert.equal(stl.length, 84 + (s.indices.length / 3) * 50);
});

console.log(`\n${n} generative tests passed`);
