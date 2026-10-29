// Where the in-app solvers (CFD Sim, FEA Sim) and their Python live, plus a quick pre-launch check
// that Python and the solver's packages are there. Shared by electron/main.cjs, vite.config.js
// (dev server) and the runners (electron/cfd-runner.cjs, electron/fea-runner.cjs).
//
// Sim folder, first match wins:
//   1. the folder set in Settings (config override), if it exists          source "custom"
//   2. <Documents>/<name> with a main.py (the owner's live copy)            source "documents"
//   3. <app root>/sims/<name> with a main.py (copied by Update CAD Modeler.bat)  source "bundled"
//   4. nothing                                                               source "missing"
// Python, first match wins:
//   1. pythonCmd set in Settings                                             source "custom"
//   2. <app root>/sims/.venv python, only when the sim folder is the bundled one  source "bundled"
//   3. "python"                                                              source "system"
// App root: the project folder from source; process.resourcesPath or the exe's folder when packaged.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SIMS = {
  cfd: { name: "CFD Sim", modules: ["numpy", "trimesh", "vtk", "pyvista"], gpu: true },
  fea: { name: "FEA Sim", modules: ["numpy", "scipy", "gmsh"], gpu: false },
};

const NOT_INSTALLED = "Simulations aren't installed yet: run Update CAD Modeler.bat (needs Python 3.12 from python.org).";
const NO_GPU = "3D CFD needs an NVIDIA graphics card (CUDA).";

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const hasMain = (dir) => !!dir && isFile(path.join(dir, "main.py"));

/** Folders that may hold `sims/`, in order. */
function appRoots({ root, packaged, resourcesPath, exeDir } = {}) {
  const list = packaged ? [resourcesPath, exeDir] : [root];
  return [...new Set(list.filter((p) => typeof p === "string" && p).map((p) => path.resolve(p)))];
}

/** The bundled venv's python inside a sims folder. */
function venvPython(simsRoot) {
  return process.platform === "win32" ? path.join(simsRoot, ".venv", "Scripts", "python.exe") : path.join(simsRoot, ".venv", "bin", "python");
}

/**
 * @param {{ name: string, override?: string, documents: string, roots: string[] }} o
 * @returns {{ dir: string, source: "custom"|"documents"|"bundled"|"missing", overrideMissing: boolean }}
 */
function resolveSimDir({ name, override, documents, roots = [] }) {
  const ov = typeof override === "string" && override.trim() ? path.resolve(override.trim()) : null;
  if (ov && isDir(ov)) return { dir: ov, source: "custom", overrideMissing: false };
  const docDir = documents ? path.join(documents, name) : null;
  if (hasMain(docDir)) return { dir: docDir, source: "documents", overrideMissing: !!ov };
  for (const r of roots) {
    const d = path.join(r, "sims", name);
    if (hasMain(d)) return { dir: d, source: "bundled", overrideMissing: !!ov };
  }
  // nothing found: point at where Update CAD Modeler.bat puts it, so messages name a real place
  return { dir: roots.length ? path.join(roots[0], "sims", name) : docDir || name, source: "missing", overrideMissing: !!ov };
}

/**
 * @param {{ override?: string, sim: { dir: string, source: string } }} o
 * @returns {{ cmd: string, source: "custom"|"bundled"|"system" }}
 */
function resolvePython({ override, sim }) {
  if (typeof override === "string" && override.trim()) return { cmd: override.trim(), source: "custom" };
  if (sim && sim.source === "bundled") {
    const py = venvPython(path.dirname(sim.dir));
    if (isFile(py)) return { cmd: py, source: "bundled" };
  }
  return { cmd: "python", source: "system" };
}

/**
 * Everything at once for one solver. `kind` "cfd" | "fea"; `overrides` = the stored config ({ cfdDir |
 * feaDir, pythonCmd }). Returns { dir, dirSource, overrideMissing, pythonCmd, pythonSource, label }.
 */
function resolveSim(kind, { overrides = {}, documents, roots }) {
  const spec = SIMS[kind];
  const sim = resolveSimDir({ name: spec.name, override: overrides[kind + "Dir"], documents, roots });
  const py = resolvePython({ override: overrides.pythonCmd, sim });
  return { dir: sim.dir, dirSource: sim.source, overrideMissing: sim.overrideMissing, pythonCmd: py.cmd, pythonSource: py.source,
    label: sourceLabel(sim.source, sim.dir, documents) };
}

function sourceLabel(source, dir, documents) {
  if (source === "bundled") return "Bundled";
  if (source === "documents") return path.join(path.basename(documents || path.dirname(dir)), path.basename(dir));
  if (source === "custom") return "Custom";
  return "Not installed";
}

/** "python" / a path to python.exe (may contain spaces) / "py -3.12" → { exe, pre }. */
function splitCmd(pythonCmd) {
  if (isFile(pythonCmd)) return { exe: pythonCmd, pre: [] };
  const parts = String(pythonCmd).split(/\s+/).filter(Boolean);
  return { exe: parts[0], pre: parts.slice(1) };
}

function run(exe, args, opts) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 90000, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ err, code: err ? (typeof err.code === "number" ? err.code : null) : 0, spawnError: err && typeof err.code === "string" ? err.code : null,
        stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

const PROBE = [
  "import sys, json, importlib.util as u",
  "m = sys.argv[1].split(',') if len(sys.argv) > 1 and sys.argv[1] else []",
  "print(json.dumps({'version': list(sys.version_info[:3]), 'missing': [x for x in m if u.find_spec(x) is None]}))",
].join("\n");
const GPU_PROBE = [
  "try:",
  "    import cupy as cp",
  "except Exception as e:",
  "    print('NOCUPY', e); raise SystemExit(0)",
  "try:",
  "    n = cp.cuda.runtime.getDeviceCount()",
  "    print('GPU', n)",
  "except Exception as e:",
  "    print('NOGPU', e)",
].join("\n");

/**
 * Quick check before a solve: Python starts, is 3.10+, has the solver's packages, and (CFD, unless cpu)
 * sees a CUDA GPU. Returns { ok: true } or { ok: false, error } with a message for the user.
 */
async function checkPython({ pythonCmd, cwd, modules = [], gpu = false }) {
  const { exe, pre } = splitCmd(pythonCmd);
  if (!exe) return { ok: false, error: NOT_INSTALLED };
  const r = await run(exe, [...pre, "-c", PROBE, modules.join(",")], { cwd });
  const out = r.stdout + r.stderr;
  if (r.spawnError === "ENOENT" || r.code === 9009 || /Microsoft Store|Python was not found|No installed Python found/i.test(out))
    return { ok: false, error: `Python not found ("${pythonCmd}"). ${NOT_INSTALLED}` };
  let info = null;
  try { info = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch {}
  if (!info) return { ok: false, error: `Could not run Python ("${pythonCmd}"): ${(out.trim().split(/\r?\n/).pop() || (r.err && r.err.message) || "no output").slice(0, 300)}` };
  const [maj, min] = info.version;
  if (maj < 3 || (maj === 3 && min < 10)) return { ok: false, error: `Python ${info.version.join(".")} is too old for the simulations (need 3.10 or newer). ${NOT_INSTALLED}` };
  if (info.missing.length) return { ok: false, error: `Python packages missing (${info.missing.join(", ")}). ${NOT_INSTALLED}` };
  if (gpu) {
    const g = await run(exe, [...pre, "-c", GPU_PROBE], { cwd });
    const line = g.stdout.trim().split(/\r?\n/).pop() || "";
    const n = /^GPU (\d+)/.exec(line);
    if (!n || +n[1] < 1) return { ok: false, error: NO_GPU + (/^NOCUPY/.test(line) ? " (The CuPy package is not installed: run Update CAD Modeler.bat on a PC with one.)" : "") };
  }
  return { ok: true, version: info.version.join(".") };
}

/** Turns a solver log into a plain-language reason, or null. */
function friendlyError(logText) {
  const t = String(logText || "");
  const mod = /ModuleNotFoundError: No module named '([\w.]+)'/.exec(t);
  if (mod) {
    if (/^cupy/.test(mod[1])) return NO_GPU;
    return `Python package missing (${mod[1]}). ${NOT_INSTALLED}`;
  }
  if (/CUDA driver|cudaErrorNoDevice|cudaErrorInsufficientDriver|nvcuda\.dll|No CUDA device|CUDARuntimeError/i.test(t)) return NO_GPU;
  return null;
}

module.exports = { SIMS, NOT_INSTALLED, NO_GPU, appRoots, venvPython, resolveSimDir, resolvePython, resolveSim, splitCmd, checkPython, friendlyError, hasMain };
