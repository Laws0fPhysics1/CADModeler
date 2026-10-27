// Parametric ISO metric fasteners: bolts, screws, set screws, nuts, washers and threaded rod.
// DOM-free (runs in Node for tests). kernel.js places the result; this file only builds the part
// in its local frame:
//
//   z = 0 is the seating plane (the surface the part sits on), +Z points out of that surface.
//   Bolt / screw heads are on +Z (a countersunk head sits below z = 0, flush at 0) and the shank
//   runs down to z = -length. Nuts and washers sit on z = 0 and stack up along +Z.
//
// Threads are "modeled" (a real helical B-rep, right hand, ISO 68-1 basic profile, built as a
// twisted extrusion of the thread's cross-section) or "cosmetic" (plain cylinder at the major
// diameter; nuts get a minor-diameter hole).
//
// Speed: OCCT booleans against the helical surface take seconds (a tip chamfer by intersection took
// 16 s and failed), so a modeled part is a compound of touching solids (head + thread) rather than a
// fused solid, and only nuts / set screws cut into a thread (about 1 s, then cached). Dimensions are nominal
// values from ISO 4017 / 4762 / 7380 / 10642 / 7045 / 4026 / 4032 / 7089 (rounded, M2 to M24).
import * as R from "replicad";

// d, P (coarse pitch), hex s/k (ISO 4017), cap dk/s/t (ISO 4762), button dk/k/s (ISO 7380),
// flat dk/s (ISO 10642, 90°), pan dk/k (ISO 7045), nut m (ISO 4032), washer d1/d2/h (ISO 7089)
const T = {
  M2:   { d: 2,   P: 0.4,  hexS: 4,   hexK: 1.4,  capDk: 3.8, capS: 1.5, capT: 1.0, btnDk: 3.5,  btnK: 1.1,  btnS: 1.3, flatDk: 4.0,   flatS: 1.3, panDk: 4,   panK: 1.3,  nutM: 1.6,  wD1: 2.2, wD2: 5,  wH: 0.3 },
  "M2.5": { d: 2.5, P: 0.45, hexS: 5, hexK: 1.7,  capDk: 4.5, capS: 2,   capT: 1.1, btnDk: 4.6,  btnK: 1.4,  btnS: 1.5, flatDk: 5.0,   flatS: 1.5, panDk: 5,   panK: 1.5,  nutM: 2.0,  wD1: 2.7, wD2: 6,  wH: 0.5 },
  M3:   { d: 3,   P: 0.5,  hexS: 5.5, hexK: 2,    capDk: 5.5, capS: 2.5, capT: 1.3, btnDk: 5.7,  btnK: 1.65, btnS: 2,   flatDk: 6.72,  flatS: 2,   panDk: 5.6, panK: 1.8,  nutM: 2.4,  wD1: 3.2, wD2: 7,  wH: 0.5 },
  M4:   { d: 4,   P: 0.7,  hexS: 7,   hexK: 2.8,  capDk: 7,   capS: 3,   capT: 2,   btnDk: 7.6,  btnK: 2.2,  btnS: 2.5, flatDk: 8.96,  flatS: 2.5, panDk: 8,   panK: 2.4,  nutM: 3.2,  wD1: 4.3, wD2: 9,  wH: 0.8 },
  M5:   { d: 5,   P: 0.8,  hexS: 8,   hexK: 3.5,  capDk: 8.5, capS: 4,   capT: 2.5, btnDk: 9.5,  btnK: 2.75, btnS: 3,   flatDk: 11.2,  flatS: 3,   panDk: 9.5, panK: 3,    nutM: 4.7,  wD1: 5.3, wD2: 10, wH: 1 },
  M6:   { d: 6,   P: 1,    hexS: 10,  hexK: 4,    capDk: 10,  capS: 5,   capT: 3,   btnDk: 10.5, btnK: 3.3,  btnS: 4,   flatDk: 13.44, flatS: 4,   panDk: 12,  panK: 3.6,  nutM: 5.2,  wD1: 6.4, wD2: 12, wH: 1.6 },
  M8:   { d: 8,   P: 1.25, hexS: 13,  hexK: 5.3,  capDk: 13,  capS: 6,   capT: 4,   btnDk: 14,   btnK: 4.4,  btnS: 5,   flatDk: 17.92, flatS: 5,   panDk: 16,  panK: 4.8,  nutM: 6.8,  wD1: 8.4, wD2: 16, wH: 1.6 },
  M10:  { d: 10,  P: 1.5,  hexS: 16,  hexK: 6.4,  capDk: 16,  capS: 8,   capT: 5,   btnDk: 17.5, btnK: 5.5,  btnS: 6,   flatDk: 22.4,  flatS: 6,   panDk: 20,  panK: 6,    nutM: 8.4,  wD1: 10.5, wD2: 20, wH: 2 },
  M12:  { d: 12,  P: 1.75, hexS: 18,  hexK: 7.5,  capDk: 18,  capS: 10,  capT: 6,   btnDk: 21,   btnK: 6.6,  btnS: 8,   flatDk: 26.88, flatS: 8,   panDk: 24,  panK: 7.2,  nutM: 10.8, wD1: 13, wD2: 24, wH: 2.5 },
  M14:  { d: 14,  P: 2,    hexS: 21,  hexK: 8.8,  capDk: 21,  capS: 12,  capT: 7,   btnDk: 24,   btnK: 7.7,  btnS: 10,  flatDk: 30.8,  flatS: 10,  panDk: 28,  panK: 8.4,  nutM: 12.8, wD1: 15, wD2: 28, wH: 2.5 },
  M16:  { d: 16,  P: 2,    hexS: 24,  hexK: 10,   capDk: 24,  capS: 14,  capT: 8,   btnDk: 28,   btnK: 8.8,  btnS: 10,  flatDk: 33.6,  flatS: 10,  panDk: 32,  panK: 9.6,  nutM: 14.8, wD1: 17, wD2: 30, wH: 3 },
  M20:  { d: 20,  P: 2.5,  hexS: 30,  hexK: 12.5, capDk: 30,  capS: 17,  capT: 10,  btnDk: 35,   btnK: 11,   btnS: 12,  flatDk: 40.32, flatS: 12,  panDk: 40,  panK: 12,   nutM: 18,   wD1: 21, wD2: 37, wH: 3 },
  M24:  { d: 24,  P: 3,    hexS: 36,  hexK: 15,   capDk: 36,  capS: 19,  capT: 12,  btnDk: 42,   btnK: 13.2, btnS: 14,  flatDk: 48,    flatS: 14,  panDk: 48,  panK: 14.4, nutM: 21.5, wD1: 25, wD2: 44, wH: 4 },
};
export const SIZES = Object.keys(T);
export const sizeData = (size) => T[size] || null;

export const KINDS = [
  ["hexBolt", "Hex Bolt (ISO 4017)"],
  ["socketCap", "Socket Head Cap Screw (ISO 4762)"],
  ["buttonHead", "Button Head Screw (ISO 7380)"],
  ["flatHead", "Countersunk Screw (ISO 10642)"],
  ["panHead", "Pan Head Screw (ISO 7045)"],
  ["setScrew", "Set Screw (ISO 4026)"],
  ["threadedRod", "Threaded Rod"],
  ["hexNut", "Hex Nut (ISO 4032)"],
  ["washer", "Flat Washer (ISO 7089)"],
];
const SHORT = { hexBolt: "Hex Bolt", socketCap: "Socket Cap Screw", buttonHead: "Button Head Screw", flatHead: "Countersunk Screw", panHead: "Pan Head Screw", setScrew: "Set Screw", threadedRod: "Threaded Rod", hexNut: "Hex Nut", washer: "Washer" };
export const hasLength = (kind) => kind !== "hexNut" && kind !== "washer";
export const isThreaded = (kind) => kind !== "washer";

/** Largest standard size whose nominal diameter fits a hole of diameter `dia` (clearance or nominal holes). */
export function autoSize(dia) {
  let best = SIZES[0];
  for (const s of SIZES) if (T[s].d <= dia + 0.05) best = s;
  return best;
}

/** Thread length when the feature leaves it at 0 ("auto"): fully threaded up to the ISO 4014/4762 b value. */
export function autoThreadLength(kind, size, length) {
  const { d } = T[size];
  if (kind === "setScrew" || kind === "threadedRod" || kind === "flatHead" || kind === "panHead" || kind === "buttonHead") return length;
  const b = kind === "hexBolt" ? 2 * d + 6 : 2 * d + 12;
  return length <= b + d ? length : b;
}

export function fastenerName(f) {
  const size = f.size;
  return hasLength(f.kind) ? `${size} × ${+(+f.length).toFixed(2)} ${SHORT[f.kind]}` : `${size} ${SHORT[f.kind]}`;
}

// ---------------------------------------------------------------- thread geometry
// Basic profile (ISO 68-1): crest flat P/8 at rMaj, root flat P/4 at rMaj - 5H/8, 60° flanks.
function threadSection(rMaj, rMin, P, n = 48) {
  const tooth = (u) => {
    u = ((u % P) + P) % P;
    const a = Math.min(u, P - u);                  // axial distance from the crest centre, 0..P/2
    if (a <= P / 16) return rMaj;
    if (a >= P / 2 - P / 8) return rMin;
    return rMaj - ((a - P / 16) / (P / 2 - P / 8 - P / 16)) * (rMaj - rMin);
  };
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * 2 * Math.PI;
    const r = tooth((-th / (2 * Math.PI)) * P);    // right hand: the helix through angle th reaches th = 0 at z = -th P / 2π
    pts.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return R.drawPointsInterpolation(pts, {}, { closeShape: true });
}
// Threaded solid between z0 and z0 + len (external: the bolt; internal: the hole to cut).
function threadSolid(d, P, z0, len, internal = false) {
  const H = 0.866025 * P;
  const c = internal ? 0.03 * P : -0.03 * P;       // small radial clearance so a nut and bolt never overlap
  const rMaj = d / 2 + c, rMin = d / 2 - 0.625 * H + c;
  const wire = threadSection(rMaj, rMin, P).sketchOnPlane("XY", z0).wire;
  return R.twistExtrude(wire, (360 * len) / P, [0, 0, z0], [0, 0, len]);
}

const cyl = (r, z0, h) => R.makeCylinder(r, h, [0, 0, z0], [0, 0, 1]);
const hexPrism = (s, z0, h) => R.drawPolysides(s / Math.sqrt(3), 6).sketchOnPlane("XY", z0).extrude(h);
const tryOp = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };
// head + shank: fused for plain geometry, a compound of touching solids when the shank is a thread
const join = (a, b, modeled) => (modeled ? R.makeCompound([a, b]) : a.fuse(b));

// hex socket (or other recess) cut into the top of a head at z = top
const hexSocket = (s, top, depth) => hexPrism(s, top - depth, depth + 1);

// Shank from the tip (z = -length) up to z = top: the thread at the tip end, plain above it.
function shank(sz, length, threadLength, modeled, top = 0) {
  const { d, P } = sz;
  const L = length;
  const zTip = -L;
  const b = Math.min(Math.max(threadLength, 0), L + top);
  const parts = [];
  const plainLen = L + top - b;                     // unthreaded part between the thread and `top`
  if (b > 1e-6) parts.push(modeled ? threadSolid(d, P, zTip, b) : cyl(d / 2, zTip, b));
  if (plainLen > 1e-6) parts.push(cyl(d / 2, zTip + b, plainLen));
  if (parts.length === 1) return parts[0];
  return modeled ? R.makeCompound(parts) : parts[0].fuse(parts[1]);
}

/**
 * Build a fastener in its local frame (see top of file).
 * @param {{kind:string,size:string,length?:number,threadLength?:number,threads?:"modeled"|"cosmetic"}} f
 * @returns {{ shape: any, meshTol: number|null }}
 */
export function buildFastener(f) {
  const sz = T[f.size];
  if (!sz) throw new Error(`Unknown size ${f.size}`);
  const { d, P } = sz;
  const modeled = f.threads !== "cosmetic";
  const length = +f.length;
  if (hasLength(f.kind) && !(length > 0)) throw new Error("Length must be positive");
  const tl = f.threadLength > 0 ? Math.min(+f.threadLength, length) : hasLength(f.kind) ? autoThreadLength(f.kind, f.size, length) : 0;
  // threads tessellate to ~10^5 triangles at the default 0.01 mm; P/4 looks the same at ~1/4 the cost
  const meshTol = modeled && isThreaded(f.kind) ? Math.max(0.05, P / 4) : null;
  let s;
  switch (f.kind) {
    case "hexBolt": {
      let head = hexPrism(sz.hexS, 0, sz.hexK);
      head = tryOp(() => head.chamfer(sz.hexK * 0.12, (e) => e.inPlane("XY", sz.hexK)), head);
      s = join(head, shank(sz, length, tl, modeled), modeled);
      break;
    }
    case "socketCap": {
      const k = d;
      let head = cyl(sz.capDk / 2, 0, k);
      head = tryOp(() => head.fillet(Math.min(0.08 * d, 1), (e) => e.inPlane("XY", k)), head);
      head = head.cut(hexSocket(sz.capS, k, Math.min(sz.capT, 0.75 * k)));
      s = join(head, shank(sz, length, tl, modeled), modeled);
      break;
    }
    case "buttonHead": {
      const a = sz.btnDk / 2, k = sz.btnK;
      const Rs = (a * a + k * k) / (2 * k);
      let head = R.makeSphere(Rs).translate([0, 0, k - Rs]).intersect(cyl(a, 0, k + 1));
      head = head.cut(hexSocket(sz.btnS, k, 0.6 * k));
      s = join(head, shank(sz, length, tl, modeled), modeled);
      break;
    }
    case "flatHead": {
      // 90° countersink: the head is a cone from dk (flush at z = 0) down to d; length includes the head
      const hc = (sz.flatDk - d) / 2;
      let head = R.makeCylinder(sz.flatDk / 2, hc, [0, 0, -hc], [0, 0, 1]);
      head = tryOp(() => head.chamfer(hc - 1e-3, (e) => e.inPlane("XY", -hc)), head);
      head = head.cut(hexSocket(sz.flatS, 0, Math.min(0.6 * hc + 0.3 * d, hc + 0.5 * d)));
      if (length <= hc + P) throw new Error(`Length must be more than the head height (${+(hc + P).toFixed(2)} mm)`);
      s = join(head, shank(sz, length, Math.min(tl, length - hc), modeled, -hc), modeled);
      break;
    }
    case "panHead": {
      const a = sz.panDk / 2, k = sz.panK;
      let head = cyl(a, 0, k);
      head = tryOp(() => head.fillet(0.45 * k, (e) => e.inPlane("XY", k)), head);
      const w = Math.max(0.12 * sz.panDk, 0.4), len = 0.55 * sz.panDk, depth = 0.55 * k;
      const slot1 = R.makeBox([-len / 2, -w / 2, k - depth], [len / 2, w / 2, k + 1]);
      const slot2 = R.makeBox([-w / 2, -len / 2, k - depth], [w / 2, len / 2, k + 1]);
      head = head.cut(slot1.fuse(slot2));
      s = join(head, shank(sz, length, tl, modeled), modeled);
      break;
    }
    case "setScrew": {
      const sock = d < 3 ? 0.45 * d : Math.round(d) / 2;          // ISO 4026 key size, about d / 2
      const sd = Math.min(0.8 * d, 0.6 * length);                   // socket depth
      if (!modeled) { s = cyl(d / 2, -length, length).cut(hexSocket(sock, 0, sd)); break; }
      // cut the socket into a short top thread segment only (cheaper), phase-matched to the lower one
      const top = threadSolid(d, P, -sd, sd).rotate((360 * (length - sd)) / P, [0, 0, 0], [0, 0, 1]).cut(hexSocket(sock, 0, sd));
      s = length - sd > 1e-6 ? R.makeCompound([threadSolid(d, P, -length, length - sd), top]) : top;
      break;
    }
    case "threadedRod": {
      s = shank(sz, length, length, modeled);
      break;
    }
    case "hexNut": {
      const m = sz.nutM;
      let nut = hexPrism(sz.hexS, 0, m);
      nut = tryOp(() => nut.chamfer(0.1 * m, (e) => e.inPlane("XY", m)), nut);
      nut = tryOp(() => nut.chamfer(0.1 * m, (e) => e.inPlane("XY", 0)), nut);
      const hole = modeled ? threadSolid(d, P, 0, m, true) : cyl(d / 2 - 0.5413 * P, -1, m + 2);
      s = nut.cut(hole);
      break;
    }
    case "washer": {
      s = cyl(sz.wD2 / 2, 0, sz.wH).cut(cyl(sz.wD1 / 2, -1, sz.wH + 2));
      break;
    }
    default: throw new Error(`Unknown fastener type ${f.kind}`);
  }
  return { shape: s, meshTol };
}

// Built parts are expensive (helical B-rep + its tessellation), and the timeline replays every
// feature on each edit, so finished parts are cached by their parameters. Shapes are never mutated
// by the kernel (operations return new shapes), so the cached shape is shared, not cloned.
const cache = new Map();
const CACHE_MAX = 48;
export function cachedFastener(f) {
  const key = JSON.stringify([f.kind, f.size, hasLength(f.kind) ? +f.length : 0, +f.threadLength || 0, f.threads || "modeled"]);
  let v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); return v; }
  v = buildFastener(f);
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return v;
}

// ---------------------------------------------------------------- imperial (UNC) sizes
// Added for the Shop Stock library (stock.js). Same fields as T, converted to mm. Nominal inch values:
// d and TPI from ASME B1.1 (UNC); socket cap dk / key from ASME B18.3; button and 82° flat heads
// from B18.3 (the builder draws a 90° countersink, so flat heads are approximate); pan heads from
// B18.6.3; hex nuts (machine-screw nuts below 1/4, finished hex nuts from 1/4) from B18.2.2;
// hex bolt heads from B18.2.1 (#4 to #10 use hex machine-screw heads); SAE flat washers.
// They are kept out of SIZES so autoSize() (fit a metric hole) never picks an inch size.
const IN = 25.4;
const imp = (d, tpi, o) => {
  const r = { d: d * IN, P: IN / tpi };
  for (const [k, v] of Object.entries(o)) r[k] = v * IN;
  return r;
};
//             d      TPI   hexS   hexK   capDk  capS    capT   btnDk  btnK   btnS    flatDk flatS   panDk  panK   nutM   wD1    wD2    wH
const IMP = {
  "#4-40":   imp(0.112, 40, { hexS: 0.25,  hexK: 0.06,  capDk: 0.183, capS: 3 / 32, capT: 0.056, btnDk: 0.213, btnK: 0.059, btnS: 5 / 64, flatDk: 0.255, flatS: 1 / 16, panDk: 0.219, panK: 0.080, nutM: 3 / 32,  wD1: 0.125, wD2: 0.312, wH: 0.032 }),
  "#6-32":   imp(0.138, 32, { hexS: 5 / 16, hexK: 0.08,  capDk: 0.226, capS: 7 / 64, capT: 0.069, btnDk: 0.262, btnK: 0.073, btnS: 5 / 64, flatDk: 0.307, flatS: 5 / 64, panDk: 0.270, panK: 0.097, nutM: 7 / 64,  wD1: 0.156, wD2: 0.375, wH: 0.049 }),
  "#8-32":   imp(0.164, 32, { hexS: 11 / 32, hexK: 0.11, capDk: 0.270, capS: 9 / 64, capT: 0.082, btnDk: 0.312, btnK: 0.087, btnS: 3 / 32, flatDk: 0.359, flatS: 3 / 32, panDk: 0.322, panK: 0.115, nutM: 1 / 8,   wD1: 0.188, wD2: 0.438, wH: 0.049 }),
  "#10-24":  imp(0.190, 24, { hexS: 3 / 8,  hexK: 0.12,  capDk: 0.312, capS: 5 / 32, capT: 0.095, btnDk: 0.361, btnK: 0.101, btnS: 1 / 8,  flatDk: 0.411, flatS: 1 / 8,  panDk: 0.373, panK: 0.133, nutM: 1 / 8,   wD1: 0.219, wD2: 0.500, wH: 0.049 }),
  "1/4-20":  imp(0.250, 20, { hexS: 7 / 16, hexK: 5 / 32, capDk: 0.375, capS: 3 / 16, capT: 0.125, btnDk: 0.437, btnK: 0.132, btnS: 5 / 32, flatDk: 0.531, flatS: 5 / 32, panDk: 0.492, panK: 0.175, nutM: 7 / 32,  wD1: 0.281, wD2: 0.625, wH: 0.065 }),
  "5/16-18": imp(0.3125, 18, { hexS: 1 / 2, hexK: 13 / 64, capDk: 0.469, capS: 1 / 4, capT: 0.156, btnDk: 0.547, btnK: 0.166, btnS: 3 / 16, flatDk: 0.656, flatS: 3 / 16, panDk: 0.600, panK: 0.210, nutM: 17 / 64, wD1: 0.344, wD2: 0.688, wH: 0.065 }),
  "3/8-16":  imp(0.375, 16, { hexS: 9 / 16, hexK: 15 / 64, capDk: 0.562, capS: 5 / 16, capT: 0.188, btnDk: 0.656, btnK: 0.199, btnS: 7 / 32, flatDk: 0.781, flatS: 7 / 32, panDk: 0.740, panK: 0.250, nutM: 21 / 64, wD1: 0.406, wD2: 0.812, wH: 0.065 }),
};
Object.assign(T, IMP);
export const IMPERIAL_SIZES = Object.keys(IMP);
export const isImperialSize = (size) => size in IMP;
