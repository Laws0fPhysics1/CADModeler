// In-app CFD results. A study runs CFD Sim's solver headless (platform.cfd.run)
// and this module shows it inside the CAD viewport while it runs and after:
// progress / Stop, force coefficients, and the flow itself: surface pressure (Cp)
// on the body, vortex (Q) surfaces, streamlines and centre slices, with a frame
// timeline and colour legends.
//
// Data: <case>/viz/manifest.json + binary files written by CFD Sim/cfd/cadviz.py.
// Everything is already in CAD millimetres and CAD axes. Layouts: docs/cfd-exchange.md.
import * as THREE from "three";
import "./cfdresults.css";
import * as platform from "./platform.js";
import * as L from "./cfdlink.js";

const POLL_MS = 1500;
const CACHE_FILES = 40;
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
const fmtRe = (v) => (v == null || !isFinite(v) ? "–" : v >= 1e4 ? v.toExponential(2).replace("e+", " × 10^") : String(Math.round(v)));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtTime = (s) => (!isFinite(s) ? "" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

// ---------------------------------------------------------------- colour maps (sRGB 0..1)
const STOPS = {
  // diverging blue - white - red, for pressure
  cp: [[0, [0.23, 0.30, 0.75]], [0.25, [0.47, 0.62, 0.97]], [0.545, [0.87, 0.87, 0.87]], [0.78, [0.96, 0.60, 0.48]], [1, [0.71, 0.02, 0.15]]],
  // turbo-like rainbow, for speed
  speed: [[0, [0.19, 0.07, 0.23]], [0.15, [0.27, 0.42, 0.89]], [0.3, [0.16, 0.73, 0.88]], [0.45, [0.27, 0.95, 0.53]], [0.6, [0.71, 0.96, 0.21]], [0.75, [0.98, 0.73, 0.22]], [0.88, [0.93, 0.36, 0.11]], [1, [0.48, 0.02, 0.01]]],
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
const LUT = {};
function lut(name) { // 256 x RGB, sRGB bytes
  if (LUT[name]) return LUT[name];
  const a = new Uint8Array(256 * 3), c = [0, 0, 0];
  for (let i = 0; i < 256; i++) { cmap(name, i / 255, c); a[i * 3] = c[0] * 255; a[i * 3 + 1] = c[1] * 255; a[i * 3 + 2] = c[2] * 255; }
  return (LUT[name] = a);
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function cssGradient(name) {
  const c = [0, 0, 0];
  const stops = [];
  for (let i = 0; i <= 10; i++) { cmap(name, i / 10, c); stops.push(`rgb(${c.map((v) => Math.round(v * 255)).join(",")}) ${i * 10}%`); }
  return `linear-gradient(to top, ${stops.join(",")})`;
}

// ---------------------------------------------------------------- binary readers
const ascii = (u8, o = 0) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
const pad4 = (n) => n + ((4 - (n % 4)) % 4);
function view(bytes) { return { u8: bytes, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), base: bytes.byteOffset }; }
// typed array at an offset (copies when unaligned)
function f32(b, off, n) { const o = b.byteOffset + off; return o % 4 ? new Float32Array(b.slice(off, off + 4 * n).buffer) : new Float32Array(b.buffer, o, n); }
function u32(b, off, n) { const o = b.byteOffset + off; return o % 4 ? new Uint32Array(b.slice(off, off + 4 * n).buffer) : new Uint32Array(b.buffer, o, n); }

export function parseSurface(b) {
  if (ascii(b) !== "CSF1") throw new Error("bad surface file");
  const { dv } = view(b), n = dv.getUint32(4, true), m = dv.getUint32(8, true);
  return { positions: f32(b, 12, 3 * n), index: u32(b, 12 + 12 * n, 3 * m), count: n };
}
export function parseIso(b) {
  if (ascii(b) !== "CQI1") throw new Error("bad iso file");
  const { dv } = view(b), n = dv.getUint32(4, true), m = dv.getUint32(8, true);
  let o = 12;
  const pos = f32(b, o, 3 * n); o += 12 * n;
  const nrm = new Int8Array(b.buffer, b.byteOffset + o, 3 * n); o += pad4(3 * n);
  const spd = new Uint8Array(b.buffer, b.byteOffset + o, n); o += pad4(n);
  const tri = u32(b, o, 3 * m);
  return { pos, nrm, spd, tri, points: n, triangles: m };
}
export function parseSlices(b) {
  if (ascii(b) !== "CSL1") throw new Error("bad slice file");
  const { dv } = view(b), k = dv.getUint32(4, true);
  let o = 8;
  const out = [];
  for (let i = 0; i < k; i++) {
    const w = dv.getUint32(o, true), hh = dv.getUint32(o + 4, true); o += 8;
    const c = f32(b, o, 12); o += 48;
    const n = w * hh;
    const speed = new Uint8Array(b.buffer, b.byteOffset + o, n); o += pad4(n);
    const cp = new Uint8Array(b.buffer, b.byteOffset + o, n); o += pad4(n);
    const fluid = new Uint8Array(b.buffer, b.byteOffset + o, n); o += pad4(n);
    out.push({ w, h: hh, o: [c[0], c[1], c[2]], u: [c[3], c[4], c[5]], v: [c[6], c[7], c[8]], speed, cp, fluid });
  }
  return out;
}
export function parseLines(b) {
  if (ascii(b) !== "CST1") throw new Error("bad streamline file");
  const { dv } = view(b), nl = dv.getUint32(4, true), np = dv.getUint32(8, true);
  let o = 12;
  const offs = u32(b, o, nl + 1); o += 4 * (nl + 1);
  const pos = f32(b, o, 3 * np); o += 12 * np;
  const spd = new Uint8Array(b.buffer, b.byteOffset + o, np);
  return { offs, pos, spd, lines: nl, points: np };
}

// ---------------------------------------------------------------- panel
/**
 * Show a study's results (and live progress while it runs) in the viewport.
 * @param {object} ctx
 * @param {import("./viewport.js").Viewport} ctx.vp
 * @param {HTMLElement} ctx.host                    the workspace element
 * @param {(msg:string)=>void} ctx.toast
 * @param {(type:string,data:object)=>void} [ctx.logEvent]
 * @param {(id:string, patch:object)=>void} [ctx.onStudyUpdate]   persist status / coefficients into the document
 * @param {(visible:boolean)=>void} [ctx.setModelVisible]          show / hide the CAD bodies
 * @param {(study:object)=>Promise<boolean>} [ctx.rerun]           write + start the same case again
 * @param {object} study  { id, name, casePath, design, settings? }
 */
export function openCfdResults(ctx, study) {
  if (current) {
    if (current.study.id === study.id) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
    current.close();
  }
  const vp = ctx.vp;
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const st = {
    manifest: null, progress: null, results: null, proc: null,
    frame: -1, shown: -1, follow: true, playing: false, playTimer: null, pollTimer: null, loading: false, pending: null,
    show: { surface: true, iso: true, lines: false, slice: "off", field: "speed", model: false },
    files: new Map(), surfaceGeo: null, closed: false, lastFrames: 0, finalSeen: false, errors: 0,
  };

  // three.js objects
  const root = new THREE.Group(); root.name = "cfd-results";
  vp.groups.results.add(root);
  const surfMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const isoMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.0, side: THREE.DoubleSide });
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 });
  const objs = { surface: null, iso: null, lines: null, slice: null };

  // ---- DOM
  const statusEl = h("div", { class: "cfr-status" });
  const resEl = h("div", { class: "cfr-res" });
  const check = (label, key) => {
    const c = h("input", { type: "checkbox" }); c.checked = st.show[key];
    c.addEventListener("change", () => { st.show[key] = c.checked; log("cfd.results.display", { [key]: c.checked }); applyDisplay(); });
    return { el: h("label", { class: "cfd-check" }, c, h("span", {}, label)), c };
  };
  const sel = (opts, value, on) => {
    const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value; s.addEventListener("change", () => on(s.value)); return s;
  };
  const ckSurf = check("Surface pressure (Cp)", "surface");
  const ckIso = check("Vortex surfaces", "iso");
  const ckLines = check("Streamlines", "lines");
  const ckModel = check("Show CAD model", "model");
  const sliceSel = sel([["off", "Off"], ["side", "Side (flow × up)"], ["top", "Top (flow × side)"], ["wake", "Wake (cross-flow)"]], st.show.slice, (v) => { st.show.slice = v; applyDisplay(); });
  const fieldSel = sel([["speed", "Velocity"], ["cp", "Pressure (Cp)"]], st.show.field, (v) => { st.show.field = v; applyDisplay(); });
  const row = (label, ctl) => h("div", { class: "dlg-row" }, h("label", {}, label), h("div", { class: "ctl" }, ctl));
  const btnStop = h("button", { class: "btn", onclick: stop }, "Stop");
  const btnRerun = h("button", { class: "btn", onclick: rerun, title: "Run this case again" }, "Re-run");
  const btnReveal = h("button", { class: "btn", onclick: () => platform.cfd.revealCase(study.casePath), title: study.casePath }, "Folder");
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic cfd-ic", html: WIND_ICON }), h("span", { class: "cfr-title" }, `CFD · ${study.name || study.design || "Study"}`),
    h("button", { class: "x", title: "Close results", html: CLOSE_ICON, onclick: () => close() }));
  const body = h("div", { class: "dlg-body" },
    statusEl, resEl,
    h("div", { class: "cfd-sec" }, "Display"),
    ckSurf.el, ckIso.el, ckLines.el,
    row("Slice", sliceSel), row("Colour by", fieldSel), ckModel.el);
  const foot = h("div", { class: "dlg-foot cfd-foot" }, btnStop, btnRerun, h("div", { class: "sp" }), btnReveal);
  const el = h("div", { class: "panel cfd-dlg cfr-panel" }, head, body, foot);
  el.addEventListener("keydown", (e) => e.stopPropagation());
  ctx.host.append(el);
  makeDraggable(el, head);

  // player (bottom centre) + legends (bottom left)
  const btnPlay = h("button", { class: "cfr-play", title: "Play / pause", html: PLAY_ICON, onclick: togglePlay });
  const slider = h("input", { type: "range", min: "0", max: "0", value: "0", step: "1" });
  slider.addEventListener("input", () => { st.follow = false; stopPlay(); showFrame(+slider.value); });
  const timeEl = h("span", { class: "cfr-time" }, "");
  const liveEl = h("button", { class: "cfr-live", title: "Follow the newest frame", onclick: () => { st.follow = true; showLatest(); } }, "LIVE");
  const player = h("div", { class: "cfr-player panel" }, btnPlay, slider, timeEl, liveEl);
  const legends = h("div", { class: "cfr-legends" });
  ctx.host.append(player, legends);

  current = { el, study, close, refresh: () => poll() };
  log("cfd.results.open", { id: study.id });
  setModel(false);
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
        platform.cfd.readResults(study.casePath).catch(() => null),
        readText("viz/manifest.json").then((t) => (t ? JSON.parse(t) : null)).catch(() => null),
        platform.cfd.status(study.casePath).catch(() => null),
      ]);
    } catch { return; }
    if (st.closed) return;
    const { progress, results } = L.normalizeReadback(rb);
    st.progress = progress; st.results = results; st.proc = proc;
    if (man && Array.isArray(man.frames)) {
      const grew = !st.manifest || man.frames.length !== st.manifest.frames.length;
      st.manifest = man;
      if (grew) onFrames();
    }
    renderStatus();
    const finished = results && results.status !== "running";
    const dead = proc && proc.known && !proc.running;
    if ((finished || (dead && !results)) && !st.finalSeen) {
      st.finalSeen = true;
      ctx.onStudyUpdate && ctx.onStudyUpdate(study.id, summary());
      if (finished && results.status === "completed") ctx.toast(`CFD finished: Cd ${fmtSig(results.Cd)}`);
    }
    // keep polling slowly once finished (the GUI could re-run the same case); stop if the folder is gone
    if (finished && st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = setInterval(poll, POLL_MS * 4); }
  }

  function summary() {
    const r = st.results || {};
    return { status: r.status || (st.proc && st.proc.exitCode ? "failed" : "unknown"), Cd: r.Cd ?? null, Cl: r.Cl ?? null, Cs: r.Cs ?? null,
      forces_N: r.forces_N || null, finishedAt: (r.timings && r.timings.finishedAt) || new Date().toISOString() };
  }

  async function readBytes(rel) {
    if (st.files.has(rel)) { const v = st.files.get(rel); st.files.delete(rel); st.files.set(rel, v); return v; }
    const b = await platform.cfd.readFile(study.casePath, rel);
    if (b == null) return null;
    const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
    if (!rel.endsWith(".json")) {
      st.files.set(rel, u8);
      while (st.files.size > CACHE_FILES) st.files.delete(st.files.keys().next().value);
    }
    return u8;
  }
  async function readText(rel) {
    const b = await platform.cfd.readFile(study.casePath, rel);
    return b == null ? null : new TextDecoder().decode(b);
  }

  // ================================================================ status / results
  function renderStatus() {
    const p = st.progress, r = st.results, proc = st.proc;
    const running = proc ? proc.running : p && (p.status === "running" || p.status === "starting");
    btnStop.classList.toggle("hidden", !running);
    btnRerun.classList.toggle("hidden", !!running || !ctx.rerun);
    let s = "";
    if (r && r.status !== "running") {
      const label = { completed: "Completed", stopped: "Stopped", diverged: "Diverged", failed: "Failed" }[r.status] || r.status;
      s += `<div class="cfd-prog-head"><b class="${r.status === "completed" ? "cfd-ok" : r.status === "stopped" ? "" : "cfd-bad"}">${esc(label)}</b>` +
        `<span class="cfd-muted">${r.timings && r.timings.wall_s ? fmtTime(r.timings.wall_s) : ""}${r.backend ? ` · ${esc(r.backend.toUpperCase())}` : ""}</span></div>`;
      if (r.status === "failed" || r.status === "diverged") s += `<div class="cfd-bad cfr-err">${esc(lastLine(r.error) || (r.status === "diverged" ? "The solution blew up (NaN). Try a lower speed or a higher quality preset." : "See cfd-run.log in the case folder."))}</div>`;
    } else if (p && (p.status === "running" || p.status === "starting")) {
      const frac = p.fraction != null ? p.fraction : p.total ? p.step / p.total : 0;
      const eta = frac > 0.01 && p.elapsed_s ? p.elapsed_s * (1 - frac) / frac : NaN;
      s += `<div class="cfd-prog-head"><b>${p.status === "starting" ? "Preparing grid…" : "Solving"}</b><span>${Math.round(100 * frac)}%</span></div>` +
        `<div class="cfd-bar"><i style="width:${(100 * frac).toFixed(1)}%"></i></div>` +
        `<div class="cfd-muted">${p.step ? `Step ${p.step.toLocaleString()} / ${(p.total || 0).toLocaleString()}` : ""}${isFinite(eta) ? ` · ${fmtTime(eta)} left` : ""}${p.elapsed_s ? ` · ${fmtTime(p.elapsed_s)} elapsed` : ""}</div>`;
    } else if (proc && proc.known && !proc.running && proc.exitCode) {
      s += `<div class="cfd-prog-head"><b class="cfd-bad">Solver stopped (exit code ${proc.exitCode})</b></div><pre class="cfr-log">${esc(proc.logTail || "")}</pre>`;
    } else if (proc && proc.running) {
      s += `<div class="cfd-prog-head"><b>Starting solver…</b></div><div class="cfd-bar cfd-bar-indet"><i></i></div>`;
    } else if (!st.manifest) {
      s += `<div class="cfd-muted">No results in this case folder yet.</div>`;
    }
    statusEl.innerHTML = s;
    // coefficients: final means when done, live values while running
    const src = r && r.status !== "running" && r.Cd != null ? r : p;
    if (src && src.Cd != null) {
      const f = r && r.forces_N ? r.forces_N : null;
      resEl.innerHTML = `<table class="cfd-res"><tr><td>Cd</td><td>${fmtSig(src.Cd)}</td>${f ? `<td>Drag</td><td>${fmtSig(f.drag)} N</td>` : ""}</tr>` +
        `<tr><td>Cl</td><td>${fmtSig(src.Cl)}</td>${f ? `<td>Lift</td><td>${fmtSig(f.lift)} N</td>` : ""}</tr>` +
        `<tr><td>Cs</td><td>${fmtSig(src.Cs)}</td>${f ? `<td>Side</td><td>${fmtSig(f.side)} N</td>` : ""}</tr></table>` +
        (r && r.status !== "running" ? `<div class="cfd-muted">${r.averaging ? "Mean of the last 20 % · " : ""}A<sub>ref</sub> ${fmtSig(r.referenceArea_m2)} m² · Re ${fmtRe(r.reynolds)}${r.cells ? ` · ${(r.cells / 1e6).toFixed(1)} M cells` : ""}</div>` : `<div class="cfd-muted">Instantaneous values</div>`);
    } else resEl.innerHTML = "";
  }
  const lastLine = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(-1)[0] || "";

  async function stop() {
    btnStop.disabled = true;
    try { await platform.cfd.stop(study.casePath); ctx.toast("Stopping: the solver is writing its results"); log("cfd.results.stop", { id: study.id }); }
    catch (e) { ctx.toast("Could not stop: " + (e.message || e)); }
    setTimeout(() => { btnStop.disabled = false; }, 3000);
  }
  async function rerun() {
    if (!ctx.rerun) return;
    btnRerun.disabled = true;
    try {
      const ok = await ctx.rerun(study);
      if (ok) {
        st.manifest = null; st.results = null; st.progress = null; st.finalSeen = false; st.files.clear();
        st.frame = st.shown = -1; st.follow = true; clearObjects();
        clearInterval(st.pollTimer); st.pollTimer = setInterval(poll, POLL_MS); poll();
      }
    } finally { btnRerun.disabled = false; }
  }

  // ================================================================ frames
  function onFrames() {
    const n = st.manifest.frames.length;
    slider.max = String(Math.max(0, n - 1));
    player.classList.toggle("hidden", n === 0);
    if (n && (st.follow || st.frame < 0)) showLatest();
  }
  function showLatest() {
    const n = st.manifest ? st.manifest.frames.length : 0;
    if (n) showFrame(n - 1);
  }
  function showFrame(i) {
    st.frame = i;
    slider.value = String(i);
    renderTime();
    loadAndShow();
  }
  function renderTime() {
    const n = st.manifest ? st.manifest.frames.length : 0;
    const f = n ? st.manifest.frames[st.frame] : null;
    timeEl.textContent = f ? `t = ${fmtSig(f.t * 1000, 3)} ms · ${st.frame + 1} / ${n}` : "";
    liveEl.classList.toggle("on", st.follow);
  }

  async function loadAndShow() {
    if (st.loading) { st.pending = true; return; }
    st.loading = true;
    try {
      do {
        st.pending = false;
        await buildFrame(st.frame);
      } while (st.pending && !st.closed);
    } catch (e) {
      if (st.errors++ < 3) console.warn("cfd results:", e);
    } finally { st.loading = false; }
  }

  async function buildFrame(i) {
    const man = st.manifest;
    if (!man || !man.frames[i] || st.closed) return;
    const fr = man.frames[i];
    const want = st.show;
    // surface mesh (once)
    if (want.surface && fr.surf && !st.surfaceGeo && man.surface) {
      const b = await readBytes("viz/" + man.surface.file);
      if (b) {
        const s = parseSurface(b);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(s.positions), 3));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(s.index), 1));
        g.computeVertexNormals();
        g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * s.count), 3));
        st.surfaceGeo = g;
      }
    }
    const [sb, ib, lb, slb] = await Promise.all([
      want.surface && fr.surf && st.surfaceGeo ? readBytes("viz/" + fr.surf.file) : null,
      want.iso && fr.iso ? readBytes("viz/" + fr.iso.file) : null,
      want.lines && fr.lines ? readBytes("viz/" + fr.lines.file) : null,
      want.slice !== "off" && fr.slice ? readBytes("viz/" + fr.slice.file) : null,
    ]);
    if (st.closed || st.frame !== i) { st.pending = true; return; }
    const ranges = man.ranges || {};
    // surface Cp
    if (sb && st.surfaceGeo) {
      const cp = f32(sb, 0, sb.byteLength / 4);
      const col = st.surfaceGeo.getAttribute("color");
      const [lo, hi] = ranges.cp || [-1.2, 1.0];
      const c = [0, 0, 0];
      for (let k = 0; k < cp.length && k < col.count; k++) {
        cmap("cp", (cp[k] - lo) / (hi - lo), c);
        col.array[3 * k] = toLinear(c[0]); col.array[3 * k + 1] = toLinear(c[1]); col.array[3 * k + 2] = toLinear(c[2]);
      }
      col.needsUpdate = true;
      if (!objs.surface) { objs.surface = new THREE.Mesh(st.surfaceGeo, surfMat); objs.surface.name = "cfd-surface"; root.add(objs.surface); }
      objs.surface.userData.frame = i;
    }
    // vortex surfaces coloured by speed
    if (ib) {
      const d = parseIso(ib);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(d.pos), 3));
      g.setAttribute("normal", new THREE.BufferAttribute(new Int8Array(d.nrm), 3, true));
      const col = new Float32Array(3 * d.points), c = [0, 0, 0];
      const sc = ranges.isoSpeedScale || 100;
      for (let k = 0; k < d.points; k++) { cmap("speed", d.spd[k] / sc / 1.6, c); col[3 * k] = toLinear(c[0]); col[3 * k + 1] = toLinear(c[1]); col[3 * k + 2] = toLinear(c[2]); }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(d.tri), 1));
      replace("iso", new THREE.Mesh(g, isoMat));
    }
    // streamlines
    if (lb) {
      const d = parseLines(lb);
      let segs = 0;
      for (let k = 0; k < d.lines; k++) segs += Math.max(0, d.offs[k + 1] - d.offs[k] - 1);
      const pos = new Float32Array(segs * 6), col = new Float32Array(segs * 6), c = [0, 0, 0];
      let o = 0;
      const sc = ranges.speedScale || 100;
      for (let k = 0; k < d.lines; k++) {
        for (let j = d.offs[k]; j < d.offs[k + 1] - 1; j++) {
          for (const q of [j, j + 1]) {
            pos[o] = d.pos[3 * q]; pos[o + 1] = d.pos[3 * q + 1]; pos[o + 2] = d.pos[3 * q + 2];
            cmap("speed", d.spd[q] / sc / 1.6, c);
            col[o] = toLinear(c[0]); col[o + 1] = toLinear(c[1]); col[o + 2] = toLinear(c[2]);
            o += 3;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      replace("lines", new THREE.LineSegments(g, lineMat));
    }
    // slice
    if (slb) {
      const planes = parseSlices(slb);
      const idx = (fr.slice.planes || []).findIndex((p) => p.name === want.slice);
      const p = planes[idx >= 0 ? idx : 0];
      if (p) { replace("slice", sliceMesh(p, want.field, ranges.slice || {})); objs.slice.userData.which = want.slice; }
    }
    for (const k of ["iso", "lines", "slice"]) if (objs[k] && ((k === "iso" && ib) || (k === "lines" && lb) || (k === "slice" && slb))) objs[k].userData.frame = i;
    st.shown = i;
    if (!st.fitted) { st.fitted = true; fitView(); }
    applyDisplay(true);
  }

  // Frame the body and its near wake (the vortex surfaces reach far downstream).
  function fitView() {
    const man = st.manifest;
    const box = new THREE.Box3();
    if (st.surfaceGeo) { st.surfaceGeo.computeBoundingBox(); box.copy(st.surfaceGeo.boundingBox); }
    else vp.groups.bodies.traverse((o) => { if (o.isMesh && o.geometry) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
    if (box.isEmpty()) return;
    const ax = { X: 0, Y: 1, Z: 2 }[(man.flow && man.flow.direction || "+X")[1]];
    const sgn = (man.flow && man.flow.direction || "+X")[0] === "-" ? -1 : 1;
    const size = box.getSize(new THREE.Vector3());
    const L = Math.max(size.x, size.y, size.z, 1e-3);
    const c = box.getCenter(new THREE.Vector3());
    c.setComponent(ax, c.getComponent(ax) + sgn * 0.6 * L);   // shift toward the wake
    vp.animateTo({ target: c, dist: L * 3.2 }, 500);
  }

  function sliceMesh(p, field, ranges) {
    const n = p.w * p.h, rgba = new Uint8Array(4 * n), table = lut(field === "cp" ? "cp" : "speed");
    const src = field === "cp" ? p.cp : p.speed;
    // the file quantizes over ranges[field]; the legend uses the same range, so the LUT maps 0..255 directly
    for (let k = 0; k < n; k++) {
      const v = src[k];
      rgba[4 * k] = table[3 * v]; rgba[4 * k + 1] = table[3 * v + 1]; rgba[4 * k + 2] = table[3 * v + 2];
      rgba[4 * k + 3] = p.fluid[k] ? 235 : 0;
    }
    const tex = new THREE.DataTexture(rgba, p.w, p.h, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const o = new THREE.Vector3(...p.o), u = new THREE.Vector3(...p.u), v = new THREE.Vector3(...p.v);
    const uv4 = u.clone().add(v).sub(o);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...o.toArray(), ...u.toArray(), ...uv4.toArray(), ...v.toArray()]), 3));
    // texel centres sit on the corner points
    const du = 0.5 / p.w, dv = 0.5 / p.h;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([du, dv, 1 - du, dv, 1 - du, 1 - dv, du, 1 - dv]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    mesh.userData.field = field;
    return mesh;
  }

  function replace(key, obj) {
    const old = objs[key];
    if (old) { root.remove(old); old.geometry.dispose(); if (old.material !== isoMat && old.material !== lineMat && old.material !== surfMat) { old.material.map && old.material.map.dispose(); old.material.dispose(); } }
    objs[key] = obj;
    if (obj) { obj.name = "cfd-" + key; root.add(obj); }
  }
  function clearObjects() {
    for (const k of ["iso", "lines", "slice"]) replace(k, null);
    if (objs.surface) { root.remove(objs.surface); objs.surface = null; }
    if (st.surfaceGeo) { st.surfaceGeo.dispose(); st.surfaceGeo = null; }
    vp.requestRender();
  }

  // Visibility of each layer, plus reloading layers that were off when the frame was built.
  function applyDisplay(fromBuild = false) {
    const s = st.show;
    const fr = st.manifest && st.manifest.frames[st.frame];
    const staleSlice = objs.slice && s.slice !== "off" && (objs.slice.userData.field !== s.field || objs.slice.userData.which !== s.slice);
    if (staleSlice && !fromBuild) replace("slice", null);
    const needs = (key, on, fileKey) => on && fr && fr[fileKey] && (!objs[key] || objs[key].userData.frame !== st.frame);
    if (!fromBuild && (needs("surface", s.surface, "surf") || needs("iso", s.iso, "iso") || needs("lines", s.lines, "lines") || needs("slice", s.slice !== "off", "slice"))) loadAndShow();
    if (objs.surface) objs.surface.visible = s.surface;
    if (objs.iso) objs.iso.visible = s.iso;
    if (objs.lines) objs.lines.visible = s.lines;
    if (objs.slice) objs.slice.visible = s.slice !== "off";
    // the Cp surface replaces the body; show the CAD model when asked or when there is nothing else to look at
    setModel(s.model || !(s.surface && objs.surface));
    renderLegends();
    vp.requestRender();
  }
  function setModel(v) { ctx.setModelVisible && ctx.setModelVisible(v); }

  function renderLegends() {
    const s = st.show, man = st.manifest;
    legends.innerHTML = "";
    if (!man) return;
    const rng = man.ranges || {};
    const U = man.speed_m_s || 1;
    const bars = [];
    const cpUsed = (s.surface && objs.surface) || (s.slice !== "off" && s.field === "cp");
    const spUsed = (s.iso && objs.iso) || (s.lines && objs.lines) || (s.slice !== "off" && s.field === "speed");
    if (cpUsed) {
      const r = s.slice !== "off" && s.field === "cp" && !(s.surface && objs.surface) ? (rng.slice && rng.slice.cp) || [-1.5, 1] : rng.cp || [-1.2, 1];
      bars.push({ title: "Pressure Cp", map: "cp", lo: r[0], hi: r[1], unit: "" , extra: `p − p∞ = Cp × ${fmtSig(man.q_Pa, 3)} Pa` });
    }
    if (spUsed) {
      const r = (rng.slice && rng.slice.speed) || [0, 1.6];
      bars.push({ title: "Velocity", map: "speed", lo: r[0] * U, hi: r[1] * U, unit: " m/s", extra: `free stream ${fmtSig(U, 3)} m/s` });
    }
    for (const b of bars) {
      const ticks = [];
      for (let k = 0; k <= 4; k++) { const v = b.lo + (b.hi - b.lo) * (k / 4); ticks.push(h("span", { style: `bottom:${k * 25}%` }, fmtSig(v, 2) + b.unit)); }
      legends.append(h("div", { class: "cfr-legend panel" }, h("div", { class: "cfr-lt" }, b.title),
        h("div", { class: "cfr-lbody" }, h("div", { class: "cfr-bar", style: `background:${cssGradient(b.map)}` }), h("div", { class: "cfr-ticks" }, ticks)),
        h("div", { class: "cfr-lx" }, b.extra)));
    }
  }

  // ================================================================ playback
  function togglePlay() { st.playing ? stopPlay() : startPlay(); }
  function startPlay() {
    if (!st.manifest || st.manifest.frames.length < 2) return;
    st.playing = true; st.follow = false; btnPlay.innerHTML = PAUSE_ICON;
    const step = () => {
      if (!st.playing || st.closed) return;
      if (!st.loading) { const n = st.manifest.frames.length; showFrame((st.frame + 1) % n); }
      st.playTimer = setTimeout(step, 120);
    };
    step();
  }
  function stopPlay() { st.playing = false; clearTimeout(st.playTimer); btnPlay.innerHTML = PLAY_ICON; renderTime(); }

  // ================================================================ close
  function close() {
    if (st.closed) return;
    st.closed = true;
    stopPlay(); clearInterval(st.pollTimer);
    clearObjects();
    vp.groups.results.remove(root);
    surfMat.dispose(); isoMat.dispose(); lineMat.dispose();
    el.remove(); player.remove(); legends.remove();
    setModel(true);
    vp.requestRender();
    log("cfd.results.close", { id: study.id });
    if (current && current.study.id === study.id) current = null;
  }
}

export function currentResults() { return current; }
export function closeResults() { if (current) current.close(); }

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
const PLAY_ICON = `<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 16 16"><path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor"/></svg>`;
