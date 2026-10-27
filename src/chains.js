// Sprockets + roller chain, timing pulleys + toothed belts (DOM-free; gears.js delegates here).
//
// Local frame of a sprocket / pulley: axis +Z, from z = 0 to its width; seat (sprocket) or groove
// (pulley) 0 is centred on +X. Chains and belts are built from a layout already in the feature frame
// (absolute u, v), lying in z = 0 … width around the wheels' mid-plane.
//
// Chain drives are solved chordally: rollers sit exactly in the sprocket seats on each wrap and the
// free spans hold a whole number of pitches, so the centre distance is adjusted until the loop closes
// (as a real chain forces). Belts follow the pitch line exactly (pitch-line length = whole teeth).
import * as R from "replicad";

const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const P3 = (q, z = 0) => [q[0], q[1], z];
const pol = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]], sub = (a, b) => [a[0] - b[0], a[1] - b[1]], mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]), unit = (a) => mul(a, 1 / (len(a) || 1));
const wrap360 = (a) => ((a % 360) + 360) % 360;

// ---------------------------------------------------------------- tables
/** Roller chains: pitch, roller Ø, inner width, plate height and thickness (mm). */
export const CHAINS = {
  "25": { label: "ANSI #25 (1/4\")", p: 6.35, dr: 3.30, w: 3.18, ph: 5.9, pt: 0.76 },
  "35": { label: "ANSI #35 (3/8\")", p: 9.525, dr: 5.08, w: 4.77, ph: 9.0, pt: 1.27 },
  "40": { label: "ANSI #40 (1/2\")", p: 12.7, dr: 7.92, w: 7.85, ph: 12.0, pt: 1.5 },
  "50": { label: "ANSI #50 (5/8\")", p: 15.875, dr: 10.16, w: 9.4, ph: 15.0, pt: 2.0 },
  "60": { label: "ANSI #60 (3/4\")", p: 19.05, dr: 11.91, w: 12.57, ph: 18.0, pt: 2.4 },
  "06B": { label: "ISO 06B (3/8\")", p: 9.525, dr: 6.35, w: 5.72, ph: 8.2, pt: 1.3 },
  "08B": { label: "ISO 08B (1/2\")", p: 12.7, dr: 8.51, w: 7.75, ph: 11.8, pt: 1.6 },
  "bike": { label: "Bicycle 1/2\" × 1/8\"", p: 12.7, dr: 7.75, w: 3.3, ph: 11.7, pt: 0.9 },
};
/** Toothed belts: pitch, pitch-line differential, total thickness, tooth height, groove radius (mm). */
export const BELTS = {
  GT2: { label: "GT2 2 mm", p: 2, pld: 0.254, t: 1.38, h: 0.75, rg: 0.555, widths: [6, 9, 10] },
  GT2_3: { label: "GT2 3 mm", p: 3, pld: 0.381, t: 2.4, h: 1.14, rg: 0.85, widths: [6, 9, 15] },
  HTD3M: { label: "HTD 3M", p: 3, pld: 0.381, t: 2.4, h: 1.17, rg: 0.86, widths: [6, 9, 15] },
  HTD5M: { label: "HTD 5M", p: 5, pld: 0.5715, t: 3.8, h: 2.06, rg: 1.49, widths: [9, 15, 25] },
};
export const chainOf = (id) => CHAINS[id] || CHAINS["40"];
export const beltOf = (id) => BELTS[id] || BELTS.GT2;

// ---------------------------------------------------------------- sizes
export function sprocketSizes(p) {
  const c = chainOf(p.chain), N = p.teeth;
  const R0 = c.p / (2 * Math.sin(Math.PI / N));
  return { pitchRadius: R0, pitchDia: 2 * R0, tipRadius: (c.p * (0.6 + 1 / Math.tan(Math.PI / N))) / 2, seatRadius: 0.505 * c.dr + 0.04, width: 0.9 * c.w, chain: c };
}
export function pulleySizes(p) {
  const b = beltOf(p.belt), N = p.teeth;
  const R0 = (N * b.p) / (2 * Math.PI);
  return { pitchRadius: R0, pitchDia: 2 * R0, tipRadius: R0 - b.pld, belt: b, flangeRadius: R0 - b.pld + b.t + 1.2 };
}

// ---------------------------------------------------------------- wheels
function arc3(a, m, b, z = 0) { return R.makeThreePointArc(P3(a, z), P3(m, z), P3(b, z)); }
/** Arc around `c` from point a to point b the short way (both at the same radius). */
function arcAround(c, a, b) {
  const r = len(sub(a, c));
  let t0 = Math.atan2(a[1] - c[1], a[0] - c[0]), t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let d = t1 - t0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  return arc3(a, add(c, pol(r, t0 + d / 2)), b);
}
/** Intersections of two circles (centre, radius). */
function circleX(c0, r0, c1, r1) {
  const d = len(sub(c1, c0));
  if (d > r0 + r1 || d < Math.abs(r0 - r1) || d === 0) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
  const m = add(c0, mul(sub(c1, c0), a / d)), n = mul([-(c1[1] - c0[1]), c1[0] - c0[0]], h / d);
  return [add(m, n), sub(m, n)];
}

/** Sprocket outline wire (ANSI-style: roller seats, flanks centred on the next roller, topping on the OD). */
function sprocketWire(p) {
  const S = sprocketSizes(p), N = p.teeth, Rp = S.pitchRadius, rs = S.seatRadius, ro = S.tipRadius, re = S.chain.p - rs;
  const s = (2 * Math.PI) / N, C = (k) => pol(Rp, k * s);
  const edges = [];
  for (let k = 0; k < N; k++) {
    const Ck = C(k), Ck1 = C(k + 1), Ckm = C(k - 1);
    const Pkm = add(Ck, mul(unit(sub(Ckm, Ck)), rs)), Pkp = add(Ck, mul(unit(sub(Ck1, Ck)), rs));
    edges.push(arc3(Pkm, sub(Ck, mul(unit(Ck), rs)), Pkp)); // roller seat
    const Pn = add(Ck1, mul(unit(sub(Ck, Ck1)), rs));
    // flank from this seat: around the next roller centre; flank into the next seat: around this one
    const tipMid = pol(ro, (k + 0.5) * s);
    const x1 = circleX(Ck1, re, [0, 0], ro).sort((a, b) => len(sub(a, Ck)) - len(sub(b, Ck)))[0];
    const x2 = circleX(Ck, re, [0, 0], ro).sort((a, b) => len(sub(a, Ck1)) - len(sub(b, Ck1)))[0];
    const ang = (q) => Math.atan2(q[1], q[0]);
    let ok = x1 && x2;
    if (ok) { let d = ang(x2) - ang(x1); while (d < -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI; ok = d > 1e-4; }
    if (ok) {
      edges.push(arcAround(Ck1, Pkp, x1));
      edges.push(arc3(x1, tipMid, x2));
      edges.push(arcAround(Ck, x2, Pn));
    } else {
      // pointed tooth: the flanks meet below the OD
      const X = circleX(Ck1, re, Ck, re).sort((a, b) => len(b) - len(a))[0];
      edges.push(arcAround(Ck1, Pkp, X));
      edges.push(arcAround(Ck, X, Pn));
    }
  }
  return R.assembleWire(edges);
}
/** Timing pulley outline wire: OD lands and round grooves. */
function pulleyWire(p) {
  const S = pulleySizes(p), b = S.belt, N = p.teeth, ro = S.tipRadius, rc = ro - b.h + b.rg, rg = b.rg;
  const cosd = (ro * ro + rc * rc - rg * rg) / (2 * ro * rc), dl = Math.acos(Math.max(-1, Math.min(1, cosd)));
  const s = (2 * Math.PI) / N, edges = [];
  for (let k = 0; k < N; k++) {
    const a = k * s;
    edges.push(arc3(pol(ro, a - dl), pol(ro - b.h, a), pol(ro, a + dl)));            // groove
    edges.push(arc3(pol(ro, a + dl), pol(ro, a + s / 2), pol(ro, a + s - dl)));       // land
  }
  return R.assembleWire(edges);
}
const extrude = (wire, h, z0 = 0) => { let s = R.basicFaceExtrusion(R.makeFace(wire), new R.Vector([0, 0, h])); if (z0) s = s.translate([0, 0, z0]); return s; };

export function buildSprocket(p) {
  const S = sprocketSizes(p), w = p.width > 0 ? p.width : S.width;
  let s = extrude(sprocketWire(p), w);
  if (p.hubDia > 0 && p.hubLength > 0) s = s.fuse(R.makeCylinder(p.hubDia / 2, p.hubLength, [0, 0, w], [0, 0, 1]));
  if (p.bore > 0) s = s.cut(R.makeCylinder(p.bore / 2, w + (p.hubDia > 0 ? p.hubLength : 0) + 2, [0, 0, -1], [0, 0, 1]));
  return s;
}
export function buildPulley(p) {
  const S = pulleySizes(p), w = p.width;
  const fl = p.flanges ? 1 : 0;
  let s = extrude(pulleyWire(p), w, fl);
  if (fl) {
    s = s.fuse(R.makeCylinder(S.flangeRadius, 1, [0, 0, 0], [0, 0, 1])).fuse(R.makeCylinder(S.flangeRadius, 1, [0, 0, w + 1], [0, 0, 1]));
  }
  const top = w + 2 * fl;
  if (p.hubDia > 0 && p.hubLength > 0) s = s.fuse(R.makeCylinder(p.hubDia / 2, p.hubLength, [0, 0, top], [0, 0, 1]));
  if (p.bore > 0) s = s.cut(R.makeCylinder(p.bore / 2, top + (p.hubDia > 0 ? p.hubLength : 0) + 2, [0, 0, -1], [0, 0, 1]));
  return s;
}
/** Full width of a pulley including its flanges. */
export const pulleyWidth = (p) => p.width + (p.flanges ? 2 : 0);

// ---------------------------------------------------------------- chain / belt bodies
/** Chain from its roller centres (closed loop, frame u, v), centred on z = zMid. */
export function buildChain(layout, chainId, zMid) {
  const c = chainOf(chainId), n = layout.rollers.length, parts = [];
  const plate = (lenP) => {
    const r = c.ph / 2;
    const d = R.drawRoundedRectangle(lenP + 2 * r, c.ph, r - 1e-3);
    return d.sketchOnPlane("XY").extrude(c.pt);
  };
  const proto = plate(c.p);
  const roller = R.makeCylinder(c.dr / 2, c.w, [0, 0, -c.w / 2], [0, 0, 1]);
  const pin = R.makeCylinder(c.dr * 0.36, c.w + 4.4 * c.pt, [0, 0, -(c.w / 2 + 2.2 * c.pt)], [0, 0, 1]);
  for (let i = 0; i < n; i++) {
    const a = layout.rollers[i], b = layout.rollers[(i + 1) % n];
    parts.push(roller.clone().translate([a[0], a[1], zMid]));
    parts.push(pin.clone().translate([a[0], a[1], zMid]));
    const mid = mul(add(a, b), 0.5), ang = deg(Math.atan2(b[1] - a[1], b[0] - a[0]));
    // inner and outer links alternate
    const off = i % 2 ? c.w / 2 + c.pt : c.w / 2;
    for (const z of [zMid + off, zMid - off - c.pt]) parts.push(proto.clone().rotate(ang, [0, 0, 0], [0, 0, 1]).translate([mid[0], mid[1], z]));
  }
  return R.makeCompound(parts);
}
/** Belt band (land at the pulley OD, back above it) plus its teeth, from a belt layout. */
export function buildBelt(layout, beltId, width, zMid) {
  const b = beltOf(beltId);
  const loop = (o) => {
    const { c1, r1, c2, r2, up1, up2, lo1, lo2 } = layout;
    const at = (c, r, a) => add(c, pol(r + o, a));
    // S1 from its lower tangent clockwise round the far side to its upper tangent, then across, round S2 and back
    const e = [];
    e.push(arc3(at(c1, r1, lo1), at(c1, r1, layout.mid1), at(c1, r1, up1)));
    e.push(R.makeLine(P3(at(c1, r1, up1)), P3(at(c2, r2, up2))));
    e.push(arc3(at(c2, r2, up2), at(c2, r2, layout.mid2), at(c2, r2, lo2)));
    e.push(R.makeLine(P3(at(c2, r2, lo2)), P3(at(c1, r1, lo1))));
    return R.assembleWire(e);
  };
  const inner = loop(-b.pld), outer = loop(-b.pld + (b.t - b.h));
  const face = R.makeFace(outer, [R.cast(inner.wrapped.Reversed())]);
  const parts = [R.basicFaceExtrusion(face, new R.Vector([0, 0, width])).translate([0, 0, zMid - width / 2])];
  const tooth = R.makeCylinder(b.rg * 0.9, width, [0, 0, zMid - width / 2], [0, 0, 1]);
  for (const t of layout.teeth) parts.push(tooth.clone().translate([t[0], t[1], 0]));
  return R.makeCompound(parts);
}

// ---------------------------------------------------------------- layouts
/** Open-drive tangent angle (deg): the upper tangent touches both wheels at this angle (wheel 1 at the origin side). */
// (normal n of the shared tangent: n·O1 = r1 and n·O2 = n·O1 + ... gives cos θ = (r1 - r2) / C)
const tangentAngle = (r1, r2, C) => deg(Math.acos(Math.max(-1, Math.min(1, (r1 - r2) / C))));

/**
 * Chain drive: sprocket a = { center, phase (deg, seat 0), teeth, chain } and a second sprocket of nB teeth
 * about `approxC` mm away in direction `dir` (deg). Returns { center, phase, C, rollers: [[u, v]], links, ratio }.
 */
export function chainDrive(a, nB, approxC, dir = 0, { freePhase = true } = {}) {
  const c = chainOf(a.chain), p = c.p, N1 = a.teeth, N2 = Math.max(6, Math.round(nB));
  const R1 = p / (2 * Math.sin(Math.PI / N1)), R2 = p / (2 * Math.sin(Math.PI / N2));
  const s1 = 360 / N1, s2 = 360 / N2, d = rad(dir);
  const loc = (q) => [q[0] * Math.cos(-d) - q[1] * Math.sin(-d), q[0] * Math.sin(-d) + q[1] * Math.cos(-d)];
  const glob = (q) => add(a.center, [q[0] * Math.cos(d) - q[1] * Math.sin(d), q[0] * Math.sin(d) + q[1] * Math.cos(d)]);
  let phi1 = (+a.phase || 0) - dir; // seat angles in the local frame: phi1 + k s1
  const minC = R1 + R2 + p;
  const C0 = Math.max(minC, +approxC || minC * 1.5);
  // a taut chain is a convex loop walked clockwise: no link may bend the other way where a span meets a sprocket
  const cw = (prevP, at, nextP) => { const u = sub(at, prevP), v = sub(nextP, at); return u[0] * v[1] - u[1] * v[0] <= 1e-9; };
  // The discrete choices (which seat the chain leaves sprocket 1 from, links in each span, which circle
  // intersection, how many seats it wraps on sprocket 2) are fixed per candidate; for each one the closure
  // error is continuous in C, so the centre distance is found by bisection.
  const near = (a, b, tol) => { let d = wrap360(a - b); if (d > 180) d -= 360; return Math.abs(d) <= tol; };
  const ev = (C, ch) => {
    const O2 = [C, 0], tu = tangentAngle(R1, R2, C);
    const aA = phi1 + ch.kA * s1, A = pol(R1, rad(aA));
    const xs = circleX(A, ch.k * p, O2, R2).sort((u, v) => v[1] - u[1]);
    const B = xs[ch.bi];
    if (!B) return null;
    const aB = deg(Math.atan2(B[1], B[0] - C)), aB2 = aB - ch.m2 * s2, B2 = add(O2, pol(R2, rad(aB2)));
    // an open drive: leave sprocket 1 near the upper tangent, meet sprocket 2 near it, wrap its far side
    if (!near(aA, tu, 1.6 * s1) || !near(aB, tu, 1.6 * s2) || !near(aB2, -tu, 1.6 * s2)) return null;
    const ys = circleX(B2, ch.k2 * p, [0, 0], R1).sort((u, v) => u[1] - v[1]);
    const A2 = ys[ch.ai];
    if (!A2) return null;
    let aA2 = deg(Math.atan2(A2[1], A2[0])); while (aA2 <= aA) aA2 += 360;
    if (!near(aA2, -tu, 1.6 * s1)) return null;
    const steps = (aA2 - aA) / s1, n1 = Math.round(steps);
    if (n1 < 1) return null;
    const seat1 = (a) => pol(R1, rad(a)), seat2 = (a) => add(O2, pol(R2, rad(a)));
    const up = (t) => add(A, mul(sub(B, A), t)), lo = (t) => add(B2, mul(sub(A2, B2), t));
    // Chains leave and meet a sprocket at corners of its pitch polygon: at each of the four corners the span
    // must lie between the two chord directions there (convex on both sides), so it never cuts into a sprocket.
    const aA2s = aA + n1 * s1;
    if (!cw(seat1(aA + s1), A, up(1 / ch.k)) || !cw(A, up(1 / ch.k), add(up(1 / ch.k), sub(seat1(aA - s1), A))) ||
        !cw(up(1 - 1 / ch.k), B, seat2(aB - s2)) || !cw(seat2(aB + s2), B, add(B, sub(B, up(1 - 1 / ch.k)))) ||
        !cw(seat2(aB2 + s2), B2, lo(1 / ch.k2)) || !cw(B2, lo(1 / ch.k2), add(lo(1 / ch.k2), sub(seat2(aB2 - s2), B2))) ||
        !cw(lo(1 - 1 / ch.k2), A2, seat1(aA2s - s1)) || !cw(seat1(aA2s + s1), A2, add(A2, sub(A2, lo(1 - 1 / ch.k2))))) return null;
    return { C, A, aA, B, aB, B2, aB2, A2, aA2, k: ch.k, k2: ch.k2, m2: ch.m2, n1, err: steps - n1, links: n1 + ch.k + ch.m2 + ch.k2 };
  };
  const tu0 = tangentAngle(R1, R2, C0), Lt0 = Math.sqrt(C0 * C0 - (R1 - R2) ** 2);
  const kA0 = Math.round((tu0 - phi1) / s1), k0 = Math.round(Lt0 / p), m0 = Math.round((2 * tu0) / s2);
  const choices = [];
  for (const dA of [-1, 0, 1]) for (const dk of [-1, 0, 1]) for (const bi of [0, 1]) for (const dm of [-1, 0, 1]) for (const dk2 of [-1, 0, 1]) for (const ai of [0, 1])
    if (k0 + dk >= 1 && k0 + dk2 >= 1 && m0 + dm >= 1) choices.push({ kA: kA0 + dA, k: k0 + dk, bi, m2: m0 + dm, k2: k0 + dk2, ai });
  // a taut chain only fits at particular centre distances; when sprocket 1 may turn (a new drive) its angle is
  // a second unknown, so look over a range of starting angles too
  let best = null;
  const span = freePhase ? 2.5 : 6, lo = Math.max(minC, C0 - span * p), hi = C0 + span * p, n = freePhase ? 100 : 240;
  const base = phi1;
  for (const dphi of freePhase ? Array.from({ length: 16 }, (_, i) => ((i - 7.5) / 16) * s1) : [0]) {
  phi1 = base + dphi;
  for (const ch of choices) {
    let prev = ev(lo, ch);
    for (let i = 1; i <= n; i++) {
      const C = lo + ((hi - lo) * i) / n, t = ev(C, ch);
      if (prev && t && Math.sign(prev.err) !== Math.sign(t.err) && Math.abs(prev.err - t.err) < 0.5) {
        let a0 = prev.C, b0 = t.C, fa = prev.err, r = null;
        for (let it = 0; it < 60; it++) { const m = (a0 + b0) / 2, tm = ev(m, ch); if (!tm) break; r = tm; if (Math.sign(tm.err) === Math.sign(fa)) { a0 = m; fa = tm.err; } else b0 = m; }
        if (r && Math.abs(r.err) < 1e-7) {
          const score = Math.abs(r.C - C0) + (r.links % 2 ? 3 * p : 0);
          if (!best || score < best.score) best = { ...r, score, phi1 };
        }
      }
      prev = t;
    }
  }
  }
  if (!best) throw new Error("Couldn't close the chain at that distance: try a longer centre distance");
  // roller centres round the loop: S1 upper seat → upper span → S2 seats → lower span → S1 seats back up
  const r = best, rollers = [];
  for (let i = 0; i < r.k; i++) rollers.push(add(r.A, mul(sub(r.B, r.A), i / r.k)));
  for (let j = 0; j < r.m2; j++) rollers.push(add([r.C, 0], pol(R2, rad(r.aB - j * s2))));
  for (let i = 0; i < r.k2; i++) rollers.push(add(r.B2, mul(sub(r.A2, r.B2), i / r.k2)));
  for (let j = 0; j < r.n1; j++) rollers.push(pol(R1, rad(r.aA2 - j * s1)));
  return {
    center: glob([r.C, 0]), phase: wrap360(r.aB + dir), phaseA: wrap360(r.phi1 + dir), C: r.C, links: rollers.length, even: rollers.length % 2 === 0,
    rollers: rollers.map(glob), ratio: N1 / N2, length: rollers.length * p,
    wheels: [{ c: glob([0, 0]), r: R1 }, { c: glob([r.C, 0]), r: R2 }],
  };
}

/**
 * Belt drive: pulley a = { center, phase (deg, groove 0), teeth, belt } and a second pulley of nB teeth about
 * `approxC` away in direction `dir`. Returns { center, phase, C, beltTeeth, length, layout, ratio }.
 */
export function beltDrive(a, nB, approxC, dir = 0) {
  const b = beltOf(a.belt), p = b.p, N1 = a.teeth, N2 = Math.max(8, Math.round(nB));
  const R1 = (N1 * p) / (2 * Math.PI), R2 = (N2 * p) / (2 * Math.PI), d = rad(dir);
  const glob = (q) => add(a.center, [q[0] * Math.cos(d) - q[1] * Math.sin(d), q[0] * Math.sin(d) + q[1] * Math.cos(d)]);
  const pathLen = (C) => { const be = Math.asin((R1 - R2) / C); return 2 * Math.sqrt(C * C - (R1 - R2) ** 2) + R1 * (Math.PI + 2 * be) + R2 * (Math.PI - 2 * be); };
  const minC = R1 + R2 + 2 * b.t + 1, C0 = Math.max(minC, +approxC || minC * 1.5);
  const nb = Math.max(Math.ceil(pathLen(minC) / p), Math.round(pathLen(C0) / p));
  let lo = minC, hi = Math.max(C0 * 2, minC + nb * p);
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (pathLen(m) < nb * p) lo = m; else hi = m; }
  const C = (lo + hi) / 2, tu = tangentAngle(R1, R2, C), O2 = [C, 0];
  // start the pitch-line walk on a groove of pulley 1 near its far side (180°)
  const phi1 = (+a.phase || 0) - dir, s1 = 360 / N1;
  const a0 = phi1 + Math.round((180 - phi1) / s1) * s1;
  const layout = {
    c1: glob([0, 0]), r1: R1, c2: glob(O2), r2: R2, dir, tu, a0, p, dIn: b.pld + b.h - b.rg,
    up1: rad(tu + dir), up2: rad(tu + dir), lo1: rad(-tu + dir), lo2: rad(-tu + dir), mid1: rad(180 + dir), mid2: rad(dir),
  };
  const path = beltPath(layout), teeth = [];
  let phase2 = null;
  for (let i = 0; i < nb; i++) {
    const r = path.at(i * p);
    teeth.push(add(r.q, mul(r.inward, layout.dIn)));
    if (phase2 == null && r.seg === 2) phase2 = r.ang - dir; // the first tooth on pulley 2 sits in a groove
  }
  layout.teeth = teeth;
  return { center: glob(O2), phase: wrap360(phase2 + dir), C, beltTeeth: nb, length: nb * p, layout, ratio: N1 / N2 };
}

/**
 * The pitch line of a belt layout as a closed path walked clockwise from layout.a0 on pulley 1:
 * { total, at(s) -> { q, inward, seg, ang } } (global frame; ang in degrees on arcs).
 */
export function beltPath(L) {
  const C1 = L.c1, C2 = L.c2, d = L.dir || 0, tu = L.tu;
  const P = (c, r, aDeg) => add(c, pol(r, rad(aDeg + d)));
  const segs = [
    { kind: "arc", c: C1, r: L.r1, from: L.a0, sweep: -(L.a0 - tu) },
    { kind: "line", a: P(C1, L.r1, tu), b: P(C2, L.r2, tu) },
    { kind: "arc", c: C2, r: L.r2, from: tu, sweep: -2 * tu },
    { kind: "line", a: P(C2, L.r2, -tu), b: P(C1, L.r1, -tu) },
    { kind: "arc", c: C1, r: L.r1, from: 360 - tu, sweep: -((360 - tu) - L.a0) },
  ];
  for (const sg of segs) sg.len = sg.kind === "line" ? len(sub(sg.b, sg.a)) : Math.abs(rad(sg.sweep)) * sg.r;
  const total = segs.reduce((x, sg) => x + sg.len, 0);
  const at = (s) => {
    s = ((s % total) + total) % total;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      if (s <= sg.len + 1e-9 || i === segs.length - 1) {
        // walking clockwise the inside of the loop is on the right of a straight span
        if (sg.kind === "line") { const dv = unit(sub(sg.b, sg.a)); return { q: add(sg.a, mul(sub(sg.b, sg.a), Math.min(1, s / sg.len))), inward: [dv[1], -dv[0]], seg: i }; }
        const angDeg = sg.from - deg(s / sg.r);
        return { q: P(sg.c, sg.r, angDeg), inward: pol(-1, rad(angDeg + d)), seg: i, ang: angDeg + d };
      }
      s -= sg.len;
    }
    return null;
  };
  return { total, at };
}

/** Where a roller / tooth that started at loop position `i` (in pitches) is after the drive moves `shift` pitches. */
export function chainPoint(rollers, x, wheels = []) {
  const n = rollers.length, f = ((x % n) + n) % n, i = Math.floor(f), t = f - i;
  const a = rollers[i], b = rollers[(i + 1) % n];
  // between two seats of the same sprocket the roller rides the pitch circle, not the chord
  for (const w of wheels) {
    if (Math.abs(len(sub(a, w.c)) - w.r) < 1e-6 && Math.abs(len(sub(b, w.c)) - w.r) < 1e-6) {
      const t0 = Math.atan2(a[1] - w.c[1], a[0] - w.c[0]);
      let d = Math.atan2(b[1] - w.c[1], b[0] - w.c[0]) - t0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      return add(w.c, pol(w.r, t0 + d * t));
    }
  }
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
export function beltToothAt(layout, x) {
  const r = beltPath(layout).at(x * layout.p);
  return add(r.q, mul(r.inward, layout.dIn));
}

/** Faces / edges in each repeated part of a chain (roller, pin, two plates): the viewport animates them per link. */
const partCountCache = new Map();
export function chainPartCounts(chainId) {
  if (partCountCache.has(chainId)) return partCountCache.get(chainId);
  const c = chainOf(chainId);
  const roller = R.makeCylinder(c.dr / 2, c.w, [0, 0, 0], [0, 0, 1]);
  const pl = R.drawRoundedRectangle(c.p + c.ph, c.ph, c.ph / 2 - 1e-3).sketchOnPlane("XY").extrude(c.pt);
  const cnt = { roller: [roller.faces.length, roller.edges.length], pin: [roller.faces.length, roller.edges.length], plate: [pl.faces.length, pl.edges.length] };
  partCountCache.set(chainId, cnt);
  return cnt;
}
