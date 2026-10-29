// Geometry kernel: wraps OpenCascade (via replicad) and replays the feature
// history into B-rep bodies. Kept free of three.js so it can be tested in Node.
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { isModel, flatten } from "./sketchmodel.js";
import { entityPolyline, circleFrom3, arcParams } from "./sketchgeom.js";
import { cachedFastener, autoSize, fastenerName } from "./fasteners.js";
import { stockItem, cachedStock, stockName, defaultAppearance } from "./stock.js";
import { cachedGear, gearName, gearParams, gearSizes } from "./gears.js";

export async function initKernel(locateFile) {
  const oc = await opencascade(locateFile ? { locateFile } : undefined);
  R.setOC(oc);
  patchTopoLists(oc);
  patchBooleans(oc);
}

/**
 * replicad's fuse / cut / intersect run OCCT booleans in their default destructive mode, which may
 * adjust the tolerances of the input shapes in place, and they never check that the operation worked.
 * Its clone() shares the geometry, so cached inputs (an imported STEP, sketch profiles) drifted with
 * every preview and regen until a boolean returned a null shape ("This shape has not type, it is null";
 * bug report 2026-10-18 19:19: two extrudes on an imported gearbox failed mid-session, fine after reopening).
 * Same operations, non-destructive, with a readable error when OCCT fails.
 */
function patchBooleans(oc) {
  if (patchBooleans.done || !oc.BRepAlgoAPI_Fuse || !oc.NCollection_List_TopoDS_Shape) return;
  const proto = R._3DShape && R._3DShape.prototype;
  if (!proto) return;
  const list = (sh) => { const l = new oc.NCollection_List_TopoDS_Shape(); l.Append(sh); return l; };
  const run = (Op, a, b, options, what) => {
    const op = new Op(), la = list(a.wrapped), lb = list(b.wrapped), range = new oc.Message_ProgressRange();
    try {
      op.SetArguments(la); op.SetTools(lb);
      op.SetNonDestructive(true);
      if (options && options.optimisation === "commonFace") op.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
      if (options && options.optimisation === "sameFace") op.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueFull);
      if (options && options.fuzzy) op.SetFuzzyValue(options.fuzzy);
      op.Build(range);
      if (!op.IsDone() || (op.HasErrors && op.HasErrors())) throw new Error(`The ${what} failed in the geometry kernel`);
      op.SimplifyResult(true, true, 1e-3);
      const res = op.Shape();
      if (!res || res.IsNull()) throw new Error(`The ${what} produced no shape`);
      const shape = R.cast(res);
      if (!R.isShape3D(shape)) throw new Error(`Could not ${what} as a 3d shape`);
      return shape;
    } finally { op.delete(); la.delete(); lb.delete(); range.delete(); }
  };
  proto.fuse = function (other, options = {}) { return run(oc.BRepAlgoAPI_Fuse, this, other, options, "fuse"); };
  proto.cut = function (tool, options = {}) { return run(oc.BRepAlgoAPI_Cut, this, tool, options, "cut"); };
  proto.intersect = function (tool) { return run(oc.BRepAlgoAPI_Common, this, tool, null, "intersect"); };
  patchBooleans.done = true;
}

/**
 * replicad's shape.faces / .edges / .vertices dedupe the explorer's items with a linear IsSame scan per
 * item (O(n^2) WASM calls): 0.6 s for the faces and 8.5 s for the edges of a 1,700-face STEP import, on
 * every call (bug report 2026-10-18 15:32: joint picking froze on an imported gearbox). Same lists, same
 * first-occurrence order, with the explorer's items bucketed by OCCT's shape hash. Cached per shape.
 */
const topoCache = new WeakMap();
function patchTopoLists(oc) {
  if (patchTopoLists.done) return;
  const hasher = oc.ReplicadShapeHasher;
  if (!hasher || !hasher.HashCode || !oc.TopExp_Explorer) return;
  const kinds = {
    faces: [oc.TopAbs_ShapeEnum.TopAbs_FACE, (x) => new R.Face(oc.TopoDS.Face(x))],
    edges: [oc.TopAbs_ShapeEnum.TopAbs_EDGE, (x) => new R.Edge(oc.TopoDS.Edge(x))],
  };
  const list = (shape, key) => {
    const [type, wrap] = kinds[key];
    const ex = new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const buckets = new Map(), out = [];
    try {
      for (; ex.More(); ex.Next()) {
        const item = ex.Current();
        const h = hasher.HashCode(item, 2147483647); // same hash for IsSame shapes (TShape + location)
        let b = buckets.get(h);
        if (!b) buckets.set(h, (b = []));
        if (b.some((x) => x.IsSame(item))) { item.delete(); continue; }
        b.push(item);
        out.push(wrap(item));
      }
      return out;
    } finally { ex.delete(); }
  };
  for (const key of Object.keys(kinds)) {
    const orig = Object.getOwnPropertyDescriptor(R.Shape.prototype, key);
    if (!orig || !orig.get) continue;
    Object.defineProperty(R.Shape.prototype, key, {
      configurable: true,
      get() {
        const w = this.wrapped;
        // wires keep the original (small, and replicad's makeNonPlanarFace deletes the edges it gets)
        if (!w || this instanceof R.Wire) return orig.get.call(this);
        let c = topoCache.get(w);
        if (!c) topoCache.set(w, (c = {}));
        // hand out a fresh array of the cached wrappers (callers may filter / sort it in place)
        if (!c[key]) { try { c[key] = list(w, key); } catch (e) { if (!patchTopoLists.warned) { patchTopoLists.warned = true; console.warn("fast topology list failed, using replicad's", e); } return orig.get.call(this); } }
        return c[key].slice();
      },
    });
  }
  patchTopoLists.done = true;
}

// ---------- small vector helpers ----------
export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
};
const tup = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);

// ---------- planes ----------
export const ORIGIN_PLANES = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
};
export const yDirOf = (p) => V.cross(p.normal, p.xDir);
export const to3D = (p, uv) => V.add(p.origin, V.add(V.mul(p.xDir, uv[0]), V.mul(yDirOf(p), uv[1])));
export const to2D = (p, xyz) => { const d = V.sub(xyz, p.origin); return [V.dot(d, p.xDir), V.dot(d, yDirOf(p))]; };
const rPlane = (p) => new R.Plane(p.origin, p.xDir, p.normal);

/** Face normal at its centroid; curved faces whose centroid isn't on the surface (a cylinder's) use the mid-parameter normal. */
export function faceNormal(face) {
  try { return face.normalAt(face.center); } catch (e) { const v = tup(face.normalAt()); return V.norm(v); }
}
export function planeFromFace(face) {
  const c = tup(face.center);
  const n = V.norm(tup(faceNormal(face)));
  // pick an x direction: project world X (or Y if X is parallel to normal)
  let ref = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  let x = V.sub(ref, V.mul(n, V.dot(ref, n)));
  return { origin: c, xDir: V.norm(x), normal: n };
}
export function offsetPlane(p, d) { return { ...p, origin: V.add(p.origin, V.mul(p.normal, d)) }; }

// ---------- sketch -> loops -> regions -> profiles ----------
const pkey = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

// Closed loops of a sketch = bounded faces of the planar graph formed by lines/arcs
// that share endpoints. Branches and dangling lines don't break a loop (Fusion behaviour).
export function sketchLoops(rawEntities) {
  const drawings = [];
  const entities = splitAtIntersections(rawEntities.filter((e) => !e.construction));
  const nodes = new Map();
  const nodeOf = (p) => { const k = pkey(p); if (!nodes.has(k)) nodes.set(k, { p, out: [] }); return k; };
  const half = [];
  for (const s of entities) {
    if (s.construction || (s.type !== "line" && s.type !== "arc")) continue;
    if (Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1]) < 1e-6) continue;
    const ka = nodeOf(s.a), kb = nodeOf(s.b);
    const h1 = { s, from: ka, to: kb, fwd: true }, h2 = { s, from: kb, to: ka, fwd: false };
    h1.twin = h2; h2.twin = h1;
    h1.ang = departAngle(s, true); h2.ang = departAngle(s, false);
    h1.curv = departCurv(s, true); h2.curv = departCurv(s, false);
    nodes.get(ka).out.push(h1); nodes.get(kb).out.push(h2);
    half.push(h1, h2);
  }
  // Order the edges leaving each node counter-clockwise. Edges leaving in the same direction
  // (a line tangent to an arc where they meet) tie on angle; ±1e-15 noise used to decide their
  // order and could merge or drop faces (bug report 2026-10-09 09:00), so ties are broken by
  // curvature: the edge bending left (counter-clockwise) comes after the straighter one.
  const ANG_TIE = 1e-7;
  for (const n of nodes.values()) {
    for (const h of n.out) if (h.ang > Math.PI - ANG_TIE) h.ang -= 2 * Math.PI; // keep ±π ties adjacent
    n.out.sort((a, b) => (Math.abs(a.ang - b.ang) > ANG_TIE ? a.ang - b.ang : a.curv - b.curv));
  }
  // face on the left: from the twin at the next node, take the next edge clockwise
  const next = (h) => { const out = nodes.get(h.to).out, i = out.indexOf(h.twin); return out[(i - 1 + out.length) % out.length]; };
  const seen = new Set();
  for (const h0 of half) {
    if (seen.has(h0)) continue;
    let cyc = [], h = h0, guard = 0;
    while (!seen.has(h) && guard++ < 10000) { seen.add(h); cyc.push(h); h = next(h); }
    if (h !== h0) continue;
    for (const piece of splitBridges(stripSpikes(cyc))) {
    cyc = stripSpikes(piece);
    if (cyc.length < 2 && !(cyc.length === 1 && cyc[0].s.type === "arc")) continue;
    if (signedArea(cyc) <= 1e-9) continue; // outer (unbounded) face, a hole or degenerate
    try {
      const pen = R.draw(nodes.get(cyc[0].from).p);
      cyc.forEach((e, i) => {
        const p = nodes.get(e.to).p, last = i === cyc.length - 1;
        if (e.s.type === "line") { if (!last) pen.lineTo(p); }
        else pen.threePointsArcTo(p, e.s.m);
      });
      drawings.push(pen.close());
    } catch (e) { /* degenerate loop: ignore */ }
    }
  }
  for (const c of entities) {
    if (c.type === "circle" && !c.construction && c.r > 1e-6) drawings.push(R.drawCircle(c.r).translate(c.c[0], c.c[1]));
  }
  return drawings;
}
// strip spikes (an edge immediately followed by its twin = dangling line)
function stripSpikes(cyc) {
  cyc = cyc.slice();
  let changed = true;
  while (changed && cyc.length) {
    changed = false;
    for (let i = 0; i < cyc.length; i++) {
      const j = (i + 1) % cyc.length;
      if (cyc[j] === cyc[i].twin) { cyc.splice(Math.max(i, j), 1); cyc.splice(Math.min(i, j), 1); changed = true; break; }
    }
  }
  return cyc;
}
// A loop that runs along the same edge both ways crosses a bridge: a line joining an inner loop to an outer one
// (e.g. from a hole to the outside of a ring) without splitting the region. Drawn as one wire it made a face
// with a zero-width slit, which every extrude carried into the body as two coincident faces and broke later
// booleans (bug report 2026-10-20 19:27). Split at the bridge: the outer part stays a loop, the inner part
// (clockwise) is dropped here and the hole comes back through the region booleans like any nested loop.
function splitBridges(cyc) {
  for (let i = 0; i < cyc.length; i++) {
    const j = cyc.indexOf(cyc[i].twin);
    if (j < 0) continue;
    const a = Math.min(i, j), b = Math.max(i, j);
    return [...splitBridges(cyc.slice(a + 1, b)), ...splitBridges([...cyc.slice(b + 1), ...cyc.slice(0, a)])];
  }
  return [cyc];
}
// Split lines (and arcs/circles crossed by lines) where they cross, so a line drawn across a
// shape divides it into separate profiles like in Fusion. Circle/circle overlaps are left to
// the region booleans in sketchProfiles.
function splitAtIntersections(ents) {
  const EPS = 1e-7;
  const lines = [], rounds = [], out = [];
  for (const e of ents) {
    if (e.type === "line") lines.push({ e, cuts: [] });
    else if (e.type === "arc") { const ap = arcParams(e.a, e.m, e.b); if (ap) rounds.push({ e, ap, cuts: [] }); else out.push(e); }
    else if (e.type === "circle") rounds.push({ e, ap: { c: e.c, r: e.r, a0: 0, sweep: 2 * Math.PI }, full: true, cuts: [] });
    else out.push(e);
  }
  const addCut = (list, f, p) => { if (f > EPS && f < 1 - EPS && !list.some((c) => Math.abs(c.f - f) < 1e-9)) list.push({ f, p }); };
  // line-line
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i].e, B = lines[j].e;
    const r = [A.b[0] - A.a[0], A.b[1] - A.a[1]], q = [B.b[0] - B.a[0], B.b[1] - B.a[1]];
    const den = r[0] * q[1] - r[1] * q[0];
    const w = [B.a[0] - A.a[0], B.a[1] - A.a[1]];
    if (Math.abs(den) < 1e-12) {
      // collinear overlap (e.g. a rectangle drawn on a projected face edge): cut each line at the
      // other's endpoints so the shared stretch becomes the same segment, deduplicated below
      const rr = r[0] * r[0] + r[1] * r[1], qq = q[0] * q[0] + q[1] * q[1];
      if (rr < 1e-18 || qq < 1e-18 || Math.abs(w[0] * r[1] - w[1] * r[0]) / Math.sqrt(rr) > 1e-6) continue;
      const on = (L, P) => { const v = [P[0] - L.a[0], P[1] - L.a[1]], d = [L.b[0] - L.a[0], L.b[1] - L.a[1]]; return (v[0] * d[0] + v[1] * d[1]) / (d[0] * d[0] + d[1] * d[1]); };
      for (const P of [B.a, B.b]) addCut(lines[i].cuts, on(A, P), P);
      for (const P of [A.a, A.b]) addCut(lines[j].cuts, on(B, P), P);
      continue;
    }
    const t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) continue;
    const p = [A.a[0] + r[0] * t, A.a[1] + r[1] * t];
    addCut(lines[i].cuts, t, p); addCut(lines[j].cuts, u, p);
  }
  // line-arc / line-circle
  const fracOn = (R, p) => {
    const ang = Math.atan2(p[1] - R.ap.c[1], p[0] - R.ap.c[0]);
    let d = (ang - R.ap.a0) * Math.sign(R.ap.sweep || 1);
    d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return d / Math.abs(R.ap.sweep);
  };
  // Touch tests use a length tolerance relative to the sketch size, so solver noise (±1e-15 on
  // a point that should sit exactly on a circle or on a tangent) can't flip a decision.
  let ext = 0;
  for (const e of ents) for (const p of [e.a, e.b, e.c]) if (p) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
  for (const R of rounds) ext = Math.max(ext, R.ap.r);
  const TOL = 1e-6 * Math.max(1, ext / 100);
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= TOL;
  // cut a round at p (p known to be on its circle); false if p lies off the arc's span
  const cutRound = (R, p) => {
    if (!R.full && (near(p, R.e.a) || near(p, R.e.b))) return true; // at its end: nothing to split
    const fr = fracOn(R, p);
    if (!R.full && fr > 1) return false;
    if (!R.cuts.some((x) => near(x.p, p))) R.cuts.push({ f: fr, p });
    return true;
  };
  const cutLine = (L, t, p) => {
    if (t <= 0 || t >= 1 || near(p, L.e.a) || near(p, L.e.b) || L.cuts.some((x) => near(x.p, p))) return;
    L.cuts.push({ f: t, p });
  };
  for (const L of lines) for (const R of rounds) {
    const { a, b } = L.e, c = R.ap.c, r = R.ap.r;
    const d = [b[0] - a[0], b[1] - a[1]], A2 = d[0] * d[0] + d[1] * d[1];
    if (A2 < 1e-18) continue;
    // foot of the perpendicular from the centre; within TOL of r counts as a tangent touch (one point)
    const t0 = ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1]) / A2;
    const h = Math.hypot(a[0] + d[0] * t0 - c[0], a[1] + d[1] * t0 - c[1]);
    if (h > r + TOL) continue;
    const dt = h >= r - TOL ? 0 : Math.sqrt(r * r - h * h) / Math.sqrt(A2), tl = TOL / Math.sqrt(A2);
    for (const t of dt ? [t0 - dt, t0 + dt] : [t0]) {
      if (t < -tl || t > 1 + tl) continue;
      let p = [a[0] + d[0] * t, a[1] + d[1] * t];
      if (near(p, a)) p = a; else if (near(p, b)) p = b;
      if (cutRound(R, p)) cutLine(L, t, p);
    }
  }
  // a line or arc ending on a circle / arc (a circle drawn through a sketch point, an arc ending
  // on another circle) splits it there too
  for (const R of rounds) for (const e of [...lines.map((x) => x.e), ...rounds.map((x) => x.e)]) {
    if (e === R.e || e.type === "circle") continue;
    for (const P of [e.a, e.b]) if (Math.abs(Math.hypot(P[0] - R.ap.c[0], P[1] - R.ap.c[1]) - R.ap.r) <= TOL) cutRound(R, P);
  }
  // merge points closer than TOL into one vertex (the first one seen, so sketch points win)
  const reps = new Map(), cell = 4 * TOL;
  const snap = (p) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of reps.get(`${gx + dx},${gy + dy}`) || []) if (near(p, q)) return q;
    const k = `${gx},${gy}`;
    if (!reps.has(k)) reps.set(k, []);
    reps.get(k).push(p);
    return p;
  };
  for (const e of ents) for (const p of [e.a, e.b]) if (p) snap(p);
  for (let i = 0; i < out.length; i++) if (out[i].a && out[i].b) out[i] = { ...out[i], a: snap(out[i].a), b: snap(out[i].b) };
  const segKeys = new Set(); // a segment drawn twice (overlapping lines) would break the loop walk
  for (const L of lines) {
    const pts = [L.e.a, ...L.cuts.sort((x, y) => x.f - y.f).map((c) => c.p), L.e.b].map(snap);
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i] === pts[i + 1]) continue;
      const k = [pkey(pts[i]), pkey(pts[i + 1])].sort().join("|");
      if (segKeys.has(k)) continue;
      segKeys.add(k);
      out.push({ ...L.e, a: pts[i], b: pts[i + 1] });
    }
  }
  for (const R of rounds) {
    const { c, r, a0, sweep } = R.ap;
    const at = (f) => [c[0] + r * Math.cos(a0 + sweep * f), c[1] + r * Math.sin(a0 + sweep * f)];
    if (R.full) {
      if (R.cuts.length < 2) { out.push(R.e); continue; }
      const cs = R.cuts.sort((x, y) => x.f - y.f);
      cs.forEach((k, i) => { const n = cs[(i + 1) % cs.length]; const f1 = i === cs.length - 1 ? n.f + 1 : n.f; out.push({ type: "arc", id: R.e.id, a: snap(k.p), b: snap(n.p), m: at((k.f + f1) / 2) }); });
      continue;
    }
    const cs = [{ f: 0, p: R.e.a }, ...R.cuts.sort((x, y) => x.f - y.f), { f: 1, p: R.e.b }];
    for (let i = 0; i < cs.length - 1; i++) {
      const pa = snap(cs[i].p), pb = snap(cs[i + 1].p);
      if (pa !== pb) out.push({ ...R.e, a: pa, b: pb, m: at((cs[i].f + cs[i + 1].f) / 2) });
    }
  }
  return out;
}
function departAngle(s, fwd) {
  const [a, b] = fwd ? [s.a, s.b] : [s.b, s.a];
  if (s.type === "line") return Math.atan2(b[1] - a[1], b[0] - a[0]);
  const circ = circleFrom3(s.a, s.m, s.b);
  if (!circ) return Math.atan2(b[1] - a[1], b[0] - a[0]);
  const r = [a[0] - circ.c[0], a[1] - circ.c[1]], toM = [s.m[0] - circ.c[0], s.m[1] - circ.c[1]];
  const ccw = r[0] * toM[1] - r[1] * toM[0] > 0; // travelling from a toward m
  const t = ccw ? [-r[1], r[0]] : [r[1], -r[0]];
  return Math.atan2(t[1], t[0]);
}
// signed curvature of an edge as it leaves its start (fwd) or end: + bends left (CCW), 0 = line
function departCurv(s, fwd) {
  if (s.type !== "arc") return 0;
  const circ = circleFrom3(s.a, s.m, s.b);
  if (!circ || !(circ.r > 0)) return 0;
  const r = [s.a[0] - circ.c[0], s.a[1] - circ.c[1]], toM = [s.m[0] - circ.c[0], s.m[1] - circ.c[1]];
  const ccw = r[0] * toM[1] - r[1] * toM[0] > 0; // a -> m -> b runs counter-clockwise
  return (ccw === fwd ? 1 : -1) / circ.r;
}
function signedArea(cyc) {
  const pts = [];
  for (const e of cyc) { const pl = entityPolyline(e.s, 32); const seq = e.fwd ? pl : pl.slice().reverse(); pts.push(...seq.slice(0, -1)); }
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

// Sketch / CompoundSketch expose face(); Sketches wraps several of them
function facesFromSketch(sk) {
  if (sk.sketches) return sk.sketches.flatMap(facesFromSketch);
  if (typeof sk.face === "function") return [sk.face()];
  const f = sk.faces();
  return f.faces || [f];
}
function drawingFaces(d, plane) {
  try { return facesFromSketch(d.sketchOnPlane(rPlane(plane))); }
  catch (e) { return []; }
}

function faceBool(kind, a, b) {
  try {
    const oc = R.getOC();
    const Op = { cut: oc.BRepAlgoAPI_Cut, common: oc.BRepAlgoAPI_Common, fuse: oc.BRepAlgoAPI_Fuse }[kind];
    const op = new Op(a.wrapped, b.wrapped);
    op.Build();
    const s = R.cast(op.Shape());
    op.delete();
    return s;
  } catch (e) { return null; }
}

const profileCache = new Map();
export function sketchProfiles(plane, entities) {
  const key = JSON.stringify([plane, entities.filter((e) => !e.construction)]);
  if (profileCache.has(key)) return profileCache.get(key);
  const loopFaces = sketchLoops(entities).flatMap((d) => drawingFaces(d, plane));
  // split overlapping loops into regions (Fusion-style profiles) with planar face booleans
  const pieces = (s) => (s ? s.faces.filter((f) => R.measureArea(f) > 1e-7) : []);
  let regions = [], union = null;
  for (const L of loopFaces) {
    const next = [];
    for (const r of regions) {
      next.push(...pieces(faceBool("common", r, L)));
      next.push(...pieces(faceBool("cut", r, L)));
    }
    next.push(...pieces(union ? faceBool("cut", L, union) : L));
    union = union ? faceBool("fuse", union, L) || union : L;
    regions = next;
  }
  const profiles = regions.map((face) => {
    const c3 = tup(face.center);
    return { face, area: R.measureArea(face), center3d: c3, center2d: to2D(plane, c3) };
  });
  if (profileCache.size > 200) profileCache.clear();
  profileCache.set(key, profiles);
  return profiles;
}

// ---------- references (survive recompute by nearest-geometry matching) ----------
const edgeMid = (e) => tup(e.pointAt(0.5));
export function edgeRef(state, bodyId, idx) {
  const b = state.bodies.find((x) => x.id === bodyId);
  return { body: bodyId, idx, pt: edgeMid(b.shape.edges[idx]) };
}
export function faceRef(state, bodyId, idx) {
  const b = state.bodies.find((x) => x.id === bodyId);
  const f = b.shape.faces[idx];
  return { body: bodyId, idx, pt: tup(f.center), n: tup(faceNormal(f)) };
}
function nearest(list, fn, pt) {
  let best = null, bd = Infinity;
  list.forEach((x, i) => { const d = V.dist(fn(x), pt); if (d < bd) { bd = d; best = i; } });
  return best;
}
export function resolveEdge(state, ref) {
  const b = state.bodies.find((x) => x.id === ref.body);
  if (!b) throw new Error(`Body ${ref.body} is missing`);
  const edges = b.shape.edges;
  const i = nearest(edges, edgeMid, ref.pt);
  if (i == null) throw new Error("Edge reference lost");
  return { body: b, edge: edges[i], idx: i };
}
export function resolveFace(state, ref) {
  const b = state.bodies.find((x) => x.id === ref.body);
  if (!b) throw new Error(`Body ${ref.body} is missing`);
  const faces = b.shape.faces;
  const i = nearest(faces, (f) => tup(f.center), ref.pt);
  if (i == null) throw new Error("Face reference lost");
  return { body: b, face: faces[i], idx: i };
}
export function resolveProfile(state, ref) {
  const sk = state.sketches[ref.sketch];
  if (!sk) throw new Error("Sketch is missing");
  if (!sk.profiles.length) throw new Error("Sketch has no closed profiles");
  let best = null, bd = Infinity;
  for (const p of sk.profiles) {
    const d = Math.hypot(p.center2d[0] - ref.pt[0], p.center2d[1] - ref.pt[1]) + Math.abs(p.area - (ref.area || p.area)) * 1e-3;
    if (d < bd) { bd = d; best = p; }
  }
  return { profile: best, sketch: sk };
}
// Like resolveProfile, but when no single profile matches the stored area and centre and two or
// three adjacent profiles together do, return those. A sketch that now splits a region the
// design was built from into pieces (e.g. after the tangent-edge fix of bug report 2026-10-09
// 09:00) then still rebuilds the same body.
export function resolveProfileSet(state, ref) {
  const { profile, sketch } = resolveProfile(state, ref);
  const A = ref.area, P = sketch.profiles;
  const fits = (area, c) => Math.abs(area - A) <= 5e-3 * A && Math.hypot(c[0] - ref.pt[0], c[1] - ref.pt[1]) <= 1e-2 * Math.sqrt(A);
  if (!(A > 0) || fits(profile.area, profile.center2d) || P.length < 2 || P.length > 40) return { profiles: [profile], sketch };
  let best = null, bd = Infinity;
  const tryCombo = (idx) => {
    const area = idx.reduce((s, i) => s + P[i].area, 0);
    const c = [0, 1].map((k) => idx.reduce((s, i) => s + P[i].area * P[i].center2d[k], 0) / area);
    if (!fits(area, c)) return;
    const d = Math.abs(area - A) / A + Math.hypot(c[0] - ref.pt[0], c[1] - ref.pt[1]) / Math.sqrt(A);
    if (d < bd) { bd = d; best = idx; }
  };
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    tryCombo([i, j]);
    if (P.length <= 16) for (let k = j + 1; k < P.length; k++) tryCombo([i, j, k]);
  }
  return { profiles: best ? best.map((i) => P[i]) : [profile], sketch };
}

// ---------- body bookkeeping ----------
function bboxOf(shape) {
  try { const b = shape.boundingBox.bounds; return b; } catch (e) { return null; }
}
function overlaps(a, b, tol = 1e-4) {
  const A = bboxOf(a), B = bboxOf(b);
  if (!A || !B) return true;
  for (let i = 0; i < 3; i++) if (A[0][i] > B[1][i] + tol || B[0][i] > A[1][i] + tol) return false;
  return true;
}
const hasSolid = (s) => { try { return s.faces.length > 0; } catch (e) { return false; } };

function newBody(st, shape) {
  st.bodyCounter += 1;
  st.bodies.push({ id: `Body${st.bodyCounter}`, name: `Body${st.bodyCounter}`, shape });
}

/** The `move` feature's transform on a clone (replicad transforms delete their input). */
export function moveShape(shape, f) {
  let s = shape.clone();
  const p = f.pivot || [0, 0, 0], r = f.rotate || [0, 0, 0], t = f.translate || [0, 0, 0];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let i = 0; i < 3; i++) if (r[i]) s = s.rotate(r[i], p, axes[i]);
  if (t[0] || t[1] || t[2]) s = s.translate(t);
  return s;
}

function combine(st, tool, op) {
  if (op === "new" || (op === "join" && st.bodies.length === 0)) { newBody(st, tool); return; }
  const targets = st.bodies.filter((b) => overlaps(b.shape, tool));
  if (op === "join") {
    if (!targets.length) { newBody(st, tool); return; }
    let merged = tool;
    for (const t of targets) merged = t.shape.fuse(merged);
    targets[0].shape = merged;
    st.bodies = st.bodies.filter((b) => b === targets[0] || !targets.includes(b));
    return;
  }
  if (!targets.length) throw new Error("No target body intersects the tool");
  for (const t of targets) t.shape = op === "cut" ? t.shape.cut(tool) : t.shape.intersect(tool);
  st.bodies = st.bodies.filter((b) => hasSolid(b.shape));
}

// ---------- features ----------
/**
 * New bodies made from a sketch on another body's face (or from that face) remember the host body
 * (`b.host`), so they follow its assembly placement on screen like the sketch does (bug report
 * 2026-10-18 18:33: a sketch on a mated, moved component appeared where the part was modelled).
 */
function tagHost(st, f, before) {
  const ref = (f.profiles || [])[0];
  if (!ref) return;
  const host = ref.kind === "face" ? ref.body : st.sketches[ref.sketch] ? st.sketches[ref.sketch].host : null;
  if (!host) return;
  const hb = st.bodies.find((b) => b.id === host);
  for (const b of st.bodies) if (!before.has(b) && b.id !== host) b.host = (hb && hb.host) || host;
}
function profileFaces(st, f) {
  const out = [];
  for (const ref of f.profiles || []) {
    if (ref.kind === "face") {
      const { face } = resolveFace(st, ref);
      if (face.geomType !== "PLANE") throw new Error("Selected face is not planar");
      out.push({ face, normal: V.norm(tup(faceNormal(face))) });
    } else {
      const { profiles, sketch } = resolveProfileSet(st, ref);
      for (const p of profiles) out.push({ face: p.face, normal: sketch.plane.normal });
    }
  }
  if (!out.length) throw new Error("No profile selected");
  return out;
}

function fuseAll(shapes) {
  let t = shapes[0];
  for (let i = 1; i < shapes.length; i++) t = t.fuse(shapes[i]);
  return t;
}

export function autoOperation(st, f) {
  if (f.operation && f.operation !== "auto") return f.operation;
  if (!st.bodies.length) return "new";
  return (f.distance ?? 1) < 0 ? "cut" : "join";
}

function extrudeTool(st, f) {
  const parts = [];
  const d = f.distance;
  if (Math.abs(d) < 1e-6 && f.direction !== "two") throw new Error("Distance must not be zero");
  for (const { face, normal } of profileFaces(st, f)) {
    const ext = (dist) => R.basicFaceExtrusion(face, new R.Vector(V.mul(normal, dist)));
    if (f.direction === "symmetric") parts.push(ext(Math.abs(d)).fuse(ext(-Math.abs(d))));
    else if (f.direction === "two") parts.push(ext(d).fuse(ext(-(f.distance2 ?? d))));
    else parts.push(ext(d));
  }
  return fuseAll(parts);
}

function revolveAxis(st, f, sketchPlane) {
  const a = f.axis || { kind: "sketchY" };
  if (a.kind === "X") return { c: [0, 0, 0], d: [1, 0, 0] };
  if (a.kind === "Y") return { c: [0, 0, 0], d: [0, 1, 0] };
  if (a.kind === "Z") return { c: [0, 0, 0], d: [0, 0, 1] };
  if (a.kind === "sketchX") return { c: sketchPlane.origin, d: sketchPlane.xDir };
  if (a.kind === "sketchY") return { c: sketchPlane.origin, d: yDirOf(sketchPlane) };
  if (a.kind === "line") {
    const sk = st.sketches[a.sketch];
    const e = sk && sk.entities.find((x) => x.id === a.entity);
    if (!e) throw new Error("Axis line is missing");
    const p0 = to3D(sk.plane, e.a), p1 = to3D(sk.plane, e.b);
    return { c: p0, d: V.norm(V.sub(p1, p0)) };
  }
  throw new Error("Bad axis");
}

function revolveTool(st, f) {
  const faces = profileFaces(st, f);
  const firstSketch = f.profiles[0].kind !== "face" ? st.sketches[f.profiles[0].sketch] : null;
  const plane = firstSketch ? firstSketch.plane : ORIGIN_PLANES.XY;
  const { c, d } = revolveAxis(st, f, plane);
  const angle = f.angle ?? 360;
  if (Math.abs(angle) < 1e-6) throw new Error("Angle must not be zero");
  return fuseAll(faces.map(({ face }) => R.revolution(face, c, d, angle)));
}

function primitiveTool(f) {
  if (f.type === "box") return R.makeBox([-f.length / 2, -f.width / 2, 0], [f.length / 2, f.width / 2, f.height]);
  if (f.type === "cylinder") return R.makeCylinder(f.radius, f.height, [0, 0, 0], [0, 0, 1]);
  if (f.type === "sphere") return R.makeSphere(f.radius);
}

function groupByBody(refs, st, resolver) {
  const map = new Map();
  for (const r of refs) {
    const { body, edge, face } = resolver(st, r);
    if (!map.has(body)) map.set(body, []);
    map.get(body).push(edge || face);
  }
  return map;
}

/** Faces split into groups that share edges (each group is offset as one sheet). */
function touchingGroups(faces) {
  const edgesOf = faces.map((f) => f.edges);
  const parent = faces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
    if (find(i) === find(j)) continue;
    if (edgesOf[i].some((a) => edgesOf[j].some((b) => a.wrapped.IsSame(b.wrapped)))) parent[find(i)] = find(j);
  }
  const groups = new Map();
  faces.forEach((f, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); });
  return [...groups.values()];
}
function sewFaces(faces, tol, freeEdges = null) {
  const oc = R.getOC();
  const sew = new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false);
  try {
    for (const f of faces) sew.Add(f.wrapped);
    sew.Perform(new oc.Message_ProgressRange());
    if (freeEdges) for (let i = 1; i <= sew.NbFreeEdges(); i++) freeEdges.push(R.cast(sew.FreeEdge(i)));
    return sew.SewedShape();
  } finally { sew.delete(); }
}
/**
 * The solid swept by offsetting touching faces together by d: the faces sewn into one sheet, offset with
 * sharp (intersection) joins, the sheet's open edges joined to the offset sheet's by ruled faces, all sewn
 * into a solid. Planar neighbours meet in a sharp corner, like Fusion. Throws when OCCT can't build it.
 */
export function offsetSlab(faces, d) {
  // sewing may flip the sheet's orientation, which flips the side MakeThickSolid offsets to: check against
  // one face thickened on its own (always the right side) and rebuild the other way if they don't overlap
  const ref = thickenFace(faces[0], d), refVol = R.measureVolume(ref);
  for (const sign of [1, -1]) {
    const slab = offsetSlabRaw(faces, sign * d);
    let common = 0;
    try { common = R.measureVolume(slab.intersect(ref)); } catch (e) { common = 0; }
    if (common > 0.5 * refVol) return slab;
  }
  throw new Error("offset sheet on the wrong side");
}
// The sheet offset by `dist` with sharp joins: its faces and open edges.
function offsetSheet(sheet, nFaces, nFree, dist) {
  const oc = R.getOC();
  const t = new oc.BRepOffsetAPI_MakeThickSolid();
  let off;
  try {
    t.MakeThickSolidByJoin(sheet, new oc.NCollection_List_TopoDS_Shape(), dist, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, new oc.Message_ProgressRange());
    off = R.cast(t.Shape());
  } finally { t.delete(); }
  const faces = off.faces, free = [];
  if (faces.length !== nFaces) throw new Error("offset sheet changed its face count");
  sewFaces(faces, 1e-6, free);
  if (free.length !== nFree) throw new Error("offset sheet changed its boundary");
  return { faces, free };
}
// The wall joining open edge e of one slab wall to its partner g on the other. A true plane when the two edges
// are coplanar (a ruled B-spline lying on a body's flat face made the boolean silently empty: bug report
// 2026-10-20 19:27), else a ruled surface.
function sideFaces(e, g) {
  const oc = R.getOC();
  // closed boundary edges (the rims of a cylinder, a hole wall or a revolved fillet): the wire below would walk a
  // zero-width slit at the seam twice, which made the slab and every body fused with it invalid (bug report
  // 2026-10-26 17:47). Coplanar rims become one planar ring face (the larger rim outside, the other a hole);
  // others fall through to the ruled surface, which handles closed wires.
  const closed = (x) => V.dist(tup(x.startPoint), tup(x.endPoint)) < 1e-7;
  if (closed(e) && closed(g)) {
    const ring = planarRing(e, g);
    if (ring) return [ring];
  } else try {
    const a0 = tup(e.startPoint), a1 = tup(e.endPoint);
    let b0 = tup(g.startPoint), b1 = tup(g.endPoint);
    if (V.dist(a0, b1) + V.dist(a1, b0) < V.dist(a0, b0) + V.dist(a1, b1)) [b0, b1] = [b1, b0];
    const parts = [e];
    if (V.dist(a1, b1) > 1e-7) parts.push(R.makeLine(a1, b1));
    parts.push(g);
    if (V.dist(b0, a0) > 1e-7) parts.push(R.makeLine(b0, a0));
    const wire = R.assembleWire(parts);
    const mk = new oc.BRepBuilderAPI_MakeFace(wire.wrapped, true);
    try { if (mk.IsDone()) return [R.cast(mk.Face())]; } finally { mk.delete(); }
  } catch (err) { /* not planar: ruled surface below */ }
  const ts = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  const w1 = new oc.BRepBuilderAPI_MakeWire(e.wrapped), w2 = new oc.BRepBuilderAPI_MakeWire(g.wrapped);
  try {
    ts.AddWire(w1.Wire()); ts.AddWire(w2.Wire());
    ts.Build(new oc.Message_ProgressRange());
    return R.cast(ts.Shape()).faces;
  } finally { ts.delete(); w1.delete(); w2.delete(); }
}
// Planar face between two closed coplanar edges (null when they aren't coplanar).
function planarRing(e, g) {
  const oc = R.getOC();
  const [outer, inner] = R.measureLength(e) >= R.measureLength(g) ? [e, g] : [g, e];
  let best = null, bestArea = Infinity;
  for (const hole of [inner.wrapped, R.cast(inner.wrapped.Reversed()).wrapped]) {
    const wo = new oc.BRepBuilderAPI_MakeWire(outer.wrapped), wi = new oc.BRepBuilderAPI_MakeWire(hole);
    let mk = null;
    try {
      mk = new oc.BRepBuilderAPI_MakeFace(wo.Wire(), true);
      if (!mk.IsDone()) return null;
      const plane = R.cast(mk.Face());
      const n = V.norm(tup(faceNormal(plane))), o = tup(outer.startPoint);
      for (const t of [0, 0.25, 0.5, 0.75]) if (Math.abs(V.dot(V.sub(tup(inner.pointAt(t)), o), n)) > 1e-6) return null;
      mk.Add(wi.Wire());
      if (!mk.IsDone()) continue;
      // the hole wire must run against the outer one; the wrong way round the "ring" covers both discs
      const face = R.cast(mk.Face()), area = R.measureArea(face);
      if (area > 0 && area < bestArea) { best = face; bestArea = area; }
    } catch (err) { /* try the other orientation */ } finally { wo.delete(); wi.delete(); if (mk) mk.delete(); }
  }
  return best;
}
function offsetSlabRaw(faces, d) {
  const oc = R.getOC();
  // one face per surface first: coplanar neighbours (a face split by a sketch line) left a seam that broke
  // half of the offset slab (bug report 2026-10-20 19:27)
  let sheet = sewFaces(faces, 1e-6);
  const uni = new oc.ShapeUpgrade_UnifySameDomain(sheet, true, true, false);
  try { uni.Build(); sheet = uni.Shape(); } finally { uni.delete(); }
  const merged = R.cast(sheet).faces, free = [];
  sewFaces(merged, 1e-6, free);
  faces = merged;
  // both walls of the slab are offsets: one a hair behind the picked faces, one at d. A slab built from the
  // body's own faces (same TShape) made the later boolean silently empty (bug report 2026-10-20 19:27)
  const near = offsetSheet(sheet, faces.length, free.length, -Math.sign(d) * 2e-3);
  const far = offsetSheet(sheet, faces.length, free.length, d);
  // each open edge pairs with the nearest open edge of the other wall; a ruled face joins them
  const sides = [], used = new Set();
  for (const e of near.free) {
    const m = edgeMid(e);
    let best = -1, bd = Infinity;
    far.free.forEach((g, k) => { if (used.has(k)) return; const dd = V.dist(m, edgeMid(g)); if (dd < bd) { bd = dd; best = k; } });
    if (best < 0) throw new Error("unmatched boundary edge");
    used.add(best);
    sides.push(...sideFaces(e, far.free[best]));
  }
  let solid = R.makeSolid([...near.faces, ...far.faces, ...sides]);
  const v = R.measureVolume(solid);
  if (!(Math.abs(v) > 1e-9)) throw new Error("empty offset slab");
  if (v < 0) solid = R.cast(solid.wrapped.Reversed());
  return solid;
}
/** A face thickened by d along its outward normal (d < 0: into the solid) as a correctly oriented solid. */
export function thickenFace(face, d) {
  const oc = R.getOC();
  const t = new oc.BRepOffsetAPI_MakeThickSolid();
  let s;
  try { t.MakeThickSolidBySimple(face.wrapped, d); s = R.cast(t.Shape()); } finally { t.delete(); }
  if (!s || !hasSolid(s)) throw new Error("Couldn't offset that face");
  if (R.measureVolume(s) < 0) s = R.cast(s.wrapped.Reversed());
  return s;
}
function shellByOffset(shape, faces, t) {
  const oc = R.getOC();
  const off = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    off.PerformByJoin(shape.wrapped, -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    const inner = R.makeSolid([R.cast(off.Shape())]);
    let out = shape.cut(inner);
    const eps = 1e-3;
    for (const face of faces) {
      const n = V.norm(tup(faceNormal(face)));
      out = out.cut(R.basicFaceExtrusion(face.clone().translate(V.mul(n, eps)), new R.Vector(V.mul(n, -(t + 2 * eps)))));
    }
    return out;
  } finally { off.delete(); }
}

// ---------- fasteners (geometry in fasteners.js) ----------
// Local frame of a fastener: z = 0 seating plane, +Z out of the surface (see fasteners.js).
// Placement: a circular edge (hole or boss rim: centre, axis, size), a hole's cylindrical face,
// a planar face (its centre), or nothing (standing on the XY plane at the origin).
function circleOfEdge(edge) {
  const [a, b, c] = [0, 1 / 3, 2 / 3].map((t) => tup(edge.pointAt(t)));
  const ab = V.sub(b, a), ac = V.sub(c, a);
  const n = V.cross(ab, ac);
  const nn = V.dot(n, n);
  if (nn < 1e-18) throw new Error("Pick a circular edge");
  const t1 = V.mul(V.cross(n, ab), V.dot(ac, ac)), t2 = V.mul(V.cross(ac, n), V.dot(ab, ab));
  const center = V.add(a, V.mul(V.add(t1, t2), 1 / (2 * nn)));   // circumcentre
  return { center, axis: V.norm(n), radius: V.dist(center, a) };
}
// outward normal of the planar face that contains the circle (null if there is none)
function outwardAt(body, center, axis) {
  for (const face of body.shape.faces) {
    if (face.geomType !== "PLANE") continue;
    const n = V.norm(tup(faceNormal(face)));
    if (Math.abs(V.dot(n, axis)) < 0.999) continue;
    if (Math.abs(V.dot(V.sub(center, tup(face.center)), n)) > 1e-3) continue;
    return n;
  }
  return null;
}
function fastenerFrame(st, f) {
  let origin = [0, 0, 0], z = [0, 0, 1], holeDia = null, standalone = false;
  const pl = f.place;
  if (!pl) standalone = true;
  else if (pl.kind === "edge") {
    const { body, edge } = resolveEdge(st, pl);
    if (edge.geomType !== "CIRCLE") throw new Error("Pick a circular edge (a hole or a round boss)");
    const c = circleOfEdge(edge);
    origin = c.center; holeDia = 2 * c.radius;
    z = outwardAt(body, c.center, c.axis) || c.axis;
  } else if (pl.kind === "face") {
    const { body, face } = resolveFace(st, pl);
    if (face.geomType === "PLANE") {
      origin = tup(face.center); z = V.norm(tup(faceNormal(face)));
    } else if (face.geomType === "CYLINDRE") {
      // a hole wall: seat at the rim that opens onto the highest-facing planar face (Direction flips it)
      const rims = face.edges.filter((e) => e.geomType === "CIRCLE").map(circleOfEdge);
      if (!rims.length) throw new Error("Pick a hole edge or a planar face");
      const opts = rims.map((c) => ({ c, n: outwardAt(body, c.center, c.axis) })).filter((o) => o.n);
      const best = (opts.length ? opts : rims.map((c) => ({ c, n: c.axis }))).reduce((a, b) => (b.n[2] > a.n[2] ? b : a));
      origin = best.c.center; z = best.n; holeDia = 2 * best.c.radius;
    } else throw new Error("Pick a hole edge, a hole, or a planar face");
  } else throw new Error("Bad fastener position");
  if (f.direction === "flip") z = V.mul(z, -1);
  if (f.offset) origin = V.add(origin, V.mul(z, f.offset));
  return { origin, z, holeDia, standalone };
}
const fastenerMeshTol = new WeakMap();
const placedCache = new Map();
function placeFastener(shape, fr, spec, meshTol) {
  // standalone parts stand on the XY plane: lift them by their depth below the seating plane
  let origin = fr.origin;
  if (fr.standalone) origin = V.add(origin, V.mul(fr.z, spec.kind === "hexNut" || spec.kind === "washer" ? 0 : +spec.length));
  const key = JSON.stringify([spec.kind, spec.size, +spec.length || 0, +spec.threadLength || 0, spec.threads || "modeled", origin.map((v) => +v.toFixed(6)), fr.z.map((v) => +v.toFixed(6))]);
  let out = placedCache.get(key);
  if (out) return out;
  out = shape.clone();                                   // replicad transforms delete their input
  const zc = Math.max(-1, Math.min(1, fr.z[2]));
  if (zc < 1 - 1e-12) {
    const axis = zc > -1 + 1e-12 ? V.norm(V.cross([0, 0, 1], fr.z)) : [1, 0, 0];
    out = out.rotate((Math.acos(zc) * 180) / Math.PI, [0, 0, 0], axis);
  }
  if (V.len(origin) > 0) out = out.translate(origin);
  if (meshTol) fastenerMeshTol.set(out, meshTol);
  placedCache.set(key, out);
  while (placedCache.size > 96) placedCache.delete(placedCache.keys().next().value);
  return out;
}

// ---------- shop stock (catalog + geometry in stock.js) ----------
// Local frame: cross-section in XY, part along +Z from z = 0. Placement reuses the fastener frame
// (circular edge, hole wall, planar face centre + normal, or the origin). With no position,
// direction "x" / "y" lays the part along that axis, resting on the XY plane.
function rotVec(v, axis, deg) {                         // Rodrigues rotation of a vector
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = V.norm(axis);
  return V.add(V.add(V.mul(v, c), V.mul(V.cross(k, v), s)), V.mul(k, V.dot(k, v) * (1 - c)));
}
const stockPlacedCache = new Map();
// ---------- gears (gears.js builds them in a local frame; the `gear` feature places a set of them) ----------
/** Rotation (axis, degrees) that takes the world axes onto the frame's xDir / yDir / normal. */
function frameRotation(fr) {
  const x = V.norm(fr.xDir), zz = V.norm(fr.normal), y = V.cross(zz, x);
  const tr = x[0] + y[1] + zz[2];
  const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (ang < 1e-9) return null;
  let axis = [y[2] - zz[1], zz[0] - x[2], x[1] - y[0]];
  if (V.len(axis) < 1e-9) {
    // 180 degrees: the axis is the column of (R + I) with the largest norm
    const cols = [[x[0] + 1, x[1], x[2]], [y[0], y[1] + 1, y[2]], [zz[0], zz[1], zz[2] + 1]];
    axis = cols.reduce((a, b) => (V.len(b) > V.len(a) ? b : a));
  }
  return { axis: V.norm(axis), deg: (ang * 180) / Math.PI };
}
const gearPlacedCache = new Map();
/** Place a gear (or rack) from its local frame: spin by `spin` degrees about local Z, then into the feature frame at (u, v, z0). */
function placeGear(local, fr, g, spin) {
  const key = JSON.stringify([gearParams(g), fr, g.center, g.z0 || 0, spin]);
  let out = gearPlacedCache.get(key);
  if (out) return out;
  out = local.clone();
  if (spin) out = out.rotate(spin, [0, 0, 0], [0, 0, 1]);
  if (g.z0) out = out.translate([0, 0, g.z0]);
  out = out.translate([g.center[0], g.center[1], 0]);
  const rot = frameRotation(fr);
  if (rot) out = out.rotate(rot.deg, [0, 0, 0], rot.axis);
  if (V.len(fr.origin) > 0) out = out.translate(fr.origin);
  gearPlacedCache.set(key, out);
  while (gearPlacedCache.size > 96) gearPlacedCache.delete(gearPlacedCache.keys().next().value);
  return out;
}
function placeStock(f, built, fr) {
  let z = fr.z;
  if (fr.standalone && (f.direction === "x" || f.direction === "y")) z = f.direction === "x" ? [1, 0, 0] : [0, 1, 0];
  const rot = +f.rotation || 0;
  // alignment of local +Z onto z (same convention as placeFastener)
  const zc = Math.max(-1, Math.min(1, z[2]));
  const align = zc < 1 - 1e-12 ? { axis: zc > -1 + 1e-12 ? V.norm(V.cross([0, 0, 1], z)) : [1, 0, 0], deg: (Math.acos(zc) * 180) / Math.PI } : null;
  let origin = fr.origin;
  if (fr.standalone && align) {
    // lying down: lift the part so its cross-section rests on z = 0
    const toWorld = (v) => (align ? rotVec(rotVec(v, [0, 0, 1], rot), align.axis, align.deg) : v);
    const ex = toWorld([1, 0, 0]), ey = toWorld([0, 1, 0]);
    const [x0, x1, y0, y1] = built.env;
    let low = Infinity;
    for (const x of [x0, x1]) for (const y of [y0, y1]) low = Math.min(low, x * ex[2] + y * ey[2]);
    if (isFinite(low)) origin = V.add(origin, [0, 0, -low]);
  }
  const key = JSON.stringify([f.item, +f.length || 0, f.params || {}, rot, origin.map((v) => +v.toFixed(6)), z.map((v) => +v.toFixed(6))]);
  let out = stockPlacedCache.get(key);
  if (out) return out;
  out = built.shape.clone();                             // replicad transforms delete their input
  if (rot) out = out.rotate(rot, [0, 0, 0], [0, 0, 1]);
  if (align) out = out.rotate(align.deg, [0, 0, 0], align.axis);
  if (V.len(origin) > 0) out = out.translate(origin);
  stockPlacedCache.set(key, out);
  while (stockPlacedCache.size > 96) stockPlacedCache.delete(stockPlacedCache.keys().next().value);
  return out;
}

/**
 * The plane a sketch lies on in state st. A construction plane's current plane; a sketch on a face re-resolves
 * that face (like a construction plane on a face does), so an upstream edit that moves the face takes the sketch
 * with it (bug report 2026-10-26 17:44: a hole sketched on a plate's top face stayed at the old height after the
 * plate got thicker and silently became blind). The stored plane's 2D frame is carried over: its normal is
 * turned onto the face's by the smallest rotation and its origin projected onto the face, so the sketch keeps
 * its coordinates (and its projected model origin). A lost or non-planar face keeps the stored plane.
 */
export function sketchPlane(st, f) {
  const pr = f.planeRef;
  if (pr && pr.kind === "cplane" && st.planes[pr.id]) return st.planes[pr.id].plane;
  if (pr && pr.kind === "face" && pr.ref && f.plane && st.bodies.some((b) => b.id === pr.ref.body)) {
    try {
      const { face } = resolveFace(st, pr.ref);
      if (face.geomType === "PLANE") return followPlane(f.plane, planeFromFace(face));
    } catch (e) { /* keep the stored plane */ }
  }
  return f.plane;
}
/** Plane `old` moved onto plane `to` (same normal and height) keeping its in-plane frame. */
export function followPlane(old, to) {
  const n0 = V.norm(old.normal), n1 = V.norm(to.normal);
  const c = V.dot(n0, n1);
  if (c < -0.999999) return old;                  // flipped: the face match is the wrong side, keep it
  let xDir = V.norm(old.xDir);
  const ax = V.cross(n0, n1), s = V.len(ax);
  if (s > 1e-12) xDir = V.norm(rotVec(xDir, ax, (Math.atan2(s, c) * 180) / Math.PI));
  xDir = V.norm(V.sub(xDir, V.mul(n1, V.dot(xDir, n1))));
  const origin = V.add(old.origin, V.mul(n1, V.dot(V.sub(to.origin, old.origin), n1)));
  return { origin, xDir, normal: n1 };
}

export function applyFeature(st, f) {
  st.lastTool = null;
  switch (f.type) {
    case "sketch": {
      const plane = sketchPlane(st, f);
      const entities = isModel(f) ? flatten(f) : f.entities;
      // host: the body whose face the sketch is on; it follows that body's assembly placement on screen
      const host = f.planeRef && f.planeRef.kind === "face" && f.planeRef.ref ? f.planeRef.ref.body || null
        : f.planeRef && f.planeRef.kind === "cplane" ? st.planes[f.planeRef.id]?.host || null : null;
      st.sketches[f.id] = { id: f.id, name: f.name, plane, entities, profiles: sketchProfiles(plane, entities), host };
      break;
    }
    case "plane": {
      let base;
      if (f.base.kind === "origin") base = ORIGIN_PLANES[f.base.name];
      else if (f.base.kind === "cplane") base = st.planes[f.base.id]?.plane;
      else base = planeFromFace(resolveFace(st, f.base.ref).face);
      if (!base) throw new Error("Base plane missing");
      const host = f.base.kind === "face" && f.base.ref ? f.base.ref.body || null : f.base.kind === "cplane" ? st.planes[f.base.id]?.host || null : null;
      st.planes[f.id] = { id: f.id, name: f.name, plane: offsetPlane(base, f.offset || 0), host };
      break;
    }
    case "extrude": {
      const tool = extrudeTool(st, f);
      st.lastTool = tool;
      const before = new Set(st.bodies);
      combine(st, tool, autoOperation(st, f));
      tagHost(st, f, before);
      break;
    }
    case "revolve": {
      const tool = revolveTool(st, f);
      st.lastTool = tool;
      const before = new Set(st.bodies);
      combine(st, tool, f.operation === "auto" || !f.operation ? (st.bodies.length ? "join" : "new") : f.operation);
      tagHost(st, f, before);
      break;
    }
    case "box": case "cylinder": case "sphere": {
      const tool = primitiveTool(f);
      st.lastTool = tool;
      combine(st, tool, f.operation === "auto" || !f.operation ? (st.bodies.length ? "join" : "new") : f.operation);
      break;
    }
    case "fillet": case "chamfer": {
      if (!(f.edges || []).length) throw new Error("No edges selected");
      const v = f.type === "fillet" ? f.radius : f.distance;
      if (!(v > 0)) throw new Error("Size must be positive");
      // OCCT can hand back an invalid solid instead of failing when the size is too large for the edge (bug report
      // 2026-10-26 17:44: an r20 fillet on an 8 mm flange "grew" the body by 6.8 cm³). Check the result and refuse
      // it, unless the body was already invalid (then the check says nothing about this feature).
      const tooBig = f.type === "fillet" ? "Fillet radius too large for this edge" : "Chamfer distance too large for this edge";
      for (const [body, edges] of groupByBody(f.edges, st, resolveEdge)) {
        let out;
        try { out = f.type === "fillet" ? body.shape.fillet(v, (e) => e.inList(edges)) : body.shape.chamfer(v, (e) => e.inList(edges)); }
        catch (e) { throw new Error(isOcctException(e) ? `${tooBig} (or OCCT can't ${f.type} these edges)` : (e && e.message) || String(e)); }
        if (!out || !hasSolid(out) || (!isValidShape(out) && isValidShape(body.shape))) throw new Error(tooBig);
        body.shape = out;
      }
      break;
    }
    case "shell": {
      if (!(f.faces || []).length) throw new Error("No faces selected");
      if (!(f.thickness > 0)) throw new Error("Thickness must be positive");
      for (const [body, faces] of groupByBody(f.faces, st, resolveFace)) {
        const before = R.measureVolume(body.shape);
        const unchanged = (s) => Math.abs(R.measureVolume(s) - before) < 1e-6 * Math.max(1, before);
        let out = null;
        try { out = body.shape.shell(f.thickness, (ff) => ff.inList(faces)); } catch (e) { out = null; }
        // like fillets, a too-thick wall can come back as an invalid solid instead of an error
        if (out && !unchanged(out) && !isValidShape(out) && isValidShape(body.shape)) out = null;
        // OCCT hands back the input unchanged when the removed face is tangent to a kept one
        // (e.g. next to a fillet); fall back to hollowing by an inward offset and cutting the openings
        const fail = "Shell failed: make the wall thinner than the smallest fillet radius";
        if (!out || unchanged(out)) {
          try { out = shellByOffset(body.shape, faces, f.thickness); } catch (e) { throw new Error(fail); }
        }
        if (unchanged(out)) throw new Error(fail);
        body.shape = out;
      }
      break;
    }
    case "offsetFace": {
      // Offset Face (feature request 2026-10-20 "offset tool ... in 3D"): picked faces that touch are offset
      // together (offsetSlab: one sewn sheet, sharp joins, so neighbours extend / trim into each other; bug report
      // 2026-10-20 19:27, one slab per face left "phantom corners" where picked faces meet) and the slab is fused
      // on (+, along the outward normal) or cut away (−). A sheet OCCT can't offset falls back to one slab per face.
      if (!(f.faces || []).length) throw new Error("No faces selected");
      const d = +f.distance;
      if (!isFinite(d)) throw new Error("Distance must be a number");
      if (Math.abs(d) < 1e-9) break;
      // The result is checked with BRepCheck: on curved faces (a hole wall, a cylinder's side, a fillet's torus) the
      // joined slab is not a valid solid (the seam edge), and fusing it gave an invalid compound with the right volume
      // that broke later fillets, STEP export and FEA (bug report 2026-10-26 17:47). Each group tries the joined slab,
      // then one MakeThickSolidBySimple slab per face, and keeps the first valid body (ShapeFix_Shape isn't in this build).
      for (const [body, faces] of groupByBody(f.faces, st, resolveFace)) {
        const wasValid = isValidShape(body.shape);
        let out = body.shape;
        for (const group of touchingGroups(faces)) {
          const builds = [() => [offsetSlab(group, d)], () => group.map((face) => thickenFace(face, d))];
          let done = null, firstSolid = null;
          for (const build of builds) {
            let next = out;
            try {
              for (const slab of build()) next = d > 0 ? next.fuse(slab) : next.cut(slab);
              try { const s = next.simplify(); if (s && hasSolid(s)) next = s; } catch (e) { /* keep the split faces */ }
            } catch (e) { continue; }
            if (!hasSolid(next)) { firstSolid = firstSolid || next; continue; }
            if (!wasValid || isValidShape(next)) { done = next; break; }
            firstSolid = firstSolid || next;
          }
          if (!done && firstSolid && !hasSolid(firstSolid)) throw new Error("Offset removed the whole body");
          if (!done) throw new Error("Offset Face couldn't make a valid solid with this distance on these faces (try a smaller distance)");
          out = done;
        }
        if (!hasSolid(out)) throw new Error("Offset removed the whole body");
        body.shape = out;
      }
      break;
    }
    case "import": {
      const shapes = importedShapes(f);
      if (!shapes.length) throw new Error("The file contained no solid geometry");
      const t = f.translate || [0, 0, 0];
      for (const sh of shapes) {
        let s = sh.clone();
        if (f.scale && f.scale !== 1) s = s.scale(f.scale, [0, 0, 0]);
        if (t[0] || t[1] || t[2]) s = s.translate(t);
        newBody(st, s);
        if (f.bodyNames) st.bodies[st.bodies.length - 1].name = `${f.bodyNames}${shapes.length > 1 ? ` (${shapes.indexOf(sh) + 1})` : ""}`;
      }
      break;
    }
    case "insert": { applyInsert(st, f); break; } // an inserted design (hybrid; see "inserted designs" below)
    case "move": {
      // Move/Copy bodies (feature request 2026-10-09, translate + rotate gizmo): rotate about `pivot`
      // by rotate[0] about X, then rotate[1] about Y, then rotate[2] about Z (world axes), then translate
      const ids = f.bodies || [];
      if (!ids.length) throw new Error("No bodies selected");
      for (const id of ids) {
        const b = st.bodies.find((x) => x.id === id);
        if (!b) throw new Error(`Body ${id} is missing`);
        const s = moveShape(b.shape, f);
        if (f.copy) {
          newBody(st, s);
          const nb = st.bodies[st.bodies.length - 1];
          for (const k of ["meshTol", "fastener", "stock", "stockAppearance"]) if (b[k] != null) nb[k] = b[k];
        } else b.shape = s;
      }
      break;
    }
    case "remove": {
      st.bodies = st.bodies.filter((b) => b.id !== f.body);
      break;
    }
    case "fastener": {
      const fr = fastenerFrame(st, f);
      const size = !f.size || f.size === "auto" ? (fr.holeDia ? autoSize(fr.holeDia) : "M6") : f.size;
      const spec = { kind: f.kind, size, length: f.length, threadLength: f.threadLength, threads: f.threads };
      const { shape, meshTol } = cachedFastener(spec);
      const placed = placeFastener(shape, fr, spec, meshTol);
      st.lastTool = placed;
      newBody(st, placed);
      const b = st.bodies[st.bodies.length - 1];
      b.name = fastenerName(spec);
      if (meshTol) b.meshTol = meshTol;
      b.fastener = { kind: f.kind, size };
      break;
    }
    case "stock": {
      const item = stockItem(f.item);
      if (!item) throw new Error(`Unknown stock item ${f.item}`);
      if (item.fastener) throw new Error("Hardware is inserted as a fastener feature");
      const fr = fastenerFrame(st, f);
      const built = cachedStock(item.id, f.length, f.params || {});
      const placed = placeStock(f, built, fr);
      st.lastTool = placed;
      newBody(st, placed);
      const b = st.bodies[st.bodies.length - 1];
      b.name = stockName(item.id, f.length, f.params || {});
      b.stock = { item: item.id };
      // default look + physical material; main.js copies it into doc.appearances (stock.js syncStockAppearances)
      b.stockAppearance = defaultAppearance(item.id, f.material);
      break;
    }
    case "gear": {
      // f: { frame: {origin, xDir, normal}, gears: [{ kind, module, teeth, …, center: [u, v], phase, z0, rackAngle }] }
      const fr = f.frame || ORIGIN_PLANES.XY;
      if (!Array.isArray(f.gears) || !f.gears.length) throw new Error("No gears to make");
      const placed = [];
      f.gears.forEach((g, i) => {
        const p = gearParams(g);
        const spin = p.kind === "rack" ? +g.rackAngle || 0 : +g.phase || 0;
        const shape = placeGear(cachedGear(p), fr, g, spin);
        placed.push(shape);
        newBody(st, shape);
        const b = st.bodies[st.bodies.length - 1];
        b.name = g.name || gearName(p);
        const yDir = yDirOf(fr), n = V.norm(fr.normal);
        const at = (u, v, w) => V.add(fr.origin, V.add(V.add(V.mul(fr.xDir, u), V.mul(yDir, v)), V.mul(n, w)));
        // what the gear wizard and the assembly links need to know about this body
        b.gear = { ...p, center: [...g.center], phase: +g.phase || 0, rackAngle: +g.rackAngle || 0, z0: +g.z0 || 0, feature: f.id, index: i,
          frame: fr, axisPoint: at(g.center[0], g.center[1], +g.z0 || 0), axisDir: n, pitchRadius: gearSizes(p).pitchRadius,
          // racks: their direction of travel in world coordinates
          travelDir: p.kind === "rack" ? V.add(V.mul(fr.xDir, Math.cos(((+g.rackAngle || 0) * Math.PI) / 180)), V.mul(yDir, Math.sin(((+g.rackAngle || 0) * Math.PI) / 180))) : null };
        if (g.material) b.stockAppearance = { materialId: g.material };
      });
      st.lastTool = placed.length === 1 ? placed[0] : R.makeCompound(placed.map((x) => x.clone()));
      break;
    }
    default: throw new Error(`Unknown feature ${f.type}`);
  }
}

export function emptyState() {
  return { bodies: [], sketches: {}, planes: {}, errors: {}, bodyCounter: 0, lastTool: null };
}
export function cloneState(st) {
  return {
    bodies: st.bodies.map((b) => ({ ...b })),
    sketches: { ...st.sketches }, planes: { ...st.planes },
    errors: { ...st.errors }, bodyCounter: st.bodyCounter, lastTool: null,
  };
}

/** The most recent feature failure's stack (debugging aid: __K.lastFeatureError). */
export const lastFeatureError = { feature: null, stack: null };
/** True for a raw OCCT (C++) exception thrown out of the WASM build. */
export function isOcctException(e) {
  return (typeof WebAssembly !== "undefined" && WebAssembly.Exception && e instanceof WebAssembly.Exception) || String(e) === "[object WebAssembly.Exception]";
}
/** BRepCheck_Analyzer: is the shape a valid B-rep? (true when the check itself can't run) */
export function isValidShape(shape) {
  const oc = R.getOC();
  let an = null;
  try {
    an = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    return !!(an.IsValid_2 || an.IsValid_1 || an.IsValid).call(an);
  } catch (e) { return true; } finally { if (an) an.delete(); }
}
const FEATURE_LABEL = { sketch: "Sketch", extrude: "Extrude", revolve: "Revolve", fillet: "Fillet", chamfer: "Chamfer", shell: "Shell", offsetFace: "Offset Face", box: "Box", cylinder: "Cylinder", sphere: "Sphere", plane: "Construction plane", import: "Import", insert: "Insert", remove: "Remove", fastener: "Fastener", stock: "Stock", gear: "Gear", move: "Move" };
/**
 * The text a failed feature shows in the timeline. Raw OCCT exceptions used to show as
 * "[object WebAssembly.Exception]" (bug report 2026-10-26 17:44); they now name the feature and OCCT's own message.
 */
export function featureErrorText(e, f) {
  if (!isOcctException(e)) return (e && e.message) || String(e);
  let detail = "";
  try { const m = R.getOC().getExceptionMessage(e); detail = (Array.isArray(m) ? m.filter(Boolean).join(": ") : String(m || "")).trim(); } catch (x) { /* no message */ }
  const label = (f && FEATURE_LABEL[f.type]) || "Feature";
  const hint = f && f.type === "fillet" ? ": the radius is probably too large for the selected edges"
    : f && f.type === "chamfer" ? ": the distance is probably too large for the selected edges"
    : f && f.type === "shell" ? ": try a thinner wall" : "";
  return `${label} failed${hint} (geometry kernel error${detail ? `: ${detail}` : ""})`;
}
/**
 * Incremental replay: the state after each timeline prefix is cached under a key built from the
 * features' contents, so a rebuild only re-runs features from the first one that changed. Deleting a
 * body at the end of a design with two STEP imports and booleans into a 1,700-face body re-ran
 * everything (~6 s freeze, bug report 2026-10-18 19:29). Snapshots share shapes (the kernel never
 * changes a shape in place), and evaluate hands out clones, so callers can't disturb the cache.
 */
const prefixCache = new Map(); // key -> state snapshot (insertion order = LRU order)
const PREFIX_CACHE_MAX = 96;
const bigStringHash = new Map(); // embedded file data (base64 STEP etc.) -> hash, so it's hashed once
function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
// hashed from the contents every time (features can be edited in place, e.g. Suppress); only big
// embedded strings are memoized
function hashOf(f) {
  return hashString(JSON.stringify(f, (k, v) => {
    if (typeof v !== "string" || v.length < 4096) return v;
    let h = bigStringHash.get(v);
    if (!h) { h = `#${hashString(v)}`; if (bigStringHash.size > 64) bigStringHash.clear(); bigStringHash.set(v, h); }
    return h;
  }));
}
export function evaluate(features, upTo = features.length) {
  const n = Math.min(upTo, features.length);
  const keys = [];
  let key = "";
  for (let i = 0; i < n; i++) { key += `${hashOf(features[i])},`; keys.push(key); }
  // longest cached prefix
  let start = 0, st = null;
  for (let i = n - 1; i >= 0; i--) {
    const snap = prefixCache.get(keys[i]);
    if (snap) { st = cloneState(snap); st.errors = { ...snap.errors }; start = i + 1; prefixCache.delete(keys[i]); prefixCache.set(keys[i], snap); break; }
  }
  if (!st) st = emptyState();
  for (let i = start; i < n; i++) {
    const f = features[i];
    if (!f.suppressed) {
      const backup = cloneState(st);
      try { applyFeature(st, f); }
      catch (e) {
        Object.assign(st, backup);
        st.errors[f.id] = featureErrorText(e, f);
        lastFeatureError.feature = f.id; lastFeatureError.stack = (e && e.stack) || String(e); // for debugging
      }
    }
    const snap = cloneState(st); snap.errors = { ...st.errors };
    prefixCache.set(keys[i], snap);
    if (prefixCache.size > PREFIX_CACHE_MAX) prefixCache.delete(prefixCache.keys().next().value);
  }
  st.lastTool = null;
  return st;
}

// apply one feature on top of a base state without mutating it (for live preview)
/** Just the extrude / revolve tool solid (join / new previews draw it over the base, no boolean). */
export function featureTool(st, f) {
  if (f.type === "extrude") return extrudeTool(st, f);
  if (f.type === "revolve") return revolveTool(st, f);
  return null;
}
export function previewFeature(base, f) {
  const st = cloneState(base);
  try { applyFeature(st, f); return { state: st, error: null }; }
  catch (e) { const s = cloneState(base); return { state: s, error: featureErrorText(e, f) }; }
}

// project a planar face's boundary edges into sketch entities (Fusion's auto-project)
export function projectFaceEdges(face, plane) {
  const out = [];
  let n = 0;
  const id = () => `p${Date.now().toString(36)}${n++}`;
  const P = (v) => to2D(plane, tup(v));
  for (const e of face.edges) {
    const a = P(e.startPoint), b = P(e.endPoint), m = P(e.pointAt(0.5));
    const t = e.geomType;
    if (t === "LINE") out.push({ id: id(), type: "line", a, b, projected: true });
    else if (t === "CIRCLE" && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) {
      const q = P(e.pointAt(0.25));
      // centre from three points on the circle
      const ax = a[0], ay = a[1], bx = q[0], by = q[1], cx = m[0], cy = m[1];
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
      out.push({ id: id(), type: "circle", c: [ux, uy], r: Math.hypot(ax - ux, ay - uy), projected: true });
    } else if (t === "CIRCLE") out.push({ id: id(), type: "arc", a, b, m, projected: true });
    else {
      let prev = a;
      for (let i = 1; i <= 16; i++) { const p = i === 16 ? b : P(e.pointAt(i / 16)); out.push({ id: id(), type: "line", a: prev, b: p, projected: true }); prev = p; }
    }
  }
  return out;
}

// ---------- tessellation & inspection ----------
const meshCache = new WeakMap();
/** Tessellate a body for display. tol: chordal tolerance (modeled threads use a coarser one, see fasteners.js). */
export function meshBody(shape, tol) {
  tol = tol || fastenerMeshTol.get(shape) || 0.01;
  const hit = meshCache.get(shape);
  if (hit && hit.tol === tol) return hit.m;
  const q = tol > 0.01 ? { tolerance: tol, angularTolerance: 0.6 } : { tolerance: 0.01, angularTolerance: 0.15 };
  const m = { faces: shape.mesh(q), edges: shape.meshEdges(q) };
  fixSingularNormals(m.faces);
  meshCache.set(shape, { tol, m });
  return m;
}
/**
 * OCCT's vertex normal at a surface singularity (a revolved dome's pole, a cone's apex) is
 * undefined and sometimes comes back flipped, which shades as a dark spot (bug report
 * 2026-10-09 "spot on top of the dome"). Replace any normal that disagrees with the
 * area-weighted normal of its own triangles. In place; triangles keep OCCT's outward winding.
 */
export function fixSingularNormals(fm) {
  const { vertices: V, normals: N, triangles: T } = fm;
  if (!V || !N || !T) return fm;
  const acc = new Float64Array(N.length);
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { acc[i] += nx; acc[i + 1] += ny; acc[i + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]);
    if (!(l > 0)) continue;
    const ax = acc[i] / l, ay = acc[i + 1] / l, az = acc[i + 2] / l;
    const nl = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (!(nl > 0.5) || (N[i] * ax + N[i + 1] * ay + N[i + 2] * az) / nl < 0.3) { N[i] = ax; N[i + 1] = ay; N[i + 2] = az; }
  }
  return fm;
}
export function meshFace(face) { return face.mesh({ tolerance: 0.01, angularTolerance: 0.15 }); }
export function faceInfo(shape, idx) {
  const f = shape.faces[idx];
  return { type: f.geomType, area: R.measureArea(f), center: tup(f.center), normal: tup(faceNormal(f)) };
}
export function edgeInfo(shape, idx) {
  const e = shape.edges[idx];
  return { type: e.geomType, length: R.measureLength(e), mid: edgeMid(e) };
}
export function bodyInfo(shape) {
  let volume = 0, area = 0;
  try { volume = R.measureVolume(shape); } catch (e) {}
  try { area = R.measureArea(shape); } catch (e) {}
  return { volume, area, bounds: bboxOf(shape) };
}
/**
 * Exact cross-section of a solid by a plane ({ origin, xDir, normal }, in the shape's coordinates):
 * the solid ∩ a planar face larger than the shape. Returns null when the plane misses it, else
 * { area, perimeter, centroid (3D), centroid2d, Iu, Iv, Iuv (second moments about the centroid along
 * the plane's xDir / yDir, mm⁴), lines (edge polyline segments, flat xyz) }. `bounds` = [[lo], [hi]] (optional). Properties come from
 * the exact faces; the second moments from their fine triangulation (exact for straight edges).
 */
/**
 * Where a sketch plane cuts a body, as flat sketch entities in the plane's 2D coordinates (lines, circles,
 * arcs, splines as short lines; `projected: true`). Feature request 2026-10-18 18:42: the cross-section
 * of the part as geometry to snap to, add to the sketch and build features from. `bounds` as in
 * sectionBody. Returns [] when the plane misses the body (or only touches a face it lies on).
 */
export function sectionEntities(shape, plane, bounds = null) {
  const bb = bounds || bboxOf(shape);
  if (!bb) return [];
  const n = V.norm(plane.normal), lo = bb[0], hi = bb[1];
  let neg = false, pos = false;
  for (let i = 0; i < 8; i++) {
    const c = [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    const d = V.dot(V.sub(c, plane.origin), n);
    if (d < -1e-4) neg = true; else if (d > 1e-4) pos = true; // a plane on a face only touches the body
  }
  if (!neg || !pos) return [];
  const mid = V.mul(V.add(lo, hi), 0.5);
  const o = V.sub(mid, V.mul(n, V.dot(V.sub(mid, plane.origin), n)));
  const span = 2 * V.dist(lo, hi) + 10;
  const cutter = R.drawRectangle(span, span).sketchOnPlane(rPlane({ origin: o, xDir: plane.xDir, normal: n })).face();
  let sec;
  try { sec = shape.clone().intersect(cutter); } catch (e) { return []; }
  const out = [];
  for (const f of sec.faces || []) { try { out.push(...projectFaceEdges(f, plane)); } catch (e) { /* skip a bad face */ } }
  return out;
}
export function sectionBody(shape, plane, bounds = null) {
  // callers pass the display mesh's box when they have it: boundingBox costs seconds on thread helicoids
  const bb = bounds || bboxOf(shape);
  if (!bb) return null;
  const n = V.norm(plane.normal), lo = bb[0], hi = bb[1];
  // quick reject: every bounding-box corner on one side of the plane
  let neg = false, pos = false;
  for (let i = 0; i < 8; i++) {
    const c = [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    const d = V.dot(V.sub(c, plane.origin), n);
    if (d < 0) neg = true; else if (d > 0) pos = true;
  }
  if (!neg || !pos) return null;
  // centre the cutting face on the box centre projected onto the plane, big enough to cover it
  const mid = V.mul(V.add(lo, hi), 0.5);
  const o = V.sub(mid, V.mul(n, V.dot(V.sub(mid, plane.origin), n)));
  const span = 2 * V.dist(lo, hi) + 10;
  const pl = { origin: o, xDir: plane.xDir, normal: n };
  const cutter = R.drawRectangle(span, span).sketchOnPlane(rPlane(pl)).face();
  let sec;
  try { sec = shape.clone().intersect(cutter); } catch (e) { return null; }
  const faces = (sec.faces || []).filter((f) => R.measureArea(f) > 1e-9);
  if (!faces.length) return null;
  const area = faces.reduce((s, f) => s + R.measureArea(f), 0);
  let perimeter = 0;
  try { perimeter = R.measureShapeLinearProperties(sec).length; } catch (e) {}
  // centroid + second moments in plane coordinates (u along xDir, v along yDir)
  let A = 0, Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0;
  for (const f of faces) {
    const m = f.mesh({ tolerance: 0.005, angularTolerance: 0.05 });
    const P = (k) => to2D(pl, [m.vertices[3 * k], m.vertices[3 * k + 1], m.vertices[3 * k + 2]]);
    for (let t = 0; t < m.triangles.length; t += 3) {
      const a = P(m.triangles[t]), b = P(m.triangles[t + 1]), c = P(m.triangles[t + 2]);
      const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      // exact triangle moments: ∫x² = A/6 (xa² + xb² + xc² + xa xb + xb xc + xc xa), ∫xy likewise
      const q = (i, j) => (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + ((a[i] + b[i] + c[i]) * (a[j] + b[j] + c[j]))) / 12;
      A += ar; Su += ar * (a[0] + b[0] + c[0]) / 3; Sv += ar * (a[1] + b[1] + c[1]) / 3;
      Suu += ar * q(0, 0); Svv += ar * q(1, 1); Suv += ar * q(0, 1);
    }
  }
  const cu = A ? Su / A : 0, cv = A ? Sv / A : 0;
  const lines = [];
  try { lines.push(...sec.meshEdges({ tolerance: 0.01, angularTolerance: 0.1 }).lines); } catch (e) {}
  return {
    area, perimeter, centroid: to3D(pl, [cu, cv]), centroid2d: [cu, cv],
    // about centroidal axes parallel to u / v: Iu = ∫v'² dA, Iv = ∫u'² dA, Iuv = ∫u'v' dA
    Iu: Svv - A * cv * cv, Iv: Suu - A * cu * cu, Iuv: Suv - A * cu * cv,
    lines, faces: faces.length,
  };
}
export function distanceBetween(a, b) { return R.measureDistanceBetween(a, b); }
export function faceOf(state, bodyId, idx) { return state.bodies.find((b) => b.id === bodyId).shape.faces[idx]; }
/**
 * Where a fillet / chamfer drag arrow sits on an edge: { origin (edge midpoint), dir (unit, along the
 * bisector of the two faces, toward where the fillet surface goes: into the material on a convex edge,
 * into the empty side on a concave one), angle (the opening angle between the faces on that side, rad) }, or null when the edge doesn't join two faces. Tip offsets for a size s: the fillet's
 * mid-arc is s·(1/sin(angle/2) − 1) from the edge, an equal-distance chamfer's mid-line s·cos(angle/2).
 */
export function edgeFrame(shape, idx) {
  const e = shape.edges[idx];
  if (!e) return null;
  const mid = edgeMid(e), ns = [];
  for (const f of shape.faces) {
    if (!f.edges.some((x) => x.isSame(e))) continue;
    try { ns.push(V.norm(tup(f.normalAt(mid)))); } catch (err) {}
    if (ns.length === 2) break;
  }
  if (ns.length < 2) return null;
  const s = V.add(ns[0], ns[1]);
  if (V.len(s) < 1e-6) return null; // tangent faces (seam of a smooth surface)
  const between = Math.acos(Math.max(-1, Math.min(1, V.dot(ns[0], ns[1]))));
  let dir = V.mul(V.norm(s), -1);
  // a concave edge (a pocket's floor) fillets into the empty side. Beside a convex edge, a step along
  // n1 − n2 leaves the solid; beside a concave one it stays inside (distance from an inside point is 0)
  try { if (R.measureDistanceBetween(R.makeVertex(V.add(mid, V.mul(V.sub(ns[0], ns[1]), 0.01))), shape) < 1e-9) dir = V.mul(dir, -1); } catch (err) {}
  return { origin: mid, dir, angle: Math.PI - between };
}
// closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5)
function closestOnTri(p, a, b, c) {
  const ab = V.sub(b, a), ac = V.sub(c, a), ap = V.sub(p, a);
  const d1 = V.dot(ab, ap), d2 = V.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = V.sub(p, b), d3 = V.dot(ab, bp), d4 = V.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return V.add(a, V.mul(ab, d1 / (d1 - d3)));
  const cp = V.sub(p, c), d5 = V.dot(ab, cp), d6 = V.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return V.add(a, V.mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return V.add(b, V.mul(V.sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  return V.add(a, V.add(V.mul(ab, vb * den), V.mul(ac, vc * den)));
}
/**
 * A point on face `idx` and its normal there, for arrows on curved faces (a face's `center` is its
 * centroid, which on a dome or cylinder lies off the surface, and `faceNormal` is then the mid-parameter
 * normal, unrelated to it). `near` (e.g. the pick point, in the shape's coordinates) picks the spot:
 * the face point closest to it, else the one closest to the centroid. Returns { origin (on the face),
 * normal (unit, out of the solid; checked with a point-in-solid test), dir (= −normal, into the material) } or null.
 */
export function faceFrameAt(shape, idx, near = null) {
  const f = shape.faces[idx];
  if (!f) return null;
  const target = near ? [near[0], near[1], near[2]] : tup(f.center);
  // closest point on the face's triangulation (stays inside the trimmed face, unlike the mid-UV point)
  let p = null, best = Infinity;
  try {
    const m = f.mesh({ tolerance: 0.01, angularTolerance: 0.15 }), vs = m.vertices, ts = m.triangles;
    const P = (k) => [vs[3 * k], vs[3 * k + 1], vs[3 * k + 2]];
    for (let t = 0; t < ts.length; t += 3) {
      const q = closestOnTri(target, P(ts[t]), P(ts[t + 1]), P(ts[t + 2]));
      const d = V.dist(q, target);
      if (d < best) { best = d; p = q; }
    }
  } catch (e) {}
  if (!p) { try { p = tup(f.pointOnSurface(0.5, 0.5)); } catch (e) { return null; } }
  // snap onto the exact surface (the triangulation sags up to its tolerance)
  try {
    const [u, v] = f.uvCoordinates(p), b = f.UVBounds;
    const q = tup(f.pointOnSurface((u - b.uMin) / (b.uMax - b.uMin || 1), (v - b.vMin) / (b.vMax - b.vMin || 1)));
    if (V.dist(q, p) < 0.1) p = q;
  } catch (e) {}
  let n;
  try { n = V.norm(tup(f.normalAt(p))); } catch (e) { n = null; }
  if (!n || !(V.len(n) > 0.5)) { try { n = V.norm(tup(faceNormal(f))); } catch (e) { return null; } }
  // the face's orientation should make n point out of the solid; trust the solid if it says otherwise
  const inside = (q) => { try { return R.measureDistanceBetween(R.makeVertex(q), shape) < 1e-9; } catch (e) { return null; } };
  const eps = 0.01;
  if (inside(V.sub(p, V.mul(n, eps))) === false && inside(V.add(p, V.mul(n, eps))) === true) n = V.mul(n, -1);
  return { origin: p, normal: n, dir: V.mul(n, -1) };
}
/**
 * Where the Shell drag arrow sits: on the rim of removed face `idx` (the boundary point closest to `near`,
 * else to the face's middle), on an edge it shares with a kept face (not in `removed`, a list of face indices),
 * pointing into the material along that kept face's inward normal. A wall of inside thickness t is the
 * kept face offset by t along that direction, so the tip at origin + dir·t sits on the new inner wall.
 * Falls back to faceFrameAt (the face's own inward normal) when no edge borders a kept face.
 * Returns { origin, dir, normal (of the removed face at origin, outward), rim: bool } or null.
 */
export function shellFrame(shape, idx, near = null, removed = [idx]) {
  const ff = faceFrameAt(shape, idx, near);
  if (!ff) return null;
  const f = shape.faces[idx], p = ff.origin, gone = new Set([idx, ...removed]);
  let best = null;
  for (const e of f.edges) {
    // the face on the other side of this edge (seams and pole edges have none)
    let other = -1;
    shape.faces.forEach((g, j) => { if (other < 0 && j !== idx && g.edges.some((x) => x.isSame(e))) other = j; });
    if (other < 0 || gone.has(other)) continue;
    // closest point on the edge's middle part (its ends are corners, often singular like a dome's pole):
    // sample, then narrow down around the best sample
    let q = null, bt = 0, bd = Infinity;
    const T0 = 0.12, T1 = 0.88, N = 48, at = (t) => { try { return tup(e.pointAt(Math.max(T0, Math.min(T1, t)))); } catch (err) { return null; } };
    for (let i = 0; i <= N; i++) { const t = T0 + (T1 - T0) * i / N, x = at(t); if (x && V.dist(x, p) < bd) { bd = V.dist(x, p); bt = t; q = x; } }
    if (!q) continue;
    let lo = bt - (T1 - T0) / N, hi = bt + (T1 - T0) / N;
    for (let k = 0; k < 30; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3, pa = at(a), pb = at(b);
      if (!pa || !pb) break;
      if (V.dist(pa, p) < V.dist(pb, p)) hi = b; else lo = a;
    }
    const qr = at((lo + hi) / 2);
    if (qr && V.dist(qr, p) <= bd) { q = qr; bd = V.dist(qr, p); }
    if (!best || bd < best.d) best = { d: bd, q, face: shape.faces[other] };
  }
  if (!best) return { origin: p, dir: ff.dir, normal: ff.normal, rim: false };
  let nk;
  try { nk = V.norm(tup(best.face.normalAt(best.q))); } catch (e) { nk = null; }
  if (!nk || !(V.len(nk) > 0.5)) return { origin: p, dir: ff.dir, normal: ff.normal, rim: false };
  // orientation check beside the rim, a little into the removed face's material side: stepping along −nk
  // stays in the solid, along +nk leaves it (trust the solid over the face orientation)
  let nr = ff.normal;
  try { nr = V.norm(tup(f.normalAt(best.q))); } catch (e) {}
  const inside = (x) => { try { return R.measureDistanceBetween(R.makeVertex(x), shape) < 1e-9; } catch (e) { return null; } };
  const eps = 0.01, base = V.sub(best.q, V.mul(nr, eps));
  if (inside(V.sub(base, V.mul(nk, eps))) === false && inside(V.add(base, V.mul(nk, eps))) === true) nk = V.mul(nk, -1);
  return { origin: best.q, dir: V.mul(nk, -1), normal: nr, rim: true };
}
export function edgeOf(state, bodyId, idx) { return state.bodies.find((b) => b.id === bodyId).shape.edges[idx]; }

export const STL_QUALITY = { coarse: { tolerance: 0.1, angularTolerance: 0.5 }, medium: { tolerance: 0.02, angularTolerance: 0.2 }, fine: { tolerance: 0.005, angularTolerance: 0.05 } };
export function exportSTL(bodies, { quality = "medium", binary = true } = {}) {
  // modeled threads tessellate to millions of triangles at the fine tolerance: mesh those bodies at half their display tolerance
  if (binary && bodies.some((b) => b.meshTol)) {
    const q = STL_QUALITY[quality] || STL_QUALITY.medium;
    return stlFromMeshes(bodies.map((b) => b.shape.mesh(b.meshTol ? { tolerance: Math.max(q.tolerance, b.meshTol / 2), angularTolerance: Math.max(q.angularTolerance, 0.3) } : q)));
  }
  const shapes = bodies.map((b) => b.shape);
  const s = shapes.length === 1 ? shapes[0] : R.makeCompound(shapes.map((x) => x.clone())); // makeCompound consumes its inputs
  return s.blobSTL({ ...(STL_QUALITY[quality] || STL_QUALITY.medium), binary });
}
function stlFromMeshes(meshes) {
  const n = meshes.reduce((a, m) => a + m.triangles.length / 3, 0);
  const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  const head = "CAD Modeler binary STL (mm)";
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) : 32);
  dv.setUint32(80, n, true);
  let o = 84;
  for (const m of meshes) {
    const v = m.vertices, t = m.triangles;
    const P = (i) => [v[3 * i], v[3 * i + 1], v[3 * i + 2]];
    for (let i = 0; i < t.length; i += 3) {
      const a = P(t[i]), b = P(t[i + 1]), c = P(t[i + 2]);
      const nr = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
      for (const x of [nr, a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, x[k], true); o += 4; }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return new Blob([buf], { type: "model/stl" });
}
// Wavefront OBJ (one object per body), from the same tessellation as the viewport
export function exportOBJ(bodies, { quality = "medium" } = {}) {
  const q = STL_QUALITY[quality] || STL_QUALITY.medium;
  const out = ["# CAD Modeler OBJ export (mm)"];
  let base = 1;
  for (const b of bodies) {
    const m = b.shape.mesh(q);
    out.push(`o ${b.name.replace(/\s+/g, "_")}`);
    for (let i = 0; i < m.vertices.length; i += 3) out.push(`v ${m.vertices[i]} ${m.vertices[i + 1]} ${m.vertices[i + 2]}`);
    for (let i = 0; i < m.normals.length; i += 3) out.push(`vn ${m.normals[i]} ${m.normals[i + 1]} ${m.normals[i + 2]}`);
    for (let i = 0; i < m.triangles.length; i += 3) {
      const [a, c, d] = [m.triangles[i] + base, m.triangles[i + 1] + base, m.triangles[i + 2] + base];
      out.push(`f ${a}//${a} ${c}//${c} ${d}//${d}`);
    }
    base += m.vertices.length / 3;
  }
  return new Blob([out.join("\n") + "\n"], { type: "text/plain" });
}

// ---------- import (synchronous, so imports replay in the timeline like any feature) ----------
const importCache = new Map();
export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function importFormat(name) {
  const ext = name.toLowerCase().split(".").pop();
  return { step: "step", stp: "step", stl: "stl", obj: "obj" }[ext] || null;
}
function importedShapes(f) {
  const key = `${f.id}:${f.data.length}:${f.data.slice(0, 64)}`;
  if (importCache.has(key)) return importCache.get(key);
  const bytes = base64ToBytes(f.data);
  const shape = f.format === "step" ? readSTEP(bytes) : readSTL(f.format === "obj" ? objToSTL(bytes) : bytes);
  let parts = [];
  try { parts = shape.solids && shape.solids.length ? shape.solids : [shape]; } catch (e) { parts = [shape]; }
  if (importCache.size > 20) importCache.clear();
  importCache.set(key, parts);
  return parts;
}
function withFile(bytes, fn) {
  const oc = R.getOC();
  const name = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  oc.FS.writeFile(`/${name}`, bytes);
  try { return fn(oc, name); } finally { try { oc.FS.unlink(`/${name}`); } catch (e) {} }
}
function readSTEP(bytes) {
  return withFile(bytes, (oc, name) => {
    const reader = new oc.STEPControl_Reader();
    try {
      if (!reader.ReadFile(name)) throw new Error("Couldn't read the STEP file");
      reader.TransferRoots();
      return R.cast(reader.OneShape());
    } finally { reader.delete(); }
  });
}
function readSTL(bytes) {
  return withFile(bytes, (oc, name) => {
    const reader = new oc.StlAPI_Reader();
    const raw = new oc.TopoDS_Shell();
    try {
      if (!reader.Read(raw, name)) throw new Error("Couldn't read the STL file");
      // the reader yields a compound of triangle faces; makeSolid sews them into a closed solid
      const tris = R.cast(raw);
      let solid = R.makeSolid([tris]);
      // merge coplanar triangles back into real faces when it's cheap enough
      if (tris.faces.length <= 5000) {
        const up = new oc.ShapeUpgrade_UnifySameDomain(solid.wrapped, true, true, false);
        up.Build();
        solid = R.cast(up.Shape());
        up.delete();
      }
      return solid;
    } finally { reader.delete(); }
  });
}
export function stlTriangleCount(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length) return dv.getUint32(80, true);
  return (new TextDecoder().decode(bytes).match(/facet/g) || []).length;
}
// minimal OBJ -> binary STL (triangulates polygons as fans)
function objToSTL(bytes) {
  const text = new TextDecoder().decode(bytes);
  const v = [], tris = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === "f") {
      const idx = p.slice(1).map((t) => { const i = parseInt(t.split("/")[0], 10); return i < 0 ? v.length + i : i - 1; });
      for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!tris.length) throw new Error("The OBJ file has no faces");
  const buf = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(buf);
  // OCCT sniffs the header to tell ASCII from binary, so give it a non-blank one
  const head = "binary STL converted from OBJ by CAD Modeler";
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) : 32);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const [a, b, c] = t.map((vi) => v[vi]);
    const n = V.norm(V.cross(V.sub(b, a), V.sub(c, a)));
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, n[k] || 0, true);
    t.forEach((vi, k) => { const q = v[vi]; for (let c = 0; c < 3; c++) dv.setFloat32(o + 12 + k * 12 + c * 4, q[c], true); });
  });
  return new Uint8Array(buf);
}
export function exportSTEP(bodies) {
  const shapes = bodies.map((b) => b.shape);
  const s = shapes.length === 1 ? shapes[0] : R.makeCompound(shapes.map((x) => x.clone())); // makeCompound consumes its inputs
  return s.blobSTEP();
}

// ---------- inserted designs (hybrid designs; feature schema in src/hybrid.js) ----------
// f.snapshot is a whole design ({ features, marker, appearances }); it's replayed with evaluate() and its
// bodies are added as new bodies (moved by f.translate), carrying their appearance. Nested inserts recurse.
const insertCache = new WeakMap(); // snapshot object -> evaluated bodies
const insertKeyCache = new Map(); // snapshot JSON key -> evaluated bodies (undo/redo re-parse the doc)
let insertDepth = 0;
function snapshotKey(s) {
  const j = JSON.stringify(s);
  let h = 2166136261;
  for (let i = 0; i < j.length; i++) h = Math.imul(h ^ j.charCodeAt(i), 16777619);
  return `${j.length}:${(h >>> 0).toString(36)}`;
}
/** The bodies of an inserted design: [{ id, name, shape, appearance, meshTol, fastener }] (shapes are shared: clone before use) */
export function insertedBodies(snap) {
  if (!snap || !Array.isArray(snap.features)) throw new Error("The inserted design has no features");
  if (insertCache.has(snap)) return insertCache.get(snap);
  const key = snapshotKey(snap);
  let out = insertKeyCache.get(key);
  if (!out) {
    if (insertDepth > 16) throw new Error("Inserted designs are nested too deep");
    insertDepth++;
    let st;
    try { st = evaluate(snap.features, Number.isFinite(snap.marker) ? snap.marker : snap.features.length); }
    finally { insertDepth--; }
    const apps = snap.appearances || {};
    out = st.bodies.map((b) => {
      const a = apps[b.id] || b.stockAppearance || null;
      let appearance = null;
      if (a) { appearance = { ...a }; delete appearance.auto; }
      return { id: b.id, name: b.name, shape: b.shape, appearance, meshTol: b.meshTol, fastener: b.fastener };
    });
    insertKeyCache.set(key, out);
    while (insertKeyCache.size > 24) insertKeyCache.delete(insertKeyCache.keys().next().value);
  }
  insertCache.set(snap, out);
  return out;
}
function applyInsert(st, f) {
  const src = insertedBodies(f.snapshot);
  const label = (f.source && f.source.name) || f.name || "Design";
  if (!src.length) throw new Error(`"${label}" has no bodies`);
  const t = f.translate || [0, 0, 0];
  const placed = [];
  for (const b of src) {
    let s = b.shape.clone();
    if (t[0] || t[1] || t[2]) s = s.translate(t); // translate deletes its input: it gets the clone
    placed.push(s);
    newBody(st, s);
    const nb = st.bodies[st.bodies.length - 1];
    nb.name = src.length === 1 ? label : `${label} · ${b.name}`;
    nb.inserted = { feature: f.id, source: label, body: b.id };
    if (b.appearance) nb.stockAppearance = b.appearance; // main.js copies it into doc.appearances (auto)
    if (b.meshTol) nb.meshTol = b.meshTol;
    if (b.fastener) nb.fastener = { ...b.fastener };
  }
  st.lastTool = placed.length === 1 ? placed[0] : null;
}

/**
 * Drop every cached shape (imports, sketch profiles, placed fasteners / stock / gears, inserted designs)
 * so the next evaluate rebuilds them from the document. main.js calls it when a regen shows new feature
 * errors, then evaluates once more (bug report 2026-10-18 19:19: features failed mid-session but were
 * fine after reopening the file, i.e. some cached OCCT object had gone bad).
 */
export function clearShapeCaches() {
  for (const m of [profileCache, placedCache, stockPlacedCache, gearPlacedCache, importCache, insertKeyCache, prefixCache]) m.clear();
}
