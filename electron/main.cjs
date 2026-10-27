// Electron main process for CAD Modeler.
//
// Production: serves the built dist/ through the privileged app://local/
// protocol (no web server). Dev: pass --dev-url=http://localhost:5180 (see
// electron/dev.cjs) to load the Vite dev server with hot reload.
// --smoke: load the page, wait for window.__app, print SMOKE OK / SMOKE FAIL
// with any console errors, and quit. --smoke-ipc additionally exercises
// saveBugReport / cfd.writeCase / readResults / status / readFile / run's
// path guards, and cleans up after itself.
"use strict";
const { app, BrowserWindow, Menu, protocol, ipcMain, dialog, shell, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { writeBugReport, listBugReports, setBugStatus } = require("./bugreport-writer.cjs");
const { createCfdRunner } = require("./cfd-runner.cjs");
const { createFeaRunner, feaDefaults } = require("./fea-runner.cjs");
const { writeFolder } = require("./folder-writer.cjs");
const { createMcMaster } = require("./mcmaster.cjs");
const partsStore = require("./parts-store.cjs");
const updateCheck = require("./update-check.cjs");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const SCHEME = "app";
const HOST = "local";
const APP_ORIGIN = `${SCHEME}://${HOST}`;

const argv = process.argv.slice(1);
const argValue = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEV_URL = argValue("dev-url") || process.env.CAD_DEV_URL || null;
const SMOKE_IPC = argv.includes("--smoke-ipc");
const SMOKE = SMOKE_IPC || argv.includes("--smoke");
// --user-data=<dir>: a separate profile (own localStorage, config, window state), e.g. for tests;
// it also skips the single-instance lock so it can run next to the user's app.
// --exit-check=run|verify: self-test of the close prompt in that profile (tools/exit-check.cjs).
const USER_DATA = argValue("user-data");
const EXIT_CHECK = argValue("exit-check");

app.setName("CAD Modeler");
if (USER_DATA) app.setPath("userData", path.resolve(USER_DATA));

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// ---------------- config (userData/config.json) ----------------
// Prefer %USERPROFILE%\Documents (where CFD Sim and this project live) over the
// shell's Documents folder, which may be redirected to OneDrive.
const DOCUMENTS = (() => {
  const local = path.join(os.homedir(), "Documents");
  if (fs.existsSync(local)) return local;
  try { return app.getPath("documents"); } catch { return local; }
})();
const CFD_DEFAULTS = {
  cfdDir: path.join(os.homedir(), "Documents", "CFD Sim"),
  pythonCmd: "python",
  exchangeDir: path.join(DOCUMENTS, "CAD-CFD Exchange"),
};
const configFile = () => path.join(app.getPath("userData"), "config.json");
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")) || {}; } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
function updateConfig(fn) { const c = readConfig(); fn(c); writeConfig(c); return c; }
// The Parts folder (default home of saved designs, the Parts panel's bin); config "partsDir" overrides
let partsDirCache = null;
function partsDir() {
  if (!partsDirCache || !fs.existsSync(partsDirCache)) {
    partsDirCache = partsStore.resolvePartsDir({ appRoot: ROOT, packaged: app.isPackaged, exeDir: path.dirname(process.execPath), documents: DOCUMENTS, override: readConfig().partsDir });
  }
  return partsDirCache;
}
function cfdConfig() {
  const c = readConfig().cfd || {};
  const out = { ...CFD_DEFAULTS };
  for (const k of Object.keys(CFD_DEFAULTS)) if (typeof c[k] === "string" && c[k].trim()) out[k] = c[k].trim();
  return out;
}

const cfdRunner = createCfdRunner({ getConfig: () => cfdConfig() });
// FEA Sim (static stress) uses the same runner machinery with its own folder and exchange folder.
const FEA_DEFAULTS = feaDefaults(DOCUMENTS);
function feaConfig() {
  const c = readConfig().fea || {};
  const out = { ...FEA_DEFAULTS };
  for (const k of Object.keys(FEA_DEFAULTS)) if (typeof c[k] === "string" && c[k].trim()) out[k] = c[k].trim();
  return out;
}
const feaRunner = createFeaRunner({ getConfig: () => feaConfig() });

const bugReportDir = () => (app.isPackaged ? path.join(DOCUMENTS, "CAD Modeler", "bug-reports") : path.join(ROOT, "bug-reports"));
const featureDir = () => path.join(path.dirname(bugReportDir()), "feature-requests");
const reportDir = (kind) => (kind === "feature" ? featureDir() : bugReportDir());

// ---------------- path validation helpers ----------------
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
const BAD_NAME = /[<>:"|?*\x00-\x1f]/;
function safeSegment(s, what) {
  if (typeof s !== "string" || !s.trim()) throw new Error(`${what} must be a non-empty string`);
  s = s.trim();
  if (BAD_NAME.test(s) || /[\\/]/.test(s) || s === "." || s === ".." || /[. ]$/.test(s)) throw new Error(`invalid ${what}: ${s}`);
  return s;
}
// "a/b.txt" -> validated relative path (no "..", no absolute, no drive letters)
function safeRelPath(s, what) {
  if (typeof s !== "string" || !s) throw new Error(`${what} must be a non-empty string`);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new Error(`invalid ${what}: ${s}`);
  return path.join(...parts.map((p) => safeSegment(p, what)));
}
function caseDirFromArg(casePath) {
  if (typeof casePath !== "string" || !casePath) throw new Error("casePath must be a string");
  const { exchangeDir } = cfdConfig();
  const p = path.resolve(casePath);
  if (!isInside(p, exchangeDir)) throw new Error(`case folder must be inside the exchange folder (${exchangeDir})`);
  return p;
}
function toBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("data must be a string, ArrayBuffer or Uint8Array");
}
function dialogFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter((f) => f && typeof f.name === "string" && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name, extensions: f.extensions.map((e) => String(e).replace(/^\./, "")).filter(Boolean) }));
}

// ---------------- protocol: app://local/... -> dist/ ----------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};
function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== HOST) return new Response("not found", { status: 404 });
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/" || rel === "") rel = "/index.html";
      const file = path.join(DIST, path.normalize(rel));
      if (!isInside(file, DIST)) return new Response("forbidden", { status: 403 });
      const data = await fsp.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      return new Response(data, { status: 200, headers: { "Content-Type": type, "Cache-Control": "no-cache" } });
    } catch (err) {
      return new Response(`not found: ${err.code || err.message}`, { status: 404 });
    }
  });
}

// ---------------- window state ----------------
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
function loadWindowState() {
  const def = { width: 1600, height: 1000, maximized: false };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (!(s.width > 400 && s.height > 300)) return def;
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      // only restore the position if it is still on a connected display
      const area = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).workArea;
      const visible = s.x < area.x + area.width - 50 && s.x + s.width > area.x + 50 && s.y >= area.y - 20 && s.y < area.y + area.height - 50;
      if (!visible) { delete s.x; delete s.y; }
    }
    return { ...def, ...s };
  } catch { return def; }
}
function saveWindowState(win) {
  if (SMOKE || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

// ---------------- window ----------------
let mainWindow = null;
let beforeCloseRegistered = false;
// Close confirmation (save prompt): the renderer acks within 3 s (or we assume it hung and close),
// then answers true (close) / false (the user cancelled). No timeout once it has acked.
let closeConfirmRegistered = false, closePending = false;
// Files the user picked in a Save / Open dialog this run: Save can rewrite them without asking again
const approvedPaths = new Set();
let allowClose = false;
// Start-page update check: one git fetch per run, started when the app is ready (never blocks startup).
// "Update now" sets runUpdaterOnQuit and closes the window through the normal close protocol; the
// updater bat starts on will-quit, i.e. only if the user didn't cancel the save prompt.
let updatePromise = null, runUpdaterOnQuit = false;
const startUpdateCheck = () => (updatePromise ||= updateCheck.checkForUpdates({ root: ROOT, packaged: app.isPackaged }));

function createWindow() {
  const st = loadWindowState();
  const win = new BrowserWindow({
    title: "CAD Modeler",
    width: st.width, height: st.height, x: st.x, y: st.y,
    minWidth: 960, minHeight: 600,
    backgroundColor: "#1f2125",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.removeMenu();

  win.once("ready-to-show", () => {
    if (SMOKE) return;
    if (st.maximized) win.maximize();
    win.show();
  });

  // DevTools on F12 / Ctrl+Shift+I, reload on Ctrl+Shift+R. Everything else
  // (Ctrl+Z, Ctrl+S, F6, ...) goes to the page untouched.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const k = (input.key || "").toLowerCase();
    if (k === "f12" || (input.control && input.shift && k === "i")) {
      win.webContents.toggleDevTools(); event.preventDefault();
    } else if (input.control && input.shift && k === "r") {
      win.webContents.reloadIgnoringCache(); event.preventDefault();
    }
  });

  // Keep the app on its own origin; links to the web open in the browser.
  const ownOrigin = DEV_URL ? new URL(DEV_URL).origin : APP_ORIGIN;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url) && !url.startsWith(ownOrigin)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ownOrigin)) {
      event.preventDefault();
      if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    saveWindowState(win);
    if (allowClose || SMOKE) return;
    if (closeConfirmRegistered) {
      e.preventDefault();
      if (closePending) return;
      closePending = true;
      let acked = false;
      const close = () => { allowClose = true; if (!win.isDestroyed()) win.close(); };
      const cleanup = () => { closePending = false; clearTimeout(timer); ipcMain.removeListener("desktop:close-ack", onAck); ipcMain.removeListener("desktop:close-answer", onAnswer); };
      const onAck = (ev) => { if (ev.sender === win.webContents) acked = true; };
      const onAnswer = (ev, ok) => { if (ev.sender !== win.webContents) return; cleanup(); if (ok) close(); else runUpdaterOnQuit = false; };
      const timer = setTimeout(() => { if (!acked) { cleanup(); close(); } }, 3000);
      ipcMain.on("desktop:close-ack", onAck);
      ipcMain.on("desktop:close-answer", onAnswer);
      win.webContents.send("desktop:close-request");
      return;
    }
    if (!beforeCloseRegistered) return;
    e.preventDefault();
    let done = false;
    const finish = () => { if (done) return; done = true; allowClose = true; if (!win.isDestroyed()) win.close(); };
    ipcMain.once("desktop:before-close-done", finish);
    setTimeout(finish, 3000);
    win.webContents.send("desktop:before-close");
  });
  win.on("closed", () => { mainWindow = null; });

  win.loadURL(DEV_URL || `${APP_ORIGIN}/index.html`);
  return win;
}

// ---------------- IPC ----------------
function senderOk(event) {
  const url = event.senderFrame?.url || "";
  return url.startsWith(APP_ORIGIN) || (DEV_URL && url.startsWith(new URL(DEV_URL).origin));
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!senderOk(event)) throw new Error("untrusted sender");
    try { return await fn(event, ...args); } catch (err) {
      // rethrow a plain message so the renderer gets a clean error
      throw new Error(String(err && err.message || err));
    }
  });
}

function registerIpc() {
  handle("desktop:saveFile", async (event, opts = {}) => {
    const cfg = readConfig();
    const name = typeof opts.defaultName === "string" ? path.basename(opts.defaultName) : "untitled";
    // designs start in the Parts folder; exports in the last folder used
    const startDir = opts.where === "parts" ? partsDir() : cfg.lastDir && fs.existsSync(cfg.lastDir) ? cfg.lastDir : DOCUMENTS;
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(startDir, name), filters: dialogFilters(opts.filters) });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, toBuffer(opts.data ?? ""));
    approvedPaths.add(path.resolve(res.filePath));
    if (opts.where !== "parts") updateConfig((c) => { c.lastDir = path.dirname(res.filePath); });
    return res.filePath;
  });

  handle("desktop:openFile", async (event, opts = {}) => {
    const cfg = readConfig();
    const startDir = opts.where === "parts" ? partsDir() : cfg.lastDir && fs.existsSync(cfg.lastDir) ? cfg.lastDir : DOCUMENTS;
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      defaultPath: startDir,
      filters: dialogFilters(opts.filters),
      properties: opts.multiple ? ["openFile", "multiSelections"] : ["openFile"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    if (opts.where !== "parts") updateConfig((c) => { c.lastDir = path.dirname(res.filePaths[0]); });
    for (const p of res.filePaths) approvedPaths.add(path.resolve(p));
    return Promise.all(res.filePaths.map(async (p) => ({ name: path.basename(p), path: p, data: new Uint8Array(await fsp.readFile(p)) })));
  });

  // Folder export (robot packages): pick a parent folder, write <parent>/<defaultName>/<files>.
  // Names are validated in folder-writer.cjs (no "..", no absolute paths, must stay inside).
  handle("desktop:saveFolder", async (event, opts = {}) => {
    const cfg = readConfig();
    const startDir = cfg.lastDir && fs.existsSync(cfg.lastDir) ? cfg.lastDir : DOCUMENTS;
    const win = BrowserWindow.fromWebContents(event.sender);
    const folderName = typeof opts.defaultName === "string" && opts.defaultName.trim() ? opts.defaultName.trim() : "export";
    const res = await dialog.showOpenDialog(win, {
      title: `Choose where to create the "${folderName}" folder`,
      defaultPath: startDir, buttonLabel: "Save Here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = await writeFolder(res.filePaths[0], folderName, opts.files);
    updateConfig((c) => { c.lastDir = res.filePaths[0]; });
    return dir;
  });

  handle("desktop:saveBugReport", async (_e, payload) => {
    try {
      const { dir } = await writeBugReport(reportDir(payload && payload.kind), payload);
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  handle("desktop:listBugReports", async () => [...(await listBugReports(bugReportDir(), "bug")), ...(await listBugReports(featureDir(), "feature"))]);
  handle("desktop:setBugStatus", async (_e, name, st) => {
    try { return { ok: true, status: await setBugStatus(reportDir(st && st.kind), name, { ...(st || {}), by: "user" }) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // Insert McMaster-Carr Component: a browser window whose CAD downloads come back as "mcmaster:file"
  const mcmaster = createMcMaster({ getMainWindow: () => mainWindow });
  handle("mcmaster:open", async (_e, query) => mcmaster.open(query));
  handle("desktop:openExternal", async (_e, target) => {
    if (typeof target !== "string" || !target) return false;
    if (/^(https?|mailto):/i.test(target)) { await shell.openExternal(target); return true; }
    // Local paths: open folders; for files just reveal them (never execute).
    const p = path.resolve(target);
    let st; try { st = await fsp.stat(p); } catch { return false; }
    if (st.isDirectory()) return (await shell.openPath(p)) === "";
    shell.showItemInFolder(p);
    return true;
  });

  handle("desktop:revealPath", async (_e, target) => {
    if (typeof target !== "string" || !target) return false;
    const p = path.resolve(target);
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });

  // ---- update check (start page) ----
  handle("update:check", async () => (SMOKE || EXIT_CHECK ? { state: "unavailable", reason: "test run" } : startUpdateCheck()));
  // Runs exactly "<app root>/Update CAD Modeler.bat" (no arguments from the renderer), after the app quits
  handle("update:install", async (event) => {
    if (app.isPackaged || process.platform !== "win32" || !fs.existsSync(updateCheck.updateBatPath(ROOT))) return false;
    runUpdaterOnQuit = true;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close(); else app.quit();
    return true;
  });

  handle("desktop:registerBeforeClose", async () => { beforeCloseRegistered = true; return true; });
  handle("desktop:registerCloseConfirm", async () => { closeConfirmRegistered = true; return true; });
  // Save to a file the user already chose this run (File > Save after Save As / Open); else null
  handle("desktop:saveFileTo", async (_e, filePath, data) => {
    if (typeof filePath !== "string" || !approvedPaths.has(path.resolve(filePath))) return null;
    await fsp.writeFile(filePath, toBuffer(data ?? ""));
    return filePath;
  });

  // ---- Parts folder (Parts panel bin) ----
  handle("parts:info", async () => ({ dir: partsDir() }));
  handle("parts:list", async () => partsStore.listParts(partsDir()));
  handle("parts:open", async (_e, file) => {
    const r = await partsStore.readPart(partsDir(), file);
    approvedPaths.add(path.resolve(r.path)); // File > Save writes back to it
    return r;
  });
  // thumbnail for a design saved into the Parts folder (by full path; ignored when it's elsewhere)
  handle("parts:writeThumb", async (_e, filePath, png) => {
    const file = partsStore.partName(partsDir(), filePath);
    return file ? partsStore.writeThumb(partsDir(), file, png) : false;
  });
  handle("parts:reveal", async () => (await shell.openPath(partsDir())) === "");

  // ---- CFD Sim integration ----
  handle("cfd:getConfig", async () => cfdConfig());

  handle("cfd:setConfig", async (_e, partial) => {
    if (!partial || typeof partial !== "object") throw new Error("setConfig expects an object");
    updateConfig((c) => {
      c.cfd = c.cfd || {};
      for (const k of Object.keys(CFD_DEFAULTS)) {
        if (!(k in partial)) continue;
        const v = partial[k];
        if (v == null || v === "") delete c.cfd[k];
        else if (typeof v === "string") c.cfd[k] = k === "pythonCmd" ? v.trim() : path.resolve(v.trim());
        else throw new Error(`${k} must be a string`);
      }
    });
    return cfdConfig();
  });

  handle("cfd:writeCase", async (_e, folderName, files) => cfdRunner.writeCase(folderName, files));

  handle("cfd:launch", async (_e, casePath) => {
    try {
      const dir = caseDirFromArg(casePath);
      if (!fs.existsSync(dir)) return { ok: false, error: `Case folder not found: ${dir}` };
      const { cfdDir, pythonCmd } = cfdConfig();
      const mainPy = path.join(cfdDir, "main.py");
      if (!fs.existsSync(mainPy)) return { ok: false, error: `CFD Sim not found: ${mainPy} does not exist` };
      // pythonCmd is either a path to an executable (may contain spaces) or a
      // command plus fixed args such as "py -3".
      let exe = pythonCmd, pre = [];
      if (!fs.existsSync(pythonCmd)) { const parts = pythonCmd.split(/\s+/).filter(Boolean); exe = parts[0]; pre = parts.slice(1); }
      const logPath = path.join(dir, "cfd-launch.log");
      const fd = fs.openSync(logPath, "w");
      let child;
      try {
        child = spawn(exe, [...pre, "main.py", "--case", dir], {
          cwd: cfdDir, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
        });
      } finally { fs.closeSync(fd); }
      // Report spawn failures and immediate crashes (bad python, missing module).
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok: true, pid: child.pid }), 2500);
        child.once("error", (err) => { clearTimeout(t); resolve({ ok: false, error: `Could not start "${pythonCmd}": ${err.message}` }); });
        child.once("exit", (code) => {
          clearTimeout(t);
          if (code === 0) return resolve({ ok: true, pid: child.pid });
          let tail = ""; try { tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-8).join("\n"); } catch {}
          resolve({ ok: false, error: `CFD Sim exited with code ${code}${tail ? `:\n${tail}` : ""}` });
        });
      });
      child.unref();
      return result;
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  handle("cfd:readResults", async (_e, casePath) => cfdRunner.readResults(casePath));

  // In-app solver: CFD Sim runs headless as a child of this app (electron/cfd-runner.cjs).
  handle("cfd:run", async (_e, casePath, opts) => cfdRunner.run(casePath, { cpu: !!(opts && opts.cpu) }));
  handle("cfd:stop", async (_e, casePath, opts) => cfdRunner.stop(casePath, { force: !!(opts && opts.force) }));
  handle("cfd:status", async (_e, casePath) => cfdRunner.status(casePath));
  handle("cfd:readFile", async (_e, casePath, rel) => {
    const buf = await cfdRunner.readFile(casePath, rel);
    return buf == null ? null : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  handle("cfd:revealCase", async (_e, casePath) => {
    const dir = caseDirFromArg(casePath);
    if (!fs.existsSync(dir)) return false;
    return (await shell.openPath(dir)) === "";
  });

  // ---- FEA Sim integration (static stress; electron/fea-runner.cjs, docs/fea-exchange.md) ----
  handle("fea:getConfig", async () => feaConfig());
  handle("fea:setConfig", async (_e, partial) => {
    if (!partial || typeof partial !== "object") throw new Error("setConfig expects an object");
    updateConfig((c) => {
      c.fea = c.fea || {};
      for (const k of Object.keys(FEA_DEFAULTS)) {
        if (!(k in partial)) continue;
        const v = partial[k];
        if (v == null || v === "") delete c.fea[k];
        else if (typeof v === "string") c.fea[k] = k === "pythonCmd" ? v.trim() : path.resolve(v.trim());
        else throw new Error(`${k} must be a string`);
      }
    });
    return feaConfig();
  });
  handle("fea:writeCase", async (_e, folderName, files) => feaRunner.writeCase(folderName, files));
  handle("fea:readResults", async (_e, casePath) => feaRunner.readResults(casePath));
  handle("fea:run", async (_e, casePath, opts) => feaRunner.run(casePath, { cpu: !!(opts && opts.cpu) }));
  handle("fea:stop", async (_e, casePath, opts) => feaRunner.stop(casePath, { force: !!(opts && opts.force) }));
  handle("fea:status", async (_e, casePath) => feaRunner.status(casePath));
  handle("fea:readFile", async (_e, casePath, rel) => {
    const buf = await feaRunner.readFile(casePath, rel);
    return buf == null ? null : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  handle("fea:revealCase", async (_e, casePath) => {
    const dir = feaRunner.caseDir(casePath);
    if (!fs.existsSync(dir)) return false;
    return (await shell.openPath(dir)) === "";
  });
}

// ---------------- smoke test ----------------
async function runSmoke(win) {
  const errors = [], warnings = [];
  win.webContents.on("console-message", (e) => {
    const level = e.level ?? e.params?.level;
    const msg = e.message ?? e.params?.message;
    if (level === "error" || level === 3) errors.push(msg);
    else if (level === "warning" || level === 2) warnings.push(msg);
  });
  win.webContents.on("render-process-gone", (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  win.webContents.on("did-fail-load", (_e, code, desc, url) => errors.push(`load failed ${code} ${desc} ${url}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const t0 = Date.now();
  let ok = false, info = "";
  try {
    while (Date.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 500));
      if (win.isDestroyed()) break;
      const s = await js(`({ app: !!window.__app, loading: !document.documentElement.dataset.appReady, failed: (document.getElementById("loading")||{}).textContent || "", desktop: !!window.desktop })`).catch(() => null);
      if (!s) continue;
      if (s.app && !s.loading) {
        ok = true;
        // localStorage persistence check: shows the value written by the previous smoke run
        const prev = await js(`(() => { const p = localStorage.getItem("__smoke_persist"); localStorage.setItem("__smoke_persist", new Date().toISOString()); return p; })()`);
        info = `kernel ready in ${((Date.now() - t0) / 1000).toFixed(1)}s, window.desktop=${s.desktop}, previous smoke run seen in localStorage: ${prev || "none"}`;
        break;
      }
      if (/Failed to start/.test(s.failed)) { info = s.failed; break; }
    }
    if (!ok && !info) info = "timed out waiting for window.__app";
    if (!win.isDestroyed()) {
      // the OpenCascade wasm must be served as application/wasm so compileStreaming works
      const wasmFile = (fs.readdirSync(path.join(DIST, "assets")).find((f) => f.endsWith(".wasm")) || "");
      const wasmUrl = DEV_URL ? null : `${APP_ORIGIN}/assets/${wasmFile}`;
      const wasm = !wasmUrl ? "skipped (dev)" : await js(`(async () => { const r = await fetch(${JSON.stringify(wasmUrl)}); const type = r.headers.get("content-type"); await WebAssembly.compileStreaming(r); return ${JSON.stringify(wasmFile)} + " served as " + type + ", compileStreaming ok"; })()`).catch((err) => "FAILED: " + err.message);
      console.log(`  wasm: ${wasm}`);
      // shape optimization runs in a module worker; 2D flow needs WebGL2 float render targets
      const extra = await js(`(async () => {
        const out = {};
        const c = document.createElement("canvas").getContext("webgl2");
        out.webgl2Float = !!(c && c.getExtension("EXT_color_buffer_float"));
        const t = window.__topo && window.__topo.selfTest ? await window.__topo.selfTest() : "no hook";
        out.topoWorker = t;
        return out;
      })()`).catch((err) => ({ error: err.message }));
      console.log(`  generative: ${JSON.stringify(extra)}`);
      if (extra.error || extra.topoWorker !== "ok" || !extra.webgl2Float) warnings.push(`generative check: ${JSON.stringify(extra)}`);
    }

    if (ok && SMOKE_IPC) {
      const r = await js(`(async () => {
        const out = {};
        const stamp = "smoke-" + Date.now();
        out.cfg = await window.desktop.cfd.getConfig();
        out.casePath = await window.desktop.cfd.writeCase(stamp, { "case.json": JSON.stringify({ smoke: true }), "geometry.stl": new Uint8Array([1,2,3,4]), "results.json": '{"cd":0.5}' });
        out.read = await window.desktop.cfd.readResults(out.casePath);
        out.status = await window.desktop.cfd.status(out.casePath);
        const rf = await window.desktop.cfd.readFile(out.casePath, "results.json");
        out.readFile = rf ? new TextDecoder().decode(rf) : null;
        out.readMissing = await window.desktop.cfd.readFile(out.casePath, "viz/manifest.json");
        try { await window.desktop.cfd.readFile(out.casePath, "../x.json"); out.readTraversal = "NOT BLOCKED"; } catch (e) { out.readTraversal = "blocked"; }
        try { await window.desktop.cfd.readFile(out.casePath, "geometry.exe"); out.readType = "NOT BLOCKED"; } catch (e) { out.readType = "blocked"; }
        out.runOutside = await window.desktop.cfd.run("C:\\Windows").catch((e) => ({ ok: false, error: e.message }));
        try { await window.desktop.cfd.writeCase("../escape", { "a.txt": "x" }); out.traversal = "NOT BLOCKED"; } catch (e) { out.traversal = "blocked"; }
        try { await window.desktop.cfd.writeCase(stamp, { "../../x.txt": "x" }); out.traversal2 = "NOT BLOCKED"; } catch (e) { out.traversal2 = "blocked"; }
        out.launchOutside = await window.desktop.cfd.launch("C:\\\\Windows");
        out.bug = await window.desktop.saveBugReport({ memo: "smoke test", createdAt: new Date().toISOString(), events: [{ t: 1, type: "app", name: "smoke" }], nowT: 2, doc: { features: [] }, screenshot: "data:image/png;base64,iVBORw0KGgo=" });
        out.feaCfg = await window.desktop.fea.getConfig();
        out.feaCase = await window.desktop.fea.writeCase(stamp, { "case.json": JSON.stringify({ smoke: true }), "geometry.step": "ISO-10303-21;", "results.json": '{"maxVonMises_MPa":1}' });
        out.feaRead = await window.desktop.fea.readResults(out.feaCase);
        try { await window.desktop.fea.readFile(out.feaCase, "../x.json"); out.feaTraversal = "NOT BLOCKED"; } catch (e) { out.feaTraversal = "blocked"; }
        out.feaRunOutside = await window.desktop.fea.run("C:\\Windows").catch((e) => ({ ok: false, error: e.message }));
        out.partsInfo = await window.desktop.parts.info();
        out.partsList = await window.desktop.parts.list();
        try { await window.desktop.parts.open("../package.json"); out.partsTraversal = "NOT BLOCKED"; } catch (e) { out.partsTraversal = "blocked"; }
        out.thumbOutside = await window.desktop.parts.writeThumb("C:/Windows/x.cadm.json", "data:image/png;base64,iVBORw0KGgo=");
        out.update = await window.desktop.update.check();
        return out;
      })()`);
      const checks = [];
      const caseFiles = r.casePath && fs.existsSync(r.casePath) ? fs.readdirSync(r.casePath).sort() : [];
      checks.push(["writeCase", isInside(r.casePath, r.cfg.exchangeDir) && caseFiles.join(",") === "case.json,geometry.stl,results.json"]);
      checks.push(["readResults", r.read && r.read.results && r.read.results.cd === 0.5 && r.read.progress === null]);
      checks.push(["status of an idle case", r.status && r.status.running === false]);
      checks.push(["readFile", r.readFile === '{"cd":0.5}' && r.readMissing === null]);
      checks.push(["readFile traversal / type blocked", r.readTraversal === "blocked" && r.readType === "blocked"]);
      checks.push(["run outside exchange refused", r.runOutside && r.runOutside.ok === false]);
      checks.push(["folder traversal blocked", r.traversal === "blocked"]);
      checks.push(["file traversal blocked", r.traversal2 === "blocked"]);
      checks.push(["launch outside exchange refused", r.launchOutside && r.launchOutside.ok === false]);
      const bugFiles = r.bug?.ok && fs.existsSync(r.bug.path) ? fs.readdirSync(r.bug.path).sort() : [];
      checks.push(["saveBugReport", bugFiles.join(",") === "README.md,design.cadm.json,report.json,screenshot.png"]);
      checks.push(["fea: writeCase / readResults / guards", isInside(r.feaCase, r.feaCfg.exchangeDir) && r.feaRead && r.feaRead.results && r.feaRead.results.maxVonMises_MPa === 1 &&
        r.feaTraversal === "blocked" && r.feaRunOutside && r.feaRunOutside.ok === false]);
      checks.push(["parts: folder, list, guards", !!(r.partsInfo && r.partsInfo.dir && fs.existsSync(r.partsInfo.dir)) && Array.isArray(r.partsList) && r.partsTraversal === "blocked" && r.thumbOutside === false]);
      checks.push(["update check answers (unavailable in test runs)", !!(r.update && r.update.state === "unavailable")]);
      if (r.feaCase && isInside(r.feaCase, r.feaCfg.exchangeDir)) fs.rmSync(r.feaCase, { recursive: true, force: true });
      // saveFolder's writer (the IPC handler itself needs a folder dialog, so call the writer directly)
      try {
        const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), "cadm-smoke-"));
        const wrote = await writeFolder(tmpParent, "pkg", { "robot.urdf": "<robot/>", "meshes/a.stl": new Uint8Array([1, 2]) });
        const good = fs.existsSync(path.join(wrote, "meshes", "a.stl"));
        let blocked = 0;
        for (const [f, files] of [["..", { "a.txt": "x" }], ["pkg", { "../a.txt": "x" }], ["pkg", { "C:/a.txt": "x" }]]) {
          try { await writeFolder(tmpParent, f, files); } catch { blocked++; }
        }
        checks.push(["saveFolder writer + traversal guards", good && blocked === 3]);
        fs.rmSync(tmpParent, { recursive: true, force: true });
      } catch (err) { checks.push([`saveFolder writer (${err.message})`, false]); }
      for (const [n, pass] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${n}`);
      console.log(`  case: ${r.casePath}\n  bug report: ${r.bug?.path}`);
      // clean up what we wrote
      if (r.casePath && isInside(r.casePath, r.cfg.exchangeDir)) fs.rmSync(r.casePath, { recursive: true, force: true });
      if (r.bug?.path && isInside(r.bug.path, bugReportDir())) fs.rmSync(r.bug.path, { recursive: true, force: true });
      if (checks.some(([, pass]) => !pass)) { ok = false; info += "; IPC checks failed"; }
    }
  } catch (err) {
    ok = false; info = `smoke error: ${err.message}`;
  }
  console.log(`${ok ? "SMOKE OK" : "SMOKE FAIL"}: ${info} (${DEV_URL || APP_ORIGIN})`);
  if (errors.length) { console.log(`console errors (${errors.length}):`); for (const e of errors) console.log("  " + String(e).split("\n")[0]); }
  if (!win.isDestroyed()) win.destroy();
  setTimeout(() => app.exit(ok ? 0 : 1), 100);
}

// ---------------- exit check (tools/exit-check.cjs) ----------------
// run: make a design, close the window -> the save prompt must appear; Cancel must keep the window;
// close again -> Don't Save must close it. verify (a second launch, same profile): the clean exit left
// no tabs behind, so the app starts with one blank design.
async function runExitCheck(win, phase) {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = async (code, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (win.isDestroyed()) return null; const v = await js(code).catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return null; };
  const out = (ok, msg) => { console.log(`EXIT-CHECK ${phase} ${ok ? "OK" : "FAIL"}: ${msg}`); };
  if (!(await wait(`!!document.documentElement.dataset.appReady`))) { out(false, "app never became ready"); return app.exit(1); }
  if (phase === "verify") {
    const r = await js(`({ tabs: __app.tabs.length, features: __app.doc.features.length, stored: localStorage.getItem("cadmodeler.tabs.v1") })`);
    const ok = r.tabs === 1 && r.features === 0;
    out(ok, JSON.stringify(r));
    allowClose = true; return app.exit(ok ? 0 : 1);
  }
  // start page after a crash (feature request 2026-10-09): leftover tabs are seeded straight into storage
  // and the app exits without the close protocol (as a crash would). Empty leftovers must be dropped and
  // never offered as "Continue"; designs with content still are.
  const seed = async (tabs, active) => {
    const blank = { name: "Untitled", features: [], marker: 0, counters: {}, hidden: [], appearances: {}, studies: [] };
    const docs = tabs.map(([id, name, full]) => [id, { ...blank, name, ...(full ? { features: [{ id: "f1", type: "box", name: "Box1", length: 10, width: 10, height: 10, operation: "new" }], marker: 1 } : {}) }]);
    await js(`(() => { const S = "cadmodeler.doc.v1"; const docs = ${JSON.stringify(docs)};
      for (const [id, d] of docs) localStorage.setItem(id === ${JSON.stringify(active)} ? S : S + "#" + id, JSON.stringify(d));
      localStorage.setItem("cadmodeler.tabs.v1", JSON.stringify({ active: ${JSON.stringify(active)}, ids: docs.map((x) => x[0]) })); })()`);
    await win.webContents.session.flushStorageData();
    out(true, `left ${tabs.length} tabs behind`);
    allowClose = true; app.exit(0);
  };
  const startPage = `(() => { const c = document.querySelector("#loading .hl-continue"), chips = [...document.querySelectorAll("#loading .hl-chip > span")].map((b) => b.textContent);
    return { open: __startPage.isOpen(), tabs: __app.tabs.map((t) => t.doc.name), active: __app.doc.name, features: __app.doc.features.length,
      continueShown: !!c && getComputedStyle(c).display !== "none", continueText: c ? c.querySelector(".hl-cname").textContent : null, chips,
      keys: Object.keys(localStorage).filter((k) => k.startsWith("cadmodeler.doc.v1#")).sort(), stored: localStorage.getItem("cadmodeler.tabs.v1") }; })()`;
  if (phase === "crash-mixed") return seed([["tE", "Untitled", false], ["tF", "Full", true], ["tE2", "Untitled", false]], "tE");
  if (phase === "crash-empty") return seed([["tE", "Untitled", false], ["tE2", "Untitled", false]], "tE2");
  if (phase === "after-mixed" || phase === "after-empty") {
    await wait(`!!document.querySelector("#loading .hero-launch:not(.loading)")`, 10000);
    const r = await js(startPage);
    const ok = phase === "after-mixed"
      ? r.open && r.tabs.join() === "Full" && r.active === "Full" && r.continueShown && r.continueText === "Full" && r.chips.join() === "Full" && !r.keys.length && JSON.parse(r.stored || "{}").ids?.length === 1
      : r.open && r.tabs.length === 1 && r.features === 0 && !r.continueShown && !r.chips.length && !r.keys.length && !/"tE2?"/.test(r.stored || "");
    out(ok, JSON.stringify(r));
    allowClose = true; return app.exit(ok ? 0 : 1);
  }
  await js(`__startPage.close(); __io.importFileData("t.json", new TextEncoder().encode(JSON.stringify({ name: "ExitCheck", features: [{ id: "f1", type: "box", name: "Box1", length: 10, width: 10, height: 10, operation: "new" }], marker: 1 })))`);
  await new Promise((r) => setTimeout(r, 1500));
  win.close();
  if (!(await wait(`!!document.querySelector(".exit-card")`, 5000))) { out(false, "no save prompt after closing"); return app.exit(1); }
  await js(`[...document.querySelectorAll(".exit-card .btn")].find((b) => b.textContent === "Cancel").click()`);
  await new Promise((r) => setTimeout(r, 4000)); // longer than main's 3 s ack timeout
  if (win.isDestroyed()) { out(false, "Cancel closed the window"); return app.exit(1); }
  win.close();
  if (!(await wait(`!!document.querySelector(".exit-card")`, 5000))) { out(false, "no save prompt the second time"); return app.exit(1); }
  const closed = new Promise((r) => win.once("closed", () => r(true)));
  await js(`[...document.querySelectorAll(".exit-card .btn")].find((b) => b.textContent === "Don't Save").click()`);
  const ok = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 8000))]);
  out(ok, ok ? "prompt shown, Cancel kept the window, Don't Save closed it" : "Don't Save didn't close the window");
  if (!ok) app.exit(1);
}

// ---------------- startup ----------------
if (!SMOKE && !USER_DATA && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerAppProtocol();
    registerIpc();
    if (!DEV_URL && !fs.existsSync(path.join(DIST, "index.html"))) {
      dialog.showErrorBox("CAD Modeler", `The app has not been built yet (${path.join(DIST, "index.html")} is missing).\n\nRun "npm start" or "Start CAD Modeler.bat".`);
      app.exit(1);
      return;
    }
    const win = createWindow();
    if (!SMOKE && !EXIT_CHECK) startUpdateCheck();
    if (SMOKE) runSmoke(win);
    else if (EXIT_CHECK) runExitCheck(win, EXIT_CHECK);
  });

  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => { if (runUpdaterOnQuit) { runUpdaterOnQuit = false; try { updateCheck.launchUpdater(ROOT); } catch (e) { console.error(e); } } });
  // A running simulation belongs to this app: ask it to stop (it writes its results) before quitting.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting || !(cfdRunner.running().length || feaRunner.running().length)) return;
    e.preventDefault(); quitting = true;
    Promise.all([cfdRunner.stopAll(5000), feaRunner.stopAll(5000)]).finally(() => app.quit());
  });
}
