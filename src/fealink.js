// CAD -> FEA case exchange (pure: no DOM, no kernel, runs in Node).
// Builds the files of a "cadmodeler-fea-case" v1 folder (geometry.step + case.json),
// validates it, and parses FEA Sim's viz/ binaries. Spec: docs/fea-exchange.md.
// FEA Sim (C:\Users\Austi\Documents\FEA Sim) reads it with fea/caseio.py.
import { safeName, timestamp, materialEntry, normColor, toBytes } from "./cfdlink.js";

export const CASE_FORMAT = "cadmodeler-fea-case";
export const CASE_VERSION = 1;
export const GEOMETRY_FILE = "geometry.step";
export const CASE_FILE = "case.json";
export const VIZ_FORMAT = "cadmodeler-fea-viz";
export const G0 = 9.80665;

/** Mesh quality presets (element size = min(fraction × largest extent, fraction × 2V/A); see FEA Sim/fea/mesher.py). */
export const MESH_QUALITIES = [
  { id: "coarse", label: "Coarse" },
  { id: "medium", label: "Medium" },
  { id: "fine", label: "Fine" },
  { id: "finest", label: "Finest" },
];
export const AXES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
/** Force directions offered by the dialog: along the face normal (into the face) or a model axis. */
export const FORCE_DIRECTIONS = ["normal", ...AXES];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const tup = (v) => (Array.isArray(v) && v.length === 3 && v.every(isNum) ? v.map(Number) : null);
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);

export function axisVector(axis) {
  const k = "XYZ".indexOf(String(axis || "")[1]);
  if (k < 0) throw new Error(`bad axis ${axis}`);
  const v = [0, 0, 0];
  v[k] = axis[0] === "-" ? -1 : 1;
  return v;
}

export function caseFolderName(designName, date = new Date()) {
  return `${safeName(designName)}_FEA_${timestamp(date)}`;
}

/**
 * Total force vector (N) for a force load.
 * direction "normal": along the (area-weighted) normal of the selected faces, pushing INTO the
 * material (−outward normal); an axis ("+X", "-Z", …) points that way. flip reverses it.
 * @param {{ magnitude:number, direction?:string, flip?:boolean, faces?:{n:number[], area_mm2?:number}[] }} load
 */
export function forceVector(load) {
  const mag = +load.magnitude;
  if (!isNum(mag)) throw new Error("force magnitude must be a number");
  let d;
  if (!load.direction || load.direction === "normal") {
    const n = [0, 0, 0];
    for (const f of load.faces || []) {
      const fn = tup(f.n);
      if (!fn) continue;
      const w = isNum(f.area_mm2) && f.area_mm2 > 0 ? f.area_mm2 : 1;
      for (let k = 0; k < 3; k++) n[k] += w * fn[k];
    }
    const l = len3(n);
    if (!(l > 1e-12)) throw new Error("the selected faces have no common normal: choose an axis direction");
    d = n.map((x) => -x / l);
  } else d = axisVector(load.direction);
  const s = load.flip ? -mag : mag;
  return d.map((x) => (x * s === 0 ? 0 : x * s));
}

/** Gravity vector in m/s² for a direction axis (default −Z, CAD is Z-up). */
export function gravityVector(direction = "-Z", g = G0) {
  return axisVector(direction).map((x) => x * g || 0);
}

/** Clean a face reference for the case: { body, idx, pt, n, area_mm2? }. */
export function cleanFaceRef(r) {
  if (!r || typeof r !== "object") throw new Error("face reference must be an object");
  const out = { body: String(r.body), idx: Number.isInteger(r.idx) ? r.idx : null, pt: tup(r.pt), n: tup(r.n) };
  if (!out.pt) throw new Error("face reference needs pt [x, y, z]");
  if (!out.n) out.n = [0, 0, 0];
  if (isNum(r.area_mm2) || isNum(r.area)) out.area_mm2 = isNum(r.area_mm2) ? r.area_mm2 : r.area;
  if (typeof r.type === "string") out.type = r.type;
  return out;
}

/**
 * Build a case folder's files.
 * @param {object} a
 * @param {string} a.designName
 * @param {{id:string,name:string,volume_mm3?:number,bbox?:{min:number[],max:number[]},faces?:object[]}[]} a.bodies  bodies in the STEP (one per study in v1)
 * @param {Blob|Uint8Array|ArrayBuffer} a.stepBytes   STEP of exactly those bodies (CAD mm, Z up), from K.exportSTEP
 * @param {object} [a.appearances]   { bodyId: { materialId, color } }
 * @param {object|function} [a.materials]   { materialId: material } or (id) => material
 * @param {object} a.study
 * @param {{type?:"fixed"|"pin", faces:object[], radial?:boolean, axial?:boolean, tangential?:boolean}[]} a.study.fixtures
 * @param {{type:"force"|"pressure"|"bearing", faces:object[], magnitude:number, direction?:string, flip?:boolean, vector?:number[]}[]} a.study.loads
 *        force magnitude in N, pressure in Pa (positive pushes into the face)
 * @param {{enabled:boolean, direction?:string}} [a.study.gravity]
 * @param {{quality?:string, size_mm?:number|null}} [a.study.mesh]
 * @param {{method?:string, gpu?:boolean}} [a.study.solver]
 * @param {string} [a.appVersion]
 * @param {Date} [a.date]
 */
export async function buildCase(a) {
  const date = a.date || new Date();
  const step = await toBytes(a.stepBytes);
  if (!step.byteLength) throw new Error("STEP export is empty");
  const st = a.study || {};
  const matOf = typeof a.materials === "function" ? a.materials : (id) => (a.materials || {})[id] || null;
  const bodies = (a.bodies || []).map((b) => {
    const ap = (a.appearances || {})[b.id] || null;
    const mid = ap && ap.materialId;
    const mat = mid ? matOf(mid) : null;
    const material = materialEntry(mid || null, mat);
    const out = { id: b.id, name: b.name || b.id, color: normColor(ap && ap.color) || null, material };
    if (isNum(b.volume_mm3)) {
      out.volume_mm3 = b.volume_mm3;
      if (material && isNum(material.density_kg_m3)) out.mass_kg = material.density_kg_m3 * b.volume_mm3 * 1e-9;
    }
    if (b.bbox && tup(b.bbox.min) && tup(b.bbox.max)) out.bbox = { min: tup(b.bbox.min), max: tup(b.bbox.max) };
    if (Array.isArray(b.faces)) out.faces = b.faces.map(cleanFaceRef).map(({ body, ...f }) => f);
    return out;
  });
  // fixed faces, or pin supports (a shaft / pin in a hole: hold radial, axial and / or tangential motion
  // in the cylinder's own frame; feature request 2026-10-21 20:47)
  const fixtures = (st.fixtures || []).map((f) => (f.type === "pin"
    ? { type: "pin", faces: (f.faces || []).map(cleanFaceRef), radial: !!f.radial, axial: !!f.axial, tangential: !!f.tangential }
    : { type: "fixed", faces: (f.faces || []).map(cleanFaceRef) }));
  const loads = (st.loads || []).map((l) => {
    const faces = (l.faces || []).map(cleanFaceRef);
    if (l.type === "pressure") return { type: "pressure", faces, magnitude_Pa: +l.magnitude };
    const vec = tup(l.vector) || forceVector({ ...l, faces });
    // bearing: a shaft pushing on a hole (FEA Sim loads only the half it pushes on, cosine spread)
    return { type: l.type === "bearing" ? "bearing" : "force", faces, vector_N: vec, magnitude_N: len3(vec), direction: l.direction || "normal", flip: !!l.flip };
  });
  const g = st.gravity || {};
  const bb = bodies.reduce((acc, b) => {
    if (!b.bbox) return acc;
    if (!acc) return { min: [...b.bbox.min], max: [...b.bbox.max] };
    for (let k = 0; k < 3; k++) { acc.min[k] = Math.min(acc.min[k], b.bbox.min[k]); acc.max[k] = Math.max(acc.max[k], b.bbox.max[k]); }
    return acc;
  }, null);
  const caseData = {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    createdAt: date.toISOString(),
    source: { app: "CAD Modeler", design: a.designName || "Untitled", appVersion: a.appVersion || null },
    units: "mm",
    analysis: "static-stress",
    geometry: {
      file: GEOMETRY_FILE, format: "step",
      bbox: bb, size: bb ? [0, 1, 2].map((k) => bb.max[k] - bb.min[k]) : null,
      bodies,
      contact: bodies.length > 1 ? "bonded" : null,
    },
    fixtures,
    loads,
    gravity: { enabled: !!g.enabled, direction: g.direction || "-Z", vector_m_s2: gravityVector(g.direction || "-Z", isNum(g.g) ? g.g : G0) },
    mesh: { quality: (st.mesh && st.mesh.quality) || "medium", size_mm: (st.mesh && isNum(st.mesh.size_mm) && st.mesh.size_mm > 0) ? st.mesh.size_mm : null, order: 2 },
    solver: { method: (st.solver && st.solver.method) || "auto", gpu: !(st.solver && st.solver.gpu === false), tolerance: 1e-8 },
    results: { progress: "progress.json", results: "results.json", viz: "viz/manifest.json" },
  };
  const v = validateCase(caseData);
  if (!v.ok) throw new Error(v.errors.join("; "));
  const folderName = caseFolderName(a.designName, date);
  return { folderName, caseData, files: { [CASE_FILE]: JSON.stringify(caseData, null, 1), [GEOMETRY_FILE]: step } };
}

/** Same rules as FEA Sim's fea/caseio.py validate(). */
export function validateCase(c) {
  const errors = [];
  if (!c || typeof c !== "object") return { ok: false, errors: ["case is not an object"] };
  if (c.format !== CASE_FORMAT) errors.push(`format must be "${CASE_FORMAT}"`);
  if (!Number.isInteger(c.version) || c.version < 1) errors.push("version must be a positive integer");
  if (c.units !== "mm") errors.push('units must be "mm"');
  const g = c.geometry || {};
  if (typeof g.file !== "string" || !g.file) errors.push("geometry.file missing");
  if (!Array.isArray(g.bodies) || !g.bodies.length) errors.push("geometry.bodies must be a non-empty list");
  if (!Array.isArray(c.fixtures) || !c.fixtures.length) errors.push("at least one fixture is required");
  (c.fixtures || []).forEach((f, i) => {
    if (!f || !Array.isArray(f.faces) || !f.faces.length) { errors.push(`fixtures[${i}].faces must be a non-empty list`); return; }
    if (f.type && f.type !== "fixed" && f.type !== "pin") errors.push(`fixtures[${i}].type must be "fixed" or "pin"`);
    if (f.type === "pin" && !(f.radial || f.axial || f.tangential)) errors.push(`fixtures[${i}]: a pin support must hold at least one of radial / axial / tangential`);
  });
  (c.loads || []).forEach((l, i) => {
    if (!l || !["force", "pressure", "bearing"].includes(l.type)) { errors.push(`loads[${i}].type must be "force", "pressure" or "bearing"`); return; }
    if (!Array.isArray(l.faces) || !l.faces.length) errors.push(`loads[${i}].faces must be a non-empty list`);
    if ((l.type === "force" || l.type === "bearing") && !tup(l.vector_N)) errors.push(`loads[${i}].vector_N must be [fx, fy, fz]`);
    if (l.type === "pressure" && !isNum(l.magnitude_Pa)) errors.push(`loads[${i}].magnitude_Pa must be a number`);
  });
  const q = (c.mesh || {}).quality || "medium";
  if (!MESH_QUALITIES.some((m) => m.id === q)) errors.push(`mesh.quality must be one of ${MESH_QUALITIES.map((m) => m.id).join(", ")}`);
  return { ok: !errors.length, errors };
}

/** Accepts platform.fea.readResults() output ({results, progress}) or a bare file object. */
export function normalizeReadback(r) {
  if (!r || typeof r !== "object") return { progress: null, results: null };
  if ("progress" in r || "results" in r) {
    return { progress: r.progress && typeof r.progress === "object" ? r.progress : null, results: r.results && typeof r.results === "object" ? r.results : null };
  }
  if (r.kind === "results") return { progress: null, results: r };
  if (r.kind === "progress") return { progress: r, results: null };
  return { progress: null, results: null };
}

/** Short summary for the browser: "FOS 4.2 · 59 MPa". */
export function resultSummary(r) {
  if (!r) return "";
  const f = (v, d = 2) => String(+(+v).toPrecision(d));
  const parts = [];
  if (isNum(r.minSafetyFactor)) parts.push(`FOS ${r.minSafetyFactor >= 15 ? "15+" : f(r.minSafetyFactor, 2)}`);
  if (isNum(r.maxVonMises_MPa)) parts.push(`${f(r.maxVonMises_MPa, 3)} MPa`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ viz binaries (layouts: docs/fea-exchange.md)
const ascii4 = (u8) => String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
function typed(Ctor, u8, off, n) {
  const o = u8.byteOffset + off;
  return o % Ctor.BYTES_PER_ELEMENT ? new Ctor(u8.slice(off, off + n * Ctor.BYTES_PER_ELEMENT).buffer) : new Ctor(u8.buffer, o, n);
}
/** viz/surface.bin: "FSF1", u32 nVerts, u32 nTris, f32[3n] positions, u32[3m] triangles, i32[m] gmsh surface tag. */
export function parseSurface(u8) {
  if (!(u8 instanceof Uint8Array) || u8.byteLength < 12 || ascii4(u8) !== "FSF1") throw new Error("bad FEA surface file");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(4, true), m = dv.getUint32(8, true);
  if (u8.byteLength < 12 + 12 * n + 16 * m) throw new Error("FEA surface file is truncated");
  return { count: n, triangles: m, positions: typed(Float32Array, u8, 12, 3 * n), index: typed(Uint32Array, u8, 12 + 12 * n, 3 * m), surface: typed(Int32Array, u8, 12 + 12 * n + 12 * m, m) };
}
/** viz/<field>.bin: f32[n × components]. */
export function parseField(u8, count, components = 1) {
  if (!(u8 instanceof Uint8Array) || u8.byteLength < 4 * count * components) throw new Error("FEA field file is truncated");
  return typed(Float32Array, u8, 0, count * components);
}

/** Deformation scale for "Adjusted": the largest displacement drawn as `frac` of the model extent. */
export function adjustedScale(maxDispMm, extentMm, frac = 0.05) {
  if (!(maxDispMm > 0) || !(extentMm > 0)) return 1;
  return (frac * extentMm) / maxDispMm;
}
