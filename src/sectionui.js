// Section Analysis (INSPECT > Section Analysis), Fusion style: cut the model with a plane to look
// inside it. Pick an origin / construction plane or a planar face, drag the arrow (or type a
// distance), flip which side is removed, and choose hatched, solid or no caps. The viewport clips and
// caps on the GPU while dragging (viewport.js setSection); once the plane settles the kernel computes
// the exact cut of each body (K.sectionBody) for crisp outlines and the section properties shown in
// the dialog (area, perimeter, centroid, second moments).
//
// Analyses are saved in doc.analyses = [{ id, name, plane: { origin, xDir, normal } (world), planeLabel,
// offset, flip, cap }]. Visibility lives in doc.hidden as "sec:<id>"; only one shows at a time. The
// plane is stored as geometry when picked, so it doesn't follow later edits of the face it came from.
import * as K from "./kernel.js";

let ctx = null;
export function initSectionUI(c) { ctx = c; }

const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const list = () => (ctx.doc().analyses = ctx.doc().analyses || []);
const hidKey = (id) => `sec:${id}`;
let draft = null; // the analysis being created / edited (while the command is open)

/** The analysis' cutting plane in world space; its normal points at the removed side. */
export function cutPlane(a) {
  const n = V.norm(a.plane.normal);
  return { origin: V.add(a.plane.origin, V.mul(n, a.offset || 0)), xDir: a.plane.xDir, normal: a.flip ? V.mul(n, -1) : n };
}
/** The analysis on screen: the one being edited, else the visible saved one (if any). */
function activeAnalysis() {
  if (draft) return draft.plane ? draft : null;
  const hs = new Set(ctx.doc().hidden || []);
  if (hs.has("analysis")) return null;
  return list().find((a) => !hs.has(hidKey(a.id))) || null;
}

// ---------- viewport + exact properties ----------
let shownKey = null, job = 0, timer = 0, lastProps = null;
/** Push the active analysis to the viewport. main.js calls this after every show(). */
export function applySection(force = false) {
  if (!ctx) return;
  const a = activeAnalysis();
  const vp = ctx.vp;
  if (!a) {
    if (vp.section) vp.setSection(null);
    shownKey = null; lastProps = null; clearTimeout(timer); job++;
    return;
  }
  const p = cutPlane(a);
  vp.setSection({ normal: p.normal, point: p.origin, cap: a.cap || "hatch" });
  const key = JSON.stringify([p, ctx.app.state && ctx.app.state.bodies.length, vp.bodyViews.map((b) => b.id + (b.grp.visible ? "" : "~")).join()]);
  // re-cut when the plane, the visible bodies or the evaluated state changed
  if (!force && key === shownKey && vp._secState === vp.state) return;
  shownKey = key; vp._secState = vp.state;
  vp.setSectionOutlines(null);
  lastProps = null;
  renderInfo();
  clearTimeout(timer);
  timer = setTimeout(() => computeProps(p), 220);
}
// one body per tick, so a big assembly doesn't freeze the window; a newer plane cancels the run
function computeProps(plane) {
  const my = ++job, vp = ctx.vp, st = vp.state;
  if (!st) return;
  const views = vp.bodyViews.filter((v) => v.grp.visible);
  const out = [], outlines = [];
  let i = 0;
  const step = () => {
    if (my !== job) return;
    if (i >= views.length) { lastProps = out; vp.setSectionOutlines(outlines); renderInfo(); return; }
    const v = views[i++];
    const b = st.bodies.find((x) => x.id === v.id);
    // modeled threads: an OCCT boolean with the helicoid takes many seconds, so cap only (no exact cut)
    if (b && !b.meshTol) {
      try {
        const inv = v.grp.matrix.clone().invert(), e = inv.elements;
        const pt = (q) => [e[0] * q[0] + e[4] * q[1] + e[8] * q[2] + e[12], e[1] * q[0] + e[5] * q[1] + e[9] * q[2] + e[13], e[2] * q[0] + e[6] * q[1] + e[10] * q[2] + e[14]];
        const dir = (q) => V.norm([e[0] * q[0] + e[4] * q[1] + e[8] * q[2], e[1] * q[0] + e[5] * q[1] + e[9] * q[2], e[2] * q[0] + e[6] * q[1] + e[10] * q[2]]);
        const local = { origin: pt(plane.origin), xDir: dir(plane.xDir), normal: dir(plane.normal) };
        const g = v.mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = [g.boundingBox.min.toArray(), g.boundingBox.max.toArray()];
        const s = K.sectionBody(b.shape, local, bb);
        if (s) {
          const m = v.grp.matrix.elements;
          const c = s.centroid;
          s.centroidWorld = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]];
          out.push({ body: b.id, name: b.name, ...s });
          outlines.push({ body: b.id, lines: s.lines });
        }
      } catch (err) { console.warn("section failed", b.name, err); }
    }
    setTimeout(step, 0);
  };
  step();
}

// ---------- dialog ----------
let infoEl = null;
function renderInfo() {
  if (!infoEl || !draft) return;
  const f = ctx.fmt;
  if (!draft.plane) { infoEl.innerHTML = "Select a plane or planar face to cut with."; return; }
  if (!lastProps) { infoEl.innerHTML = "<i>Computing section…</i>"; return; }
  if (!lastProps.length) { infoEl.innerHTML = "The plane doesn't cut any visible body."; return; }
  const tot = lastProps.reduce((s, x) => s + x.area, 0);
  const rows = lastProps.slice(0, 8).map((x) =>
    `<tr><td>${x.name}</td><td>${f(x.area, 2)}</td><td>${f(x.Iu, 1)}</td><td>${f(x.Iv, 1)}</td></tr>`).join("");
  const one = lastProps.length === 1 ? lastProps[0] : null;
  infoEl.innerHTML =
    `<b>Section area: ${f(tot, 3)} mm²</b>` +
    (one ? `<br>Perimeter: ${f(one.perimeter, 3)} mm<br>Centroid: (${one.centroidWorld.map((v) => f(v, 3)).join(", ")}) mm` +
      `<br>I<sub>u</sub> ${f(one.Iu, 2)} · I<sub>v</sub> ${f(one.Iv, 2)} · I<sub>uv</sub> ${f(one.Iuv, 2)} mm⁴` : "") +
    (lastProps.length > 1 ? `<table class="sec-tbl"><tr><th>Body</th><th>Area mm²</th><th>I<sub>u</sub> mm⁴</th><th>I<sub>v</sub> mm⁴</th></tr>${rows}</table>` +
      (lastProps.length > 8 ? `<div>…and ${lastProps.length - 8} more</div>` : "") : "") +
    `<div class="sec-note">Second moments about the centroid; u = plane X, v = plane Y.</div>`;
}

function planeFromPick(it) {
  const vp = ctx.vp, st = ctx.app.state;
  let p, label;
  if (it.kind === "plane") { p = { ...it.plane, origin: [...(it.plane.origin || [0, 0, 0])] }; const on = it.name || (it.planeRef && it.planeRef.kind === "origin" && it.planeRef.name); label = on ? `${on} plane` : ((it.planeRef && st.planes[it.planeRef.id]) || {}).name || "Plane"; }
  else {
    const lp = K.planeFromFace(K.faceOf(st, it.body, it.idx));
    const bv = vp.bodyViews.find((b) => b.id === it.body);
    const m = bv ? bv.grp.matrix.elements : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const pt = (q) => [m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12], m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13], m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14]];
    const dir = (q) => V.norm([m[0] * q[0] + m[4] * q[1] + m[8] * q[2], m[1] * q[0] + m[5] * q[1] + m[9] * q[2], m[2] * q[0] + m[6] * q[1] + m[10] * q[2]]);
    p = { origin: pt(lp.origin), xDir: dir(lp.xDir), normal: dir(lp.normal) };
    label = `Face of ${(st.bodies.find((b) => b.id === it.body) || {}).name || "body"}`;
  }
  // put the arrow where the model is: the visible bodies' centre projected onto the plane
  const box = vp.sceneBounds ? vp.sceneBounds() : null;
  if (box && !box.isEmpty() && it.kind === "plane") {
    const c = box.getCenter(box.min.clone()).toArray(), n = V.norm(p.normal);
    p.origin = V.sub(c, V.mul(n, V.dot(V.sub(c, p.origin), n)));
  }
  return { plane: p, label };
}

export function startSection(editId = null) {
  const { app, vp, h, ico } = ctx;
  ctx.prepare(); // leaves sketch mode, cancels any command
  const editing = editId ? list().find((a) => a.id === editId) : null;
  draft = editing ? JSON.parse(JSON.stringify(editing)) : { id: `sec${Date.now().toString(36)}`, name: `Section${list().length + 1}`, plane: null, planeLabel: "", offset: 0, flip: false, cap: "hatch" };
  const pre = !editing && app.selection.find((it) => it.kind === "plane" || (it.kind === "face" && ctx.isPlanarFace(app.state, it)));
  app.selection = [];
  app.cmd = {
    kind: "section",
    pickKinds: () => ["plane", "face"],
    pickFilter: (it) => it.kind === "plane" || (it.kind === "face" && ctx.isPlanarFace(app.state, it)),
    onPick: (it) => { if (it) setPlane(it); },
    onCancel: () => { draft = null; infoEl = null; applySection(true); },
  };
  app.lastCmd = "sectionAnalysis";
  ctx.logEvent("command", { name: "sectionAnalysis", edit: !!editing });

  const selBtn = h("button", { class: "sel-btn", onclick: () => { vp.setOriginPlanesVisible(true); ctx.setTip("Select a plane or planar face"); } });
  const dist = h("input", { value: ctx.fmt(draft.offset), spellcheck: "false" });
  const flip = h("button", { class: "btn mini-btn", title: "Flip the side that is cut away" }, ico("flip"), "Flip");
  const cap = h("select", {}, [["hatch", "Hatched"], ["solid", "Solid"], ["none", "None (hollow)"]].map(([v, l]) => h("option", { value: v }, l)));
  cap.value = draft.cap;
  infoEl = h("div", { class: "dlg-info sec-info" });
  const refreshSel = () => {
    selBtn.className = `sel-btn${draft.plane ? " filled" : " active"}`;
    selBtn.innerHTML = "";
    selBtn.append(ico("select", "arrow"), h("span", { class: "cnt" }, draft.plane ? draft.planeLabel : "Select"));
  };
  const live = () => { applySection(); syncArrow(); };
  const syncArrow = () => {
    if (!draft.plane) { vp.hideArrow(); return; }
    const n = V.norm(draft.plane.normal);
    if (!vp.arrow) {
      vp.showArrow({
        key: "offset", origin: draft.plane.origin, dir: n, value: draft.offset,
        onDrag: (v) => { draft.offset = Math.round(v * 100) / 100; dist.value = ctx.fmt(draft.offset); applySection(); },
      });
    } else if (!vp.drag || vp.drag.mode !== "arrow") { vp.arrow.value = draft.offset; vp.positionArrow(); }
  };
  function setPlane(it) {
    const { plane, label } = planeFromPick(it);
    draft.plane = plane; draft.planeLabel = label;
    if (!editing) draft.offset = 0;
    dist.value = ctx.fmt(draft.offset);
    vp.setOriginPlanesVisible(false);
    ctx.setTip("");
    vp.hideArrow();
    refreshSel(); live();
  }
  dist.addEventListener("input", () => { const v = parseFloat(dist.value); if (isFinite(v)) { draft.offset = v; live(); } });
  dist.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); draft.offset = +(draft.offset + (e.key === "ArrowUp" ? 1 : -1)).toFixed(4); dist.value = ctx.fmt(draft.offset); live(); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
  });
  flip.addEventListener("click", () => { draft.flip = !draft.flip; live(); });
  cap.addEventListener("change", () => { draft.cap = cap.value; applySection(true); });

  const ok = () => {
    if (!draft.plane) { ctx.toast("Select a plane or planar face first"); return; }
    ctx.pushUndo();
    const arr = list(), saved = { ...draft };
    const i = arr.findIndex((a) => a.id === saved.id);
    if (i >= 0) arr[i] = saved; else arr.push(saved);
    showOnly(saved.id);
    ctx.logEvent("section analysis", { action: editing ? "edit" : "create", offset: saved.offset, flip: saved.flip, cap: saved.cap });
    draft = null; infoEl = null;
    ctx.endCommand();
    applySection(true);
    ctx.save(); ctx.refreshBrowser();
  };
  ctx.dialogFrame(editing ? "Edit Section Analysis" : "Section Analysis", "section", [
    h("div", { class: "dlg-row" }, h("label", {}, "Plane"), h("div", { class: "ctl" }, selBtn)),
    h("div", { class: "dlg-row" }, h("label", {}, "Distance"), h("div", { class: "ctl" }, h("div", { class: "num" }, dist, h("em", {}, "mm")), flip)),
    h("div", { class: "dlg-row" }, h("label", {}, "Cut face"), h("div", { class: "ctl" }, cap)),
    infoEl,
  ], { ok: "OK", onOK: ok });
  refreshSel();
  if (pre) setPlane(pre);
  else if (draft.plane) live();
  else { vp.setOriginPlanesVisible(true); ctx.setTip("Select a plane or planar face"); renderInfo(); }
  ctx.refreshHighlights(); ctx.buildToolbar();
}

// ---------- browser (Analysis folder) ----------
function showOnly(id) {
  const d = ctx.doc(), hs = new Set(d.hidden || []);
  for (const a of list()) if (a.id !== id) hs.add(hidKey(a.id));
  hs.delete(hidKey(id)); hs.delete("analysis");
  d.hidden = [...hs];
}
/** main.js toggleVisible hook: showing one analysis hides the others. */
export function onToggleVisible(hs, id) {
  if (!id.startsWith("sec:") || hs.has(id)) return;
  for (const a of list()) if (hidKey(a.id) !== id) hs.add(hidKey(a.id));
}
export function removeSection(id) {
  ctx.pushUndo();
  ctx.doc().analyses = list().filter((a) => a.id !== id);
  ctx.doc().hidden = (ctx.doc().hidden || []).filter((x) => x !== hidKey(id));
  applySection(true); ctx.save(); ctx.refreshBrowser();
}
function flipSection(id) {
  const a = list().find((x) => x.id === id);
  if (!a) return;
  ctx.pushUndo(); a.flip = !a.flip; showOnly(id); applySection(true); ctx.save(); ctx.refreshBrowser();
}
/** Rows for the browser tree: row(depth, opts) is main.js's row builder. */
export function sectionBrowserRows(row, open, hidden) {
  const arr = ctx.doc().analyses || [];
  if (!arr.length) return;
  if (open.analysis === undefined) open.analysis = true;
  row(1, { key: "analysis", icon: "folder", name: "Analysis", eye: !hidden.has("analysis"), eyeId: "analysis" });
  if (!open.analysis) return;
  for (const a of arr) {
    row(2, { key: a.id, icon: "section", name: a.name, leaf: true, eye: !hidden.has(hidKey(a.id)), eyeId: hidKey(a.id),
      sub: `${a.planeLabel || "plane"}${a.offset ? ` ${a.offset > 0 ? "+" : ""}${ctx.fmt(a.offset, 2)} mm` : ""}`,
      ondbl: () => startSection(a.id),
      onctx: (e) => ctx.openMenu(null, [
        { label: "Edit Section Analysis", icon: "section", run: () => startSection(a.id) },
        { label: "Flip", icon: "flip", run: () => flipSection(a.id) },
        "|",
        { label: "Delete", icon: "trash", run: () => removeSection(a.id) },
      ], { x: e.clientX, y: e.clientY }) });
  }
}
/** Script hooks for tests and the feature tour: window.__section */
export function sectionDebugApi() {
  return {
    start: (id) => startSection(id),
    draft: () => draft,
    props: () => lastProps,
    list: () => list(),
    apply: () => applySection(true),
  };
}
