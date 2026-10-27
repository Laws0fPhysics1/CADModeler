// Sketch profiles when lines overlap: a rectangle drawn on a face whose edges were projected into
// the sketch shares (part of) an edge with the projection. Bug report 2026-10-08 20:48: the shared
// edge was walked twice, the rectangle's profile disappeared and Extrude could only pick the face.
import * as K from "../src/kernel.js";
await K.initKernel();
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const L = (a, b) => ({ type: "line", a, b });
const areas = (ents) => K.sketchProfiles(K.ORIGIN_PLANES.XY, ents).map((p) => +p.area.toFixed(3)).sort((x, y) => x - y);

// face outline 50 x 260 plus a rectangle on its bottom edge (exact shared edge)
const face = [L([-25, 130], [25, 130]), L([25, 130], [25, -130]), L([-25, -130], [25, -130]), L([-25, 130], [-25, -130])];
let a = areas([...face, L([25, -130], [-25, -130]), L([-25, -130], [-25, -55]), L([-25, -55], [25, -55])]);
check(a.length === 2 && Math.abs(a[0] - 3750) < 1e-6 && Math.abs(a[1] - 9250) < 1e-6, `shared edge: two profiles 3750 + 9250 (${a})`);
// a rectangle whose bottom edge covers only part of the outline's edge (partial overlap)
a = areas([...face, L([-10, -130], [10, -130]), L([10, -130], [10, -100]), L([10, -100], [-10, -100]), L([-10, -100], [-10, -130])]);
check(a.length === 2 && Math.abs(a[0] - 600) < 1e-6 && Math.abs(a[1] - 12400) < 1e-6, `partial overlap: two profiles 600 + 12400 (${a})`);
// the same line drawn twice
a = areas([L([0, 0], [10, 0]), L([10, 0], [10, 10]), L([10, 10], [0, 10]), L([0, 10], [0, 0]), L([0, 0], [10, 0])]);
check(a.length === 1 && Math.abs(a[0] - 100) < 1e-6, `duplicate line: one profile 100 (${a})`);

// Bug report 2026-10-09 09:00: a line ending tangent to a circle (and a circle through a line's
// endpoint in the line's direction) gave the same leaving angle at the shared vertex; ±1e-15 noise
// in the solved coordinates decided their order and the user's sketch lost two of its three profiles.
const C = (c, r) => ({ type: "circle", c, r });
const close = (a, b, tol = 1e-3) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < tol * Math.max(1, b[i]));
const xf = (ents, f) => ents.map((e) => (e.type === "circle" ? { ...e, c: f(e.c) } : { ...e, a: f(e.a), b: f(e.b), ...(e.m ? { m: f(e.m) } : {}) }));
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
const jitter = (ents, s) => { const m = new Map(); return xf(ents, (p) => { const k = p.join(); if (!m.has(k)) m.set(k, [p[0] + rnd() * s, p[1] + rnd() * s]); return m.get(k); }); };
const user = (o, a, c, b, d) => [L(o, a), L(o, c), L(a, b), C(c, 30), L(c, d)];
const userExpect = [193.142, 1413.717, 1413.717];
a = areas(user([0, 0], [30, 0], [0, 30], [30, 30], [0, 60]));
check(close(a, userExpect), `user dome sketch, clean coordinates: three profiles (${a})`);
a = areas(user([0, 0], [30, 0], [1.83697019872103e-15, 30], [30.000000000000004, 30], [3.67394039744206e-15, 60]));
check(close(a, userExpect), `user dome sketch, solver coordinates: same three profiles (${a})`);
for (const s of [1e-12, 1e-9]) for (let k = 0; k < 4; k++) {
  a = areas(jitter(user([0, 0], [30, 0], [0, 30], [30, 30], [0, 60]), s));
  check(close(a, userExpect), `user dome sketch jittered ±${s} #${k}: three profiles (${a})`);
}
const rot = (deg, sc = 1, t = [0, 0]) => { const q = (deg * Math.PI) / 180, cs = Math.cos(q), sn = Math.sin(q); return (p) => [t[0] + sc * (cs * p[0] - sn * p[1]), t[1] + sc * (sn * p[0] + cs * p[1])]; };
for (const deg of [37, 90, 180, 211]) { // rotated + shifted (radius unchanged)
  a = areas(xf(user([0, 0], [30, 0], [0, 30], [30, 30], [0, 60]), rot(deg, 1, [7.3, -2.1])));
  check(close(a, userExpect), `user dome sketch rotated ${deg}° and shifted: three profiles (${a})`);
}
// U under a circle, its two sides ending tangent to it: disc + the U region (300 - half disc)
const U = [C([0, 0], 10), L([10, 0], [10, -15]), L([10, -15], [-10, -15]), L([-10, -15], [-10, 0])];
const uExpect = [300 - 50 * Math.PI, 100 * Math.PI];
for (const [name, ents] of [["clean", U], ["jitter 1e-12", jitter(U, 1e-12)], ["jitter 1e-9", jitter(U, 1e-9)], ["rotated 23°", xf(U, rot(23))], ["rotated 23° + jitter 1e-9", jitter(xf(U, rot(23)), 1e-9)]]) {
  a = areas(ents);
  check(close(a, uExpect), `tangent U under a circle (${name}): disc + U (${a})`);
}
// slot: lines continued by tangent arcs, split in half by a line across (T-junctions)
const Arc = (a, m, b) => ({ type: "arc", a, m, b });
const slot = [L([0, -5], [20, -5]), Arc([20, -5], [25, 0], [20, 5]), L([20, 5], [0, 5]), Arc([0, 5], [-5, 0], [0, -5]), L([10, -5], [10, 5])];
const sExpect = [100 + 12.5 * Math.PI, 100 + 12.5 * Math.PI];
for (const [name, ents] of [["clean", slot], ["jitter 1e-12", jitter(slot, 1e-12)], ["rotated 71° + jitter 1e-9", jitter(xf(slot, rot(71)), 1e-9)]]) {
  a = areas(ents);
  check(close(a, sExpect), `slot with tangent arcs (${name}): two halves (${a})`);
}
// the user's design replays the body they revolved (square + quarter disc, 270°): 5 faces.
// It was revolved from a single merged profile (area 1606.86); that region is now two profiles and
// resolveProfileSet picks both.
{
  const { readFileSync } = await import("node:fs");
  const d = { features: JSON.parse(readFileSync(new URL("./fixtures-profile-tangent.json", import.meta.url), "utf8")) }; // features of that report's design
  const st = K.evaluate(d.features);
  const b = st.bodies[0];
  const vol = b ? K.bodyInfo(b.shape).volume : null;
  const want = (1606.858 * 14.0025 * 2 * Math.PI * 270) / 360; // Pappus: area × centroid radius × angle
  check(st.bodies.length === 1 && b.shape.faces.length === 5 && !Object.keys(st.errors).length, `user design rebuilds the 5-face revolve (${b && b.shape.faces.length} faces)`);
  if (vol != null) check(Math.abs(vol - want) < 1e-3 * want, `user design volume ${vol.toFixed(1)} ≈ ${want.toFixed(1)}`);
}

// a bridge: a line from a square hole out to the outer square doesn't split the ring (bug report
// 2026-10-20 19:27: the ring came out as one face with a zero-width slit, and extrudes made invalid bodies)
{
  const sq = (h) => [L([-h, -h], [h, -h]), L([h, -h], [h, h]), L([h, h], [-h, h]), L([-h, h], [-h, -h])];
  a = areas([...sq(10), ...sq(4), L([0, 4], [0, 10])]);
  check(a.length === 2 && Math.abs(a[0] - 64) < 1e-6 && Math.abs(a[1] - 336) < 1e-6, `bridge: ring 336 + hole 64 (${a})`);
  const ring = K.sketchProfiles(K.ORIGIN_PLANES.XY, [...sq(10), ...sq(4), L([0, 4], [0, 10])]).find((p) => p.area > 300);
  const R = await import("replicad");
  const body = R.basicFaceExtrusion(ring.face, new R.Vector([0, 0, 5]));
  const oc = R.getOC(), chk = new oc.BRepCheck_Analyzer(body.wrapped, true, false);
  const slit = body.faces.some((f) => { const c = f.center, x = c.toTuple ? c.toTuple()[0] : c.x; return f.geomType === "PLANE" && Math.abs(x) < 1e-6 && f.boundingBox.bounds[1][0] - f.boundingBox.bounds[0][0] < 1e-6; });
  check((chk.IsValid_2 ? chk.IsValid_2() : chk.IsValid()) && !slit, `bridge: extruded ring is a valid solid without a slit face (${body.faces.length} faces)`);
}

console.log(fails ? `\n${fails} failed` : "\nall profile tests passed");
process.exit(fails ? 1 : 0);
