// Launcher for the desktop app.
//   node electron/run.cjs start      build dist/ if stale, then run Electron on it (waits)
//   node electron/run.cjs launch     same, but start Electron detached and exit (used by the .bat)
//   node electron/run.cjs build      build dist/ only if it is missing or stale
//   node electron/run.cjs dev        Vite dev server on :5180 + Electron pointed at it (hot reload)
// Extra args after the mode are passed to Electron (e.g. --smoke).
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const DIST_INDEX = path.join(ROOT, "dist", "index.html");
const VITE = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const DEV_PORT = 5180;

function electronExe() {
  const pkg = path.join(ROOT, "node_modules", "electron");
  const pathTxt = path.join(pkg, "path.txt");
  // Some npm configurations skip install scripts, so fetch the binary if needed.
  if (!fs.existsSync(pathTxt) || !fs.existsSync(path.join(pkg, "dist", fs.readFileSync(pathTxt, "utf8").trim()))) {
    console.log("Downloading the Electron runtime (one time)...");
    const r = spawnSync(process.execPath, [path.join(pkg, "install.js")], { cwd: pkg, stdio: "inherit" });
    if (r.status !== 0) throw new Error("Electron download failed");
  }
  return path.join(pkg, "dist", fs.readFileSync(pathTxt, "utf8").trim());
}

function newestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let m = st.mtimeMs;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newestMtime(path.join(p, e)));
  return m;
}

function isStale() {
  if (!fs.existsSync(DIST_INDEX)) return true;
  const built = fs.statSync(DIST_INDEX).mtimeMs;
  const src = Math.max(...["src", "public", "index.html", "vite.config.js"].map((p) => newestMtime(path.join(ROOT, p))));
  return src > built;
}

function buildIfStale() {
  if (!isStale()) return;
  console.log("Building CAD Modeler...");
  const r = spawnSync(process.execPath, [VITE, "build"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error("Build failed."); process.exit(r.status || 1); }
}

function waitForServer(url, timeoutMs = 60000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on("error", () => (Date.now() - t0 > timeoutMs ? reject(new Error(`no response from ${url}`)) : setTimeout(tryOnce, 300)));
    };
    tryOnce();
  });
}

async function main() {
  const [mode = "start", ...extra] = process.argv.slice(2);
  if (mode === "build") return buildIfStale();

  if (mode === "start" || mode === "launch") {
    buildIfStale();
    const exe = electronExe();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (mode === "launch") {
      spawn(exe, [ROOT, ...extra], { cwd: ROOT, env, detached: true, stdio: "ignore" }).unref();
      return;
    }
    const child = spawn(exe, [ROOT, ...extra], { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  if (mode === "dev") {
    const url = `http://localhost:${DEV_PORT}`;
    let stopVite = () => {};
    // Reuse a dev server that is already running on the port.
    const running = await waitForServer(url, 0).then(() => true, () => false);
    if (running) {
      console.log(`Using the dev server already running at ${url}`);
    } else {
      const vite = spawn(process.execPath, [VITE, "--port", String(DEV_PORT), "--strictPort"], { cwd: ROOT, stdio: "inherit" });
      stopVite = () => { if (vite.exitCode === null) vite.kill(); };
      process.on("exit", stopVite);
      process.on("SIGINT", () => { stopVite(); process.exit(130); });
      vite.on("exit", (code) => { console.log(`Vite exited (${code})`); process.exit(code ?? 1); });
      await waitForServer(url);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const el = spawn(electronExe(), [ROOT, `--dev-url=${url}`, ...extra], { cwd: ROOT, env, stdio: "inherit" });
    el.on("exit", (code) => { stopVite(); process.exit(code ?? 0); });
    return;
  }

  console.error(`unknown mode: ${mode} (use start | launch | build | dev)`);
  process.exit(2);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
