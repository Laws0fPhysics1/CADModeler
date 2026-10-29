// Sketch Offset (feature request 2026-10-20 "i want the offset tool to be added. Both in sketch and 3D"). DOM-free.
// findChain() collects the curves connected end to end with the picked one (Fusion's chain selection);
// offsetChain() offsets them by a signed distance: positive = the left side of the chain's travel direction
// (for a counter-clockwise closed loop that is inside). Lines stay lines, arcs stay concentric arcs; at corners
// neighbouring offset curves are extended / trimmed to meet, and where they can't meet (outside of a corner
// next to an arc) a round corner centred on the original vertex fills the gap.
import { arcInfo, P } from "./sketchmodel.js";

const EPS = 1e-9;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const dist = (a, b) => len(sub(a, b));
const unit = (a) => { const l = len(a); return l > EPS ? [a[0] / l, a[1] / l] : [0, 0]; };
const left = (u) => [-u[1], u[0]];

const ends = (e) => (e.type === "line" ? [e.p1, e.p2] : e.type === "arc" ? [e.p1, e.p2] : []);

/** Curves connected end to end with `startId` (a circle is a chain by itself). { segs: [{ id, rev }], closed } */
export function findChain(m, startId) {
  const start = m.entities.find((e) => e.id === startId);
  if (!start) return null;
  if (start.type === "circle") return { segs: [{ id: start.id, rev: false }], closed: true, circle: true };
  const usable = (e) => (e.type === "line" || e.type === "arc") && !!e.construction === !!start.construction;
  const at = new Map();
  for (const e of m.entities) if (usable(e)) for (const p of ends(e)) { if (!at.has(p)) at.set(p, []); at.get(p).push(e); }
  // walk forward from start.p2, then backward from start.p1; only through points joining exactly two curves
  const segs = [{ id: start.id, rev: false }], used = new Set([start.id]);
  let closed = false;
  const walk = (fromPoint, pushFront) => {
    let p = fromPoint;
    for (;;) {
      const list = at.get(p) || [];
      if (list.length !== 2) return;
      const next = list.find((e) => !used.has(e.id));
      if (!next) { if (list.every((e) => used.has(e.id)) && segs.length > 1) closed = true; return; }
      used.add(next.id);
      const [a, b] = ends(next);
      // forward walk: the next curve starts at p; backward walk: it ends at p
      const rev = pushFront ? b !== p : a !== p;
      if (pushFront) segs.unshift({ id: next.id, rev }); else segs.push({ id: next.id, rev });
      p = pushFront ? (rev ? b : a) : (rev ? a : b);
    }
  };
  walk(start.p2, false);
  if (!closed) walk(start.p1, true);
  // a single curve whose ends meet (rare) or a loop found from the back
  if (!closed && segs.length > 1) {
    const s0 = segGeom(m, segs[0]), sN = segGeom(m, segs[segs.length - 1]);
    if (s0.startId === sN.endId) closed = true;
  }
  return { segs, closed };
}

/** A chain segment in travel direction. line: { a, b }; arc: { c, r, sweep (signed, + = CCW) , a, b } */
export function segGeom(m, s) {
  const e = m.entities.find((x) => x.id === s.id);
  if (e.type === "line") {
    const [a, b] = s.rev ? [P(m, e.p2), P(m, e.p1)] : [P(m, e.p1), P(m, e.p2)];
    return { type: "line", id: e.id, a, b, startId: s.rev ? e.p2 : e.p1, endId: s.rev ? e.p1 : e.p2 };
  }
  if (e.type === "arc") {
    const i = arcInfo(m, e);
    return s.rev
      ? { type: "arc", id: e.id, c: i.c, r: i.r, centerId: e.c, sweep: -i.sweep, a: i.b, b: i.a, startId: e.p2, endId: e.p1 }
      : { type: "arc", id: e.id, c: i.c, r: i.r, centerId: e.c, sweep: i.sweep, a: i.a, b: i.b, startId: e.p1, endId: e.p2 };
  }
  return { type: "circle", id: e.id, c: P(m, e.c), r: e.r, centerId: e.c };
}

/** Signed distance of p from the chain (+ = left of travel; circles: + = inside), measured to the nearest curve. */
export function chainSide(m, chain, p) {
  let best = null;
  for (const s of chain.segs) {
    const g = segGeom(m, s);
    let d, sd;
    if (g.type === "line") {
      const u = unit(sub(g.b, g.a)), t = Math.max(0, Math.min(len(sub(g.b, g.a)), dot(sub(p, g.a), u)));
      d = dist(p, add(g.a, mul(u, t)));
      sd = dot(sub(p, g.a), left(u));
    } else {
      const rp = dist(p, g.c);
      d = Math.abs(rp - g.r);
      sd = g.type === "circle" || g.sweep > 0 ? g.r - rp : rp - g.r;
    }
    if (!best || d < best.d) best = { d, sd };
  }
  return best ? best.sd : 0;
}

function offsetSeg(g, d) {
  if (g.type === "line") {
    const n = mul(left(unit(sub(g.b, g.a))), d);
    return { ...g, a: add(g.a, n), b: add(g.b, n) };
  }
  // left of travel is toward the centre on a CCW arc
  const r = g.type === "circle" || g.sweep > 0 ? g.r - d : g.r + d;
  if (r <= 1e-6) return null;
  if (g.type === "circle") return { ...g, r };
  const on = (p) => add(g.c, mul(unit(sub(p, g.c)), r));
  return { ...g, r, a: on(g.a), b: on(g.b) };
}

// intersections of two offset curves taken as full lines / circles
function intersect(g1, g2) {
  const lineOf = (g) => ({ p: g.a, u: unit(sub(g.b, g.a)) });
  if (g1.type === "line" && g2.type === "line") {
    const A = lineOf(g1), B = lineOf(g2), den = A.u[0] * B.u[1] - A.u[1] * B.u[0];
    if (Math.abs(den) < 1e-12) return [];
    const t = ((B.p[0] - A.p[0]) * B.u[1] - (B.p[1] - A.p[1]) * B.u[0]) / den;
    return [add(A.p, mul(A.u, t))];
  }
  if (g1.type === "line" || g2.type === "line") {
    const L = lineOf(g1.type === "line" ? g1 : g2), C = g1.type === "line" ? g2 : g1;
    const f = sub(L.p, C.c), b = dot(f, L.u), c = dot(f, f) - C.r * C.r, disc = b * b - c;
    if (disc < -1e-12) return [];
    const s = Math.sqrt(Math.max(0, disc));
    return [add(L.p, mul(L.u, -b - s)), add(L.p, mul(L.u, -b + s))];
  }
  const dvec = sub(g2.c, g1.c), D = len(dvec);
  if (D < EPS || D > g1.r + g2.r + 1e-9 || D < Math.abs(g1.r - g2.r) - 1e-9) return [];
  const a = (g1.r * g1.r - g2.r * g2.r + D * D) / (2 * D), h = Math.sqrt(Math.max(0, g1.r * g1.r - a * a));
  const u = mul(dvec, 1 / D), pm = add(g1.c, mul(u, a));
  return [add(pm, mul(left(u), h)), add(pm, mul(left(u), -h))];
}

/**
 * Offset a chain by signed distance d. Returns { items, error }. items, in chain order:
 *   { type: "line", a, b, src } | { type: "arc", c, r, a, b, ccw, centerId, src } | { type: "circle", c, r, centerId, src }
 *   | { type: "arc", corner: vertexPointId, c, r, a, b, ccw } (round corner)
 * Consecutive items share end points exactly (a closed chain's last item ends where the first starts).
 * Curves whose offset collapses or reverses (short segments on the inside of a bend, e.g. at an airfoil's
 * leading / trailing edge, or arcs smaller than the offset) are dropped and their neighbours re-intersected
 * (bug report 2026-10-26 17:42), so there can be fewer items than the chain has curves; each kept item still
 * names its source curve in `src`. The finished loop is checked (no self-intersection and, for a closed
 * chain, nothing closer than |d| to the original), else the offset is reported as too large.
 */
export function offsetChain(m, chain, d) {
  if (!chain || !chain.segs.length) return { items: [], error: "Nothing to offset" };
  if (Math.abs(d) < 1e-9) return { items: [], error: "Offset distance is zero" };
  const geo = chain.segs.map((s) => segGeom(m, s));
  if (geo[0].type === "circle") {
    const o = offsetSeg(geo[0], d);
    return o ? { items: [{ type: "circle", c: o.c, r: o.r, centerId: o.centerId, src: o.id }] } : { items: [], error: "The offset is larger than the radius" };
  }
  const off = geo.map((g) => offsetSeg(g, d));
  const alive = off.map((o) => !!o);
  const arcCollapsed = alive.some((x) => !x);
  const tooLarge = { items: [], error: arcCollapsed ? "The offset is larger than an arc's radius" : "The offset is too large for this shape" };
  const n = off.length, closed = !!chain.closed;
  for (let iter = 0; iter <= n; iter++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (alive[i]) idx.push(i);
    if (!idx.length || (closed && idx.length < 2) || (closed && idx.length === 2 && idx.every((i) => off[i].type === "line"))) return tooLarge;
    const r = buildOffset(geo, off, idx, closed, d);
    if (r.error) return tooLarge;
    if (r.bad != null) { alive[r.bad] = false; continue; }
    if (!offsetValid(geo, r.items, closed, d)) return tooLarge;
    return { items: r.items };
  }
  return tooLarge;
}

// Corners and trimmed curves for the kept curves idx (indices into geo / off).
// Returns { items } | { bad: the curve to drop (the most reversed one) } | { error }.
function buildOffset(geo, off, idx, closed, d) {
  const n = geo.length, L = idx.length, ad = Math.abs(d);
  const joins = closed ? L : L - 1, corners = new Array(L).fill(null); // corners[j]: between idx[j] and idx[j + 1]
  for (let j = 0; j < joins; j++) {
    const i1 = idx[j], i2 = idx[(j + 1) % L], g1 = off[i1], g2 = off[i2];
    const adjacent = i2 === (i1 + 1) % n;
    if (adjacent && dist(g1.b, g2.a) < 1e-7) { corners[j] = { p: g1.b }; continue; }
    // original vertices between the two kept curves (just one when they are neighbours) and the dropped length
    const verts = [];
    let span = 0;
    for (let k = i1; ; k = (k + 1) % n) {
      verts.push(geo[k].b);
      if ((k + 1) % n === i2) break;
      span += dist(geo[(k + 1) % n].a, geo[(k + 1) % n].b);
    }
    const near = (p) => Math.min(...verts.map((v) => dist(p, v)));
    const want = [(g1.b[0] + g2.a[0]) / 2, (g1.b[1] + g2.a[1]) / 2];
    const cand = intersect(g1, g2).filter((p) => near(p) < ad * 20 + span + 1e-6).sort((p, q) => dist(p, want) - dist(q, want));
    // line-line corners always meet (sharp), as do curves re-joined over dropped ones; others meet near the gap
    // (inside of a corner), else get a round corner on the vertex
    if (cand.length && ((g1.type === "line" && g2.type === "line") || !adjacent || dist(cand[0], want) < ad * 2 + 1e-6)) corners[j] = { p: cand[0] };
    else if (adjacent) corners[j] = { p: null, round: { c: verts[0], r: ad, a: g1.b, b: g2.a, vertexId: geo[i1].endId } };
    else return { error: true };
  }
  // trim / extend each kept curve to its corners; note the ones that reverse
  const items = [];
  let bad = null, worst = Infinity;
  for (let j = 0; j < L; j++) {
    const i = idx[j], g = off[i];
    const prev = closed || j > 0 ? corners[(j - 1 + L) % L] : null;
    const next = closed || j < L - 1 ? corners[j] : null;
    const a = prev && prev.p ? prev.p : g.a, b = next && next.p ? next.p : g.b;
    if (g.type === "line") {
      const u = sub(geo[i].b, geo[i].a), l0 = len(u), s = dot(sub(b, a), u) / (l0 * l0 || 1);
      if (s * l0 <= 1e-9 && s < worst) { worst = s; bad = i; }
      items.push({ type: "line", a, b, src: g.id });
    } else {
      // the arc keeps its travel direction; a reversed (or collapsed) sweep means it has to go
      const ccw = g.sweep > 0;
      const a0 = Math.atan2(a[1] - g.c[1], a[0] - g.c[0]), a1 = Math.atan2(b[1] - g.c[1], b[0] - g.c[0]);
      let sw = a1 - a0;
      if (ccw) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
      if (Math.abs(sw) > Math.abs(g.sweep) + Math.PI) {
        const s = -(2 * Math.PI - Math.abs(sw)) / Math.abs(g.sweep);
        if (s < worst) { worst = s; bad = i; }
      }
      items.push({ type: "arc", c: g.c, r: g.r, a, b, ccw, centerId: g.centerId, src: g.id });
    }
    if (next && next.round) {
      const R = next.round;
      const t1 = Math.atan2(R.a[1] - R.c[1], R.a[0] - R.c[0]), t2 = Math.atan2(R.b[1] - R.c[1], R.b[0] - R.c[0]);
      let sw = t2 - t1; while (sw > Math.PI) sw -= 2 * Math.PI; while (sw < -Math.PI) sw += 2 * Math.PI;
      items.push({ type: "arc", corner: R.vertexId, c: R.c, r: R.r, a: R.a, b: R.b, ccw: sw > 0 });
    }
  }
  return bad != null ? { bad } : { items };
}

// points along an offset item, ends included (for the checks)
function sampleItem(it, k) {
  if (it.type === "line") return Array.from({ length: k + 1 }, (_, i) => add(it.a, mul(sub(it.b, it.a), i / k)));
  const t1 = Math.atan2(it.a[1] - it.c[1], it.a[0] - it.c[0]);
  let t2 = Math.atan2(it.b[1] - it.c[1], it.b[0] - it.c[0]);
  if (it.ccw) { while (t2 <= t1) t2 += 2 * Math.PI; } else { while (t2 >= t1) t2 -= 2 * Math.PI; }
  const pts = [it.a];
  for (let i = 1; i < k; i++) { const t = t1 + ((t2 - t1) * i) / k; pts.push([it.c[0] + it.r * Math.cos(t), it.c[1] + it.r * Math.sin(t)]); }
  pts.push(it.b);
  return pts;
}

// distance from p to an original chain curve
function distToGeo(g, p) {
  if (g.type === "line") {
    const v = sub(g.b, g.a), l2 = dot(v, v), t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, g.a), v) / l2)) : 0;
    return dist(p, add(g.a, mul(v, t)));
  }
  let t = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - Math.atan2(g.a[1] - g.c[1], g.a[0] - g.c[0]);
  if (g.sweep < 0) t = -t;
  t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return t <= Math.abs(g.sweep) ? Math.abs(dist(p, g.c) - g.r) : Math.min(dist(p, g.a), dist(p, g.b));
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// a proper offset: no crossings and (closed chains) nothing closer than |d| to the original, which is what
// fails when the offset goes past the shape's medial axis
function offsetValid(geo, items, closed, d) {
  let scale = 0;
  for (const g of geo) scale = Math.max(scale, Math.abs(g.a[0]), Math.abs(g.a[1]), Math.abs(g.b[0]), Math.abs(g.b[1]));
  const tol = 1e-7 * Math.max(1, scale, Math.abs(d));
  if (closed) {
    const ad = Math.abs(d);
    for (const it of items) for (const p of sampleItem(it, it.type === "line" ? 4 : 12)) {
      for (const g of geo) if (distToGeo(g, p) < ad - 10 * tol) return false;
    }
  }
  const poly = [];
  for (const it of items) { const s = sampleItem(it, it.type === "line" ? 1 : 12); if (poly.length) s.shift(); poly.push(...s); }
  if (closed) poly.pop(); // the last point is the first again
  const N = poly.length, S = closed ? N : N - 1;
  if (N < (closed ? 3 : 2)) return false;
  for (let i = 0; i < S; i++) {
    const p1 = poly[i], p2 = poly[(i + 1) % N];
    const xmin = Math.min(p1[0], p2[0]) - tol, xmax = Math.max(p1[0], p2[0]) + tol, ymin = Math.min(p1[1], p2[1]) - tol, ymax = Math.max(p1[1], p2[1]) + tol;
    for (let j = i + 2; j < S; j++) {
      if (closed && i === 0 && j === S - 1) continue; // neighbours across the closing point
      const q1 = poly[j], q2 = poly[(j + 1) % N];
      if (Math.max(q1[0], q2[0]) < xmin || Math.min(q1[0], q2[0]) > xmax || Math.max(q1[1], q2[1]) < ymin || Math.min(q1[1], q2[1]) > ymax) continue;
      const e = tol * Math.max(len(sub(p2, p1)), len(sub(q2, q1)), 1e-9);
      const d1 = cross(p1, p2, q1), d2 = cross(p1, p2, q2), d3 = cross(q1, q2, p1), d4 = cross(q1, q2, p2);
      if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e))) return false;
    }
  }
  return true;
}

/** Offset items as flat entities for drawing (sketcher preview): line { a, b }, arc { a, b, m }, circle { c, r }. */
export function itemsToFlat(items) {
  return items.map((it) => {
    if (it.type === "line") return { type: "line", a: it.a, b: it.b };
    if (it.type === "circle") return { type: "circle", c: it.c, r: it.r };
    const t1 = Math.atan2(it.a[1] - it.c[1], it.a[0] - it.c[0]);
    let t2 = Math.atan2(it.b[1] - it.c[1], it.b[0] - it.c[0]);
    if (it.ccw) { while (t2 <= t1) t2 += 2 * Math.PI; } else { while (t2 >= t1) t2 -= 2 * Math.PI; }
    const tm = (t1 + t2) / 2;
    return { type: "arc", a: it.a, b: it.b, m: [it.c[0] + it.r * Math.cos(tm), it.c[1] + it.r * Math.sin(tm)] };
  });
}
