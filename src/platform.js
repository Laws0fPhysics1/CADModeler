// One interface for everything that touches the OS. In the Electron desktop app
// it talks to window.desktop (electron/preload.cjs); in a plain browser it falls
// back to downloads, <input type=file> and the dev server's /api/bug-report.

const desktop = typeof window !== "undefined" && window.desktop && window.desktop.isDesktop ? window.desktop : null;

export const isDesktop = !!desktop;

// ---------- helpers ----------
async function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError("data must be a Blob, ArrayBuffer, Uint8Array or string");
}

function toBlob(data) {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (typeof data === "string") return new Blob([data], { type: "text/plain" });
  return new Blob([data ?? ""], { type: "application/octet-stream" });
}

function downloadBlob(name, data) {
  const url = URL.createObjectURL(toBlob(data));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "report";

// ---------- files ----------

/**
 * Save data to a file. Desktop: native Save dialog (remembers the last folder)
 * and returns the chosen path, or null if cancelled. Browser: triggers a
 * download and returns the file name.
 * @param {{ defaultName?: string, filters?: {name:string, extensions:string[]}[], data: Blob|ArrayBuffer|Uint8Array|string }} opts
 */
export async function saveFile({ defaultName = "untitled", filters = [], data, where } = {}) {
  if (desktop) return desktop.saveFile({ defaultName, filters, data: await toBytes(data), where });
  return downloadBlob(defaultName, data);
}

/**
 * Ask the user for file(s). Returns null if cancelled, else an array of
 * { name, path?, data: Uint8Array } (path only on desktop).
 */
/** Desktop: rewrite a file the user already picked this run (Save after Save As / Open). Else null. */
/** Where a File dropped from Explorer lives on disk (desktop), else null. Nothing is opened or written. */
export function droppedFilePath(file) {
  try { return desktop && desktop.pathForFile ? desktop.pathForFile(file) : null; } catch (e) { return null; }
}
export async function saveFileTo(filePath, data) {
  if (desktop && desktop.saveFileTo && filePath) return desktop.saveFileTo(filePath, await toBytes(data));
  return null;
}
/**
 * Closing the app (desktop): confirm() -> Promise<boolean> runs when the window is closed; false keeps
 * it open. The browser build does nothing: in the dev preview every design counts as unsaved, and a
 * "Leave site?" prompt would block every reload (agents, the feature tour). Its autosave still restores tabs.
 */
export function onCloseRequest(confirm) {
  if (desktop && desktop.onCloseRequest) desktop.onCloseRequest(confirm);
}
export async function openFile({ filters = [], multiple = false, where } = {}) {
  if (desktop) return desktop.openFile({ filters, multiple, where });
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !!multiple;
    const exts = filters.flatMap((f) => f.extensions || []).filter((e) => e && e !== "*");
    if (exts.length) input.accept = exts.map((e) => "." + String(e).replace(/^\./, "")).join(",");
    input.style.display = "none";
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener("change", async () => {
      const files = [...(input.files || [])];
      if (!files.length) return finish(null);
      finish(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * The Parts folder: where designs are saved by default, listed in the Parts panel's bin with thumbnails
 * (`where: "parts"` on saveFile / openFile starts the dialog there). Desktop: IPC to electron/parts-store.cjs.
 * Browser: the dev server's /api/parts (read-only bin, no thumbnails written), or nothing.
 */
async function devParts(op, args = {}) {
  try {
    const r = await fetch("/api/parts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...args }) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
export const parts = {
  /** { dir } or null when there is no Parts folder (plain browser build) */
  info: () => (desktop && desktop.parts ? desktop.parts.info() : devParts("info")),
  /** [{ file, name, path, mtime, size, thumb }] newest first, or null */
  list: () => (desktop && desktop.parts ? desktop.parts.list() : devParts("list")),
  /** { name, path, data: Uint8Array } */
  open: async (file) => {
    if (desktop && desktop.parts) return desktop.parts.open(file);
    const r = await devParts("open", { file });
    return r && { name: r.name, path: null, data: new TextEncoder().encode(r.text) };
  },
  /** a design was saved at filePath: store its thumbnail (PNG data URL) if that's in the Parts folder */
  writeThumb: (filePath, png) => (desktop && desktop.parts && filePath ? desktop.parts.writeThumb(filePath, png) : Promise.resolve(false)),
  reveal: () => (desktop && desktop.parts ? desktop.parts.reveal() : Promise.resolve(false)),
};

/**
 * Save a set of files as a folder (robot export packages). Desktop: native folder
 * picker, then writes <picked>/<defaultName>/<file> for each entry (names are
 * validated in electron/folder-writer.cjs: no "..", no absolute paths) and
 * returns the folder path, or null if cancelled. Browser: downloads
 * <defaultName>.zip (STORE-only, src/zip.js) and returns its name.
 * @param {{ defaultName: string, files: Object<string, Blob|ArrayBuffer|Uint8Array|string> }} opts
 */
export async function saveFolder({ defaultName = "export", files = {} } = {}) {
  const entries = [];
  for (const [name, data] of Object.entries(files || {})) entries.push([name, typeof data === "string" ? data : await toBytes(data)]);
  if (desktop && desktop.saveFolder) return desktop.saveFolder({ defaultName, files: Object.fromEntries(entries) });
  const { makeZip } = await import("./zip.js");
  const enc = new TextEncoder();
  const zip = makeZip(entries.map(([name, data]) => ({ path: `${defaultName}/${name.replace(/^[\\/]+/, "")}`, data: typeof data === "string" ? enc.encode(data) : data })));
  return downloadBlob(`${defaultName}.zip`, new Blob([zip], { type: "application/zip" }));
}

// ---------- bug reports ----------

/**
 * Save a bug report payload (as built by src/bugreport.js). Desktop writes a
 * folder (report.json, screenshot.png, design.cadm.json, README.md) to
 * <project>/bug-reports when running from source, or
 * Documents/CAD Modeler/bug-reports when packaged. Browser POSTs to the dev
 * server's /api/bug-report and falls back to downloading a .json file.
 * @returns {Promise<{ ok: boolean, path?: string, method?: string, error?: string }>}
 */
export async function saveBugReport(payload) {
  if (desktop) {
    const r = await desktop.saveBugReport(payload);
    return r && r.ok ? { ...r, method: "desktop" } : r;
  }
  try {
    const res = await fetch("/api/bug-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
      const data = await res.json();
      if (data && data.ok) return { ok: true, path: data.path, method: "server" };
    }
  } catch {}
  const name = downloadBlob(`bug-report_${stamp()}_${slug(payload && payload.memo)}.json`, new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" }));
  return { ok: true, path: name, method: "download" };
}

/** Saved bug reports, newest first: [{ name, memo, createdAt, status: "untouched"|"in-work"|"resolved", note, updatedAt, by, screenshot }]. */
export async function listBugReports() {
  if (desktop && desktop.listBugReports) return (await desktop.listBugReports()) || [];
  try { const r = await fetch("/api/bug-reports"); if (r.ok && (r.headers.get("content-type") || "").includes("json")) return await r.json(); } catch {}
  return [];
}
/** Set a report's status (kind "bug" | "feature"); returns { ok, status? , error? }. */
export async function setBugStatus(name, status, note, kind = "bug") {
  if (desktop && desktop.setBugStatus) return desktop.setBugStatus(name, { status, note, kind });
  try {
    const r = await fetch("/api/bug-reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, status, note, kind }) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- CFD Sim integration ----------
// Desktop: IPC to electron/main.cjs. Browser: the Vite dev server's /api/cfd
// (same runner, electron/cfd-runner.cjs), so the preview can run studies too.
// A plain static build has neither; then the case files download instead.

async function devCfd(op, args = {}, binary = false) {
  const res = await fetch("/api/cfd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...args }) });
  if (binary) {
    if (res.status === 404) return null;
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data.value;
}
let devCfdOk = null;
async function hasDevCfd() {
  if (desktop || typeof fetch === "undefined") return false;
  if (devCfdOk == null) devCfdOk = devCfd("getConfig").then((c) => !!(c && c.exchangeDir), () => false);
  return devCfdOk;
}
const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

export const cfd = {
  /** True when studies can run in-app (desktop, or the dev server's /api/cfd). */
  async canRun() {
    return !!desktop || (await hasDevCfd());
  },
  /** @returns {Promise<{ cfdDir: string, pythonCmd: string, exchangeDir: string } | null>} null in a static browser build */
  async getConfig() {
    if (desktop) return desktop.cfd.getConfig();
    return (await hasDevCfd()) ? devCfd("getConfig") : null;
  },
  /** Persist overrides (any of cfdDir, pythonCmd, exchangeDir; "" or null resets to default). Returns the new config. */
  async setConfig(partial) {
    return desktop ? desktop.cfd.setConfig(partial) : null;
  },
  /**
   * Write a case folder <exchangeDir>/<folderName>/ with the given files
   * ({ "geometry.stl": Uint8Array, "case.json": string, ... }). Returns the
   * absolute folder path. Static browser build: downloads each file and returns null.
   */
  async writeCase(folderName, files) {
    const entries = Object.entries(files || {});
    if (desktop) {
      const out = {};
      for (const [name, data] of entries) out[name] = typeof data === "string" ? data : await toBytes(data);
      return desktop.cfd.writeCase(folderName, out);
    }
    if (await hasDevCfd()) {
      const out = {};
      for (const [name, data] of entries) out[name] = typeof data === "string" ? data : { b64: b64(await toBytes(data)) };
      return devCfd("writeCase", { folderName, files: out });
    }
    for (const [name, data] of entries) downloadBlob(`${folderName}_${name.replace(/[\/]/g, "_")}`, data);
    return null;
  },
  /** Open the case in the separate CFD Sim window (`main.py --case`), detached. */
  async launch(casePath) {
    return desktop ? desktop.cfd.launch(casePath) : { ok: false, error: "Desktop app required" };
  },
  /** Run the solver headless inside this app. Resolves once it has started: { ok, pid } or { ok: false, error }. */
  async run(casePath, opts = {}) {
    if (desktop) return desktop.cfd.run(casePath, opts);
    return (await hasDevCfd()) ? devCfd("run", { casePath, opts }) : { ok: false, error: "Desktop app required" };
  },
  /** Ask a running solve to stop (it still writes its results). opts.force kills it. */
  async stop(casePath, opts = {}) {
    if (desktop) return desktop.cfd.stop(casePath, opts);
    return (await hasDevCfd()) ? devCfd("stop", { casePath, opts }) : { ok: false };
  },
  /** { running, known, pid?, exitCode?, startedAt?, logTail? } for a solve started by this app. */
  async status(casePath) {
    if (desktop) return desktop.cfd.status(casePath);
    return (await hasDevCfd()) ? devCfd("status", { casePath }) : { running: false, known: false };
  },
  /** Bytes of <case>/<rel> (rel = viz/<file>, or a top-level .json/.log/.stl), or null if missing. */
  async readFile(casePath, rel) {
    if (desktop) return desktop.cfd.readFile(casePath, rel);
    return (await hasDevCfd()) ? devCfd("readFile", { casePath, rel }, true) : null;
  },
  /** Returns { results, progress } (each parsed JSON or null) or null if neither file exists. */
  async readResults(casePath) {
    if (desktop) return desktop.cfd.readResults(casePath);
    return (await hasDevCfd()) ? devCfd("readResults", { casePath }) : null;
  },
  /** Open the case folder in Explorer. */
  async revealCase(casePath) {
    return desktop ? desktop.cfd.revealCase(casePath) : false;
  },
};

// ---------- FEA Sim integration (static stress) ----------
// Same model as cfd: desktop IPC ("fea:*", electron/fea-runner.cjs) or the dev server's /api/fea.
// Exchange folder: Documents/CAD-FEA Exchange. Case format: docs/fea-exchange.md.
async function devFea(op, args = {}, binary = false) {
  const res = await fetch("/api/fea", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, ...args }) });
  if (binary) {
    if (res.status === 404) return null;
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data.value;
}
let devFeaOk = null;
async function hasDevFea() {
  if (desktop || typeof fetch === "undefined") return false;
  if (devFeaOk == null) devFeaOk = devFea("getConfig").then((c) => !!(c && c.exchangeDir), () => false);
  return devFeaOk;
}
const deskFea = () => (desktop && desktop.fea) || null;

export const fea = {
  /** True when static-stress studies can run in-app (desktop, or the dev server's /api/fea). */
  async canRun() { return !!deskFea() || (await hasDevFea()); },
  /** @returns {Promise<{ feaDir: string, pythonCmd: string, exchangeDir: string } | null>} */
  async getConfig() {
    if (deskFea()) return deskFea().getConfig();
    return (await hasDevFea()) ? devFea("getConfig") : null;
  },
  async setConfig(partial) { return deskFea() ? deskFea().setConfig(partial) : null; },
  /** Write <exchangeDir>/<folderName>/ with the given files; returns the folder path (null = downloaded instead). */
  async writeCase(folderName, files) {
    const entries = Object.entries(files || {});
    if (deskFea()) {
      const out = {};
      for (const [name, data] of entries) out[name] = typeof data === "string" ? data : await toBytes(data);
      return deskFea().writeCase(folderName, out);
    }
    if (await hasDevFea()) {
      const out = {};
      for (const [name, data] of entries) out[name] = typeof data === "string" ? data : { b64: b64(await toBytes(data)) };
      return devFea("writeCase", { folderName, files: out });
    }
    for (const [name, data] of entries) downloadBlob(`${folderName}_${name.replace(/[\/]/g, "_")}`, data);
    return null;
  },
  /** Start the solver headless: { ok, pid } or { ok: false, error }. */
  async run(casePath, opts = {}) {
    if (deskFea()) return deskFea().run(casePath, opts);
    return (await hasDevFea()) ? devFea("run", { casePath, opts }) : { ok: false, error: "Desktop app required" };
  },
  async stop(casePath, opts = {}) {
    if (deskFea()) return deskFea().stop(casePath, opts);
    return (await hasDevFea()) ? devFea("stop", { casePath, opts }) : { ok: false };
  },
  async status(casePath) {
    if (deskFea()) return deskFea().status(casePath);
    return (await hasDevFea()) ? devFea("status", { casePath }) : { running: false, known: false };
  },
  /** Bytes of <case>/<rel> (viz/<file>, or a top-level .json/.log), or null if missing. */
  async readFile(casePath, rel) {
    if (deskFea()) return deskFea().readFile(casePath, rel);
    return (await hasDevFea()) ? devFea("readFile", { casePath, rel }, true) : null;
  },
  /** { results, progress } (each parsed JSON or null), or null if neither exists. */
  async readResults(casePath) {
    if (deskFea()) return deskFea().readResults(casePath);
    return (await hasDevFea()) ? devFea("readResults", { casePath }) : null;
  },
  async revealCase(casePath) { return deskFea() ? deskFea().revealCase(casePath) : false; },
};

// ---------- shell ----------

/** Open an http(s)/mailto URL in the default browser, or a local folder in Explorer (local files are revealed, never executed). */
export async function openExternal(urlOrPath) {
  if (desktop) return desktop.openExternal(urlOrPath);
  if (/^(https?|mailto):/i.test(urlOrPath)) { window.open(urlOrPath, "_blank", "noopener"); return true; }
  return false;
}

// ---------- McMaster-Carr ----------
export const MCMASTER_URL = "https://www.mcmaster.com/";
export const mcmaster = {
  /** True when downloads from the McMaster window come straight back into the app (desktop only). */
  get direct() { return !!(desktop && desktop.mcmaster); },
  /** Desktop: open the McMaster-Carr window (optionally at a part number / search). Browser: open the site in a new tab. */
  async open(query = "") {
    if (desktop && desktop.mcmaster) return desktop.mcmaster.open(query);
    window.open(query ? `${MCMASTER_URL}${encodeURIComponent(query)}/` : MCMASTER_URL, "_blank", "noopener");
    return false;
  },
  /** cb({ name, data } | { name, error }) for each CAD file downloaded in the McMaster window. Returns an unsubscribe function. */
  onFile(cb) { return desktop && desktop.mcmaster ? desktop.mcmaster.onFile(cb) : () => {}; },
};

/** Show a file or folder selected in Explorer. */
export async function revealPath(p) {
  return desktop ? desktop.revealPath(p) : false;
}

/**
 * Desktop only: run cb (may be async, up to ~3 s) before the window closes.
 * Returns an unsubscribe function. No-op in the browser.
 */
export function onBeforeClose(cb) {
  return desktop ? desktop.onBeforeClose(cb) : () => {};
}

// ---------- updates (start page) ----------
export const update = {
  /**
   * Desktop git clones: does GitHub (origin/main) have commits this copy doesn't? Resolves to
   * { state: "available", behind, subject, date } | { state: "current" } | { state: "offline" } |
   * { state: "unavailable" } (browser, dev server, packaged build, not a clone, no git). Never rejects.
   */
  async check() {
    if (!(desktop && desktop.update)) return { state: "unavailable", reason: "browser" };
    try { return (await desktop.update.check()) || { state: "unavailable" }; } catch (e) { return { state: "unavailable", reason: String(e.message || e) }; }
  },
  /** Close the app (unsaved-changes prompt first) and run "Update CAD Modeler.bat". False if not possible. */
  async install() {
    if (!(desktop && desktop.update)) return false;
    try { return !!(await desktop.update.install()); } catch { return false; }
  },
};
