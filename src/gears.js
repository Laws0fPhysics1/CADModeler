// Involute gears: geometry, meshing math and solids (replicad). DOM-free; tests run it in Node.
//
// Kinds:  "spur"    external gear (helical when helixAngle > 0)
//         "ring"    internal gear (teeth point inward, cut from a ring)
//         "rack"    straight rack, teeth along local +X
// Local frame of a built part: axis = +Z, faces from z = 0 to z = width. A gear's tooth 0 is
// centred on +X (a ring gear's tooth 0, the material tooth, is centred on +X too). A rack's pitch
// line is y = 0 with its teeth pointing +Y, tooth 0 centred on x = 0, running from x = 0 to its length.
//
// Standard full-depth teeth: addendum 1·m, dedendum 1.25·m, profile shift x·m. Undercut on gears
// below ~17 teeth (20°) isn't modelled: those flanks run radially below the base circle.
import * as R from "replicad";
import * as CH from "./chains.js";

export const PRESSURE_ANGLES = [14.5, 20, 25];
export const KINDS = { spur: "Spur gear", ring: "Internal (ring) gear", rack: "Rack", sprocket: "Chain sprocket", pulley: "Timing belt pulley" };
// chains and belts are parts of a drive (made with their wheels), not standalone choices
const ALL_KINDS = { ...KINDS, chain: "Roller chain", belt: "Timing belt" };
export const isWheel = (k) => k === "sprocket" || k === "pulley";
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const inv = (a) => Math.tan(a) - a;

/** Clean parameters with defaults. */
export function gearParams(p = {}) {
  const kind = ALL_KINDS[p.kind] ? p.kind : "spur";
  if (kind === "sprocket" || kind === "pulley" || kind === "chain" || kind === "belt") {
    const z = Math.max(kind === "pulley" ? 8 : 6, Math.round(+p.teeth || 18));
    return {
      kind, teeth: z, chain: CH.CHAINS[p.chain] ? p.chain : "40", belt: CH.BELTS[p.belt] ? p.belt : "GT2",
      width: +p.width > 0 ? +p.width : kind === "sprocket" ? CH.sprocketSizes({ teeth: z, chain: p.chain }).width : 6,
      bore: Math.max(0, +p.bore || 0), hubDia: Math.max(0, +p.hubDia || 0), hubLength: Math.max(0, +p.hubLength || 0),
      flanges: !!p.flanges, zMid: +p.zMid || 0,
      // module / pressure angle keep the gear code paths happy; wheels don't use them
      module: 1, pressureAngle: 20, helixAngle: 0, hand: "right", backlash: 0, shift: 0,
      ...(kind === "chain" || kind === "belt" ? { layout: p.layout, wheel: p.wheel || null } : {}),
    };
  }
  const m = Math.max(0.05, +p.module || 1);
  const z = Math.max(kind === "rack" ? 1 : 6, Math.round(+p.teeth || 20));
  return {
    kind, module: m, teeth: z,
    pressureAngle: +p.pressureAngle > 0 ? +p.pressureAngle : 20,
    width: +p.width > 0 ? +p.width : 10 * m,
    helixAngle: kind === "rack" ? 0 : Math.max(0, Math.min(45, +p.helixAngle || 0)),
    hand: p.hand === "left" ? "left" : "right",
    bore: Math.max(0, +p.bore || 0),
    hubDia: Math.max(0, +p.hubDia || 0), hubLength: Math.max(0, +p.hubLength || 0),
    rimWidth: +p.rimWidth > 0 ? +p.rimWidth : 3 * m,       // ring gears: material outside the root circle
    rackHeight: +p.rackHeight > 0 ? +p.rackHeight : 3 * m,  // racks: material below the root line
    backlash: Math.max(0, +p.backlash || 0),
    shift: +p.shift || 0,
  };
}

/** Derived sizes (mm) for a gear. */
export function gearSizes(p) {
  p = gearParams(p);
  if (p.kind === "sprocket") { const S = CH.sprocketSizes(p); return { ...S, outerRadius: S.tipRadius, rootRadius: S.pitchRadius - S.seatRadius, minTeethNoUndercut: 0 }; }
  if (p.kind === "pulley") { const S = CH.pulleySizes(p); return { ...S, outerRadius: p.flanges ? S.flangeRadius : S.tipRadius, rootRadius: S.tipRadius - S.belt.h, minTeethNoUndercut: 0 }; }
  if (p.kind === "chain" || p.kind === "belt") return { pitchRadius: 0, pitchDia: 0, tipRadius: 0, rootRadius: 0, minTeethNoUndercut: 0 };
  const { module: m, teeth: z, shift: x } = p;
  const a = rad(p.pressureAngle);
  const r = (m * z) / 2;
  const internal = p.kind === "ring";
  return {
    pitchDia: 2 * r, pitchRadius: r,
    baseRadius: r * Math.cos(a),
    // internal gears: the tip circle is inside the pitch circle
    tipRadius: internal ? r - m * (1 - x) : r + m * (1 + x),
    rootRadius: internal ? r + 1.25 * m + x * m : r - 1.25 * m + x * m,
    outerRadius: internal ? r + 1.25 * m + p.rimWidth : r + m * (1 + x),
    circularPitch: Math.PI * m,
    minTeethNoUndercut: Math.ceil(2 / Math.sin(a) ** 2),
  };
}

/**
 * Closed outline of an external tooth form (polar teeth), as [x, y] points, CCW.
 * o: { m, z, alpha (rad), ra, rf, s (tooth thickness on the pitch circle), flank (points per flank) }
 * Returns { teeth: [{ right: [...pts root->tip], tip: [a, mid, b], left: [...tip->root] , rootNext: [a, mid, b] }] }.
 */
function toothForm({ m, z, alpha, ra, rf, s, flank = 10 }) {
  const r = (m * z) / 2, rb = r * Math.cos(alpha);
  const halfAt = (rho) => s / (2 * r) + inv(alpha) - inv(Math.acos(Math.min(1, rb / rho)));
  const rStart = Math.max(rb, rf);
  let rTip = ra;
  if (halfAt(rTip) <= 0.002) { // pointed tooth: stop just below the point
    let lo = rStart, hi = ra;
    for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (halfAt(mid) > 0.002) lo = mid; else hi = mid; }
    rTip = lo;
  }
  const radii = [];
  for (let i = 0; i <= flank; i++) { const t = i / flank; radii.push(rStart + (rTip - rStart) * t * t * (2 - t)); }
  const pitchAng = (2 * Math.PI) / z;
  const P = (rho, ang) => [rho * Math.cos(ang), rho * Math.sin(ang)];
  const teeth = [];
  for (let k = 0; k < z; k++) {
    const c = k * pitchAng;
    const right = [], left = [];
    if (rf < rb) right.push(P(rf, c - halfAt(rb)));
    for (const rho of radii) right.push(P(rho, c - halfAt(rho)));
    for (const rho of [...radii].reverse()) left.push(P(rho, c + halfAt(rho)));
    if (rf < rb) left.push(P(rf, c + halfAt(rb)));
    const hT = halfAt(rTip);
    const tip = [P(rTip, c - hT), P(rTip, c), P(rTip, c + hT)];
    const a0 = c + (rf < rb ? halfAt(rb) : halfAt(rf)), a1 = c + pitchAng - (rf < rb ? halfAt(rb) : halfAt(rf));
    const rootNext = [P(rf, a0), P(rf, (a0 + a1) / 2), P(rf, a1)];
    teeth.push({ right, tip, left, rootNext });
  }
  return { teeth };
}

/** The tooth form used to cut / build a part: { form, extra } in the part's local XY. */
function formFor(p) {
  const S = gearSizes(p), m = p.module, a = rad(p.pressureAngle);
  if (p.kind === "spur") {
    const s = (Math.PI * m) / 2 + 2 * p.shift * m * Math.tan(a) - p.backlash / 2;
    return toothForm({ m, z: p.teeth, alpha: a, ra: S.tipRadius, rf: S.rootRadius, s });
  }
  // ring: the cutter is an external form whose "teeth" are the ring's tooth spaces, rotated half a pitch
  const s = (Math.PI * m) / 2 + 2 * p.shift * m * Math.tan(a) + p.backlash / 2;
  return toothForm({ m, z: p.teeth, alpha: a, ra: S.rootRadius, rf: S.tipRadius, s });
}

/** Flat point list of the outline (for previews and tests). */
export function outlinePoints(p) {
  p = gearParams(p);
  if (p.kind === "rack") return rackOutline(p);
  const { teeth } = formFor(p);
  const pts = [];
  for (const t of teeth) pts.push(...t.right, t.tip[1], ...t.left, t.rootNext[1]);
  if (p.kind === "ring") { const h = Math.PI / p.teeth; return pts.map(([x, y]) => [x * Math.cos(h) - y * Math.sin(h), x * Math.sin(h) + y * Math.cos(h)]); }
  return pts;
}

function rackOutline(p) {
  const m = p.module, a = rad(p.pressureAngle), pitch = Math.PI * m;
  const s = pitch / 2 - p.backlash / 2, ha = m, hf = 1.25 * m, t = Math.tan(a);
  const pts = [];
  // tooth k centred on x = k·pitch; outline left to right along the top, then down and back along the bottom
  const n = p.teeth;
  const xStart = -pitch / 2, xEnd = (n - 0.5) * pitch;
  pts.push([xStart, -hf]);
  for (let k = 0; k < n; k++) {
    const c = k * pitch;
    pts.push([c - s / 2 - hf * t, -hf], [c - s / 2 + ha * t, ha], [c + s / 2 - ha * t, ha], [c + s / 2 + hf * t, -hf]);
  }
  pts.push([xEnd, -hf], [xEnd, -hf - p.rackHeight], [xStart, -hf - p.rackHeight]);
  return pts;
}

// ---------------------------------------------------------------- solids
const P3 = (q) => [q[0], q[1], 0];
function flankEdge(pts) {
  return pts.length >= 3 ? R.makeBSplineApproximation(pts.map(P3), { tolerance: 1e-4, degMax: 3, degMin: 1, smoothing: null }) : R.makeLine(P3(pts[0]), P3(pts[pts.length - 1]));
}
function formWire(form) {
  const edges = [];
  for (const t of form.teeth) {
    edges.push(flankEdge(t.right));
    edges.push(R.makeThreePointArc(...t.tip.map(P3)));
    edges.push(flankEdge(t.left));
    edges.push(R.makeThreePointArc(...t.rootNext.map(P3)));
  }
  return R.assembleWire(edges);
}
function extrudeWire(wire, width, twistDeg) {
  if (Math.abs(twistDeg) > 1e-6) return R.twistExtrude(wire, twistDeg, [0, 0, 0], [0, 0, width]);
  return R.basicFaceExtrusion(R.makeFace(wire), new R.Vector([0, 0, width]));
}
/** Twist across the face width for a helical gear (degrees, + = counter-clockwise going up +Z). */
export function twistOf(p) {
  p = gearParams(p);
  if (!p.helixAngle || p.kind === "rack") return 0;
  const r = gearSizes(p).pitchRadius;
  const t = deg((p.width * Math.tan(rad(p.helixAngle))) / r);
  return p.hand === "left" ? -t : t;
}

/** Build the part in its local frame (see the header). Returns a replicad solid. */
export function buildGear(p) {
  p = gearParams(p);
  if (p.kind === "sprocket") return CH.buildSprocket(p);
  if (p.kind === "pulley") return CH.buildPulley(p);
  if (p.kind === "chain") return CH.buildChain(p.layout, p.chain, p.zMid);
  if (p.kind === "belt") return CH.buildBelt(p.layout, p.belt, p.width, p.zMid);
  const S = gearSizes(p);
  let shape;
  if (p.kind === "rack") {
    const pts = rackOutline(p);
    shape = R.basicFaceExtrusion(R.makePolygon(pts.map(P3)), new R.Vector([0, 0, p.width]));
    return shape;
  }
  const twist = twistOf(p);
  if (p.kind === "spur") {
    shape = extrudeWire(formWire(formFor(p)), p.width, twist);
    if (p.hubDia > 0 && p.hubLength > 0) shape = shape.fuse(R.makeCylinder(p.hubDia / 2, p.hubLength, [0, 0, p.width], [0, 0, 1]));
    const len = p.width + (p.hubDia > 0 ? p.hubLength : 0);
    if (p.bore > 0) shape = shape.cut(R.makeCylinder(p.bore / 2, len + 2, [0, 0, -1], [0, 0, 1]));
    return shape;
  }
  // straight ring: one face (outer disc minus the tooth outline), extruded once
  if (!twist) {
    const h = 180 / p.teeth;
    const inner = formWire(formFor(p)).rotate(h, [0, 0, 0], [0, 0, 1]);
    const outer = R.assembleWire([R.makeCircle(S.outerRadius, [0, 0, 0], [0, 0, 1])]);
    // a hole wire runs the opposite way round to the outer one
    const hole = R.cast(inner.wrapped.Reversed());
    return R.basicFaceExtrusion(R.makeFace(outer, [hole]), new R.Vector([0, 0, p.width]));
  }
  // helical ring: outer cylinder minus the twisted tooth-space cutter (a little longer so the cut is clean)
  // (the cutter starts 1 mm below z = 0, so turn it back by that much twist; then half a pitch so a ring tooth sits on +X)
  const rate = twist / p.width;
  let cutter = extrudeWire(formWire(formFor(p)), p.width + 2, rate * (p.width + 2)).translate([0, 0, -1]);
  cutter = cutter.rotate(180 / p.teeth - rate, [0, 0, 0], [0, 0, 1]);
  shape = R.makeCylinder(S.outerRadius, p.width, [0, 0, 0], [0, 0, 1]).cut(cutter);
  return shape;
}

const cache = new Map();
/** buildGear with a parameter-keyed cache (timeline replays reuse the same solid). */
export function cachedGear(p) {
  p = gearParams(p);
  const key = JSON.stringify(p);
  let s = cache.get(key);
  if (!s) {
    s = buildGear(p);
    cache.set(key, s);
    while (cache.size > 48) cache.delete(cache.keys().next().value);
  }
  return s;
}

export function gearName(p) {
  p = gearParams(p);
  if (p.kind === "sprocket") return `Sprocket ${p.teeth}T #${p.chain}`.replace("#bike", "bike").replace(/#(0\dB)/, "$1");
  if (p.kind === "pulley") return `${CH.beltOf(p.belt).label} pulley ${p.teeth}T`;
  if (p.kind === "chain") return `${CH.chainOf(p.chain).label} chain, ${p.layout ? p.layout.rollers.length : "?"} links`;
  if (p.kind === "belt") return `${CH.beltOf(p.belt).label} belt, ${p.layout ? p.layout.teeth.length : "?"}T × ${p.width} mm`;
  const m = `m${+p.module.toFixed(3)}`;
  if (p.kind === "rack") return `Rack ${m} × ${p.teeth}T`;
  return `${p.kind === "ring" ? "Ring gear" : p.helixAngle ? "Helical gear" : "Spur gear"} ${p.teeth}T ${m}`;
}

// ---------------------------------------------------------------- meshing
const wrap = (x) => x - Math.floor(x);
/**
 * Place a gear `b` so it meshes with gear `a`. Both are { kind, module, teeth, center [u, v], phase (deg) }
 * in the same frame. `dir` (deg) is the direction from a's centre to b's centre (for a ring `a`, from the
 * ring's centre toward the pinion; for a rack `b`, from the pinion's centre to the rack's pitch line).
 * Returns { center, phase } for b (a rack's "phase" is its x offset along its own +X, and it also gets
 * `rackAngle`, the direction of its +X, in degrees), plus the motion relation `ratio` (b per a: deg/deg,
 * or mm per deg for a rack) and the centre distance.
 */
export function meshWith(a, b, dir = 0) {
  const pa = gearParams(a), pb = gearParams(b);
  const m = pa.module, d = rad(dir);
  const ra = (m * pa.teeth) / 2, rbp = (m * pb.teeth) / 2;
  const pitchA = 360 / pa.teeth;
  if (pb.kind === "rack") {
    if (pa.kind !== "spur") throw new Error("A rack meshes with a spur gear");
    // rack pitch line tangent to the pinion's pitch circle at angle dir; rack +X along dir + 90
    const fA2 = wrap(((+a.phase || 0) - dir) / pitchA);
    const contact = [a.center[0] + ra * Math.cos(d), a.center[1] + ra * Math.sin(d)];
    const t = [Math.cos(d + Math.PI / 2), Math.sin(d + Math.PI / 2)];
    const pitch = Math.PI * m;
    // a pinion tooth fA2 pitches past `dir` (counter-clockwise) has moved fA2·p along +t: a rack space sits there
    const off = (0.5 + fA2) * pitch;
    // rack origin (tooth 0 at its local x = 0): start a few pitches back so the rack spans the contact
    const back = Math.floor(pb.teeth / 2) * pitch;
    const s0 = off - back;
    return {
      center: [contact[0] + t[0] * s0, contact[1] + t[1] * s0], phase: 0, rackAngle: dir + 90,
      // the rack's teeth point toward the pinion: its local +Y is -dir
      ratio: (ra * Math.PI) / 180, distance: ra,
    };
  }
  if (pa.kind === "rack") throw new Error("Pick the pinion as the gear to mesh with, not the rack");
  if (pb.module !== pa.module || pb.pressureAngle !== pa.pressureAngle) throw new Error("Meshing gears need the same module and pressure angle");
  const fA = wrap(((+a.phase || 0) - dir) / pitchA);
  const pitchB = 360 / pb.teeth;
  if (pa.kind === "ring" || pb.kind === "ring") {
    // internal pair: the ring and the pinion turn the same way; contact on the `dir` side of both centres
    const ring = pa.kind === "ring" ? pa : pb;
    const pin = pa.kind === "ring" ? pb : pa;
    if (pin.kind !== "spur") throw new Error("A ring gear meshes with a spur gear");
    if (ring.teeth - pin.teeth < 6) throw new Error("The ring needs at least 6 more teeth than the pinion");
    const dist = (m * (ring.teeth - pin.teeth)) / 2;
    if (pa.kind === "ring") {
      // b (pinion) sits toward dir from the ring centre; both have the contact at angle dir
      return { center: [a.center[0] + dist * Math.cos(d), a.center[1] + dist * Math.sin(d)], phase: dir + (0.5 + fA) * pitchB, ratio: pa.teeth / pb.teeth, distance: dist };
    }
    // a is the pinion, b the ring: the ring's centre sits opposite dir, contact at angle dir for both
    return { center: [a.center[0] - dist * Math.cos(d), a.center[1] - dist * Math.sin(d)], phase: dir + (0.5 + fA) * pitchB, ratio: pa.teeth / pb.teeth, distance: dist };
  }
  const dist = ra + rbp;
  return {
    center: [a.center[0] + dist * Math.cos(d), a.center[1] + dist * Math.sin(d)],
    phase: dir + 180 + (0.5 - fA) * pitchB,
    ratio: -pa.teeth / pb.teeth, distance: dist,
  };
}

/** Transverse contact ratio of an external or internal pair (rough check: > 1.2 runs smoothly). */
export function contactRatio(a, b) {
  const pa = gearParams(a), pb = gearParams(b);
  const sa = gearSizes(pa), sb = gearSizes(pb), al = rad(pa.pressureAngle), pbase = Math.PI * pa.module * Math.cos(al);
  if (pb.kind === "rack") {
    const len = Math.sqrt(sa.tipRadius ** 2 - sa.baseRadius ** 2) - sa.pitchRadius * Math.sin(al) + pa.module / Math.sin(al);
    return len / pbase;
  }
  if (pb.kind === "ring" || pa.kind === "ring") {
    const pin = pa.kind === "ring" ? sb : sa, ring = pa.kind === "ring" ? sa : sb;
    const C = ring.pitchRadius - pin.pitchRadius;
    const len = Math.sqrt(pin.tipRadius ** 2 - pin.baseRadius ** 2) - Math.sqrt(ring.tipRadius ** 2 - ring.baseRadius ** 2) + C * Math.sin(al);
    return len / pbase;
  }
  const C = sa.pitchRadius + sb.pitchRadius;
  const len = Math.sqrt(sa.tipRadius ** 2 - sa.baseRadius ** 2) + Math.sqrt(sb.tipRadius ** 2 - sb.baseRadius ** 2) - C * Math.sin(al);
  return len / pbase;
}
