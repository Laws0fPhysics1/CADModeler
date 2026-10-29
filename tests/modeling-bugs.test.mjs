// Regression tests for the modeling bug reports of 2026-10-26 (agent tests 1 and 2):
//  - 17:44 sketches on a face didn't follow the face when an upstream feature changed
//  - 17:44 an oversized fillet returned an invalid solid with no error; raw OCCT errors read "[object WebAssembly.Exception]"
//  - 17:47 Offset Face with a positive distance on curved faces made an invalid body
import fs from "node:fs";
import * as K from "../src/kernel.js";
import * as R from "replicad";
await K.initKernel();
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const vol = (st, i = 0) => K.bodyInfo(st.bodies[i].shape).volume;

// ---------- 1. sketches on a face follow the face ----------
{
  const bracket = fixture("fixtures-bracket.json");
  const F = bracket.slice(0, -1);                       // without Fillet2
  const base = K.evaluate(F);
  check(!Object.keys(base.errors).length && near(vol(base), 44130.35, 0.05), `bracket as built: V ${vol(base).toFixed(2)} (44130.35)`);
  const G = clone(F);
  G.find((f) => f.name === "Extrude1").distance = 12;
  const st = K.evaluate(G), b = st.bodies[0], bi = K.bodyInfo(b.shape);
  const z = (name) => st.sketches[G.find((f) => f.name === name).id].plane.origin[2];
  check(near(z("Sketch2"), 12, 1e-6) && near(z("Sketch3"), 12, 1e-6), `face sketches moved to the new top face z=12 (${z("Sketch2")}, ${z("Sketch3")})`);
  const s4 = st.sketches[G.find((f) => f.name === "Sketch4").id].plane;
  check(near(s4.origin[2], 34, 1e-6) && near(s4.origin[0], 0, 1e-6), `flange-face sketch keeps its in-plane origin (${s4.origin.map((v) => +v.toFixed(3))})`);
  check(near(bi.bounds[1][2], 72, 1e-6), `flange rides on the thicker plate: top z ${bi.bounds[1][2].toFixed(3)} (72)`);
  // V = 80·40·12 + 8·40·60 + (25-25π/4)·40 - π·16·8 (8 mm cut from the new top face) - π·16·8 (flange hole) - 80 (chamfer)
  const expV = 80 * 40 * 12 + 8 * 40 * 60 + (25 - (25 * Math.PI) / 4) * 40 - 2 * Math.PI * 16 * 8 - 80;
  check(!Object.keys(st.errors).length && near(bi.volume, expV, 0.05), `edited bracket V ${bi.volume.toFixed(2)} (${expV.toFixed(2)})`);
  const sec = (zz) => K.sectionBody(b.shape, { origin: [0, 0, zz], xDir: [1, 0, 0], normal: [0, 0, 1] }).area;
  check(near(sec(10), 3200 - 16 * Math.PI, 0.05), `hole is cut from the moved top face: section z=10 area ${sec(10).toFixed(2)} (3149.73)`);
  check(near(sec(2), 3200, 0.05), `8 mm cut from z=12 stays blind below z=4: section z=2 area ${sec(2).toFixed(2)} (3200)`);
  check(st.sketches[G.find((f) => f.name === "Sketch2").id].host === "Body1", "face sketch keeps its host body");
  // 2D frame carried over: same xDir, so the sketch coordinates map to the same in-plane positions
  const p0 = base.sketches.f3.plane, p1 = st.sketches.f3.plane;
  check(p0.xDir.every((v, i) => near(v, p1.xDir[i], 1e-9)) && near(p1.origin[0], p0.origin[0], 1e-9) && near(p1.origin[1], p0.origin[1], 1e-9), "face sketch keeps its xDir and in-plane origin");
  // incremental replay cache: back to 8 mm gives the original body again
  check(near(vol(K.evaluate(F)), 44130.35, 0.05), "replay cache: original bracket again after the edit");
  // a face that turned: the frame turns by the smallest rotation and the origin is projected onto it
  const fp = K.followPlane({ origin: [1, 2, 3], xDir: [1, 0, 0], normal: [0, 0, 1] }, { origin: [5, 5, 5], xDir: [0, 1, 0], normal: [1, 0, 0] });
  check(near(fp.normal[0], 1, 1e-12) && near(fp.xDir[2], -1, 1e-9) && near(fp.origin[0], 5, 1e-9) && near(fp.origin[1], 2, 1e-9), `followPlane on a turned face (${JSON.stringify(fp)})`);
  // a sketch whose face body is gone keeps its stored plane (no error)
  const lost = K.sketchPlane({ bodies: [], planes: {} }, G.find((f) => f.name === "Sketch2"));
  check(lost.origin[2] === 8, "sketch on a missing body keeps its stored plane");
}

// ---------- 2. oversized fillet / chamfer ----------
{
  const F = fixture("fixtures-bracket.json");
  const before = K.evaluate(F.slice(0, -1)), v0 = vol(before);
  const at = (r) => { const G = clone(F); G[G.length - 1].radius = r; const st = K.evaluate(G); return { st, err: st.errors[G[G.length - 1].id], v: vol(st), ok: K.isValidShape(st.bodies[0].shape) }; };
  const r6 = at(6), r20 = at(20);
  check(!r6.err && r6.ok && near(r6.v - v0, -518.38, 0.05), `fillet r6: valid, dV ${(r6.v - v0).toFixed(2)} (-518.38)`);
  check(r20.err === "Fillet radius too large for this edge" && r20.ok && near(r20.v, v0, 1e-6), `fillet r20: error "${r20.err}", body unchanged and valid`);
  const box = { id: "b", type: "box", length: 40, width: 20, height: 8, operation: "new" };
  const bs = K.evaluate([box]), sh = bs.bodies[0].shape;
  const i = sh.edges.findIndex((e) => near(e.startPoint.z, 8, 1e-6) && near(e.endPoint.z, 8, 1e-6) && Math.abs(e.startPoint.x - e.endPoint.x) > 30);
  const fe = K.evaluate([box, { id: "f", type: "fillet", edges: [K.edgeRef(bs, bs.bodies[0].id, i)], radius: 10 }]).errors.f;
  check(fe && !/object WebAssembly/.test(fe) && /too large/.test(fe), `box fillet r10: readable error "${fe}"`);
  const ce = K.evaluate([box, { id: "c", type: "chamfer", edges: [K.edgeRef(bs, bs.bodies[0].id, i)], distance: 12 }]).errors.c;
  check(ce && !/object WebAssembly/.test(ce), `box chamfer 12: readable error "${ce}"`);
  const pv = K.previewFeature(bs, { id: "f", type: "fillet", edges: [K.edgeRef(bs, bs.bodies[0].id, i)], radius: 10 });
  check(pv.error && !/object WebAssembly/.test(pv.error), `preview error is readable too ("${pv.error}")`);
  let raw; try { R.makeBox([0, 0, 0], [1, 1, 1]).fillet(5); } catch (e) { raw = e; }
  check(raw && /geometry kernel error: .*NotDone/.test(K.featureErrorText(raw, { type: "extrude" })), `generic OCCT error text: "${raw && K.featureErrorText(raw, { type: "extrude" })}"`);
}

// ---------- 3. positive Offset Face on curved faces ----------
{
  const cyl = { id: "oc", type: "cylinder", radius: 5, height: 10, operation: "new" };
  const cs = K.evaluate([cyl]);
  const side = cs.bodies[0].shape.faces.map((f, i) => [f, i]).filter(([f]) => f.geomType === "CYLINDRE").map(([, i]) => K.faceRef(cs, cs.bodies[0].id, i));
  for (const d of [1, -1]) {
    const feats = [cyl, { id: "o", type: "offsetFace", faces: side, distance: d }];
    const s = K.evaluate(feats), sh = s.bodies[0].shape;
    const rim = sh.edges.map((e, i) => [e, i]).filter(([e]) => e.geomType === "CIRCLE" && near(e.pointAt(0).z, 10, 1e-6)).map(([, i]) => K.edgeRef(s, s.bodies[0].id, i));
    check(!s.errors.o && K.isValidShape(sh) && sh.edges.length === 3 && near(vol(s), Math.PI * (5 + d) ** 2 * 10, 1e-3), `cylinder side ${d > 0 ? "+" : ""}${d}: valid, ${sh.edges.length} edges, V ${vol(s).toFixed(3)}`);
    const f = K.evaluate([...feats, { id: "f", type: "fillet", edges: rim, radius: 1 }]);
    // Pappus: the removed spandrel (area 1 - π/4) has its centroid (10 - 3π)/(12 - 3π) from the corner
    const r = 5 + d, expF = Math.PI * r * r * 10 - 2 * Math.PI * (r - (10 - 3 * Math.PI) / (12 - 3 * Math.PI)) * (1 - Math.PI / 4);
    check(!f.errors.f && rim.length === 1 && near(vol(f), expF, 0.05) && K.isValidShape(f.bodies[0].shape), `  then fillet r1 on the top rim: V ${vol(f).toFixed(3)} (${expF.toFixed(3)})`);
  }
  // the report's plate: Ø10 through hole, hole wall +1 -> Ø8
  const P = fixture("fixtures-plate-hole.json");
  const ps = K.evaluate(P), psh = ps.bodies[0].shape;
  check(!Object.keys(ps.errors).length && K.isValidShape(psh) && near(vol(ps), 50000 - Math.PI * 16 * 5, 1e-3), `plate hole wall +1: valid, V ${vol(ps).toFixed(3)} (49748.673)`);
  const topRim = psh.edges.map((e, i) => [e, i]).filter(([e]) => e.geomType === "CIRCLE" && near(e.pointAt(0).z, 5, 1e-6)).map(([, i]) => K.edgeRef(ps, ps.bodies[0].id, i));
  const pc = K.evaluate([...P, { id: "c", type: "chamfer", edges: topRim, distance: 0.5 }]);
  check(!pc.errors.c && topRim.length >= 1 && near(vol(pc), 49745.40, 0.05) && K.isValidShape(pc.bodies[0].shape), `  then chamfer 0.5 on the hole rim: V ${vol(pc).toFixed(2)} (49745.40)`);
  const step = K.exportSTEP([ps.bodies[0]]);
  const stepText = typeof step === "string" ? step : new TextDecoder().decode(step instanceof Blob ? new Uint8Array(await step.arrayBuffer()) : step);
  check(/MANIFOLD_SOLID_BREP/.test(stepText), "  STEP export of the offset plate carries a solid");
  // the stepped shaft's concave shoulder fillet (torus) +0.5
  const T = fixture("fixtures-shaft-torus.json");
  const T0 = K.evaluate(T.slice(0, -1)), ts = K.evaluate(T);
  check(!Object.keys(ts.errors).length && K.isValidShape(ts.bodies[0].shape) && vol(ts) > vol(T0), `shaft shoulder fillet (torus) +0.5: valid, dV ${(vol(ts) - vol(T0)).toFixed(3)}`);
}

console.log(fails ? `\n${fails} failed` : "\nall modeling bug tests passed");
process.exit(fails ? 1 : 0);
