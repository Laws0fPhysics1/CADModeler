// STATIC STRESS study dialog (Fusion-style): pick a body, select fixed faces and load faces
// in the viewport, set force (magnitude + direction along the face normal or an axis) or
// pressure loads, gravity and mesh quality, then Solve. Solve writes a cadmodeler-fea-case
// folder (fealink.js) to the FEA exchange folder and runs FEA Sim headless
// (platform.fea.run); results are shown in the viewport by fearesults.js.
// Case format: docs/fea-exchange.md.
import * as THREE from "three";
import "./cfdstudy.css";
import "./fea.css";
import * as platform from "./platform.js";
import * as L from "./fealink.js";

let current = null; // the open dialog (one at a time)

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
const safe = (fn) => { try { return fn(); } catch { return null; } };
/** bodyInfo().bounds is replicad's [[min], [max]]; accept {min, max} too. */
const boundsOf = (info) => {
  const b = info && info.bounds;
  if (!b) return null;
  if (Array.isArray(b) && b.length === 2) return { min: [...b[0]], max: [...b[1]] };
  return b.min && b.max ? { min: [...b.min], max: [...b.max] } : null;
};

const FIX_COLOR = 0x2f7fd8, LOAD_COLOR = 0xe8742a, PIN_COLOR = 0x1fa89a;
const DIR_LABEL = { normal: "Normal to face", "+X": "+X", "-X": "−X", "+Y": "+Y", "-Y": "−Y", "+Z": "+Z", "-Z": "−Z" };
const PRESSURE_UNITS = { Pa: 1, kPa: 1e3, MPa: 1e6 };

// ------------------------------------------------------------------ study → case (shared with window.__fea)
/**
 * Build the case for a study spec, write it and (optionally) start the solver.
 * spec: { bodyId, fixtures: [{body, idx}], loads: [{type, faces:[{body, idx}], magnitude, direction, flip}],
 *         gravity: {enabled, direction}, quality }
 * Returns { casePath, folderName, caseData }.
 */
export async function submitStudy(ctx, spec, { solve = true } = {}) {
  const body = (ctx.getBodies() || []).find((b) => b.id === spec.bodyId);
  if (!body) throw new Error("Pick a body to analyse");
  const pins = (spec.pins || []).filter((p) => p.faces && p.faces.length);
  if (!(spec.fixtures || []).length && !pins.length) throw new Error("Select at least one fixed face or pin support (Constraints)");
  for (const p of pins) if (!(p.radial || p.axial || p.tangential)) throw new Error("A pin support must hold at least one direction (radial, axial or tangential)");
  const loads = (spec.loads || []).filter((l) => l.faces && l.faces.length);
  if (!loads.length && !(spec.gravity && spec.gravity.enabled)) throw new Error("Add a load (select its faces) or switch on gravity");
  for (const l of loads) if (!(Math.abs(+l.magnitude) > 0)) throw new Error(`${l.type === "pressure" ? "Pressure" : "Force"} magnitude must be non-zero`);
  for (const l of loads) if (l.type === "bearing" && (!l.direction || l.direction === "normal")) throw new Error("A bearing load needs an axis direction (the way the shaft pushes)");
  const ref = (it) => {
    const r = ctx.faceRef(it.body, it.idx);
    const fi = safe(() => ctx.faceInfo(it.body, it.idx));
    return fi ? { ...r, area_mm2: fi.area, type: fi.type } : r;
  };
  const nFaces = ctx.faceCount ? ctx.faceCount(body.id) : 0;
  const allFaces = nFaces && nFaces <= 2000 ? Array.from({ length: nFaces }, (_, i) => safe(() => ref({ body: body.id, idx: i }))).filter(Boolean) : undefined;
  const info = ctx.bodyInfo ? safe(() => ctx.bodyInfo(body.shape)) : null;
  const ap = safe(() => ctx.getAppearance && ctx.getAppearance(body.id));
  const appearances = ap ? { [body.id]: { ...ap, materialId: ap.materialId || "generic" } } : { [body.id]: { materialId: "generic" } };
  const { folderName, files, caseData } = await L.buildCase({
    designName: ctx.designName,
    bodies: [{ id: body.id, name: body.name, volume_mm3: info && info.volume, faces: allFaces,
      bbox: boundsOf(info) || undefined }],
    stepBytes: await ctx.exportSTEP([body]),
    appearances, materials: (id) => ctx.getMaterial(id),
    study: {
      fixtures: [
        ...((spec.fixtures || []).length ? [{ type: "fixed", faces: spec.fixtures.map(ref) }] : []),
        ...pins.map((p) => ({ type: "pin", faces: p.faces.map(ref), radial: !!p.radial, axial: !!p.axial, tangential: !!p.tangential })),
      ],
      loads: loads.map((l) => ({ type: l.type, faces: l.faces.map(ref), magnitude: +l.magnitude, direction: l.direction || "normal", flip: !!l.flip })),
      gravity: spec.gravity || { enabled: false }, mesh: { quality: spec.quality || "medium" },
    },
    appVersion: ctx.appVersion,
  });
  const casePath = await platform.fea.writeCase(folderName, files);
  if (!casePath) return { casePath: null, folderName, caseData };
  if (solve) {
    const r = await platform.fea.run(casePath);
    if (!r || !r.ok) throw new Error("Could not start the FEA solver: " + ((r && r.error) || "unknown error"));
    const settings = {
      bodyId: body.id, quality: spec.quality || "medium", gravity: spec.gravity || { enabled: false },
      fixtures: (caseData.fixtures.find((f) => f.type === "fixed") || { faces: [] }).faces,
      pins: caseData.fixtures.filter((f) => f.type === "pin"), loads: caseData.loads,
      summary: caseData.loads.map((l) => (l.type === "pressure" ? `${fmtSig(l.magnitude_Pa / 1e6)} MPa` : `${fmtSig(l.magnitude_N)} N`)).join(", "),
    };
    ctx.onSolve && ctx.onSolve({ casePath, folderName, settings, bodies: [body.name || body.id], bodyId: body.id });
  }
  return { casePath, folderName, caseData };
}

// ------------------------------------------------------------------ dialog
/**
 * @param {object} ctx
 * @param {string} ctx.designName
 * @param {() => {id,name,shape,visible}[]} ctx.getBodies
 * @param {(bodies) => Blob|Uint8Array} ctx.exportSTEP
 * @param {(bodyId, idx) => {body, idx, pt, n}} ctx.faceRef
 * @param {(bodyId, idx) => {type, area, center, normal}} ctx.faceInfo
 * @param {(bodyId) => number} ctx.faceCount
 * @param {(ref) => {body, idx}|null} [ctx.resolveFace]  re-find stored references (Edit Study)
 * @param {(id) => object|null} ctx.getAppearance
 * @param {(id) => object} ctx.getMaterial
 * @param {(shape) => {volume, bounds}} [ctx.bodyInfo]
 * @param {{ start: (opts) => void, stop: () => void }} ctx.picker   viewport face picking (main.js "extpick")
 * @param {object} ctx.vp            the Viewport (setup glyphs are drawn in vp.groups.results)
 * @param {HTMLElement} ctx.host
 * @param {(msg) => void} ctx.toast
 * @param {(type, data) => void} [ctx.logEvent]
 * @param {(study) => void} [ctx.onSolve]
 * @param {string} [ctx.selectedBodyId]
 * @param {object} [ctx.initial]     settings of a stored study to start from
 */
export function openFeaStudy(ctx) {
  if (current) { current.el.classList.add("cfd-flash"); setTimeout(() => current && current.el.classList.remove("cfd-flash"), 400); return current; }
  const toast = ctx.toast || (() => {});
  const log = (t, d) => { try { ctx.logEvent && ctx.logEvent(t, d); } catch {} };
  const bodies = (ctx.getBodies() || []).filter((b) => b.visible !== false);
  const init = ctx.initial || null;
  const st = {
    bodyId: (init && bodies.some((b) => b.id === init.bodyId) && init.bodyId) || (bodies.some((b) => b.id === ctx.selectedBodyId) ? ctx.selectedBodyId : bodies[0] && bodies[0].id),
    fixtures: [],
    pins: [], // pin supports: { faces, radial, axial, tangential } (a shaft or pin in a hole)
    loads: [{ type: "force", faces: [], magnitude: 100, direction: "normal", flip: false, unit: "MPa" }],
    gravity: false, gdir: "-Z", quality: "medium",
    active: { kind: "fix" }, busy: false, casePath: null,
  };
  if (init) {
    const res = (r) => (ctx.resolveFace ? safe(() => ctx.resolveFace(r)) : null);
    st.fixtures = (init.fixtures || []).map(res).filter(Boolean);
    st.pins = (init.pins || []).map((p) => ({ faces: (p.faces || []).map(res).filter(Boolean), radial: !!p.radial, axial: !!p.axial, tangential: !!p.tangential }));
    st.loads = (init.loads || []).map((l) => ({
      type: l.type, faces: (l.faces || []).map(res).filter(Boolean),
      magnitude: l.type === "pressure" ? l.magnitude_Pa / 1e6 : l.magnitude_N, unit: "MPa",
      direction: l.direction || "normal", flip: !!l.flip,
    }));
    if (!st.loads.length) st.loads.push({ type: "force", faces: [], magnitude: 100, direction: "normal", flip: false, unit: "MPa" });
    st.gravity = !!(init.gravity && init.gravity.enabled); st.gdir = (init.gravity && init.gravity.direction) || "-Z";
    st.quality = init.quality || "medium";
  }

  // setup glyphs (fixture / load faces, force arrows) live in the results group while the dialog is open
  const glyphs = new THREE.Group(); glyphs.name = "fea-setup";
  ctx.vp.groups.results.add(glyphs);

  // ---- controls
  const row = (label, ctl, cls) => h("div", { class: "dlg-row" + (cls ? " " + cls : "") }, h("label", {}, label), h("div", { class: "ctl" }, ctl));
  const select = (opts, value, on) => {
    const s = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l)));
    s.value = value; s.addEventListener("change", () => on(s.value));
    return s;
  };
  const numBox = (value, unit, on) => {
    const inp = h("input", { value: String(value), spellcheck: "false" });
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (isFinite(v)) on(v); });
    inp.addEventListener("keydown", (e) => e.stopPropagation());
    const u = typeof unit === "string" ? h("em", {}, unit) : unit;
    return { box: h("div", { class: "num" }, inp, u), inp };
  };
  const check = (label, value, on) => {
    const c = h("input", { type: "checkbox" }); c.checked = value;
    c.addEventListener("change", () => on(c.checked));
    return { el: h("label", { class: "cfd-check" }, c, h("span", {}, label)), c };
  };

  const bodySel = select(bodies.map((b) => {
    const ap = safe(() => ctx.getAppearance(b.id));
    const m = safe(() => ctx.getMaterial((ap && ap.materialId) || "generic"));
    return [b.id, `${b.name || b.id}${m ? "  ·  " + m.name : ""}`];
  }), st.bodyId || "", (v) => {
    st.bodyId = v; st.fixtures = []; st.pins.forEach((p) => { p.faces = []; }); st.loads.forEach((l) => { l.faces = []; });
    activate({ kind: "fix" }); render();
  });
  const fixBtn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "fix" }) });
  const pinsEl = h("div", { class: "fea-loads" });
  const addPin = h("button", { class: "btn fea-add", title: "A shaft, pin or bolt in a hole: hold the hole round and on its axis without welding it in place",
    onclick: () => { st.pins.push({ faces: [], radial: true, axial: false, tangential: false }); activate({ kind: "pin", i: st.pins.length - 1 }); render(); } }, "+ Add pin support");
  const loadsEl = h("div", { class: "fea-loads" });
  const addLoad = h("button", { class: "btn fea-add", onclick: () => { st.loads.push({ type: "force", faces: [], magnitude: 100, direction: "normal", flip: false, unit: "MPa" }); activate({ kind: "load", i: st.loads.length - 1 }); render(); } }, "+ Add load");
  const gravCk = check("Gravity", st.gravity, (v) => { st.gravity = v; render(); });
  const gdirSel = select(L.AXES.map((a) => [a, DIR_LABEL[a]]), st.gdir, (v) => { st.gdir = v; render(); });
  const gdirRow = row("Direction", gdirSel, "cfd-indent");
  const qualSel = select(L.MESH_QUALITIES.map((q) => [q.id, q.label]), st.quality, (v) => { st.quality = v; });
  const info = h("div", { class: "dlg-info cfd-info" });
  const note = h("div", { class: "cfd-note hidden" }, "Browser mode without the dev server: the case files download instead of solving.");
  const err = h("div", { class: "dlg-err" });
  const status = h("div", { class: "cfd-status hidden" });

  const body = h("div", { class: "dlg-body" },
    h("div", { class: "cfd-sec" }, "Body"), row("Body", bodySel),
    h("div", { class: "cfd-sec" }, "Constraints"), row("Fixed", fixBtn), pinsEl, addPin,
    h("div", { class: "cfd-sec" }, "Loads"), loadsEl, addLoad,
    h("div", { class: "dlg-row" }, gravCk.el), gdirRow,
    h("div", { class: "cfd-sec" }, "Mesh"), row("Quality", qualSel),
    info, note, err, status);
  const btnSolve = h("button", { class: "btn primary", onclick: () => go(true), title: "Mesh, solve and show the stresses in the viewport" }, "Solve");
  const btnExport = h("button", { class: "btn", onclick: () => go(false), title: "Write the case folder only" }, "Export Case");
  btnSolve.disabled = true;
  platform.fea.canRun().then((ok) => { st.canRun = ok; btnSolve.disabled = !ok || st.busy; if (!ok) { btnSolve.title = "Needs the desktop app or the dev server"; note.classList.remove("hidden"); } }).catch(() => {});
  const close = () => {
    if (st.closed) return;
    st.closed = true;
    ctx.picker && ctx.picker.stop();
    clearGlyphs(); ctx.vp.groups.results.remove(glyphs); ctx.vp.requestRender();
    el.remove(); current = null;
    log("fea.study.close", {});
  };
  const head = h("div", { class: "dlg-head" }, h("i", { class: "ic fea-ic", html: STRESS_ICON }), h("span", {}, "Static Stress"),
    h("button", { class: "x", title: "Close", html: CLOSE_ICON, onclick: close }));
  const foot = h("div", { class: "dlg-foot cfd-foot" }, btnSolve, btnExport, h("div", { class: "sp" }), h("button", { class: "btn", onclick: close }, "Cancel"));
  const el = h("div", { class: "panel cfd-dlg fea-dlg" }, head, body, foot);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  (ctx.host || document.body).append(el);
  makeDraggable(el, head);

  current = { el, close, state: st, refresh: () => render() };
  if (!bodies.length) showErr("No visible bodies");
  activate(st.active);
  render();
  log("fea.study.open", { bodies: bodies.length });
  return current;

  // ---------------------------------------------------------------- picking
  function listFor(a) {
    if (a.kind === "fix") return st.fixtures;
    if (a.kind === "pin") return st.pins[a.i] ? st.pins[a.i].faces : null;
    return a.kind === "load" && st.loads[a.i] ? st.loads[a.i].faces : null;
  }
  // pin supports and bearing loads sit on holes / shafts: curved faces only (FEA Sim fits the axis)
  function curved(it) { const fi = safe(() => ctx.faceInfo(it.body, it.idx)); return !fi || fi.type !== "PLANE"; }
  function activate(a) {
    st.active = a;
    if (!ctx.picker || !a) { render(); return; }
    const round = a.kind === "pin" || (a.kind === "load" && st.loads[a.i] && st.loads[a.i].type === "bearing");
    ctx.picker.start({
      kinds: ["face"],
      prompt: a.kind === "fix" ? "Select faces to fix" : round ? "Select the hole's (or shaft's) cylindrical faces" : "Select faces to load",
      filter: (it) => it.kind === "face" && it.body === st.bodyId && (!round || curved(it)),
      onPick: (it) => {
        const list = listFor(st.active);
        if (!list) return;
        const i = list.findIndex((x) => x.body === it.body && x.idx === it.idx);
        if (i >= 0) list.splice(i, 1); else list.push({ body: it.body, idx: it.idx });
        log("fea.study.pick", { field: st.active.kind, idx: it.idx });
        render();
      },
      onEnd: () => { if (!st.closed) { st.active = null; render(); } },
    });
    render();
  }
  function selLabel(btn, n, isActive, onClear) {
    btn.className = `sel-btn${isActive ? " active" : ""}${n ? " filled" : ""}`;
    btn.innerHTML = "";
    btn.append(h("i", { class: "arrow", html: ARROW_ICON }), h("span", { class: "cnt" }, n ? `${n} face${n > 1 ? "s" : ""}` : "Select"));
    if (n) btn.append(h("i", { class: "clr", html: CLOSE_ICON, title: "Clear", onclick: (e) => { e.stopPropagation(); onClear(); } }));
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (st.closed) return;
    const act = st.active;
    selLabel(fixBtn, st.fixtures.length, act && act.kind === "fix", () => { st.fixtures = []; activate({ kind: "fix" }); });
    pinsEl.innerHTML = "";
    st.pins.forEach((pn, i) => {
      const on = act && act.kind === "pin" && act.i === i;
      const btn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "pin", i }) });
      selLabel(btn, pn.faces.length, on, () => { pn.faces = []; activate({ kind: "pin", i }); });
      const rm = h("button", { class: "x fea-rm", title: "Remove this pin support", html: CLOSE_ICON, onclick: () => { st.pins.splice(i, 1); activate({ kind: "fix" }); } });
      const ck = (key, label, tip) => { const c = check(label, pn[key], (v) => { pn[key] = v; refreshInfo(); }); c.el.title = tip; return c.el; };
      pinsEl.append(h("div", { class: "fea-load" + (on ? " on" : "") },
        h("div", { class: "fea-load-head" }, h("span", {}, `Pin support ${i + 1}`), rm),
        row("Faces", btn),
        h("div", { class: "fea-pin-dofs" },
          ck("radial", "Radial", "The hole stays round and on the shaft's axis (it can't collapse or move sideways)"),
          ck("axial", "Axial", "No sliding along the shaft"),
          ck("tangential", "Tangential", "No turning about the shaft (off = free to rotate, like a bearing)")),
      ));
    });
    loadsEl.innerHTML = "";
    st.loads.forEach((ld, i) => {
      const btn = h("button", { class: "sel-btn", onclick: () => activate({ kind: "load", i }) });
      selLabel(btn, ld.faces.length, act && act.kind === "load" && act.i === i, () => { ld.faces = []; activate({ kind: "load", i }); });
      const typeSel = select([["force", "Force"], ["pressure", "Pressure"], ["bearing", "Bearing (shaft in hole)"]], ld.type, (v) => {
        if ((v === "pressure") !== (ld.type === "pressure")) ld.magnitude = v === "pressure" ? 1 : 100;
        ld.type = v;
        if (v === "bearing") {
          if (!ld.direction || ld.direction === "normal") ld.direction = "-Z";
          ld.faces = ld.faces.filter(curved);
        }
        activate({ kind: "load", i }); // re-filter picks (bearing: curved faces only)
      });
      const unitSel = select(Object.keys(PRESSURE_UNITS).map((u) => [u, u]), ld.unit || "MPa", (v) => { ld.unit = v; });
      const isP = ld.type === "pressure";
      const mag = numBox(ld.magnitude, isP ? unitSel : "N", (v) => { ld.magnitude = v; drawGlyphs(); refreshInfo(); });
      const rm = st.loads.length > 1 ? h("button", { class: "x fea-rm", title: "Remove this load", html: CLOSE_ICON, onclick: () => { st.loads.splice(i, 1); activate({ kind: "fix" }); } }) : null;
      const kids = [h("div", { class: "fea-load-head" }, h("span", {}, `Load ${i + 1}`), typeSel, rm), row("Faces", btn), row(isP ? "Pressure" : "Magnitude", mag.box)];
      if (!isP) {
        const dirs = ld.type === "bearing" ? L.AXES : L.FORCE_DIRECTIONS;
        const dirSel = select(dirs.map((d) => [d, DIR_LABEL[d]]), ld.direction, (v) => { ld.direction = v; drawGlyphs(); });
        const flip = check("Flip", ld.flip, (v) => { ld.flip = v; drawGlyphs(); });
        kids.push(row("Direction", h("div", { class: "fea-dir" }, dirSel, flip.el)));
        if (ld.type === "bearing") kids.push(h("div", { class: "cfd-muted fea-hint" }, "The way the shaft pushes on the hole. Only the side it pushes on carries the load, heaviest in the middle."));
      } else kids.push(h("div", { class: "cfd-muted fea-hint" }, "Positive pressure pushes into the faces."));
      loadsEl.append(h("div", { class: "fea-load" + (act && act.kind === "load" && act.i === i ? " on" : "") }, kids));
    });
    gdirRow.classList.toggle("hidden", !st.gravity);
    refreshInfo();
    drawGlyphs();
  }

  function material() {
    const ap = safe(() => ctx.getAppearance(st.bodyId));
    return safe(() => ctx.getMaterial((ap && ap.materialId) || "generic"));
  }
  function refreshInfo() {
    const b = bodies.find((x) => x.id === st.bodyId);
    if (!b) { info.innerHTML = "Pick a body."; return; }
    const m = material(), p = (m && m.physical) || {};
    const vinfo = ctx.bodyInfo ? safe(() => ctx.bodyInfo(b.shape)) : null;
    const mass = vinfo && p.density_kg_m3 ? p.density_kg_m3 * vinfo.volume * 1e-9 : null;
    const ys = p.yield_strength_Pa || p.ultimate_strength_Pa;
    info.innerHTML =
      `<b>Material</b> ${esc(m ? m.name : "Generic steel")}<br>` +
      `<span class="cfd-muted">E ${fmtSig((p.youngs_modulus_Pa || 0) / 1e9)} GPa · ν ${fmtSig(p.poissons_ratio)} · ` +
      `${p.yield_strength_Pa ? "yield" : "ultimate"} ${ys ? fmtSig(ys / 1e6) + " MPa" : "n/a"} · ρ ${fmtSig(p.density_kg_m3, 4)} kg/m³</span>` +
      (mass ? `<br><b>Mass</b> ${fmtSig(mass, 4)} kg` : "") +
      (st.active ? `<br><span class="fea-tip">${st.active.kind === "fix" ? "Click faces to fix them in place."
        : st.active.kind === "pin" ? `Click the hole's faces for pin support ${st.active.i + 1} (the shaft in it).`
        : `Click faces to apply load ${st.active.i + 1}.`}</span>` : "");
  }

  // ---------------------------------------------------------------- glyphs
  function clearGlyphs() {
    for (const o of [...glyphs.children]) { glyphs.remove(o); o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); }); }
  }
  function facePatch(it, color) {
    const bv = ctx.vp.bodyViews.find((b) => b.id === it.body);
    const g = bv && bv.faceGroups[it.idx];
    if (!g) return null;
    const tri = bv.mesh_.faces.triangles, idx = [];
    for (let i = g.start; i < g.start + g.count; i++) idx.push(tri[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", bv.mesh.geometry.getAttribute("position"));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    mesh.renderOrder = 4;
    return mesh;
  }
  function modelSize() { return Math.max(ctx.vp.modelSize || 100, 1); }
  function arrow(pos, dir, color, len, toward = true) {
    const d = new THREE.Vector3(...dir).normalize();
    const p = new THREE.Vector3(...pos);
    const origin = toward ? p.clone().addScaledVector(d, -len) : p;
    const a = new THREE.ArrowHelper(d, origin, len, color, len * 0.28, len * 0.14);
    a.traverse((x) => { if (x.material) { x.material.depthTest = false; x.material.transparent = true; } x.renderOrder = 7; });
    return a;
  }
  function drawGlyphs() {
    clearGlyphs();
    // everything here is in the body's modelled coordinates: follow its assembly placement
    const bv = ctx.vp.bodyViews.find((x) => x.id === st.bodyId);
    glyphs.matrixAutoUpdate = false;
    if (bv && bv.grp) glyphs.matrix.copy(bv.grp.matrix); else glyphs.matrix.identity();
    glyphs.matrixWorldNeedsUpdate = true;
    const size = modelSize() * 0.12;
    for (const it of st.fixtures) {
      const m = facePatch(it, FIX_COLOR); if (m) glyphs.add(m);
      const fi = safe(() => ctx.faceInfo(it.body, it.idx));
      if (fi) glyphs.add(fixGlyph(fi.center, fi.normal, size * 0.45));
    }
    for (const pn of st.pins) for (const it of pn.faces) { const m = facePatch(it, PIN_COLOR); if (m) glyphs.add(m); }
    st.loads.forEach((ld) => {
      const refs = ld.faces.map((it) => ({ it, fi: safe(() => ctx.faceInfo(it.body, it.idx)) })).filter((x) => x.fi);
      for (const { it } of refs) { const m = facePatch(it, LOAD_COLOR); if (m) glyphs.add(m); }
      if (!refs.length) return;
      let vec = null;
      if (ld.type !== "pressure") vec = safe(() => L.forceVector({ magnitude: ld.magnitude >= 0 ? 1 : -1, direction: ld.direction, flip: ld.flip, faces: refs.map(({ fi }) => ({ n: fi.normal, area_mm2: fi.area })) }));
      for (const { fi } of refs) {
        const v = vec || (ld.type === "pressure" ? fi.normal.map((x) => (ld.magnitude >= 0 ? -x : x)) : null);
        if (v) glyphs.add(arrow(fi.center, v, LOAD_COLOR, size, true));
      }
    });
    if (st.gravity) {
      const b = bodies.find((x) => x.id === st.bodyId);
      const bb = b && ctx.bodyInfo ? safe(() => ctx.bodyInfo(b.shape)) : null;
      const bx = boundsOf(bb);
      const c = bx ? bx.min.map((v, k) => (v + bx.max[k]) / 2) : null;
      if (c) glyphs.add(arrow(c, L.axisVector(st.gdir), 0x8a5cd6, size * 1.2, false));
    }
    ctx.vp.requestRender();
  }
  function fixGlyph(center, normal, s) {
    // a small "ground" glyph: cone pointing into the face plus a disc
    const n = new THREE.Vector3(...normal).normalize();
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: FIX_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(s * 0.45, s, 16), mat);
    cone.position.set(0, s / 2, 0); cone.rotation.x = Math.PI;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.7, s * 0.7, s * 0.12, 20), mat.clone());
    disc.position.set(0, s, 0);
    grp.add(cone, disc);
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    grp.position.set(...center);
    grp.traverse((x) => { x.renderOrder = 7; });
    return grp;
  }

  // ---------------------------------------------------------------- solve / export
  function showErr(msg) { err.textContent = msg; err.classList.toggle("show", !!msg); }
  function spec() {
    return {
      bodyId: st.bodyId, fixtures: st.fixtures, pins: st.pins,
      loads: st.loads.map((l) => ({ ...l, magnitude: l.type === "pressure" ? l.magnitude * (PRESSURE_UNITS[l.unit || "MPa"] || 1) : l.magnitude })),
      gravity: { enabled: st.gravity, direction: st.gdir }, quality: st.quality,
    };
  }
  async function go(solve) {
    if (st.busy) return;
    showErr("");
    st.busy = true; btnSolve.disabled = btnExport.disabled = true;
    try {
      const r = await submitStudy({ ...ctx, onSolve: (s) => { ctx.onSolve && ctx.onSolve(s); } }, spec(), { solve: solve && st.canRun });
      log("fea.case." + (solve ? "solve" : "export"), { folderName: r.folderName, written: !!r.casePath });
      if (!r.casePath) {
        status.innerHTML = `Case files downloaded as <b>${esc(r.folderName)}_*</b>. Put them in a folder and run <code>python main.py --case &lt;folder&gt;</code> in FEA Sim.`;
        status.classList.remove("hidden");
        return;
      }
      if (solve && st.canRun) { close(); return; }
      st.casePath = r.casePath;
      status.innerHTML = `<div class="cfd-path"><span title="${esc(r.casePath)}">${esc(r.casePath)}</span><a href="#" data-act="reveal">Reveal</a></div><div class="cfd-live">Case written.</div>`;
      status.classList.remove("hidden");
      const a = status.querySelector('[data-act="reveal"]');
      if (a) a.addEventListener("click", (e) => { e.preventDefault(); platform.fea.revealCase(st.casePath).catch(() => {}); });
      toast(`FEA case written: ${r.folderName}`);
    } catch (e) {
      showErr(e.message || String(e));
      log("fea.case.error", { message: String(e.message || e) });
    } finally {
      st.busy = false; btnExport.disabled = false; btnSolve.disabled = !st.canRun;
    }
  }
}

export function currentFeaStudy() { return current; }

/**
 * Script / console API (window.__fea, set up by main.js). getCtx() returns the same ctx the dialog gets.
 *   __fea.faces(bodyId?)               -> [{ idx, type, center, normal, area }]
 *   __fea.solve({ body?, fixed: [faceIdx…], pins?: [{ faces: [faceIdx…], radial?, axial?, tangential? }],
 *                 loads: [{ type: "force"|"pressure"|"bearing", faces: [faceIdx…], magnitude, direction?, flip? }],
 *                 gravity?: true|"-Z", quality? })   -> { casePath, folderName }   (results open in the viewport)
 *   __fea.open()                       -> opens the dialog
 */
export function feaDebugApi(getCtx) {
  const ctxB = () => getCtx();
  const pickBody = (ctx, id) => id || (ctx.getBodies()[0] || {}).id;
  return {
    open: () => openFeaStudy(ctxB()),
    close: () => current && current.close(),
    faces(bodyId) {
      const ctx = ctxB(), id = pickBody(ctx, bodyId), n = ctx.faceCount(id);
      return Array.from({ length: n }, (_, i) => { const fi = ctx.faceInfo(id, i); return { idx: i, type: fi.type, center: fi.center.map((v) => +v.toFixed(4)), normal: fi.normal.map((v) => +v.toFixed(4)), area: +fi.area.toFixed(4) }; });
    },
    async solve(o = {}) {
      const ctx = ctxB(), id = pickBody(ctx, o.body);
      const F = (list) => (list || []).map((i) => (typeof i === "number" ? { body: id, idx: i } : i));
      const g = o.gravity === true ? { enabled: true, direction: "-Z" } : typeof o.gravity === "string" ? { enabled: true, direction: o.gravity } : o.gravity || { enabled: false };
      return submitStudy(ctx, {
        bodyId: id, fixtures: F(o.fixed),
        pins: (o.pins || []).map((p) => ({ faces: F(p.faces), radial: p.radial !== false, axial: !!p.axial, tangential: !!p.tangential })),
        loads: (o.loads || []).map((l) => ({ type: l.type || "force", faces: F(l.faces), magnitude: l.magnitude, direction: l.direction || (l.type === "bearing" ? "-Z" : "normal"), flip: !!l.flip })),
        gravity: g, quality: o.quality || "medium",
      }, { solve: o.solve !== false });
    },
    state: () => current && current.state,
  };
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

export const STRESS_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3 15.5h14"/><path d="M4.5 15.5V12M15.5 15.5V12"/><path d="M4.5 12c3-4.5 8-4.5 11 0"/><path d="M10 2.5v5.2"/><path d="M8.2 5.9 10 7.7l1.8-1.8"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const ARROW_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l8 6-3.6.6L10.6 13l-1.6.8-2.2-4.5L4 12z"/></svg>`;

/** Close the open Static Stress dialog (main.js leaveDoc: a dialog must not outlive its design tab). */
export function closeFeaStudy() { if (current) current.close(); }
