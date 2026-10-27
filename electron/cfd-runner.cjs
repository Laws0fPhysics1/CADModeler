// Runs CFD Sim's solver headless as a child process of CAD Modeler, so a CFD
// study runs "inside" the CAD app: no CFD Sim window opens. Shared by the
// Electron main process (IPC) and the Vite dev server (/api/cfd/*, for the
// browser preview).
//
//   run(casePath)            python -u main.py --case <dir> --headless   (cwd = cfdDir, log = <dir>/cfd-run.log)
//   stop(casePath)           creates <dir>/stop.request; the solver writes its results and exits.
//                            Killed after STOP_GRACE_MS if it does not.
//   status(casePath)         { running, pid, exitCode, startedAt, logTail }
//   readFile(casePath, rel)  bytes of <dir>/<rel>; rel limited to viz/*, *.json and *.log
//
// Every path is validated to lie inside exchangeDir. No other executable or
// arguments can be run through this module.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn, execFile } = require("node:child_process");

const STOP_FILE = "stop.request";
const STOP_GRACE_MS = 30000;
const BAD_NAME = /[<>:"|?*\x00-\x1f]/;

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function safeSegment(s, what) {
  if (typeof s !== "string" || !s.trim()) throw new Error(`${what} must be a non-empty string`);
  s = s.trim();
  if (BAD_NAME.test(s) || /[\\/]/.test(s) || s === "." || s === ".." || /[. ]$/.test(s)) throw new Error(`invalid ${what}: ${s}`);
  return s;
}
function safeRelPath(s, what) {
  if (typeof s !== "string" || !s) throw new Error(`${what} must be a non-empty string`);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new Error(`invalid ${what}: ${s}`);
  return path.join(...parts.map((p) => safeSegment(p, what)));
}
function toBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("data must be a string, ArrayBuffer or Uint8Array");
}
// readable files: viz/<name>, top-level *.json / *.log / *.stl
const READABLE = /^(viz[\\/][\w.-]+|[\w.-]+\.(json|log|stl))$/i;

function splitCmd(pythonCmd) {
  if (fs.existsSync(pythonCmd)) return { exe: pythonCmd, pre: [] };
  const parts = String(pythonCmd).split(/\s+/).filter(Boolean);
  return { exe: parts[0], pre: parts.slice(1) };
}

function tail(file, lines = 12) {
  try { return fs.readFileSync(file, "utf8").replace(/\r/g, "").trim().split("\n").slice(-lines).join("\n"); } catch { return ""; }
}

/**
 * @param {{ getConfig: () => { cfdDir: string, pythonCmd: string, exchangeDir: string } }} opts
 * The optional keys let other solvers reuse this runner (electron/fea-runner.cjs): appDirKey names the
 * config key of the solver's folder (holding main.py), logName the per-case log file, label the
 * solver's name in error messages. The defaults are CFD Sim's.
 */
function createCfdRunner({ getConfig, appDirKey = "cfdDir", logName = "cfd-run.log", label = "CFD solver", settingsHint = "Set the CFD Sim folder in the CFD Study settings." }) {
  const procs = new Map(); // case dir -> { child, pid, startedAt, exitCode, log, killTimer }

  function caseDir(casePath) {
    if (typeof casePath !== "string" || !casePath) throw new Error("casePath must be a string");
    const { exchangeDir } = getConfig();
    const p = path.resolve(casePath);
    if (!isInside(p, exchangeDir)) throw new Error(`case folder must be inside the exchange folder (${exchangeDir})`);
    return p;
  }

  async function writeCase(folderName, files) {
    const { exchangeDir } = getConfig();
    const dir = path.join(exchangeDir, safeSegment(folderName, "folderName"));
    if (!files || typeof files !== "object") throw new Error("files must be an object");
    const entries = Object.entries(files).map(([name, data]) => {
      const p = path.join(dir, safeRelPath(name, "file name"));
      if (!isInside(p, dir)) throw new Error(`invalid file name: ${name}`);
      return [p, toBuffer(data)];
    });
    await fsp.mkdir(dir, { recursive: true });
    for (const [p, buf] of entries) {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, buf);
    }
    return dir;
  }

  async function readResults(casePath) {
    const dir = caseDir(casePath);
    const readJson = async (n) => { try { return JSON.parse(await fsp.readFile(path.join(dir, n), "utf8")); } catch { return null; } };
    const [results, progress] = await Promise.all([readJson("results.json"), readJson("progress.json")]);
    if (results == null && progress == null) return null;
    return { results, progress };
  }

  async function readFile(casePath, rel) {
    const dir = caseDir(casePath);
    if (typeof rel !== "string" || !READABLE.test(rel)) throw new Error(`not a readable case file: ${rel}`);
    const p = path.join(dir, safeRelPath(rel, "file name"));
    if (!isInside(p, dir)) throw new Error(`invalid file name: ${rel}`);
    try { return await fsp.readFile(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }

  async function run(casePath, { cpu = false } = {}) {
    const dir = caseDir(casePath);
    if (!fs.existsSync(path.join(dir, "case.json"))) return { ok: false, error: `No case.json in ${dir}` };
    const cur = procs.get(dir);
    if (cur && cur.exitCode == null) return { ok: false, error: "A simulation is already running for this case" };
    const cfg = getConfig();
    const cfdDir = cfg[appDirKey], pythonCmd = cfg.pythonCmd;
    const mainPy = path.join(cfdDir, "main.py");
    if (!fs.existsSync(mainPy)) return { ok: false, error: `${label} not found: ${mainPy} does not exist. ${settingsHint}` };
    for (const f of [STOP_FILE, "results.json", "progress.json"]) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
    const { exe, pre } = splitCmd(pythonCmd);
    const log = path.join(dir, logName);
    const fd = fs.openSync(log, "w");
    let child;
    try {
      child = spawn(exe, [...pre, "-u", "main.py", "--case", dir, "--headless", ...(cpu ? ["--cpu"] : [])], {
        cwd: cfdDir, windowsHide: true, stdio: ["ignore", fd, fd],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
    } finally { fs.closeSync(fd); }
    const rec = { child, pid: child.pid, startedAt: new Date().toISOString(), exitCode: null, log, killTimer: null };
    procs.set(dir, rec);
    const started = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: true, pid: child.pid }), 1500);
      child.once("error", (err) => { clearTimeout(t); rec.exitCode = -1; resolve({ ok: false, error: `Could not start "${pythonCmd}": ${err.message}` }); });
      child.once("exit", (code) => {
        rec.exitCode = code == null ? -1 : code;
        if (rec.killTimer) clearTimeout(rec.killTimer);
        clearTimeout(t);
        resolve(code === 0 ? { ok: true, pid: child.pid } : { ok: false, error: `${label} exited with code ${code}${tail(log) ? `:\n${tail(log)}` : ""}` });
      });
    });
    return started;
  }

  function killTree(pid) {
    if (!pid) return;
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    else try { process.kill(pid, "SIGKILL"); } catch {}
  }

  async function stop(casePath, { force = false } = {}) {
    const dir = caseDir(casePath);
    const rec = procs.get(dir);
    if (!rec || rec.exitCode != null) return { ok: true, running: false };
    if (force) { killTree(rec.pid); return { ok: true, running: true, killed: true }; }
    await fsp.writeFile(path.join(dir, STOP_FILE), new Date().toISOString());
    if (!rec.killTimer) rec.killTimer = setTimeout(() => { if (rec.exitCode == null) killTree(rec.pid); }, STOP_GRACE_MS);
    return { ok: true, running: true };
  }

  function status(casePath) {
    const dir = caseDir(casePath);
    const rec = procs.get(dir);
    if (!rec) return { running: false, known: false };
    return { running: rec.exitCode == null, known: true, pid: rec.pid, exitCode: rec.exitCode, startedAt: rec.startedAt,
      logTail: rec.exitCode != null && rec.exitCode !== 0 ? tail(rec.log, 20) : "" };
  }

  /** Stop everything (app quit): ask nicely, then kill whatever is left after `ms`. */
  async function stopAll(ms = 4000) {
    const live = [...procs.entries()].filter(([, r]) => r.exitCode == null);
    if (!live.length) return;
    for (const [dir] of live) { try { fs.writeFileSync(path.join(dir, STOP_FILE), "app quit"); } catch {} }
    const t0 = Date.now();
    while (Date.now() - t0 < ms && live.some(([, r]) => r.exitCode == null)) await new Promise((r) => setTimeout(r, 100));
    for (const [, r] of live) if (r.exitCode == null) killTree(r.pid);
  }

  const running = () => [...procs.entries()].filter(([, r]) => r.exitCode == null).map(([d]) => d);

  return { caseDir, writeCase, readResults, readFile, run, stop, status, stopAll, running };
}

module.exports = { createCfdRunner, isInside, safeSegment, safeRelPath, toBuffer, STOP_FILE };
