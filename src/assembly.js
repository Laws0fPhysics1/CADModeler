// Assemblies: components (groups of timeline bodies) + joints between them, and the kinematics that
// turns them into a world transform per component / body. DOM-free and Node-testable.
// The data model and the maths are the contract in docs/assembly.md (robotexport.js builds on it too).
//
// Matrices are 4x4, column-major (three.js / WebGL order): m[col * 4 + row]. Units mm and degrees.

export const JOINT_TYPES = ["rigid", "revolute", "slider", "cylindrical", "ball"];
export const JOINT_LABELS = { rigid: "Rigid", revolute: "Revolute", slider: "Slider", cylindrical: "Cylindrical", ball: "Ball" };

// ---------------------------------------------------------------- mat4 helpers
export function identity() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
/** a · b */
export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
/** chain product mulAll(a, b, c) = a · b · c */
export function mulAll(...ms) { return ms.reduce((acc, m) => mul(acc, m), identity()); }
/** General 4x4 inverse (null if singular). */
export function invert(m) {
  const a = m, o = new Float64Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}
const rad = (deg) => (deg * Math.PI) / 180;
export function rotZ(deg) { const m = identity(), c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
export function rotX(deg) { const m = identity(), c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
export function rotY(deg) { const m = identity(), c = Math.cos(rad(deg)), s = Math.sin(rad(deg)); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
export function translation(x, y, z) { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; }
export function transZ(mm) { return translation(0, 0, mm); }
export function applyToPoint(m, p) {
  const [x, y, z] = p;
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
export function applyToDir(m, d) {
  const [x, y, z] = d;
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}
/** Copy any 16-number array-like into a Float64Array (identity when missing or malformed). */
export function toMat(a) {
  if (!a || a.length !== 16) return identity();
  const m = new Float64Array(16);
  for (let i = 0; i < 16; i++) { const v = +a[i]; if (!Number.isFinite(v)) return identity(); m[i] = v; }
  return m;
}
/** Plain array (for JSON in the document). */
export const toArray = (m) => Array.from(m, (v) => (Math.abs(v) < 1e-12 ? 0 : v));
export function isIdentity(m, eps = 1e-9) { const I = identity(); for (let i = 0; i < 16; i++) if (Math.abs(m[i] - I[i]) > eps) return false; return true; }
/** Origin and axes of a frame matrix. */
export function frameAxes(m) { return { origin: [m[12], m[13], m[14]], x: [m[0], m[1], m[2]], y: [m[4], m[5], m[6]], z: [m[8], m[9], m[10]] }; }

// small vector helpers
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Joint frame: origin, +z along zAxis, x from xHint projected onto the plane normal to z
 * (default: whichever of world X / Y / Z is least aligned with z). Right-handed.
 */
export function frameFromPoint(origin, zAxis, xHint) {
  const z = vnorm(zAxis && vlen(zAxis) > 1e-12 ? zAxis : [0, 0, 1]);
  let hint = xHint && vlen(xHint) > 1e-12 ? vnorm(xHint) : null;
  if (!hint || Math.abs(vdot(hint, z)) > 0.999) {
    const cands = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    hint = cands.reduce((best, c) => (Math.abs(vdot(c, z)) < Math.abs(vdot(best, z)) ? c : best));
  }
  const d = vdot(hint, z);
  const x = vnorm([hint[0] - d * z[0], hint[1] - d * z[1], hint[2] - d * z[2]]);
  const y = vcross(z, x);
  const m = identity();
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
  m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  m[12] = +origin[0] || 0; m[13] = +origin[1] || 0; m[14] = +origin[2] || 0;
  return m;
}

// ---------------------------------------------------------------- document model
export function emptyAssembly() { return { components: [], joints: [], links: [] }; }
export const LINK_TYPES = ["gear", "rack", "ratio"];

/** Make an assembly safe to use (old documents, hand-edited files). Returns a new object; does not prune bodies. */
export function normalizeAssembly(asm) {
  const a = asm && typeof asm === "object" ? asm : {};
  const components = (Array.isArray(a.components) ? a.components : []).filter((c) => c && c.id != null).map((c) => ({
    ...c,
    id: String(c.id),
    name: c.name || String(c.id),
    bodies: Array.isArray(c.bodies) ? c.bodies.map(String) : [],
    grounded: !!c.grounded,
    transform: c.transform && c.transform.length === 16 ? Array.from(c.transform, Number) : toArray(identity()),
    color: c.color ?? null,
  }));
  const joints = (Array.isArray(a.joints) ? a.joints : []).filter((j) => j && j.id != null).map((j) => ({
    ...j,
    id: String(j.id),
    name: j.name || String(j.id),
    type: JOINT_TYPES.includes(j.type) ? j.type : "rigid",
    parent: j.parent != null ? String(j.parent) : null,
    child: j.child != null ? String(j.child) : null,
    frameParent: j.frameParent && j.frameParent.length === 16 ? Array.from(j.frameParent, Number) : toArray(identity()),
    frameChild: j.frameChild && j.frameChild.length === 16 ? Array.from(j.frameChild, Number) : toArray(identity()),
    value: Number.isFinite(+j.value) ? +j.value : 0,
    value2: Number.isFinite(+j.value2) ? +j.value2 : 0,
    limits: { lower: numOrNull(j.limits && j.limits.lower), upper: numOrNull(j.limits && j.limits.upper) },
    effort: numOrNull(j.effort), velocity: numOrNull(j.velocity),
  }));
  // motion links (gears, rack and pinion): driven.value = offset + ratio · driver.value
  const links = (Array.isArray(a.links) ? a.links : []).filter((l) => l && l.id != null).map((l) => ({
    ...l,
    id: String(l.id), name: l.name || String(l.id),
    type: LINK_TYPES.includes(l.type) ? l.type : "ratio",
    driver: l.driver != null ? String(l.driver) : null, driven: l.driven != null ? String(l.driven) : null,
    ratio: Number.isFinite(+l.ratio) ? +l.ratio : 1, offset: Number.isFinite(+l.offset) ? +l.offset : 0,
  }));
  return { ...a, components, joints, links };
}

/**
 * Joint values set by motion links: Map<drivenJointId, value>. A joint can be driven by one link; links
 * may chain (gear trains) but not loop. Problems go into `errors` ({link, message}) and the link is skipped.
 */
export function resolveLinks(asm, errors = []) {
  const links = (asm && Array.isArray(asm.links)) ? asm.links : [];
  const joints = new Map(((asm && asm.joints) || []).map((j) => [j.id, j]));
  const byDriven = new Map(), out = new Map();
  for (const l of links) {
    const name = l.name || l.id;
    if (!joints.has(l.driver) || !joints.has(l.driven)) { errors.push({ link: l.id, message: `${name}: a joint it links is missing` }); continue; }
    if (l.driver === l.driven) { errors.push({ link: l.id, message: `${name}: links a joint to itself` }); continue; }
    if (byDriven.has(l.driven)) { errors.push({ link: l.id, message: `${name}: "${joints.get(l.driven).name}" is already driven by ${byDriven.get(l.driven).name || byDriven.get(l.driven).id}` }); continue; }
    byDriven.set(l.driven, l);
  }
  const visiting = new Set();
  const valueOf = (id) => {
    if (out.has(id)) return out.get(id);
    const j = joints.get(id), l = byDriven.get(id);
    if (!l) return clampToLimits(j.value, j.limits);
    if (visiting.has(id)) { errors.push({ link: l.id, message: `${l.name || l.id}: motion links form a loop` }); byDriven.delete(id); return clampToLimits(j.value, j.limits); }
    visiting.add(id);
    const v = clampToLimits((+l.offset || 0) + (+l.ratio || 0) * valueOf(l.driver), j.limits);
    visiting.delete(id);
    out.set(id, v);
    return v;
  };
  for (const id of [...byDriven.keys()]) valueOf(id);
  return out;
}
function numOrNull(v) { return v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v; }

export function componentOfBody(asm, bodyId) {
  if (!asm || !Array.isArray(asm.components)) return null;
  return asm.components.find((c) => Array.isArray(c.bodies) && c.bodies.includes(bodyId)) || null;
}

/** Clamp a joint value to its limits (null limit = open). */
export function clampToLimits(v, limits) {
  let x = +v || 0;
  if (limits) {
    if (limits.lower != null && Number.isFinite(+limits.lower) && x < +limits.lower) x = +limits.lower;
    if (limits.upper != null && Number.isFinite(+limits.upper) && x > +limits.upper) x = +limits.upper;
  }
  return x;
}

/** Which joint types move, and in what units. */
export function jointDofs(type) {
  switch (type) {
    case "revolute": return [{ key: "value", unit: "deg", kind: "angle" }];
    case "slider": return [{ key: "value", unit: "mm", kind: "distance" }];
    case "cylindrical": return [{ key: "value", unit: "deg", kind: "angle" }, { key: "value2", unit: "mm", kind: "distance" }];
    default: return []; // rigid; ball has no modelled motion yet
  }
}

/** Joint motion M in the joint frame (limits applied to `value`). */
export function jointMotion(j) {
  const v = clampToLimits(j.value, j.limits);
  switch (j.type) {
    case "revolute": return rotZ(v);
    case "slider": return transZ(v);
    case "cylindrical": return mul(rotZ(v), transZ(+j.value2 || 0));
    default: return identity();
  }
}

/**
 * Solve the kinematic tree.
 * Returns { transforms: Map<componentId, Float64Array(16)>, errors: [{joint?, component?, message}],
 *           values: Map<jointId, clampedValue>, badJoints: Set<jointId> }.
 * opts.bodyIds (optional): ids of bodies that exist right now; components whose bodies are all missing are reported.
 */
export function solveAssembly(asm, opts = {}) {
  const transforms = new Map(), errors = [], values = new Map(), badJoints = new Set();
  const comps = (asm && Array.isArray(asm.components)) ? asm.components : [];
  const joints = (asm && Array.isArray(asm.joints)) ? asm.joints : [];
  const byId = new Map(comps.map((c) => [c.id, c]));
  const bad = (j, message) => { errors.push({ joint: j.id, message }); badJoints.add(j.id); };

  // missing bodies (rolled back or removed in the timeline): reported, never fatal
  if (opts.bodyIds) {
    const have = new Set(opts.bodyIds);
    for (const c of comps) {
      const missing = (c.bodies || []).filter((b) => !have.has(b));
      if (missing.length && missing.length === (c.bodies || []).length) errors.push({ component: c.id, message: `${c.name || c.id}: none of its bodies exist in the timeline` });
      else if (missing.length) errors.push({ component: c.id, message: `${c.name || c.id}: ${missing.length} missing bod${missing.length === 1 ? "y" : "ies"}`, warning: true });
    }
  }

  // validate joints; each component may be the child of at most one joint
  const linked = resolveLinks(asm, errors);
  const parentJoint = new Map(); // childId -> joint
  for (const j of joints) {
    values.set(j.id, linked.has(j.id) ? linked.get(j.id) : clampToLimits(j.value, j.limits));
    if (!byId.has(j.parent)) { bad(j, `${j.name || j.id}: parent component "${j.parent}" is missing`); continue; }
    if (!byId.has(j.child)) { bad(j, `${j.name || j.id}: child component "${j.child}" is missing`); continue; }
    if (j.parent === j.child) { bad(j, `${j.name || j.id}: joins a component to itself`); continue; }
    if (byId.get(j.child).grounded) { bad(j, `${j.name || j.id}: child component "${byId.get(j.child).name}" is grounded`); continue; }
    if (parentJoint.has(j.child)) { bad(j, `${j.name || j.id}: "${byId.get(j.child).name}" already has a parent joint (${parentJoint.get(j.child).name || parentJoint.get(j.child).id})`); continue; }
    parentJoint.set(j.child, j);
  }

  // cycle detection: walk up the parent chain from each component
  for (const c of comps) {
    const seen = new Set();
    let cur = c.id;
    while (parentJoint.has(cur)) {
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = parentJoint.get(cur).parent;
    }
    if (parentJoint.has(cur) && seen.has(cur)) {
      // cur is on a loop: break it at the joint that drives cur
      const j = parentJoint.get(cur);
      bad(j, `${j.name || j.id}: joints form a loop`);
      parentJoint.delete(cur);
    }
  }

  // evaluate (memoised recursion; the loop check above guarantees termination)
  const world = (id) => {
    if (transforms.has(id)) return transforms.get(id);
    const c = byId.get(id);
    const j = parentJoint.get(id);
    let T;
    if (!j) T = toMat(c.transform);
    else T = mulAll(world(j.parent), toMat(j.frameParent), jointMotion(linked.has(j.id) ? { ...j, value: linked.get(j.id) } : j), invert(toMat(j.frameChild)) || identity());
    transforms.set(id, T);
    return T;
  };
  for (const c of comps) world(c.id);
  return { transforms, errors, values, badJoints };
}

/** World transform for each body id (identity if the body is in no component). */
export function bodyTransforms(asm, bodyIds, solved = null) {
  const s = solved || solveAssembly(asm);
  const out = new Map();
  for (const b of bodyIds || []) {
    const c = componentOfBody(asm, b);
    out.set(b, c && s.transforms.has(c.id) ? s.transforms.get(c.id) : identity());
  }
  return out;
}

/** Ids of the components below `compId` in the joint tree (not including it). */
export function descendants(asm, compId) {
  const out = new Set(), joints = (asm && asm.joints) || [];
  const stack = [compId];
  while (stack.length) {
    const p = stack.pop();
    for (const j of joints) if (j.parent === p && !out.has(j.child) && j.child !== compId) { out.add(j.child); stack.push(j.child); }
  }
  return out;
}

/** The joint (if any) whose child is compId. */
export function parentJointOf(asm, compId) { return ((asm && asm.joints) || []).find((j) => j.child === compId) || null; }

/** Next free id with a prefix ("c" -> c1, c2 ...). */
export function nextId(list, prefix) {
  let n = 1;
  const used = new Set((list || []).map((x) => x.id));
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Add a component made of bodyIds (removing them from any other component). Mutates asm; returns the component.
 * placement: initial transform (defaults to identity).
 */
export function addComponent(asm, bodyIds, { name, grounded = false, transform = null, id = null } = {}) {
  const ids = [...new Set(bodyIds.map(String))];
  for (const c of asm.components) c.bodies = c.bodies.filter((b) => !ids.includes(b));
  const cid = id || nextId(asm.components, "c");
  const comp = { id: cid, name: name || `Component${cid.replace(/^c/, "")}`, bodies: ids, grounded: !!grounded, transform: transform ? toArray(toMat(transform)) : toArray(identity()), color: null };
  asm.components.push(comp);
  return comp;
}

/** Remove a component (its bodies stay in the design) and every joint that references it. Mutates asm. */
export function removeComponent(asm, compId) {
  asm.components = asm.components.filter((c) => c.id !== compId);
  asm.joints = asm.joints.filter((j) => j.parent !== compId && j.child !== compId);
}

/**
 * Bake the solved world transform into every component's `transform` (so deleting a joint or ungrounding
 * leaves parts where they are). Mutates asm.
 */
export function bakeTransforms(asm, ids = null) {
  const s = solveAssembly(asm);
  for (const c of asm.components) if (!ids || ids.includes(c.id)) { const T = s.transforms.get(c.id); if (T) c.transform = toArray(T); }
}

// ---------------------------------------------------------------- snapping joint origins to geometry
// Works on replicad shapes (only edge.pointAt / startPoint / endPoint / geomType and face.center / normalAt /
// edges are used), all in the body's modelled coordinates.
const tup = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Circle through three points of a circular edge: { center, axis, radius } or null. */
export function circleOfEdge(edge) {
  const [a, b, c] = [0, 1 / 3, 2 / 3].map((t) => tup(edge.pointAt(t)));
  const ab = vsub(b, a), ac = vsub(c, a);
  const n = vcross(ab, ac);
  const nn = vdot(n, n);
  if (nn < 1e-18) return null;
  const t1 = vcross(n, ab).map((x) => x * vdot(ac, ac)), t2 = vcross(ac, n).map((x) => x * vdot(ab, ab));
  const center = a.map((x, i) => x + (t1[i] + t2[i]) / (2 * nn));
  return { center, axis: vnorm(n), radius: vdist(center, a) };
}
/** Outward normal of a planar face of `shape` that contains the circle, or null. */
// planar faces of a shape as { n, c } (normal, centroid): computing every face's centroid on each
// joint hover took ~150 ms on a 1,700-face STEP import (bug report 2026-10-18 15:32)
const planeCache = new WeakMap();
function planarFaces(shape) {
  let list = planeCache.get(shape);
  if (!list) {
    list = [];
    for (const face of shape.faces) {
      if (face.geomType !== "PLANE") continue;
      const c = tup(face.center);
      list.push({ n: vnorm(tup(face.normalAt(face.center))), c });
    }
    planeCache.set(shape, list);
  }
  return list;
}
export function outwardNormalAt(shape, center, axis) {
  for (const { n, c } of planarFaces(shape)) {
    if (Math.abs(vdot(n, axis)) < 0.999) continue;
    if (Math.abs(vdot(vsub(center, c), n)) > 1e-3) continue;
    return n;
  }
  return null;
}
/**
 * Joint origin from a pick { kind: "edge" | "face", idx, localPoint? } on `shape`:
 *   circular edge  -> centre, axis = outward normal of the face it bounds (else the circle axis)
 *   cylindrical face -> the rim nearest localPoint: centre + outward axis
 *   planar face    -> face centre + normal
 *   straight edge  -> nearest of midpoint / start vertex / end vertex, axis along the edge
 *   other faces    -> localPoint + surface normal
 * Returns { origin, z, what } or null.
 */
export function snapToGeometry(shape, it) {
  const lp = it.localPoint || null;
  const near = (pts) => (lp ? pts.reduce((a, b) => (vdist(b[0], lp) < vdist(a[0], lp) ? b : a)) : pts[0]);
  try {
    if (it.kind === "edge") {
      const e = shape.edges[it.idx];
      if (!e) return null;
      if (e.geomType === "CIRCLE") {
        const c = circleOfEdge(e);
        if (c) return { origin: c.center, z: outwardNormalAt(shape, c.center, c.axis) || c.axis, what: "circle centre" };
      }
      const a = tup(e.startPoint), b = tup(e.endPoint), m = tup(e.pointAt(0.5));
      const d = vsub(b, a);
      const [p, what] = near([[m, "edge midpoint"], [a, "vertex"], [b, "vertex"]]);
      return { origin: p, z: vlen(d) > 1e-9 ? vnorm(d) : [0, 0, 1], what };
    }
    if (it.kind === "face") {
      const f = shape.faces[it.idx];
      if (!f) return null;
      if (f.geomType === "PLANE") return { origin: tup(f.center), z: vnorm(tup(f.normalAt(f.center))), what: "face centre" };
      if (f.geomType === "CYLINDRE") {
        const rims = f.edges.filter((e) => e.geomType === "CIRCLE").map(circleOfEdge).filter(Boolean);
        if (rims.length) {
          const [, c] = near(rims.map((r) => [r.center, r]));
          return { origin: c.center, z: outwardNormalAt(shape, c.center, c.axis) || c.axis, what: "axis" };
        }
      }
      const p = lp || tup(f.center);
      let n;
      try { n = vnorm(tup(f.normalAt(p))); } catch (e) { n = vnorm(tup(f.normalAt(f.center))); }
      return { origin: p, z: n, what: "point" };
    }
  } catch (e) { /* fall through */ }
  return null;
}
