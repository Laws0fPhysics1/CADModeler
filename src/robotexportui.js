// EXPORT ROBOT dialog (URDF / USD for Isaac Sim and Isaac Lab) and the window.__robot
// debug hook. The package itself is built by robotexport.js and saved as a folder
// through platform.saveFolder (desktop: folder picker; browser: .zip download).
import "./robotexport.css";
import * as platform from "./platform.js";
import { buildRobot, describeRobot, fileList, DEFAULTS, safeName } from "./robotexport.js";

const PREFS_KEY = "cadmodeler.robotexport";
const ROBOT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><rect x="3" y="19" width="10" height="3" rx="0.5"/><circle cx="8" cy="16.5" r="1.6"/><path d="M8 15 L12 7"/><circle cx="12.5" cy="6" r="1.6"/><path d="M14 6.5 L19 9"/><path d="M19 9 l2 -1.5 M19 9 l1.5 2"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
let current = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} };
const FORMATS = { both: ["usd", "urdf"], usd: ["usd"], urdf: ["urdf"] };

/** Build options from a partial set (used by the dialog and the debug hook). */
function optionsFrom(ctx, o = {}) {
  const doc = ctx.getDoc();
  return { ...DEFAULTS, name: safeName(o.name || (doc && doc.name) || "robot", "robot"), ...o };
}

/** Build (and optionally save) a package. Returns { path, name, summary, warnings, links, joints, files: [{path, bytes}] }. */
async function runExport(ctx, opts, { save = true } = {}) {
  const pkg = buildRobot(ctx.getDoc(), ctx.getState(), opts);
  let saved = null;
  if (save) saved = await platform.saveFolder({ defaultName: pkg.name, files: pkg.files });
  return { path: saved, name: pkg.name, summary: pkg.summary, warnings: pkg.warnings, fixedBase: pkg.fixedBase, links: pkg.links, joints: pkg.joints, files: fileList(pkg.files), pkg };
}

/**
 * Open the Export Robot dialog.
 * @param {{ getDoc: () => object, getState: () => object, toast: (m:string) => void, logEvent?: Function, host: HTMLElement }} ctx
 */
export function openRobotExport(ctx) {
  if (current) { current.el.classList.add("rbx-flash"); setTimeout(() => current && current.el.classList.remove("rbx-flash"), 400); return current; }
  const toast = ctx.toast || (() => {});
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const prefs = loadPrefs();
  const doc = ctx.getDoc();

  const nameInp = h("input", { value: safeName(prefs.lastName && prefs.docName === doc.name ? prefs.lastName : doc.name || "robot", "robot"), spellcheck: "false" });
  const sel = (opts, value) => { const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l))); s.value = value; return s; };
  const fmtSel = sel([["both", "USD + URDF"], ["usd", "USD (Isaac Sim / Isaac Lab)"], ["urdf", "URDF"]], prefs.format || "both");
  const meshSel = sel([["obj", "OBJ with colours"], ["stl", "STL (binary)"]], prefs.meshFormat || "obj");
  const qualSel = sel([["coarse", "Low"], ["medium", "Medium"], ["fine", "High"]], prefs.quality || "medium");
  const collSel = sel([["convexHull", "Convex hull per body"], ["convexDecomposition", "Convex decomposition"], ["boundingCube", "Bounding box"], ["none", "None (visual only)"]], prefs.collision || "convexHull");
  const baseSel = sel([["auto", "From assembly (grounded = fixed)"], ["fixed", "Fixed to the world"], ["floating", "Floating"]], prefs.base || "auto");
  const numInp = (v, unit) => { const i = h("input", { value: String(v), inputmode: "decimal", spellcheck: "false" }); return { i, el: h("div", { class: "num" }, i, h("em", {}, unit)) }; };
  const kA = numInp(prefs.angularStiffness ?? DEFAULTS.angularStiffness, "N·m/rad"), dA = numInp(prefs.angularDamping ?? DEFAULTS.angularDamping, "N·m·s/rad");
  const kL = numInp(prefs.linearStiffness ?? DEFAULTS.linearStiffness, "N/m"), dL = numInp(prefs.linearDamping ?? DEFAULTS.linearDamping, "N·s/m");
  const sceneChk = h("input", { type: "checkbox" }); sceneChk.checked = !!prefs.physicsScene;
  const row = (label, ...ctl) => h("div", { class: "dlg-row" }, h("label", {}, label), h("div", { class: "ctl" }, ...ctl));
  const meshRow = row("Mesh files", meshSel);
  const info = h("div", { class: "rbx-info" });
  const note = h("div", { class: "rbx-units" }, "Writes metres, kilograms and seconds, Z up (metersPerUnit = 1). Revolute limits: radians in URDF, degrees in USD. The robot is exported at joint values 0; the current pose goes into README.txt for Isaac Lab.");

  const readOpts = () => {
    const n = (inp, d) => { const v = parseFloat(inp.i.value); return Number.isFinite(v) && v >= 0 ? v : d; };
    return {
      name: safeName(nameInp.value || doc.name || "robot", "robot"),
      formats: FORMATS[fmtSel.value], meshFormat: meshSel.value, quality: qualSel.value, collision: collSel.value,
      fixedBase: baseSel.value === "auto" ? null : baseSel.value === "fixed",
      angularStiffness: n(kA, DEFAULTS.angularStiffness), angularDamping: n(dA, DEFAULTS.angularDamping),
      linearStiffness: n(kL, DEFAULTS.linearStiffness), linearDamping: n(dL, DEFAULTS.linearDamping),
      physicsScene: sceneChk.checked,
    };
  };
  const refresh = () => {
    meshRow.classList.toggle("hidden", fmtSel.value === "usd");
    let m;
    try { m = describeRobot(ctx.getDoc(), ctx.getState(), readOpts()); } catch (e) { info.textContent = `Cannot read the assembly: ${e.message || e}`; return; }
    const moving = m.joints.filter((j) => j.type !== "fixed");
    info.innerHTML = "";
    info.append(
      h("div", {}, h("b", {}, `${m.links.length} link${m.links.length === 1 ? "" : "s"}`), `, ${m.joints.length} joint${m.joints.length === 1 ? "" : "s"} (${moving.length} movable), ${m.fixedBase ? "fixed" : "floating"} base`),
      m.joints.length ? h("div", { class: "rbx-joints" }, m.joints.map((j) => h("div", {}, h("code", {}, j.name), ` ${j.type}  ${j.parent} → ${j.child}`))) : null,
      ...m.warnings.map((w) => h("div", { class: "rbx-warn" }, w)),
    );
  };
  for (const el of [fmtSel, baseSel]) el.addEventListener("change", refresh);

  const close = () => { if (!current) return; current.el.remove(); current = null; };
  const btnExport = h("button", { class: "btn primary" }, "Export");
  btnExport.addEventListener("click", async () => {
    const o = readOpts();
    savePrefs({ format: fmtSel.value, meshFormat: o.meshFormat, quality: o.quality, collision: o.collision, base: baseSel.value,
      angularStiffness: o.angularStiffness, angularDamping: o.angularDamping, linearStiffness: o.linearStiffness, linearDamping: o.linearDamping,
      physicsScene: o.physicsScene, lastName: o.name, docName: doc.name });
    btnExport.disabled = true; btnExport.textContent = "Exporting…";
    try {
      await new Promise((r) => setTimeout(r, 30)); // let the button repaint before meshing
      const r = await runExport(ctx, o);
      log("file", { action: "export robot", formats: o.formats.join("+"), links: r.links.length, joints: r.joints.length });
      if (r.path) { toast(`Exported robot "${r.name}" (${r.summary})`); close(); }
    } catch (e) {
      console.error(e);
      toast(`Robot export failed: ${e.message || e}`);
    } finally { if (current) { btnExport.disabled = false; btnExport.textContent = "Export"; } }
  });

  const body = h("div", { class: "dlg-body" },
    row("Robot name", h("div", { class: "num" }, nameInp)),
    row("Format", fmtSel), meshRow, row("Mesh quality", qualSel), row("Collision", collSel), row("Base", baseSel),
    h("div", { class: "rbx-sec" }, "Joint drives (USD)"),
    row("Revolute k", kA.el), row("Revolute d", dA.el), row("Slider k", kL.el), row("Slider d", dL.el),
    h("label", { class: "rbx-check" }, sceneChk, "Add a PhysicsScene (gravity −Z, 9.81 m/s²)"),
    h("div", { class: "rbx-sec" }, "Robot"), info, note);
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic rbx-ic", html: ROBOT_ICON }), h("span", {}, "Export Robot"),
    h("i", { class: "x", html: CLOSE_ICON, onclick: close, title: "Close" }));
  const foot = h("div", { class: "dlg-foot" }, h("div", { class: "sp" }), btnExport, h("button", { class: "btn", onclick: close }, "Cancel"));
  const el = h("div", { class: "panel rbx-dlg" }, head, body, foot);
  (ctx.host || document.body).append(el);
  current = { el, close };
  refresh();
  log("command started", { name: "robot export" });
  return current;
}

/**
 * window.__robot debug hook for scripted checks:
 *   __robot.build(opts)  -> { summary, warnings, links, joints, files: [{path, bytes}], pkg }   (no saving)
 *   __robot.export(opts) -> same plus `path` (opens the folder picker on desktop, downloads a .zip in the browser)
 *   __robot.open()       -> opens the dialog
 */
export function installRobotDebugHook(ctx) {
  if (typeof window === "undefined") return;
  window.__robot = {
    build: (opts = {}) => runExport(ctx, optionsFrom(ctx, opts), { save: false }),
    export: (opts = {}) => runExport(ctx, optionsFrom(ctx, opts), { save: true }),
    open: () => openRobotExport(ctx),
    describe: (opts = {}) => describeRobot(ctx.getDoc(), ctx.getState(), optionsFrom(ctx, opts)),
  };
}
