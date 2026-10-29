// Sketch Offset: node tests/sketchoffset.test.mjs
// Bug report 2026-10-26 17:42 (agent test 4): an airfoil couldn't be offset inward (wing skin) at all, because the
// tiny segments near the leading / trailing edge reverse and the whole offset aborted. They are now dropped and
// their neighbours re-intersected; genuinely too-large offsets still error.
import * as SM from "../src/sketchmodel.js";
import { nacaEntities } from "../src/airfoil.js";
import { findChain, offsetChain, chainSide, itemsToFlat } from "../src/sketchoffset.js";
import { solve } from "../src/solver.js";
import * as K from "../src/kernel.js";

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const segDist = (p, a, b) => { const v = sub(b, a), l2 = v[0] ** 2 + v[1] ** 2, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / l2)); return dist(p, [a[0] + v[0] * t, a[1] + v[1] * t]); };
const inPoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const area = (poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const selfIntersects = (poly) => {
  const N = poly.length;
  for (let i = 0; i < N; i++) for (let j = i + 2; j < N; j++) {
    if (i === 0 && j === N - 1) continue;
    const p1 = poly[i], p2 = poly[(i + 1) % N], q1 = poly[j], q2 = poly[(j + 1) % N];
    const d1 = cross(p1, p2, q1), d2 = cross(p1, p2, q2), d3 = cross(q1, q2, p1), d4 = cross(q1, q2, p2);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
};
const chainOf = (m) => findChain(m, m.entities.find((e) => !e.construction).id);
const inward = (m, ch, inside, d) => offsetChain(m, ch, d * Math.sign(chainSide(m, ch, inside)));

// --- airfoils, inward, the reported case and its relatives ---
await K.initKernel();
for (const code of ["0012", "2412", "4412"]) for (const sharp of [true, false]) {
  const af = nacaEntities(code, { chord: 200, n: 60, closedTE: sharp });
  const m = SM.addFlat(SM.emptyModel(), af.entities);
  const ch = chainOf(m), ring = af.outline.slice(0, sharp ? -1 : undefined);
  const outerArea = Math.abs(area(ring));
  for (const d of [0.5, 1, 1.5, 2, 3, 4, 5]) {
    const tag = `NACA ${code} ${sharp ? "sharp" : "blunt"} inward ${d} mm`;
    const r = inward(m, ch, [80, 2], d);
    if (r.error) { check(false, `${tag}: ${r.error}`); continue; }
    const it = r.items, poly = it.map((x) => x.a);
    const closedOk = it.every((x, i) => dist(x.b, it[(i + 1) % it.length].a) < 1e-9);
    const inside = poly.every((p) => inPoly(p, ring));
    const minD = Math.min(...poly.map((p) => Math.min(...ring.map((a, i) => segDist(p, a, ring[(i + 1) % ring.length])))));
    const ia = Math.abs(area(poly));
    const srcOk = it.every((x) => x.type === "line" && x.src);
    check(closedOk && inside && !selfIntersects(poly) && minD > d - 1e-6 && ia < outerArea && srcOk,
      `${tag}: ${it.length}/${ch.segs.length} lines, closed ${closedOk}, inside ${inside}, min dist ${minD.toFixed(4)}, area ${ia.toFixed(1)} < ${outerArea.toFixed(1)}`);
    if (d === 1.5 || d === 5) {
      // extrude outline minus offset: one shell solid of (outer - inner) area x 10
      let k = 0;
      const ents = [...af.entities.filter((e) => !e.construction), ...itemsToFlat(it)].map((e) => ({ ...e, id: `x${k++}` }));
      const sk = { id: "s1", type: "sketch", name: "Sketch1", plane: K.ORIGIN_PLANES.XY, entities: ents };
      const profs = K.evaluate([sk]).sketches.s1.profiles;
      const shell = profs.find((p) => Math.abs(p.area - (outerArea - ia)) < 1e-3 * outerArea);
      if (!shell) { check(false, `${tag}: no skin profile (${profs.map((p) => p.area.toFixed(1))})`); continue; }
      const ex = { id: "e1", type: "extrude", profiles: [{ kind: "profile", sketch: "s1", pt: shell.center2d, area: shell.area }], distance: 10, direction: "one", operation: "auto" };
      const st = K.evaluate([sk, ex]);
      const vol = st.bodies.length === 1 ? K.bodyInfo(st.bodies[0].shape).volume : NaN;
      check(st.bodies.length === 1 && !st.errors.length && Math.abs(vol - shell.area * 10) < 1e-3 * vol,
        `${tag}: skin extrudes to one solid, volume ${vol.toFixed(1)} (expected ${(shell.area * 10).toFixed(1)}) ${JSON.stringify(st.errors)}`);
    }
  }
  // an airfoil can't be offset inward by more than its half thickness
  check(!!inward(m, ch, [80, 2], 20).error, `NACA ${code} ${sharp ? "sharp" : "blunt"} inward 20 mm (past the medial axis) refused`);
  const o = offsetChain(m, ch, -2 * Math.sign(chainSide(m, ch, [80, 2])));
  check(!o.error && o.items.length >= ch.segs.length, `NACA ${code} ${sharp ? "sharp" : "blunt"} outward 2 mm ok (${o.error || o.items.length + " items"})`);
}

// --- 10 degree triangle (sharp vertex) and past its inradius (~8.0) ---
{
  const pts = [[0, 0], [100, 0], [100, 17.6]];
  const m = SM.addFlat(SM.emptyModel(), pts.map((p, i) => ({ type: "line", a: p, b: pts[(i + 1) % 3] })));
  const ch = chainOf(m);
  for (const d of [0.5, 2, 5]) { const r = inward(m, ch, [80, 5], d); check(!r.error && r.items.length === 3, `triangle 10deg inward ${d}: ${r.error || r.items.length + " lines"}`); }
  check(!!inward(m, ch, [80, 5], 8.5).error, "triangle 10deg inward 8.5 (past the inradius) refused");
}

// --- slot 20 x 16 (two lines, two r 8 arcs): ±3 and 7.9 ok, 8.1 refused ---
{
  const m = SM.addFlat(SM.emptyModel(), [
    { type: "line", a: [0, -8], b: [20, -8] }, { type: "arc", a: [20, -8], b: [20, 8], m: [28, 0] },
    { type: "line", a: [20, 8], b: [0, 8] }, { type: "arc", a: [0, 8], b: [0, -8], m: [-8, 0] },
  ]);
  const ch = chainOf(m);
  for (const d of [3, -3, 7.9]) {
    const r = inward(m, ch, [10, 6], d);
    const arcs = r.items ? r.items.filter((x) => x.type === "arc") : [];
    check(!r.error && r.items.length === 4 && arcs.every((a) => a.centerId && Math.abs(a.r - (8 - d)) < 1e-9), `slot inward ${d}: ${r.error || "4 items, concentric arcs r " + arcs.map((a) => a.r.toFixed(2))}`);
  }
  const r = inward(m, ch, [10, 6], 8.1);
  check(!!r.error, `slot inward 8.1 refused (${r.error})`);
}

// --- rounded rectangle 40 x 20, r 2 fillets: inward 3 drops the fillets (sharp inner corners) ---
{
  const f = 2, W = 40, H = 20, s = Math.SQRT1_2 * f;
  const m = SM.addFlat(SM.emptyModel(), [
    { type: "line", a: [f, 0], b: [W - f, 0] }, { type: "arc", a: [W - f, 0], b: [W, f], m: [W - f + s, f - s] },
    { type: "line", a: [W, f], b: [W, H - f] }, { type: "arc", a: [W, H - f], b: [W - f, H], m: [W - f + s, H - f + s] },
    { type: "line", a: [W - f, H], b: [f, H] }, { type: "arc", a: [f, H], b: [0, H - f], m: [f - s, H - f + s] },
    { type: "line", a: [0, H - f], b: [0, f] }, { type: "arc", a: [0, f], b: [f, 0], m: [f - s, f - s] },
  ]);
  const ch = chainOf(m);
  const r1 = inward(m, ch, [20, 10], 1);
  check(!r1.error && r1.items.length === 8, `rounded rect inward 1: ${r1.error || r1.items.length + " items (fillets kept, r 1)"}`);
  const r = inward(m, ch, [20, 10], 3);
  const corners = r.items ? r.items.map((x) => x.a.map((v) => +v.toFixed(6)).join(",")).sort() : [];
  check(!r.error && r.items.length === 4 && JSON.stringify(corners) === JSON.stringify(["3,17", "3,3", "37,17", "37,3"].sort()), `rounded rect inward 3: ${r.error || corners.join(" ")}`);
  check(!!inward(m, ch, [20, 10], 10.5).error, "rounded rect inward 10.5 (whole shape gone) refused");
}

// --- one driving dimension (as sketcher.js commitOffset builds it) still solves after segments were dropped ---
{
  const af = nacaEntities("2412", { chord: 200, n: 60 });
  const m = SM.addFlat(SM.emptyModel(), af.entities);
  const ch = chainOf(m), sgn = Math.sign(chainSide(m, ch, [80, 2]));
  const r = offsetChain(m, ch, 1.5 * sgn), items = r.items, n = items.length;
  const addPoint = (p) => { const id = SM.sid("p"); m.points[id] = { x: p[0], y: p[1] }; return id; };
  let startId = null, firstStart = null;
  const newLines = [];
  items.forEach((it, i) => {
    const a = startId || addPoint(it.a);
    if (i === 0) firstStart = a;
    const b = i === n - 1 ? firstStart : addPoint(it.b);
    startId = b;
    const e = { id: SM.sid("e"), type: "line", p1: a, p2: b };
    m.entities.push(e);
    newLines.push([it.src, e.id]);
  });
  for (const [src, id] of newLines) m.constraints.push({ id: SM.sid("c"), type: "parallel", e: [src, id] }, { id: SM.sid("d"), type: "dim", kind: "lineDist", e: [src, id], value: 1.5 });
  const hold = new Set(ch.segs.flatMap((s) => { const e = m.entities.find((x) => x.id === s.id); return [e.p1, e.p2]; }));
  const ok1 = solve(m, { fixedKeys: hold }).ok;
  for (const c of m.constraints) if (c.kind === "lineDist") c.value = 1.52; // the linked dims follow the lead one
  const ok2 = solve(m, { fixedKeys: hold }).ok;
  const want = offsetChain(m, ch, 1.52 * sgn).items;
  const P = (id) => [m.points[id].x, m.points[id].y];
  const bySrc = new Map(want.map((w) => [w.src, w]));
  const err = Math.max(...newLines.map(([src, id]) => { const w = bySrc.get(src), e = m.entities.find((x) => x.id === id); return w ? Math.max(dist(P(e.p1), w.a), dist(P(e.p2), w.b)) : Infinity; }));
  check(ok1 && ok2 && want.length === n && err < 1e-3, `2412 inward 1.5 -> 1.52 by its dimension: ${n} lines, solves ${ok1}/${ok2}, max corner error ${err.toExponential(2)}`);
}

console.log(fails ? `${fails} FAILED` : "all sketch offset tests passed");
if (fails) process.exitCode = 1;
