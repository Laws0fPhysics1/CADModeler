// Robot export: turns the assembly (docs/assembly.md) into a robot package for
// NVIDIA Isaac Sim / Isaac Lab: robot.usda (UsdPhysics articulation with embedded
// meshes), robot.urdf + meshes/, and README.txt. DOM-free and Node-testable.
// Format, frame conventions and validation status: docs/robot-export.md.
//
//   const pkg = buildRobot(doc, state, { name: "arm", formats: ["usd", "urdf"] });
//   pkg.files  -> { "robot.usda": string, "robot.urdf": string, "meshes/x.obj": string|Uint8Array, "README.txt": string }
//
// Frames: every link frame is the joint frame of the joint that drives it
// (frameChild, in the component's modelled coordinates); root links use the
// component's modelled origin. Everything is written in metres, kilograms and
// seconds with Z up. The package is exported in the ZERO configuration (all joint
// values 0); the current values go into README.txt's Isaac Lab init_state.
import * as R from "replicad";
import { getMaterial, resolveAppearance } from "./materials.js";

export const DEFAULT_DENSITY = 2700; // kg/m^3, aluminium: used for bodies with no appearance/material
export const MESH_QUALITY = {
  coarse: { tolerance: 0.1, angularTolerance: 0.5 },
  medium: { tolerance: 0.05, angularTolerance: 0.3 },
  fine: { tolerance: 0.01, angularTolerance: 0.15 },
};
export const DEFAULTS = {
  name: "robot",
  formats: ["usd", "urdf"],     // any of "usd", "urdf"
  meshFormat: "obj",            // URDF mesh files: "obj" (with .mtl) or "stl" (binary)
  quality: "medium",
  collision: "convexHull",      // USD physics:approximation: convexHull | convexDecomposition | boundingCube | meshSimplification | none
  fixedBase: null,              // null = from the assembly (grounded root -> fixed), true / false to force
  angularStiffness: 100,        // N·m/rad   (USD writes per degree, see below)
  angularDamping: 10,           // N·m·s/rad
  linearStiffness: 1000,        // N/m
  linearDamping: 100,           // N·s/m
  defaultEffort: 100,           // N·m or N, when a joint has no effort
  defaultVelocity: null,        // rad/s or m/s; null -> 2π rad/s and 1 m/s
  physicsScene: false,          // add a /physicsScene prim (outside the robot prim)
  dummyMass: 0.001,             // kg, for the intermediate links of cylindrical / ball joints and empty links
  includeHidden: false,         // bodies that belong to no component and are hidden are skipped unless true
};

// ---------------- 4x4 matrices (column-major, like docs/assembly.md) ----------------
export const M4 = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
  // rigid-transform inverse (rotation + translation)
  invert(m) {
    const o = M4.identity();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
    return o;
  },
  rotZ(deg) { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  transZ(mm) { const m = M4.identity(); m[14] = mm; return m; },
  apply(m, p) { return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]); },
  applyDir(m, v) { return [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]); },
  rot3(m) { return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]]; }, // row-major 3x3
  pos(m) { return [m[12], m[13], m[14]]; },
  of(v) { return Array.isArray(v) || ArrayBuffer.isView(v) ? (v.length === 16 ? Array.from(v, Number) : null) : null; },
};
const clampV = (v, lo, hi) => { let x = +v || 0; if (lo != null && x < lo) x = lo; if (hi != null && x > hi) x = hi; return x; };
const valid16 = (v) => { const m = M4.of(v); return m && m.every(Number.isFinite) ? m : null; };

/** Joint motion M(joint) per the contract (values in degrees / mm). */
function motion(j, value = j.value || 0, value2 = j.value2 || 0) {
  if (j.type === "revolute") return M4.rotZ(value);
  if (j.type === "slider") return M4.transZ(value);
  if (j.type === "cylindrical") return M4.mul(M4.rotZ(value), M4.transZ(value2));
  return M4.identity();
}

/**
 * Component world transforms, as in docs/assembly.md (self-contained copy of
 * assembly.js's solveAssembly so the export works on its own). zero: evaluate
 * with every joint value at 0.
 */
export function solveTransforms(asm, { zero = false } = {}) {
  const comps = new Map((asm.components || []).map((c) => [c.id, c]));
  const childJoint = new Map();
  for (const j of asm.joints || []) if (comps.has(j.parent) && comps.has(j.child) && !childJoint.has(j.child)) childJoint.set(j.child, j);
  const out = new Map(), busy = new Set(), errors = [];
  const T = (id) => {
    if (out.has(id)) return out.get(id);
    const c = comps.get(id);
    let t = valid16(c.transform) || M4.identity();
    const j = childJoint.get(id);
    if (j && !c.grounded) {
      if (busy.has(id)) { errors.push({ joint: j.id, message: "joint loop" }); return t; }
      busy.add(id);
      const fp = valid16(j.frameParent) || M4.identity(), fc = valid16(j.frameChild) || M4.identity();
      t = M4.mul(M4.mul(M4.mul(T(j.parent), fp), zero ? M4.identity() : motion(j)), M4.invert(fc));
      busy.delete(id);
    }
    out.set(id, t);
    return t;
  };
  for (const id of comps.keys()) T(id);
  return { transforms: out, errors };
}

// ---------------- small linear algebra ----------------
const mat3mul = (a, b) => a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
const transpose = (a) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[c][r]));
const det3 = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);

/** Jacobi eigen-decomposition of a symmetric 3x3: { values: [3], vectors: 3x3 row-major whose COLUMNS are the eigenvectors, det +1 }. */
export function eigenSym3(A) {
  const a = A.map((r) => r.slice());
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    const scale = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 || 1;
    if (off <= 1e-30 * scale) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  if (det3(v) < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/** Rotation matrix (row-major 3x3) -> unit quaternion [w, x, y, z]. */
export function quatFromMat3(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4; }
  const n = Math.hypot(w, x, y, z) || 1;
  const q = [w / n, x / n, y / n, z / n];
  return q[0] < 0 ? q.map((c) => -c) : q;
}

/** URDF roll-pitch-yaw (fixed axes X, Y, Z: R = Rz(yaw)·Ry(pitch)·Rx(roll)) from a row-major rotation. */
export function rpyFromMat3(m) {
  const cp = Math.hypot(m[0][0], m[1][0]);
  if (cp > 1e-9) return [Math.atan2(m[2][1], m[2][2]), Math.atan2(-m[2][0], cp), Math.atan2(m[1][0], m[0][0])];
  return [Math.atan2(-m[1][2], m[1][1]), Math.atan2(-m[2][0], cp), 0];
}

// ---------------- mass properties (OCCT GProp) ----------------
/**
 * Volume properties of a replicad shape with density 1: { volume (mm^3), com [mm], inertia (3x3 tensor
 * about the COM, mm^5, modelled axes) }. OCCT's MatrixOfInertia returns a gp_Mat, which this WASM build
 * does not bind, so the tensor is assembled from six MomentOfInertia(axis through the COM) queries:
 * I_uu = u·I·u, and for u = (e_i + e_j)/√2, I_ij = I_uu − (I_ii + I_jj)/2.
 */
export function volumeProperties(shape) {
  const oc = R.getOC();
  const props = new oc.GProp_GProps();
  const trash = [props];
  try {
    oc.BRepGProp.VolumeProperties(shape.wrapped || shape, props, false, false, false);
    const volume = props.Mass();
    const c = props.CentreOfMass(); trash.push(c);
    const com = [c.X(), c.Y(), c.Z()];
    const moment = (x, y, z) => {
      const d = new oc.gp_Dir(x, y, z), ax = new oc.gp_Ax1(c, d);
      trash.push(d, ax);
      return props.MomentOfInertia(ax);
    };
    const s = Math.SQRT1_2;
    const Ixx = moment(1, 0, 0), Iyy = moment(0, 1, 0), Izz = moment(0, 0, 1);
    const Ixy = moment(s, s, 0) - (Ixx + Iyy) / 2, Ixz = moment(s, 0, s) - (Ixx + Izz) / 2, Iyz = moment(0, s, s) - (Iyy + Izz) / 2;
    return { volume, com, inertia: [[Ixx, Ixy, Ixz], [Ixy, Iyy, Iyz], [Ixz, Iyz, Izz]] };
  } finally {
    for (const o of trash) try { o.delete(); } catch {}
  }
}

/** Density in kg/m^3 for a body: its appearance's material, else DEFAULT_DENSITY (aluminium). */
export function bodyDensity(doc, bodyId, fallback = DEFAULT_DENSITY) {
  const app = doc && doc.appearances && doc.appearances[bodyId];
  if (!app || !app.materialId) return fallback;
  const d = getMaterial(app.materialId)?.physical?.density_kg_m3;
  return d > 0 ? d : fallback;
}

/**
 * Combine bodies into one link's mass properties, expressed in the link frame.
 * parts: [{ props: volumeProperties(), density }], invF: modelled coords -> link frame (mm).
 * Returns { mass kg, com [m], inertia 3x3 kg·m² about the COM in link axes }.
 */
export function combineMass(parts, invF) {
  const Rl = M4.rot3(invF);
  let mass = 0, sum = [0, 0, 0];
  const items = parts.map(({ props, density }) => {
    const m = props.volume * 1e-9 * density;
    const c = M4.apply(invF, props.com).map((x) => x * 1e-3);
    const I = mat3mul(mat3mul(Rl, props.inertia.map((r) => r.map((x) => x * density * 1e-15))), transpose(Rl));
    mass += m; for (let k = 0; k < 3; k++) sum[k] += m * c[k];
    return { m, c, I };
  });
  const com = mass > 0 ? sum.map((x) => (Math.abs(x / mass) < 1e-12 ? 0 : x / mass)) : [0, 0, 0];
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const it of items) {
    const d = [0, 1, 2].map((k) => it.c[k] - com[k]), d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) I[r][c] += it.I[r][c] + it.m * ((r === c ? d2 : 0) - d[r] * d[c]);
  }
  return { mass, com, inertia: I };
}

// ---------------- names & formatting ----------------
const num = (x, p = 7) => { if (!Number.isFinite(x)) return "0"; const s = String(+(+x).toPrecision(p)); return s === "-0" ? "0" : s; };
const tuple = (a, p) => `(${a.map((x) => num(x, p)).join(", ")})`;
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
export function safeName(s, fallback = "item") {
  let n = String(s || "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!n) n = fallback;
  if (/^[0-9]/.test(n)) n = "_" + n;
  return n.slice(0, 60);
}
function uniqueNamer() {
  const used = new Set();
  return (s, fallback) => {
    const base = safeName(s, fallback);
    let n = base, i = 2;
    while (used.has(n.toLowerCase())) n = `${base}_${i++}`;
    used.add(n.toLowerCase());
    return n;
  };
}
const hexRgb = (hex) => { const h = (hex || "#c9ced4").replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ---------------- the robot model (topology + frames, no meshes) ----------------
/**
 * Resolve the assembly into links and joints (no meshing or mass yet; cheap, used for the dialog summary).
 * Returns { links: [{name, compId, bodyIds, F, world0, dummy}], joints: [{name, type, parent, child, origin, axis, lower, upper,
 *   effort, velocity, value, sourceId}], fixedBase, rootLink, warnings, single }.
 * Units: F / world0 / origin in mm (modelled coords); lower/upper/value in rad (revolute) or m (prismatic).
 */
export function describeRobot(doc, state, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const warnings = [];
  const asm = doc && doc.assembly && Array.isArray(doc.assembly.components) ? doc.assembly : { components: [], joints: [] };
  const bodies = (state && state.bodies) || [];
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const hidden = new Set((doc && doc.hidden) || []);
  const linkName = uniqueNamer(), jointName = uniqueNamer();
  const links = [], joints = [];
  const defVel = (prismatic) => (o.defaultVelocity > 0 ? o.defaultVelocity : prismatic ? 1 : 2 * Math.PI);

  // body ownership: first component listing a body wins
  const owner = new Map();
  for (const c of asm.components) for (const id of c.bodies || []) {
    if (!byId.has(id)) { warnings.push(`Component "${c.name || c.id}" lists body ${id}, which does not exist; skipped.`); continue; }
    if (owner.has(id)) { warnings.push(`Body ${id} is in more than one component; kept in the first.`); continue; }
    owner.set(id, c.id);
  }
  const loose = bodies.filter((b) => !owner.has(b.id) && (o.includeHidden || !(hidden.has(b.id) || hidden.has("bodies"))));
  const single = !asm.components.length;

  const { transforms } = solveTransforms(asm, { zero: true });
  const comps = asm.components;
  const compById = new Map(comps.map((c) => [c.id, c]));
  const jointsIn = (asm.joints || []).filter((j) => {
    const ok = compById.has(j.parent) && compById.has(j.child) && j.parent !== j.child;
    if (!ok) warnings.push(`Joint "${j.name || j.id}" does not connect two existing components; skipped.`);
    return ok;
  });
  const childJoint = new Map();
  for (const j of jointsIn) {
    if (compById.get(j.child).grounded) { warnings.push(`Joint "${j.name || j.id}" drives a grounded component ("${compById.get(j.child).name}"); skipped, as in assembly.js.`); continue; }
    if (childJoint.has(j.child)) { warnings.push(`Component "${compById.get(j.child).name}" is the child of more than one joint; "${j.name || j.id}" skipped.`); continue; }
    childJoint.set(j.child, j);
  }
  // drop joints that close a loop
  for (const [child, j] of [...childJoint]) {
    const seen = new Set([child]);
    let p = j.parent;
    while (childJoint.has(p) && !seen.has(p)) { seen.add(p); p = childJoint.get(p).parent; }
    if (seen.has(p)) { warnings.push(`Joint "${j.name || j.id}" closes a loop; skipped (robot export needs a tree).`); childJoint.delete(child); }
  }

  const linkOf = new Map(); // compId -> link
  const addLink = (compId, label, bodyIds, F, world0, dummy = false) => {
    const l = { name: linkName(label, "link"), compId, bodyIds, F, world0, dummy };
    links.push(l);
    if (compId) linkOf.set(compId, l);
    return l;
  };
  const rootComps = comps.filter((c) => !childJoint.has(c.id));
  const compBodies = (c) => bodies.filter((b) => owner.get(b.id) === c.id).map((b) => b.id);

  let rootLink, fixedBase;
  if (single) {
    rootLink = addLink(null, "base_link", loose.map((b) => b.id), M4.identity(), M4.identity());
    fixedBase = true;
  } else if (!loose.length && rootComps.length === 1) {
    const c = rootComps[0];
    rootLink = addLink(c.id, c.name || c.id, compBodies(c), M4.identity(), transforms.get(c.id));
    fixedBase = !!c.grounded;
  } else {
    rootLink = addLink(null, "base_link", loose.map((b) => b.id), M4.identity(), M4.identity());
    fixedBase = true;
    for (const c of rootComps) {
      if (!c.grounded) warnings.push(`Free component "${c.name || c.id}" is welded to base_link with a fixed joint.`);
      const l = addLink(c.id, c.name || c.id, compBodies(c), M4.identity(), transforms.get(c.id));
      joints.push({ name: jointName(`${l.name}_fixed`), type: "fixed", parent: rootLink.name, child: l.name, origin: transforms.get(c.id), axis: [0, 0, 1], sourceId: null });
    }
  }
  if (o.fixedBase === true || o.fixedBase === false) fixedBase = o.fixedBase;

  // breadth-first over the joint tree so parents exist before children
  const queue = rootComps.map((c) => c.id);
  while (queue.length) {
    const pid = queue.shift();
    for (const [cid, j] of childJoint) {
      if (j.parent !== pid) continue;
      queue.push(cid);
      const parent = linkOf.get(pid), c = compById.get(cid);
      const fp = valid16(j.frameParent) || M4.identity(), fc = valid16(j.frameChild) || M4.identity();
      const origin = M4.mul(M4.invert(parent.F), fp); // joint frame in the parent LINK frame (mm)
      const jointWorld = M4.mul(parent.world0, origin);
      const base = j.name || j.id || "joint";
      const lim = j.limits || {};
      const lo = Number.isFinite(lim.lower) ? lim.lower : null, hi = Number.isFinite(lim.upper) ? lim.upper : null;
      const effort = j.effort > 0 ? j.effort : o.defaultEffort;
      const degVel = j.velocity > 0 ? (j.velocity * Math.PI) / 180 : defVel(false);
      const mmVel = j.velocity > 0 ? j.velocity / 1000 : defVel(true);
      const D2R = Math.PI / 180;
      const rev = (name, parentName, childName, org, axis, value, lower, upper) => {
        const limited = lower != null && upper != null;
        if (!limited && (lower != null || upper != null)) warnings.push(`Joint "${base}" has only one limit; exported as continuous.`);
        joints.push({ name, type: limited ? "revolute" : "continuous", parent: parentName, child: childName, origin: org, axis,
          lower: limited ? Math.min(lower, upper) * D2R : null, upper: limited ? Math.max(lower, upper) * D2R : null,
          effort, velocity: degVel, value: clampV(value, lower, upper) * D2R, sourceId: j.id });
      };
      const pri = (name, parentName, childName, org, value, lower, upper) => {
        let lw = lower, up = upper;
        if (lw == null || up == null) { warnings.push(`Slider "${base}" has no limits; URDF gets ±10 m, USD is left unlimited.`); }
        joints.push({ name, type: "prismatic", parent: parentName, child: childName, origin: org, axis: [0, 0, 1],
          lower: lw != null && up != null ? Math.min(lw, up) / 1000 : null, upper: lw != null && up != null ? Math.max(lw, up) / 1000 : null,
          effort, velocity: mmVel, value: clampV(value, lower, upper) / 1000, sourceId: j.id });
      };
      const childLink = () => addLink(cid, c.name || cid, compBodies(c), fc, jointWorld);
      if (j.type === "revolute") { const l = childLink(); rev(jointName(base), parent.name, l.name, origin, [0, 0, 1], j.value, lo, hi); }
      else if (j.type === "slider") { const l = childLink(); pri(jointName(base), parent.name, l.name, origin, j.value, lo, hi); }
      else if (j.type === "cylindrical") {
        const mid = addLink(null, `${c.name || cid}_cyl`, [], null, jointWorld, true);
        const l = childLink();
        rev(jointName(`${base}_rot`), parent.name, mid.name, origin, [0, 0, 1], j.value, lo, hi);
        pri(jointName(`${base}_slide`), mid.name, l.name, M4.identity(), j.value2, null, null);
      } else if (j.type === "ball") {
        const mx = addLink(null, `${c.name || cid}_ball_x`, [], null, jointWorld, true);
        const my = addLink(null, `${c.name || cid}_ball_y`, [], null, jointWorld, true);
        const l = childLink();
        rev(jointName(`${base}_x`), parent.name, mx.name, origin, [1, 0, 0], 0, null, null);
        rev(jointName(`${base}_y`), mx.name, my.name, M4.identity(), [0, 1, 0], 0, null, null);
        rev(jointName(`${base}_z`), my.name, l.name, M4.identity(), [0, 0, 1], 0, null, null);
      } else {
        if (j.type !== "rigid") warnings.push(`Joint "${base}" has unknown type "${j.type}"; exported as fixed.`);
        const l = childLink();
        joints.push({ name: jointName(base), type: "fixed", parent: parent.name, child: l.name, origin, axis: [0, 0, 1], sourceId: j.id });
      }
    }
  }
  // motion links (gears, rack and pinion) become URDF mimic joints: driven = multiplier · driver + offset
  for (const lk of asm.links || []) {
    const dj = joints.find((x) => x.sourceId === lk.driven && x.type !== "fixed"), sj = joints.find((x) => x.sourceId === lk.driver && x.type !== "fixed");
    if (!dj || !sj) { warnings.push(`Motion link "${lk.name || lk.id}" skipped: one of its joints isn't exported as a moving joint.`); continue; }
    const unit = (t) => (t === "prismatic" ? 1e-3 : Math.PI / 180); // CAD deg / mm -> rad / m
    dj.mimic = { joint: sj.name, multiplier: ((+lk.ratio || 0) * unit(dj.type)) / unit(sj.type), offset: (+lk.offset || 0) * unit(dj.type) };
  }
  if (joints.some((j) => j.mimic)) warnings.push("Gear / rack motion links are written as URDF <mimic> joints; the USD file leaves them as independent joints.");
  if (!links.some((l) => l.bodyIds.length)) warnings.push("The robot has no bodies.");
  if (single) warnings.push("No assembly yet: all visible bodies are exported as one fixed link (base_link).");
  return { links, joints, fixedBase, rootLink: rootLink.name, warnings, single, options: o };
}

// ---------------- meshes ----------------
function meshInLink(body, invF, quality) {
  const q = MESH_QUALITY[quality] || MESH_QUALITY.medium;
  // modeled threads: mesh at their display tolerance (half of it gives ~150k triangles per M6 bolt)
  const tol = body.meshTol ? { tolerance: Math.max(q.tolerance, body.meshTol * (quality === "coarse" ? 2 : 1)), angularTolerance: Math.max(q.angularTolerance, 0.5) } : q;
  const m = body.shape.mesh(tol);
  const n = m.vertices.length / 3;
  const points = new Float64Array(n * 3), normals = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = M4.apply(invF, [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]]);
    const v = M4.applyDir(invF, [m.normals[3 * i] || 0, m.normals[3 * i + 1] || 0, m.normals[3 * i + 2] || 0]);
    for (let k = 0; k < 3; k++) { points[3 * i + k] = p[k] * 1e-3; normals[3 * i + k] = v[k]; }
  }
  return { points, normals, triangles: Uint32Array.from(m.triangles) };
}

function objText(mesh, objName, mtlFile, mtlName) {
  const out = [`# CAD Modeler robot export (metres, link frame)`, `mtllib ${mtlFile}`, `o ${objName}`];
  const P = mesh.points, N = mesh.normals, T = mesh.triangles;
  for (let i = 0; i < P.length; i += 3) out.push(`v ${num(P[i])} ${num(P[i + 1])} ${num(P[i + 2])}`);
  for (let i = 0; i < N.length; i += 3) out.push(`vn ${num(N[i], 5)} ${num(N[i + 1], 5)} ${num(N[i + 2], 5)}`);
  out.push(`usemtl ${mtlName}`);
  for (let i = 0; i < T.length; i += 3) { const a = T[i] + 1, b = T[i + 1] + 1, c = T[i + 2] + 1; out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`); }
  return out.join("\n") + "\n";
}
function mtlText(mtlName, rgb) {
  return `# CAD Modeler robot export\nnewmtl ${mtlName}\nKd ${rgb.map((x) => num(x, 4)).join(" ")}\nKa 0 0 0\nKs 0.2 0.2 0.2\nNs 50\nd 1\nillum 2\n`;
}
function stlBytes(mesh, header) {
  const T = mesh.triangles, P = mesh.points, n = T.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) & 0x7f : 32);
  dv.setUint32(80, n, true);
  let o = 84;
  const p = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
  for (let t = 0; t < T.length; t += 3) {
    const a = p(T[t]), b = p(T[t + 1]), c = p(T[t + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let nr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...nr) || 1; nr = nr.map((x) => x / l);
    for (const x of [nr, a, b, c]) for (let k = 0; k < 3; k++) { dv.setFloat32(o, x[k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Uint8Array(buf);
}

// ---------------- build ----------------
/**
 * Build the robot package in memory.
 * @param {object} doc    the design document (doc.assembly per docs/assembly.md, doc.appearances, doc.hidden)
 * @param {object} state  kernel state (state.bodies: [{ id, name, shape, meshTol? }])
 * @param {object} [opts] see DEFAULTS
 * @returns {{ name, files: Object<string, string|Uint8Array>, links, joints, fixedBase, warnings, summary }}
 */
export function buildRobot(doc, state, opts = {}) {
  const model = describeRobot(doc, state, opts);
  const o = model.options;
  const name = safeName(o.name || (doc && doc.name) || "robot", "robot");
  const formats = new Set((o.formats && o.formats.length ? o.formats : ["usd", "urdf"]).map((f) => String(f).toLowerCase()));
  const byId = new Map(((state && state.bodies) || []).map((b) => [b.id, b]));
  const warnings = model.warnings.slice();
  const files = {};
  const bodyName = uniqueNamer();

  // per link: mass properties and per-body meshes in the link frame
  const links = model.links.map((l) => {
    const F = l.F || M4.identity();
    const invF = M4.invert(F);
    const parts = [], visuals = [];
    for (const id of l.bodyIds) {
      const b = byId.get(id);
      let props = null;
      try { props = volumeProperties(b.shape); } catch (e) { warnings.push(`Mass properties of ${b.name || id} failed (${e.message || e}).`); }
      const density = bodyDensity(doc, id, o.defaultDensity > 0 ? o.defaultDensity : DEFAULT_DENSITY);
      if (props && props.volume > 0) parts.push({ props, density });
      else if (props) warnings.push(`${b.name || id} has no closed volume; it adds no mass.`);
      const app = resolveAppearance(doc && doc.appearances && doc.appearances[id]);
      let mesh;
      try { mesh = meshInLink(b, invF, o.quality); } catch (e) { warnings.push(`Meshing ${b.name || id} failed (${e.message || e}); left out.`); continue; }
      visuals.push({ bodyId: id, name: bodyName(`${l.name}__${b.name || id}`, "body"), label: b.name || id, color: app.color,
        metalness: app.renderParams.metalness ?? 0, roughness: app.renderParams.roughness ?? 0.5, mesh });
    }
    let mp = parts.length ? combineMass(parts, invF) : null;
    if (!mp || !(mp.mass > 0)) {
      const m = o.dummyMass, I = m * 1e-4; // a 1 cm-ish point mass: PhysX articulation links need positive mass
      mp = { mass: m, com: [0, 0, 0], inertia: [[I, 0, 0], [0, I, 0], [0, 0, I]], dummy: true };
    }
    const eig = eigenSym3(mp.inertia);
    return { ...l, invF, visuals, mass: mp.mass, com: mp.com, inertia: mp.inertia, massless: !!mp.dummy,
      principal: eig.values.map((v) => Math.max(v, 1e-12)), principalAxes: quatFromMat3(eig.vectors) };
  });
  const linkByName = new Map(links.map((l) => [l.name, l]));

  // ---- materials (one per distinct colour + finish) ----
  const mats = new Map();
  for (const l of links) for (const v of l.visuals) {
    const key = `${v.color}|${num(v.metalness, 2)}|${num(v.roughness, 2)}`;
    if (!mats.has(key)) mats.set(key, { name: `mat_${(v.color || "#888888").replace("#", "")}${mats.size ? "_" + mats.size : ""}`, color: v.color, metalness: v.metalness, roughness: v.roughness });
    v.mat = mats.get(key);
  }

  if (formats.has("urdf")) {
    const meshFiles = {};
    for (const l of links) for (const v of l.visuals) {
      if (o.meshFormat === "stl") meshFiles[`meshes/${v.name}.stl`] = stlBytes(v.mesh, `CAD Modeler robot mesh ${v.name} (m)`);
      else {
        meshFiles[`meshes/${v.name}.obj`] = objText(v.mesh, v.name, `${v.name}.mtl`, v.mat.name);
        meshFiles[`meshes/${v.name}.mtl`] = mtlText(v.mat.name, hexRgb(v.color));
      }
      v.file = `meshes/${v.name}.${o.meshFormat === "stl" ? "stl" : "obj"}`;
    }
    files["robot.urdf"] = urdfText(name, links, model.joints, mats, o);
    Object.assign(files, meshFiles);
  }
  if (formats.has("usd")) files["robot.usda"] = usdaText(name, links, linkByName, model.joints, mats, model.fixedBase, o);
  files["README.txt"] = readmeText(name, links, model.joints, model.fixedBase, formats, o, warnings);

  const totalMass = links.reduce((a, l) => a + (l.massless ? 0 : l.mass), 0);
  return {
    name, files, fixedBase: model.fixedBase, warnings,
    links: links.map((l) => ({ name: l.name, component: l.compId, bodies: l.bodyIds, mass: l.mass, com: l.com, inertia: l.inertia, massless: l.massless,
      world0: l.world0.map((x, i) => (i >= 12 && i < 15 ? x / 1000 : x)) })),
    joints: model.joints.map((j) => ({ name: j.name, type: j.type, parent: j.parent, child: j.child, axis: j.axis, lower: j.lower, upper: j.upper, value: j.value })),
    summary: `${links.length} link${links.length === 1 ? "" : "s"}, ${model.joints.length} joint${model.joints.length === 1 ? "" : "s"}, ${num(totalMass, 4)} kg, ${model.fixedBase ? "fixed" : "floating"} base`,
  };
}

// ---------------- URDF ----------------
function originXml(m, ind) {
  const p = M4.pos(m).map((x) => x / 1000), rpy = rpyFromMat3(M4.rot3(m));
  return `${ind}<origin xyz="${p.map((x) => num(x)).join(" ")}" rpy="${rpy.map((x) => num(x)).join(" ")}"/>`;
}
function urdfText(name, links, joints, mats, o) {
  const L = [`<?xml version="1.0" encoding="utf-8"?>`, `<!-- CAD Modeler robot export. SI units (m, kg, rad), Z up. Generated ${new Date().toISOString()} -->`, `<robot name="${xmlEsc(name)}">`];
  for (const m of mats.values()) L.push(`  <material name="${m.name}"><color rgba="${hexRgb(m.color).map((x) => num(x, 4)).join(" ")} 1"/></material>`);
  for (const l of links) {
    L.push(`  <link name="${xmlEsc(l.name)}">`);
    const I = l.inertia;
    L.push(`    <inertial>`, `      <origin xyz="${l.com.map((x) => num(x)).join(" ")}" rpy="0 0 0"/>`, `      <mass value="${num(l.mass)}"/>`,
      `      <inertia ixx="${num(I[0][0])}" ixy="${num(I[0][1])}" ixz="${num(I[0][2])}" iyy="${num(I[1][1])}" iyz="${num(I[1][2])}" izz="${num(I[2][2])}"/>`, `    </inertial>`);
    for (const v of l.visuals) {
      L.push(`    <visual name="${xmlEsc(v.name)}">`, `      <origin xyz="0 0 0" rpy="0 0 0"/>`, `      <geometry><mesh filename="${xmlEsc(v.file)}"/></geometry>`, `      <material name="${v.mat.name}"/>`, `    </visual>`);
      if (o.collision !== "none") L.push(`    <collision name="${xmlEsc(v.name)}_collision">`, `      <origin xyz="0 0 0" rpy="0 0 0"/>`, `      <geometry><mesh filename="${xmlEsc(v.file)}"/></geometry>`, `    </collision>`);
    }
    L.push(`  </link>`);
  }
  for (const j of joints) {
    L.push(`  <joint name="${xmlEsc(j.name)}" type="${j.type}">`, `    <parent link="${xmlEsc(j.parent)}"/>`, `    <child link="${xmlEsc(j.child)}"/>`, originXml(j.origin, "    "));
    if (j.type !== "fixed") {
      L.push(`    <axis xyz="${j.axis.join(" ")}"/>`);
      if (j.type === "continuous") L.push(`    <limit effort="${num(j.effort)}" velocity="${num(j.velocity)}"/>`);
      else {
        const lo = j.lower != null ? j.lower : -10, hi = j.upper != null ? j.upper : 10;
        L.push(`    <limit lower="${num(lo)}" upper="${num(hi)}" effort="${num(j.effort)}" velocity="${num(j.velocity)}"/>`);
      }
      if (j.mimic) L.push(`    <mimic joint="${xmlEsc(j.mimic.joint)}" multiplier="${num(j.mimic.multiplier)}" offset="${num(j.mimic.offset)}"/>`);
      const damp = j.type === "prismatic" ? o.linearDamping : o.angularDamping;
      L.push(`    <dynamics damping="${num(damp)}" friction="0"/>`);
    }
    L.push(`  </joint>`);
  }
  L.push(`</robot>`, "");
  return L.join("\n");
}

// ---------------- USD (usda) ----------------
function xformOps(m, ind) {
  const p = M4.pos(m).map((x) => x / 1000), q = quatFromMat3(M4.rot3(m));
  return [`${ind}double3 xformOp:translate = ${tuple(p, 9)}`, `${ind}quatd xformOp:orient = ${tuple(q, 9)}`, `${ind}uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]`];
}
function usdArray(arr, per, p = 7) {
  const parts = [];
  if (per === 1) for (let i = 0; i < arr.length; i++) parts.push(String(arr[i]));
  else for (let i = 0; i < arr.length; i += per) parts.push(`(${Array.from(arr.subarray ? arr.subarray(i, i + per) : arr.slice(i, i + per), (x) => num(x, p)).join(", ")})`);
  return `[${parts.join(", ")}]`;
}
function usdaText(name, links, linkByName, joints, mats, fixedBase, o) {
  const root = `/${name}`;
  const L = [
    "#usda 1.0", "(",
    `    defaultPrim = "${name}"`,
    `    doc = "CAD Modeler robot export (UsdPhysics articulation). Metres, kilograms, Z up."`,
    "    kilogramsPerUnit = 1", "    metersPerUnit = 1", '    upAxis = "Z"', ")", "",
    `def Xform "${name}" (`, '    prepend apiSchemas = ["PhysicsArticulationRootAPI", "PhysxArticulationAPI"]', ")", "{",
    "    bool physxArticulation:enabledSelfCollisions = 0",
    "    int physxArticulation:solverPositionIterationCount = 32",
    "    int physxArticulation:solverVelocityIterationCount = 1",
    "",
    '    def Scope "Looks"', "    {",
  ];
  for (const m of mats.values()) {
    const c = hexRgb(m.color).map(srgbToLinear);
    L.push(`        def Material "${m.name}"`, "        {", `            token outputs:surface.connect = <${root}/Looks/${m.name}/Shader.outputs:surface>`,
      '            def Shader "Shader"', "            {", '                uniform token info:id = "UsdPreviewSurface"',
      `                color3f inputs:diffuseColor = ${tuple(c, 4)}`, `                float inputs:metallic = ${num(m.metalness, 3)}`, `                float inputs:roughness = ${num(m.roughness, 3)}`,
      "                token outputs:surface", "            }", "        }");
  }
  L.push("    }", "");
  const approx = o.collision === "none" ? null : o.collision || "convexHull";
  for (const l of links) {
    L.push(`    def Xform "${l.name}" (`, '        prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsMassAPI"]', "    )", "    {");
    L.push(...xformOps(l.world0, "        "));
    L.push(`        float physics:mass = ${num(l.mass)}`, `        point3f physics:centerOfMass = ${tuple(l.com)}`,
      `        float3 physics:diagonalInertia = ${tuple(l.principal)}`, `        quatf physics:principalAxes = ${tuple(l.principalAxes)}`);
    for (const v of l.visuals) {
      const mesh = v.mesh, P = mesh.points;
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); }
      if (!P.length) lo = hi = [0, 0, 0];
      const schemas = ["MaterialBindingAPI"].concat(approx ? ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI"] : []);
      L.push("", `        def Mesh "${uniqueChild(l, safeName(v.label, "body"))}" (`, `            prepend apiSchemas = [${schemas.map((s) => `"${s}"`).join(", ")}]`, "        )", "        {",
        `            float3[] extent = [${tuple(lo)}, ${tuple(hi)}]`,
        `            int[] faceVertexCounts = [${new Array(mesh.triangles.length / 3).fill(3).join(", ")}]`,
        `            int[] faceVertexIndices = ${usdArray(mesh.triangles, 1)}`,
        `            rel material:binding = <${root}/Looks/${v.mat.name}>`,
        `            normal3f[] normals = ${usdArray(mesh.normals, 3, 5)} (`, '                interpolation = "vertex"', "            )",
        `            point3f[] points = ${usdArray(P, 3)}`,
        `            color3f[] primvars:displayColor = [${tuple(hexRgb(v.color).map(srgbToLinear), 4)}] (`, '                interpolation = "constant"', "            )",
        '            uniform token subdivisionScheme = "none"');
      if (approx) L.push(`            uniform token physics:approximation = "${approx}"`);
      L.push("        }");
    }
    L.push("    }", "");
  }
  L.push('    def Scope "joints"', "    {");
  if (fixedBase) {
    const rootLink = links[0];
    const p = M4.pos(rootLink.world0).map((x) => x / 1000), q = quatFromMat3(M4.rot3(rootLink.world0));
    L.push('        def PhysicsFixedJoint "root_joint"', "        {", `            rel physics:body1 = <${root}/${rootLink.name}>`,
      `            point3f physics:localPos0 = ${tuple(p)}`, `            quatf physics:localRot0 = ${tuple(q)}`,
      "            point3f physics:localPos1 = (0, 0, 0)", "            quatf physics:localRot1 = (1, 0, 0, 0)", "        }");
  }
  const AX = (a) => (a[0] ? "X" : a[1] ? "Y" : "Z");
  for (const j of joints) {
    const type = j.type === "fixed" ? "PhysicsFixedJoint" : j.type === "prismatic" ? "PhysicsPrismaticJoint" : "PhysicsRevoluteJoint";
    const kind = j.type === "prismatic" ? "linear" : "angular";
    const schemas = j.type === "fixed" ? [] : [`PhysicsDriveAPI:${kind}`, "PhysxJointAPI"];
    const p = M4.pos(j.origin).map((x) => x / 1000), q = quatFromMat3(M4.rot3(j.origin));
    L.push(`        def ${type} "${j.name}"${schemas.length ? ` (\n            prepend apiSchemas = [${schemas.map((s) => `"${s}"`).join(", ")}]\n        )` : ""}`, "        {",
      `            rel physics:body0 = <${root}/${j.parent}>`, `            rel physics:body1 = <${root}/${j.child}>`,
      `            point3f physics:localPos0 = ${tuple(p)}`, `            quatf physics:localRot0 = ${tuple(q)}`,
      "            point3f physics:localPos1 = (0, 0, 0)", "            quatf physics:localRot1 = (1, 0, 0, 0)");
    if (j.type !== "fixed") {
      L.push(`            uniform token physics:axis = "${AX(j.axis)}"`);
      const R2D = 180 / Math.PI;
      const ang = j.type !== "prismatic";
      if (j.lower != null && j.upper != null) L.push(`            float physics:lowerLimit = ${num(ang ? j.lower * R2D : j.lower)}`, `            float physics:upperLimit = ${num(ang ? j.upper * R2D : j.upper)}`);
      // UsdPhysics angular drives are per degree: stiffness N·m/deg, damping N·m·s/deg
      const k = ang ? o.angularStiffness * (Math.PI / 180) : o.linearStiffness;
      const d = ang ? o.angularDamping * (Math.PI / 180) : o.linearDamping;
      L.push(`            uniform token drive:${kind}:physics:type = "force"`, `            float drive:${kind}:physics:stiffness = ${num(k)}`, `            float drive:${kind}:physics:damping = ${num(d)}`,
        `            float drive:${kind}:physics:maxForce = ${num(j.effort)}`, `            float drive:${kind}:physics:targetPosition = 0`, `            float drive:${kind}:physics:targetVelocity = 0`,
        `            float physxJoint:maxJointVelocity = ${num(ang ? j.velocity * R2D : j.velocity)}`);
    }
    L.push("        }");
  }
  L.push("    }", "}", "");
  if (o.physicsScene) L.push('def PhysicsScene "physicsScene"', "{", "    vector3f physics:gravityDirection = (0, 0, -1)", "    float physics:gravityMagnitude = 9.81", "}", "");
  return L.join("\n");
}
// unique Mesh prim names inside one link prim
function uniqueChild(l, n) {
  l._childNames = l._childNames || new Set();
  let s = n, i = 2;
  while (l._childNames.has(s.toLowerCase())) s = `${n}_${i++}`;
  l._childNames.add(s.toLowerCase());
  return s;
}

// ---------------- README ----------------
function readmeText(name, links, joints, fixedBase, formats, o, warnings) {
  const moving = joints.filter((j) => j.type !== "fixed");
  const fmtPos = (j) => (j.type === "prismatic" ? `${num(j.value || 0, 4)}` : `${num(j.value || 0, 4)}`);
  const lines = [
    `${name}: robot package exported by CAD Modeler (${new Date().toISOString().slice(0, 10)})`,
    "",
    "Units: metres, kilograms, seconds; revolute joints in radians (URDF) / degrees (USD limits and drives); Z up.",
    `Links: ${links.length}   Joints: ${joints.length} (${moving.length} movable)   Base: ${fixedBase ? "fixed to the world" : "floating"}`,
    "The package is in the ZERO configuration (every joint value 0). Link frames sit on the joint frames.",
    "",
    "FILES",
  ];
  if (formats.has("usd")) lines.push("  robot.usda   USD stage: UsdPhysics articulation, meshes embedded, Z up, metersPerUnit = 1, kilogramsPerUnit = 1");
  if (formats.has("urdf")) lines.push(`  robot.urdf   URDF with relative mesh paths (meshes/*.${o.meshFormat === "stl" ? "stl" : "obj"}, in metres, in each link's frame)`);
  lines.push("", "LINKS");
  for (const l of links) lines.push(`  ${l.name.padEnd(24)} ${num(l.mass, 4)} kg${l.massless ? " (dummy mass, no bodies)" : ""}`);
  lines.push("", "JOINTS");
  for (const j of joints) {
    const lim = j.lower != null ? `  limits ${num(j.lower, 4)} .. ${num(j.upper, 4)} ${j.type === "prismatic" ? "m" : "rad"}` : "";
    lines.push(`  ${j.name.padEnd(24)} ${j.type.padEnd(11)} ${j.parent} -> ${j.child}${lim}`);
  }
  if (formats.has("usd")) {
    lines.push("", "ISAAC SIM: OPEN THE USD",
      "  File > Open > robot.usda (or drag it into an open stage to add it as a reference), then press Play.",
      fixedBase ? "  The base is held by the fixed joint /" + name + "/joints/root_joint (body0 = world)." : "  The base is floating (no joint to the world).",
      "  The default prim carries PhysicsArticulationRootAPI; there is no PhysicsScene unless you ticked that option,",
      "  so add one (Create > Physics > Physics Scene) when you open the file on its own.");
  }
  if (formats.has("urdf")) {
    lines.push("", "ISAAC SIM: IMPORT THE URDF",
      "  File > Import > robot.urdf (Isaac Sim 4.5+), or Isaac Utils > Workflows > URDF Importer in older versions.",
      `  Tick "Fix Base Link" for a ${fixedBase ? "fixed" : "floating"} base: ${fixedBase ? "on" : "off"}. Leave "Merge Fixed Joints" off to keep the link names.`,
      "  URDF has no drive gains: set the joint drive stiffness / damping in the importer.",
      "  Python (Isaac Sim 4.5: isaacsim.asset.importer.urdf; 4.0-4.2: omni.importer.urdf):",
      "    import omni.kit.commands",
      '    _, cfg = omni.kit.commands.execute("URDFCreateImportConfig")',
      `    cfg.fix_base = ${fixedBase ? "True" : "False"}; cfg.merge_fixed_joints = False; cfg.make_default_prim = True`,
      '    omni.kit.commands.execute("URDFParseAndImportFile", urdf_path="/path/to/robot.urdf", import_config=cfg)');
  }
  const jp = moving.map((j) => `"${j.name}": ${fmtPos(j)}`).join(", ");
  const kAng = o.angularStiffness, dAng = o.angularDamping, kLin = o.linearStiffness, dLin = o.linearDamping;
  const rev = moving.filter((j) => j.type !== "prismatic").map((j) => j.name), pri = moving.filter((j) => j.type === "prismatic").map((j) => j.name);
  const re = (names) => `[${names.map((n) => `"${n}"`).join(", ")}]`;
  lines.push("", "ISAAC LAB (2.x; older releases use omni.isaac.lab instead of isaaclab)",
    "  import isaaclab.sim as sim_utils",
    "  from isaaclab.assets import ArticulationCfg",
    "  from isaaclab.actuators import ImplicitActuatorCfg",
    "",
    `  ${name.toUpperCase()}_CFG = ArticulationCfg(`,
    '      prim_path="{ENV_REGEX_NS}/Robot",',
    "      spawn=sim_utils.UsdFileCfg(",
    '          usd_path="/path/to/robot.usda",',
    "          articulation_props=sim_utils.ArticulationRootPropertiesCfg(enabled_self_collisions=False),",
    "      ),",
    `      init_state=ArticulationCfg.InitialStateCfg(pos=(0.0, 0.0, 0.0), joint_pos={${jp}}),`,
    "      actuators={");
  if (rev.length) lines.push(`          "revolute": ImplicitActuatorCfg(joint_names_expr=${re(rev)}, stiffness=${num(kAng)}, damping=${num(dAng)}),`);
  if (pri.length) lines.push(`          "prismatic": ImplicitActuatorCfg(joint_names_expr=${re(pri)}, stiffness=${num(kLin)}, damping=${num(dLin)}),`);
  lines.push("      },", "  )",
    "  joint_pos above holds the joint values the design was posed at (rad / m).",
    fixedBase ? "  The USD already fixes the base with root_joint. If your cloned environments drift to the world origin, delete root_joint\n  and pass articulation_props=sim_utils.ArticulationRootPropertiesCfg(fix_root_link=True) instead." : "",
    "  Isaac Lab actuator gains are per radian (revolute) or per metre (prismatic); the USD drive values were converted to per degree.");
  if (warnings.length) { lines.push("", "WARNINGS"); for (const w of warnings) lines.push(`  - ${w}`); }
  lines.push("", "Isaac Sim was not available when this exporter was written; the USD was validated with Pixar's usd-core (pxr) and",
    "UsdPhysics' own parser, and the URDF with a structural check. See docs/robot-export.md in CAD Modeler.", "");
  return lines.join("\r\n");
}

/** File list with sizes, for logging / the debug hook. */
export function fileList(files) {
  return Object.entries(files).map(([path, data]) => ({ path, bytes: typeof data === "string" ? new TextEncoder().encode(data).length : data.byteLength }));
}
