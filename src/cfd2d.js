// 2D flow solver for sketch sections (DOM-free, runs in cfd2d.worker.js and in Node tests).
// D2Q9 lattice Boltzmann, BGK collision with a Smagorinsky subgrid model so it stays stable
// at the low lattice viscosities that higher Reynolds numbers need. Fused pull streaming
// with halfway bounce-back on the body; forces by momentum exchange on the bounce-back links.
//
// Boundaries: velocity inlet (left) as equilibrium ghost cells; zero-gradient top, bottom and
// outlet (right), so a lifting section's circulation isn't pinned to the free stream at the
// edges; a sponge layer before the outlet soaks up wake eddies before they reflect. Flow runs along +x; the body is rotated for angle of attack, so lift
// is the +y force and drag the +x force. Lattice units: rho0 = 1, cs^2 = 1/3.

export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

export const FLUIDS = {
  air: { label: "Air (20 °C)", rho: 1.204, nu: 1.516e-5 },
  water: { label: "Water (20 °C)", rho: 998.2, nu: 1.004e-6 },
};
export const RESOLUTIONS = { coarse: 64, medium: 110, fine: 170 };
const U_LB = 0.08;          // inlet speed in lattice units (Mach ~0.14)
const TAU_MIN = 0.5015;     // molecular tau floor; the subgrid model carries the rest

// ---------------------------------------------------------------- geometry
/** Even-odd rasterisation of closed polylines (any number, holes allowed) onto cell centres. */
export function rasterize(loops, nx, ny, x0, y0, dx) {
  const solid = new Uint8Array(nx * ny);
  const xs = [];
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * dx;
    xs.length = 0;
    for (const L of loops) {
      for (let k = 0; k < L.length; k++) {
        const a = L[k], b = L[(k + 1) % L.length];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / dx - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / dx - 0.5));
      for (let i = i0; i <= i1; i++) solid[j * nx + i] = 1;
    }
  }
  return solid;
}

/** Turn sketch entities ({type:line|arc|circle, a, b, m, c, r}) into closed polylines (u, v). */
export function entitiesToLoops(flat, segPerRad = 12) {
  const segs = [];
  const arcPts = (c, r, a0, sweep) => {
    const n = Math.max(6, Math.ceil(Math.abs(sweep) * segPerRad));
    return Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + (sweep * i) / n), c[1] + r * Math.sin(a0 + (sweep * i) / n)]);
  };
  const loops = [];
  for (const e of flat) {
    if (e.construction) continue;
    if (e.type === "circle") { const p = arcPts(e.c, e.r, 0, 2 * Math.PI); p.pop(); loops.push(p); }
    else if (e.type === "line") segs.push([e.a, e.b]);
    else if (e.type === "arc") {
      // circle through a, m, b
      const [ax, ay] = e.a, [mx, my] = e.m, [bx, by] = e.b;
      const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
      if (Math.abs(d) < 1e-12) { segs.push([e.a, e.b]); continue; }
      const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
      const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
      const r = Math.hypot(ax - ux, ay - uy);
      const t0 = Math.atan2(ay - uy, ax - ux), tm = Math.atan2(my - uy, mx - ux), t1 = Math.atan2(by - uy, bx - ux);
      const norm = (t) => { while (t < 0) t += 2 * Math.PI; return t; };
      let sweep = norm(t1 - t0);
      if (norm(tm - t0) > sweep) sweep -= 2 * Math.PI; // the arc goes clockwise through m
      const p = arcPts([ux, uy], r, t0, sweep);
      for (let k = 0; k + 1 < p.length; k++) segs.push([p[k], p[k + 1]]);
    }
  }
  // chain the segments into loops by matching end points
  const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const at = new Map();
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  const used = new Uint8Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    const startK = key(segs[i][0]);
    let cur = segs[i][1], closed = false;
    for (let guard = 0; guard < segs.length; guard++) {
      const k = key(cur);
      if (k === startK) { closed = true; break; }
      const next = (at.get(k) || []).find((j) => !used[j]);
      if (next == null) break;
      used[next] = 1;
      const s = segs[next];
      cur = key(s[0]) === k ? s[1] : s[0];
      loop.push(cur);
    }
    if (closed && loop.length >= 4) { loop.pop(); loops.push(loop); }
  }
  return loops;
}

const bboxOf = (loops) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const L of loops) for (const [x, y] of L) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
};

/**
 * Set up a case. loops: closed polylines in mm (sketch u, v). opts: alpha (deg, nose-up),
 * speed (m/s), fluid id, resolution id or cells per reference length, refLength (mm,
 * default: the section's streamwise extent = chord), cs (Smagorinsky constant).
 */
export function setupCase(loops, opts = {}) {
  if (!loops.length) throw new Error("The sketch has no closed profile to put in the flow");
  const a = (-(opts.alpha || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const b0 = bboxOf(loops);
  const cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2;
  const rot = loops.map((L) => L.map(([x, y]) => [cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca]));
  const b = bboxOf(rot);
  const ref = opts.refLength > 0 ? opts.refLength : b0.w > 0 ? b0.w : Math.max(b.w, b.h);
  const span = Math.max(ref, b.w, b.h);
  const cells = typeof opts.resolution === "number" ? opts.resolution : RESOLUTIONS[opts.resolution || "medium"];
  const dx = ref / cells;
  // keep blockage near 10 % for bluff sections; slender ones (airfoils) get 1.3 lengths each side
  const dm = opts.domain || 1;
  const up = 2 * span * dm, down = 4 * span * dm, side = Math.max(2 * span * dm, 4.5 * b.h);
  const nx = Math.ceil((b.w + up + down) / dx), ny = Math.ceil((b.h + 2 * side) / dx);
  if (nx * ny > 1.6e6) throw new Error("That grid is too big; pick a coarser resolution");
  const x0 = b.x0 - up, y0 = b.y0 - side;
  const solid = rasterize(rot, nx, ny, x0, y0, dx);
  let nSolid = 0;
  for (let k = 0; k < solid.length; k++) nSolid += solid[k];
  if (!nSolid) throw new Error("The profile is thinner than one grid cell; use a finer resolution");
  const fluid = FLUIDS[opts.fluid || "air"] || FLUIDS.air;
  const speed = opts.speed > 0 ? opts.speed : 10;
  const ReTrue = (speed * ref * 1e-3) / fluid.nu;
  const Lc = ref / dx;
  const nuMin = (TAU_MIN - 0.5) / 3;
  const ReMax = (U_LB * Lc) / nuMin;
  const Re = Math.min(ReTrue, ReMax);
  const nu = (U_LB * Lc) / Re;
  let panel = null;
  if (loops.length === 1) { try { panel = panelMethod(loops[0], opts.alpha || 0); } catch { panel = null; } }
  return {
    nx, ny, dx, x0, y0, solid, loops: rot, panel, refCells: Lc, refLength: ref, alpha: opts.alpha || 0,
    U: U_LB, nu, tau: 3 * nu + 0.5, cs: opts.cs ?? 0.16,
    Re, ReTrue, clamped: ReTrue > ReMax * 1.0001,
    fluid: { ...fluid, id: opts.fluid || "air" }, speed,
    // lattice step in seconds: dx / dt = U_phys / U_lb
    dt: (dx * 1e-3 * U_LB) / speed,
  };
}

// ---------------------------------------------------------------- solver
export class LBM2D {
  constructor(cs) {
    this.cs = cs;
    const { nx, ny } = cs;
    // one ghost cell all round; interior (i, j) lives at (i + 1, j + 1)
    this.NX = nx + 2; this.NY = ny + 2;
    const N = (this.N = this.NX * this.NY);
    this.f = new Float64Array(9 * N); this.g = new Float64Array(9 * N);
    this.wall = new Uint8Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (cs.solid[j * nx + i]) this.wall[(j + 1) * this.NX + i + 1] = 1;
    // sponge: extra viscosity over the last 12 % of the domain
    this.omega = new Float32Array(this.NX);
    const s0 = Math.floor(this.NX * 0.88);
    for (let i = 0; i < this.NX; i++) {
      const t = i <= s0 ? 0 : (i - s0) / (this.NX - s0);
      this.omega[i] = cs.tau + t * t * 1.2; // stores tau0 per column
    }
    this.off = CX.map((cx, i) => cx + CY[i] * this.NX);
    // cells next to the body take the bounce-back path; the rest stream without checks
    this.near = new Uint8Array(N);
    for (let k = this.NX; k < N - this.NX; k++) if (!this.wall[k]) for (let q = 1; q < 9; q++) if (this.wall[k - this.off[q]]) { this.near[k] = 1; break; }
    this.t = 0;
    this.ramp = Math.max(400, Math.round(2 * cs.refCells / cs.U)); // smooth start over ~2 chord passes
    this.Fx = 0; this.Fy = 0;
    this.history = []; // {t, cd, cl}
    this.init();
  }
  uIn() { const s = Math.min(1, this.t / this.ramp); return this.cs.U * (s * s * (3 - 2 * s)); }
  // a brief cross-flow wobble during start-up breaks the mirror symmetry, so wakes that want to shed do
  vIn() { return this.t < this.ramp ? 0.03 * this.cs.U * Math.sin((2 * Math.PI * this.t) / this.ramp) : 0; }
  init() {
    const { N } = this;
    for (let i = 0; i < 9; i++) this.f.fill(W[i], i * N, (i + 1) * N);
    this.g.set(this.f);
  }
  fillGhosts(src) {
    const { NX, NY, N } = this, u = this.uIn(), v = this.vIn();
    const feq = W.map((w, i) => { const cu = 3 * (CX[i] * u + CY[i] * v); return w * (1 + cu + 0.5 * cu * cu - 1.5 * (u * u + v * v)); });
    for (let i = 0; i < 9; i++) {
      const o = i * N;
      for (let x = 1; x < NX - 1; x++) { src[o + x] = src[o + NX + x]; src[o + (NY - 1) * NX + x] = src[o + (NY - 2) * NX + x]; }
      for (let j = 0; j < NY; j++) { src[o + j * NX] = feq[i]; src[o + j * NX + NX - 1] = src[o + j * NX + NX - 2]; }
    }
  }
  step(n = 1) {
    const { NX, NY, N, wall, near, off, omega } = this;
    const [, o1, o2, o3, o4, o5, o6, o7, o8] = off;
    const cs2 = this.cs.cs * this.cs.cs * 18 * Math.SQRT2;
    for (let s = 0; s < n; s++) {
      const src = this.f, dst = this.g;
      this.fillGhosts(src);
      let fx = 0, fy = 0;
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const k = y * NX + x;
          if (wall[k]) continue;
          // pull, bouncing back off the body
          let f0 = src[k], f1, f2, f3, f4, f5, f6, f7, f8;
          if (!near[k]) {
            f1 = src[N + k - o1]; f2 = src[2 * N + k - o2]; f3 = src[3 * N + k - o3]; f4 = src[4 * N + k - o4];
            f5 = src[5 * N + k - o5]; f6 = src[6 * N + k - o6]; f7 = src[7 * N + k - o7]; f8 = src[8 * N + k - o8];
          } else {
          if (wall[k - off[1]]) { f1 = src[3 * N + k]; fx += 2 * f1; } else f1 = src[N + k - off[1]];
          if (wall[k - off[2]]) { f2 = src[4 * N + k]; fy += 2 * f2; } else f2 = src[2 * N + k - off[2]];
          if (wall[k - off[3]]) { f3 = src[N + k]; fx -= 2 * f3; } else f3 = src[3 * N + k - off[3]];
          if (wall[k - off[4]]) { f4 = src[2 * N + k]; fy -= 2 * f4; } else f4 = src[4 * N + k - off[4]];
          if (wall[k - off[5]]) { f5 = src[7 * N + k]; fx += 2 * f5; fy += 2 * f5; } else f5 = src[5 * N + k - off[5]];
          if (wall[k - off[6]]) { f6 = src[8 * N + k]; fx -= 2 * f6; fy += 2 * f6; } else f6 = src[6 * N + k - off[6]];
          if (wall[k - off[7]]) { f7 = src[5 * N + k]; fx -= 2 * f7; fy -= 2 * f7; } else f7 = src[7 * N + k - off[7]];
          if (wall[k - off[8]]) { f8 = src[6 * N + k]; fx += 2 * f8; fy -= 2 * f8; } else f8 = src[8 * N + k - off[8]];
          }
          // fx, fy collect the momentum each bounce hands back to the fluid (2 f c_i per link)
          const rho = f0 + f1 + f2 + f3 + f4 + f5 + f6 + f7 + f8;
          const ir = 1 / rho;
          const ux = (f1 - f3 + f5 - f6 - f7 + f8) * ir, uy = (f2 - f4 + f5 + f6 - f7 - f8) * ir;
          const uu = 1.5 * (ux * ux + uy * uy);
          const r9 = rho * (4 / 9), r1 = rho / 9, r36 = rho / 36;
          const e0 = r9 * (1 - uu);
          const e1 = r1 * (1 + 3 * ux + 4.5 * ux * ux - uu), e3 = r1 * (1 - 3 * ux + 4.5 * ux * ux - uu);
          const e2 = r1 * (1 + 3 * uy + 4.5 * uy * uy - uu), e4 = r1 * (1 - 3 * uy + 4.5 * uy * uy - uu);
          const a5 = ux + uy, a6 = -ux + uy;
          const e5 = r36 * (1 + 3 * a5 + 4.5 * a5 * a5 - uu), e7 = r36 * (1 - 3 * a5 + 4.5 * a5 * a5 - uu);
          const e6 = r36 * (1 + 3 * a6 + 4.5 * a6 * a6 - uu), e8 = r36 * (1 - 3 * a6 + 4.5 * a6 * a6 - uu);
          const n1 = f1 - e1, n2 = f2 - e2, n3 = f3 - e3, n4 = f4 - e4, n5 = f5 - e5, n6 = f6 - e6, n7 = f7 - e7, n8 = f8 - e8;
          const pxx = n1 + n3 + n5 + n6 + n7 + n8, pyy = n2 + n4 + n5 + n6 + n7 + n8, pxy = n5 - n6 + n7 - n8;
          const Q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
          const t0 = omega[x];
          const om = 2 / (t0 + Math.sqrt(t0 * t0 + cs2 * Q * ir));
          dst[k] = f0 - om * (f0 - e0);
          dst[N + k] = f1 - om * n1; dst[2 * N + k] = f2 - om * n2; dst[3 * N + k] = f3 - om * n3; dst[4 * N + k] = f4 - om * n4;
          dst[5 * N + k] = f5 - om * n5; dst[6 * N + k] = f6 - om * n6; dst[7 * N + k] = f7 - om * n7; dst[8 * N + k] = f8 - om * n8;
        }
      }
      // the body gets the opposite: drag along +x, lift along +y
      this.Fx = -fx; this.Fy = -fy;
      this.f = dst; this.g = src;
      this.t++;
      if (this.t % 10 === 0) {
        const U = this.cs.U, q = 0.5 * U * U * this.cs.refCells;
        this.history.push({ t: this.t, cd: this.Fx / q, cl: this.Fy / q });
        if (this.history.length > 6000) this.history.splice(0, this.history.length - 6000);
      }
    }
  }
  /** Chord passes so far (convective time t U / c). */
  get passes() { return (this.t * this.cs.U) / this.cs.refCells; }
  /** Mean coefficients over the last `window` chord passes (skipping the start-up ramp). */
  mean(window = 2) {
    const U = this.cs.U, Lc = this.cs.refCells;
    const tMin = Math.max(this.ramp * 1.5, this.t - (window * Lc) / U);
    const h = this.history.filter((p) => p.t >= tMin);
    if (h.length < 5) return null;
    let cd = 0, cl = 0, clMin = Infinity, clMax = -Infinity;
    for (const p of h) { cd += p.cd; cl += p.cl; clMin = Math.min(clMin, p.cl); clMax = Math.max(clMax, p.cl); }
    return { cd: cd / h.length, cl: cl / h.length, clAmp: (clMax - clMin) / 2, n: h.length };
  }
  /** Macroscopic fields on the interior grid (nx * ny), rho / ux / uy in lattice units. */
  fields(out) {
    const { NX, N } = this, { nx, ny } = this.cs, f = this.f;
    const n = nx * ny;
    out = out || { rho: new Float32Array(n), ux: new Float32Array(n), uy: new Float32Array(n) };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j + 1) * NX + i + 1, o = j * nx + i;
      if (this.wall[k]) { out.rho[o] = 1; out.ux[o] = 0; out.uy[o] = 0; continue; }
      let r = 0, mx = 0, my = 0;
      for (let q = 0; q < 9; q++) { const v = f[q * N + k]; r += v; mx += v * CX[q]; my += v * CY[q]; }
      out.rho[o] = r; out.ux[o] = mx / r; out.uy[o] = my / r;
    }
    return out;
  }
  /** Lattice-unit coefficients to physical forces per metre of span. */
  physical(c) {
    const { fluid, speed, refLength } = this.cs;
    const q = 0.5 * fluid.rho * speed * speed * refLength * 1e-3;
    return { drag: c.cd * q, lift: c.cl * q };
  }
}

// ---------------------------------------------------------------- inviscid reference
/**
 * Hess-Smith panel method (constant-strength sources + one vortex, Kutta condition at the
 * trailing edge) for a single closed section. The trailing edge is the vertex farthest from
 * the leading edge (the leftmost point). Gives the inviscid lift coefficient at the design
 * angle: what the section does at high Reynolds number with attached flow, as a reference
 * next to the lattice Boltzmann result. Returns { cl, chord } or null.
 */
export function panelMethod(loop, alphaDeg = 0) {
  let P = loop.map((p) => [p[0], p[1]]);
  // drop consecutive duplicates
  P = P.filter((p, i) => { const q = P[(i + 1) % P.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9; });
  const N = P.length;
  if (N < 8 || N > 2000) return null;
  // clockwise, starting at the trailing edge (rightmost-from-leading-edge vertex)
  let A = 0;
  for (let i = 0; i < N; i++) { const p = P[i], q = P[(i + 1) % N]; A += p[0] * q[1] - q[0] * p[1]; }
  if (A > 0) P.reverse();
  let le = 0;
  for (let i = 1; i < N; i++) if (P[i][0] < P[le][0]) le = i;
  let te = 0, best = -1;
  for (let i = 0; i < N; i++) { const d = Math.hypot(P[i][0] - P[le][0], P[i][1] - P[le][1]); if (d > best) { best = d; te = i; } }
  P = [...P.slice(te), ...P.slice(0, te)];
  const chord = best;
  const X = P.map((p) => p[0]), Y = P.map((p) => p[1]);
  X.push(X[0]); Y.push(Y[0]);
  const xc = [], yc = [], th = [], S = [];
  for (let j = 0; j < N; j++) { xc.push((X[j] + X[j + 1]) / 2); yc.push((Y[j] + Y[j + 1]) / 2); th.push(Math.atan2(Y[j + 1] - Y[j], X[j + 1] - X[j])); S.push(Math.hypot(X[j + 1] - X[j], Y[j + 1] - Y[j])); }
  const al = (alphaDeg * Math.PI) / 180;
  const M = Array.from({ length: N + 1 }, () => new Float64Array(N + 2)); // augmented
  const lnR = (i, j) => Math.log(Math.hypot(xc[i] - X[j + 1], yc[i] - Y[j + 1]) / Math.hypot(xc[i] - X[j], yc[i] - Y[j]));
  // angle panel j subtends at control point i, positive on the outer (left-hand) side
  const beta = (i, j) => (i === j ? Math.PI : Math.atan2((xc[i] - X[j]) * (yc[i] - Y[j + 1]) - (yc[i] - Y[j]) * (xc[i] - X[j + 1]), (xc[i] - X[j + 1]) * (xc[i] - X[j]) + (yc[i] - Y[j + 1]) * (yc[i] - Y[j])));
  // tangential-velocity coefficients for the Kutta row
  const Bt = (i) => {
    const row = new Float64Array(N + 1);
    for (let j = 0; j < N; j++) {
      const d = th[i] - th[j], L = i === j ? 0 : lnR(i, j), b = beta(i, j);
      row[j] = (Math.sin(d) * b - Math.cos(d) * L) / (2 * Math.PI);
      row[N] += (Math.sin(d) * L + Math.cos(d) * b) / (2 * Math.PI);
    }
    return row;
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const d = th[i] - th[j], L = i === j ? 0 : lnR(i, j), b = beta(i, j);
      M[i][j] = (Math.sin(d) * L + Math.cos(d) * b) / (2 * Math.PI);
      M[i][N] += (Math.cos(d) * L - Math.sin(d) * b) / (2 * Math.PI);
    }
    M[i][N + 1] = Math.sin(th[i] - al);
  }
  const r1 = Bt(0), rN = Bt(N - 1);
  for (let j = 0; j <= N; j++) M[N][j] = r1[j] + rN[j];
  M[N][N + 1] = -(Math.cos(th[0] - al) + Math.cos(th[N - 1] - al));
  // Gaussian elimination with partial pivoting
  const n = N + 1;
  for (let c = 0; c < n; c++) {
    let pr = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pr][c])) pr = r;
    if (Math.abs(M[pr][c]) < 1e-14) return null;
    [M[c], M[pr]] = [M[pr], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const sol = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * sol[k]; sol[r] = s / M[r][r]; }
  const gamma = sol[N];
  const perim = S.reduce((a, b) => a + b, 0);
  return { cl: (2 * gamma * perim) / chord, chord };
}
