// 2D FLOW panel: runs the GPU lattice Boltzmann solver (cfd2dgpu.js) on a sketch's closed
// profiles and shows the flow live: speed / vorticity / pressure colour maps, streamlines, a
// hover probe, and lift and drag (coefficients, a history plot, and N per metre of span).
// Flow runs along the sketch's +X; "Angle of attack" pitches the section nose-up.
import "./cfdstudy.css";
import "./cfd2d.css";
import { setupCase, entitiesToLoops, FLUIDS, RESOLUTIONS } from "./cfd2d.js";
import { LBM2DGPU } from "./cfd2dgpu.js";

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
const sig = (v, d = 3) => (v == null || !isFinite(v) ? "–" : String(+(+v).toPrecision(d)));
const fmtRe = (r) => (r >= 1e6 ? `${sig(r / 1e6, 3)} M` : r >= 1e4 ? `${sig(r / 1e3, 3)} k` : sig(r, 3));
const MODES = [["speed", "Speed"], ["vort", "Vorticity"], ["cp", "Pressure (Cp)"]];
const PREFS = { fluid: "air", speed: 15, alpha: 0, resolution: "medium", mode: "speed", range: 1.4, stream: true };

export function closeFlow2D() { if (current) current.close(); }
export function currentFlow2D() { return current; }

/**
 * ctx: { host, sketches() -> [{ id, name, flat }], selectedSketchId, toast, logEvent, isDark() }
 */
export function openFlow2D(ctx) {
  if (current) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
  const toast = ctx.toast || (() => {});
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const sketches = ctx.sketches().map((s) => ({ ...s, loops: entitiesToLoops(s.flat) })).filter((s) => s.loops.length);
  if (!sketches.length) { toast("2D Flow needs a sketch with a closed profile (try CREATE → NACA Airfoil)"); return null; }
  const P = { ...PREFS, ...(openFlow2D.prefs || {}) };
  openFlow2D.prefs = P;
  P.sketch = sketches.some((s) => s.id === ctx.selectedSketchId) ? ctx.selectedSketchId : sketches.some((s) => s.id === P.sketch) ? P.sketch : sketches[sketches.length - 1].id;

  // ---------------- DOM
  const select = (opts, value, on) => { const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l))); s.value = value; s.addEventListener("change", () => on(s.value)); return s; };
  const num = (value, unit, on) => {
    const inp = h("input", { value: String(value), spellcheck: "false" });
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (isFinite(v)) on(v); else inp.value = String(value); });
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
    return h("div", { class: "num" }, inp, h("em", {}, unit));
  };
  const row = (label, ctl, title) => h("div", { class: "dlg-row" }, h("label", { title: title || null }, label), h("div", { class: "ctl" }, ctl));
  const restartOn = (k) => (v) => { P[k] = v; rebuild(); };

  const canvas = h("canvas", { class: "f2-gl" });
  const overlay = h("canvas", { class: "f2-ov" });
  const legend = h("div", { class: "f2-legend" });
  const probe = h("div", { class: "f2-probe" });
  const banner = h("div", { class: "f2-banner hidden" });
  const stage = h("div", { class: "f2-stage" }, canvas, overlay, legend, probe, banner);
  const plot = h("canvas", { class: "f2-plot", width: 300, height: 92 });
  const out = h("div", { class: "f2-out" });
  const reEl = h("div", { class: "f2-re" });
  const btnRun = h("button", { class: "btn primary", onclick: () => setRunning(!st.running) }, "Run");
  const btnReset = h("button", { class: "btn", onclick: () => rebuild(), title: "Restart from rest" }, "Reset");
  const rangeIn = h("input", { type: "range", min: "0.2", max: "3", step: "0.05", value: String(P.range) });
  rangeIn.addEventListener("input", () => { P.range = +rangeIn.value; drawLegend(); render(); });
  const streamCk = h("input", { type: "checkbox" }); streamCk.checked = P.stream;
  streamCk.addEventListener("change", () => { P.stream = streamCk.checked; st.lines = null; st.lastLines = 0; render(); });

  const side = h("div", { class: "f2-side" },
    h("div", { class: "cfd-sec" }, "Section"),
    row("Sketch", select(sketches.map((s) => [s.id, s.name]), P.sketch, restartOn("sketch"))),
    row("Angle of attack", num(P.alpha, "deg", restartOn("alpha")), "Nose-up pitch of the section; the flow runs along the sketch's +X"),
    h("div", { class: "cfd-sec" }, "Flow"),
    row("Fluid", select(Object.entries(FLUIDS).map(([k, f]) => [k, f.label]), P.fluid, restartOn("fluid"))),
    row("Speed", num(P.speed, "m/s", restartOn("speed"))),
    row("Resolution", select(Object.entries(RESOLUTIONS).map(([k, n]) => [k, `${k[0].toUpperCase()}${k.slice(1)} · ${n} cells / chord`]), P.resolution, restartOn("resolution"))),
    reEl,
    h("div", { class: "cfd-sec" }, "Display"),
    row("Colour by", select(MODES, P.mode, (v) => { P.mode = v; drawLegend(); render(); })),
    row("Range", rangeIn),
    h("label", { class: "dlg-row cfd-check" }, streamCk, h("span", {}, "Streamlines")),
    h("div", { class: "cfd-sec" }, "Forces (per metre of span)"),
    out, plot,
  );
  const headTitle = h("span", {}, "2D Flow");
  const head = h("div", { class: "dlg-head" }, h("i", { class: "cfd-ic", html: ctx.icon || "" }), headTitle, h("button", { class: "x", title: "Close", html: ctx.closeIcon || "✕", onclick: () => close() }));
  const foot = h("div", { class: "dlg-foot" }, h("span", { class: "f2-hint" }, "Wheel: zoom · drag: pan · double-click: fit"), h("div", { class: "sp" }), btnRun, btnReset, h("button", { class: "btn", onclick: () => close() }, "Close"));
  const el = h("div", { class: "panel f2-dlg" }, head, h("div", { class: "f2-main" }, side, stage), foot);
  ctx.host.append(el);
  makeDraggable(el, head);

  // ---------------- state
  const st = { sim: null, cs: null, running: false, view: null, lines: null, lastLines: 0, fields: null, raf: 0, spf: 20, closed: false, mouse: null };

  function rebuild() {
    const wasRunning = st.running || !st.sim;
    setRunning(false);
    if (st.sim) { st.sim.dispose(); st.sim = null; }
    st.lines = null; st.fields = null;
    banner.classList.add("hidden");
    const sk = sketches.find((s) => s.id === P.sketch);
    try {
      st.cs = setupCase(sk.loops, { alpha: P.alpha, speed: P.speed, fluid: P.fluid, resolution: P.resolution });
      st.sim = new LBM2DGPU(st.cs, canvas);
    } catch (e) {
      st.cs = null;
      banner.textContent = e.message; banner.classList.remove("hidden");
      log("flow2d error", { message: e.message });
      render(); return;
    }
    const cs = st.cs;
    headTitle.textContent = `2D Flow · ${sk.name}`;
    reEl.innerHTML = `Re <b>${fmtRe(cs.Re)}</b>${cs.clamped ? ` <span class="cfd-muted">(real ${fmtRe(cs.ReTrue)}: capped by the grid; the subgrid model stands in for the rest, so treat drag as approximate)</span>` : ""}<br><span class="cfd-muted">Grid ${cs.nx} × ${cs.ny} · chord ${sig(cs.refLength, 4)} mm = ${Math.round(cs.refCells)} cells</span>`;
    fitView();
    log("flow2d start", { sketch: sk.name, alpha: P.alpha, speed: P.speed, fluid: P.fluid, res: P.resolution, nx: cs.nx, ny: cs.ny, Re: cs.Re });
    drawLegend();
    setRunning(wasRunning);
    render();
  }
  function setRunning(on) {
    st.running = !!on && !!st.sim;
    btnRun.textContent = st.running ? "Pause" : st.sim && st.sim.t ? "Resume" : "Run";
    if (st.running && !st.raf) st.raf = requestAnimationFrame(tick);
  }
  function tick() {
    st.raf = 0;
    if (st.closed || !st.running || !st.sim) return;
    const t0 = performance.now();
    st.sim.step(st.spf, { sampleEvery: 20 });
    st.sim.gl.finish();
    const dt = performance.now() - t0;
    // aim for ~14 ms of solving per frame
    st.spf = Math.max(10, Math.min(2000, Math.round(st.spf * (dt > 0 ? Math.min(1.5, Math.max(0.6, 14 / dt)) : 1.5) / 10) * 10));
    if (P.stream && performance.now() - st.lastLines > 350) { st.fields = st.sim.fields(st.fields); st.lines = streamlines(st.fields, st.cs); st.lastLines = performance.now(); }
    render();
    // stop by itself after 40 chord passes; the averages have long settled by then
    if (st.sim.passes > 40) { setRunning(false); toast("2D Flow: 40 chord passes done, paused"); }
    if (st.running) st.raf = requestAnimationFrame(tick);
  }

  // ---------------- view (cells)
  function canvasSize() {
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(50, Math.round(r.width * dpr)), hh = Math.max(50, Math.round(r.height * dpr));
    for (const c of [canvas, overlay]) if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    return { w, h: hh };
  }
  function fitView() {
    if (!st.cs) return;
    const { w, h: hh } = canvasSize(), cs = st.cs;
    // frame the section and the near wake rather than the whole far field
    const L = cs.refCells, b = solidBox(cs);
    const cx = (b.x0 + b.x1) / 2 + 0.8 * L, cy = (b.y0 + b.y1) / 2;
    const halfW = Math.max(1.7 * L, (b.x1 - b.x0) * 1.3), halfH = (halfW * hh) / w;
    st.view = { cx, cy, s: (2 * halfW) / w }; // cells per pixel
  }
  const viewRect = () => { const { w, h: hh } = canvasSize(), v = st.view; return [v.cx - (w / 2) * v.s, v.cy - (hh / 2) * v.s, v.cx + (w / 2) * v.s, v.cy + (hh / 2) * v.s]; };
  const toCell = (e) => { const r = overlay.getBoundingClientRect(), dpr = overlay.width / r.width, vr = viewRect(); return [vr[0] + (e.clientX - r.left) * dpr * st.view.s, vr[3] - (e.clientY - r.top) * dpr * st.view.s]; };
  overlay.addEventListener("wheel", (e) => {
    if (!st.view) return;
    e.preventDefault();
    const [x, y] = toCell(e), k = Math.exp(e.deltaY * 0.0015);
    st.view.cx = x + (st.view.cx - x) * k; st.view.cy = y + (st.view.cy - y) * k; st.view.s *= k;
    render();
  }, { passive: false });
  overlay.addEventListener("pointerdown", (e) => {
    if (!st.view) return;
    const r = overlay.getBoundingClientRect(), dpr = overlay.width / r.width;
    const sx = e.clientX, sy = e.clientY, cx = st.view.cx, cy = st.view.cy;
    overlay.setPointerCapture(e.pointerId);
    const mv = (ev) => { st.view.cx = cx - (ev.clientX - sx) * dpr * st.view.s; st.view.cy = cy + (ev.clientY - sy) * dpr * st.view.s; render(); };
    const up = () => { overlay.removeEventListener("pointermove", mv); overlay.removeEventListener("pointerup", up); };
    overlay.addEventListener("pointermove", mv); overlay.addEventListener("pointerup", up);
  });
  overlay.addEventListener("dblclick", () => { fitView(); render(); });
  overlay.addEventListener("pointermove", (e) => { st.mouse = toCell(e); updateProbe(); });
  overlay.addEventListener("pointerleave", () => { st.mouse = null; probe.textContent = ""; });
  const ro = new ResizeObserver(() => { if (st.view) render(); });
  ro.observe(stage);

  // ---------------- drawing
  const modeIdx = () => ({ speed: 0, vort: 1, cp: 2 })[P.mode];
  function render() {
    if (!st.sim || !st.view) { const c = overlay.getContext("2d"); c.clearRect(0, 0, overlay.width, overlay.height); return; }
    canvasSize();
    const vr = viewRect();
    st.sim.draw(vr, modeIdx(), P.range, ctx.isDark && ctx.isDark());
    const g = overlay.getContext("2d");
    g.clearRect(0, 0, overlay.width, overlay.height);
    const X = (x) => (x - vr[0]) / st.view.s, Y = (y) => (vr[3] - y) / st.view.s;
    if (P.stream && st.lines) {
      g.strokeStyle = P.mode === "speed" ? "rgba(255,255,255,0.75)" : "rgba(20,20,20,0.55)";
      g.lineWidth = Math.max(1, overlay.width / 900);
      g.beginPath();
      for (const L of st.lines) { g.moveTo(X(L[0]), Y(L[1])); for (let k = 2; k < L.length; k += 2) g.lineTo(X(L[k]), Y(L[k + 1])); }
      g.stroke();
    }
    // flow arrow
    g.fillStyle = g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 2; g.font = `${Math.round(overlay.width / 70)}px sans-serif`;
    const ay = overlay.height - 18, ax = 16;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + 50, ay); g.stroke();
    g.beginPath(); g.moveTo(ax + 56, ay); g.lineTo(ax + 46, ay - 5); g.lineTo(ax + 46, ay + 5); g.fill();
    g.fillText(`${sig(P.speed, 3)} m/s${P.alpha ? `  ·  α ${sig(P.alpha, 3)}°` : ""}`, ax + 64, ay + 5);
    updateOutputs();
  }
  function drawLegend() {
    const cs = st.cs;
    if (!cs) { legend.innerHTML = ""; return; }
    const r = P.range;
    let lo, hi, unit, grad;
    if (P.mode === "speed") { lo = 0; hi = P.speed * r; unit = "m/s"; grad = "linear-gradient(to top, rgb(13,48,217), rgb(0,184,242), rgb(38,217,64), rgb(255,217,13), rgb(230,20,13))"; }
    else if (P.mode === "vort") { const w = (cs.U * 0.08 * r) / cs.dt; lo = -w; hi = w; unit = "1/s"; grad = "linear-gradient(to top, rgb(26,77,217), rgb(247,247,247), rgb(217,31,20))"; }
    else { lo = -r; hi = r; unit = "Cp"; grad = "linear-gradient(to top, rgb(26,77,217), rgb(247,247,247), rgb(217,31,20))"; }
    legend.innerHTML = "";
    legend.append(h("div", { class: "f2-lt" }, `${sig(hi, 3)} ${unit}`), h("div", { class: "f2-lbar", style: `background:${grad}` }), h("div", { class: "f2-lt" }, `${sig(lo, 3)}`));
  }
  function updateOutputs() {
    const s = st.sim;
    if (!s) { out.innerHTML = ""; return; }
    const m = s.mean(3), last = s.history[s.history.length - 1];
    const c = m || (last ? { cd: last.cd, cl: last.cl } : null);
    const f = c ? s.physical(c) : null;
    const settling = !m;
    out.innerHTML = `<table class="cfd-res">
      <tr><td>C<sub>L</sub></td><td>${c ? sig(c.cl, 3) : "–"}</td><td>Lift</td><td>${f ? sig(f.lift, 3) + " N/m" : "–"}</td></tr>
      <tr><td>C<sub>D</sub></td><td>${c ? sig(c.cd, 3) : "–"}</td><td>Drag</td><td>${f ? sig(f.drag, 3) + " N/m" : "–"}</td></tr>
      <tr><td>L/D</td><td>${c && Math.abs(c.cd) > 1e-6 ? sig(c.cl / c.cd, 3) : "–"}</td><td>Passes</td><td>${sig(s.passes, 3)}${settling ? " · settling" : m.clAmp > 0.02 ? ` · C<sub>L</sub> ±${sig(m.clAmp, 2)}` : ""}</td></tr></table>` +
      (s.cs.panel && isFinite(s.cs.panel.cl) ? `<div class="f2-panel" title="Hess-Smith panel method: inviscid, attached flow. What a clean section gives at high Reynolds number, before stall."><span>Inviscid C<sub>L</sub> (panel method)</span><b>${sig(s.cs.panel.cl, 3)}</b><span class="cfd-muted">${sig(s.physical({ cl: s.cs.panel.cl, cd: 0 }).lift, 3)} N/m</span></div>` : "");
    drawPlot();
  }
  function drawPlot() {
    const s = st.sim, g = plot.getContext("2d"), W = plot.width, H = plot.height;
    g.clearRect(0, 0, W, H);
    const hist = s.history.filter((p) => p.t > s.ramp);
    if (hist.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (const p of hist) { lo = Math.min(lo, p.cd, p.cl); hi = Math.max(hi, p.cd, p.cl); }
    lo = Math.min(lo, 0); hi = Math.max(hi, 0.05);
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
    const X = (t) => 4 + ((t - t0) / (t1 - t0 || 1)) * (W - 8), Y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
    g.strokeStyle = "rgba(128,128,128,0.4)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke();
    for (const [k, col] of [["cl", "#1c8ad1"], ["cd", "#e8742a"]]) {
      g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath();
      hist.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p[k])) : g.moveTo(X(p.t), Y(p[k]))));
      g.stroke();
    }
    g.font = "10px sans-serif"; g.fillStyle = "#1c8ad1"; g.fillText("CL", 6, 11); g.fillStyle = "#e8742a"; g.fillText("CD", 24, 11);
  }
  function updateProbe() {
    if (!st.mouse || !st.cs || !st.sim) { probe.textContent = ""; return; }
    const cs = st.cs, [x, y] = st.mouse, i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= cs.nx || j >= cs.ny) { probe.textContent = ""; return; }
    if (cs.solid[j * cs.nx + i]) { probe.textContent = "solid"; return; }
    if (!st.fields || !st.running) st.fields = st.sim.fields(st.fields);
    const k = j * cs.nx + i, F = st.fields;
    const sp = (Math.hypot(F.ux[k], F.uy[k]) / cs.U) * P.speed, cp = (F.rho[k] - 1) / 3 / (0.5 * cs.U * cs.U);
    probe.textContent = `|v| ${sig(sp, 3)} m/s · Cp ${sig(cp, 3)}`;
  }

  function close() {
    if (st.closed) return;
    st.closed = true;
    st.running = false;
    if (st.raf) cancelAnimationFrame(st.raf);
    ro.disconnect();
    if (st.sim) st.sim.dispose();
    st.sim?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    el.remove();
    if (current === api) current = null;
    log("flow2d close", {});
  }
  const api = { el, close, state: st, prefs: P, rebuild, setRunning, step: (n) => { st.sim && st.sim.step(n, { sampleEvery: 10 }); render(); return st.sim && st.sim.mean(3); } };
  current = api;
  requestAnimationFrame(() => rebuild());
  return api;
}

// ---------------- helpers
function solidBox(cs) {
  let x0 = cs.nx, x1 = 0, y0 = cs.ny, y1 = 0;
  for (let j = 0; j < cs.ny; j++) for (let i = 0; i < cs.nx; i++) if (cs.solid[j * cs.nx + i]) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
  return { x0, x1: x1 + 1, y0, y1: y1 + 1 };
}
/** Streamlines seeded across the inlet, RK2 in cell space; returns flat [x, y, x, y, ...] arrays. */
function streamlines(F, cs) {
  const { nx, ny, solid } = cs, lines = [];
  const b = solidBox(cs), L = cs.refCells;
  const ya = Math.max(1, b.y0 - 1.2 * L), yb = Math.min(ny - 2, b.y1 + 1.2 * L), n = 34;
  const vel = (x, y, o) => {
    const i = Math.floor(x - 0.5), j = Math.floor(y - 0.5);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return false;
    const fx = x - 0.5 - i, fy = y - 0.5 - j, k = j * nx + i;
    if (solid[k] && solid[k + 1] && solid[k + nx] && solid[k + nx + 1]) return false;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    o[0] = F.ux[k] * w00 + F.ux[k + 1] * w10 + F.ux[k + nx] * w01 + F.ux[k + nx + 1] * w11;
    o[1] = F.uy[k] * w00 + F.uy[k + 1] * w10 + F.uy[k + nx] * w01 + F.uy[k + nx + 1] * w11;
    return true;
  };
  const v = [0, 0], v2 = [0, 0], x0 = Math.max(2, b.x0 - 1.2 * L);
  for (let s = 0; s < n; s++) {
    let x = x0, y = ya + ((yb - ya) * (s + 0.5)) / n;
    const pts = [x, y];
    for (let k = 0; k < 4000; k++) {
      if (!vel(x, y, v)) break;
      const sp = Math.hypot(v[0], v[1]);
      if (sp < 1e-6) break;
      const ds = 0.9 / sp;
      if (!vel(x + 0.5 * v[0] * ds, y + 0.5 * v[1] * ds, v2)) break;
      const sp2 = Math.hypot(v2[0], v2[1]) || sp;
      x += (v2[0] / sp2) * 0.9; y += (v2[1] / sp2) * 0.9;
      if (k % 2 === 0) pts.push(x, y);
    }
    if (pts.length > 4) lines.push(pts);
  }
  return lines;
}
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
