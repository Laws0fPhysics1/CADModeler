// In-app static stress results. FEA Sim runs headless (platform.fea.run) and this module
// shows the study in the viewport while it runs and after: progress / Stop, then the
// deformed shape (Adjusted / Actual / Undeformed scale, optional animation) coloured by
// safety factor, von Mises stress or displacement, the undeformed shape as a wireframe
// ghost, min / max probes, and a colour legend in the same style as the CFD legends.
//
// Data: <case>/viz/manifest.json + binaries written by FEA Sim (fea/run.py write_viz),
// already in CAD millimetres and CAD axes (the body's modelled coordinates).
// Layouts: docs/fea-exchange.md.
import * as THREE from "three";
import "./cfdstudy.css";
import "./cfdresults.css";
import "./fea.css";
import * as platform from "./platform.js";
import * as L from "./fealink.js";

const POLL_MS = 1500;
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
const fmtSig = (v, d = 3) => (v == null || !isFinite(v) ? "–" : String(+(+v).toPrecision(d)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtTime = (s) => (!isFinite(s) ? "" : s < 90 ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const lastLine = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(-1)[0] || "";
const firstLine = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean)[0] || "";

// ---------------------------------------------------------------- colour maps (sRGB 0..1)
const STOPS = {
  // Fusion-style rainbow: blue (low) -> cyan -> green -> yellow -> red (high)
  rainbow: [[0, [0.05, 0.19, 0.85]], [0.25, [0.0, 0.72, 0.95]], [0.5, [0.15, 0.85, 0.25]], [0.75, [1.0, 0.85, 0.05]], [1, [0.9, 0.08, 0.05]]],
  // safety factor: red below 1, then orange / yellow / green / blue for large margins
  fos: [[0, [0.85, 0.05, 0.05]], [0.1249, [0.95, 0.15, 0.05]], [0.125, [1.0, 0.55, 0.0]], [0.25, [1.0, 0.85, 0.05]], [0.45, [0.3, 0.85, 0.2]], [0.7, [0.0, 0.7, 0.85]], [1, [0.08, 0.25, 0.85]]],
};
function cmap(name, t, out = [0, 0, 0]) {
  const s = STOPS[name];
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 1;
  while (i < s.length - 1 && t > s[i][0]) i++;
  const [t0, c0] = s[i - 1], [t1, c1] = s[i];
  const f = (t - t0) / (t1 - t0 || 1);
  for (let k = 0; k < 3; k++) out[k] = c0[k] + (c1[k] - c0[k]) * f;
  return out;
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function cssGradient(name) {
  const c = [0, 0, 0], stops = [];
  for (let i = 0; i <= 40; i++) { cmap(name, i / 40, c); stops.push(`rgb(${c.map((v) => Math.round(v * 255)).join(",")}) ${(i * 2.5).toFixed(1)}%`); }
  return `linear-gradient(to top, ${stops.join(",")})`;
}

const RESULT_TYPES = [
  ["safety", "Safety Factor"],
  ["vonMises", "Stress (von Mises)"],
  ["displacement", "Displacement"],
  ["p1", "1st Principal Stress"],
  ["p3", "3rd Principal Stress"],
];
const FOS_MAX = 8; // legend range 0..8 (values above are the same blue)

/**
 * @param {object} ctx
 * @param {import("./viewport.js").Viewport} ctx.vp
 * @param {HTMLElement} ctx.host
 * @param {(msg:string)=>void} ctx.toast
 * @param {(type:string,data:object)=>void} [ctx.logEvent]
 * @param {(id:string, patch:object)=>void} [ctx.onStudyUpdate]
 * @param {(visible:boolean)=>void} [ctx.setModelVisible]
 * @param {(study:object)=>Promise<boolean>} [ctx.rerun]
 * @param {(study:object)=>void} [ctx.edit]                  reopen the study dialog with these settings
 * @param {(bodyId:string)=>number[]|null} [ctx.bodyMatrix]  assembly placement of the analysed body (16 numbers)
 * @param {({bounds})=>void} [ctx.onLoaded]               after the results load: the solved mesh's box (modelled mm)
 * @param {object} study  { id, name, casePath, design, bodyId }
 */
export function openFeaResults(ctx, study) {
  if (current) {
    if (current.study.id === study.id) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
    current.close();
  }
  const vp = ctx.vp;
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const st = {
    manifest: null, progress: null, results: null, proc: null, closed: false, finalSeen: false, pollTimer: null,
    data: null, loadingKey: null, fitted: false, anim: false, raf: 0, t0: 0,
    show: { field: "safety", scaleMode: "adjusted", adj: 1, ghost: true, probes: true, model: false },
  };

  // ---- three.js objects
  const root = new THREE.Group(); root.name = "fea-results";
  const m = ctx.bodyMatrix && study.bodyId ? ctx.bodyMatrix(study.bodyId) : null;
  if (m && m.length === 16) { root.matrixAutoUpdate = false; root.matrix.fromArray(Array.from(m)); root.matrixWorldNeedsUpdate = true; }
  vp.groups.results.add(root);
  const surfMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const ghostMat = new THREE.LineBasicMaterial({ color: 0x8a9099, transparent: true, opacity: 0.55, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1d21, transparent: true, opacity: 0.35 });
  const objs = { mesh: null, ghost: null, edges: null, probes: null };

  // ---- DOM
  const statusEl = h("div", { class: "cfr-status" });
  const resEl = h("div", { class: "cfr-res" });
  const warnEl = h("div", { class: "fea-warn hidden" });
  const row = (label, ctl) => h("div", { class: "dlg-row" }, h("label", {}, label), h("div", { class: "ctl" }, ctl));
  const sel = (opts, value, on) => {
    const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value; s.addEventListener("change", () => on(s.value)); return s;
  };
  const check = (label, key, on) => {
    const c = h("input", { type: "checkbox" }); c.checked = st.show[key];
    c.addEventListener("change", () => { st.show[key] = c.checked; log("fea.results.display", { [key]: c.checked }); on ? on() : applyDisplay(); });
    return { el: h("label", { class: "cfd-check" }, c, h("span", {}, label)), c };
  };
  const fieldSel = sel(RESULT_TYPES, st.show.field, (v) => { st.show.field = v; log("fea.results.field", { field: v }); recolor(); applyDisplay(); });
  const scaleSel = sel([["adjusted", "Adjusted"], ["actual", "Actual (1:1)"], ["none", "Undeformed"]], st.show.scaleMode, (v) => { st.show.scaleMode = v; deform(); applyDisplay(); });
  const adj = h("input", { type: "range", min: "-1", max: "1", step: "0.01", value: "0", title: "Exaggeration" });
  adj.addEventListener("input", () => { st.show.adj = Math.pow(10, +adj.value); deform(); applyDisplay(); });
  const scaleTxt = h("span", { class: "fea-scale" }, "");
  const ckAnim = check("Animate", "anim", () => { st.anim = st.show.anim; animate(); });
  const ckGhost = check("Show undeformed (wireframe)", "ghost");
  const ckProbes = check("Min / max markers", "probes");
  const ckModel = check("Show CAD model", "model");
  const btnStop = h("button", { class: "btn", onclick: stop }, "Stop");
  const btnRerun = h("button", { class: "btn", onclick: rerun, title: "Run this case again" }, "Re-run");
  const btnEdit = h("button", { class: "btn", onclick: () => ctx.edit && ctx.edit(study), title: "Change the loads / constraints and solve again" }, "Edit Study");
  const btnReveal = h("button", { class: "btn", onclick: () => platform.fea.revealCase(study.casePath), title: study.casePath }, "Folder");
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic fea-ic", html: STRESS_ICON }), h("span", { class: "cfr-title" }, `Static Stress · ${study.name || study.design || "Study"}`),
    h("button", { class: "x", title: "Close results", html: CLOSE_ICON, onclick: () => close() }));
  const displayEls = [h("div", { class: "cfd-sec" }, "Display"), row("Result", fieldSel), row("Deformation", scaleSel),
    h("div", { class: "dlg-row fea-adjrow" }, h("label", {}, ""), h("div", { class: "ctl fea-adj" }, adj, scaleTxt)),
    ckAnim.el, ckGhost.el, ckProbes.el, ckModel.el];
  const display = h("div", { class: "fea-display hidden" }, displayEls);
  const body = h("div", { class: "dlg-body" }, statusEl, resEl, warnEl, display);
  const foot = h("div", { class: "dlg-foot cfd-foot" }, btnStop, btnRerun, ctx.edit ? btnEdit : null, h("div", { class: "sp" }), btnReveal);
  const el = h("div", { class: "panel cfd-dlg cfr-panel fea-res-panel" }, head, body, foot);
  el.addEventListener("keydown", (e) => e.stopPropagation());
  ctx.host.append(el);
  makeDraggable(el, head);
  const legends = h("div", { class: "cfr-legends" });
  const labels = h("div", { class: "fea-probes" });
  ctx.host.append(legends, labels);

  current = { el, study, close, refresh: () => poll(), state: st, objs };
  log("fea.results.open", { id: study.id });
  renderStatus();
  poll();
  st.pollTimer = setInterval(poll, POLL_MS);
  return current;

  // ================================================================ polling
  async function poll() {
    if (st.closed) return;
    let rb = null, man = null, proc = null;
    try {
      [rb, man, proc] = await Promise.all([
        platform.fea.readResults(study.casePath).catch(() => null),
        readText("viz/manifest.json").then((t) => (t ? JSON.parse(t) : null)).catch(() => null),
        platform.fea.status(study.casePath).catch(() => null),
      ]);
    } catch { return; }
    if (st.closed) return;
    const { progress, results } = L.normalizeReadback(rb);
    st.progress = progress; st.results = results; st.proc = proc;
    const finished = results && results.status && results.status !== "running";
    if (man && finished && results.status === "completed") {
      const key = `${man.surface && man.surface.vertices}|${results.timings && results.timings.finishedAt}`;
      st.manifest = man;
      if (st.loadingKey !== key) { st.loadingKey = key; loadViz(man).catch((e) => { console.warn("fea results:", e); }); }
    }
    renderStatus();
    const dead = proc && proc.known && !proc.running;
    if ((finished || (dead && !results)) && !st.finalSeen) {
      st.finalSeen = true;
      ctx.onStudyUpdate && ctx.onStudyUpdate(study.id, summary());
      if (finished && results.status === "completed") ctx.toast(`Static stress solved: ${L.resultSummary(results)}`);
    }
    if (finished && st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = setInterval(poll, POLL_MS * 4); }
  }
  function summary() {
    const r = st.results || {};
    return { status: r.status || (st.proc && st.proc.exitCode ? "failed" : "unknown"),
      maxVonMises_MPa: r.maxVonMises_MPa ?? null, maxDisplacement_mm: r.maxDisplacement_mm ?? null, minSafetyFactor: r.minSafetyFactor ?? null,
      finishedAt: (r.timings && r.timings.finishedAt) || new Date().toISOString() };
  }
  async function readBytes(rel) {
    const b = await platform.fea.readFile(study.casePath, rel);
    return b == null ? null : b instanceof Uint8Array ? b : new Uint8Array(b);
  }
  async function readText(rel) { const b = await readBytes(rel); return b == null ? null : new TextDecoder().decode(b); }

  // ================================================================ status
  function renderStatus() {
    const p = st.progress, r = st.results, proc = st.proc;
    const running = proc && proc.known ? proc.running : p && (p.status === "running" || p.status === "starting");
    btnStop.classList.toggle("hidden", !running);
    btnRerun.classList.toggle("hidden", !!running || !ctx.rerun);
    btnEdit.classList.toggle("hidden", !!running);
    let s = "";
    if (r && r.status && r.status !== "running") {
      const label = { completed: "Completed", stopped: "Stopped", failed: "Failed" }[r.status] || r.status;
      s += `<div class="cfd-prog-head"><b class="${r.status === "completed" ? "cfd-ok" : r.status === "stopped" ? "" : "cfd-bad"}">${esc(label)}</b>` +
        `<span class="cfd-muted">${r.timings && r.timings.wall_s ? fmtTime(r.timings.wall_s) : ""}${r.solver && r.solver.backend ? ` · ${esc(r.solver.backend.toUpperCase())}` : ""}</span></div>`;
      if (r.status === "failed") s += `<div class="cfd-bad cfr-err">${esc(firstLine(r.error) || "See fea-run.log in the case folder.")}</div>`;
    } else if (p && (p.status === "running" || p.status === "starting")) {
      const frac = p.fraction || 0;
      const phase = { starting: "Starting…", meshing: "Meshing", assembling: "Assembling", solving: "Solving", post: "Computing stresses", writing: "Writing results" }[p.phase] || "Running";
      s += `<div class="cfd-prog-head"><b>${phase}</b><span>${Math.round(100 * frac)}%</span></div>` +
        `<div class="cfd-bar"><i style="width:${(100 * frac).toFixed(1)}%"></i></div>` +
        `<div class="cfd-muted">${esc(p.message || "")}${p.elapsed_s ? ` · ${fmtTime(p.elapsed_s)} elapsed` : ""}</div>`;
    } else if (proc && proc.known && !proc.running && proc.exitCode) {
      s += `<div class="cfd-prog-head"><b class="cfd-bad">Solver stopped (exit code ${proc.exitCode})</b></div>${proc.hint ? `<div class="cfd-bad cfr-err">${esc(proc.hint)}</div>` : ""}<pre class="cfr-log">${esc(proc.logTail || "")}</pre>`;
    } else if (proc && proc.running) {
      s += `<div class="cfd-prog-head"><b>Starting solver…</b></div><div class="cfd-bar cfd-bar-indet"><i></i></div>`;
    } else s += `<div class="cfd-muted">No results in this case folder yet.</div>`;
    statusEl.innerHTML = s;
    if (r && r.status === "completed") {
      const rt = r.reactionTotal_N || [0, 0, 0], ap = r.appliedTotal_N || [0, 0, 0];
      const mag = (v) => Math.hypot(v[0], v[1], v[2]);
      const yieldTxt = (r.materials || []).map((x) => x.yield_MPa ? `${fmtSig(x.yield_MPa)} MPa${x.yieldFrom === "ultimate" ? " (ultimate)" : ""}` : "n/a").join(", ");
      resEl.innerHTML = `<table class="cfd-res fea-res">` +
        `<tr><td>Safety factor (min)</td><td class="${r.minSafetyFactor != null && r.minSafetyFactor < 1 ? "cfd-bad" : ""}">${r.minSafetyFactor == null ? "–" : r.minSafetyFactor >= 1000 ? "> 1000" : fmtSig(r.minSafetyFactor)}</td></tr>` +
        `<tr><td>Stress, von Mises (max)</td><td>${fmtSig(r.maxVonMises_MPa)} MPa</td></tr>` +
        `<tr><td>Displacement (max)</td><td>${fmtSig(r.maxDisplacement_mm)} mm</td></tr>` +
        `<tr><td>Reaction force</td><td>${fmtSig(mag(rt))} N</td></tr></table>` +
        `<div class="cfd-muted">Yield ${yieldTxt} · applied ${fmtSig(mag(ap))} N · balance error ${(r.equilibriumError * 100).toExponential(1)} %<br>` +
        `${(r.nodes || 0).toLocaleString()} nodes · ${(r.elements || 0).toLocaleString()} TET10 · ${esc(r.mesh && r.mesh.quality || "")} mesh (${fmtSig(r.mesh && r.mesh.size_mm, 2)} mm)` +
        `${r.solver ? ` · ${esc(r.solver.method)}` : ""}</div>`;
      const w = r.warnings || [];
      warnEl.innerHTML = w.map((x) => `<div>${esc(x)}</div>`).join("");
      warnEl.classList.toggle("hidden", !w.length);
    } else { resEl.innerHTML = ""; warnEl.classList.add("hidden"); }
    display.classList.toggle("hidden", !st.data);
  }

  async function stop() {
    btnStop.disabled = true;
    try { await platform.fea.stop(study.casePath); ctx.toast("Stopping the FEA solver"); log("fea.results.stop", { id: study.id }); }
    catch (e) { ctx.toast("Could not stop: " + (e.message || e)); }
    setTimeout(() => { btnStop.disabled = false; }, 3000);
  }
  async function rerun() {
    if (!ctx.rerun) return;
    btnRerun.disabled = true;
    try {
      const ok = await ctx.rerun(study);
      if (ok) {
        st.manifest = null; st.results = null; st.progress = null; st.finalSeen = false; st.loadingKey = null;
        clearObjects(); st.data = null;
        clearInterval(st.pollTimer); st.pollTimer = setInterval(poll, POLL_MS); poll();
      }
    } finally { btnRerun.disabled = false; }
  }

  // ================================================================ viz
  async function loadViz(man) {
    const sb = await readBytes("viz/" + man.surface.file);
    if (!sb || st.closed) return;
    const s = L.parseSurface(sb);
    const F = man.fields || {};
    const [db, vb, fb, pb] = await Promise.all([
      F.displacement ? readBytes("viz/" + F.displacement.file) : null,
      F.vonMises ? readBytes("viz/" + F.vonMises.file) : null,
      F.safetyFactor ? readBytes("viz/" + F.safetyFactor.file) : null,
      F.principal ? readBytes("viz/" + F.principal.file) : null,
    ]);
    if (st.closed) return;
    const n = s.count;
    const data = {
      n, pos: new Float32Array(s.positions), index: new Uint32Array(s.index),
      disp: db ? new Float32Array(L.parseField(db, n, 3)) : new Float32Array(3 * n),
      vm: vb ? new Float32Array(L.parseField(vb, n)) : new Float32Array(n),
      fos: fb ? new Float32Array(L.parseField(fb, n)) : null,
      pr: pb ? new Float32Array(L.parseField(pb, n, 3)) : null,
      man,
    };
    data.dmax = 0;
    for (let i = 0; i < n; i++) data.dmax = Math.max(data.dmax, Math.hypot(data.disp[3 * i], data.disp[3 * i + 1], data.disp[3 * i + 2]));
    const box = new THREE.Box3().setFromArray(data.pos);
    data.extent = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-6);
    data.autoScale = L.adjustedScale(data.dmax, data.extent);
    st.data = data;
    build();
    log("fea.results.loaded", { vertices: n, dmax: data.dmax });
    try { ctx.onLoaded && ctx.onLoaded({ bounds: [box.min.toArray(), box.max.toArray()] }); } catch (e) {}
  }

  function build() {
    clearObjects();
    const d = st.data;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(d.pos), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * d.n), 3));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    objs.mesh = new THREE.Mesh(g, surfMat); objs.mesh.name = "fea-mesh";
    // feature edges of the deformed shape + the undeformed ghost (both from the undeformed geometry)
    const ug = new THREE.BufferGeometry();
    ug.setAttribute("position", new THREE.BufferAttribute(d.pos, 3));
    ug.setIndex(new THREE.BufferAttribute(d.index, 1));
    const eg = new THREE.EdgesGeometry(ug, 30);
    ug.dispose();
    objs.ghost = new THREE.LineSegments(eg, ghostMat); objs.ghost.name = "fea-ghost";
    // deformed edges: map each edge vertex back to its surface vertex so it can follow the deformation
    const ep = eg.getAttribute("position").array;
    const key = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    const vid = new Map();
    for (let i = 0; i < d.n; i++) vid.set(key(d.pos[3 * i], d.pos[3 * i + 1], d.pos[3 * i + 2]), i);
    d.edgeVid = new Int32Array(ep.length / 3);
    for (let i = 0; i < d.edgeVid.length; i++) d.edgeVid[i] = vid.get(key(ep[3 * i], ep[3 * i + 1], ep[3 * i + 2])) ?? -1;
    const de = new THREE.BufferGeometry();
    de.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ep), 3));
    objs.edges = new THREE.LineSegments(de, edgeMat); objs.edges.name = "fea-edges";
    objs.probes = new THREE.Group(); objs.probes.name = "fea-probes";
    root.add(objs.mesh, objs.ghost, objs.edges, objs.probes);
    recolor(); deform(); buildProbes();
    if (!st.fitted) { st.fitted = true; fitView(); }
    applyDisplay();
    renderStatus();
  }

  function scale() {
    const d = st.data; if (!d) return 0;
    const mode = st.show.scaleMode;
    return mode === "none" ? 0 : mode === "actual" ? 1 : d.autoScale * st.show.adj;
  }
  function deform(k = 1) {
    const d = st.data; if (!d || !objs.mesh) return;
    const s = scale() * k;
    const pa = objs.mesh.geometry.getAttribute("position"), p = pa.array;
    for (let i = 0; i < 3 * d.n; i++) p[i] = d.pos[i] + s * d.disp[i];
    pa.needsUpdate = true;
    objs.mesh.geometry.computeVertexNormals();
    objs.mesh.geometry.computeBoundingSphere();
    const ea = objs.edges.geometry.getAttribute("position"), e = ea.array;
    for (let i = 0; i < d.edgeVid.length; i++) { const v = d.edgeVid[i]; if (v >= 0) for (let c = 0; c < 3; c++) e[3 * i + c] = p[3 * v + c]; }
    ea.needsUpdate = true;
    objs.edges.geometry.computeBoundingSphere();
    scaleTxt.textContent = st.show.scaleMode === "adjusted" ? `× ${fmtSig(scale(), 3)}` : st.show.scaleMode === "actual" ? "× 1" : "× 0";
    adj.disabled = st.show.scaleMode !== "adjusted";
    if (objs.probes) for (const pr of objs.probes.children) {
      const v = pr.userData.vid;
      if (v >= 0) pr.position.set(p[3 * v], p[3 * v + 1], p[3 * v + 2]);
    }
    vp.requestRender();
  }

  /** The active field: values per vertex, colour map, legend range and label. */
  function field() {
    const d = st.data, f = st.show.field, man = d.man, F = man.fields || {};
    if (f === "safety" && d.fos) return { vals: d.fos, map: "fos", lo: 0, hi: FOS_MAX, title: "Safety Factor", unit: "", fmt: (v) => fmtSig(v, 2), extra: "< 1 = yields (red)" };
    if (f === "displacement") {
      const vals = new Float32Array(d.n);
      for (let i = 0; i < d.n; i++) vals[i] = Math.hypot(d.disp[3 * i], d.disp[3 * i + 1], d.disp[3 * i + 2]);
      return { vals, map: "rainbow", lo: 0, hi: d.dmax || 1e-12, title: "Displacement", unit: " mm", fmt: (v) => fmtSig(v, 3), extra: "total magnitude" };
    }
    if ((f === "p1" || f === "p3") && d.pr) {
      const vals = new Float32Array(d.n), k = f === "p1" ? 0 : 2;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < d.n; i++) { const v = d.pr[3 * i + k]; vals[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!(hi > lo)) hi = lo + 1e-9;
      return { vals, map: "rainbow", lo, hi, title: f === "p1" ? "1st Principal" : "3rd Principal", unit: " MPa", fmt: (v) => fmtSig(v, 3), extra: f === "p1" ? "max tension" : "max compression" };
    }
    let hi = F.vonMises && F.vonMises.max;
    if (!(hi > 0)) { hi = 0; for (let i = 0; i < d.n; i++) if (d.vm[i] > hi) hi = d.vm[i]; }
    return { vals: d.vm, map: "rainbow", lo: 0, hi: hi || 1e-9, title: "Stress (von Mises)", unit: " MPa", fmt: (v) => fmtSig(v, 3),
      extra: (man.yield_MPa || []).filter(Boolean).length ? `yield ${man.yield_MPa.filter(Boolean).map((y) => fmtSig(y)).join(", ")} MPa` : "" };
  }
  function recolor() {
    const d = st.data; if (!d || !objs.mesh) return;
    const fl = field();
    const col = objs.mesh.geometry.getAttribute("color"), a = col.array, c = [0, 0, 0];
    const span = fl.hi - fl.lo || 1;
    for (let i = 0; i < d.n; i++) {
      cmap(fl.map, (fl.vals[i] - fl.lo) / span, c);
      a[3 * i] = toLinear(c[0]); a[3 * i + 1] = toLinear(c[1]); a[3 * i + 2] = toLinear(c[2]);
    }
    col.needsUpdate = true;
    st.legend = fl;
    renderLegend();
    vp.requestRender();
  }

  // min / max probes: small spheres at the extreme vertices, labelled in the DOM
  function buildProbes() {
    const d = st.data, mk = (d.man && d.man.markers) || {};
    for (const o of [...objs.probes.children]) { objs.probes.remove(o); o.geometry.dispose(); o.material.dispose(); }
    // nearest surface vertex to each marker position (markers come from all nodes; the extremes are on the surface for these fields)
    const near = (p) => { let best = -1, bd = Infinity; for (let i = 0; i < d.n; i++) { const dx = d.pos[3 * i] - p[0], dy = d.pos[3 * i + 1] - p[1], dz = d.pos[3 * i + 2] - p[2]; const q = dx * dx + dy * dy + dz * dz; if (q < bd) { bd = q; best = i; } } return best; };
    const list = [
      ["maxVonMises", "Max von Mises", (v) => `${fmtSig(v)} MPa`, 0xd62020],
      ["maxDisplacement", "Max displacement", (v) => `${fmtSig(v)} mm`, 0x1f5fd6],
      ["minSafetyFactor", "Min safety factor", (v) => fmtSig(v), 0xd67a20],
    ];
    const r = d.extent * 0.008;
    for (const [k, label, fmt, color] of list) {
      const m = mk[k];
      if (!m || !m.pos) continue;
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      s.renderOrder = 8;
      s.userData = { vid: near(m.pos), key: k, text: `${label}: ${fmt(m.value)}` };
      objs.probes.add(s);
    }
    deform();
  }
  function placeLabels() {
    labels.innerHTML = "";
    if (!st.data || !st.show.probes || !objs.probes) return;
    const host = ctx.host.getBoundingClientRect();
    const seen = new Map();
    for (const s of objs.probes.children) {
      const w = new THREE.Vector3(); s.getWorldPosition(w);
      const p = vp.worldToScreen(w);
      if (p.behind) continue;
      const k = `${Math.round(p.x / 8)},${Math.round(p.y / 8)}`;
      const dy = (seen.get(k) || 0); seen.set(k, dy + 18);
      labels.append(h("div", { class: "fea-probe", style: `left:${p.x - host.left + 8}px;top:${p.y - host.top - 10 + dy}px` }, s.userData.text));
    }
  }
  function labelLoop() {
    if (st.closed) return;
    // re-place the DOM labels only when the view (or the deformation) changed
    const e = vp.camera.matrixWorld.elements, r = vp.canvas.getBoundingClientRect();
    const sig = `${e.map((x) => x.toFixed(4)).join()}|${vp.camera.zoom}|${r.width}x${r.height}|${scale()}|${st.show.probes}|${st.anim ? performance.now() : ""}`;
    if (sig !== st.labelSig) { st.labelSig = sig; placeLabels(); }
    if (st.anim && st.data) {
      const t = (performance.now() - st.t0) / 1000;
      deform(0.5 - 0.5 * Math.cos(t * 2.4));
    }
    st.raf = requestAnimationFrame(labelLoop);
  }
  function animate() {
    st.t0 = performance.now();
    if (!st.anim) deform();
  }

  function fitView() {
    const d = st.data; if (!d) return;
    const box = new THREE.Box3().setFromArray(d.pos);
    if (root.matrixAutoUpdate === false) box.applyMatrix4(root.matrix);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    vp.animateTo({ target: c, dist: Math.max(size.x, size.y, size.z, 1e-3) * 2.0 }, 450);
  }

  function clearObjects() {
    for (const k of ["mesh", "ghost", "edges"]) if (objs[k]) { root.remove(objs[k]); objs[k].geometry.dispose(); objs[k] = null; }
    if (objs.probes) { for (const o of objs.probes.children) { o.geometry.dispose(); o.material.dispose(); } root.remove(objs.probes); objs.probes = null; }
    labels.innerHTML = ""; legends.innerHTML = "";
    vp.requestRender();
  }

  function applyDisplay() {
    const s = st.show, have = !!(st.data && objs.mesh);
    if (objs.ghost) objs.ghost.visible = s.ghost && scale() > 0;
    if (objs.probes) objs.probes.visible = s.probes;
    setModel(s.model || !have);
    if (have && !st.raf) labelLoop();
    renderLegend();
    vp.requestRender();
  }
  function setModel(v) { ctx.setModelVisible && ctx.setModelVisible(v); }

  function renderLegend() {
    legends.innerHTML = "";
    const b = st.legend;
    if (!b || !st.data) return;
    const ticks = [];
    const N = b.map === "fos" ? 8 : 5;
    for (let k = 0; k <= N; k++) {
      const v = b.lo + (b.hi - b.lo) * (k / N);
      const label = b.map === "fos" && k === N ? `${b.fmt(v)}+` : b.fmt(v) + b.unit;
      ticks.push(h("span", { style: `bottom:${(k / N) * 100}%` }, label));
    }
    legends.append(h("div", { class: "cfr-legend panel" }, h("div", { class: "cfr-lt" }, b.title),
      h("div", { class: "cfr-lbody" }, h("div", { class: "cfr-bar", style: `background:${cssGradient(b.map)}` }), h("div", { class: "cfr-ticks" }, ticks)),
      h("div", { class: "cfr-lx" }, [b.extra, `deformation ${scaleTxt.textContent}`].filter(Boolean).join(" · "))));
  }

  // ================================================================ close
  function close() {
    if (st.closed) return;
    st.closed = true;
    cancelAnimationFrame(st.raf);
    clearInterval(st.pollTimer);
    clearObjects();
    vp.groups.results.remove(root);
    surfMat.dispose(); ghostMat.dispose(); edgeMat.dispose();
    el.remove(); legends.remove(); labels.remove();
    setModel(true);
    vp.requestRender();
    log("fea.results.close", { id: study.id });
    if (current && current.study.id === study.id) current = null;
  }
}

export function currentFeaResults() { return current; }
export function closeFeaResults() { if (current) current.close(); }

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

const STRESS_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3 15.5h14"/><path d="M4.5 15.5V12M15.5 15.5V12"/><path d="M4.5 12c3-4.5 8-4.5 11 0"/><path d="M10 2.5v5.2"/><path d="M8.2 5.9 10 7.7l1.8-1.8"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
