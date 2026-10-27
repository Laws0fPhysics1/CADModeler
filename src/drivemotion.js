// Chains and belts in motion. A chain isn't a rigid body, so instead of an assembly matrix the viewport
// moves its parts along the loop: each link's rollers, pins and plates (or each belt tooth) shift by the
// number of pitches their wheel has turned (one pitch per tooth). The B-rep is untouched; only the display
// mesh and its edge lines are rewritten from a saved copy.
import * as CH from "./chains.js";

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Vertex indices of each part (consecutive runs of faces / edges), or null when the counts don't fit the pattern. */
function partsOf(bv, g) {
  const nF = bv.faceGroups.length, nE = bv.edgeGroups.length;
  let faceRuns, edgeRuns;
  if (g.kind === "chain") {
    const n = g.layout.rollers.length, c = CH.chainPartCounts(g.chain);
    const per = [c.roller, c.pin, c.plate, c.plate];
    if (n * per.reduce((s, x) => s + x[0], 0) !== nF || n * per.reduce((s, x) => s + x[1], 0) !== nE) return null;
    faceRuns = []; edgeRuns = [];
    for (let i = 0; i < n; i++) for (const [f, e] of per) { faceRuns.push(f); edgeRuns.push(e); }
  } else {
    const n = g.layout.teeth.length, bandF = nF - 3 * n, bandE = nE - 3 * n;
    if (bandF < 1 || bandE < 1) return null;
    faceRuns = [bandF, ...Array(n).fill(3)]; edgeRuns = [bandE, ...Array(n).fill(3)];
  }
  const tri = bv.mesh_.faces.triangles, parts = [];
  let f = 0, e = 0;
  for (let k = 0; k < faceRuns.length; k++) {
    const vs = new Set();
    for (let q = f; q < f + faceRuns[k]; q++) { const gr = bv.faceGroups[q]; for (let t = gr.start; t < gr.start + gr.count; t++) vs.add(tri[t]); }
    const ls = [];
    for (let q = e; q < e + edgeRuns[k]; q++) { const gr = bv.edgeGroups[q]; for (let v = gr.start; v < gr.start + gr.count; v++) ls.push(v); }
    parts.push({ verts: Int32Array.from(vs), lines: Int32Array.from(ls) });
    f += faceRuns[k]; e += edgeRuns[k];
  }
  return parts;
}

/** Move one chain / belt body's display mesh to `shift` pitches along its loop. */
function place(bv, g, shift) {
  if (!bv.drive) {
    const parts = partsOf(bv, g);
    if (!parts) { bv.drive = { off: true }; return; }
    const pos = bv.mesh.geometry.getAttribute("position"), lin = bv.lines.geometry.getAttribute("position");
    bv.drive = { parts, base: Float32Array.from(pos.array), baseL: Float32Array.from(lin.array), shift: 0 };
  }
  const D = bv.drive;
  if (D.off || Math.abs(D.shift - shift) < 1e-9) return;
  D.shift = shift;
  const fr = g.frame, X = fr.xDir, Z = fr.normal, Y = cross3(Z, X), O = fr.origin;
  // a 2D rigid motion in the loop's plane, applied to world-space vertices
  const move = (src, dst, idx, T) => {
    for (const i of idx) {
      const x = src[3 * i] - O[0], y = src[3 * i + 1] - O[1], z = src[3 * i + 2] - O[2];
      const u = x * X[0] + y * X[1] + z * X[2], v = x * Y[0] + y * Y[1] + z * Y[2];
      const [u2, v2] = T(u, v), du = u2 - u, dv = v2 - v;
      dst[3 * i] = src[3 * i] + du * X[0] + dv * Y[0];
      dst[3 * i + 1] = src[3 * i + 1] + du * X[1] + dv * Y[1];
      dst[3 * i + 2] = src[3 * i + 2] + du * X[2] + dv * Y[2];
    }
  };
  // the layout is in frame (u, v) coordinates already
  const translate = (d) => (u, v) => [u + d[0], v + d[1]];
  const rigid = (a, b, A, B) => {
    const th = Math.atan2(B[1] - A[1], B[0] - A[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(th), s = Math.sin(th);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    return (u, v) => { const x = u - m[0], y = v - m[1]; return [M[0] + c * x - s * y, M[1] + s * x + c * y]; };
  };
  const pos = bv.mesh.geometry.getAttribute("position"), lin = bv.lines.geometry.getAttribute("position");
  if (g.kind === "chain") {
    const R = g.layout.rollers, n = R.length;
    for (let i = 0; i < n; i++) {
      const a = R[i], b = R[(i + 1) % n], A = CH.chainPoint(R, i + shift, g.layout.wheels), B = CH.chainPoint(R, i + 1 + shift, g.layout.wheels);
      const t = translate([A[0] - a[0], A[1] - a[1]]), r = rigid(a, b, A, B);
      for (let k = 0; k < 4; k++) {
        const part = D.parts[4 * i + k], T = k < 2 ? t : r; // roller, pin translate; plates turn with the link
        move(D.base, pos.array, part.verts, T); move(D.baseL, lin.array, part.lines, T);
      }
    }
  } else {
    const L = g.layout, path = CH.beltPath(L), teeth = L.teeth;
    for (let j = 0; j < teeth.length; j++) {
      const r = path.at((j + shift) * L.p), q = [r.q[0] + r.inward[0] * L.dIn, r.q[1] + r.inward[1] * L.dIn];
      const T = translate([q[0] - teeth[j][0], q[1] - teeth[j][1]]);
      move(D.base, pos.array, D.parts[1 + j].verts, T); move(D.baseL, lin.array, D.parts[1 + j].lines, T);
    }
  }
  pos.needsUpdate = true; lin.needsUpdate = true;
}

/**
 * Update every chain / belt in the viewport. wheelAngle(bodyId) -> degrees the wheel body has turned
 * (its axle joint's value). A loop moves one pitch per tooth of its wheel, in the wheels' turning direction.
 */
export function updateLoops(vp, state, wheelAngle) {
  if (!vp || !state) return;
  let any = false;
  for (const b of state.bodies) {
    const g = b.gear;
    if (!g || (g.kind !== "chain" && g.kind !== "belt") || !g.wheel) continue;
    const bv = vp.bodyViews.find((v) => v.id === b.id);
    if (!bv) continue;
    const wheel = state.bodies.find((x) => x.gear && x.gear.feature === g.feature && x.gear.index === g.wheel.index);
    const theta = wheel ? +wheelAngle(wheel.id) || 0 : 0;
    // the loops are laid out clockwise; a wheel turning counter-clockwise (+) carries them the other way
    place(bv, g, (-theta * (g.wheel.teeth || (wheel && wheel.gear.teeth) || 1)) / 360);
    any = true;
  }
  if (any) vp.requestRender();
}
