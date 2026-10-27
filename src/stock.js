// Shop stock library: catalog + geometry for things you buy rather than design (T-slot extrusion,
// pipe, tube, structural shapes, bar, sheet, bearings, shafts, motors) plus the fastener catalog.
// DOM-free (runs in Node for tests). The kernel's `stock` feature places the parts.
//
// Local frame of every builder: the cross-section lies in XY (centred on its profile, or on the
// part's axis for bearings and motors) and the part runs along +Z from z = 0. Plates lie flat: their
// outline is in XY and the thickness runs along +Z.
//
// Dimensions are nominal catalogue values (sources cited per table). T-slot profiles are simplified:
// the slot opening, lip, T-cavity and centre bore follow the vendor drawings, but the inner cored
// pockets are approximated, so the section area (and so the mass) is only roughly right.
//
// Hardware items do not build geometry here: they expand into ordinary `fastener` features
// (fasteners.js), so the stock browser is one place to find everything.
import * as R from "replicad";
import { KINDS as F_KINDS, SIZES as F_SIZES, IMPERIAL_SIZES as F_IMPERIAL, sizeData, hasLength as fastenerHasLength } from "./fasteners.js";

const IN = 25.4;
const r3 = (v) => +(+v).toFixed(3);
const mm = (v) => `${+(+v).toFixed(2)}`;

export const CATEGORIES = [
  { id: "tslot", name: "T-Slot Extrusion", icon: "extrusion" },
  { id: "pipe", name: "Pipe & Conduit", icon: "pipe" },
  { id: "tube", name: "Tube", icon: "pipe" },
  { id: "shape", name: "Structural Shapes", icon: "stock" },
  { id: "bar", name: "Bar & Rod", icon: "stock" },
  { id: "sheet", name: "Sheet & Plate", icon: "stock" },
  { id: "hardware", name: "Hardware", icon: "bolt" },
  { id: "bearing", name: "Bearings & Shafts", icon: "bearing" },
  { id: "motor", name: "Motors & Servos", icon: "motor" },
];

const ITEMS = [];
const BY_ID = new Map();
function add(it) {
  if (BY_ID.has(it.id)) throw new Error(`duplicate stock id ${it.id}`);
  ITEMS.push(it);
  BY_ID.set(it.id, it);
}

// ---------------------------------------------------------------- 2D profile helpers
const poly = (pts) => {
  let p = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) p = p.lineTo(pts[i]);
  return p.close();
};
const rect = (w, h, r = 0) => (r > 1e-6 ? R.drawRoundedRectangle(w, h, r) : R.drawRectangle(w, h));
const annulus = (od, wall) => R.drawCircle(od / 2).cut(R.drawCircle(od / 2 - wall));

// ---------------------------------------------------------------- T-slot extrusion
// Per series: a = cell size, w = slot opening, t = lip thickness, cw = T-cavity width under the lips,
// cd = cavity depth from the outer face (down to the centre tube), web = diagonal web thickness between
// neighbouring cavities, bore = centre bore (tap drill), r = outer corner radius, pw = wall around the
// cored corner pockets (pockets are only cut where they fit, i.e. 40 series and the inch profiles).
// Metric: Misumi HFS5 (20 series, slot 6, M5 bore), HFS6 (30 series, slot 8, M8 bore),
// HFS8 (40 series, slot 8, M10 bore approximated at 8.5). Inch: 80/20 Inc. fractional 10 series
// (1.00", slot 0.256", 1/4-20 tap bore 0.205") and 15 series (1.50", slot 0.320", 5/16-18 tap bore 0.257").
// Internal pockets are approximations, so the section area (and mass) is only roughly right.
const TSLOT = {
  m20: { a: 20, w: 6.2, t: 1.8, cw: 11, cd: 6.1, web: 1.5, bore: 4.2, r: 1.5, pw: 1.5, src: "Misumi HFS5 20 series" },
  m30: { a: 30, w: 8.2, t: 2.2, cw: 16.5, cd: 9, web: 2, bore: 6.8, r: 2, pw: 2, src: "Misumi HFS6 30 series" },
  m40: { a: 40, w: 8.2, t: 4.3, cw: 20, cd: 12.5, web: 2.5, bore: 8.5, r: 2.5, pw: 2.5, src: "Misumi HFS8 40 series" },
  i10: { a: IN, w: 0.256 * IN, t: 0.087 * IN, cw: 0.48 * IN, cd: 0.3 * IN, web: 0.07 * IN, bore: 0.205 * IN, r: 0.03 * IN, pw: 0.063 * IN, src: "80/20 10 series" },
  i15: { a: 1.5 * IN, w: 0.32 * IN, t: 0.13 * IN, cw: 0.7 * IN, cd: 0.52 * IN, web: 0.1 * IN, bore: 0.257 * IN, r: 0.04 * IN, pw: 0.08 * IN, src: "80/20 15 series" },
};
// T-slot opening into a face: u along the face, depth v measured inward from the face.
function slotPoints(S) {
  const { a, w, t, cw, cd, web } = S;
  // straight cavity wall of height k, then 45° shoulders whose spacing to the neighbouring cavity is `web`
  const k = Math.min(Math.max(a / 2 - t - cw / 2 - web / Math.SQRT2, 0.2 * (cd - t)), cd - t);
  const s = Math.max(cw / 2 - (cd - t - k), (w / 2) * 0.8);  // half width of the cavity floor
  return [[-w / 2, -1], [w / 2, -1], [w / 2, t], [cw / 2, t], [cw / 2, t + k], [s, cd], [-s, cd], [-cw / 2, t + k], [-cw / 2, t], [-w / 2, t]];
}
function tslotProfile(S, nx, ny) {
  const { a } = S, W = nx * a, H = ny * a;
  let d = rect(W, H, S.r);
  const sp = slotPoints(S);
  const cx = (i) => -W / 2 + a / 2 + i * a, cy = (j) => -H / 2 + a / 2 + j * a;
  const cuts = [];
  for (let i = 0; i < nx; i++) {
    cuts.push(sp.map(([u, v]) => [cx(i) + u, H / 2 - v]));      // top
    cuts.push(sp.map(([u, v]) => [cx(i) - u, -H / 2 + v]));     // bottom
  }
  for (let j = 0; j < ny; j++) {
    cuts.push(sp.map(([u, v]) => [W / 2 - v, cy(j) - u]));      // right
    cuts.push(sp.map(([u, v]) => [-W / 2 + v, cy(j) + u]));     // left
  }
  for (const c of cuts) d = d.cut(poly(c));
  // cored corner pockets in each cell, outside the cavities
  const lo = S.cw / 2 + S.pw, hi = a / 2 - S.pw;
  if (hi - lo >= 0.12 * a) {
    const c = (lo + hi) / 2, sz = hi - lo;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) d = d.cut(rect(sz, sz, 0.15 * sz).translate(cx(i) + sx * c, cy(j) + sy * c));
  }
  // hollow on each shared cell edge (real multi-cell profiles are hollow between the bores)
  const across = 0.17 * a, along = S.cw / 2;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (i + 1 < nx) d = d.cut(rect(2 * across, 2 * along).translate(cx(i) + a / 2, cy(j)));
    if (j + 1 < ny) d = d.cut(rect(2 * along, 2 * across).translate(cx(i), cy(j) + a / 2));
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) d = d.cut(R.drawCircle(S.bore / 2).translate(cx(i), cy(j)));
  return d;
}
const TSLOT_KW = "t-slot tslot extrusion aluminum aluminium profile frame rail";
for (const [code, ser, nx, ny] of [["2020", "m20", 1, 1], ["2040", "m20", 1, 2], ["2060", "m20", 1, 3], ["3030", "m30", 1, 1], ["3060", "m30", 1, 2], ["4040", "m40", 1, 1], ["4080", "m40", 1, 2]]) {
  const S = TSLOT[ser];
  add({ id: `tslot-m${code}`, category: "tslot", family: "tslot-metric", name: `${code} T-slot`, size: `${S.a * nx} × ${S.a * ny} mm, slot ${Math.round(S.w)}`, material: "aluminum-6061",
    keywords: `${TSLOT_KW} metric misumi ${S.src}`, length: 500, env: [S.a * nx, S.a * ny], profile: () => tslotProfile(S, nx, ny) });
}
for (const [code, ser, nx, ny] of [["1010", "i10", 1, 1], ["1020", "i10", 1, 2], ["1030", "i10", 1, 3], ["1515", "i15", 1, 1], ["1530", "i15", 1, 2], ["1545", "i15", 1, 3], ["3030", "i15", 2, 2]]) {
  const S = TSLOT[ser];
  add({ id: `tslot-${code}`, category: "tslot", family: "tslot-inch", name: `${code} T-slot`, size: `${(S.a * nx / IN).toFixed(1)}" × ${(S.a * ny / IN).toFixed(1)}", ${ser === "i10" ? "10" : "15"} series`, material: "aluminum-6061",
    keywords: `${TSLOT_KW} inch imperial 80/20 8020 fractional ${S.src}`, length: 500, env: [S.a * nx, S.a * ny], profile: () => tslotProfile(S, nx, ny) });
}

// ---------------------------------------------------------------- pipe
// NPS outside diameter and Schedule 40 / 80 wall, inches (ASME B36.10M; PVC per ASTM D1785 uses the same OD and walls).
const NPS = [
  ["1/8", 0.405, 0.068, 0.095], ["1/4", 0.540, 0.088, 0.119], ["3/8", 0.675, 0.091, 0.126], ["1/2", 0.840, 0.109, 0.147],
  ["3/4", 1.050, 0.113, 0.154], ["1", 1.315, 0.133, 0.179], ["1-1/4", 1.660, 0.140, 0.191], ["1-1/2", 1.900, 0.145, 0.200],
  ["2", 2.375, 0.154, 0.218], ["2-1/2", 2.875, 0.203, 0.276], ["3", 3.500, 0.216, 0.300], ["3-1/2", 4.000, 0.226, 0.318], ["4", 4.500, 0.237, 0.337],
];
const pipeId = (n) => n.replace("/", "_");
for (const [mat, matId, color, kw] of [["Steel", "steel-mild", null, "black iron galvanized"], ["PVC", "abs", null, "plastic plumbing"]]) {
  for (const sch of [40, 80]) {
    for (const [n, od, w40, w80] of NPS) {
      const OD = od * IN, wall = (sch === 40 ? w40 : w80) * IN;
      add({ id: `pipe-${mat.toLowerCase()}-s${sch}-${pipeId(n)}`, category: "pipe", family: `pipe-${mat.toLowerCase()}-s${sch}`, name: `${n}" Sch ${sch} ${mat} Pipe`, size: `${n}" NPS · OD ${mm(OD)} × ${mm(wall)} wall`,
        material: matId, color: mat === "PVC" ? (sch === 40 ? "#f1f1ec" : "#5f656b") : color, keywords: `pipe nps schedule sch${sch} ${kw}`,
        length: 300, env: [OD, OD], dims: { od: OD, wall }, profile: () => annulus(OD, wall) });
    }
  }
}
// EMT conduit OD and wall, inches (ANSI C80.3).
for (const [n, od, w] of [["1/2", 0.706, 0.042], ["3/4", 0.922, 0.049], ["1", 1.163, 0.057], ["1-1/4", 1.510, 0.065], ["1-1/2", 1.740, 0.065], ["2", 2.197, 0.065]]) {
  const OD = od * IN, wall = w * IN;
  add({ id: `emt-${pipeId(n)}`, category: "pipe", family: "emt", name: `${n}" EMT Conduit`, size: `${n}" trade size · OD ${mm(OD)} × ${mm(wall)} wall`, material: "steel-mild", color: "#b8bec4",
    keywords: "emt conduit electrical metallic tubing pipe galvanized", length: 300, env: [OD, OD], dims: { od: OD, wall }, profile: () => annulus(OD, wall) });
}

// ---------------------------------------------------------------- tube
// Round tube: common stocked sizes (OnlineMetals / McMaster 6061 drawn tube; metric EN 754-7 sizes; pultruded carbon tube).
for (const [n, od, w] of [["1/4", 0.25, 0.035], ["3/8", 0.375, 0.035], ["1/2", 0.5, 0.035], ["1/2", 0.5, 0.065], ["5/8", 0.625, 0.058], ["3/4", 0.75, 0.065], ["1", 1, 0.065], ["1", 1, 0.125], ["1-1/4", 1.25, 0.065], ["1-1/2", 1.5, 0.065], ["2", 2, 0.125]]) {
  const OD = od * IN, wall = w * IN;
  add({ id: `rtube-${pipeId(n)}x${String(w).slice(1)}`, category: "tube", family: "rtube-inch", name: `${n}" × ${String(w).replace(/^0/, "")}" Round Tube`, size: `OD ${n}" × ${String(w).replace(/^0/, "")}" wall`, material: "aluminum-6061",
    keywords: "round tube tubing aluminum inch", length: 300, env: [OD, OD], dims: { od: OD, wall }, profile: () => annulus(OD, wall) });
}
for (const [od, w] of [[6, 1], [8, 1], [10, 1], [12, 1], [16, 1.5], [20, 2], [25, 2], [30, 2], [40, 2], [50, 3]]) {
  add({ id: `rtube-m${od}x${w}`, category: "tube", family: "rtube-metric", name: `${od} × ${w} mm Round Tube`, size: `OD ${od} × ${w} mm wall`, material: "aluminum-6061",
    keywords: "round tube tubing aluminum metric", length: 300, env: [od, od], dims: { od, wall: w }, profile: () => annulus(od, w) });
}
for (const [od, id] of [[6, 4], [8, 6], [10, 8], [12, 10], [16, 14], [20, 18], [25, 23]]) {
  add({ id: `cftube-${od}x${id}`, category: "tube", family: "cftube", name: `${od} × ${id} mm Carbon Fiber Tube`, size: `OD ${od} / ID ${id} mm`, material: "carbon-fiber",
    keywords: "carbon fiber fibre cf tube tubing composite drone", length: 300, env: [od, od], dims: { od, wall: (od - id) / 2 }, profile: () => annulus(od, (od - id) / 2) });
}
// Square / rectangular tube: outer corner radius ≈ 1.5 × wall, inner = outer - wall (typical 6063 extruded and EN 10219 practice).
const sqTube = (W, H, t) => rect(W, H, 1.5 * t).cut(rect(W - 2 * t, H - 2 * t, 0.5 * t));
for (const [label, w, h, t, tl] of [["1/2 × 1/2", 0.5, 0.5, 1 / 16, "1/16"], ["3/4 × 3/4", 0.75, 0.75, 1 / 16, "1/16"], ["1 × 1", 1, 1, 1 / 16, "1/16"], ["1 × 1", 1, 1, 1 / 8, "1/8"],
  ["1-1/2 × 1-1/2", 1.5, 1.5, 1 / 8, "1/8"], ["2 × 2", 2, 2, 1 / 8, "1/8"], ["1 × 2", 1, 2, 1 / 16, "1/16"], ["1 × 2", 1, 2, 1 / 8, "1/8"], ["2 × 3", 2, 3, 1 / 8, "1/8"]]) {
  const W = w * IN, H = h * IN, T = t * IN;
  const nm = label.split(" × ").map((x) => `${x}"`).join(" × ");
  add({ id: `sqtube-${w}x${h}x${tl.replace("/", "_")}`, category: "tube", family: "sqtube-inch", name: `${nm} × ${tl}" ${w === h ? "Square" : "Rectangular"} Tube`, size: `${nm} × ${tl}" wall`, material: "aluminum-6061",
    keywords: "square rectangular rectangle box tube tubing section aluminum inch", length: 300, env: [W, H], dims: { w: W, h: H, wall: T }, profile: () => sqTube(W, H, T) });
}
for (const [w, h, t] of [[15, 15, 1.5], [20, 20, 2], [25, 25, 2], [30, 30, 2], [40, 40, 2], [50, 50, 3], [40, 20, 2], [50, 25, 2], [60, 40, 3], [80, 40, 3]]) {
  add({ id: `sqtube-m${w}x${h}x${t}`, category: "tube", family: "sqtube-metric", name: `${w} × ${h} × ${t} mm ${w === h ? "Square" : "Rectangular"} Tube`, size: `${w} × ${h} mm × ${t} wall`, material: "aluminum-6061",
    keywords: "square rectangular rectangle box tube tubing section shs rhs aluminum metric", length: 300, env: [w, h], dims: { w, h, wall: t }, profile: () => sqTube(w, h, t) });
}

// ---------------------------------------------------------------- structural shapes
// Angle: legs a (along X) × b (along Y) × thickness t, sharp corners (Aluminum Association / EN 10056 sizes).
// The profile is centred on its bounding box.
const angleProfile = (a, b, t) => poly([[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]]).translate(-a / 2, -b / 2);
// Channel: depth h (web, along Y), flange width b (along X), thickness t for web and flanges; opens toward +X.
const channelProfile = (h, b, t) => poly([[0, 0], [b, 0], [b, t], [t, t], [t, h - t], [b, h - t], [b, h], [0, h]]).translate(-b / 2, -h / 2);
const fr = (s) => `${s}"`;
for (const [a, b, t, la, lb, lt] of [[0.5, 0.5, 1 / 16, "1/2", "1/2", "1/16"], [0.75, 0.75, 1 / 8, "3/4", "3/4", "1/8"], [1, 1, 1 / 8, "1", "1", "1/8"], [1.5, 1.5, 1 / 8, "1-1/2", "1-1/2", "1/8"],
  [2, 2, 1 / 8, "2", "2", "1/8"], [2, 2, 1 / 4, "2", "2", "1/4"], [1, 2, 1 / 8, "1", "2", "1/8"], [1.5, 2, 1 / 8, "1-1/2", "2", "1/8"]]) {
  const A = a * IN, B = b * IN, T = t * IN;
  add({ id: `angle-${a}x${b}x${lt.replace("/", "_")}`, category: "shape", family: a === b ? "angle-inch" : "angle-unequal-inch", name: `${fr(la)} × ${fr(lb)} × ${fr(lt)} Angle`, size: `${fr(la)} × ${fr(lb)} legs, ${fr(lt)} thick`, material: "aluminum-6061",
    keywords: `angle l bracket ${a === b ? "equal" : "unequal"} aluminum inch`, length: 300, env: [A, B], profile: () => angleProfile(A, B, T) });
}
for (const [a, b, t] of [[20, 20, 3], [25, 25, 3], [30, 30, 3], [40, 40, 4], [50, 50, 5], [30, 20, 3], [40, 20, 4], [60, 40, 5]]) {
  add({ id: `angle-m${a}x${b}x${t}`, category: "shape", family: a === b ? "angle-metric" : "angle-unequal-metric", name: `${a} × ${b} × ${t} mm Angle`, size: `${a} × ${b} mm legs, ${t} thick`, material: "aluminum-6061",
    keywords: `angle l bracket ${a === b ? "equal" : "unequal"} aluminum metric`, length: 300, env: [a, b], profile: () => angleProfile(a, b, t) });
}
for (const [h, b, t, lh, lb, lt] of [[1, 0.5, 1 / 8, "1", "1/2", "1/8"], [1.5, 0.75, 1 / 8, "1-1/2", "3/4", "1/8"], [2, 1, 1 / 8, "2", "1", "1/8"], [3, 1.5, 3 / 16, "3", "1-1/2", "3/16"]]) {
  const H = h * IN, B = b * IN, T = t * IN;
  add({ id: `channel-${h}x${b}`, category: "shape", family: "channel-inch", name: `${fr(lh)} × ${fr(lb)} × ${fr(lt)} C-Channel`, size: `${fr(lh)} deep × ${fr(lb)} flange, ${fr(lt)} thick`, material: "aluminum-6061",
    keywords: "channel c-channel u-channel u c aluminum inch", length: 300, env: [B, H], profile: () => channelProfile(H, B, T) });
}
for (const [h, b, t] of [[20, 10, 2], [30, 15, 2], [40, 20, 3], [50, 25, 3], [60, 30, 4]]) {
  add({ id: `channel-m${h}x${b}x${t}`, category: "shape", family: "channel-metric", name: `${h} × ${b} × ${t} mm C-Channel`, size: `${h} deep × ${b} flange, ${t} thick`, material: "aluminum-6061",
    keywords: "channel c-channel u-channel u c aluminum metric", length: 300, env: [b, h], profile: () => channelProfile(h, b, t) });
}

// ---------------------------------------------------------------- bar and rod
for (const [t, w, lt, lw] of [[1 / 8, 0.5, "1/8", "1/2"], [1 / 8, 1, "1/8", "1"], [3 / 16, 1, "3/16", "1"], [1 / 4, 1, "1/4", "1"], [1 / 4, 2, "1/4", "2"], [1 / 2, 1, "1/2", "1"], [1 / 2, 2, "1/2", "2"]]) {
  const T = t * IN, W = w * IN;
  add({ id: `flat-${lt.replace("/", "_")}x${lw}`, category: "bar", family: "flat-inch", name: `${fr(lt)} × ${fr(lw)} Flat Bar`, size: `${fr(lt)} thick × ${fr(lw)} wide`, material: "aluminum-6061",
    keywords: "flat bar strip rectangular aluminum inch", length: 300, env: [W, T], profile: () => rect(W, T) });
}
for (const [t, w] of [[3, 20], [5, 20], [5, 30], [6, 40], [10, 40], [10, 50]]) {
  add({ id: `flat-m${t}x${w}`, category: "bar", family: "flat-metric", name: `${t} × ${w} mm Flat Bar`, size: `${t} thick × ${w} wide`, material: "aluminum-6061",
    keywords: "flat bar strip rectangular aluminum metric", length: 300, env: [w, t], profile: () => rect(w, t) });
}
const INCH_ROUND = [["1/8", 0.125], ["3/16", 0.1875], ["1/4", 0.25], ["5/16", 0.3125], ["3/8", 0.375], ["1/2", 0.5], ["5/8", 0.625], ["3/4", 0.75], ["1", 1]];
for (const [n, d] of INCH_ROUND) {
  const D = d * IN;
  add({ id: `rod-${pipeId(n)}`, category: "bar", family: "rod-inch", name: `${n}" Round Bar`, size: `Ø ${n}" (${mm(D)} mm)`, material: "aluminum-6061",
    keywords: "round bar rod dowel aluminum inch", length: 300, env: [D, D], profile: () => R.drawCircle(D / 2) });
}
for (const d of [3, 4, 5, 6, 8, 10, 12, 16, 20, 25]) {
  add({ id: `rod-m${d}`, category: "bar", family: "rod-metric", name: `${d} mm Round Bar`, size: `Ø ${d} mm`, material: "aluminum-6061",
    keywords: "round bar rod dowel aluminum metric", length: 300, env: [d, d], profile: () => R.drawCircle(d / 2) });
}
for (const [n, s] of [["1/4", 0.25], ["3/8", 0.375], ["1/2", 0.5], ["3/4", 0.75], ["1", 1]]) {
  const S = s * IN;
  add({ id: `sqbar-${pipeId(n)}`, category: "bar", family: "sqbar-inch", name: `${n}" Square Bar`, size: `${n}" square`, material: "aluminum-6061",
    keywords: "square bar key stock aluminum inch", length: 300, env: [S, S], profile: () => rect(S, S) });
}
for (const s of [6, 8, 10, 12, 20]) {
  add({ id: `sqbar-m${s}`, category: "bar", family: "sqbar-metric", name: `${s} mm Square Bar`, size: `${s} mm square`, material: "aluminum-6061",
    keywords: "square bar key stock aluminum metric", length: 300, env: [s, s], profile: () => rect(s, s) });
}
// Hex bar: size across flats; flats parallel to X (so the X extent is across corners). 3/8" and 1/2" are the VEX / FRC hex shaft sizes.
const hexProfile = (s) => R.drawPolysides(s / Math.sqrt(3), 6).rotate(30, [0, 0]);
for (const [n, s] of [["1/4", 0.25], ["3/8", 0.375], ["1/2", 0.5], ["3/4", 0.75]]) {
  const S = s * IN;
  add({ id: `hexbar-${pipeId(n)}`, category: "bar", family: "hexbar-inch", name: `${n}" Hex Bar`, size: `${n}" across flats`, material: "aluminum-6061",
    keywords: "hex hexagon bar shaft frc vex robotics inch", length: 300, env: [(2 * S) / Math.sqrt(3), S], profile: () => hexProfile(S) });
}
for (const s of [8, 10, 13, 17]) {
  add({ id: `hexbar-m${s}`, category: "bar", family: "hexbar-metric", name: `${s} mm Hex Bar`, size: `${s} mm across flats`, material: "aluminum-6061",
    keywords: "hex hexagon bar metric", length: 300, env: [(2 * s) / Math.sqrt(3), s], profile: () => hexProfile(s) });
}

// ---------------------------------------------------------------- sheet and plate (outline in XY, thickness along +Z)
const plateParams = [{ key: "width", label: "Width", type: "number", unit: "mm", value: 200 }];
for (const [n, t] of [["1/32", 1 / 32], ["1/16", 1 / 16], ["0.090", 0.09], ["1/8", 1 / 8], ["3/16", 3 / 16], ["1/4", 1 / 4], ["3/8", 3 / 8], ["1/2", 1 / 2]]) {
  add({ id: `plate-al-${n.replace("/", "_")}`, category: "sheet", family: "plate-al-inch", name: `${n}" Aluminum Plate`, size: `${n}" thick (${mm(t * IN)} mm)`, material: "aluminum-6061",
    keywords: "sheet plate aluminum inch", plate: true, thickness: t * IN, length: 300, params: plateParams });
}
for (const t of [1, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
  add({ id: `plate-al-m${t}`, category: "sheet", family: "plate-al-metric", name: `${t} mm Aluminum Plate`, size: `${t} mm thick`, material: "aluminum-6061",
    keywords: "sheet plate aluminum metric", plate: true, thickness: t, length: 300, params: plateParams });
}
// Manufacturer's standard gauge for steel sheet.
for (const [g, t] of [[20, 0.0359], [16, 0.0598], [14, 0.0747], [11, 0.1196]]) {
  add({ id: `sheet-steel-${g}ga`, category: "sheet", family: "sheet-steel", name: `${g} ga Steel Sheet`, size: `${g} gauge (${mm(t * IN)} mm)`, material: "steel-mild",
    keywords: "sheet plate steel gauge gage", plate: true, thickness: t * IN, length: 300, params: plateParams });
}
for (const [n, t, mat, nm] of [["1/16", 1 / 16, "polycarbonate", "Polycarbonate"], ["1/8", 1 / 8, "polycarbonate", "Polycarbonate"], ["1/4", 1 / 4, "polycarbonate", "Polycarbonate"], ["1/8", 1 / 8, "acrylic", "Acrylic"], ["1/4", 1 / 4, "acrylic", "Acrylic"]]) {
  add({ id: `sheet-${mat}-${n.replace("/", "_")}`, category: "sheet", family: `sheet-${mat}`, name: `${n}" ${nm} Sheet`, size: `${n}" thick (${mm(t * IN)} mm)`, material: mat,
    keywords: `sheet plate plastic ${mat} ${mat === "polycarbonate" ? "lexan pc" : "plexiglass pmma"}`, plate: true, thickness: t * IN, length: 300, params: plateParams });
}

// ---------------------------------------------------------------- bearings and shafts
// Deep groove ball bearings, bore d × OD D × width B in mm (ISO 15 / SKF catalogue).
const BEARINGS = [["623", 3, 10, 4], ["624", 4, 13, 5], ["625", 5, 16, 5], ["626", 6, 19, 6], ["608", 8, 22, 7], ["688", 8, 16, 5], ["6800", 10, 19, 5],
  ["6000", 10, 26, 8], ["6001", 12, 28, 8], ["6002", 15, 32, 9], ["6003", 17, 35, 10], ["6004", 20, 42, 12], ["6005", 25, 47, 12],
  ["6200", 10, 30, 9], ["6201", 12, 32, 10], ["6202", 15, 35, 11], ["6203", 17, 40, 12], ["6204", 20, 47, 14], ["6205", 25, 52, 15]];
// Shielded bearing as one revolved section: inner ring, outer ring and a recessed shield between them.
function bearingShape(d, D, B) {
  const ri = d / 2, ro = D / 2, w = (ro - ri) * 0.24, s = Math.min(0.35, B * 0.06);
  const pts = [[ri, 0], [ri + w, 0], [ri + w, s], [ro - w, s], [ro - w, 0], [ro, 0], [ro, B], [ro - w, B], [ro - w, B - s], [ri + w, B - s], [ri + w, B], [ri, B]];
  return poly(pts).sketchOnPlane("XZ").revolve();
}
for (const [code, d, D, B] of BEARINGS) {
  add({ id: `bearing-${code}`, category: "bearing", family: "bearing", name: `${code} Ball Bearing`, size: `${d} × ${D} × ${B} mm`, material: "stainless-304",
    keywords: `bearing ball deep groove ${code}zz ${code}-2rs ${code}rs skateboard`, env: [D, D], build: () => bearingShape(d, D, B) });
}
// Shafts: precision (h6 linear) rod and D-shafts. D flat depth 0.5 mm (metric motor shafts) or 0.02" (1/4" D).
const dProfile = (dia, flat) => R.drawCircle(dia / 2).cut(rect(dia + 2, dia).translate(0, dia / 2 + (dia / 2 - flat)));
for (const d of [3, 4, 5, 6, 8, 10, 12, 16, 20]) {
  add({ id: `shaft-m${d}`, category: "bearing", family: "shaft-precision", name: `${d} mm Precision Shaft`, size: `Ø ${d} mm h6 linear rod`, material: "stainless-304",
    keywords: "shaft rod linear precision hardened axle guide", length: 200, env: [d, d], profile: () => R.drawCircle(d / 2) });
}
for (const [d, flat, n] of [[5, 0.5, "5 mm"], [6, 0.5, "6 mm"], [8, 0.5, "8 mm"], [0.25 * IN, 0.02 * IN, '1/4"']]) {
  add({ id: `dshaft-${n.replace(/[ "]/g, "").replace("/", "_")}`, category: "bearing", family: "shaft-d", name: `${n} D-Shaft`, size: `Ø ${n}, ${mm(flat)} mm flat`, material: "steel-mild",
    keywords: "shaft d-shaft dshaft d axle motor flat", length: 200, env: [d, d], bounds: [-d / 2, d / 2, -d / 2, d / 2 - flat], profile: () => dProfile(d, flat) });
}
for (const [n, s] of [["3/8", 0.375], ["1/2", 0.5]]) {
  const S = s * IN;
  add({ id: `hexshaft-${n.replace("/", "_")}`, category: "bearing", family: "shaft-hex", name: `${n}" Hex Shaft`, size: `${n}" across flats (steel)`, material: "steel-mild",
    keywords: "hex shaft axle frc vex robotics", length: 200, env: [(2 * S) / Math.sqrt(3), S], profile: () => hexProfile(S) });
}

// ---------------------------------------------------------------- motors (envelope models)
// NEMA ICS 16 frame sizes: body square, pilot (boss) diameter × height, shaft, mounting-hole square and diameter.
// The body runs z = 0 (rear) to z = L (mounting face); pilot and shaft stick out along +Z.
const NEMA = {
  17: { s: 42.3, c: 4, pilot: 22, ph: 2, shaft: 5, sl: 24, holeSq: 31, hole: 2.5, hd: 4.5, lengths: [34, 40, 48, 60], L: 40 },
  23: { s: 56.4, c: 5, pilot: 38.1, ph: 1.6, shaft: 6.35, sl: 21, holeSq: 47.14, hole: 5.1, hd: 5, lengths: [41, 56, 76, 100], L: 56 },
};
function nemaShape(N, L) {
  const h = N.s / 2, c = N.c;
  const body = poly([[-h + c, -h], [h - c, -h], [h, -h + c], [h, h - c], [h - c, h], [-h + c, h], [-h, h - c], [-h, -h + c]]).sketchOnPlane("XY").extrude(L);
  const pilot = R.makeCylinder(N.pilot / 2, N.ph, [0, 0, L], [0, 0, 1]);
  const shaft = dProfile(N.shaft, 0.5).sketchOnPlane("XY", L).extrude(N.sl);
  let s = body.fuse(pilot).fuse(shaft);
  const m = N.holeSq / 2;
  for (const [x, y] of [[m, m], [-m, m], [-m, -m], [m, -m]]) s = s.cut(R.makeCylinder(N.hole / 2, N.hd + 1, [x, y, L - N.hd], [0, 0, 1]));
  return s;
}
for (const n of [17, 23]) {
  const N = NEMA[n];
  add({ id: `nema${n}`, category: "motor", family: "stepper", name: `NEMA ${n} Stepper`, size: `${N.s} mm square, Ø${N.shaft} shaft`, material: "aluminum-anodized",
    keywords: `stepper motor nema${n} nema ${n} step`, env: [N.s, N.s], params: [{ key: "bodyLength", label: "Body length", type: "select", unit: "mm", value: N.L, options: N.lengths }],
    build: (len, p) => nemaShape(N, +(p && p.bodyLength) || N.L) });
}
// Hobby servos (envelopes from the common Futaba S3003 / TowerPro SG90 drawings). Body centred in XY,
// output spline offset toward +X, flange around the case.
const SERVO = {
  standard: { L: 40.4, W: 19.8, H: 36, fl: 54.4, ft: 2.5, fz: 26.5, holeX: 24.4, holeY: 5, hole: 4.2, spX: 10.2, boss: 13, bh: 2, spline: 6, sh: 4 },
  micro: { L: 22.8, W: 12.2, H: 22.7, fl: 32.3, ft: 2.5, fz: 15.9, holeX: 13.8, holeY: 0, hole: 2, spX: 5.9, boss: 11.8, bh: 4, spline: 4.8, sh: 3 },
};
function servoShape(S) {
  let s = R.makeBox([-S.L / 2, -S.W / 2, 0], [S.L / 2, S.W / 2, S.H]);
  s = s.fuse(R.makeBox([-S.fl / 2, -S.W / 2, S.fz], [S.fl / 2, S.W / 2, S.fz + S.ft]));
  const cx = S.L / 2 - S.spX;
  s = s.fuse(R.makeCylinder(S.boss / 2, S.bh, [cx, 0, S.H], [0, 0, 1])).fuse(R.makeCylinder(S.spline / 2, S.sh, [cx, 0, S.H + S.bh], [0, 0, 1]));
  const ys = S.holeY ? [S.holeY, -S.holeY] : [0];
  for (const x of [S.holeX, -S.holeX]) for (const y of ys) s = s.cut(R.makeCylinder(S.hole / 2, S.ft + 2, [x, y, S.fz - 1], [0, 0, 1]));
  return s;
}
add({ id: "servo-standard", category: "motor", family: "servo", name: "Standard Servo", size: "40.4 × 19.8 × 36 mm (S3003 class)", material: "abs",
  keywords: "servo hobby rc standard motor futaba hitec", env: [SERVO.standard.fl, SERVO.standard.W], build: () => servoShape(SERVO.standard) });
add({ id: "servo-micro", category: "motor", family: "servo", name: "Micro Servo (SG90)", size: "22.8 × 12.2 × 22.7 mm", material: "abs", color: "#2a62c9",
  keywords: "servo hobby rc micro sg90 9g motor", env: [SERVO.micro.fl, SERVO.micro.W], build: () => servoShape(SERVO.micro) });

// ---------------------------------------------------------------- hardware (fastener features)
const F_SHORT = { hexBolt: "Hex Bolt", socketCap: "Socket Head Cap Screw", buttonHead: "Button Head Screw", flatHead: "Flat Head Screw", panHead: "Pan Head Screw", setScrew: "Set Screw", threadedRod: "Threaded Rod", hexNut: "Hex Nut", washer: "Washer" };
const F_KW = {
  hexBolt: "bolt hex cap screw hhcs", socketCap: "bolt screw shcs socket cap allen", buttonHead: "bolt screw bhcs button socket", flatHead: "bolt screw fhcs flat countersunk countersink",
  panHead: "screw machine pan", setScrew: "set screw grub", threadedRod: "threaded rod stud all-thread allthread", hexNut: "nut hex", washer: "washer flat",
};
const METRIC_LEN = [3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 150];
const INCH_LEN = [0.25, 0.375, 0.5, 0.625, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
function defaultFastenerLength(kind, size, imperial) {
  const d = sizeData(size).d;
  if (kind === "threadedRod") return imperial ? 6 * IN : 100;
  if (imperial) return (INCH_LEN.find((l) => l * IN >= 3.5 * d) || 4) * IN;
  return METRIC_LEN.find((l) => l >= 4 * d) || 150;
}
for (const [kind] of F_KINDS) {
  for (const size of [...F_SIZES, ...F_IMPERIAL]) {
    const imperial = F_IMPERIAL.includes(size);
    add({ id: `fastener-${kind}-${size}`, category: "hardware", family: `fastener-${kind}`, name: `${size} ${F_SHORT[kind]}`, size: imperial ? `${size} UNC` : `${size} × ${sizeData(size).P} (coarse)`,
      material: null, keywords: `${F_KW[kind]} ${imperial ? "inch unc imperial sae" : "metric iso"} fastener hardware`,
      fastener: { kind, size }, length: fastenerHasLength(kind) ? r3(defaultFastenerLength(kind, size, imperial)) : null,
      params: kind === "washer" ? [] : [{ key: "threads", label: "Threads", type: "select", value: "modeled", options: [["modeled", "Modeled"], ["cosmetic", "Cosmetic (plain, fast)"]] }] });
  }
}

// ---------------------------------------------------------------- catalog API
export const STOCK_ITEMS = ITEMS;
export const stockItem = (id) => BY_ID.get(id) || null;
export const isFastenerItem = (id) => !!(stockItem(id) || {}).fastener;
/** Does the item take a length (linear stock, plates, fasteners with a shank)? */
export const itemHasLength = (id) => { const it = stockItem(id); return !!it && it.length != null; };
/** Items of the same family (the browser's Size dropdown). */
export const familyOf = (id) => { const it = stockItem(id); return it ? ITEMS.filter((x) => x.family === it.family) : []; };
export const itemsIn = (category) => ITEMS.filter((x) => x.category === category);
/** Default parameter values for an item ({ width: 200 } for plates, { threads: "modeled" } for fasteners…). */
export function defaultParams(id) {
  const it = stockItem(id), out = {};
  for (const p of (it && it.params) || []) out[p.key] = p.value;
  return out;
}

const fmtLen = (v) => `${+(+v).toFixed(2)}`;
/** Body / timeline name, e.g. "1530 T-slot × 500 mm". */
export function stockName(id, length, params = {}) {
  const it = stockItem(id);
  if (!it) return "Stock";
  if (it.plate) return `${it.name} ${fmtLen(length)} × ${fmtLen(params.width ?? 200)} mm`;
  if (it.family === "stepper") return `${it.name} (${fmtLen(params.bodyLength ?? it.params[0].value)} mm)`;
  if (it.length != null) return `${it.name} × ${fmtLen(length)} mm`;
  return it.name;
}

// ---------------------------------------------------------------- search
const tokens = (s) => s.toLowerCase().replace(/["“”(),·]/g, " ").replace(/(\d)\s*[x×]\s*(?=\d)/g, "$1 ").replace(/×/g, " ").split(/\s+/).filter(Boolean);
const SYN = { bolt: ["bolt"], screw: ["screw"], al: ["aluminum"], aluminium: ["aluminum"], ss: ["stainless"], "80/20": ["8020"], "t-slot": ["tslot"] };
const hayCache = new Map();
function hay(it) {
  let h = hayCache.get(it.id);
  if (!h) {
    const cat = CATEGORIES.find((c) => c.id === it.category);
    const text = `${it.name} ${it.size} ${it.keywords || ""} ${cat ? cat.name : ""} ${it.id}`;
    h = { words: new Set(tokens(text)), text: text.toLowerCase(), name: new Set(tokens(it.name)) };
    hayCache.set(it.id, h);
  }
  return h;
}
/**
 * Rank catalog items for a free-text query ("m4 bolt", "1/2 pipe", "1530"). Every query word must
 * match (whole word 3, word prefix 2, substring 1, +1 when it is in the item name). Ties keep catalog order.
 */
export function searchStock(query, { category = null, limit = 200 } = {}) {
  const q = tokens(query || "").flatMap((t) => (SYN[t] ? SYN[t] : [t]));
  const pool = category ? itemsIn(category) : ITEMS;
  if (!q.length) return pool.slice(0, limit);
  const scored = [];
  pool.forEach((it, i) => {
    const h = hay(it);
    let score = 0;
    for (const t of q) {
      let s = 0;
      if (h.words.has(t)) s = 3;
      else { for (const w of h.words) if (w.startsWith(t)) { s = 2; break; } }
      if (!s && h.text.includes(t)) s = 1;
      if (!s) return;
      if (h.name.has(t)) s += 1;
      score += s;
    }
    scored.push({ it, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.it);
}

// ---------------------------------------------------------------- feature construction
/**
 * Turn browser values into a timeline feature. Hardware items become `fastener` features; everything
 * else is `{ type: "stock", item, length, params, material, place, direction, offset, rotation }`.
 */
export function stockFeature(v) {
  const it = stockItem(v.item);
  if (!it) throw new Error(`Unknown stock item ${v.item}`);
  const params = { ...defaultParams(it.id), ...(v.params || {}) };
  if (it.fastener) {
    return { type: "fastener", kind: it.fastener.kind, size: it.fastener.size, length: v.length ?? it.length ?? 0, threadLength: 0, threads: params.threads || "modeled",
      direction: v.direction === "flip" ? "flip" : "normal", offset: +v.offset || 0, place: v.place || null };
  }
  return { type: "stock", item: it.id, length: it.length != null ? +(v.length ?? it.length) : null, params, material: v.material || "", place: v.place || null,
    direction: v.direction || "normal", offset: +v.offset || 0, rotation: +v.rotation || 0 };
}

/** Appearance a stock body gets until the user assigns one: { materialId, color? }. */
export function defaultAppearance(id, materialOverride) {
  const it = stockItem(id);
  if (!it || !it.material) return null;
  if (materialOverride && materialOverride !== it.material) return { materialId: materialOverride };
  return it.color ? { materialId: it.material, color: it.color } : { materialId: it.material };
}

/**
 * Keep doc.appearances in step with stock bodies (appearances are keyed by body id, which can shift
 * when upstream features change). Entries written here carry `auto: true`; anything the user set in
 * the Appearance dialog has no flag and is never touched. Returns true when the map changed.
 */
export function syncStockAppearances(bodies, appearances) {
  let changed = false;
  const want = new Map();
  for (const b of bodies) if (b.stockAppearance) want.set(b.id, b.stockAppearance);
  for (const [id, a] of Object.entries(appearances)) {
    if (a && a.auto && !want.has(id)) { delete appearances[id]; changed = true; }
  }
  for (const [id, a] of want) {
    const cur = appearances[id];
    if (cur && !cur.auto) continue;
    if (!cur || cur.materialId !== a.materialId || (cur.color || null) !== (a.color || null)) { appearances[id] = { ...a, auto: true }; changed = true; }
  }
  return changed;
}

// ---------------------------------------------------------------- geometry
/**
 * Build an item in its local frame (see top of file).
 * @returns {{ shape, env: [x0, x1, y0, y1] }} env = the cross-section's extent in XY (used to lay parts flat).
 */
export function buildStock(id, length, params = {}) {
  const it = stockItem(id);
  if (!it) throw new Error(`Unknown stock item ${id}`);
  if (it.fastener) throw new Error("Hardware items are fastener features");
  if (it.length != null && !(+length > 0)) throw new Error("Length must be positive");
  if (it.plate) {
    const W = +(params.width ?? 200);
    if (!(W > 0)) throw new Error("Width must be positive");
    return { shape: rect(+length, W).sketchOnPlane("XY").extrude(it.thickness), env: [-length / 2, length / 2, -W / 2, W / 2] };
  }
  const env = it.bounds || (it.env ? [-it.env[0] / 2, it.env[0] / 2, -it.env[1] / 2, it.env[1] / 2] : [0, 0, 0, 0]);
  if (it.build) return { shape: it.build(length, params), env };
  return { shape: it.profile().sketchOnPlane("XY").extrude(+length), env };
}

// Built parts are cached by parameters (like fasteners.js) so timeline replays reuse the same shape
// objects and the kernel's mesh cache hits. Shapes are never mutated (transforms run on clones).
const cache = new Map();
const CACHE_MAX = 64;
export function cachedStock(id, length, params = {}) {
  const key = JSON.stringify([id, +length || 0, params]);
  let v = cache.get(key);
  if (v) { cache.delete(key); cache.set(key, v); return v; }
  v = buildStock(id, length, params);
  cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return v;
}
