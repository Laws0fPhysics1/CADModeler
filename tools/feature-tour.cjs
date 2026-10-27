// Feature tour: drives CAD Modeler through tools/tour-scenes.cjs and saves a full-window screenshot of
// each scene, plus docs/feature-tour/index.html (a gallery with what each feature does).
//
//   1. start the dev server (Vite on :5180; the CFD / FEA results are read through its /api routes)
//   2. node_modules/electron/dist/electron.exe tools/feature-tour.cjs [--only id,id] [--url http://localhost:5180/]
//
// It runs in its own temporary profile, so the designs saved in the app (localStorage) are never touched.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { scenes, helpers } = require("./tour-scenes.cjs");

const argv = process.argv;
const arg = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
const URL = arg("--url") || "http://localhost:5180/";
const ONLY = arg("--only") ? arg("--only").split(",") : null;
const OUT = path.join(__dirname, "..", "docs", "feature-tour");
const W = 1600, H = 960;
const DOC_KEY = "cadmodeler.doc.v1", PREFS_KEY = "cadmodeler.prefs";

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cadmodeler-tour-")));
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// the FEA scene shows the user's existing study (a copy of that design; the case folder is only read)
const FEA_DOC = {
  name: "Extrusion Cantilever",
  features: [{ type: "stock", item: "tslot-m2040", length: 300, params: {}, material: "", place: null, direction: "x", offset: 0, rotation: 0, id: "fmuznirf80", name: "Stock1" }],
  marker: 1, counters: { stock: 1 }, hidden: [], appearances: { Body1: { materialId: "aluminum-6061", auto: true } },
  studies: [{
    id: "fmuznixfs1", kind: "fea", name: "Static Stress 1 · 200 N",
    casePath: path.join(os.homedir(), "Documents", "CAD-FEA Exchange", "Extrusion_Cantilever_FEA_20261008-074829"), folderName: "Extrusion_Cantilever_FEA_20261008-074829",
    settings: { bodyId: "Body1", quality: "medium", gravity: { enabled: false },
      fixtures: [{ body: "Body1", idx: 76, pt: [0, 0, 10], n: [-1, 0, 0], area_mm2: 387.27, type: "PLANE" }],
      loads: [{ type: "force", faces: [{ body: "Body1", idx: 77, pt: [300, 0, 10], n: [1, 0, 0], area_mm2: 387.27, type: "PLANE" }], vector_N: [0, 0, -200], magnitude_N: 200, direction: "-Z", flip: false }], summary: "200 N" },
    bodies: ["2040 T-slot × 300 mm"], createdAt: "2026-10-08T14:48:30.664Z", status: "completed",
    results: { status: "completed", maxVonMises_MPa: 58.118, maxDisplacement_mm: 1.788, minSafetyFactor: 4.749 },
  }],
  assembly: { components: [], joints: [], links: [] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // offscreen rendering: nothing appears on screen, but animation frames (camera moves, WebGL) keep running
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const errors = [];
  win.webContents.on("console-message", (e) => { const lvl = e.level ?? e.params?.level; const msg = e.message ?? e.params?.message; if (lvl === "error" || lvl === 3) errors.push(msg); });

  async function load({ doc, theme } = {}) {
    if (doc) await js(`localStorage.setItem(${JSON.stringify(DOC_KEY)}, ${JSON.stringify(JSON.stringify(doc))}); true`);
    if (theme) await js(`localStorage.setItem(${JSON.stringify(PREFS_KEY)}, ${JSON.stringify(JSON.stringify({ theme }))}); true`);
    await win.loadURL(URL);
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const ok = await js(`!!window.__app && !!document.documentElement.dataset.appReady`).catch(() => false);
      if (ok) break;
    }
    await js(`window.__startPage && window.__startPage.close(); true`); // the start page would cover every shot
    await js(`(${helpers.toString()})(); true`);
    await sleep(800);
  }

  await win.loadURL(URL);
  await load();
  const manifest = [];
  let gearsDoc = null;
  for (const [n, sc] of scenes.entries()) {
    if (ONLY && !ONLY.includes(sc.id)) continue;
    const t0 = Date.now();
    errors.length = 0;
    let doc = sc.doc;
    if (sc.id === "fea") doc = FEA_DOC;
    if (sc.id === "dark-theme") doc = gearsDoc || undefined;
    if (doc || sc.theme) await load({ doc, theme: sc.theme || "light" });
    let err = null;
    try { await js(`(${sc.run.toString().replace(/^async run\(\)/, "async function ()")})()`); } catch (e) { err = String(e.message || e); }
    await sleep(600);
    if (sc.id === "motion-link") gearsDoc = JSON.parse(await js(`localStorage.getItem(${JSON.stringify(DOC_KEY)})`));
    const img = await win.webContents.capturePage();
    const file = `${String(n + 1).padStart(2, "0")}-${sc.id}.jpg`;
    fs.writeFileSync(path.join(OUT, file), img.toJPEG(88));
    manifest.push({ id: sc.id, title: sc.title, blurb: sc.blurb, file, error: err, consoleErrors: [...errors] });
    console.log(`${file}  ${((Date.now() - t0) / 1000).toFixed(1)} s${err ? "  ERROR " + err : ""}${errors.length ? "  console: " + errors.slice(0, 2).join(" | ") : ""}`);
    if (sc.theme) await load({ theme: "light" });
  }
  // keep earlier scenes when re-running a subset
  const mfile = path.join(OUT, "manifest.json");
  let all = manifest;
  if (ONLY && fs.existsSync(mfile)) {
    const old = JSON.parse(fs.readFileSync(mfile, "utf8"));
    all = scenes.map((s) => manifest.find((m) => m.id === s.id) || old.find((m) => m.id === s.id)).filter(Boolean);
  }
  fs.writeFileSync(mfile, JSON.stringify(all, null, 1));
  fs.writeFileSync(path.join(OUT, "index.html"), gallery(all));
  console.log(`TOUR DONE: ${all.length} scenes -> ${OUT}`);
  app.quit();
});

function gallery(items) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAD Modeler features</title>
<style>
:root { --bg: #f4f5f7; --card: #fff; --ink: #1d2733; --muted: #5b6673; --line: #dde1e6; --accent: #0696d7; }
@media (prefers-color-scheme: dark) { :root { --bg: #17191c; --card: #212429; --ink: #e8ebef; --muted: #9aa4af; --line: #31353b; --accent: #38b2ec; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
header { max-width: 1180px; margin: 0 auto; padding: 36px 16px 12px; }
h1 { margin: 0 0 6px; font-size: 28px; }
header p { margin: 0; color: var(--muted); max-width: 70ch; }
nav { max-width: 1180px; margin: 0 auto; padding: 10px 16px 0; display: flex; flex-wrap: wrap; gap: 6px; }
nav a { font-size: 13px; color: var(--accent); text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; background: var(--card); }
main { max-width: 1180px; margin: 0 auto; padding: 16px; display: grid; gap: 22px; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
article img { display: block; width: 100%; height: auto; border-bottom: 1px solid var(--line); cursor: zoom-in; }
article div { padding: 14px 18px 16px; }
h2 { margin: 0 0 4px; font-size: 19px; }
h2 span { color: var(--muted); font-weight: 400; font-size: 14px; margin-right: 8px; }
article p { margin: 0; color: var(--muted); }
</style></head><body>
<header><h1>CAD Modeler: feature tour</h1><p>A Fusion 360-style parametric modeler (Electron, three.js, OpenCascade) with in-app CFD and FEA, generative design and a gear wizard. Every screenshot below was captured from the running app by <code>tools/feature-tour.cjs</code>.</p></header>
<nav>${items.map((m, i) => `<a href="#${m.id}">${i + 1}. ${esc(m.title)}</a>`).join("")}</nav>
<main>${items.map((m, i) => `
<article id="${m.id}"><a href="${m.file}"><img src="${m.file}" alt="${esc(m.title)}" loading="lazy" width="${W}" height="${H}"></a>
<div><h2><span>${i + 1}</span>${esc(m.title)}</h2><p>${esc(m.blurb)}</p></div></article>`).join("")}
</main></body></html>
`;
}
