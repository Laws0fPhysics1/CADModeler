// 2D sketch constraint solver.
// Unknowns are free point coordinates and circle radii. Each constraint adds
// residuals; we drive them to zero with damped Gauss-Newton using minimum-norm
// steps (dx = J^T (J J^T + λI)^-1 (-r)), so geometry that isn't constrained
// moves as little as possible - the behaviour people expect from Fusion.
import { arcInfo } from "./sketchmodel.js";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (a) => Math.hypot(a[0], a[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const DEG = Math.PI / 180;
export const TOL = 1e-7;

function setup(m, fixedKeys = new Set(), constraints = m.constraints) {
  const keys = [], pIdx = new Map(), rIdx = new Map();
  for (const [id, p] of Object.entries(m.points)) {
    if (p.fixed || fixedKeys.has(id)) continue;
    pIdx.set(id, keys.length); keys.push(`${id}.x`, `${id}.y`);
  }
  const ent = new Map(m.entities.map((e) => [e.id, e]));
  for (const e of m.entities) if (e.type === "circle" && !fixedKeys.has(`r:${e.id}`)) { rIdx.set(e.id, keys.length); keys.push(`r:${e.id}`); }
  const x0 = keys.map((k) => {
    if (k.startsWith("r:")) return ent.get(k.slice(2)).r;
    const [id, c] = k.split(".");
    return m.points[id][c];
  });
  const mk = (x) => {
    const p = (id) => { const i = pIdx.get(id); if (i !== undefined) return [x[i], x[i + 1]]; const q = m.points[id]; return [q.x, q.y]; };
    const r = (eid) => { const e = ent.get(eid); if (e.type === "circle") { const i = rIdx.get(eid); return i !== undefined ? x[i] : e.r; } return len(sub(p(e.p1), p(e.c))); };
    return { p, r, e: (id) => ent.get(id) };
  };
  const fns = [];
  // arcs: both ends stay on the radius
  for (const e of m.entities) if (e.type === "arc") fns.push((g) => [len(sub(g.p(e.p1), g.p(e.c))) - len(sub(g.p(e.p2), g.p(e.c)))]);
  for (const c of constraints) { const f = residualFor(c, ent); if (f) fns.push(f); }
  const residuals = (x) => { const g = mk(x); const out = []; for (const f of fns) out.push(...f(g)); return out; };
  return { keys, pIdx, rIdx, x0, residuals, ent, fns };
}

const lineDir = (g, l) => sub(g.p(l.p2), g.p(l.p1));
const unit = (v) => { const l = len(v) || 1e-12; return [v[0] / l, v[1] / l]; };
const distPointLine = (g, pt, l) => { const a = g.p(l.p1), d = lineDir(g, l); return cross(d, sub(pt, a)) / (len(d) || 1e-12); };

function residualFor(c, ent) {
  const E = (i) => ent.get(c.e[i]);
  const isLine = (e) => e && e.type === "line";
  switch (c.type) {
    case "horizontal": return c.e ? (g) => [g.p(E(0).p2)[1] - g.p(E(0).p1)[1]] : (g) => [g.p(c.p[1])[1] - g.p(c.p[0])[1]];
    case "vertical": return c.e ? (g) => [g.p(E(0).p2)[0] - g.p(E(0).p1)[0]] : (g) => [g.p(c.p[1])[0] - g.p(c.p[0])[0]];
    case "parallel": return (g) => [cross(unit(lineDir(g, E(0))), unit(lineDir(g, E(1))))];
    case "perpendicular": return (g) => [dot(unit(lineDir(g, E(0))), unit(lineDir(g, E(1))))];
    case "collinear": return (g) => [cross(unit(lineDir(g, E(0))), unit(lineDir(g, E(1)))), distPointLine(g, g.p(E(1).p1), E(0))];
    case "equal":
      if (isLine(E(0))) return (g) => [len(lineDir(g, E(0))) - len(lineDir(g, E(1)))];
      return (g) => [g.r(c.e[0]) - g.r(c.e[1])];
    case "tangent":
      if (isLine(E(0)) || isLine(E(1))) {
        const [l, k] = isLine(E(0)) ? [E(0), E(1)] : [E(1), E(0)];
        return (g) => [Math.abs(distPointLine(g, g.p(k.c), l)) - g.r(k.id)];
      }
      return (g) => { const d = len(sub(g.p(E(0).c), g.p(E(1).c))); return [c.internal ? d - Math.abs(g.r(c.e[0]) - g.r(c.e[1])) : d - (g.r(c.e[0]) + g.r(c.e[1]))]; };
    case "concentric": return (g) => sub(g.p(E(0).c), g.p(E(1).c));
    case "midpoint": return (g) => { const a = g.p(E(0).p1), b = g.p(E(0).p2), q = g.p(c.p[0]); return [q[0] - (a[0] + b[0]) / 2, q[1] - (a[1] + b[1]) / 2]; };
    case "coincident": // point on curve
      if (isLine(E(0))) return (g) => [distPointLine(g, g.p(c.p[0]), E(0))];
      return (g) => [len(sub(g.p(c.p[0]), g.p(E(0).c))) - g.r(c.e[0])];
    case "dim": return c.driven ? null : dimResidual(c, ent);
  }
  return null;
}

function dimResidual(c, ent) {
  const v = c.value;
  const E = (i) => ent.get(c.e[i]);
  switch (c.kind) {
    case "distance":
      if (c.orient === "h") return (g) => [Math.abs(g.p(c.p[1])[0] - g.p(c.p[0])[0]) - v];
      if (c.orient === "v") return (g) => [Math.abs(g.p(c.p[1])[1] - g.p(c.p[0])[1]) - v];
      return (g) => [len(sub(g.p(c.p[1]), g.p(c.p[0]))) - v];
    case "pointLine": return (g) => [Math.abs(distPointLine(g, g.p(c.p[0]), E(0))) - v];
    case "lineDist": return (g) => [Math.abs(distPointLine(g, g.p(E(1).p1), E(0))) - v];
    case "diameter": return (g) => [2 * g.r(c.e[0]) - v];
    case "radius": return (g) => [g.r(c.e[0]) - v];
    case "radialGap": return (g) => [Math.abs(g.r(c.e[0]) - g.r(c.e[1])) - v]; // between concentric circles / arcs
    case "angle": return (g) => [angleOf(g, c, E(0), E(1)) - v * DEG];
  }
  return null;
}
export function angleOf(g, c, l1, l2) {
  const u1 = unit(lineDir(g, l1)).map((x) => x * (c.s1 || 1)), u2 = unit(lineDir(g, l2)).map((x) => x * (c.s2 || 1));
  return Math.atan2(Math.abs(cross(u1, u2)), dot(u1, u2));
}

// current measured value of a dimension (mm or degrees)
export function measureDim(m, c) {
  const S = setup(m, new Set(), []);
  const g = { p: (id) => [m.points[id].x, m.points[id].y], r: (eid) => { const e = S.ent.get(eid); return e.type === "circle" ? e.r : arcInfo(m, e).r; } };
  const E = (i) => S.ent.get(c.e[i]);
  switch (c.kind) {
    case "distance": {
      const a = g.p(c.p[0]), b = g.p(c.p[1]);
      return c.orient === "h" ? Math.abs(b[0] - a[0]) : c.orient === "v" ? Math.abs(b[1] - a[1]) : len(sub(b, a));
    }
    case "pointLine": return Math.abs(distPointLine(g, g.p(c.p[0]), E(0)));
    case "lineDist": return Math.abs(distPointLine(g, g.p(E(1).p1), E(0)));
    case "diameter": return 2 * g.r(c.e[0]);
    case "radius": return g.r(c.e[0]);
    case "radialGap": return Math.abs(g.r(c.e[0]) - g.r(c.e[1]));
    case "angle": return angleOf(g, c, E(0), E(1)) / DEG;
  }
  return 0;
}

const maxAbs = (r) => r.reduce((a, b) => Math.max(a, Math.abs(b)), 0);

function jacobian(S, x, r0, central = false) {
  const n = x.length, J = r0.map(() => new Float64Array(n));
  for (let j = 0; j < n; j++) {
    const h = (central ? 1e-5 : 1e-7) * Math.max(1, Math.abs(x[j]));
    const xp = x.slice(); xp[j] += h;
    const rp = S.residuals(xp);
    if (central) {
      const xm = x.slice(); xm[j] -= h;
      const rm = S.residuals(xm);
      for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    } else for (let i = 0; i < r0.length; i++) J[i][j] = (rp[i] - r0[i]) / h;
  }
  return J;
}

function gaussSolve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / A[r][r]; }
  return x;
}

// Solve in place. Returns { ok, error }. On failure the model is left untouched.
export function solve(m, { fixedKeys = new Set(), maxIter = 80 } = {}) {
  const S = setup(m, fixedKeys);
  let x = S.x0.slice();
  let r = S.residuals(x), err = maxAbs(r);
  if (err < TOL) return { ok: true, error: err };
  if (!x.length) return { ok: false, error: err };
  let lambda = 1e-6;
  for (let it = 0; it < maxIter && err >= TOL; it++) {
    const J = jacobian(S, x, r);
    const mrows = r.length, n = x.length;
    // A = J J^T
    const JJt = [];
    for (let i = 0; i < mrows; i++) { const row = new Float64Array(mrows); for (let k = 0; k < mrows; k++) { let s = 0; for (let j = 0; j < n; j++) s += J[i][j] * J[k][j]; row[k] = s; } JJt.push(row); }
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const A = JJt.map((row, i) => { const c = Float64Array.from(row); c[i] += lambda; return c; });
      const y = gaussSolve(A, r.map((v) => -v));
      if (y) {
        const xn = x.slice();
        for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < mrows; i++) s += J[i][j] * y[i]; xn[j] += s; }
        const rn = S.residuals(xn), en = maxAbs(rn);
        if (isFinite(en) && en < err) { x = xn; r = rn; err = en; lambda = Math.max(lambda / 10, 1e-12); improved = true; break; }
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  if (err >= TOL * 10) return { ok: false, error: err };
  S.keys.forEach((k, i) => {
    if (k.startsWith("r:")) S.ent.get(k.slice(2)).r = x[i];
    else { const [id, c] = k.split("."); m.points[id][c] = x[i]; }
  });
  return { ok: true, error: err };
}

function rref(J, n) {
  const A = J.map((row) => Float64Array.from(row));
  const big = A.reduce((mx, row) => Math.max(mx, maxAbs(Array.from(row))), 0);
  const tol = 1e-7 * Math.max(1, big);
  const pivots = [];
  let r = 0;
  for (let c = 0; c < n && r < A.length; c++) {
    let p = r;
    for (let i = r + 1; i < A.length; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) < tol) continue;
    [A[r], A[p]] = [A[p], A[r]];
    const pv = A[r][c];
    for (let k = 0; k < n; k++) A[r][k] /= pv;
    for (let i = 0; i < A.length; i++) if (i !== r && A[i][c]) { const f = A[i][c]; for (let k = 0; k < n; k++) A[i][k] -= f * A[r][k]; }
    pivots.push(c); r++;
  }
  return { A, pivots, tol };
}

// Which unknowns are pinned down by the constraints? (Fusion colours fully constrained geometry black.)
export function analyze(m) {
  const S = setup(m);
  const n = S.x0.length;
  if (!n) return { determined: new Set(), dof: 0, rank: 0 };
  if (!S.fns.length) return { determined: new Set(), dof: n, rank: 0 };
  const r0 = S.residuals(S.x0);
  const { A, pivots } = rref(jacobian(S, S.x0, r0, true), n);
  const pivotSet = new Set(pivots);
  const free = [...Array(n).keys()].filter((j) => !pivotSet.has(j));
  const determined = new Set();
  pivots.forEach((pc, row) => { if (free.every((f) => Math.abs(A[row][f]) < 1e-6)) determined.add(S.keys[pc]); });
  return { determined, dof: n - pivots.length, rank: pivots.length };
}
export function rankOf(m, constraints = m.constraints) {
  const S = setup(m, new Set(), constraints);
  if (!S.x0.length || !S.fns.length) return 0;
  return rref(jacobian(S, S.x0, S.residuals(S.x0), true), S.x0.length).pivots.length;
}
