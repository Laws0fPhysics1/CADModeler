// CFD STUDY dialog: pick bodies + flow settings, then Solve (runs CFD Sim's solver
// headless inside the app; results show in the viewport via cfdresults.js), or
// export the case folder / open it in the separate CFD Sim window.
// Case format: docs/cfd-exchange.md. Pure case building lives in cfdlink.js.
import "./cfdstudy.css";
import * as platform from "./platform.js";
import * as L from "./cfdlink.js";

const POLL_MS = 3000;
// In-app solves write fewer frames than CFD Sim's presets (60-200): each frame costs the solver
// ~1-2 s of output work, and a short timeline is plenty for the viewport player.
const IN_APP_FRAMES = 30;
let current = null; // the open study (one at a time)

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
const fmtSig = (v, d = 3) => (v == null || !isFinite(v) ? "–" : String(+(+v).toPrecision(d)));
const fmtRe = (v) => (!isFinite(v) ? "–" : v >= 1e4 ? v.toExponential(2).replace("e+", " × 10^") : String(Math.round(v)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isDesktop = () => { try { return !!platform.isDesktop; } catch { return false; } };

/**
 * Open the CFD study dialog.
 * @param {object} ctx
 * @param {string} ctx.designName
 * @param {() => {id:string,name:string,shape:any,visible:boolean}[]} ctx.getBodies
 * @param {(bodies:any[]) => Blob|Uint8Array} ctx.exportSTL
 * @param {(bodyId:string) => ({materialId?:string,color?:string}|null)} [ctx.getAppearance]
 * @param {(id:string) => ({id,name,physical}|null)} [ctx.getMaterial]
 * @param {(bodyShape:any) => {volume:number}} [ctx.bodyInfo]   optional: adds volume / mass per body
 * @param {(msg:string) => void} ctx.toast
 * @param {(type:string, data:object) => void} [ctx.logEvent]
 * @param {HTMLElement} ctx.host       element the dialog is positioned in (the workspace)
 * @param {string} [ctx.appVersion]
 * @param {(study:{casePath:string, folderName:string, settings:object, bodies:string[]}) => void} [ctx.onSolve]  called once an in-app solve has started
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function openCfdStudy(ctx) {
  if (current) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
  const toast = ctx.toast || (() => {});
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const visible = (ctx.getBodies() || []).filter((b) => b.visible !== false);

  const st = {
    selected: new Set(visible.map((b) => b.id)),
    direction: "+X", speed: 20, fluid: "Air (20°C)", nu: 1.5e-5, rho: 1.204,
    ground: false, gap: 0, moving: true, quality: "standard", duration: 3, launchAfter: false,
    stl: null, stlKey: "", info: null, areas: {}, casePath: null, busy: false, timer: null,
  };

  // ---------------- controls
  const row = (label, ctl, cls) => h("div", { class: "dlg-row" + (cls ? " " + cls : "") }, h("label", {}, label), h("div", { class: "ctl" }, ctl));
  const num = (value, unit, on) => {
    const inp = h("input", { value: String(value), spellcheck: "false" });
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (isFinite(v)) on(v); });
    return { box: h("div", { class: "num" }, inp, h("em", {}, unit)), inp };
  };
  const select = (opts, value, on) => {
    const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value; s.addEventListener("change", () => on(s.value));
    return s;
  };
  const check = (label, value, on) => {
    const c = h("input", { type: "checkbox" }); c.checked = value;
    c.addEventListener("change", () => on(c.checked));
    return { el: h("label", { class: "cfd-check" }, c, h("span", {}, label)), c };
  };

  const bodyList = h("div", { class: "cfd-bodies" });
  if (!visible.length) bodyList.append(h("div", { class: "cfd-muted" }, "No visible bodies"));
  for (const b of visible) {
    const ap = safe(() => ctx.getAppearance && ctx.getAppearance(b.id));
    const mat = ap && ap.materialId ? safe(() => ctx.getMaterial && ctx.getMaterial(ap.materialId)) : null;
    const sw = h("i", { class: "cfd-swatch" });
    const col = L.normColor(ap && ap.color) || (mat && mat.render && L.normColor(mat.render.color));
    if (col) sw.style.background = col;
    const c = check("", true, (on) => { on ? st.selected.add(b.id) : st.selected.delete(b.id); refreshGeometry(); });
    c.el.append(sw, h("span", { class: "cfd-bname" }, b.name || b.id), mat ? h("em", {}, mat.name) : null);
    bodyList.append(c.el);
  }

  const dirSel = select(L.FLOW_DIRECTIONS.map((d) => [d, `${d}  (air moves toward ${d})`]), st.direction, (v) => { st.direction = v; refreshInfo(); });
  const speed = num(st.speed, "m/s", (v) => { st.speed = v; refreshInfo(); });
  const nuIn = num(st.nu, "m²/s", (v) => { st.nu = v; refreshInfo(); });
  const rhoIn = num(st.rho, "kg/m³", (v) => { st.rho = v; });
  const fluidSel = select(Object.keys(L.FLUIDS).map((k) => [k, k]), st.fluid, (v) => {
    st.fluid = v;
    const f = L.FLUIDS[v];
    if (f) { st.nu = f.nu; st.rho = f.rho; nuIn.inp.value = String(f.nu); rhoIn.inp.value = String(f.rho); }
    refreshRows(); refreshInfo();
  });
  const groundCk = check("Ground plane under the model", st.ground, (v) => { st.ground = v; refreshRows(); });
  const gap = num(st.gap, "mm", (v) => { st.gap = Math.max(0, v); });
  const movingCk = check("Moving ground (vehicle belt)", st.moving, (v) => { st.moving = v; });
  const qualSel = select(L.QUALITY_PRESETS.map((q) => [q.id, q.label]), st.quality, (v) => { st.quality = v; });
  const durSel = select(L.DURATIONS.map((d) => [String(d.value), d.label]), String(st.duration), (v) => { st.duration = +v; });
  const launchCk = check("Launch CFD Sim after export", st.launchAfter, (v) => { st.launchAfter = v; });

  const nuRow = row("Viscosity ν", nuIn.box), rhoRow = row("Density ρ", rhoIn.box);
  const gapRow = row("Clearance", gap.box), movingRow = h("div", { class: "dlg-row cfd-indent" }, movingCk.el);
  const groundRow = h("div", { class: "dlg-row" }, groundCk.el);
  const info = h("div", { class: "dlg-info cfd-info" }, "Computing…");
  const note = isDesktop() ? null : h("div", { class: "cfd-note" }, "Browser mode: the case files download instead. Launching CFD Sim and reading results back needs the desktop app.");
  const status = h("div", { class: "cfd-status hidden" });
  const err = h("div", { class: "dlg-err" });

  const body = h("div", { class: "dlg-body" },
    h("div", { class: "cfd-sec" }, "Geometry"), bodyList,
    h("div", { class: "cfd-sec" }, "Flow"),
    row("Direction", dirSel), row("Speed", speed.box), row("Fluid", fluidSel), nuRow, rhoRow,
    groundRow, gapRow, movingRow,
    h("div", { class: "cfd-sec" }, "Solver"),
    row("Quality", qualSel), row("Duration", durSel),
    info, note, err, status);

  const btnSolve = h("button", { class: "btn primary", onclick: () => doExport("solve"), title: "Run the CFD solver inside CAD Modeler and show the flow in the viewport" }, "Solve");
  const btnExport = h("button", { class: "btn", onclick: () => doExport(st.launchAfter), title: "Write the case folder only" }, "Export Case");
  const btnOpen = h("button", { class: "btn", onclick: () => doExport(true), title: isDesktop() ? "Open the case in the separate CFD Sim window (advanced viewer)" : "Needs the desktop app" }, "Open in CFD Sim");
  if (!isDesktop()) btnOpen.disabled = true;
  btnSolve.disabled = true;
  platform.cfd.canRun().then((ok) => { st.canRun = ok; btnSolve.disabled = !ok || st.busy; if (!ok) btnSolve.title = "Needs the desktop app"; }).catch(() => {});
  const close = () => {
    clearInterval(st.timer);
    el.remove(); current = null;
  };
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic cfd-ic", html: WIND_ICON }), h("span", {}, "CFD Study"),
    h("button", { class: "x", title: "Close", html: CLOSE_ICON, onclick: close }));
  const foot = h("div", { class: "dlg-foot cfd-foot" }, btnSolve, btnExport, btnOpen, h("div", { class: "sp" }), h("button", { class: "btn", onclick: close }, "Cancel"));
  const el = h("div", { class: "panel cfd-dlg" }, head, body, foot);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  (ctx.host || document.body).append(el);
  makeDraggable(el, head);

  current = { el, close };
  refreshRows();
  refreshGeometry();
  log("cfd.study.open", { bodies: visible.length });
  return current;

  // ---------------- behaviour
  function selectedBodies() { return visible.filter((b) => st.selected.has(b.id)); }

  function refreshRows() {
    const custom = st.fluid === "Custom";
    nuRow.classList.toggle("hidden", !custom); rhoRow.classList.toggle("hidden", !custom);
    const vertical = st.direction[1] === "Z";
    groundRow.classList.toggle("hidden", vertical);
    gapRow.classList.toggle("hidden", !st.ground || vertical); movingRow.classList.toggle("hidden", !st.ground || vertical);
  }

  // Re-export the STL only when the body selection changes; areas are cached per direction.
  async function refreshGeometry() {
    const bodies = selectedBodies();
    const key = bodies.map((b) => b.id).join("|");
    if (key === st.stlKey) return refreshInfo();
    st.stlKey = key; st.stl = null; st.info = null; st.areas = {};
    if (!bodies.length) { info.innerHTML = "Select at least one body."; return; }
    info.textContent = "Meshing…";
    try {
      await new Promise((r) => setTimeout(r, 0));
      const bytes = await L.toBytes(ctx.exportSTL(bodies));
      if (key !== st.stlKey) return;
      st.stl = bytes; st.info = L.stlInfo(bytes);
      refreshInfo();
    } catch (e) {
      if (key === st.stlKey) info.textContent = "Could not mesh the selection: " + (e.message || e);
    }
  }

  function refreshInfo() {
    refreshRows();
    if (!st.stl) return;
    if (st.areas[st.direction] == null) st.areas[st.direction] = L.frontalAreaMm2(st.stl, st.direction);
    const s = L.flowSummary({ bbox: st.info, direction: st.direction, speed: st.speed, nu: st.nu, frontalMm2: st.areas[st.direction] });
    const ext = [0, 1, 2].map((k) => st.info.max[k] - st.info.min[k]);
    info.innerHTML =
      `<b>Model length</b> ${fmtSig(s.lengthM, 4)} m <span class="cfd-muted">(${ext.map((v) => fmtSig(v, 4)).join(" × ")} mm)</span><br>` +
      `<b>Frontal area</b> ≈ ${fmtSig(s.frontalM2 * 1e4, 3)} cm² <span class="cfd-muted">(${fmtSig(s.frontalM2, 3)} m²)</span><br>` +
      `<b>Reynolds</b> ${fmtRe(s.reynolds)} <span class="cfd-muted">(U·L/ν)</span><br>` +
      `<span class="cfd-muted">${st.info.triangles.toLocaleString()} triangles</span>`;
  }

  function showErr(msg) { err.textContent = msg; err.classList.toggle("show", !!msg); }

  async function doExport(launch) {
    if (st.busy) return;
    showErr("");
    const bodies = selectedBodies();
    if (!bodies.length) return showErr("Select at least one body.");
    if (!(st.speed > 0)) return showErr("Speed must be greater than zero.");
    if (st.fluid === "Custom" && !(st.nu > 0 && st.rho > 0)) return showErr("Custom fluid needs ν and ρ greater than zero.");
    const solve = launch === "solve";
    st.busy = true; btnExport.disabled = btnOpen.disabled = btnSolve.disabled = true;
    try {
      if (!st.stl) await refreshGeometry();
      if (!st.stl) throw new Error("Could not mesh the selected bodies");
      const appearances = {}, materials = {};
      for (const b of bodies) {
        const ap = safe(() => ctx.getAppearance && ctx.getAppearance(b.id));
        if (ap) appearances[b.id] = ap;
        if (ap && ap.materialId && !(ap.materialId in materials)) materials[ap.materialId] = safe(() => ctx.getMaterial && ctx.getMaterial(ap.materialId));
      }
      const caseBodies = bodies.map((b) => {
        const out = { id: b.id, name: b.name };
        const v = ctx.bodyInfo ? safe(() => ctx.bodyInfo(b.shape)) : null;
        if (v && isFinite(v.volume)) out.volume_mm3 = v.volume;
        return out;
      });
      const { folderName, files } = await L.buildCase({
        designName: ctx.designName, bodies: caseBodies, stlBytes: st.stl, appearances, materials,
        options: {
          direction: st.direction, speed: st.speed, fluid: st.fluid, nu: st.nu, rho: st.rho,
          ground: { enabled: st.ground, gap_mm: st.gap, moving: st.moving },
          solver: { quality: st.quality, flowThroughs: st.duration, frames: solve ? IN_APP_FRAMES : null }, appVersion: ctx.appVersion, launch: launch === true,
        },
      });
      const path = await platform.cfd.writeCase(folderName, files);
      log("cfd.case.export", { folderName, bodies: bodies.length, direction: st.direction, speed: st.speed, fluid: st.fluid, desktop: !!path });
      if (!path) {
        setStatus(`<div>Case files downloaded as <b>${esc(folderName)}_*</b>. Put them in one folder named <code>${esc(folderName)}</code> (without the prefix) and run <code>python main.py --case &lt;folder&gt;</code> in CFD Sim.</div>`);
        toast("CFD case downloaded");
        return;
      }
      st.casePath = path;
      if (solve) {
        const r = await platform.cfd.run(path);
        log("cfd.case.solve", { ok: !!(r && r.ok), error: r && r.error });
        if (!r || !r.ok) { showErr("Could not start the solver: " + ((r && r.error) || "unknown error")); return; }
        ctx.onSolve && ctx.onSolve({ casePath: path, folderName, settings: { direction: st.direction, speed: st.speed, fluid: st.fluid, quality: st.quality, duration: st.duration, ground: st.ground }, bodies: bodies.map((b) => b.name || b.id) });
        close();
        return;
      }
      setStatus(caseLine() + `<div class="cfd-live">Case written. ${launch ? "Starting CFD Sim…" : "Waiting for CFD Sim."}</div>`);
      toast(`CFD case written: ${folderName}`);
      if (launch) {
        const r = await platform.cfd.launch(path);
        log("cfd.case.launch", { ok: !!(r && r.ok), error: r && r.error });
        if (!r || !r.ok) showErr("Could not start CFD Sim: " + ((r && r.error) || "unknown error") + ". Check the CFD Sim folder and Python command in the desktop settings.");
        else setLive("CFD Sim is opening with this case. Press Run simulation there; progress shows up here.");
      }
      startPolling();
    } catch (e) {
      showErr(e.message || String(e));
      log("cfd.case.error", { message: String(e.message || e) });
    } finally {
      st.busy = false; btnExport.disabled = false; btnOpen.disabled = !isDesktop(); btnSolve.disabled = !st.canRun;
    }
  }

  function caseLine() {
    return `<div class="cfd-path"><span title="${esc(st.casePath)}">${esc(st.casePath)}</span><a href="#" data-act="reveal">Reveal</a></div>`;
  }
  function setStatus(html) {
    status.innerHTML = html; status.classList.remove("hidden");
    const a = status.querySelector('[data-act="reveal"]');
    if (a) a.addEventListener("click", (e) => { e.preventDefault(); safeAsync(() => platform.cfd.revealCase(st.casePath)); });
  }
  function setLive(html) {
    let live = status.querySelector(".cfd-live");
    if (!live) { live = h("div", { class: "cfd-live" }); status.append(live); }
    live.innerHTML = html;
  }

  function startPolling() {
    clearInterval(st.timer);
    if (!isDesktop() || !st.casePath) return;
    const tick = async () => {
      if (!current || !st.casePath) return;
      let r = null;
      try { r = await platform.cfd.readResults(st.casePath); } catch { return; }
      const { progress, results } = L.normalizeReadback(r);
      if (results) { setLive(resultsHtml(results)); if (results.status !== "running") clearInterval(st.timer); return; }
      if (progress) setLive(progressHtml(progress));
    };
    st.timer = setInterval(tick, POLL_MS);
    tick();
  }
}

function progressHtml(p) {
  const pct = Math.round(100 * (p.fraction != null ? p.fraction : p.total ? p.step / p.total : 0));
  const label = { ready: "CFD Sim has the case loaded", starting: "Starting run…", running: "Running", completed: "Finished", stopped: "Stopped", failed: "Failed", diverged: "Diverged" }[p.status] || p.status;
  let s = `<div class="cfd-prog-head"><b>${esc(label)}</b>${p.status === "running" ? `<span>${pct}%</span>` : ""}</div>`;
  if (p.status === "running" || p.status === "starting") s += `<div class="cfd-bar"><i style="width:${pct}%"></i></div>`;
  if (p.Cd != null) s += `<div class="cfd-muted">Cd ${fmtSig(p.Cd)} · Cl ${fmtSig(p.Cl)} · ${p.MLUPS ? Math.round(p.MLUPS) + " MLUPS" : ""}${p.step ? ` · step ${p.step.toLocaleString()} / ${(p.total || 0).toLocaleString()}` : ""}</div>`;
  if (p.error) s += `<div class="cfd-bad">${esc(String(p.error).split("\n").filter(Boolean).slice(-1)[0] || "")}</div>`;
  return s;
}

function resultsHtml(r) {
  if (r.status === "failed") return `<div class="cfd-prog-head"><b class="cfd-bad">Run failed</b></div><div class="cfd-muted">${esc(String(r.error || "").split("\n").filter(Boolean).slice(-1)[0] || "See the CFD Sim log.")}</div>`;
  const f = r.forces_N || {};
  return `<div class="cfd-prog-head"><b class="${r.status === "completed" ? "cfd-ok" : "cfd-bad"}">${r.status === "completed" ? "Results" : esc(r.status)}</b>` +
    `<span class="cfd-muted">${r.averaging ? "mean of last 20 %" : ""}</span></div>` +
    `<table class="cfd-res"><tr><td>Cd</td><td>${fmtSig(r.Cd)}</td><td>Drag</td><td>${fmtSig(f.drag)} N</td></tr>` +
    `<tr><td>Cl</td><td>${fmtSig(r.Cl)}</td><td>Lift</td><td>${fmtSig(f.lift)} N</td></tr>` +
    `<tr><td>Cs</td><td>${fmtSig(r.Cs)}</td><td>Side</td><td>${fmtSig(f.side)} N</td></tr></table>` +
    `<div class="cfd-muted">A<sub>ref</sub> ${fmtSig(r.referenceArea_m2)} m² · L ${fmtSig(r.referenceLength_m)} m · Re ${fmtRe(r.reynolds)}` +
    `${r.timings && r.timings.wall_s ? ` · ${Math.round(r.timings.wall_s)} s` : ""}</div>`;
}

function safe(fn) { try { return fn(); } catch { return null; } }
function safeAsync(fn) { try { const p = fn(); if (p && p.catch) p.catch(() => {}); } catch {} }

function makeDraggable(panel, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect(), host = panel.parentElement.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const mv = (ev) => { panel.style.left = `${ev.clientX - host.left - ox}px`; panel.style.top = `${ev.clientY - host.top - oy}px`; panel.style.right = "auto"; };
    const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  });
}

const WIND_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 7h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M2 10.5h13a2.5 2.5 0 1 1-2.5 2.5"/><path d="M2 14h6"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

/** Close the open CFD Study dialog (main.js leaveDoc). */
export function closeCfdStudy() { if (current) current.close(); }
