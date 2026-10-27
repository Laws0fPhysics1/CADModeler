// Fastener feature: node tests/fasteners.test.mjs
import * as K from "../src/kernel.js";
import * as F from "../src/fasteners.js";
import * as R from "replicad";
await K.initKernel();

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const bounds = (shape) => shape.boundingBox.bounds;

// every type builds, cosmetic and modeled, with a sane volume
for (const threads of ["cosmetic", "modeled"]) {
  for (const [kind] of F.KINDS) {
    if (threads === "modeled" && !["socketCap", "hexNut", "setScrew"].includes(kind)) continue; // modeled is slow; spot-check
    const t = performance.now();
    const { shape } = F.buildFastener({ kind, size: "M5", length: 16, threadLength: 0, threads });
    const v = R.measureVolume(shape);
    ok(v > 10 && v < 3000, `${threads} ${kind}: volume ${v.toFixed(1)} mm³ (${(performance.now() - t).toFixed(0)} ms)`);
  }
}

// a modeled thread is lighter than the plain shank but heavier than its core
{
  const plain = R.measureVolume(F.buildFastener({ kind: "threadedRod", size: "M6", length: 10, threads: "cosmetic" }).shape);
  const thr = R.measureVolume(F.buildFastener({ kind: "threadedRod", size: "M6", length: 10, threads: "modeled" }).shape);
  const core = Math.PI * (3 - 0.625 * 0.866 * 1) ** 2 * 10;
  ok(thr < plain && thr > core, `M6 thread volume ${thr.toFixed(1)} between core ${core.toFixed(1)} and plain ${plain.toFixed(1)}`);
}

// sizes
ok(F.autoSize(6.6) === "M6" && F.autoSize(6) === "M6" && F.autoSize(5.5) === "M5" && F.autoSize(1) === "M2", "autoSize picks the largest size that fits");
ok(F.fastenerName({ kind: "socketCap", size: "M4", length: 12 }) === "M4 × 12 Socket Cap Screw", "name");

// a 10 mm plate with a 6.6 mm clearance hole
const sk = { id: "s1", type: "sketch", name: "Sketch1", plane: K.ORIGIN_PLANES.XY, entities: [
  { id: "a", type: "line", a: [-20, -20], b: [20, -20] }, { id: "b", type: "line", a: [20, -20], b: [20, 20] },
  { id: "c", type: "line", a: [20, 20], b: [-20, 20] }, { id: "d", type: "line", a: [-20, 20], b: [-20, -20] },
  { id: "h", type: "circle", c: [5, 0], r: 3.3 }] };
let st = K.evaluate([sk]);
const prof = st.sketches.s1.profiles.reduce((a, b) => (a.area > b.area ? a : b));
const ex = { id: "e1", type: "extrude", profiles: [{ kind: "profile", sketch: "s1", pt: prof.center2d, area: prof.area }], distance: 10, direction: "one", operation: "auto" };
st = K.evaluate([sk, ex]);
const plate = st.bodies[0].shape;
const rimTop = plate.edges.findIndex((e) => e.geomType === "CIRCLE" && near(e.pointAt(0).z, 10));
const rimBot = plate.edges.findIndex((e) => e.geomType === "CIRCLE" && near(e.pointAt(0).z, 0));
ok(rimTop >= 0 && rimBot >= 0, "plate has top and bottom hole rims");

const bolt = { id: "f1", type: "fastener", kind: "socketCap", size: "auto", length: 20, threadLength: 0, threads: "cosmetic", place: { kind: "edge", ...K.edgeRef(st, "Body1", rimTop) } };
let s2 = K.evaluate([sk, ex, bolt]);
ok(!Object.keys(s2.errors).length && s2.bodies.length === 2, "bolt on the top rim: new body, no errors " + JSON.stringify(s2.errors));
let b = s2.bodies[1];
let bb = bounds(b.shape);
ok(b.name === "M6 × 20 Socket Cap Screw", `auto size from the 6.6 mm hole: ${b.name}`);
ok(near(bb[0][2], -10, 1e-3) && near(bb[1][2], 16, 1e-3), `head on top (z ${bb[0][2].toFixed(2)}..${bb[1][2].toFixed(2)}, expected -10..16)`);
ok(near((bb[0][0] + bb[1][0]) / 2, 5, 1e-3) && near((bb[0][1] + bb[1][1]) / 2, 0, 1e-3), "centred on the hole");

// from the bottom rim it comes in from below
s2 = K.evaluate([sk, ex, { ...bolt, place: { kind: "edge", ...K.edgeRef(st, "Body1", rimBot) } }]);
bb = bounds(s2.bodies[1].shape);
ok(near(bb[0][2], -6, 1e-3) && near(bb[1][2], 20, 1e-3), `bottom rim: head below (z ${bb[0][2].toFixed(2)}..${bb[1][2].toFixed(2)}, expected -6..20)`);

// flip + offset
s2 = K.evaluate([sk, ex, { ...bolt, direction: "flip", offset: 2 }]);
bb = bounds(s2.bodies[1].shape);
ok(near(bb[0][2], 2, 1e-3) && near(bb[1][2], 28, 1e-3), `flip with 2 mm offset (z ${bb[0][2].toFixed(2)}..${bb[1][2].toFixed(2)}, expected 2..28)`);

// nut on the bottom rim sits under the plate
s2 = K.evaluate([sk, ex, { id: "n", type: "fastener", kind: "hexNut", size: "auto", threads: "cosmetic", place: { kind: "edge", ...K.edgeRef(st, "Body1", rimBot) } }]);
bb = bounds(s2.bodies[1].shape);
ok(near(bb[1][2], 0, 1e-3) && near(bb[0][2], -5.2, 1e-3), `nut under the plate (z ${bb[0][2].toFixed(2)}..${bb[1][2].toFixed(2)})`);

// hole wall (cylindrical face) seats at the upper rim
const wall = plate.faces.findIndex((f) => f.geomType === "CYLINDRE");
s2 = K.evaluate([sk, ex, { ...bolt, place: { kind: "face", ...K.faceRef(st, "Body1", wall) } }]);
bb = bounds(s2.bodies[1].shape);
ok(near(bb[1][2], 16, 1e-3), `hole wall pick seats at the top rim (top z ${bb[1][2].toFixed(2)})`);

// planar face: washer at the top face centre
const top = plate.faces.findIndex((f) => f.geomType === "PLANE" && near(f.center.z, 10));
s2 = K.evaluate([sk, ex, { id: "w", type: "fastener", kind: "washer", size: "M8", threads: "cosmetic", place: { kind: "face", ...K.faceRef(st, "Body1", top) } }]);
bb = bounds(s2.bodies[1].shape);
ok(near(bb[0][2], 10, 1e-3) && near(bb[1][2], 11.6, 1e-3), "washer on the top face");

// standalone stands on XY
s2 = K.evaluate([{ id: "f", type: "fastener", kind: "hexBolt", size: "M8", length: 30, threads: "cosmetic", place: null }]);
bb = bounds(s2.bodies[0].shape);
ok(near(bb[0][2], 0, 1e-3) && near(bb[1][2], 35.3, 1e-3), `standalone bolt on the XY plane (z ${bb[0][2].toFixed(2)}..${bb[1][2].toFixed(2)})`);

// errors
s2 = K.evaluate([sk, ex, { ...bolt, place: { kind: "edge", ...K.edgeRef(st, "Body1", plate.edges.findIndex((e) => e.geomType === "LINE")) } }]);
ok(/circular edge/.test(Object.values(s2.errors)[0] || ""), "straight edge is rejected: " + Object.values(s2.errors)[0]);

// modeled: cached across replays, coarser display mesh, light STL
{
  const mb = { ...bolt, threads: "modeled", size: "M6", length: 16 };
  let t = performance.now();
  const a = K.evaluate([sk, ex, mb]);
  const first = performance.now() - t;
  t = performance.now();
  const c = K.evaluate([sk, ex, mb]);
  const second = performance.now() - t;
  ok(a.bodies[1].shape === c.bodies[1].shape, `modeled bolt is reused on replay (${first.toFixed(0)} ms, then ${second.toFixed(0)} ms)`);
  ok(a.bodies[1].meshTol > 0.1, "modeled bolt carries a display mesh tolerance");
  t = performance.now();
  const m = K.meshBody(a.bodies[1].shape, a.bodies[1].meshTol);
  const tm = performance.now() - t;
  t = performance.now();
  K.meshBody(c.bodies[1].shape, c.bodies[1].meshTol);
  ok(m.faces.triangles.length / 3 < 80000, `display mesh ${m.faces.triangles.length / 3} triangles in ${tm.toFixed(0)} ms, cached ${(performance.now() - t).toFixed(0)} ms`);
  const stl = new Uint8Array(await K.exportSTL([a.bodies[1]], { quality: "fine" }).arrayBuffer());
  const n = new DataView(stl.buffer).getUint32(80, true);
  ok(stl.length === 84 + 50 * n && n > 1000 && n < 400000, `fine STL of a modeled bolt: ${n} triangles`);
}

console.log(fails ? `${fails} fastener test(s) FAILED` : "all fastener tests passed");
process.exit(fails ? 1 : 0);
