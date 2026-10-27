// Constraint-ready sketch model: shared points referenced by entities, plus a
// list of constraints / dimensions. `flatten` turns it into the coordinate-only
// entities the kernel and renderer consume.
//
//   points:      { id: { x, y, fixed?, origin? } }
//   entities:    line {p1,p2} | circle {c,r} | arc {c,p1,p2} (counter-clockwise p1 -> p2)
//                + construction? / projected?
//   constraints: { id, type, p?:[pointIds], e?:[entityIds], value?, ... }
import { arcParams } from "./sketchgeom.js";

let n = 0;
export const sid = (prefix = "s") => `${prefix}${Date.now().toString(36)}${(n++).toString(36)}`;
export const ORIGIN = "O";

export function emptyModel(originUV = [0, 0]) {
  return { points: { [ORIGIN]: { x: originUV[0], y: originUV[1], fixed: true, origin: true } }, entities: [], constraints: [] };
}
export const isModel = (f) => !!(f && f.points && !Array.isArray(f.points));
export const P = (m, id) => { const p = m.points[id]; return [p.x, p.y]; };

export function arcInfo(m, e) {
  const c = P(m, e.c), a = P(m, e.p1), b = P(m, e.p2);
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  return { c, r, a0, sweep, a, b };
}
export function radiusOf(m, e) { return e.type === "circle" ? e.r : arcInfo(m, e).r; }
export function centerOf(m, e) { return P(m, e.c); }

export function flatten(m) {
  const out = [];
  for (const e of m.entities) {
    const base = { id: e.id, construction: !!e.construction, projected: !!e.projected };
    if (e.type === "line") out.push({ ...base, type: "line", a: P(m, e.p1), b: P(m, e.p2) });
    else if (e.type === "circle") out.push({ ...base, type: "circle", c: P(m, e.c), r: e.r });
    else if (e.type === "arc") {
      const i = arcInfo(m, e), t = i.a0 + i.sweep / 2;
      // keep the end point exactly on the radius so loops close cleanly
      out.push({ ...base, type: "arc", a: i.a, b: i.b, m: [i.c[0] + i.r * Math.cos(t), i.c[1] + i.r * Math.sin(t)] });
    }
  }
  return out;
}

// add coordinate-style entities (old format, face projections) to a model, merging coincident points
export function addFlat(m, flat, { fixed = false, projected = false } = {}) {
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const byKey = new Map();
  for (const [id, p] of Object.entries(m.points)) byKey.set(key([p.x, p.y]), id);
  const pt = (p) => {
    const k = key(p);
    if (byKey.has(k)) { const id = byKey.get(k); if (fixed) m.points[id].fixed = true; return id; }
    const id = sid("p");
    m.points[id] = { x: p[0], y: p[1], ...(fixed ? { fixed: true } : {}) };
    byKey.set(k, id);
    return id;
  };
  for (const e of flat) {
    const extra = { ...(e.construction ? { construction: true } : {}), ...(projected || e.projected ? { projected: true } : {}) };
    const id = e.id || sid("e");
    if (e.type === "line") m.entities.push({ id, type: "line", p1: pt(e.a), p2: pt(e.b), ...extra });
    else if (e.type === "circle") m.entities.push({ id, type: "circle", c: pt(e.c), r: e.r, ...extra });
    else if (e.type === "arc") {
      const ap = arcParams(e.a, e.m, e.b);
      if (!ap) { m.entities.push({ id, type: "line", p1: pt(e.a), p2: pt(e.b), ...extra }); continue; }
      const [s, t] = ap.sweep > 0 ? [e.a, e.b] : [e.b, e.a];
      m.entities.push({ id, type: "arc", c: pt(ap.c), p1: pt(s), p2: pt(t), ...extra });
    }
  }
  return m;
}

// sketch features saved before constraints existed stored flat entities
export function normalizeSketch(f, originUV = [0, 0]) {
  if (isModel(f)) return { points: JSON.parse(JSON.stringify(f.points)), entities: JSON.parse(JSON.stringify(f.entities)), constraints: JSON.parse(JSON.stringify(f.constraints || [])) };
  const m = emptyModel(originUV);
  const normal = (f.entities || []).filter((e) => !e.projected), proj = (f.entities || []).filter((e) => e.projected);
  addFlat(m, proj, { fixed: true, projected: true });
  addFlat(m, normal);
  return m;
}

export function entityPoints(e) {
  if (e.type === "line") return [e.p1, e.p2];
  if (e.type === "circle") return [e.c];
  if (e.type === "arc") return [e.c, e.p1, e.p2];
  return [];
}

// remove entities and everything that depended on them
export function deleteItems(m, { entities = [], constraints = [], points = [] }) {
  const de = new Set(entities), dc = new Set(constraints), dp = new Set(points);
  m.entities = m.entities.filter((e) => !de.has(e.id) && !entityPoints(e).some((p) => dp.has(p)));
  pruneOrphans(m);
  m.constraints = m.constraints.filter((c) => !dc.has(c.id));
}
export function pruneOrphans(m) {
  const used = new Set([ORIGIN]);
  for (const e of m.entities) for (const p of entityPoints(e)) used.add(p);
  for (const id of Object.keys(m.points)) if (!used.has(id)) delete m.points[id];
  const ents = new Set(m.entities.map((e) => e.id));
  m.constraints = m.constraints.filter((c) => (c.p || []).every((p) => m.points[p]) && (c.e || []).every((e) => ents.has(e)));
}

// coincident point-point: re-point every reference of `drop` at `keep`
export function mergePoints(m, keep, drop) {
  if (keep === drop) return keep;
  // a fixed point (origin, projected geometry) always survives the merge
  if (drop === ORIGIN || (m.points[drop].fixed && !m.points[keep].fixed)) [keep, drop] = [drop, keep];
  for (const e of m.entities) for (const k of ["p1", "p2", "c"]) if (e[k] === drop) e[k] = keep;
  for (const c of m.constraints) if (c.p) c.p = c.p.map((p) => (p === drop ? keep : p));
  delete m.points[drop];
  // drop degenerate lines (both ends merged) and their constraints
  m.entities = m.entities.filter((e) => !(e.type === "line" && e.p1 === e.p2));
  pruneOrphans(m);
  return keep;
}

// ---------- named dimensions and expressions (feature request 2026-10-20 "this line is that line / 2") ----------
// Every dimension gets a name (d1, d2, ... per sketch). A dimension typed as an expression that uses
// other names keeps it in `expr` and is re-evaluated whenever the sketch changes, so it stays linked.
export const isDim = (c) => c.type === "dim";
export function ensureDimNames(m) {
  let max = 0;
  for (const c of m.constraints) if (isDim(c) && /^d\d+$/.test(c.name || "")) max = Math.max(max, +c.name.slice(1));
  for (const c of m.constraints) if (isDim(c) && !c.name) c.name = `d${++max}`;
}
/** name (lower case) -> current value (mm, or degrees for angles) */
export function dimVars(m, exceptId = null) {
  const v = {};
  for (const c of m.constraints) if (isDim(c) && c.name && c.id !== exceptId) v[c.name.toLowerCase()] = c.value;
  return v;
}
/** Would dimension `id` depending on `names` make a loop? */
export function dimExprLoop(m, id, names) {
  const byName = new Map(m.constraints.filter(isDim).map((c) => [String(c.name).toLowerCase(), c]));
  const seen = new Set(), stack = [...names];
  while (stack.length) {
    const c = byName.get(stack.pop());
    if (!c || seen.has(c.id)) continue;
    if (c.id === id) return true;
    seen.add(c.id);
    if (c.expr && c.deps) stack.push(...c.deps);
  }
  return false;
}
/**
 * Re-evaluate every dimension with an expression (dependency order by repeated passes).
 * parse(c, vars) -> value or NaN. Returns true if any value changed; failing ones are listed in `bad`.
 */
export function applyDimExprs(m, parse, bad = []) {
  const withExpr = m.constraints.filter((c) => isDim(c) && c.expr && !c.driven);
  let changed = false;
  for (let pass = 0; pass <= withExpr.length; pass++) {
    let any = false;
    for (const c of withExpr) {
      const v = parse(c, dimVars(m, c.id));
      if (!isFinite(v)) { if (pass === withExpr.length) bad.push(c.id); continue; }
      if (Math.abs(v - c.value) > 1e-12) { c.value = v; any = changed = true; }
    }
    if (!any) break;
  }
  return changed;
}
