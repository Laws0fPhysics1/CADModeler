// SHAPE OPTIMIZATION (generative design, first version) dialog. Pick a body, the faces that
// hold it, the faces that carry loads (and any faces to keep), a safety factor or a target
// mass; Optimize voxelises the body and runs topo.js in a worker. The design "shaves away"
// live in the viewport over a ghost of the original. Create Body adds the result to the
// timeline as an imported mesh body.
import * as THREE from "three";
import "./cfdstudy.css";
import "./fea.css";
import "./topo.css";
import * as L from "./fealink.js";
import { voxelize, markTriangles, voxelSizeFor, RESOLUTIONS } from "./topo.js";

let current = null;
export function currentTopo() { return current; }
export function closeTopo() { if (current) current.close(); }

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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const safe = (fn) => { try { return fn(); } catch { return null; } };
const FIX_COLOR = 0x2f7fd8, LOAD_COLOR = 0xe8742a, KEEP_COLOR = 0x3fa34d, DESIGN_COLOR = 0xd9822b;
const DIR_LABEL = { normal: "Normal to face", "+X": "+X", "-X": "−X", "+Y": "+Y", "-Y": "−Y", "+Z": "+Z", "-Z": "−Z" };
const PREFS = { mode: "sf", sf: 2, mass: 30, resolution: "medium" };

/**
 * ctx: { host, vp, getBodies(), faceInfo(body, idx), getAppearance(id), getMaterial(id), bodyInfo(shape), picker,
 *        selectedBodyId, toast, logEvent, icons, setModelVisible(v), addBody({ stl, name, hideBodyId }) }
 */
export function openTopo(ctx) {
  if (current) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
  const toast = ctx.toast || (() => {});
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const bodies = (ctx.getBodies() || []).filter((b) => b.visible !== false);
  const P = (openTopo.prefs = { ...PREFS, ...(openTopo.prefs || {}) });
  const st = {
    bodyId: bodies.some((b) => b.id === ctx.selectedBodyId) ? ctx.selectedBodyId : bodies[0] && bodies[0].id,
    fixtures: [], keep: [], loads: [{ faces: [], magnitude: 1000, direction: "normal", flip: false }],
    active: { kind: "fix" }, running: false, worker: null, info: null, setup: null, closed: false, done: false,
  };
  const icon = (n) => (ctx.icons && ctx.icons[n]) || "";

  const glyphs = new THREE.Group(); glyphs.name = "topo-setup";
  const design = new THREE.Group(); design.name = "topo-design";
  ctx.vp.groups.results.add(glyphs, design);

  // ---------------- controls
  const row = (label, ctl, cls) => h("div", { class: "dlg-row" + (cls ? " " + cls : "") }, h("label", {}, label), h("div", { class: "ctl" }, ctl));
  const select = (opts, value, on) => { const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l))); s.value = value; s.addEventListener("change", () => on(s.value)); return s; };
  const numBox = (value, unit, on) => {
    const inp = h("input", { value: String(value), spellcheck: "false" });
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (isFinite(v)) on(v); });
    inp.addEventListener("keydown", (e) => e.stopPropagation());
    return h("div", { class: "num" }, inp, h("em", {}, unit));
  };
  const bodySel = select(bodies.map((b) => [b.id, b.name || b.id]), st.bodyId || "", (v) => { st.bodyId = v; st.fixtures = []; st.keep = []; st.loads.forEach((l) => (l.faces = [])); activate({ kind: "fix" }); });
  const fixBtn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "fix" }) });
  const keepBtn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "keep" }) });
  const loadsEl = h("div", { class: "fea-loads" });
  const addLoad = h("button", { class: "btn fea-add", onclick: () => { st.loads.push({ faces: [], magnitude: 1000, direction: "normal", flip: false }); activate({ kind: "load", i: st.loads.length - 1 }); } }, "+ Add load");
  const sfRow = row("Safety factor", numBox(P.sf, "", (v) => { P.sf = Math.max(1, v); refreshInfo(); }));
  const massRow = row("Target mass", numBox(P.mass, "%", (v) => { P.mass = Math.min(95, Math.max(5, v)); refreshInfo(); }));
  const modeSel = select([["sf", "Lightest part meeting the safety factor"], ["mass", "Stiffest part at a target mass"]], P.mode, (v) => { P.mode = v; render(); });
  const resSel = select(Object.entries(RESOLUTIONS).map(([k, n]) => [k, `${k[0].toUpperCase()}${k.slice(1)} · ~${n / 1000}k voxels`]), P.resolution, (v) => { P.resolution = v; refreshInfo(); });
  const info = h("div", { class: "dlg-info cfd-info" });
  const prog = h("div", { class: "cfd-status topo-prog hidden" });
  const err = h("div", { class: "dlg-err" });
  const body = h("div", { class: "dlg-body" },
    h("div", { class: "cfd-sec" }, "Design space"), row("Body", bodySel),
    h("div", { class: "cfd-sec" }, "Constraints"), row("Fixed", fixBtn),
    h("div", { class: "cfd-sec" }, "Loads"), loadsEl, addLoad,
    h("div", { class: "cfd-sec" }, "Preserve"), row("Keep faces", keepBtn), h("div", { class: "cfd-muted fea-hint" }, "Fixed and loaded faces are always kept; add bolt holes or mating faces here."),
    h("div", { class: "cfd-sec" }, "Objective"), row("Goal", modeSel), sfRow, massRow, row("Resolution", resSel),
    info, err, prog);
  const btnRun = h("button", { class: "btn primary", onclick: () => (st.running ? stop() : run()) }, "Optimize");
  const btnBody = h("button", { class: "btn", onclick: () => createBody(), disabled: true, title: "Add the optimized shape to the timeline as a new body" }, "Create Body");
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic fea-ic", html: icon("topo") }), h("span", {}, "Shape Optimization"),
    h("button", { class: "x", title: "Close", html: icon("close"), onclick: () => close() }));
  const foot = h("div", { class: "dlg-foot cfd-foot" }, btnRun, btnBody, h("div", { class: "sp" }), h("button", { class: "btn", onclick: () => close() }, "Close"));
  const el = h("div", { class: "panel cfd-dlg fea-dlg topo-dlg" }, head, body, foot);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  ctx.host.append(el);
  makeDraggable(el, head);

  const api = { el, close, state: st, prefs: P, run, stop, createBody, activate, render };
  current = api;
  if (!bodies.length) err.textContent = "No visible bodies";
  activate(st.active);
  log("topo.open", { bodies: bodies.length });
  return api;

  // ---------------- picking
  function listFor(a) { return a.kind === "fix" ? st.fixtures : a.kind === "keep" ? st.keep : a.kind === "load" && st.loads[a.i] ? st.loads[a.i].faces : null; }
  function activate(a) {
    st.active = a;
    if (!ctx.picker || !a || st.running) { render(); return; }
    ctx.picker.start({
      kinds: ["face"],
      prompt: a.kind === "fix" ? "Select faces to fix" : a.kind === "keep" ? "Select faces to keep" : "Select faces to load",
      filter: (it) => it.kind === "face" && it.body === st.bodyId,
      onPick: (it) => {
        const list = listFor(st.active);
        if (!list) return;
        const i = list.findIndex((x) => x.idx === it.idx);
        if (i >= 0) list.splice(i, 1); else list.push({ body: it.body, idx: it.idx });
        render();
      },
      onEnd: () => { if (!st.closed) { st.active = null; render(); } },
    });
    render();
  }
  function selLabel(btn, n, isActive, onClear) {
    btn.className = `sel-btn${isActive ? " active" : ""}${n ? " filled" : ""}`;
    btn.innerHTML = "";
    btn.append(h("i", { class: "arrow", html: icon("select") }), h("span", { class: "cnt" }, n ? `${n} face${n > 1 ? "s" : ""}` : "Select"));
    if (n) btn.append(h("i", { class: "clr", html: icon("close"), title: "Clear", onclick: (e) => { e.stopPropagation(); onClear(); } }));
  }

  // ---------------- render
  function render() {
    if (st.closed) return;
    const act = st.active;
    selLabel(fixBtn, st.fixtures.length, act && act.kind === "fix", () => { st.fixtures = []; activate({ kind: "fix" }); });
    selLabel(keepBtn, st.keep.length, act && act.kind === "keep", () => { st.keep = []; activate({ kind: "keep" }); });
    loadsEl.innerHTML = "";
    st.loads.forEach((ld, i) => {
      const btn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "load", i }) });
      selLabel(btn, ld.faces.length, act && act.kind === "load" && act.i === i, () => { ld.faces = []; activate({ kind: "load", i }); });
      const rm = st.loads.length > 1 ? h("button", { class: "x fea-rm", title: "Remove this load", html: icon("close"), onclick: () => { st.loads.splice(i, 1); activate({ kind: "fix" }); } }) : null;
      const dirSel = select(L.FORCE_DIRECTIONS.map((d) => [d, DIR_LABEL[d]]), ld.direction, (v) => { ld.direction = v; drawGlyphs(); });
      const flip = h("input", { type: "checkbox" }); flip.checked = ld.flip; flip.addEventListener("change", () => { ld.flip = flip.checked; drawGlyphs(); });
      loadsEl.append(h("div", { class: "fea-load" + (act && act.kind === "load" && act.i === i ? " on" : "") },
        h("div", { class: "fea-load-head" }, h("span", {}, `Force ${i + 1}`), rm),
        row("Faces", btn), row("Magnitude", numBox(ld.magnitude, "N", (v) => { ld.magnitude = v; drawGlyphs(); })),
        row("Direction", h("div", { class: "fea-dir" }, dirSel, h("label", { class: "cfd-check" }, flip, h("span", {}, "Flip"))))));
    });
    sfRow.classList.toggle("hidden", P.mode !== "sf");
    massRow.classList.toggle("hidden", P.mode !== "mass");
    for (const c of body.querySelectorAll("input, select, button")) c.disabled = st.running;
    btnRun.textContent = st.running ? "Stop" : st.done ? "Optimize again" : "Optimize";
    btnBody.disabled = st.running || !st.done;
    refreshInfo();
    drawGlyphs();
  }
  function material() {
    const ap = safe(() => ctx.getAppearance(st.bodyId));
    return safe(() => ctx.getMaterial((ap && ap.materialId) || "generic")) || safe(() => ctx.getMaterial("generic"));
  }
  function bodyOf() { return bodies.find((b) => b.id === st.bodyId); }
  function refreshInfo() {
    const b = bodyOf();
    if (!b) { info.innerHTML = "Pick a body."; return; }
    const m = material(), p = (m && m.physical) || {};
    const vinfo = safe(() => ctx.bodyInfo(b.shape));
    const mass = vinfo && p.density_kg_m3 ? p.density_kg_m3 * vinfo.volume * 1e-9 : null;
    const ys = p.yield_strength_Pa || p.ultimate_strength_Pa;
    const hvox = vinfo ? voxelSizeFor(vinfo.volume, RESOLUTIONS[P.resolution]) : null;
    info.innerHTML =
      `<b>Material</b> ${esc(m ? m.name : "Generic steel")} <span class="cfd-muted">· E ${sig((p.youngs_modulus_Pa || 0) / 1e9)} GPa · yield ${ys ? sig(ys / 1e6) + " MPa" : "n/a"}</span>` +
      (mass ? `<br><b>Mass</b> ${sig(mass, 4)} kg${P.mode === "sf" && ys ? ` · stress limit <b>${sig(ys / 1e6 / P.sf)} MPa</b>` : P.mode === "mass" ? ` → about <b>${sig((mass * P.mass) / 100, 3)} kg</b>` : ""}` : "") +
      (hvox ? `<br><span class="cfd-muted">Voxel ${sig(hvox, 3)} mm</span>` : "") +
      (st.active && !st.running ? `<br><span class="fea-tip">${st.active.kind === "fix" ? "Click the faces that hold the part." : st.active.kind === "keep" ? "Click faces that must stay." : `Click the faces force ${st.active.i + 1} acts on.`}</span>` : "");
  }

  // ---------------- glyphs
  function clearGroup(g) { for (const o of [...g.children]) { g.remove(o); o.traverse((x) => { if (x.geometry && !x.userData.shared) x.geometry.dispose(); if (x.material) x.material.dispose(); }); } }
  function bodyView() { return ctx.vp.bodyViews.find((x) => x.id === st.bodyId); }
  function follow(g) {
    const bv = bodyView();
    g.matrixAutoUpdate = false;
    if (bv && bv.grp) g.matrix.copy(bv.grp.matrix); else g.matrix.identity();
    g.matrixWorldNeedsUpdate = true;
  }
  function facePatch(it, color) {
    const bv = bodyView(), g = bv && bv.faceGroups[it.idx];
    if (!g) return null;
    const tri = bv.mesh_.faces.triangles, idx = [];
    for (let i = g.start; i < g.start + g.count; i++) idx.push(tri[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", bv.mesh.geometry.getAttribute("position"));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.renderOrder = 4;
    return mesh;
  }
  function loadVector(ld) {
    const faces = ld.faces.map((it) => { const fi = safe(() => ctx.faceInfo(it.body, it.idx)); return fi ? { n: fi.normal, area_mm2: fi.area } : null; }).filter(Boolean);
    return L.forceVector({ magnitude: ld.magnitude, direction: ld.direction, flip: ld.flip, faces });
  }
  function drawGlyphs() {
    clearGroup(glyphs);
    follow(glyphs);
    for (const it of st.fixtures) { const m = facePatch(it, FIX_COLOR); if (m) glyphs.add(m); }
    for (const it of st.keep) { const m = facePatch(it, KEEP_COLOR); if (m) glyphs.add(m); }
    const size = Math.max(ctx.vp.modelSize || 100, 1) * 0.14;
    for (const ld of st.loads) {
      for (const it of ld.faces) {
        const m = facePatch(it, LOAD_COLOR); if (m) glyphs.add(m);
        const fi = safe(() => ctx.faceInfo(it.body, it.idx));
        const v = safe(() => loadVector(ld));
        if (fi && v && Math.hypot(...v) > 0) {
          const d = new THREE.Vector3(...v).normalize();
          const a = new THREE.ArrowHelper(d, new THREE.Vector3(...fi.center).addScaledVector(d, -size), size, LOAD_COLOR, size * 0.28, size * 0.14);
          a.traverse((x) => { if (x.material) { x.material.depthTest = false; x.material.transparent = true; } x.renderOrder = 7; });
          glyphs.add(a);
        }
      }
    }
    ctx.vp.requestRender();
  }

  // ---------------- run
  function buildSetup() {
    const b = bodyOf();
    if (!b) throw new Error("Pick a body");
    if (!st.fixtures.length) throw new Error("Select the faces that hold the part (Fixed)");
    const loads = st.loads.filter((l) => l.faces.length);
    if (!loads.length) throw new Error("Select the faces a force acts on");
    const bv = bodyView();
    if (!bv) throw new Error("The body isn't displayed");
    const mesh = { vertices: bv.mesh_.faces.vertices, triangles: bv.mesh_.faces.triangles };
    const groups = (list) => list.map((it) => { const g = bv.faceGroups[it.idx]; return [g.start, g.count]; });
    const vinfo = ctx.bodyInfo(b.shape);
    const hvox = voxelSizeFor(vinfo.volume, RESOLUTIONS[P.resolution]);
    const vox = voxelize(mesh, hvox);
    const fixed = markTriangles(mesh, groups(st.fixtures), vox);
    const loadList = loads.map((l) => ({ mark: markTriangles(mesh, groups(l.faces), vox), force: loadVector(l) }));
    // keep faces: their voxels plus one layer inward
    const keep0 = markTriangles(mesh, groups(st.keep), vox);
    const preserve = grow(keep0, vox, 1);
    for (const l of loadList) { const g = grow(l.mark, vox, 1); for (let k = 0; k < g.length; k++) if (g[k]) preserve[k] = 1; }
    { const g = grow(fixed, vox, 1); for (let k = 0; k < g.length; k++) if (g[k]) preserve[k] = 1; }
    const m = material(), p = (m && m.physical) || {};
    const E = (p.youngs_modulus_Pa || 200e9) / 1e6, ys = (p.yield_strength_Pa || p.ultimate_strength_Pa || 250e6) / 1e6;
    return {
      setup: { vox, fixed, loads: loadList, preserve, E, nu: p.poissons_ratio ?? 0.3, yield: ys },
      meta: { bodyId: b.id, bodyName: b.name || b.id, volume: vinfo.volume, density: p.density_kg_m3 || 7850, material: m ? m.name : "Generic", h: hvox, ys },
    };
  }
  function run() {
    err.textContent = "";
    let built;
    try { built = buildSetup(); } catch (e) { err.textContent = e.message; return; }
    ctx.picker && ctx.picker.stop();
    st.active = null; st.running = true; st.done = false; st.info = null; st.meta = built.meta; st.t0 = performance.now();
    prog.classList.remove("hidden");
    prog.innerHTML = "Setting up…";
    ctx.setModelVisible(false);
    drawGhost();
    const w = (st.worker = new Worker(new URL("./topo.worker.js", import.meta.url), { type: "module" }));
    w.onmessage = (e) => onWorker(e.data);
    w.onerror = (e) => { finish(); err.textContent = "Optimizer failed: " + (e.message || "worker error"); };
    const opts = { mode: P.mode, sf: P.sf, targetMass: P.mass / 100, maxIter: 140 };
    w.postMessage({ cmd: "run", setup: built.setup, opts });
    log("topo.run", { body: built.meta.bodyName, mode: P.mode, sf: P.sf, mass: P.mass, res: P.resolution, h: built.meta.h, vox: [built.setup.vox.nx, built.setup.vox.ny, built.setup.vox.nz] });
    render();
  }
  function onWorker(m) {
    if (st.closed) return;
    if (m.type === "ready") { st.ne = m.ne; prog.innerHTML = `${m.ne.toLocaleString()} voxels · ${m.ndof.toLocaleString()} equations · first solve…`; }
    else if (m.type === "iter") { st.info = m.info; showDesign(m.positions, m.indices); showProgress(); }
    else if (m.type === "done") { if (m.info) st.info = m.info; finish(); showProgress(true, m.stopped); log("topo.done", { ...summary(), stopped: !!m.stopped }); }
    else if (m.type === "stl") { st.stlResolve && st.stlResolve(m); st.stlResolve = null; }
    else if (m.type === "error") { err.textContent = m.message; if (st.stlResolve) { st.stlResolve(null); st.stlResolve = null; } if (st.running) { finish(); } }
  }
  function stop() { if (st.worker && st.running) { st.worker.postMessage({ cmd: "stop" }); prog.append(h("div", { class: "cfd-muted" }, "Stopping after this iteration…")); } }
  function finish() { st.running = false; st.done = !!st.info; render(); }
  function summary() {
    const i = st.info, M = st.meta;
    if (!i || !M) return {};
    const mass0 = (M.density * M.volume) * 1e-9;
    return { volume: i.volume, mass_kg: mass0 * i.volume, mass0_kg: mass0, stress_MPa: i.stress, sf: i.sf, iterations: i.it };
  }
  function showProgress(final, stopped) {
    const i = st.info, M = st.meta;
    if (!i) return;
    const s = summary(), secs = (performance.now() - st.t0) / 1000;
    const sfOk = i.sf >= (P.mode === "sf" ? P.sf : 1);
    prog.innerHTML =
      `<div class="cfd-prog-head"><b>${final ? (stopped ? "Stopped" : "Done") : i.phase === "shaving" ? "Shaving away material…" : "Settling the design…"}</b><span class="cfd-muted">iteration ${i.it} · ${Math.round(secs)} s</span></div>` +
      `<div class="cfd-bar"><i style="width:${Math.round((1 - i.volume) * 100)}%"></i></div>` +
      `<table class="cfd-res"><tr><td>Mass</td><td>${sig(s.mass_kg, 3)} kg</td><td>Kept</td><td>${Math.round(i.volume * 100)} %</td></tr>` +
      `<tr><td>Stress</td><td>${sig(i.stress, 3)} MPa</td><td>Safety factor</td><td class="${sfOk ? "cfd-ok" : "cfd-bad"}">${sig(i.sf, 3)}</td></tr></table>` +
      `<div class="cfd-muted">Stress is the 99th percentile von Mises in the kept material (${esc(M.material)}, yield ${sig(M.ys, 3)} MPa); voxel ${sig(M.h, 3)} mm. ` +
      `${final ? "Check the final part with Static Stress before trusting it." : ""}</div>`;
  }
  function drawGhost() {
    clearGroup(design);
    follow(design);
    const bv = bodyView();
    if (!bv) return;
    const geo = bv.mesh.geometry;
    const ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x8aa1b8, transparent: true, opacity: 0.12, depthWrite: false }));
    ghost.userData.shared = true; ghost.renderOrder = 2; ghost.name = "ghost";
    const edges = new THREE.LineSegments(bv.lines.geometry, new THREE.LineBasicMaterial({ color: 0x8aa1b8, transparent: true, opacity: 0.45 }));
    edges.userData.shared = true;
    design.add(ghost, edges);
    ctx.vp.requestRender();
  }
  function showDesign(positions, indices) {
    let m = design.getObjectByName("shape");
    if (!m) {
      m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: DESIGN_COLOR, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide }));
      m.name = "shape"; m.renderOrder = 3;
      design.add(m);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    m.geometry.dispose(); m.geometry = g;
    ctx.vp.requestRender();
  }
  function requestSTL() {
    return new Promise((resolve) => { st.stlResolve = resolve; st.worker.postMessage({ cmd: "stl", iso: 0.5, smooth: 3 }); });
  }
  async function createBody() {
    if (!st.worker || !st.done) return;
    btnBody.disabled = true;
    const r = await requestSTL();
    if (!r) { btnBody.disabled = false; return; }
    const name = `${st.meta.bodyName} (optimized)`;
    log("topo.createBody", { triangles: r.triangles });
    toast(`Building a body from ${r.triangles.toLocaleString()} triangles…`);
    await new Promise((res) => setTimeout(res, 40));
    const ok = ctx.addBody({ stl: r.bytes, name, hideBodyId: st.meta.bodyId });
    if (ok) close();
    else btnBody.disabled = false;
  }
  function close() {
    if (st.closed) return;
    st.closed = true;
    ctx.picker && ctx.picker.stop();
    if (st.worker) st.worker.terminate();
    clearGroup(glyphs); clearGroup(design);
    ctx.vp.groups.results.remove(glyphs, design);
    ctx.setModelVisible(true);
    ctx.vp.requestRender();
    el.remove();
    if (current === api) current = null;
    log("topo.close", {});
  }
}

/** Mark elements within `layers` voxels of a marked one (inside the solid). */
function grow(mark, vox, layers) {
  const { nx, ny, nz, solid } = vox;
  let cur = Uint8Array.from(mark);
  for (let l = 0; l < layers; l++) {
    const next = Uint8Array.from(cur);
    for (let e = 0; e < cur.length; e++) {
      if (!cur[e]) continue;
      const i = e % nx, j = ((e - i) / nx) % ny, k = (e - i - nx * j) / (nx * ny);
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const ii = i + di, jj = j + dj, kk = k + dk;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const q = ii + nx * (jj + ny * kk);
        if (solid[q]) next[q] = 1;
      }
    }
    cur = next;
  }
  return cur;
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

/** Console hooks (window.__topo). */
export function topoDebugApi() {
  return { current: () => current, close: closeTopo, selfTest };
}
/** Run a tiny optimisation in the worker (used by the Electron smoke test): resolves "ok" or an error message. */
function selfTest() {
  return new Promise((resolve) => {
    const n = 6, solid = new Uint8Array(n * 2 * 2).fill(1), fixed = new Uint8Array(solid.length), load = new Uint8Array(solid.length);
    for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) { fixed[0 + n * (j + 2 * k)] = 1; load[n - 1 + n * (j + 2 * k)] = 1; }
    const vox = { nx: n, ny: 2, nz: 2, h: 1, origin: [0, 0, 0], solid };
    const w = new Worker(new URL("./topo.worker.js", import.meta.url), { type: "module" });
    const done = (r) => { w.terminate(); clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => done("timeout"), 20000);
    w.onerror = (e) => done("worker error: " + (e.message || "load failed"));
    w.onmessage = (e) => { if (e.data.type === "iter") done("ok"); else if (e.data.type === "error") done(e.data.message); };
    w.postMessage({ cmd: "run", setup: { vox, fixed, loads: [{ mark: load, force: [0, 0, -10] }], preserve: new Uint8Array(solid.length), E: 1000, nu: 0.3, yield: 100 }, opts: { mode: "mass", targetMass: 0.6, maxIter: 3 } });
  });
}
