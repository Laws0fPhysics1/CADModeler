// Shape optimization (generative design, first version). DOM-free: runs in topo.worker.js
// and in Node tests.
//
// The body is voxelised into cubes (8-node hex elements). Faces picked as fixtures and loads
// become "preserved" regions that are always kept. SIMP topology optimisation (density
// filter, optimality-criteria update) then removes material step by step: each iteration
// lowers the allowed volume a little ("shaving"), re-solves the static stiffness problem
// with a matrix-free Jacobi-preconditioned CG, and checks stress. In safety-factor mode it
// stops shaving once the stress in the remaining material reaches yield / SF and settles the
// design there; in mass mode it shaves down to the target mass. Units: mm, N, MPa.

// ---------------------------------------------------------------- voxelisation
/**
 * mesh: { vertices: flat xyz, triangles: flat indices } (closed, in mm). Returns
 * { nx, ny, nz, h, origin, solid: Uint8Array(nx*ny*nz) } with element (i,j,k) at index i + nx*(j + ny*k).
 */
export function voxelize(mesh, h, pad = 0) {
  const V = mesh.vertices, T = mesh.triangles;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < V.length; i += 3) {
    x0 = Math.min(x0, V[i]); x1 = Math.max(x1, V[i]); y0 = Math.min(y0, V[i + 1]); y1 = Math.max(y1, V[i + 1]); z0 = Math.min(z0, V[i + 2]); z1 = Math.max(z1, V[i + 2]);
  }
  const nx = Math.max(1, Math.round((x1 - x0) / h)) + 2 * pad, ny = Math.max(1, Math.round((y1 - y0) / h)) + 2 * pad, nz = Math.max(1, Math.round((z1 - z0) / h)) + 2 * pad;
  // centre the grid on the box so rounding is shared by both sides
  const origin = [(x0 + x1) / 2 - (nx * h) / 2, (y0 + y1) / 2 - (ny * h) / 2, (z0 + z1) / 2 - (nz * h) / 2];
  const solid = new Uint8Array(nx * ny * nz);
  // bin triangles by the columns their xy box covers, then cast a +z ray up each column centre
  const cols = new Map();
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    const tx0 = Math.min(V[a], V[b], V[c]), tx1 = Math.max(V[a], V[b], V[c]), ty0 = Math.min(V[a + 1], V[b + 1], V[c + 1]), ty1 = Math.max(V[a + 1], V[b + 1], V[c + 1]);
    const i0 = Math.max(0, Math.floor((tx0 - origin[0]) / h - 0.5)), i1 = Math.min(nx - 1, Math.ceil((tx1 - origin[0]) / h - 0.5));
    const j0 = Math.max(0, Math.floor((ty0 - origin[1]) / h - 0.5)), j1 = Math.min(ny - 1, Math.ceil((ty1 - origin[1]) / h - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = i + nx * j; let l = cols.get(k); if (!l) cols.set(k, (l = [])); l.push(t); }
  }
  const zs = [];
  for (const [col, tris] of cols) {
    const i = col % nx, j = (col - i) / nx;
    // nudge the ray off the grid lines so it never runs exactly along a mesh edge
    const px = origin[0] + (i + 0.5) * h + h * 1.37e-4, py = origin[1] + (j + 0.5) * h + h * 2.11e-4;
    zs.length = 0;
    for (const t of tris) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ax = V[a] - px, ay = V[a + 1] - py, bx = V[b] - px, by = V[b + 1] - py, cx = V[c] - px, cy = V[c + 1] - py;
      const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(d) < 1e-14) continue;
      const w0 = (bx * cy - by * cx) / d, w1 = (cx * ay - cy * ax) / d, w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      zs.push(w0 * V[a + 2] + w1 * V[b + 2] + w2 * V[c + 2]);
    }
    if (zs.length < 2) continue;
    zs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < zs.length; s += 2) {
      const k0 = Math.max(0, Math.ceil((zs[s] - origin[2]) / h - 0.5)), k1 = Math.min(nz - 1, Math.floor((zs[s + 1] - origin[2]) / h - 0.5));
      for (let k = k0; k <= k1; k++) solid[i + nx * (j + ny * k)] = 1;
    }
  }
  return { nx, ny, nz, h, origin, solid };
}

/**
 * Elements touched by the given triangles (a face's tessellation): points sampled over each
 * triangle are pushed half a voxel inside along the triangle normal and snapped to a solid voxel.
 */
export function markTriangles(mesh, triStarts, vox) {
  const { nx, ny, nz, h, origin, solid } = vox, V = mesh.vertices, T = mesh.triangles;
  const mark = new Uint8Array(solid.length);
  const elemAt = (x, y, z) => {
    const i = Math.floor((x - origin[0]) / h), j = Math.floor((y - origin[1]) / h), k = Math.floor((z - origin[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    const e = i + nx * (j + ny * k);
    return solid[e] ? e : -1;
  };
  for (const [start, count] of triStarts) {
    for (let t = start; t < start + count; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const A = [V[a], V[a + 1], V[a + 2]], B = [V[b], V[b + 1], V[b + 2]], C = [V[c], V[c + 1], V[c + 2]];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const nl = Math.hypot(...n) || 1; n = n.map((x) => x / nl);
      const len = Math.max(Math.hypot(...u), Math.hypot(...v), Math.hypot(C[0] - B[0], C[1] - B[1], C[2] - B[2]));
      const m = Math.max(1, Math.ceil((2 * len) / h));
      for (let p = 0; p <= m; p++) for (let q = 0; q <= m - p; q++) {
        const s = p / m, r = q / m;
        const x = A[0] + s * u[0] + r * v[0], y = A[1] + s * u[1] + r * v[1], z = A[2] + s * u[2] + r * v[2];
        let e = elemAt(x - n[0] * 0.5 * h, y - n[1] * 0.5 * h, z - n[2] * 0.5 * h);
        if (e < 0) e = elemAt(x + n[0] * 0.5 * h, y + n[1] * 0.5 * h, z + n[2] * 0.5 * h);
        if (e < 0) e = elemAt(x, y, z);
        if (e >= 0) mark[e] = 1;
      }
    }
  }
  return mark;
}

// ---------------------------------------------------------------- element
const NODE = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
const NODE_OFF = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
/** Isotropic elasticity matrix (Voigt: xx, yy, zz, xy, yz, zx) for E = 1. */
function Dmat(nu) {
  const c = 1 / ((1 + nu) * (1 - 2 * nu)), D = new Float64Array(36);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i * 6 + j] = c * (i === j ? 1 - nu : nu);
  for (let i = 3; i < 6; i++) D[i * 6 + i] = c * (1 - 2 * nu) / 2;
  return D;
}
/** Strain-displacement matrix (6x24) at natural coords for a cube of side h. */
function Bmat(xi, eta, zeta, h) {
  const B = new Float64Array(6 * 24);
  for (let a = 0; a < 8; a++) {
    const [p, q, r] = NODE[a];
    // dN/dx = dN/dxi * 2/h
    const dx = (p * (1 + q * eta) * (1 + r * zeta)) / 8 * (2 / h);
    const dy = (q * (1 + p * xi) * (1 + r * zeta)) / 8 * (2 / h);
    const dz = (r * (1 + p * xi) * (1 + q * eta)) / 8 * (2 / h);
    const c = 3 * a;
    B[0 * 24 + c] = dx; B[1 * 24 + c + 1] = dy; B[2 * 24 + c + 2] = dz;
    B[3 * 24 + c] = dy; B[3 * 24 + c + 1] = dx;
    B[4 * 24 + c + 1] = dz; B[4 * 24 + c + 2] = dy;
    B[5 * 24 + c] = dz; B[5 * 24 + c + 2] = dx;
  }
  return B;
}
/** 24x24 stiffness of a cube of side h with E = 1 (2x2x2 Gauss). */
export function hexKE(nu, h = 1) {
  const D = Dmat(nu), KE = new Float64Array(576), g = 1 / Math.sqrt(3), detJ = (h / 2) ** 3;
  const DB = new Float64Array(6 * 24);
  for (const xi of [-g, g]) for (const eta of [-g, g]) for (const zeta of [-g, g]) {
    const B = Bmat(xi, eta, zeta, h);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += D[i * 6 + k] * B[k * 24 + j]; DB[i * 24 + j] = s; }
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) { let s = 0; for (let k = 0; k < 6; k++) s += B[k * 24 + i] * DB[k * 24 + j]; KE[i * 24 + j] += s * detJ; }
  }
  return KE;
}

// ---------------------------------------------------------------- problem
/**
 * setup: { vox, fixed: Uint8Array (elements whose nodes are clamped), loads: [{ mark: Uint8Array, force: [Fx,Fy,Fz] }],
 *          preserve: Uint8Array (elements always kept), E (MPa), nu, yield (MPa), density (kg/m^3) }
 */
export class TopoProblem {
  constructor(setup) {
    const { vox } = setup;
    this.s = setup;
    const { nx, ny, nz, solid } = vox;
    const elems = [];
    for (let e = 0; e < solid.length; e++) if (solid[e]) elems.push(e);
    this.elems = Int32Array.from(elems);
    const ne = (this.ne = elems.length);
    if (!ne) throw new Error("The body didn't voxelise (is it a closed solid?)");
    const NX = nx + 1, NY = ny + 1;
    const nodeId = new Int32Array(NX * NY * (nz + 1)).fill(-1);
    const conn = new Int32Array(ne * 8);
    let nn = 0;
    for (let q = 0; q < ne; q++) {
      const e = elems[q], i = e % nx, j = ((e - i) / nx) % ny, k = (e - i - nx * j) / (nx * ny);
      for (let a = 0; a < 8; a++) {
        const [di, dj, dk] = NODE_OFF[a];
        const g = i + di + NX * (j + dj + NY * (k + dk));
        if (nodeId[g] < 0) nodeId[g] = nn++;
        conn[q * 8 + a] = nodeId[g];
      }
    }
    this.nn = nn; this.conn = conn; this.nodeId = nodeId;
    // clamp every node of the fixture elements
    const fixedNode = new Uint8Array(nn);
    let nFixed = 0;
    for (let q = 0; q < ne; q++) if (setup.fixed[elems[q]]) for (let a = 0; a < 8; a++) { const n = conn[q * 8 + a]; if (!fixedNode[n]) { fixedNode[n] = 1; nFixed++; } }
    if (!nFixed) throw new Error("No fixed region: pick the faces that hold the part");
    const dofOf = new Int32Array(nn).fill(-1);
    let nd = 0;
    for (let n = 0; n < nn; n++) if (!fixedNode[n]) dofOf[n] = nd++;
    this.ndof = nd * 3;
    this.edof = new Int32Array(ne * 24);
    for (let q = 0; q < ne; q++) for (let a = 0; a < 8; a++) { const d = dofOf[conn[q * 8 + a]]; for (let c = 0; c < 3; c++) this.edof[q * 24 + 3 * a + c] = d < 0 ? -1 : 3 * d + c; }
    // loads: spread each force evenly over the free nodes of its elements
    this.f = new Float64Array(this.ndof);
    let anyLoad = false;
    for (const L of setup.loads) {
      const nodes = new Set();
      for (let q = 0; q < ne; q++) if (L.mark[elems[q]]) for (let a = 0; a < 8; a++) { const n = conn[q * 8 + a]; if (dofOf[n] >= 0) nodes.add(n); }
      if (!nodes.size) continue;
      anyLoad = true;
      // K is assembled with E = 1, so divide the load by E to get displacements in mm
      for (const n of nodes) for (let c = 0; c < 3; c++) this.f[3 * dofOf[n] + c] += L.force[c] / nodes.size / setup.E;
    }
    if (!anyLoad) throw new Error("No load reaches free material: pick load faces away from the fixed ones");
    this.KE = hexKE(setup.nu ?? 0.3, vox.h);
    this.D = Dmat(setup.nu ?? 0.3);
    this.B0 = Bmat(0, 0, 0, vox.h);
    this.u = new Float64Array(this.ndof);
    this.preserve = new Uint8Array(ne);
    for (let q = 0; q < ne; q++) if (setup.preserve[elems[q]] || setup.fixed[elems[q]]) this.preserve[q] = 1;
    for (const L of setup.loads) for (let q = 0; q < ne; q++) if (L.mark[elems[q]]) this.preserve[q] = 1;
    this.buildFilter(setup.rmin ?? 1.6);
  }
  // density filter over neighbours within rmin voxels (weights rmin - distance)
  buildFilter(rmin) {
    const { nx, ny, nz } = this.s.vox, ne = this.ne, elems = this.elems;
    const index = new Int32Array(nx * ny * nz).fill(-1);
    for (let q = 0; q < ne; q++) index[elems[q]] = q;
    const R = Math.ceil(rmin) - 1;
    const start = new Int32Array(ne + 1), nbr = [], w = [];
    for (let q = 0; q < ne; q++) {
      const e = elems[q], i = e % nx, j = ((e - i) / nx) % ny, k = (e - i - nx * j) / (nx * ny);
      for (let dk = -R; dk <= R; dk++) for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const ii = i + di, jj = j + dj, kk = k + dk;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const p = index[ii + nx * (jj + ny * kk)];
        if (p < 0) continue;
        const wt = rmin - Math.hypot(di, dj, dk);
        if (wt > 0) { nbr.push(p); w.push(wt); }
      }
      start[q + 1] = nbr.length;
    }
    this.fStart = start; this.fNbr = Int32Array.from(nbr); this.fW = Float64Array.from(w);
    this.fSum = new Float64Array(ne);
    for (let q = 0; q < ne; q++) for (let k = start[q]; k < start[q + 1]; k++) this.fSum[q] += this.fW[k];
  }
  filter(x, out) {
    for (let q = 0; q < this.ne; q++) { let s = 0; for (let k = this.fStart[q]; k < this.fStart[q + 1]; k++) s += this.fW[k] * x[this.fNbr[k]]; out[q] = s / this.fSum[q]; }
    return out;
  }
  filterT(g, out) { // adjoint of filter (the weights are symmetric)
    out.fill(0);
    for (let q = 0; q < this.ne; q++) { const gq = g[q] / this.fSum[q]; for (let k = this.fStart[q]; k < this.fStart[q + 1]; k++) out[this.fNbr[k]] += this.fW[k] * gq; }
    return out;
  }
  matvec(Ee, x, y) {
    const { ne, edof, KE } = this, xe = new Float64Array(24);
    y.fill(0);
    for (let q = 0; q < ne; q++) {
      const s = Ee[q], o = q * 24;
      for (let a = 0; a < 24; a++) { const d = edof[o + a]; xe[a] = d < 0 ? 0 : x[d]; }
      for (let a = 0; a < 24; a++) {
        const d = edof[o + a];
        if (d < 0) continue;
        let sum = 0;
        const r = a * 24;
        for (let b = 0; b < 24; b++) sum += KE[r + b] * xe[b];
        y[d] += s * sum;
      }
    }
  }
  /** Solve K(Ee) u = f by Jacobi-preconditioned CG, warm-started from the last solution. */
  solve(Ee, { tol = 1e-5, maxIt = 2000 } = {}) {
    const n = this.ndof, { ne, edof, KE, f } = this, u = this.u;
    const diag = new Float64Array(n);
    for (let q = 0; q < ne; q++) for (let a = 0; a < 24; a++) { const d = edof[q * 24 + a]; if (d >= 0) diag[d] += Ee[q] * KE[a * 25]; }
    const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    this.matvec(Ee, u, Ap);
    let fn = 0;
    for (let i = 0; i < n; i++) { r[i] = f[i] - Ap[i]; fn += f[i] * f[i]; }
    fn = Math.sqrt(fn) || 1;
    let rz = 0;
    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; rz += r[i] * z[i]; }
    let it = 0, res = 1;
    for (; it < maxIt; it++) {
      let rn = 0;
      for (let i = 0; i < n; i++) rn += r[i] * r[i];
      res = Math.sqrt(rn) / fn;
      if (res < tol) break;
      this.matvec(Ee, p, Ap);
      let pAp = 0;
      for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
      const alpha = rz / pAp;
      let rz2 = 0;
      for (let i = 0; i < n; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; z[i] = r[i] / diag[i]; rz2 += r[i] * z[i]; }
      const beta = rz2 / rz;
      rz = rz2;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    this.lastIt = it; this.lastRes = res;
    return u;
  }
  /** Per-element strain energy u_e^T KE u_e (for E = 1). */
  elementEnergy(out) {
    const { ne, edof, KE, u } = this, ue = new Float64Array(24);
    for (let q = 0; q < ne; q++) {
      for (let a = 0; a < 24; a++) { const d = edof[q * 24 + a]; ue[a] = d < 0 ? 0 : u[d]; }
      let s = 0;
      for (let a = 0; a < 24; a++) { let t = 0; for (let b = 0; b < 24; b++) t += KE[a * 24 + b] * ue[b]; s += ue[a] * t; }
      out[q] = s;
    }
    return out;
  }
  /** Element-centre von Mises stress (MPa) if the element were full material. */
  vonMises(out) {
    const { ne, edof, u, D, B0 } = this, E0 = this.s.E, ue = new Float64Array(24), eps = new Float64Array(6), sg = new Float64Array(6);
    for (let q = 0; q < ne; q++) {
      for (let a = 0; a < 24; a++) { const d = edof[q * 24 + a]; ue[a] = d < 0 ? 0 : u[d]; }
      for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 24; j++) s += B0[i * 24 + j] * ue[j]; eps[i] = s; }
      for (let i = 0; i < 6; i++) { let s = 0; for (let j = 0; j < 6; j++) s += D[i * 6 + j] * eps[j]; sg[i] = E0 * s; }
      out[q] = Math.sqrt(0.5 * ((sg[0] - sg[1]) ** 2 + (sg[1] - sg[2]) ** 2 + (sg[2] - sg[0]) ** 2) + 3 * (sg[3] ** 2 + sg[4] ** 2 + sg[5] ** 2));
    }
    return out;
  }
}

const percentile = (vals, p) => {
  if (!vals.length) return 0;
  const s = Float64Array.from(vals).sort();
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};

/**
 * Run the optimisation. opts: { mode: "sf" | "mass", sf, targetMass (fraction 0-1), step (volume
 * removed per iteration), minVolume, maxIter, penal, onIter(info) -> false to stop }.
 * info: { it, phase, volume, compliance, stress, stressMax, sf, change, rho (Float32Array, per problem element), cgIt }
 */
export function optimize(P, opts = {}) {
  let last = null;
  for (const info of optimizeSteps(P, opts)) { last = info; if (opts.onIter && opts.onIter(info) === false) break; }
  return last;
}
/** The same optimisation as a generator, one yield per iteration (the worker uses this so Stop gets through). */
export function* optimizeSteps(P, opts = {}) {
  const ne = P.ne, penal = opts.penal ?? 3, Emin = 1e-4;
  const mode = opts.mode || "sf", SF = opts.sf ?? 2, yieldS = P.s.yield || 250;
  const allow = yieldS / SF;
  let step = opts.step ?? 0.03;
  const floor = Math.max(0.03, mode === "mass" ? opts.targetMass ?? 0.3 : opts.minVolume ?? 0.05);
  const maxIter = opts.maxIter ?? 140;
  const x = new Float64Array(ne).fill(1), xPhys = new Float64Array(ne).fill(1), xNew = new Float64Array(ne);
  const Ee = new Float64Array(ne), dc = new Float64Array(ne), dcF = new Float64Array(ne), dv = new Float64Array(ne), dvF = new Float64Array(ne);
  const ce = new Float64Array(ne), vm = new Float64Array(ne);
  const nPres = P.preserve.reduce((s, v) => s + v, 0);
  let target = 1, phase = "shaving", settle = 0, lastFeasible = null, info = null;
  const stressOf = () => {
    P.vonMises(vm);
    const vals = [];
    let mx = 0;
    for (let q = 0; q < ne; q++) if (xPhys[q] > 0.5) { vals.push(vm[q]); if (!P.preserve[q]) mx = Math.max(mx, vm[q]); }
    return { p99: percentile(vals, 0.99), max: Math.max(mx, percentile(vals, 1)) };
  };
  for (let it = 1; it <= maxIter; it++) {
    for (let q = 0; q < ne; q++) Ee[q] = Emin + Math.pow(xPhys[q], penal) * (1 - Emin);
    P.solve(Ee, { tol: opts.tol ?? 1e-4, maxIt: opts.cgMax ?? 1500 });
    P.elementEnergy(ce);
    let c = 0, vol = 0;
    for (let q = 0; q < ne; q++) { c += Ee[q] * ce[q] * P.s.E; dc[q] = -penal * Math.pow(xPhys[q], penal - 1) * (1 - Emin) * ce[q]; dv[q] = 1; vol += xPhys[q]; }
    vol /= ne;
    const S = stressOf();
    const feasible = S.p99 <= allow;
    info = { it, phase, volume: vol, target, compliance: c, stress: S.p99, stressMax: S.max, sf: yieldS / Math.max(S.p99, 1e-12), allow, cgIt: P.lastIt, cgRes: P.lastRes, rho: Float32Array.from(xPhys), feasible };
    // schedule: keep lowering the volume while the stress allows it, then settle
    if (phase === "shaving") {
      if (mode === "sf" && !feasible && it > 1) {
        // went one step too far: go back to the last feasible volume and converge there
        target = lastFeasible != null ? Math.min(1, lastFeasible + step * 0.5) : Math.min(1, target + step);
        phase = "settling"; settle = 0;
      } else {
        if (feasible) lastFeasible = vol;
        if (target <= floor + 1e-9) { phase = "settling"; settle = 0; }
        else target = Math.max(floor, target - step);
      }
    } else settle++;
    info.phase = phase;
    // sensitivities through the filter, then the optimality-criteria update
    P.filterT(dc, dcF); P.filterT(dv, dvF);
    let l1 = 0, l2 = 1e9, change = 0;
    const move = 0.15;
    while ((l2 - l1) / (l1 + l2) > 1e-4) {
      const lm = 0.5 * (l1 + l2);
      let s = 0;
      for (let q = 0; q < ne; q++) {
        let v;
        if (P.preserve[q]) v = 1;
        else {
          const B = Math.sqrt(Math.max(0, -dcF[q]) / (dvF[q] * lm));
          v = Math.max(0, Math.max(x[q] - move, Math.min(1, Math.min(x[q] + move, x[q] * B))));
        }
        xNew[q] = v;
      }
      P.filter(xNew, xPhys);
      for (let q = 0; q < ne; q++) s += P.preserve[q] ? 1 : xPhys[q];
      if (s > target * ne) l1 = lm; else l2 = lm;
    }
    for (let q = 0; q < ne; q++) { change = Math.max(change, Math.abs(xNew[q] - x[q])); x[q] = xNew[q]; }
    for (let q = 0; q < ne; q++) if (P.preserve[q]) xPhys[q] = 1;
    info.change = change;
    info.preserved = nPres / ne;
    yield info;
    if (phase === "settling" && ((settle >= 6 && change < 0.02) || settle >= 30)) {
      // landed well above the safety factor (the stress check during shaving is on a design that
      // hasn't caught up yet): shave again from here in half-size steps
      if (mode === "sf" && feasible && info.sf > SF * 1.12 && step > 0.006 && target > floor + 1e-9) {
        step /= 2; lastFeasible = vol; target = Math.max(floor, target - step); phase = "shaving";
        continue;
      }
      break;
    }
  }
  return info;
}

// ---------------------------------------------------------------- surface
/**
 * Surface nets over the element-centre density field (padded with empty space so the surface
 * closes). Returns { positions: Float32Array, indices: Uint32Array } in mm.
 */
export function densitySurface(vox, elems, rho, iso = 0.5, smooth = 2) {
  const { nx, ny, nz, h, origin } = vox;
  const X = nx + 2, Y = ny + 2, Z = nz + 2;
  const F = new Float32Array(X * Y * Z);
  for (let q = 0; q < elems.length; q++) {
    const e = elems[q], i = e % nx, j = ((e - i) / nx) % ny, k = (e - i - nx * j) / (nx * ny);
    F[i + 1 + X * (j + 1 + Y * (k + 1))] = rho[q];
  }
  const at = (i, j, k) => F[i + X * (j + Y * k)];
  // one vertex per dual cell (cube of 8 centres) that the iso-surface crosses
  const vid = new Int32Array((X - 1) * (Y - 1) * (Z - 1)).fill(-1);
  const pos = [];
  const C = (i, j, k) => i + (X - 1) * (j + (Y - 1) * k);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const v = new Float32Array(8);
  for (let k = 0; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { v[c] = at(i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2]); if (v[c] > iso) inside++; }
    if (!inside || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      if ((v[a] > iso) === (v[b] > iso)) continue;
      const t = (iso - v[a]) / (v[b] - v[a]);
      sx += CORNER[a][0] + t * (CORNER[b][0] - CORNER[a][0]); sy += CORNER[a][1] + t * (CORNER[b][1] - CORNER[a][1]); sz += CORNER[a][2] + t * (CORNER[b][2] - CORNER[a][2]);
      n++;
    }
    vid[C(i, j, k)] = pos.length / 3;
    // centre of element (i-1) sits at origin + (i - 1 + 0.5) h
    pos.push(origin[0] + (i - 0.5 + sx / n) * h, origin[1] + (j - 0.5 + sy / n) * h, origin[2] + (k - 0.5 + sz / n) * h);
  }
  const idx = [];
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d); };
  // each centre-to-centre edge that crosses the surface makes a quad from the 4 dual cells around it,
  // wound so its normal points from inside to outside
  for (let k = 0; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
    const s0 = at(i, j, k) > iso;
    if (j >= 1 && k >= 1 && s0 !== at(i + 1, j, k) > iso) quad(vid[C(i, j - 1, k - 1)], vid[C(i, j, k - 1)], vid[C(i, j, k)], vid[C(i, j - 1, k)], !s0);
    if (i >= 1 && k >= 1 && s0 !== at(i, j + 1, k) > iso) quad(vid[C(i - 1, j, k - 1)], vid[C(i - 1, j, k)], vid[C(i, j, k)], vid[C(i, j, k - 1)], !s0);
    if (i >= 1 && j >= 1 && s0 !== at(i, j, k + 1) > iso) quad(vid[C(i - 1, j - 1, k)], vid[C(i, j - 1, k)], vid[C(i, j, k)], vid[C(i - 1, j, k)], !s0);
  }
  const positions = Float32Array.from(pos), indices = Uint32Array.from(idx);
  // light Laplacian smoothing (vertices only move toward neighbours, the topology stays)
  if (smooth > 0 && indices.length) {
    const nv = positions.length / 3, nb = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) { const a = indices[t + e], b = indices[t + ((e + 1) % 3)]; nb[a].add(b); nb[b].add(a); }
    const tmp = new Float32Array(positions.length);
    // Taubin smoothing: alternate shrink / inflate passes so the part keeps its size
    for (let s = 0; s < 2 * smooth; s++) {
      const w = s % 2 ? -0.53 : 0.5;
      for (let a = 0; a < nv; a++) {
        let x = 0, y = 0, z = 0;
        for (const b of nb[a]) { x += positions[3 * b]; y += positions[3 * b + 1]; z += positions[3 * b + 2]; }
        const m = nb[a].size || 1;
        tmp[3 * a] = positions[3 * a] * (1 - w) + (x / m) * w; tmp[3 * a + 1] = positions[3 * a + 1] * (1 - w) + (y / m) * w; tmp[3 * a + 2] = positions[3 * a + 2] * (1 - w) + (z / m) * w;
      }
      positions.set(tmp);
    }
  }
  return { positions, indices };
}

/** Binary STL bytes for a triangle mesh (normals from the winding). */
export function meshToSTL(positions, indices, header = "CAD Modeler shape optimization") {
  const nt = indices.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) & 0x7f : 32);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = 3 * indices[3 * t], b = 3 * indices[3 * t + 1], c = 3 * indices[3 * t + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, positions[p + k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

/** Pick a voxel size giving about `target` solid elements for a body of the given volume (mm^3). */
export function voxelSizeFor(volume, target) { return Math.cbrt(volume / Math.max(100, target)); }
export const RESOLUTIONS = { coarse: 4000, medium: 9000, fine: 20000 };
