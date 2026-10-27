// CAD -> CFD case exchange (pure: no DOM, no kernel, runs in Node).
// Builds the files of a "cadmodeler-cfd-case" v1 folder: geometry.stl + case.json.
// The format is specified in docs/cfd-exchange.md; CFD Sim reads it with cfd/cadlink.py.

export const CASE_FORMAT = "cadmodeler-cfd-case";
export const CASE_VERSION = 1;
export const GEOMETRY_FILE = "geometry.stl";
export const CASE_FILE = "case.json";
export const PROGRESS_FILE = "progress.json";
export const RESULTS_FILE = "results.json";

/** Free-stream directions in CAD coordinates: "+X" means the air moves toward +X. */
export const FLOW_DIRECTIONS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

/** Same names and values as CFD Sim's cfd/solver.py FLUIDS. */
export const FLUIDS = {
  "Air (20°C)": { nu: 1.5e-5, rho: 1.204 },
  "Water (20°C)": { nu: 1.0e-6, rho: 998.0 },
  Custom: null,
};

/** CFD Sim's Quality presets (cfd/app.py QUALITY): a cell budget across all grid levels. */
export const QUALITY_PRESETS = [
  { id: "draft", label: "Draft · ~8 M cells", cells: 8e6, frames: 60 },
  { id: "standard", label: "Standard · ~25 M cells", cells: 25e6, frames: 120 },
  { id: "high", label: "High · ~60 M cells", cells: 60e6, frames: 160 },
  { id: "ultra", label: "Ultra · ~110 M cells", cells: 110e6, frames: 200 },
  { id: "max", label: "Max · ~150 M cells", cells: 150e6, frames: 200 },
];

/** CFD Sim's Duration presets (flow-throughs of the domain). */
export const DURATIONS = [
  { value: 2, label: "Quick look · 2 flow-throughs" },
  { value: 3, label: "Standard · 3 flow-throughs" },
  { value: 4, label: "Developed · 4 flow-throughs" },
  { value: 6, label: "Long · 6 flow-throughs" },
];

export const SOLVER_DEFAULTS = { quality: "standard", resolution: null, levels: 4, precision: "fp16c", flowThroughs: 3, frames: null, gpu: true };
const PRECISIONS = ["fp16c", "fp16", "fp32"];

// ------------------------------------------------------------------ small helpers
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pad2 = (n) => String(n).padStart(2, "0");

export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** Folder-safe design name: letters, digits, "-" and "_" only. */
export function safeName(name) {
  const s = String(name || "").normalize("NFKD").replace(/[^\w-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
  return s || "Design";
}

export function caseFolderName(designName, date = new Date()) {
  return `${safeName(designName)}_${timestamp(date)}`;
}

/** Up axis sent to CFD: CAD is Z-up; a vertical flow needs another up axis. */
export function upAxisFor(direction) {
  return direction[1] === "Z" ? "+Y" : "+Z";
}

/** "#rrggbb" from a number (0xRRGGBB), "#rgb", "#rrggbb" or an {r,g,b} 0..1 object. */
export function normColor(c) {
  if (c == null) return null;
  if (typeof c === "number") return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
  if (typeof c === "string") {
    const s = c.trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return s;
  }
  if (typeof c === "object" && isNum(c.r)) {
    const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }
  return null;
}

/** Accepts Uint8Array, ArrayBuffer, any typed array, or a Blob (async). */
export async function toBytes(data) {
  if (data == null) throw new Error("No STL data");
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  throw new Error("STL data must be a Blob or a Uint8Array");
}

// ------------------------------------------------------------------ STL inspection
/** Parse a binary STL: { triangles, min, max } in file units (mm). */
export function stlInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 84) throw new Error("STL is empty or not binary");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 > bytes.byteLength) throw new Error(`STL is truncated (${n} triangles declared, ${bytes.byteLength} bytes)`);
  if (n === 0) throw new Error("STL has no triangles");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(o + v * 12 + k * 4, true);
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return { triangles: n, min, max };
}

/** Projected (frontal) area in mm² of the STL seen along `direction`, by rasterising
 *  the triangles onto a res x res grid over the bounding rectangle. Overlaps count once. */
export function frontalAreaMm2(bytes, direction = "+X", res = 192) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(80, true);
  const ax = "XYZ".indexOf(direction[1]);
  const [ia, ib] = [0, 1, 2].filter((k) => k !== ax);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  const P = new Float32Array(n * 6);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const a = dv.getFloat32(o + v * 12 + ia * 4, true), b = dv.getFloat32(o + v * 12 + ib * 4, true);
      P[t * 6 + v * 2] = a; P[t * 6 + v * 2 + 1] = b;
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
  }
  const wa = a1 - a0, wb = b1 - b0;
  if (!(wa > 0 && wb > 0)) return 0;
  const h = Math.max(wa, wb) / res;
  const na = Math.max(1, Math.ceil(wa / h)), nb = Math.max(1, Math.ceil(wb / h));
  const grid = new Uint8Array(na * nb);
  for (let t = 0; t < n; t++) {
    const q = t * 6;
    const ax0 = P[q], ay0 = P[q + 1], ax1 = P[q + 2], ay1 = P[q + 3], ax2 = P[q + 4], ay2 = P[q + 5];
    const d = (ax1 - ax0) * (ay2 - ay0) - (ax2 - ax0) * (ay1 - ay0);
    if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax0, ax1, ax2) - a0) / h)), i1 = Math.min(na - 1, Math.floor((Math.max(ax0, ax1, ax2) - a0) / h));
    const j0 = Math.max(0, Math.floor((Math.min(ay0, ay1, ay2) - b0) / h)), j1 = Math.min(nb - 1, Math.floor((Math.max(ay0, ay1, ay2) - b0) / h));
    for (let j = j0; j <= j1; j++) {
      const y = b0 + (j + 0.5) * h;
      for (let i = i0; i <= i1; i++) {
        if (grid[j * na + i]) continue;
        const x = a0 + (i + 0.5) * h;
        const w0 = ((ax1 - x) * (ay2 - y) - (ax2 - x) * (ay1 - y)) / d;
        const w1 = ((ax2 - x) * (ay0 - y) - (ax0 - x) * (ay2 - y)) / d;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) grid[j * na + i] = 1;
      }
    }
  }
  let c = 0;
  for (let k = 0; k < grid.length; k++) c += grid[k];
  return c * h * h;
}

/** Numbers shown in the study dialog. */
export function flowSummary({ bbox, direction = "+X", speed = 20, nu = 1.5e-5, frontalMm2 = null }) {
  const ext = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]);
  const lengthM = Math.max(...ext) / 1000;
  const ax = "XYZ".indexOf(direction[1]);
  const along = ext[ax] / 1000;
  const boxArea = ext.filter((_, k) => k !== ax).reduce((a, b) => a * b, 1) / 1e6;
  const frontalM2 = frontalMm2 != null ? frontalMm2 / 1e6 : boxArea;
  const reynolds = nu > 0 ? (speed * lengthM) / nu : NaN;
  return { lengthM, alongFlowM: along, frontalM2, bboxFrontalM2: boxArea, reynolds };
}

// ------------------------------------------------------------------ materials
/** Flatten a material record ({ id, name, physical: {...} }) into the case's material entry. */
export function materialEntry(materialId, mat) {
  if (!mat && !materialId) return null;
  const out = { id: (mat && mat.id) || materialId || null, name: (mat && mat.name) || materialId || null, density_kg_m3: null };
  const phys = (mat && (mat.physical || mat.props)) || {};
  for (const [k, v] of Object.entries(phys)) {
    if (v == null || typeof v === "function") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  const dens = [phys.density_kg_m3, phys.densityKgM3, phys.density].find(isNum);
  out.density_kg_m3 = dens != null ? dens : null;
  if ("density" in out && out.density === out.density_kg_m3) delete out.density;
  return out;
}

// ------------------------------------------------------------------ case building
/**
 * Build a case folder's files.
 * @param {object} a
 * @param {string} a.designName
 * @param {{id:string,name:string,volume_mm3?:number}[]} a.bodies    bodies included in the STL
 * @param {Blob|Uint8Array|ArrayBuffer} a.stlBytes                    binary STL (CAD mm, Z up)
 * @param {object|function} [a.appearances]  bodyId -> { materialId, color } (map or function)
 * @param {object|function} [a.materials]    materialId -> { id, name, physical:{...} } (map or function)
 * @param {object} [a.options]  { direction, speed, fluid, nu, rho, ground:{enabled,gap_mm,moving},
 *                               solver:{quality,resolution,levels,precision,flowThroughs,frames,gpu},
 *                               appVersion, app, launch, date, notes }
 * @returns {Promise<{folderName:string, files:{"geometry.stl":Uint8Array,"case.json":string}, caseData:object, summary:object}>}
 */
export async function buildCase({ designName, bodies = [], stlBytes, appearances, materials, options = {} }) {
  const bytes = await toBytes(stlBytes);
  const info = stlInfo(bytes);
  const date = options.date || new Date();
  const look = (src, key) => (typeof src === "function" ? src(key) : src ? src[key] : null) || null;

  const direction = options.direction || "+X";
  const fluid = options.fluid || "Air (20°C)";
  const fl = FLUIDS[fluid];
  const nu = fl ? fl.nu : +options.nu;
  const rho = fl ? fl.rho : +options.rho;
  const speed = options.speed != null ? +options.speed : 20;
  const g = options.ground || {};
  const vertical = direction[1] === "Z";
  const s = { ...SOLVER_DEFAULTS, ...(options.solver || {}) };
  for (const k of Object.keys(s)) if (s[k] === undefined) s[k] = SOLVER_DEFAULTS[k];

  const ext = [0, 1, 2].map((k) => info.max[k] - info.min[k]);
  const frontal = frontalAreaMm2(bytes, direction);
  const summary = flowSummary({ bbox: info, direction, speed, nu, frontalMm2: frontal });

  const caseData = {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    createdAt: date.toISOString(),
    source: { app: options.app || "CAD Modeler", design: String(designName || "Untitled"), appVersion: String(options.appVersion || "unknown") },
    units: "mm",
    geometry: {
      file: GEOMETRY_FILE,
      format: "stl-binary",
      triangles: info.triangles,
      bbox: { min: info.min.map(round6), max: info.max.map(round6) },
      size: ext.map(round6),
      lengthMm: round6(Math.max(...ext)),
      bodies: bodies.map((b) => {
        const ap = look(appearances, b.id);
        const matId = ap && ap.materialId;
        const entry = { id: String(b.id), name: String(b.name || b.id), material: matId ? materialEntry(matId, look(materials, matId)) : null, color: normColor(ap && ap.color) };
        if (isNum(b.volume_mm3)) {
          entry.volume_mm3 = b.volume_mm3;
          const d = entry.material && entry.material.density_kg_m3;
          if (isNum(d)) entry.mass_kg = round6(d * b.volume_mm3 * 1e-9);
        }
        return entry;
      }),
    },
    flow: { direction, up: options.up || upAxisFor(direction), speed_m_s: speed, fluid, nu, rho },
    ground: { enabled: !!g.enabled && !vertical, gap_mm: isNum(+g.gap_mm) ? +g.gap_mm : 0, moving: g.moving !== false },
    solver: {
      quality: s.quality,
      resolution: s.resolution == null ? null : Math.round(+s.resolution),
      levels: Math.round(+s.levels),
      precision: s.precision,
      flowThroughs: +s.flowThroughs,
      frames: s.frames == null ? null : Math.round(+s.frames),
      gpu: s.gpu !== false,
    },
    estimates: { lengthM: round6(summary.lengthM), frontalAreaM2: round6(summary.frontalM2), reynolds: Math.round(summary.reynolds) },
    results: { progress: PROGRESS_FILE, results: RESULTS_FILE },
  };
  if (options.notes) caseData.notes = String(options.notes);
  if (options.launch != null) caseData.launch = !!options.launch;

  const v = validateCase(caseData);
  if (!v.ok) throw new Error("Invalid CFD case: " + v.errors.join("; "));
  return { folderName: caseFolderName(designName, date), files: { [GEOMETRY_FILE]: bytes, [CASE_FILE]: JSON.stringify(caseData, null, 2) }, caseData, summary };
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }

/** Validate a parsed case.json (or its JSON text). Returns { ok, errors[], warnings[] }. */
export function validateCase(c) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  if (typeof c === "string") { try { c = JSON.parse(c); } catch (e) { return { ok: false, errors: ["not JSON: " + e.message], warnings }; } }
  if (!c || typeof c !== "object") return { ok: false, errors: ["case is not an object"], warnings };
  if (c.format !== CASE_FORMAT) err(`format must be "${CASE_FORMAT}"`);
  if (!Number.isInteger(c.version) || c.version < 1) err("version must be a positive integer");
  else if (c.version > CASE_VERSION) warnings.push(`version ${c.version} is newer than this reader (${CASE_VERSION})`);
  if (typeof c.createdAt !== "string" || isNaN(Date.parse(c.createdAt))) err("createdAt must be an ISO date");
  if (!c.source || typeof c.source.design !== "string") err("source.design missing");
  if (c.units !== "mm") err('units must be "mm"');
  const g = c.geometry;
  if (!g) err("geometry missing");
  else {
    if (typeof g.file !== "string" || !g.file) err("geometry.file missing");
    const okVec = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
    if (!g.bbox || !okVec(g.bbox.min) || !okVec(g.bbox.max)) err("geometry.bbox.min/max must be 3-vectors");
    else if (g.bbox.max.some((v, k) => v < g.bbox.min[k])) err("geometry.bbox max < min");
    if (!isNum(g.lengthMm) || g.lengthMm <= 0) err("geometry.lengthMm must be > 0");
    if (!Array.isArray(g.bodies)) err("geometry.bodies must be an array");
    else g.bodies.forEach((b, i) => {
      if (!b || typeof b.id !== "string") err(`geometry.bodies[${i}].id missing`);
      if (b && b.material != null && typeof b.material !== "object") err(`geometry.bodies[${i}].material must be an object or null`);
    });
    if (Array.isArray(g.bodies) && !g.bodies.length) warnings.push("no bodies listed");
  }
  const f = c.flow;
  if (!f) err("flow missing");
  else {
    if (!FLOW_DIRECTIONS.includes(f.direction)) err("flow.direction must be one of " + FLOW_DIRECTIONS.join(" "));
    if (!FLOW_DIRECTIONS.includes(f.up)) err("flow.up must be one of " + FLOW_DIRECTIONS.join(" "));
    else if (f.direction && f.up[1] === f.direction[1]) err("flow.up must be perpendicular to flow.direction");
    if (!isNum(f.speed_m_s) || f.speed_m_s <= 0) err("flow.speed_m_s must be > 0");
    else if (f.speed_m_s > 100 && f.fluid !== "Water (20°C)") warnings.push("speeds above ~100 m/s in air break the low-Mach assumption");
    if (!(f.fluid in FLUIDS)) err("flow.fluid must be one of " + Object.keys(FLUIDS).join(", "));
    if (!isNum(f.nu) || f.nu <= 0) err("flow.nu must be > 0");
    if (!isNum(f.rho) || f.rho <= 0) err("flow.rho must be > 0");
  }
  const gr = c.ground;
  if (!gr || typeof gr.enabled !== "boolean") err("ground.enabled must be boolean");
  else if (!isNum(gr.gap_mm) || gr.gap_mm < 0) err("ground.gap_mm must be >= 0");
  const s = c.solver || {};
  if (s.quality != null && !QUALITY_PRESETS.some((q) => q.id === s.quality)) err("solver.quality must be one of " + QUALITY_PRESETS.map((q) => q.id).join(" "));
  if (s.resolution != null && !(Number.isInteger(s.resolution) && s.resolution >= 8)) err("solver.resolution must be an integer >= 8");
  if (s.levels != null && !(Number.isInteger(s.levels) && s.levels >= 1 && s.levels <= 4)) err("solver.levels must be 1..4");
  if (s.precision != null && !PRECISIONS.includes(s.precision)) err("solver.precision must be one of " + PRECISIONS.join(" "));
  if (s.flowThroughs != null && !(isNum(s.flowThroughs) && s.flowThroughs > 0)) err("solver.flowThroughs must be > 0");
  if (s.frames != null && !(Number.isInteger(s.frames) && s.frames >= 1)) err("solver.frames must be an integer >= 1");
  if (!c.results || typeof c.results.results !== "string" || typeof c.results.progress !== "string") err("results.results / results.progress file names missing");
  return { ok: errors.length === 0, errors, warnings };
}

/** Normalise whatever platform.cfd.readResults returned into { progress, results }. */
export function normalizeReadback(r) {
  if (!r || typeof r !== "object") return { progress: null, results: null };
  if ("progress" in r || "results" in r) {
    const p = r.progress && typeof r.progress === "object" ? r.progress : null;
    const res = r.results && typeof r.results === "object" ? r.results : null;
    return { progress: p, results: res };
  }
  if (r.kind === "results") return { progress: null, results: r };
  if (r.kind === "progress") return { progress: r, results: null };
  return isNum(r.Cd) && r.status && r.status !== "running" ? { progress: null, results: r } : { progress: r, results: null };
}
