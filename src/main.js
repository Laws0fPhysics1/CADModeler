// App shell: document + undo, commands and their dialogs, toolbar, browser,
// timeline, marking menu, keyboard shortcuts, save / open / export.
import { initBugReporter, logEvent, setSaveHandler, setReportsHandler } from "./bugreport.js"; // first, so logging starts early
import { openBugList, refreshBugBadge } from "./bugstatusui.js";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as K from "./kernel.js";
import { Viewport, COLORS, applyGizmoDelta, moveMatrix, transformPlane, invertRigid } from "./viewport.js";
import { moveToolsRow, movedBounds, snapFor, keyStep, readoutText, showReadout, hideReadout } from "./movetools.js";
import { UNITS, setUnitSource, units, unitLabel, fmtLen, parseLength, parseNumber, fromDisp } from "./units.js";
import { ViewCube } from "./viewcube.js";
import { Sketcher, CONSTRAINT_TOOLS } from "./sketcher.js";
import * as SM from "./sketchmodel.js";
import { icons, featureIcon, jointIcon } from "./icons.js";
import { getTheme, toggleTheme, onThemeChange, getPref, setPref } from "./theme.js";
import { openSettings } from "./settings.js";
import { STUDY_TYPES } from "./studytypes.js";
import { STUDY_SETUP, SIM_TOOLS } from "./studysetup.js";
import { openStudyOptions, closeStudyOptions, defaultValues } from "./studyoptions.js";
import { openStudyGallery } from "./studygallery.js";
import { initPartsPanel } from "./partsui.js";
import { newDocId, docKind, insertLoop, makeInsertFeature, KIND_LABEL, KIND_ICON } from "./hybrid.js";
import { heroReady, closeHero, showHero, heroOpen } from "./hero.js";
import { docHasContent, pruneEmptyTabs, startPageOffer } from "./session.js";
import * as platform from "./platform.js";
import { openCfdStudy, closeCfdStudy } from "./cfdstudy.js";
import { openCfdResults, closeResults, currentResults } from "./cfdresults.js";
import { openFeaStudy, feaDebugApi, closeFeaStudy } from "./feastudy.js";
import { openFeaResults, closeFeaResults, currentFeaResults } from "./fearesults.js";
import { resultSummary as feaSummary } from "./fealink.js";
import { getMaterial, describe as describeAppearance } from "./materials.js";
import { openAppearanceDialog } from "./appearance.js";
import { openRobotExport, installRobotDebugHook } from "./robotexportui.js";
import { KINDS as FASTENER_KINDS, SIZES as FASTENER_SIZES, IMPERIAL_SIZES as FASTENER_INCH, hasLength as fastenerHasLength } from "./fasteners.js";
import { makeStockDef, initStockUI } from "./stockui.js";
import { syncStockAppearances } from "./stock.js";
import { emptyAssembly, solveAssembly, componentOfBody, parentJointOf } from "./assembly.js";
import { updateLoops } from "./drivemotion.js";
import { createAssemblyUI } from "./assemblyui.js";
import { nacaEntities } from "./airfoil.js";
import { makeGearDef } from "./gearui.js";
import { openFlow2D, closeFlow2D, currentFlow2D } from "./cfd2dui.js";
import { openTopo as openTopoStudy, closeTopo, topoDebugApi } from "./topoui.js";
import { initSectionUI, startSection, applySection, sectionBrowserRows, onToggleVisible as sectionToggle, sectionDebugApi } from "./sectionui.js";

const $ = (s, el = document) => el.querySelector(s);
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
const ico = (name, cls = "ic") => h("i", { class: cls, html: icons[name] || "" });
const fmt = (v, d = 3) => String(+(+v).toFixed(d));
// lengths are mm inside; dialogs show and read them in the design's units (units.js): the design's
// own doc.units, else the default for new designs (Settings > General > Units)
setUnitSource(() => (app && app.doc && app.doc.units) || getPref("units", "mm"));
const fmtArea = (mm2) => { const f = fromDisp(1); return `${String(+(mm2 / f / f).toPrecision(6))} ${unitLabel()}²`; };
const isLenUnit = (u) => u === "mm";
const fmtVal = (v, unit) => (isLenUnit(unit) ? fmtLen(v) : fmt(v));
const parseVal = (text, unit) => (isLenUnit(unit) ? parseLength(text) : parseNumber(text));
const unitText = (unit) => (isLenUnit(unit) ? unitLabel() : unit);

// ======================= document & state =======================
const STORE = "cadmodeler.doc.v1"; // the active tab's design
const TABS_STORE = "cadmodeler.tabs.v1"; // { active, ids }: open design tabs; the inactive ones are stored at `${STORE}#<id>`
const TYPE_NAMES = { import: "Import", sketch: "Sketch", extrude: "Extrude", revolve: "Revolve", fillet: "Fillet", chamfer: "Chamfer", shell: "Shell", offsetFace: "Offset Face", box: "Box", cylinder: "Cylinder", sphere: "Sphere", plane: "Plane", remove: "Remove", fastener: "Fastener", stock: "Stock", gear: "Gears", insert: "Insert", move: "Move" };
// id: stable across renames (loop checks for inserted designs); kind: "part" | "assembly" | "hybrid" (hybrid.js)
const newDoc = () => ({ id: newDocId(), kind: "part", units: getPref("units", "mm"), name: "Untitled", features: [], marker: 0, counters: {}, hidden: [], appearances: {}, studies: [], assembly: emptyAssembly() });
/** a design read from storage or a file: older ones get an id and a kind */
const fromStored = (d) => ({ ...newDoc(), ...d, kind: docKind(d) });
function parseDoc(json) {
  try { const d = JSON.parse(json); if (d && Array.isArray(d.features)) return fromStored(d); } catch (e) {}
  return null;
}
const tabId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const makeTab = (d = newDoc()) => ({ id: tabId(), doc: d, undo: [], redo: [], view: null, file: null, saved: null }); // file/saved: Save target + JSON at the last save/open
function loadTabs() {
  const active = parseDoc(localStorage.getItem(STORE)) || newDoc();
  let meta = null;
  try { meta = JSON.parse(localStorage.getItem(TABS_STORE)); } catch (e) {}
  let tabs, tab = 0;
  if (!meta || !Array.isArray(meta.ids) || !meta.ids.includes(meta.active)) tabs = [makeTab(active)];
  else {
    tabs = meta.ids.map((id) => ({ ...makeTab(), id, doc: id === meta.active ? active : parseDoc(localStorage.getItem(`${STORE}#${id}`)) })).filter((t) => t.doc);
    tab = tabs.findIndex((t) => t.id === meta.active);
  }
  // empty leftovers aren't worth continuing (feature request 2026-10-09): drop them and their storage
  const kept = pruneEmptyTabs(tabs, tab);
  if (!kept.dropped.length) return { tabs, tab };
  try {
    for (const t of kept.dropped) localStorage.removeItem(`${STORE}#${t.id}`);
    if (!kept.tabs.length) { localStorage.removeItem(STORE); localStorage.removeItem(TABS_STORE); }
    else {
      const a = kept.tabs[kept.active];
      localStorage.setItem(STORE, JSON.stringify(a.doc)); localStorage.removeItem(`${STORE}#${a.id}`);
      localStorage.setItem(TABS_STORE, JSON.stringify({ active: a.id, ids: kept.tabs.map((t) => t.id) }));
    }
  } catch (e) {}
  return kept.tabs.length ? { tabs: kept.tabs, tab: kept.active } : { tabs: [makeTab()], tab: 0 };
}
const openTabs = loadTabs();
// designs left over from the last run (it crashed, or an older build): offered on the start page;
// New Design there closes them
const bootSession = { count: openTabs.tabs.filter((t) => docHasContent(t.doc)).length, used: false };
const app = {
  tabs: openTabs.tabs, tab: openTabs.tab, // open designs; app.doc / undo / redo belong to tabs[tab]
  doc: openTabs.tabs[openTabs.tab].doc,
  state: K.emptyState(),
  mode: "model",
  cmd: null,
  selection: [],
  hover: null,
  undo: [], redo: [],
  lastCmd: null,
  tip: "",
  display: ["shadedEdges", "shaded", "wire"].includes(getPref("display")) ? getPref("display") : "shadedEdges", // persisted (Settings)
};
let vp, sketcher;
let asmUI = null; // assemblies (assemblyui.js): components, joints, per-body placement
const doc = () => app.doc;
let fidN = 0;
const fid = () => `f${Date.now().toString(36)}${(fidN++).toString(36)}`;
function nextName(type) { const c = doc().counters; c[type] = (c[type] || 0) + 1; return `${TYPE_NAMES[type]}${c[type]}`; }
function save() { if (app.closing) return; try { localStorage.setItem(STORE, JSON.stringify(app.doc)); } catch (e) {} saveTabs(); }
function saveTabs() { if (app.closing) return; try { localStorage.setItem(TABS_STORE, JSON.stringify({ active: app.tabs[app.tab].id, ids: app.tabs.map((t) => t.id) })); } catch (e) {} }
function pushUndo() { app.undo.push(JSON.stringify(app.doc)); if (app.undo.length > 80) app.undo.shift(); app.redo = []; refreshAppbar(); }
function undo() {
  logEvent("undo", { mode: app.mode });
  if (app.mode === "sketch") { sketcher.undo(); return; }
  if (!app.undo.length) return;
  cancelCommand();
  app.redo.push(JSON.stringify(app.doc)); app.doc = JSON.parse(app.undo.pop()); regen();
}
function redo() {
  logEvent("redo", { mode: app.mode });
  if (app.mode === "sketch") { sketcher.redo(); return; }
  if (!app.redo.length) return;
  cancelCommand();
  app.undo.push(JSON.stringify(app.doc)); app.doc = JSON.parse(app.redo.pop()); regen();
}

function show(state, opts = {}) {
  vp.hidden = new Set(doc().hidden);
  if (app.cmd && app.cmd.showSketches) for (const id of app.cmd.showSketches) vp.hidden.delete(id);
  if (asmUI) vp.bodyXforms = asmUI.transformsFor(state); // assembly placement, applied by setState
  vp.setState(state, { appearances: doc().appearances || {}, ...opts });
  applyVisibility(state);
  applyDisplay();
  driveLoops(undefined, state);
  applySection(); // Section Analysis clip + caps (sectionui.js)
}
/** Chains and belts travel with their sprocket / pulley's axle joint (drivemotion.js). */
function driveLoops(a = doc().assembly, state = app.state) {
  if (!a || !Array.isArray(a.joints) || !state.bodies.some((b) => b.gear && b.gear.wheel)) return;
  const solved = solveAssembly(a);
  updateLoops(vp, state, (bodyId) => { const c = componentOfBody(a, bodyId), j = c && parentJointOf(a, c.id); return j ? solved.values.get(j.id) || 0 : 0; });
}
function setDisplay(style) { app.display = style; setPref("display", style); applyDisplay(); }
function setGrid(on) { vp.showGrid = !!on; setPref("showGrid", vp.showGrid); if (app.mode !== "sketch") vp.grid.visible = vp.showGrid; vp.requestRender(); }
function applyDisplay() {
  for (const b of vp.bodyViews) {
    b.mesh.visible = app.display !== "wire";
    b.lines.visible = app.display !== "shaded";
  }
  vp.requestRender();
}
let lastErrorKeys = "";
function regen() {
  app.state = K.evaluate(doc().features, doc().marker);
  // new feature errors: rebuild once from scratch (fresh caches) in case a cached shape went bad
  const errKeys = Object.keys(app.state.errors).sort().join(",");
  if (errKeys && errKeys !== lastErrorKeys) {
    const before = { ...app.state.errors }, stack = K.lastFeatureError.stack;
    K.clearShapeCaches();
    app.state = K.evaluate(doc().features, doc().marker);
    const fixed = Object.keys(before).filter((id) => !app.state.errors[id]);
    logEvent("feature errors retried", { before, after: app.state.errors, fixedByFreshCaches: fixed, stack: stack && stack.split(String.fromCharCode(10)).slice(0, 8).join(" | ") });
  }
  lastErrorKeys = Object.keys(app.state.errors).sort().join(",");
  doc().kind = docKind(doc()); // inserted designs make it a hybrid; deleting them all makes it a part again
  syncStockAppearances(app.state.bodies, doc().appearances || (doc().appearances = {})); // stock bodies get their default material
  if (Object.keys(app.state.errors).length) logEvent("feature errors", app.state.errors);
  show(app.state);
  app.selection = app.selection.filter((it) => itemExists(app.state, it));
  refreshHighlights(); refreshBrowser(); refreshTimeline(); refreshAppbar(); save();
}
function itemExists(st, it) {
  if (it.body) { const b = st.bodies.find((x) => x.id === it.body); if (!b) return false; }
  if (it.kind === "profile") return !!st.sketches[it.sketch];
  return it.kind !== "face" && it.kind !== "edge"; // topology indices are stale after a rebuild
}

// ======================= items & references =======================
function itemKey(it) {
  switch (it.kind) {
    case "face": case "edge": return `${it.kind}:${it.body}:${it.idx}`;
    case "profile": return `p:${it.sketch}:${it.idx}`;
    case "plane": return `pl:${JSON.stringify(it.planeRef)}`;
    case "axis": return `ax:${it.name}`;
    case "sketchline": return `sl:${it.sketch}:${it.entity}`;
    case "body": return `b:${it.body}`;
  }
  return JSON.stringify(it);
}
function refFromItem(st, it) {
  if (it.kind === "face") return { kind: "face", ...K.faceRef(st, it.body, it.idx) };
  if (it.kind === "edge") return K.edgeRef(st, it.body, it.idx);
  if (it.kind === "profile") { const p = st.sketches[it.sketch].profiles[it.idx]; return { kind: "profile", sketch: it.sketch, pt: p.center2d, area: p.area }; }
  return null;
}
function itemFromRef(st, ref, kind) {
  try {
    if (kind === "edge") { const r = K.resolveEdge(st, ref); return { kind: "edge", body: r.body.id, idx: r.idx }; }
    if (ref.kind === "face" || kind === "face") { const r = K.resolveFace(st, ref); return { kind: "face", body: r.body.id, idx: r.idx }; }
    if (ref.kind === "profile") { const r = K.resolveProfile(st, ref); return { kind: "profile", sketch: ref.sketch, idx: r.sketch.profiles.indexOf(r.profile) }; }
  } catch (e) {}
  return null;
}
function profileItems(st, ref) {
  try { const r = K.resolveProfileSet(st, ref); return r.profiles.map((p) => ({ kind: "profile", sketch: ref.sketch, idx: r.sketch.profiles.indexOf(p) })); }
  catch (e) { return [itemFromRef(st, ref)]; }
}
// Face/edge indices only mean something for the body they were picked on. While a fillet/chamfer/shell
// preview shows the *result*, picks must be translated back to the base body (and highlights forward).
function mapItem(from, to, it) {
  if (!it || from === to || (it.kind !== "face" && it.kind !== "edge")) return it;
  try {
    const ref = it.kind === "edge" ? K.edgeRef(from, it.body, it.idx) : K.faceRef(from, it.body, it.idx);
    const r = itemFromRef(to, ref, it.kind);
    // keep the pick point (same modelled coordinates on both bodies): the Shell arrow anchors near it
    if (r && it.localPoint) { r.point = it.point; r.localPoint = it.localPoint; }
    return r;
  } catch (e) { return null; }
}
const isPlanarFace = (st, it) => { try { return K.faceOf(st, it.body, it.idx).geomType === "PLANE"; } catch (e) { return false; } };
function itemFrame(st, it) {
  // origin + normal used to place arrows (on screen: in the sketch's / body's assembly placement)
  const placed = (fr, key) => { const p = transformPlane({ origin: fr.origin, xDir: [1, 0, 0], normal: fr.normal }, vp.bodyXform(key)); return { origin: p.origin, normal: p.normal }; };
  if (it.kind === "profile") { const sk = st.sketches[it.sketch], p = sk.profiles[it.idx]; return placed({ origin: p.center3d, normal: sk.plane.normal }, `sk:${it.sketch}`); }
  if (it.kind === "face") { const f = K.faceInfo(st.bodies.find((b) => b.id === it.body).shape, it.idx); return placed({ origin: f.center, normal: K.V.norm(f.normal) }, it.body); }
  if (it.kind === "plane") return { origin: it.plane.origin, normal: it.plane.normal };
  return null;
}

// fillet / chamfer drag arrow on an edge (bug-report feature request 2026-10-09). `tipScale(angle)` maps the
// size to the distance from the edge to the new surface's middle, so the arrow tip sits on it
const edgeFrames = new WeakMap(); // shape -> Map(idx -> K.edgeFrame)
function edgeArrow(st, it, key, tipScale) {
  if (!it || it.kind !== "edge") return null;
  const b = st.bodies.find((x) => x.id === it.body);
  if (!b) return null;
  let m = edgeFrames.get(b.shape);
  if (!m) edgeFrames.set(b.shape, (m = new Map()));
  if (!m.has(it.idx)) { let fr = null; try { fr = K.edgeFrame(b.shape, it.idx); } catch (e) {} m.set(it.idx, fr); }
  const fr = m.get(it.idx);
  if (!fr) return null;
  const sc = tipScale(fr.angle);
  return { origin: fr.origin, dir: fr.dir, key, scaleValue: isFinite(sc) && sc > 0.05 ? sc : 1, min: 0.01, step: 0.1 };
}
// shell drag arrow (bug report 2026-10-09 09:00): on the first removed face's rim near where it was picked,
// pointing into the kept wall, so the tip (origin + dir·thickness) rides on the new inner wall. Cached per
// base shape + faces + pick point, so it stays put while previews come and go
const shellFrames = new WeakMap(); // shape -> Map(key -> K.shellFrame)
function shellArrow(st, faces) {
  const it = faces && faces[0];
  if (!it || it.kind !== "face") return null;
  const b = st.bodies.find((x) => x.id === it.body);
  if (!b) return null;
  const removed = faces.filter((f) => f && f.kind === "face" && f.body === it.body).map((f) => f.idx);
  const near = Array.isArray(it.localPoint) ? it.localPoint : null;
  const key = `${removed.join(",")}|${near ? near.map((x) => x.toFixed(3)).join(",") : ""}`;
  let m = shellFrames.get(b.shape);
  if (!m) shellFrames.set(b.shape, (m = new Map()));
  if (!m.has(key)) { let fr = null; try { fr = K.shellFrame(b.shape, it.idx, near, removed); } catch (e) {} m.set(key, fr); }
  const fr = m.get(key);
  return fr && { origin: fr.origin, dir: fr.dir, key: "thickness", min: 0.05, step: 0.1 };
}

// ======================= feature command definitions =======================
const OPS = [["join", "Join"], ["cut", "Cut"], ["intersect", "Intersect"], ["new", "New Body"]];
const opField = { type: "dropdown", key: "operation", label: "Operation", options: OPS, value: "auto" };
const planarFilter = (st, it) => it.kind !== "face" || isPlanarFace(st, it);
// fastener positions: circular edges, hole walls and planar faces
const fastenerPlaceFilter = (st, it) => {
  try {
    if (it.kind === "edge") return K.edgeOf(st, it.body, it.idx).geomType === "CIRCLE";
    if (it.kind === "face") { const t = K.faceOf(st, it.body, it.idx).geomType; return t === "PLANE" || t === "CYLINDRE"; }
  } catch (e) {}
  return false;
};
const DEFS = {
  extrude: {
    title: "Extrude", icon: "extrude",
    fields: [
      { type: "select", key: "profiles", label: "Profiles", kinds: ["profile", "face"], multi: true, filter: planarFilter, prompt: "Select a profile or planar face" },
      { type: "dropdown", key: "direction", label: "Direction", options: [["one", "One Side"], ["symmetric", "Symmetric"], ["two", "Two Sides"]], value: "one" },
      { type: "number", key: "distance", label: "Distance", unit: "mm", value: 10 },
      { type: "number", key: "distance2", label: "Distance 2", unit: "mm", value: 10, showIf: (v) => v.direction === "two" },
      opField,
    ],
    build: (v, st) => ({ type: "extrude", profiles: v.profiles.map((it) => refFromItem(st, it)), direction: v.direction, distance: v.distance, distance2: v.distance2, operation: v.operation }),
    arrow: (v, st) => { const fr = v.profiles[0] && itemFrame(st, v.profiles[0]); return fr && { origin: fr.origin, dir: fr.normal, key: "distance" }; },
  },
  revolve: {
    title: "Revolve", icon: "revolve",
    fields: [
      { type: "select", key: "profiles", label: "Profile", kinds: ["profile", "face"], multi: true, filter: planarFilter, prompt: "Select a profile to revolve" },
      { type: "select", key: "axis", label: "Axis", kinds: ["axis", "sketchline"], multi: false, prompt: "Select a sketch line or origin axis" },
      { type: "number", key: "angle", label: "Angle", unit: "deg", value: 360 },
      opField,
    ],
    build: (v, st) => {
      const a = v.axis[0];
      return { type: "revolve", profiles: v.profiles.map((it) => refFromItem(st, it)), axis: a ? (a.kind === "axis" ? { kind: a.name } : { kind: "line", sketch: a.sketch, entity: a.entity }) : null, angle: v.angle, operation: v.operation };
    },
  },
  fillet: {
    title: "Fillet", icon: "fillet",
    fields: [
      { type: "select", key: "edges", label: "Edges", kinds: ["edge"], multi: true, prompt: "Select edges to fillet" },
      { type: "number", key: "radius", label: "Radius", unit: "mm", value: 2 },
    ],
    build: (v, st) => ({ type: "fillet", edges: v.edges.map((it) => refFromItem(st, it)), radius: v.radius }),
    // drag arrow on the first edge, along the corner's bisector; its tip rides on the fillet's mid-arc
    arrow: (v, st) => edgeArrow(st, v.edges[0], "radius", (a) => 1 / Math.sin(a / 2) - 1),
  },
  chamfer: {
    title: "Chamfer", icon: "chamfer",
    fields: [
      { type: "select", key: "edges", label: "Edges", kinds: ["edge"], multi: true, prompt: "Select edges to chamfer" },
      { type: "number", key: "distance", label: "Distance", unit: "mm", value: 1 },
    ],
    build: (v, st) => ({ type: "chamfer", edges: v.edges.map((it) => refFromItem(st, it)), distance: v.distance }),
    arrow: (v, st) => edgeArrow(st, v.edges[0], "distance", (a) => Math.cos(a / 2)),
  },
  shell: {
    title: "Shell", icon: "shell",
    fields: [
      { type: "select", key: "faces", label: "Faces", kinds: ["face"], multi: true, prompt: "Select faces to remove" },
      { type: "number", key: "thickness", label: "Inside Thickness", unit: "mm", value: 1 },
    ],
    build: (v, st) => ({ type: "shell", faces: v.faces.map((it) => refFromItem(st, it)), thickness: v.thickness }),
    // arrow on the first removed face pointing into the part: drag it in to thicken the walls
    arrow: (v, st) => shellArrow(st, v.faces),
  },
  // Offset Face: push / pull faces of a body (+ adds material along the face's outward normal, − removes)
  offsetFace: {
    title: "Offset Face", icon: "offsetFace",
    fields: [
      { type: "select", key: "faces", label: "Faces", kinds: ["face"], multi: true, prompt: "Select faces to push or pull" },
      { type: "number", key: "distance", label: "Distance", unit: "mm", value: 1 },
    ],
    build: (v, st) => ({ type: "offsetFace", faces: v.faces.map((it) => refFromItem(st, it)), distance: v.distance }),
    // arrow on the first face along its outward normal; its tip rides on the offset face
    arrow: (v, st) => {
      const it = v.faces && v.faces[0];
      if (!it || it.kind !== "face") return null;
      const b = st.bodies.find((x) => x.id === it.body);
      if (!b) return null;
      let fr = null;
      try { fr = K.faceFrameAt(b.shape, it.idx, Array.isArray(it.localPoint) ? it.localPoint : null); } catch (e) { fr = null; }
      return fr && { origin: fr.origin, dir: fr.normal, key: "distance", step: 0.1 };
    },
  },
  box: {
    title: "Box", icon: "box",
    fields: [
      { type: "number", key: "length", label: "Length", unit: "mm", value: 50 },
      { type: "number", key: "width", label: "Width", unit: "mm", value: 50 },
      { type: "number", key: "height", label: "Height", unit: "mm", value: 20 },
      opField,
    ],
    build: (v) => ({ type: "box", length: v.length, width: v.width, height: v.height, operation: v.operation }),
    arrow: (v) => ({ origin: [0, 0, 0], dir: [0, 0, 1], key: "height" }),
  },
  cylinder: {
    title: "Cylinder", icon: "cylinder",
    fields: [
      { type: "number", key: "radius", label: "Radius", unit: "mm", value: 20 },
      { type: "number", key: "height", label: "Height", unit: "mm", value: 40 },
      opField,
    ],
    build: (v) => ({ type: "cylinder", radius: v.radius, height: v.height, operation: v.operation }),
    arrow: (v) => ({ origin: [0, 0, 0], dir: [0, 0, 1], key: "height" }),
  },
  sphere: {
    title: "Sphere", icon: "sphere",
    fields: [{ type: "number", key: "radius", label: "Radius", unit: "mm", value: 25 }, opField],
    build: (v) => ({ type: "sphere", radius: v.radius, operation: v.operation }),
    arrow: (v) => ({ origin: [0, 0, 0], dir: [1, 0, 0], key: "radius" }),
  },
  fastener: {
    title: "Fastener", icon: "bolt",
    fields: [
      { type: "select", key: "place", label: "Position", kinds: ["edge", "face"], multi: false, optional: true, filter: fastenerPlaceFilter, prompt: "Select a hole edge, a hole, or a planar face (or leave empty: origin)" },
      { type: "dropdown", key: "kind", label: "Type", options: FASTENER_KINDS, value: "socketCap" },
      { type: "dropdown", key: "size", label: "Size", options: [["auto", "Auto (fit the hole)"], ...[...FASTENER_SIZES, ...FASTENER_INCH].map((s) => [s, s])], value: "auto" },
      { type: "number", key: "length", label: "Length", unit: "mm", value: 20, showIf: (v) => fastenerHasLength(v.kind) },
      { type: "number", key: "threadLength", label: "Thread Length", unit: "mm", value: 0, showIf: (v) => ["hexBolt", "socketCap"].includes(v.kind), hint: "0 = standard" },
      { type: "dropdown", key: "threads", label: "Threads", options: [["modeled", "Modeled"], ["cosmetic", "Cosmetic (plain, fast)"]], value: "modeled", showIf: (v) => v.kind !== "washer" },
      { type: "dropdown", key: "direction", label: "Direction", options: [["normal", "Into the hole"], ["flip", "Flipped"]], value: "normal" },
      { type: "number", key: "offset", label: "Offset", unit: "mm", value: 0 },
    ],
    build: (v, st) => {
      const it = v.place[0];
      const place = !it ? null : it.kind === "edge" ? { kind: "edge", ...K.edgeRef(st, it.body, it.idx) } : { kind: "face", ...K.faceRef(st, it.body, it.idx) };
      return { type: "fastener", kind: v.kind, size: v.size, length: v.length, threadLength: v.threadLength, threads: v.threads, direction: v.direction, offset: v.offset, place };
    },
    // the live preview uses plain shanks (a modeled thread takes about a second to build and mesh); OK builds the real thing
    previewBuild: (v, st) => ({ ...DEFS.fastener.build(v, st), threads: "cosmetic" }),
  },
  plane: {
    title: "Offset Plane", icon: "plane",
    fields: [
      { type: "select", key: "base", label: "Plane", kinds: ["plane", "face"], multi: false, filter: planarFilter, prompt: "Select a plane or planar face" },
      { type: "number", key: "offset", label: "Distance", unit: "mm", value: 20 },
    ],
    build: (v, st) => {
      const b = v.base[0];
      const base = !b ? null : b.kind === "plane" ? b.planeRef.kind === "origin" ? { kind: "origin", name: b.planeRef.name } : { kind: "cplane", id: b.planeRef.id } : { kind: "face", ref: refFromItem(st, b) };
      return { type: "plane", base, offset: v.offset };
    },
    arrow: (v, st) => { const fr = v.base[0] && itemFrame(st, v.base[0]); return fr && { origin: fr.origin, dir: fr.normal, key: "offset" }; },
  },
};
// Move/Copy bodies (feature request 2026-10-09 "translation and rotation tool/gizmo", bug "cant drag sub
// parts"): a timeline feature that rotates about the bodies' centre, then translates. The gizmo
// (vp.showGizmo) drags the values; while dragging, the bodies follow by a display matrix only, and the
// real result is rebuilt when the mouse is released.
DEFS.move = {
  title: "Move/Copy", icon: "move",
  fields: [
    { type: "select", key: "bodies", label: "Bodies", kinds: ["body"], multi: true, prompt: "Select bodies to move" },
    { type: "dropdown", key: "copy", label: "Create Copy", options: [["no", "No (move)"], ["yes", "Yes (copy)"]], value: "no" },
    { type: "number", key: "dx", label: "X Distance", unit: "mm", value: 0, step: () => keyStep("mm") },
    { type: "number", key: "dy", label: "Y Distance", unit: "mm", value: 0, step: () => keyStep("mm") },
    { type: "number", key: "dz", label: "Z Distance", unit: "mm", value: 0, step: () => keyStep("mm") },
    { type: "number", key: "rx", label: "X Angle", unit: "deg", value: 0, step: () => keyStep("deg") },
    { type: "number", key: "ry", label: "Y Angle", unit: "deg", value: 0, step: () => keyStep("deg") },
    { type: "number", key: "rz", label: "Z Angle", unit: "deg", value: 0, step: () => keyStep("deg") },
    { type: "hidden", key: "pivot", value: null },
    // quick placement: 90° turns, drop to ground, centre, snap steps (movetools.js; feature requests 2026-10-21)
    { type: "custom", key: "tools", render: (c, changed) => moveToolsRow({
      get: () => c.values,
      set: (v) => { for (const k of ["dx", "dy", "dz", "rx", "ry", "rz"]) { c.values[k] = v[k]; syncField(c, k); } changed(); },
      bounds: (v) => {
        const ids = c.values.bodies.map((it) => it.body);
        const bs = c.base.bodies.filter((b) => ids.includes(b.id));
        if (!bs.length) return null;
        const pts = bs.map((b) => { try { return K.meshBody(b.shape, b.meshTol).faces.vertices; } catch (e) { return []; } });
        return movedBounds(pts, moveMatrix(v, v.pivot || bodiesCentre(c.base, ids)));
      },
    }) },
  ],
  build: (v, st) => {
    const ids = [...new Set(v.bodies.filter((it) => it.kind === "body").map((it) => it.body))];
    return { type: "move", bodies: ids, copy: v.copy === "yes", translate: [v.dx, v.dy, v.dz], rotate: [v.rx, v.ry, v.rz], pivot: v.pivot || bodiesCentre(st, ids) };
  },
  // stored as arrays; the dialog edits one number per axis
  fromFeature: (f) => {
    const t = f.translate || [0, 0, 0], r = f.rotate || [0, 0, 0];
    return { dx: t[0], dy: t[1], dz: t[2], rx: r[0], ry: r[1], rz: r[2], copy: f.copy ? "yes" : "no", pivot: f.pivot || null };
  },
  gizmo: (v, st) => {
    const ids = v.bodies.map((it) => it.body);
    if (!ids.length) return null;
    const p = v.pivot || bodiesCentre(st, ids);
    return { pivot: p, position: [p[0] + (v.dx || 0), p[1] + (v.dy || 0), p[2] + (v.dz || 0)], bodies: ids };
  },
};
/** Bounding-box centre of some bodies (modelled coordinates), from their cached display meshes. */
function bodiesCentre(st, ids) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of st.bodies) {
    if (!ids.includes(b.id)) continue;
    let vs = null;
    try { vs = K.meshBody(b.shape, b.meshTol).faces.vertices; } catch (e) { continue; }
    for (let i = 0; i < vs.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], vs[i + k]); hi[k] = Math.max(hi[k], vs[i + k]); }
  }
  return Number.isFinite(lo[0]) ? lo.map((x, k) => +((x + hi[k]) / 2).toFixed(4)) : [0, 0, 0];
}
function updateGizmo(c) {
  const spec = c.def.gizmo && c.def.gizmo(c.values, c.base);
  if (!spec) { vp.hideGizmo(); return; }
  if (!vp.gizmo) {
    vp.showGizmo({
      position: spec.position,
      onStart: () => {
        const g = c.def.gizmo(c.values, c.base);
        c.gz = { v0: { ...c.values }, pivot: g.pivot, bodies: g.bodies };
        if (c.shown !== c.base) { show(c.base); c.shown = c.base; } // cheap live preview: matrices on the base bodies
        vp.setPreviewTool(null);
      },
      onDrag: (d, e) => {
        if (!c.gz) return;
        const snap = snapFor(e), nv = applyGizmoDelta(c.gz.v0, d, snap);
        for (const k of ["dx", "dy", "dz", "rx", "ry", "rz"]) { c.values[k] = nv[k]; syncField(c, k); }
        showReadout(e, readoutText(d, nv, snap, (x) => `${fmtLen(x)} ${unitLabel()}`));
        const M = moveMatrix(nv, c.gz.pivot), base = (asmUI && asmUI.transformsFor(c.base)) || {};
        const get = (id) => (typeof base.get === "function" ? base.get(id) : base[id]);
        const xf = {};
        for (const bv of vp.bodyViews) {
          const C = get(bv.id);
          xf[bv.id] = c.gz.bodies.includes(bv.id) ? (C ? mulCols(C, M) : M) : C || null;
        }
        vp.setBodyTransforms(xf);
        vp.setGizmoPosition([c.gz.pivot[0] + nv.dx, c.gz.pivot[1] + nv.dy, c.gz.pivot[2] + nv.dz]);
      },
      onEnd: () => { c.gz = null; c.shown = null; hideReadout(); schedulePreview(); },
    });
  } else if (!c.gz) vp.setGizmoPosition(spec.position);
}
/** a·b for column-major 4×4 arrays. */
function mulCols(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return o;
}
DEFS.stock = makeStockDef({ K, placeFilter: fastenerPlaceFilter }); // Shop Stock browser (stockui.js)
DEFS.gear = makeGearDef({ // Gear Wizard (gearui.js, geometry in gears.js)
  K, faceFilter: (st, it) => it.kind === "face" && isPlanarFace(st, it),
  gearFaceFilter: (st, it) => { const b = st.bodies.find((x) => x.id === it.body); return !!(b && b.gear && !["rack", "chain", "belt"].includes(b.gear.kind)); },
  components: () => ((doc().assembly && doc().assembly.components) || []).map((c) => ({ id: c.id, name: c.name })),
  addGearAssembly: (spec) => asmUI.addGearAssembly(spec), toast,
});

// values for editing an existing feature
function valuesFromFeature(def, f, st) {
  const v = {};
  for (const fd of def.fields) {
    if (fd.type === "select") {
      let items = [];
      // a stored profile can now resolve to several pieces (older, noisier region splits): select them all
      if (fd.key === "profiles") items = (f.profiles || []).flatMap((r) => (r.kind === "profile" ? profileItems(st, r) : [itemFromRef(st, r)]));
      else if (fd.key === "edges") items = (f.edges || []).map((r) => itemFromRef(st, r, "edge"));
      else if (fd.key === "faces") items = (f.faces || []).map((r) => itemFromRef(st, r, "face"));
      else if (fd.key === "bodies") items = (f.bodies || []).filter((id) => st.bodies.some((b) => b.id === id)).map((id) => ({ kind: "body", body: id }));
      else if (fd.key === "place" && f.place) items = [itemFromRef(st, f.place, f.place.kind)];
      else if (fd.key === "partner" && f.partner) items = [itemFromRef(st, f.partner, "face")];
      else if (fd.key === "axis" && f.axis) {
        if (f.axis.kind === "line") { const sk = st.sketches[f.axis.sketch]; const e = sk && sk.entities.find((x) => x.id === f.axis.entity); if (e) items = [{ kind: "sketchline", sketch: f.axis.sketch, entity: e.id, a: e.a, b: e.b, plane: sk.plane }]; }
        else if (["X", "Y", "Z"].includes(f.axis.kind)) items = [{ kind: "axis", name: f.axis.kind }];
      } else if (fd.key === "base" && f.base) {
        if (f.base.kind === "origin") items = [{ kind: "plane", planeRef: { kind: "origin", name: f.base.name }, plane: K.ORIGIN_PLANES[f.base.name] }];
        else if (f.base.kind === "cplane" && st.planes[f.base.id]) items = [{ kind: "plane", planeRef: { kind: "cplane", id: f.base.id }, plane: st.planes[f.base.id].plane }];
        else if (f.base.kind === "face") items = [itemFromRef(st, f.base.ref, "face")];
      }
      v[fd.key] = items.filter(Boolean);
    } else v[fd.key] = f[fd.key] ?? fd.value;
  }
  if (def.fromFeature) Object.assign(v, def.fromFeature(f));
  return v;
}

// ======================= commands =======================
// origin axes become pickable (all three visible) while an axis selection is active
function showAxesForPick(on) {
  vp.axisLines[2].visible = on;
  if (on) vp.axisLines[0].visible = vp.axisLines[1].visible = true;
  else applyVisibility(app.mode === "sketch" ? app.sk.base : app.state);
  vp.requestRender();
}
function cancelCommand() {
  const c = app.cmd;
  if (!c) return;
  logEvent("command cancelled", { name: c.type || c.kind });
  app.cmd = null;
  if (c.onCancel) c.onCancel(); // e.g. assembly commands restore their live preview
  showAxesForPick(false);
  vp.hideArrow(); vp.hideGizmo();
  vp.setPreviewTool(null);
  vp.setOriginPlanesVisible(false);
  closeDialog();
  setTip("");
  if (c.kind === "feature" || c.kind === "measure") show(app.state);
  refreshHighlights(); refreshTimeline(); buildToolbar();
}

function startFeature(type, editIndex = null) {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const def = DEFS[type];
  const editing = editIndex != null;
  const base = editing ? K.evaluate(doc().features, editIndex) : app.state;
  let values;
  if (editing) values = valuesFromFeature(def, doc().features[editIndex], base);
  else {
    values = {};
    for (const fd of def.fields) values[fd.key] = fd.type === "select" ? [] : fd.value;
    // consume compatible pre-selection (Fusion behaviour)
    const firstSel = def.fields.find((f) => f.type === "select");
    if (firstSel) {
      const pre = app.selection.filter((it) => firstSel.kinds.includes(it.kind) && (!firstSel.filter || firstSel.filter(base, it)));
      values[firstSel.key] = firstSel.multi ? pre : pre.slice(0, 1);
    }
  }
  app.selection = [];
  const c = { kind: "feature", type, def, values, base, editIndex, active: null };
  logEvent("command started", { name: type, edit: editIndex });
  app.cmd = c;
  if (!editing) app.lastCmd = type;
  // activate the first empty selection field
  const sels = def.fields.filter((f) => f.type === "select");
  c.active = (sels.find((f) => !values[f.key].length) || (editing ? null : null))?.key ?? null;
  // editing (every field filled): the first selection field is active, so clicks add / remove items
  // (bug report 2026-10-18 18:47: a hole profile couldn't be deselected while re-editing an extrude)
  if (!c.active && sels.length) c.active = sels[0].key;
  // consumed sketches are auto-hidden; while editing, show the ones this feature uses so their profiles
  // can be seen and picked (bug report 2026-10-18 18:47 "the sketch was hidden when I went back")
  if (editing) c.showSketches = new Set(Object.values(values).flat().filter((it) => it && it.kind === "profile").map((it) => it.sketch));
  if (editing) show(base);
  openFeatureDialog(c);
  setupArrow(c);
  schedulePreview();
  refreshTimeline(); buildToolbar();
}

function commandReady(c) {
  return c.def.fields.every((f) => f.type !== "select" || f.optional || c.values[f.key].length > 0);
}
let previewQueued = false;
function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => { previewQueued = false; runPreview(); });
}
function runPreview() {
  const c = app.cmd;
  if (!c || c.kind !== "feature") return;
  let err = null, tool = null, result = null, op = null;
  if (commandReady(c)) {
    let f = null;
    try { f = (c.def.previewBuild || c.def.build)(c.values, c.base); } catch (e) { err = e.message; }
    if (f) {
      op = f.operation === "auto" || !f.operation ? (f.type === "extrude" ? K.autoOperation(c.base, f) : c.base.bodies.length ? "join" : "new") : f.operation;
      if ((f.type === "extrude" || f.type === "revolve") && (op === "join" || op === "new")) {
        // join / new previews show the base plus the translucent tool, so skip the boolean: fusing into a
        // big STEP import on every drag made the extrude dialog crawl (bug report 2026-10-18 18:44)
        try { tool = K.featureTool(c.base, f); result = c.base; } catch (e) { err = e.message; }
      } else {
        const r = K.previewFeature(c.base, f);
        err = r.error; tool = r.state.lastTool; result = r.state;
      }
      if (c.opSelect && (f.operation === "auto" || !f.operation)) c.opSelect.value = op;
    }
  }
  // joins preview as base + translucent tool; cuts/intersects show the live result (Fusion-style)
  if (c.def.onPreview) c.def.onPreview(c);
  const want = !result || err ? c.base : tool && (op === "join" || op === "new") ? c.base : result;
  if (c.shown !== want) { show(want); c.shown = want; }
  const color = { join: COLORS.join, cut: COLORS.cut, intersect: 0x9a5ad0, new: COLORS.newBody }[op] || COLORS.join;
  // the tool is in modelled coordinates: draw it in the placement of the sketch / body it starts from
  const src = Object.values(c.values).find((v) => Array.isArray(v) && v[0] && (v[0].kind === "profile" || v[0].kind === "face"));
  const xkey = src ? (src[0].kind === "profile" ? `sk:${src[0].sketch}` : src[0].body) : null;
  vp.setPreviewTool(err ? null : tool, color, xkey ? vp.bodyXform(xkey) : null);
  if (c.errEl) { c.errEl.textContent = err || ""; c.errEl.classList.toggle("show", !!err); }
  refreshHighlights();
  updateArrow(c);
  updateGizmo(c);
}
function setupArrow(c) {
  c.arrowInput = null;
  updateArrow(c);
}
function updateArrow(c) {
  const spec = c.def.arrow && c.def.arrow(c.values, c.base);
  if (!spec) { vp.hideArrow(); if (c.arrowBox) { c.arrowBox.remove(); c.arrowBox = null; } return; }
  const sameSpot = vp.arrow && vp.arrow.key === spec.key && JSON.stringify(vp.arrow.origin) === JSON.stringify(spec.origin) && JSON.stringify(vp.arrow.dir) === JSON.stringify(spec.dir);
  if (!sameSpot) {
    vp.showArrow({
      ...spec, value: c.values[spec.key],
      onDrag: (v) => {
        if (spec.min != null) v = Math.max(spec.min, v);
        const step = spec.step && Math.abs(v) < 20 ? spec.step : v > 100 || v < -100 ? 1 : 0.5;
        c.values[spec.key] = Math.max(spec.min ?? -Infinity, +(Math.round(v / step) * step).toFixed(6));
        syncField(c, spec.key);
        schedulePreview();
      },
    });
  } else if (!vp.drag || vp.drag.mode !== "arrow") { vp.arrow.value = c.values[spec.key]; vp.positionArrow(); }
  if (!c.arrowBox) {
    const unit = c.def.fields.find((f) => f.key === spec.key).unit;
    c.arrowBox = h("div", { class: "dimbox" }, h("input", { spellcheck: "false" }), h("em", {}, unitText(unit)));
    const inp = c.arrowBox.querySelector("input");
    inp.addEventListener("input", () => { const v = parseVal(inp.value, unit); if (isFinite(v)) { c.values[spec.key] = v; syncField(c, spec.key, true); schedulePreview(); } });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); okCommand(); } if (e.key === "Escape") { e.stopPropagation(); cancelCommand(); } });
    $("#hud").appendChild(c.arrowBox);
  }
  c.arrowKey = spec.key;
  positionArrowBox();
}
function positionArrowBox() {
  const c = app.cmd;
  if (!c || !c.arrowBox || !vp.arrow) return;
  // Put the box past the arrow's tip along its on-screen direction, far enough that no part of
  // the box covers the arrow (it used to sit 10 px right of the tip, on top of right-pointing
  // or foreshortened arrows). Nearly end-on arrows get it off to the upper right.
  const tip = vp.arrowTipScreen(), base = vp.worldToScreen(vp.arrow.grp.position), host = $("#hud").getBoundingClientRect();
  let ux = tip.x - base.x, uy = tip.y - base.y;
  const len = Math.hypot(ux, uy);
  if (len > 2) { ux /= len; uy /= len; } else { ux = Math.SQRT1_2; uy = -Math.SQRT1_2; }
  const w = c.arrowBox.offsetWidth || 100, hgt = c.arrowBox.offsetHeight || 22;
  const reach = Math.abs(ux) * w / 2 + Math.abs(uy) * hgt / 2; // box half-extent along the arrow
  const along = Math.max(len, 0) + (len < 30 ? 22 : 14) + reach; // clear the arrow head (and its grab zone)
  const cx = base.x + ux * along, cy = base.y + uy * along;
  c.arrowBox.style.left = `${Math.max(4, Math.min(host.width - w - 4, cx - host.left - w / 2))}px`;
  c.arrowBox.style.top = `${Math.max(4, Math.min(host.height - hgt - 4, cy - host.top - hgt / 2))}px`;
  const inp = c.arrowBox.querySelector("input");
  if (document.activeElement !== inp) inp.value = fmtVal(c.values[c.arrowKey], fieldUnit(c, c.arrowKey));
}
function fieldUnit(c, key) { const fd = c.def.fields.find((f) => f.key === key); return fd && fd.unit; }
function syncField(c, key, fromArrowBox) {
  const el = c.fieldInputs && c.fieldInputs[key];
  if (el && document.activeElement !== el) el.value = fmtVal(c.values[key], fieldUnit(c, key));
  if (!fromArrowBox) positionArrowBox();
}
function okCommand() {
  const c = app.cmd;
  if (!c) return;
  if (c.kind !== "feature") { if (c.onOK) c.onOK(); else cancelCommand(); return; }
  if (!commandReady(c)) { toast(c.def.fields.find((f) => f.type === "select" && !f.optional && !c.values[f.key].length).prompt); return; }
  let f;
  try { f = c.def.build(c.values, c.base); } catch (e) { toast(e.message); return; }
  const r = K.previewFeature(c.base, f);
  if (r.error) { toast(r.error); return; }
  pushUndo();
  logEvent("command ok", { name: c.type, feature: f });
  let saved;
  if (c.editIndex != null) {
    const old = doc().features[c.editIndex];
    saved = doc().features[c.editIndex] = { ...f, id: old.id, name: old.name };
  } else {
    saved = { ...f, id: fid(), name: nextName(f.type) };
    doc().features.splice(doc().marker, 0, saved);
    doc().marker++;
    // Fusion auto-hides a sketch once a feature consumes its profiles
    const used = (f.profiles || []).filter((r) => r.kind === "profile").map((r) => r.sketch);
    if (used.length) doc().hidden = [...new Set([...doc().hidden, ...used])];
  }
  app.cmd = null;
  vp.hideArrow(); vp.hideGizmo(); vp.setPreviewTool(null); closeDialog(); setTip("");
  vp.axisLines[2].visible = false;
  regen(); buildToolbar();
  // e.g. the Gear Wizard wires its new gears into the assembly
  if (c.def.after) { try { c.def.after(saved, c, app.state); } catch (e) { toast(e.message); } }
}

// ---------- create sketch ----------
function startCreateSketch() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const pre = app.selection.find((it) => it.kind === "plane" || (it.kind === "face" && isPlanarFace(app.state, it)));
  app.selection = [];
  if (pre) { beginSketch(pre); return; }
  app.cmd = { kind: "pickPlane" };
  app.lastCmd = "sketch";
  vp.setOriginPlanesVisible(true);
  setTip("Select a plane or planar face");
  refreshHighlights(); buildToolbar();
}
function beginSketch(it) {
  app.cmd = null;
  vp.setOriginPlanesVisible(false);
  setTip("");
  let plane, planeRef, entities = [];
  if (it.kind === "plane") { plane = it.plane; planeRef = it.planeRef; }
  else {
    const face = K.faceOf(app.state, it.body, it.idx);
    plane = K.planeFromFace(face);
    planeRef = { kind: "face", ref: refFromItem(app.state, it) };
    try { entities = K.projectFaceEdges(face, plane); } catch (e) { entities = []; }
  }
  const feature = { id: fid(), type: "sketch", name: nextName("sketch"), plane, planeRef };
  // new sketches start with the projected origin, plus the face's edges (fixed) when sketching on a face
  const model = SM.addFlat(SM.emptyModel(K.to2D(plane, [0, 0, 0])), entities, { fixed: true, projected: true });
  enterSketch(feature, null, model);
}
function enterSketch(feature, editIndex, model) {
  cancelCommand();
  logEvent("sketch enter", { name: feature.name, plane: feature.plane, planeRef: feature.planeRef, editIndex });
  app.mode = "sketch";
  const base = editIndex == null ? app.state : K.evaluate(doc().features, editIndex);
  let plane = feature.plane;
  if (feature.planeRef && feature.planeRef.kind === "cplane" && base.planes[feature.planeRef.id]) plane = base.planes[feature.planeRef.id].plane;
  const model2d = model || SM.normalizeSketch(feature, K.to2D(plane, [0, 0, 0]));
  app.selection = [];
  show(base, { activeSketchId: feature.id });
  // a sketch on a placed component's face is edited where that component is shown; its 2D coordinates
  // are the same in both frames, so only the plane the sketcher draws on moves (bug report 2026-10-18 18:33)
  const pr = feature.planeRef;
  const xkey = pr && pr.kind === "face" && pr.ref ? pr.ref.body : pr && pr.kind === "cplane" ? `pl:${pr.id}` : null;
  const viewPlane = transformPlane(plane, xkey ? vp.bodyXform(xkey) : null);
  app.sk = { feature, editIndex, base, plane: viewPlane, modelPlane: plane };
  refreshHighlights();
  sketcher.begin({ plane: viewPlane, model: model2d, name: feature.name });
  // orthographic while sketching (feature request 2026-10-18 18:32; Settings > Viewport); restored on finish
  scheduleCutEdges();
  if (getPref("sketchOrtho", true) !== false && vp.cameraMode !== "orthographic") { app.sk.restoreCam = vp.cameraMode; vp.setCameraMode("orthographic", { persist: false }); }
  vp.lookAtPlane(viewPlane);
  buildToolbar(); showPalette(); refreshTimeline(); refreshBrowser();
}
// Cut edges (feature request 2026-10-18 18:42): where the sketch plane slices each visible body, computed
// one body per tick after the sketch opens (a 1,700-face STEP takes ~1.6 s), cached per shape + plane.
// Each body is cut in its modelled frame (the plane moved back by its placement); 2D coordinates match.
const cutCache = new WeakMap(); // shape -> Map(planeKey -> entities)
function scheduleCutEdges() {
  const sk = app.sk;
  if (!sk) return;
  const views = vp.bodyViews.filter((v) => v.grp.visible);
  const out = [];
  let i = 0;
  const step = () => {
    if (app.sk !== sk || app.mode !== "sketch") return;
    if (i >= views.length) { sketcher.setCutEdges(out); if (out.length) setTip(`Dashed purple: where this sketch plane cuts the bodies (snap to it, or SKETCH > CREATE > Intersect to add it)`); return; }
    const v = views[i++], b = sk.base.bodies.find((x) => x.id === v.id);
    if (b && !b.meshTol) {
      const pl = transformPlane(sk.plane, invertRigid(vp.bodyXform(v.id)));
      const key = [...pl.origin, ...pl.normal, ...pl.xDir].map((x) => x.toFixed(5)).join(",");
      let per = cutCache.get(b.shape);
      if (!per) cutCache.set(b.shape, (per = new Map()));
      if (!per.has(key)) {
        const g = v.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        try { per.set(key, K.sectionEntities(b.shape, pl, [bb.min.toArray(), bb.max.toArray()])); } catch (e) { per.set(key, []); }
      }
      out.push(...per.get(key));
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 150);
}
function sketchIntersect() {
  if (app.mode !== "sketch") return;
  if (!sketcher.cutEdges.length) { toast("The sketch plane doesn't cut any visible body (or the cut edges are still being computed)"); return; }
  const n = sketcher.addCutEdges();
  logEvent("sketch intersect", { added: n });
  toast(n ? `Added ${n} cut edge${n > 1 ? "s" : ""} to the sketch (fixed, purple)` : "The cut edges are already in the sketch");
}
function finishSketch() {
  if (app.mode !== "sketch") return;
  const model = sketcher.end();
  const { feature, editIndex } = app.sk;
  logEvent("sketch finish", { name: feature.name, entities: model.entities.length, constraints: model.constraints.length });
  pushUndo();
  const data = { points: model.points, entities: model.entities, constraints: model.constraints };
  if (editIndex == null) {
    doc().features.splice(doc().marker, 0, { ...feature, ...data });
    doc().marker++;
  } else doc().features[editIndex] = { ...doc().features[editIndex], ...data };
  // undo the sketch's temporary orthographic camera, unless the user picked another mode meanwhile
  if (app.sk.restoreCam && vp.cameraMode === "orthographic") vp.setCameraMode(app.sk.restoreCam, { persist: false });
  app.mode = "model"; app.sk = null;
  hidePalette(); setTip("");
  regen(); buildToolbar();
}
// Move/Copy: components (Assembly workspace, or bodies that belong to one) move by their placement;
// plain bodies get a timeline Move feature with the gizmo (DEFS.move)
function startMove() {
  const a = doc().assembly;
  const inComp = app.selection.some((it) => it.body && a && a.components && componentOfBody(a, it.body));
  if (workspaceId() === "assembly" || inComp) { asmUI.move(); return; }
  app.selection = [...new Set(app.selection.filter((it) => it.body).map((it) => it.body))].map((body) => ({ kind: "body", body }));
  startFeature("move");
}
// ---------- copy / paste (feature request 2026-10-20 "copy sketches or parts from the history or design browser") ----------
// Bodies paste as a Move/Copy feature with "Create Copy" on and the gizmo up, so the copy can be dragged into place.
// Sketches paste as a new sketch feature, on the selected plane / planar face if there is one, else on the source's plane.
function copyBodies(ids) {
  ids = [...new Set(ids)].filter((id) => app.state.bodies.some((b) => b.id === id));
  if (!ids.length) { toast("Select a body or sketch to copy"); return; }
  app.clip = { kind: "bodies", ids, doc: doc().id };
  const names = ids.map((id) => app.state.bodies.find((b) => b.id === id).name);
  logEvent("copy", { bodies: ids });
  toast(`Copied ${names.join(", ")}. Paste (Ctrl+V) to place a copy with the move gizmo.`);
}
function copySketch(featureId) {
  const f = doc().features.find((x) => x.id === featureId && x.type === "sketch");
  if (!f) return;
  app.clip = { kind: "sketch", feature: JSON.parse(JSON.stringify(f)), plane: sketchPlaneOf(app.state, f), doc: doc().id };
  logEvent("copy", { sketch: f.name });
  toast(`Copied ${f.name}. Select a plane or planar face, then Paste (Ctrl+V); with nothing selected it pastes on the same plane.`);
}
/** Bodies made (or else changed) by timeline feature i that still exist. */
function bodiesOfFeature(i) {
  const before = K.evaluate(doc().features, i), after = K.evaluate(doc().features, i + 1);
  const had = new Map(before.bodies.map((b) => [b.id, b.shape]));
  const live = new Set(app.state.bodies.map((b) => b.id));
  const made = after.bodies.filter((b) => !had.has(b.id)).map((b) => b.id).filter((id) => live.has(id));
  return made.length ? made : after.bodies.filter((b) => had.has(b.id) && had.get(b.id) !== b.shape).map((b) => b.id).filter((id) => live.has(id));
}
function copyFeature(i) {
  const f = doc().features[i];
  if (!f) return;
  if (f.type === "sketch") { copySketch(f.id); return; }
  if (i >= doc().marker) { toast("Roll the history marker past this feature first"); return; }
  const ids = bodiesOfFeature(i);
  if (!ids.length) { toast(`${f.name} has no body to copy`); return; }
  copyBodies(ids);
}
function copySelection() {
  const ids = app.selection.filter((it) => it.body).map((it) => it.body);
  if (ids.length) { copyBodies(ids); return; }
  if (ui.sketchSel && doc().features.some((f) => f.id === ui.sketchSel)) { copySketch(ui.sketchSel); return; }
  toast("Select a body or sketch to copy");
}
/** Marking-menu list entries in model mode: right-clicking a body selects it (when nothing is selected) and offers Move/Copy, Copy, Paste. */
function modelContextItems(e) {
  if (app.cmd) return [];
  if (!app.selection.some((it) => it.body) && e && e.clientX != null) {
    let hit = null;
    try { hit = vp.pick(e.clientX, e.clientY, ["face"]); } catch (err) { hit = null; }
    if (hit && hit.body) { app.selection = [{ kind: "body", body: hit.body }]; ui.sketchSel = null; refreshHighlights(); refreshBrowser(); }
  }
  if (app.selection.some((it) => it.body)) return [...bodyMenuItems().filter((it) => it === "|" || it.label !== "Delete"), "|"];
  return app.clip ? [{ label: `Paste ${app.clip.kind === "sketch" ? "Sketch" : "Bodies"}`, icon: "paste", kb: "Ctrl+V", run: pasteClip }, "|"] : [];
}
/** Right-click menu for selected bodies (browser rows and the viewport marking menu's list). */
function bodyMenuItems() {
  const ids = [...new Set(app.selection.filter((it) => it.body).map((it) => it.body))];
  const hs = new Set(doc().hidden);
  return [
    { label: "Move/Copy", icon: "move", kb: "M", run: () => startMove() },
    { label: "Copy", icon: "copy", kb: "Ctrl+C", run: () => copyBodies(ids) },
    ...(app.clip ? [{ label: `Paste ${app.clip.kind === "sketch" ? "Sketch" : "Bodies"}`, icon: "paste", kb: "Ctrl+V", run: pasteClip }] : []),
    "|",
    { label: "Appearance", icon: "appearance", kb: "A", run: () => openAppearance("appearance") },
    ...(ids.length === 1 ? [{ label: hs.has(ids[0]) ? "Show Body" : "Hide Body", icon: hs.has(ids[0]) ? "eye" : "eyeOff", run: () => toggleVisible(ids[0]) }] : []),
    { label: "Delete", icon: "trash", kb: "Del", run: deleteSelection },
  ];
}
function sketchPlaneOf(st, f) {
  if (f.planeRef && f.planeRef.kind === "cplane" && st.planes[f.planeRef.id]) return st.planes[f.planeRef.id].plane;
  return (st.sketches[f.id] && st.sketches[f.id].plane) || f.plane;
}
function pasteClip() {
  const c = app.clip;
  if (!c) { toast("Nothing copied yet: right-click a body or sketch > Copy, or Ctrl+C"); return; }
  if (c.kind === "sketch") { pasteSketch(c); return; }
  if (c.doc !== doc().id) { toast("Bodies paste into the design they came from. To bring in another design, drag it from the Parts panel."); return; }
  const ids = c.ids.filter((id) => app.state.bodies.some((b) => b.id === id));
  if (!ids.length) { toast("The copied bodies no longer exist"); return; }
  if (app.mode === "sketch") finishSketch();
  app.selection = ids.map((body) => ({ kind: "body", body }));
  startFeature("move");
  const cmd = app.cmd;
  if (!cmd || cmd.type !== "move") return;
  cmd.values.copy = "yes";
  closeDialog(); openFeatureDialog(cmd); schedulePreview();
  setTip("Drag the gizmo (or type distances / angles) to place the copy, then OK");
}
function pasteSketch(c) {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const src = c.feature;
  const pre = app.selection.find((it) => it.kind === "plane" || (it.kind === "face" && isPlanarFace(app.state, it)));
  let plane = src.plane, planeRef = src.planeRef;
  if (pre && pre.kind === "plane") { plane = pre.plane; planeRef = pre.planeRef; }
  else if (pre) { plane = K.planeFromFace(K.faceOf(app.state, pre.body, pre.idx)); planeRef = { kind: "face", ref: refFromItem(app.state, pre) }; }
  const srcPlane = c.plane || src.plane;
  const m = SM.normalizeSketch(src, K.to2D(srcPlane, [0, 0, 0]));
  // keep the shape where it sits relative to the sketch origin (the world origin projected onto the plane)
  const o0 = m.points[SM.ORIGIN] ? [m.points[SM.ORIGIN].x, m.points[SM.ORIGIN].y] : K.to2D(srcPlane, [0, 0, 0]);
  const o1 = K.to2D(plane, [0, 0, 0]);
  for (const q of Object.values(m.points)) { q.x += o1[0] - o0[0]; q.y += o1[1] - o0[1]; }
  const f = { id: fid(), type: "sketch", name: nextName("sketch"), plane, planeRef, points: m.points, entities: m.entities, constraints: m.constraints };
  pushUndo();
  const at = doc().marker;
  doc().features.splice(at, 0, f);
  doc().marker = at + 1;
  app.selection = [];
  logEvent("paste", { sketch: src.name, as: f.name, on: pre ? pre.kind : "same plane" });
  regen();
  toast(`Pasted ${f.name} (a copy of ${src.name})${pre ? "" : " on the same plane"}. Double-click it to edit.`);
}
// Document Settings > Units (per design, saved in the file; the model stays in mm)
function setDocUnits(u) {
  if (!UNITS[u] || u === units()) return;
  pushUndo();
  doc().units = u;
  logEvent("units", { units: u });
  save(); refreshBrowser();
  if (app.cmd && app.cmd.kind === "feature") { const c = app.cmd; closeDialog(); openFeatureDialog(c); if (c.arrowBox) { c.arrowBox.remove(); c.arrowBox = null; } updateArrow(c); }
  if (app.mode === "sketch") { sketcher.clearHud(); sketcher.render(); }
  toast(`Units: ${UNITS[u].plural.toLowerCase()} (${UNITS[u].label}). Values convert; the model doesn't change.`);
}
function openUnitsMenu(e) {
  openMenu(null, [{ hd: "DESIGN UNITS" }, ...Object.entries(UNITS).map(([k, u]) => ({ label: `${k === units() ? "✓ " : ""}${u.plural} (${u.label})`, icon: "gear", run: () => setDocUnits(k) }))], { x: e.clientX, y: e.clientY });
}
function editFeature(i) {
  const f = doc().features[i];
  if (!f) return;
  if (f.type === "sketch") { if (app.mode === "sketch") finishSketch(); enterSketch(f, i, null); return; }
  if (f.type === "insert") { toast(`${f.name}: an inserted design (a copy from ${f.source && f.source.file ? f.source.file : "when it was inserted"}). Delete it from the timeline to remove it.`, 5000); return; }
  if (DEFS[f.type]) startFeature(f.type, i);
}


// ---------- NACA airfoil: drops the section into a sketch (airfoil.js) ----------
// Model mode: makes a new sketch on the selected plane / planar face (or the chosen origin plane).
// Sketch mode: adds the section to the open sketch. The outline is a closed polyline with a
// construction chord line; "Lock shape" fixes its points so it behaves like projected geometry.
function startAirfoil() {
  const inSketch = app.mode === "sketch";
  const pre = !inSketch && app.selection.find((it) => it.kind === "plane" || (it.kind === "face" && isPlanarFace(app.state, it)));
  cancelCommand();
  const v = (app.airfoilPrefs = app.airfoilPrefs || { code: "2412", chord: 100, alpha: 0, n: 60, te: "closed", plane: "XZ", lock: true, u: 0, v: 0 });
  const LABELS = { chord: "Chord", alpha: "Angle of attack", n: "Points / side", u: "Leading edge X", v: "Leading edge Y" };
  const num = (key, unit, hint) => {
    const inp = h("input", { value: String(v[key]), spellcheck: "false" });
    inp.addEventListener("input", () => { const x = parseFloat(inp.value); if (isFinite(x)) { v[key] = x; draw(); } });
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ok(); });
    return h("div", { class: "dlg-row" }, h("label", { title: hint || null }, LABELS[key]), h("div", { class: "ctl" }, h("div", { class: "num" }, inp, h("em", {}, unit))));
  };
  const codeInp = h("input", { value: v.code, spellcheck: "false", placeholder: "2412" });
  codeInp.addEventListener("input", () => { v.code = codeInp.value.trim(); draw(); });
  codeInp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") ok(); });
  const sel = (key, opts) => { const s = h("select", {}, opts.map(([k, l]) => h("option", { value: k }, l))); s.value = v[key]; s.addEventListener("change", () => { v[key] = s.value; draw(); }); return s; };
  const lock = h("input", { type: "checkbox" }); lock.checked = v.lock; lock.addEventListener("change", () => { v.lock = lock.checked; });
  const pv = h("div", { class: "af-preview" });
  const info = h("div", { class: "dlg-info" });
  const err = h("div", { class: "dlg-err" });
  const planeRow = pre
    ? h("div", { class: "dlg-row" }, h("label", {}, "Plane"), h("div", { class: "ctl" }, h("span", { class: "af-plane" }, pre.kind === "plane" ? (pre.planeRef && pre.planeRef.name) || "Selected plane" : "Selected face")))
    : inSketch ? null : h("div", { class: "dlg-row" }, h("label", {}, "Plane"), h("div", { class: "ctl" }, sel("plane", [["XZ", "XZ (span along Y)"], ["XY", "XY (span along Z)"], ["YZ", "YZ (span along X)"]])));
  const rows = [
    h("div", { class: "dlg-row" }, h("label", { title: "4-digit (0012, 2412, 4415) or 5-digit (23012, 23015)" }, "NACA"), h("div", { class: "ctl" }, codeInp)),
    num("chord", "mm"), num("alpha", "deg", "Nose-up pitch about the leading edge, for flow along the sketch's +X"),
    planeRow, num("u", "mm"), num("v", "mm"),
    h("div", { class: "dlg-row" }, h("label", {}, "Trailing edge"), h("div", { class: "ctl" }, sel("te", [["closed", "Sharp (closed)"], ["blunt", "Blunt (standard)"]]))),
    num("n", "", "Cosine-spaced points on each surface (8-400)"),
    h("label", { class: "dlg-row cfd-check" }, lock, h("span", {}, "Lock shape (fixed points)")),
    pv, info, err,
  ];
  let built = null;
  function draw() {
    err.textContent = "";
    try {
      built = nacaEntities(v.code, { chord: v.chord, alpha: v.alpha, n: v.n, closedTE: v.te === "closed" });
      const pts = built.outline;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const W = 236, H = 70, sc = Math.min((W - 12) / (x1 - x0 || 1), (H - 12) / (y1 - y0 || 1));
      const X = (x) => 6 + (x - x0) * sc + ((W - 12) - (x1 - x0) * sc) / 2, Y = (y) => H - 6 - (y - y0) * sc - ((H - 12) - (y1 - y0) * sc) / 2;
      pv.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"><path d="${pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(" ")}Z" fill="var(--af-fill)" stroke="var(--af-line)" stroke-width="1.2"/></svg>`;
      const s = built.sec;
      info.innerHTML = `${built.name}: max thickness <b>${fmt(s.t * v.chord, 2)} mm</b> (${fmt(s.t * 100, 1)} %)${s.series === 5 ? `, design C<sub>l</sub> ${fmt(s.cl, 2)}` : s.m ? `, camber ${fmt(s.m * 100, 1)} % at ${fmt(s.p * 100, 0)} %` : ", symmetric"}`;
    } catch (e) { built = null; pv.innerHTML = ""; info.innerHTML = ""; err.textContent = e.message; }
  }
  function ok() {
    draw();
    if (!built) { toast(err.textContent || "Check the NACA number"); return; }
    const ents = nacaEntities(v.code, { chord: v.chord, alpha: v.alpha, n: v.n, closedTE: v.te === "closed", origin: [v.u, v.v] }).entities;
    logEvent("airfoil", { code: v.code, chord: v.chord, alpha: v.alpha, inSketch });
    app.cmd = null; closeDialog(); setTip("");
    if (inSketch) {
      sketcher.snapshot();
      SM.addFlat(sketcher.m, ents, { fixed: v.lock });
      sketcher.afterChange();
      toast(`${built.name} added to the sketch`);
      return;
    }
    let plane, planeRef;
    if (pre && pre.kind === "plane") { plane = pre.plane; planeRef = pre.planeRef; }
    else if (pre) { plane = K.planeFromFace(K.faceOf(app.state, pre.body, pre.idx)); planeRef = { kind: "face", ref: refFromItem(app.state, pre) }; }
    else { plane = K.ORIGIN_PLANES[v.plane]; planeRef = { kind: "origin", name: v.plane }; }
    const model = SM.addFlat(SM.emptyModel(K.to2D(plane, [0, 0, 0])), ents, { fixed: v.lock });
    pushUndo();
    nextName("sketch");
    doc().features.splice(doc().marker, 0, { id: fid(), type: "sketch", name: `${built.name} · ${fmt(v.chord, 1)} mm`, plane, planeRef, points: model.points, entities: model.entities, constraints: model.constraints });
    doc().marker++;
    app.selection = [];
    regen(); buildToolbar();
    toast(`${built.name} sketch created: extrude its profile, or run 2D Flow on it`);
  }
  app.cmd = { kind: "airfoil", onOK: ok };
  app.lastCmd = "airfoil";
  dialogFrame("NACA Airfoil", "airfoil", rows.filter(Boolean), { ok: inSketch ? "Add to Sketch" : "Create Sketch" });
  draw();
  setTimeout(() => { codeInp.focus(); codeInp.select(); }, 0);
}

// ---------- measure ----------
function startMeasure() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  app.cmd = { kind: "measure", items: app.selection.filter((it) => it.kind === "face" || it.kind === "edge").slice(0, 2) };
  app.selection = [];
  app.lastCmd = "measure";
  openMeasureDialog();
  setTip("Select faces or edges to measure");
  refreshHighlights(); buildToolbar();
}
function measureText() {
  const items = app.cmd.items, st = app.state;
  if (!items.length) return "Select one or two faces/edges.";
  const geo = (it) => (it.kind === "face" ? K.faceOf(st, it.body, it.idx) : K.edgeOf(st, it.body, it.idx));
  const desc = (it) => {
    const b = st.bodies.find((x) => x.id === it.body).shape;
    if (it.kind === "face") { const f = K.faceInfo(b, it.idx); return `Face (${f.type.toLowerCase()}) — Area <b>${fmtArea(f.area)}</b>`; }
    const e = K.edgeInfo(b, it.idx); return `Edge (${e.type.toLowerCase()}) — Length <b>${fmtLen(e.length)} ${unitLabel()}</b>`;
  };
  let html = items.map((it, i) => `Selection ${i + 1}: ${desc(it)}`).join("<br>");
  if (items.length === 2) { try { html += `<br>Minimum distance: <b>${fmtLen(K.distanceBetween(geo(items[0]), geo(items[1])))} ${unitLabel()}</b>`; } catch (e) {} }
  return html;
}

// ======================= picking & selection =======================
function pickKinds() {
  const c = app.cmd;
  if (app.mode === "sketch") return [];
  if (!c) return ["edge", "face", "profile"];
  if (c.kind === "pickPlane") return ["plane", "face"];
  if (c.kind === "measure") return ["edge", "face"];
  if (c.pickKinds) return c.pickKinds(); // assembly commands
  if (c.kind === "feature") return [...new Set(candidateFields(c).flatMap((f) => f.kinds))];
  return [];
}
// the active selection field, plus any still-empty ones (so e.g. Revolve's axis can be picked straight after the profile)
function candidateFields(c) {
  return c.def.fields.filter((f) => f.type === "select" && (f.key === c.active || !c.values[f.key].length));
}
function fieldFor(c, it) {
  const ok = (f) => f.kinds.includes(it.kind) && (!f.filter || f.filter(c.base, it));
  const active = c.def.fields.find((f) => f.key === c.active);
  if (active && ok(active)) return active;
  return candidateFields(c).find(ok) || null;
}
function pickFilter(it) {
  const c = app.cmd;
  if (!it) return null;
  if (c && c.kind === "pickPlane" && it.kind === "face" && !isPlanarFace(app.state, it)) return null;
  if (c && c.kind === "feature" && !fieldFor(c, it)) return null;
  if (c && c.pickFilter && !c.pickFilter(it)) return null; // e.g. the FEA study's face picker
  return it;
}
function pickAt(e) {
  let it = vp.pick(e.clientX, e.clientY, pickKinds());
  const c = app.cmd;
  if (c && c.kind === "feature" && c.shown && c.shown !== c.base) it = mapItem(c.shown, c.base, it);
  return pickFilter(it);
}
function onMove(e) {
  updateTipPos(e);
  if (app.mode === "sketch") { sketcher.move(e); return; }
  const it = pickAt(e);
  const k = it ? itemKey(it) : null;
  if (k !== (app.hover ? itemKey(app.hover) : null)) { app.hover = it; refreshHighlights(); }
}
function onClick(e) {
  if (app.mode === "sketch") { sketcher.click(e); return; }
  const it = pickAt(e);
  const c = app.cmd;
  logEvent("pick", { item: it, cmd: c && (c.type || c.kind), field: c && c.active });
  if (c && c.kind === "pickPlane") { if (it) beginSketch(it); return; }
  if (c && c.onPick) { c.onPick(it, e); return; } // assembly commands
  if (c && c.kind === "measure") {
    if (!it) { c.items = []; }
    else { const i = c.items.findIndex((x) => itemKey(x) === itemKey(it)); if (i >= 0) c.items.splice(i, 1); else { if (c.items.length >= 2) c.items.shift(); c.items.push(it); } }
    $("#measureInfo").innerHTML = measureText();
    refreshHighlights();
    return;
  }
  if (c && c.kind === "feature") {
    const fd = it && fieldFor(c, it);
    if (!fd) return;
    c.active = fd.key;
    const list = c.values[fd.key];
    const i = list.findIndex((x) => itemKey(x) === itemKey(it));
    if (i >= 0) list.splice(i, 1);
    else if (fd.multi) list.push(it);
    else { list.length = 0; list.push(it); }
    if (!fd.multi && list.length) {
      const next = c.def.fields.find((f) => f.type === "select" && !c.values[f.key].length);
      if (next) c.active = next.key;
    }
    refreshDialogSelections(c);
    schedulePreview();
    return;
  }
  // plain selection
  if (!it) { app.selection = []; }
  else if (e.shiftKey || e.ctrlKey) {
    const i = app.selection.findIndex((x) => itemKey(x) === itemKey(it));
    if (i >= 0) app.selection.splice(i, 1); else app.selection.push(it);
  } else app.selection = [it];
  refreshHighlights(); refreshBrowser();
}
function onDblClick(e) {
  if (app.mode === "sketch") { sketcher.dblclick(e); return; }
  if (app.cmd) return;
  // double-click a profile to edit its sketch
  const it = vp.pick(e.clientX, e.clientY, ["profile"]);
  if (it && it.kind === "profile") { const i = doc().features.findIndex((f) => f.id === it.sketch); if (i >= 0) editFeature(i); }
}
function refreshHighlights() {
  const list = [];
  const c = app.cmd;
  // face/edge indices refer to the base bodies, so skip them while the live result is displayed
  const showingResult = c && c.kind === "feature" && c.shown && c.shown !== c.base;
  const shownItem = (it) => (showingResult ? mapItem(c.base, c.shown, it) : it);
  if (c && c.kind === "feature") for (const f of c.def.fields) if (f.type === "select") for (const it of c.values[f.key]) { const m = shownItem(it); if (m) list.push({ item: m, style: "select" }); }
  if (c && c.kind === "measure") for (const it of c.items) list.push({ item: it, style: "select" });
  for (const it of app.selection) list.push({ item: it, style: "select" });
  const hov = app.hover && (c && c.kind === "feature" ? shownItem(app.hover) : app.hover);
  if (hov && !list.some((x) => itemKey(x.item) === itemKey(hov))) list.push({ item: hov, style: "hover" });
  if (asmUI) list.push(...asmUI.highlights()); // joint glyphs + assembly command picks
  vp.setHighlights(list);
}

// ======================= dialogs =======================
const dialogEl = () => $("#dialog");
function closeDialog() { dialogEl().classList.add("hidden"); dialogEl().innerHTML = ""; $("#hud").querySelectorAll(".dimbox").forEach((d) => { if (!sketcher || !sketcher.hud.contains(d) || app.mode !== "sketch") d.remove(); }); }
function dialogFrame(title, icon, bodyEls, { ok = "OK", onOK = okCommand, onCancel = cancelCommand } = {}) {
  const d = dialogEl();
  d.innerHTML = "";
  const head = h("div", { class: "dlg-head" }, ico(icon), h("span", {}, title), h("button", { class: "x", title: "Cancel", html: icons.close, onclick: onCancel }));
  const foot = h("div", { class: "dlg-foot" }, h("button", { class: "help", html: icons.help, title: "Help" }), h("div", { class: "sp" }), h("button", { class: "btn primary", onclick: onOK }, ok), h("button", { class: "btn", onclick: onCancel }, "Cancel"));
  d.append(head, h("div", { class: "dlg-body" }, bodyEls), foot);
  d.classList.remove("hidden");
  makeDraggable(d, head);
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
function openFeatureDialog(c) {
  const rows = [];
  c.fieldInputs = {}; c.selBtns = {}; c.rowEls = {};
  for (const fd of c.def.fields) {
    let ctl;
    if (fd.type === "hidden") continue;                // value only (e.g. stock params)
    if (fd.type === "custom") { const row = h("div", { class: "dlg-row wide" }, fd.render(c, () => { refreshRows(c); schedulePreview(); })); c.rowEls[fd.key] = row; rows.push(row); continue; } // stockui.js browser
    if (fd.type === "select") {
      const btn = h("button", { class: "sel-btn", onclick: () => { c.active = fd.key; refreshDialogSelections(c); app.hover = null; refreshHighlights(); } });
      c.selBtns[fd.key] = btn;
      ctl = btn;
    } else if (fd.type === "number") {
      const inp = h("input", { value: fmtVal(c.values[fd.key], fd.unit), spellcheck: "false" });
      inp.addEventListener("input", () => { const v = parseVal(inp.value, fd.unit); if (isFinite(v)) { c.values[fd.key] = v; schedulePreview(); } });
      inp.addEventListener("keydown", (e) => {
        const step = fd.step ? fd.step() : isLenUnit(fd.unit) ? fromDisp(1) : 1; // one display unit (Move: its snap step)
        if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); c.values[fd.key] = +(c.values[fd.key] + (e.key === "ArrowUp" ? step : -step)).toFixed(6); inp.value = fmtVal(c.values[fd.key], fd.unit); schedulePreview(); }
      });
      inp.addEventListener("change", () => { inp.value = fmtVal(c.values[fd.key], fd.unit); }); // "1in + 3" → its value
      c.fieldInputs[fd.key] = inp;
      ctl = h("div", { class: "num" }, inp, h("em", {}, unitText(fd.unit)));
    } else if (fd.type === "dropdown") {
      const sel = h("select", {}, fd.options.map(([v, l]) => h("option", { value: v }, l)));
      sel.value = fd.key === "operation" && c.values[fd.key] === "auto" ? (c.base.bodies.length ? "join" : "new") : c.values[fd.key];
      sel.addEventListener("change", () => { c.values[fd.key] = sel.value; refreshRows(c); schedulePreview(); });
      if (fd.key === "operation") c.opSelect = sel;
      ctl = sel;
    }
    const row = h("div", { class: "dlg-row" }, h("label", { title: fd.hint || null }, fd.label), h("div", { class: "ctl" }, ctl));
    c.rowEls[fd.key] = row;
    rows.push(row);
  }
  c.errEl = h("div", { class: "dlg-err" });
  rows.push(c.errEl);
  dialogFrame(c.editIndex != null ? `Edit ${c.def.title}` : c.def.title, c.def.icon, rows);
  refreshDialogSelections(c);
  refreshRows(c);
}
function refreshRows(c) {
  for (const fd of c.def.fields) if (fd.showIf) c.rowEls[fd.key].classList.toggle("hidden", !fd.showIf(c.values));
}
function refreshDialogSelections(c) {
  for (const fd of c.def.fields) {
    if (fd.type !== "select") continue;
    const btn = c.selBtns[fd.key], n = c.values[fd.key].length;
    btn.className = `sel-btn${c.active === fd.key ? " active" : ""}${n ? " filled" : ""}`;
    btn.innerHTML = "";
    btn.append(ico("select", "arrow"), h("span", { class: "cnt" }, n ? `${n} selected` : "Select"));
    if (n) btn.append(h("i", { class: "clr", html: icons.close, title: "Clear", onclick: (e) => { e.stopPropagation(); c.values[fd.key] = []; c.active = fd.key; refreshDialogSelections(c); schedulePreview(); } }));
  }
  const fd = c.active && c.def.fields.find((f) => f.key === c.active);
  setTip(fd && !c.values[fd.key].length ? fd.prompt : "");
  showAxesForPick(candidateFields(c).some((f) => f.kinds.includes("axis")));
}
function openMeasureDialog() {
  dialogFrame("Measure", "measure", [h("div", { class: "dlg-info", id: "measureInfo", html: measureText() })], { ok: "Close" });
}

// ---------- sketch palette ----------
function showPalette() {
  const p = $("#palette");
  const o = sketcher.options;
  const cb = (key, label, onchange) => {
    const inp = h("input", { type: "checkbox" }); inp.checked = !!o[key];
    inp.addEventListener("change", () => { o[key] = inp.checked; onchange && onchange(); sketcher.render(); });
    return h("label", { class: "pal-row" }, h("span", {}, label), inp);
  };
  p.innerHTML = "";
  p.append(
    h("div", { class: "dlg-head" }, ico("sketchSmall"), h("span", {}, "Sketch Palette")),
    h("div", { class: "pal-sec" },
      h("h4", {}, "Options"),
      h("div", { class: "pal-row" }, h("span", {}, "Look At"), h("button", { class: "mini", html: icons.lookat, title: "Look At", onclick: () => vp.lookAtPlane(app.sk.plane) })),
      cb("grid", "Sketch Grid"), cb("snap", "Snap to Grid"), cb("modelSnap", "Snap to Model"), cb("cutEdges", "Show Cut Edges", () => { sketcher.modelPts = null; }), cb("profiles", "Show Profile"), cb("dimensions", "Dimensions"), cb("constraints", "Constraints"), cb("construction", "Construction Lines"),
      h("div", { class: "pal-row" }, h("span", {}, "Polygon Sides"), (() => { const i = h("input", { type: "number", min: 3, max: 64, value: o.polygonSides, style: "width:50px" }); i.addEventListener("change", () => { o.polygonSides = Math.max(3, Math.min(64, parseInt(i.value) || 6)); }); return i; })()),
    ),
    h("div", { class: "pal-sec" }, h("div", { class: "pal-status", id: "sketchStatus" })),
    h("div", { class: "pal-foot" }, h("button", { class: "btn primary finish", onclick: finishSketch }, ico("finish"), "Finish Sketch")),
  );
  p.classList.remove("hidden");
  refreshSketchStatus();
}
function refreshSketchStatus() {
  const el = $("#sketchStatus");
  if (!el || app.mode !== "sketch" || !sketcher.status) return;
  const dof = sketcher.status.dof;
  el.className = `pal-status${sketcher.fullyConstrained ? " full" : ""}`;
  el.textContent = sketcher.fullyConstrained ? "Fully constrained" : sketcher.m.entities.length ? `Under-constrained · ${dof} degree${dof === 1 ? "" : "s"} of freedom` : "Empty sketch";
}
function hidePalette() { $("#palette").classList.add("hidden"); }

// ======================= toolbar =======================
const COMMANDS = {
  sketch: { label: "Create Sketch", icon: "sketch", run: startCreateSketch },
  extrude: { label: "Extrude", icon: "extrude", key: "E", run: () => startFeature("extrude") },
  revolve: { label: "Revolve", icon: "revolve", run: () => startFeature("revolve") },
  box: { label: "Box", icon: "box", run: () => startFeature("box") },
  cylinder: { label: "Cylinder", icon: "cylinder", run: () => startFeature("cylinder") },
  sphere: { label: "Sphere", icon: "sphere", run: () => startFeature("sphere") },
  // Press Pull like Fusion: a body face runs Offset Face, an edge runs Fillet, anything else Extrude
  presspull: { label: "Press Pull", icon: "presspull", key: "Q", run: () => startFeature(app.selection.length && app.selection.every((it) => it.kind === "face") ? "offsetFace" : app.selection.length && app.selection.every((it) => it.kind === "edge") ? "fillet" : "extrude") },
  offsetFace: { label: "Offset Face", icon: "offsetFace", run: () => startFeature("offsetFace") },
  appearance: { label: "Appearance (material & color)", icon: "appearance", key: "A", run: () => openAppearance("appearance") },
  physical: { label: "Physical Material", icon: "physical", run: () => openAppearance("physical") },
  fillet: { label: "Fillet", icon: "fillet", key: "F", run: () => startFeature("fillet") },
  chamfer: { label: "Chamfer", icon: "chamfer", run: () => startFeature("chamfer") },
  shell: { label: "Shell", icon: "shell", run: () => startFeature("shell") },
  plane: { label: "Offset Plane", icon: "plane", run: () => startFeature("plane") },
  measure: { label: "Measure", icon: "measure", key: "I", run: startMeasure },
  sectionAnalysis: { label: "Section Analysis", icon: "section", run: () => startSection() },
  select: { label: "Select", icon: "select", run: () => { cancelCommand(); if (app.mode === "sketch") setSketchTool("select"); } },
  delete: { label: "Delete", icon: "trash", key: "Del", run: () => deleteSelection() },
  line: { label: "Line", icon: "line", key: "L", sketch: true, run: () => setSketchTool("line") },
  rect: { label: "2-Point Rectangle", icon: "rect", key: "R", sketch: true, run: () => setSketchTool("rect") },
  rectCenter: { label: "Center Rectangle", icon: "rectCenter", sketch: true, run: () => setSketchTool("rectCenter") },
  circle: { label: "Center Diameter Circle", icon: "circle", key: "C", sketch: true, run: () => setSketchTool("circle") },
  arc: { label: "3-Point Arc", icon: "arc", key: "A", sketch: true, run: () => setSketchTool("arc") },
  arcCenter: { label: "Center Point Arc", icon: "arcCenter", sketch: true, run: () => setSketchTool("arcCenter") },
  circle2p: { label: "2-Point Circle", icon: "circle2p", sketch: true, run: () => setSketchTool("circle2p") },
  circle3p: { label: "3-Point Circle", icon: "circle3p", sketch: true, run: () => setSketchTool("circle3p") },
  polygon: { label: "Circumscribed Polygon", icon: "polygon", key: "P", sketch: true, run: () => setSketchTool("polygon") },
  dimension: { label: "Sketch Dimension", icon: "dimension", key: "D", sketch: true, run: () => setSketchTool("dimension") },
  construction: { label: "Normal / Construction", icon: "construction", key: "X", sketch: true, run: () => { sketcher.toggleConstruction(); showPalette(); } },
  sketchDelete: { label: "Delete", icon: "trash", key: "Del", sketch: true, run: () => sketcher.deleteSelected() },
  sketchIntersect: { label: "Intersect (add where the plane cuts the bodies)", icon: "section", sketch: true, run: () => sketchIntersect() },
  finish: { label: "Finish Sketch", icon: "finish", sketch: true, run: finishSketch },
  fit: { label: "Fit", icon: "fit", key: "F6", run: () => vp.fit() },
  home: { label: "Home View", icon: "home", run: () => vp.home() },
  undo: { label: "Undo", icon: "undo", key: "Ctrl+Z", run: undo },
  redo: { label: "Redo", icon: "redo", key: "Ctrl+Y", run: redo },
  // shown for the Fusion look, not built yet
  hole: { label: "Hole", icon: "hole", soon: true }, sweep: { label: "Sweep", icon: "sweep", soon: true }, loft: { label: "Loft", icon: "loft", soon: true },
  mirror: { label: "Mirror", icon: "mirror", soon: true }, pattern: { label: "Rectangular Pattern", icon: "pattern", soon: true },
  move: { label: "Move/Copy", icon: "move", key: "M", run: () => startMove() }, joint: { label: "Joint (moving: revolute, slider, cylindrical, ball)", icon: "joint", key: "J", run: () => asmUI.joint() },
  mate: { label: "Rigid Mate (lock two components together)", icon: "jointRigid", run: () => asmUI.mate() },
  newComponent: { label: "New Component", icon: "newComponent", run: () => asmUI.newComponent() },
  ground: { label: "Ground / Unground", icon: "ground", run: () => asmUI.ground() },
  drive: { label: "Drive Joints", icon: "drive", run: () => asmUI.drive() },
  midplane: { label: "Midplane", icon: "plane", soon: true }, insert: { label: "Insert CAD / Mesh (STEP, STL, OBJ)", icon: "insert", run: startImport }, exportCmd: { label: "Export", icon: "file", run: () => startExport() },
  robotExport: { label: "Export Robot (URDF / USD for Isaac Sim)", icon: "file", run: () => openRobot() },
  cfd: { label: "CFD Study", icon: "wind", run: () => openCfd() },
  fea: { label: "Static Stress", icon: "stress", run: () => openFea() },
  flow2d: { label: "2D Flow (airfoil / sketch section CFD)", icon: "flow2d", run: () => openFlow2DStudy() },
  topo: { label: "Shape Optimization (generative)", icon: "topo", run: () => openTopo() },
  airfoil: { label: "NACA Airfoil", icon: "airfoil", run: startAirfoil },
  gear: { label: "Gear Wizard (spur, helical, ring, rack, planetary)", icon: "gear", key: "G", run: () => startFeature("gear") },
  motionLink: { label: "Motion Link (gear / rack ratio between joints)", icon: "gearLink", run: () => asmUI.motionLink() },
  fastener: { label: "Fastener (bolt, screw, nut, washer)", icon: "bolt", run: () => startFeature("fastener") },
  stock: { label: "Shop Stock (extrusion, pipe, tube, bar, plate, bearings, motors, hardware)", icon: "stock", key: "K", run: () => startFeature("stock") },
  mcmaster: { label: "Insert McMaster-Carr Component", icon: "mcmaster", run: () => openMcMaster() },
  studies: { label: "Simulation Studies (show results)", icon: "studies", run: () => openStudiesMenu() },
  tapDie: { label: "Tap and Die (cut internal / external threads)", icon: "tapDie", soon: true },
  trim: { label: "Trim", icon: "line", soon: true }, offset: { label: "Offset (sketch curves)", icon: "sketchOffset", key: "O", sketch: true, run: () => setSketchTool("offset") }, sfillet: { label: "Sketch Fillet", icon: "arc", soon: true },
};
// sketch constraint tools
for (const [k, t] of Object.entries(CONSTRAINT_TOOLS)) COMMANDS[k] = { label: t.label, icon: k, sketch: true, run: () => setSketchTool(k) };
// placeholder tools on the ribbon tabs that aren't built: they show the under-construction tape and do nothing
const PLACEHOLDERS = {
  // surface
  surfExtrude: ["Extrude (surface)", "extrude"], surfRevolve: ["Revolve (surface)", "revolve"], surfSweep: ["Sweep (surface)", "sweep"], surfLoft: ["Loft (surface)", "loft"],
  patch: ["Patch", "surfPatch"], ruled: ["Ruled", "surfPatch"], surfOffset: ["Offset", "surfOffset"], thicken: ["Thicken", "thicken"], boundaryFill: ["Boundary Fill", "shell"],
  trimSurf: ["Trim", "trimSurf"], untrim: ["Untrim", "trimSurf"], extendSurf: ["Extend", "extendSurf"], stitch: ["Stitch", "stitch"], unstitch: ["Unstitch", "stitch"], reverseNormal: ["Reverse Normal", "reverseNormal"],
  // sheet metal
  smSketch: ["Create Sketch", "sketch"], flange: ["Flange", "flange"], contourFlange: ["Contour Flange", "flange"], hem: ["Hem", "bend"], bend: ["Bend", "bend"],
  unfold: ["Unfold", "unfold"], refold: ["Refold Faces", "unfold"], flatPattern: ["Create Flat Pattern", "flatPattern"], convertSheet: ["Convert to Sheet Metal", "flange"],
  smRules: ["Sheet Metal Rules", "smRules"], smExport: ["Export Flat Pattern as DXF", "file"],
  // plastic: Snap Fit and Lip come first, then Web and Rib, then the rest
  snapFit: ["Snap Fit", "snapFit"], lip: ["Lip / Groove", "lip"], web: ["Web", "web"], rib: ["Rib", "rib"],
  boss: ["Boss", "boss"], rest: ["Rest", "rest"], ruleFillet: ["Rule Fillet", "ruleFillet"], draft: ["Draft", "draft"], plasticRules: ["Plastic Rules", "smRules"],
  // CAM
  camSetup: ["New Setup", "camSetup"], camStock: ["Stock", "camStock"],
  facing: ["Face", "facing"], adaptive2d: ["2D Adaptive Clearing", "adaptive"], pocket2d: ["2D Pocket", "pocket"], contour2d: ["2D Contour", "contourPath"], slotCam: ["Slot", "slotCam"], boreCam: ["Bore", "boreCam"], chamfer2d: ["2D Chamfer", "chamfer"], threadCam: ["Thread", "bolt"],
  adaptive3d: ["3D Adaptive Clearing", "adaptive"], pocket3d: ["3D Pocket Clearing", "pocket"], parallel: ["Parallel", "parallel"], scallop: ["Scallop", "scallop"], steepShallow: ["Steep and Shallow", "parallel"], contour3d: ["3D Contour", "contourPath"],
  drill: ["Drill", "drill"],
  // CAM: turning, additive, cutting, probing
  turnSetup: ["New Turning Setup", "lathe"], turnFace: ["Turning Face", "lathe"], turnRough: ["Turning Profile Roughing", "lathe"], turnFinish: ["Turning Profile Finishing", "lathe"],
  turnGroove: ["Turning Groove", "lathe"], turnThread: ["Turning Thread", "bolt"], turnPart: ["Turning Part-off", "lathe"], turnDrill: ["Turning Drill", "drill"],
  addSetup: ["New Additive Setup", "printer"], machine: ["Machine (printer)", "printer"], printSettings: ["Print Settings", "printer"], arrange: ["Arrange on Build Plate", "pattern"], orient: ["Automatic Orientation", "move"],
  supports: ["Supports", "rib"], slice: ["Slice", "printer"], exportGcode: ["Export G-code", "post"],
  cutSetup: ["New Cutting Setup", "laser"], cutProfile: ["2D Profile (laser / waterjet / plasma)", "laser"], cutNest: ["Nesting", "pattern"],
  probeWCS: ["WCS Probe", "measure"], probeGeom: ["Geometry Probe", "measure"], inspect: ["Inspect Surface", "measure"],
  nc: ["NC Program", "post"], machineLib: ["Machine Library", "camSetup"], postLib: ["Post Library", "post"],
  simToolpath: ["Simulate Toolpath", "simToolpath"], post: ["Post Process (G-code)", "post"], setupSheet: ["Setup Sheet", "setupSheet"], toolLibrary: ["Tool Library", "toolLibrary"],
  // render
  // assembly
  asBuiltJoint: ["As-built Joint", "joint"], jointOrigin: ["Joint Origin", "origin"], rigidGroup: ["Rigid Group", "jointRigid"],
  interference: ["Interference", "measure"], motionStudy: ["Motion Study", "drive"], contactSets: ["Contact Sets", "simContact"], explodeView: ["Exploded View", "explode"],
  scene: ["Scene Settings", "scene"], renderAppearance: ["Appearance", "appearance"], decal: ["Decal", "decal"], textureMap: ["Texture Map Controls", "textureMap"],
  inCanvasRender: ["In-canvas Render", "inCanvasRender"], renderImg: ["Render", "renderImg"], gallery: ["Rendering Gallery", "gallery"],
  // animate
  storyboard: ["New Storyboard", "storyboard"], transformComp: ["Transform Components", "move"], autoExplode: ["Auto Explode", "explode"], restoreHome: ["Restore Home", "home"],
  viewCam: ["View", "camera"], callout: ["Callout", "callout"], publishVideo: ["Publish Video", "publish"],
};
for (const [k, [label, icon]] of Object.entries(PLACEHOLDERS)) COMMANDS[k] = { label, icon, soon: true };
// simulation study types (studytypes.js): the ones without a working command are placeholders
// they open a setup preview (their own ribbon + Study Settings) with the tape still on
for (const t of STUDY_TYPES) if (!t.cmd) COMMANDS[t.id] = { label: t.label, icon: t.icon, preview: true, run: () => startStudySetup(t) };
for (const [k, [label, icon]] of Object.entries(SIM_TOOLS)) COMMANDS[`sim_${k}`] = { label, icon, soon: true };
COMMANDS.studySettings = { label: "Study Settings", icon: "settings", run: () => showStudyOptions() };
COMMANDS.newStudy = { label: "New Study (all simulation types)", icon: "newStudy", run: () => openStudyGallery({ icons, run: runCommand, logEvent }) };

// the ribbon: one entry per top-level tab. `uc` tabs are under construction (they open and show their
// tools, but every tool there is a placeholder).
const SHARED = {
  construct: { label: "CONSTRUCT", icons: ["plane"], menu: ["plane", "midplane"] },
  inspect: { label: "INSPECT", icons: ["measure", "sectionAnalysis"], menu: ["measure", "sectionAnalysis"] },
  select: { label: "SELECT", icons: ["select"], menu: ["select"] },
};
const RIBBON = [
  { id: "solid", label: "SOLID", groups: [
    { label: "CREATE", icons: ["sketch", "extrude", "revolve", "hole", "tapDie", "box"], menu: ["sketch", "airfoil", "|", "extrude", "revolve", "sweep", "loft", "|", "box", "cylinder", "sphere", "|", "hole", "tapDie", "stock", "mirror", "pattern"] },
    { label: "MODIFY", icons: ["presspull", "fillet", "chamfer", "shell", "offsetFace", "appearance"], menu: ["presspull", "fillet", "chamfer", "shell", "offsetFace", "|", "appearance", "physical", "|", "move", "|", "delete"] },
    SHARED.construct, SHARED.inspect,
    { label: "INSERT", icons: ["insert", "mcmaster", "stock", "fastener", "gear"], menu: ["insert", "mcmaster", "|", "stock", "fastener", "gear", "|", "exportCmd", "robotExport"] },
    SHARED.select,
  ] },
  { id: "surface", label: "SURFACE", groups: [
    { label: "CREATE", icons: ["sketch", "surfExtrude", "surfRevolve", "surfSweep", "surfLoft", "patch", "surfOffset"], menu: ["sketch", "|", "surfExtrude", "surfRevolve", "surfSweep", "surfLoft", "|", "patch", "ruled", "surfOffset", "|", "thicken", "boundaryFill"] },
    { label: "MODIFY", icons: ["trimSurf", "extendSurf", "stitch", "thicken"], menu: ["trimSurf", "untrim", "extendSurf", "|", "stitch", "unstitch", "|", "reverseNormal", "thicken"] },
    SHARED.construct, SHARED.inspect, SHARED.select,
  ] },
  { id: "sheetmetal", label: "SHEET METAL", uc: true, groups: [
    { label: "CREATE", icons: ["smSketch", "flange", "bend", "unfold", "flatPattern"], menu: ["smSketch", "|", "flange", "contourFlange", "hem", "bend", "|", "unfold", "refold", "flatPattern", "|", "convertSheet"] },
    { label: "MODIFY", icons: ["smRules"], menu: ["smRules", "convertSheet"] },
    { label: "EXPORT", icons: ["smExport"], menu: ["smExport"] },
  ] },
  { id: "plastic", label: "PLASTIC", groups: [
    { label: "CREATE", icons: ["sketch", "snapFit", "lip", "web", "rib"], menu: ["sketch", "|", "snapFit", "lip", "|", "web", "rib", "|", "boss", "rest"] },
    { label: "MODIFY", icons: ["ruleFillet", "draft", "shell"], menu: ["ruleFillet", "draft", "|", "shell", "|", "plasticRules"] },
    SHARED.construct, SHARED.inspect, SHARED.select,
  ] },
  { id: "render", label: "RENDER", uc: true, groups: [
    { label: "SETUP", icons: ["scene", "renderAppearance", "decal", "textureMap"], menu: ["scene", "renderAppearance", "decal", "textureMap"] },
    { label: "IN-CANVAS RENDER", icons: ["inCanvasRender"], menu: ["inCanvasRender"] },
    { label: "RENDER", icons: ["renderImg", "gallery"], menu: ["renderImg", "gallery"] },
  ] },
  { id: "animate", label: "ANIMATE", uc: true, groups: [
    { label: "STORYBOARD", icons: ["storyboard"], menu: ["storyboard"] },
    { label: "TRANSFORM", icons: ["transformComp", "autoExplode", "restoreHome"], menu: ["transformComp", "autoExplode", "restoreHome"] },
    { label: "VIEW", icons: ["viewCam"], menu: ["viewCam"] },
    { label: "ANNOTATION", icons: ["callout"], menu: ["callout"] },
    { label: "PUBLISH", icons: ["publishVideo"], menu: ["publishVideo"] },
  ] },
];
// the SIMULATION workspace (cube dropdown, top left): one tab per kind of physics, every tool shown
// directly in its group so nothing hides in sub-menus
const SIM_RIBBON = [
  { id: "studies", label: "STUDIES", groups: [
    { label: "NEW", icons: ["newStudy", "designCheck"], menu: ["newStudy", "designCheck"] },
    { label: "MATERIAL", icons: ["physical"], menu: ["physical"] },
    { label: "RESULTS", icons: ["studies"], menu: ["studies"] },
  ] },
  { id: "structural", label: "STRUCTURAL", groups: [
    { label: "STATIC", icons: ["fea", "nonlinearStress", "fatigue"], menu: ["fea", "nonlinearStress", "fatigue"] },
    { label: "VIBRATION & STABILITY", icons: ["modal", "buckling"], menu: ["modal", "buckling"] },
    { label: "EVENTS", icons: ["quasiStatic", "dynamicEvent"], menu: ["quasiStatic", "dynamicEvent"] },
  ] },
  { id: "thermal", label: "THERMAL", groups: [
    { label: "HEAT", icons: ["thermal", "thermalStress"], menu: ["thermal", "thermalStress"] },
    { label: "ELECTRONICS", icons: ["electronicsCooling"], menu: ["electronicsCooling"] },
  ] },
  { id: "fluids", label: "FLUIDS", groups: [
    { label: "3D FLOW", icons: ["cfd", "aeroLoads"], menu: ["cfd", "aeroLoads"] },
    { label: "2D FLOW", icons: ["flow2d"], menu: ["flow2d"] },
    { label: "INTERNAL FLOW", icons: ["internalFlow", "turbomachinery"], menu: ["internalFlow", "turbomachinery"] },
  ] },
  { id: "motion", label: "MOTION", groups: [
    { label: "MULTIBODY", icons: ["multibody"], menu: ["multibody"] },
  ] },
  { id: "manufacturing", label: "MANUFACTURING", groups: [
    { label: "MOLDING", icons: ["injectionMolding"], menu: ["injectionMolding"] },
  ] },
  { id: "optimize", label: "OPTIMIZE", groups: [
    { label: "GENERATIVE", icons: ["topo"], menu: ["topo"] },
    { label: "DESIGN EXPLORATION", icons: ["designExploration", "parametricOptimization"], menu: ["designExploration", "parametricOptimization"] },
    { label: "ADJOINT", icons: ["adjointShape"], menu: ["adjointShape"] },
  ] },
];
// the CAM workspace (under construction): one tab per process, every tool shown directly
const ACTIONS = { label: "ACTIONS", icons: ["simToolpath", "post", "setupSheet", "nc"], menu: ["simToolpath", "post", "setupSheet", "nc"] };
const MANAGE = { label: "LIBRARIES", icons: ["toolLibrary", "machineLib", "postLib"], menu: ["toolLibrary", "machineLib", "postLib"] };
// the ASSEMBLY workspace: components, joints and placement; motion; export
const ASM_RIBBON = [
  { id: "assemble", label: "ASSEMBLE", groups: [
    { label: "COMPONENTS", icons: ["newComponent", "ground"], menu: ["newComponent", "ground"] },
    { label: "INSERT", icons: ["insert", "mcmaster", "stock", "fastener", "gear"], menu: ["insert", "mcmaster", "|", "stock", "fastener", "gear"] },
    { label: "MATE", icons: ["mate", "rigidGroup"], menu: ["mate", "rigidGroup"] },
    { label: "JOINTS", icons: ["joint", "asBuiltJoint", "jointOrigin"], menu: ["joint", "asBuiltJoint", "jointOrigin"] },
    { label: "POSITION", icons: ["move"], menu: ["move"] },
    { label: "INSPECT", icons: ["measure", "sectionAnalysis", "interference"], menu: ["measure", "sectionAnalysis", "interference"] },
    { label: "SELECT", icons: ["select"], menu: ["select"] },
  ] },
  { id: "motion", label: "MOTION", groups: [
    { label: "DRIVE", icons: ["drive", "motionLink"], menu: ["drive", "motionLink"] },
    { label: "STUDY", icons: ["motionStudy", "multibody", "contactSets", "explodeView"], menu: ["motionStudy", "multibody", "contactSets", "explodeView"] },
  ] },
  { id: "export", label: "EXPORT", groups: [
    { label: "ROBOTICS", icons: ["robotExport"], menu: ["robotExport"] },
    { label: "FILES", icons: ["exportCmd"], menu: ["exportCmd"] },
  ] },
];
const CAM_RIBBON = [
  { id: "milling", label: "MILLING", uc: true, groups: [
    { label: "SETUP", icons: ["camSetup", "camStock"], menu: ["camSetup", "camStock"] },
    { label: "2D", icons: ["facing", "adaptive2d", "pocket2d", "contour2d", "slotCam", "boreCam", "threadCam", "chamfer2d"], menu: ["facing", "adaptive2d", "pocket2d", "contour2d", "slotCam", "boreCam", "threadCam", "chamfer2d"] },
    { label: "3D", icons: ["adaptive3d", "pocket3d", "parallel", "scallop", "steepShallow", "contour3d"], menu: ["adaptive3d", "pocket3d", "parallel", "scallop", "steepShallow", "contour3d"] },
    { label: "DRILLING", icons: ["drill"], menu: ["drill"] },
    ACTIONS, MANAGE,
  ] },
  { id: "turning", label: "TURNING", uc: true, groups: [
    { label: "SETUP", icons: ["turnSetup", "camStock"], menu: ["turnSetup", "camStock"] },
    { label: "TURNING", icons: ["turnFace", "turnRough", "turnFinish", "turnGroove", "turnThread", "turnPart", "turnDrill"], menu: ["turnFace", "turnRough", "turnFinish", "turnGroove", "turnThread", "turnPart", "turnDrill"] },
    ACTIONS, MANAGE,
  ] },
  { id: "additive", label: "ADDITIVE", uc: true, groups: [
    { label: "SETUP", icons: ["addSetup", "machine", "printSettings"], menu: ["addSetup", "machine", "printSettings"] },
    { label: "POSITION", icons: ["arrange", "orient"], menu: ["arrange", "orient"] },
    { label: "SUPPORTS", icons: ["supports"], menu: ["supports"] },
    { label: "ACTIONS", icons: ["slice", "simToolpath", "exportGcode"], menu: ["slice", "simToolpath", "exportGcode"] },
  ] },
  { id: "cutting", label: "CUTTING", uc: true, groups: [
    { label: "SETUP", icons: ["cutSetup"], menu: ["cutSetup"] },
    { label: "CUTTING", icons: ["cutProfile", "cutNest"], menu: ["cutProfile", "cutNest"] },
    ACTIONS,
  ] },
  { id: "probing", label: "PROBING", uc: true, groups: [
    { label: "PROBING", icons: ["probeWCS", "probeGeom", "inspect"], menu: ["probeWCS", "probeGeom", "inspect"] },
    ACTIONS,
  ] },
];
const WORKSPACES = {
  design: { label: "DESIGN", menuLabel: "Design", icon: "design", tabs: RIBBON, tabPref: "ribbonTab", defaultTab: "solid" },
  assembly: { label: "ASSEMBLY", menuLabel: "Assembly", icon: "component", tabs: ASM_RIBBON, tabPref: "ribbonTabAsm", defaultTab: "assemble" },
  simulation: { label: "SIMULATION", menuLabel: "Simulation", icon: "stress", tabs: SIM_RIBBON, tabPref: "ribbonTabSim", defaultTab: "studies" },
  cam: { label: "CAM", menuLabel: "CAM (manufacture)", icon: "camSetup", tabs: CAM_RIBBON, tabPref: "ribbonTabCam", defaultTab: "milling", uc: true },
};
const workspaceId = () => { const id = getPref("workspace", "design"); return WORKSPACES[id] ? id : "design"; };
const workspace = () => WORKSPACES[workspaceId()];
// study types without a solver only live in the Simulation workspace
const SIM_ONLY = new Set(STUDY_TYPES.filter((t) => !t.cmd).map((t) => t.id));
function setWorkspace(id) {
  if (!WORKSPACES[id] || id === workspaceId()) return;
  logEvent("workspace", { workspace: id });
  closeMenus();
  if (id !== "simulation") { finishStudySetup(); closeResults(); closeFeaResults(); } // results live in the Simulation workspace
  setPref("workspace", id);
  ctxPeek = null;
  buildToolbar(); refreshBrowser();
}
// every tool on an under-construction tab is a placeholder, whatever it shares with other tabs
for (const t of [...RIBBON, ...ASM_RIBBON, ...SIM_RIBBON, ...CAM_RIBBON]) if (t.uc) for (const g of t.groups) for (const k of [...g.icons, ...g.menu]) if (k !== "|" && !COMMANDS[k].soon) throw new Error(`ribbon: ${t.id} is under construction but ${k} works`);
const SKETCH_GROUPS = [
  { label: "CREATE", icons: ["line", "rect", "circle", "arc", "polygon", "airfoil", "sketchIntersect", "dimension"], menu: ["line", "|", "rect", "rectCenter", "|", "circle", "circle2p", "circle3p", "|", "arc", "arcCenter", "|", "polygon", "airfoil", "|", "sketchIntersect", "|", "dimension"] },
  { label: "MODIFY", icons: ["offset", "construction", "sketchDelete"], menu: ["offset", "sfillet", "trim", "|", "construction", "sketchDelete"] },
  { label: "CONSTRAINTS", icons: ["c_coincident", "c_hv", "c_parallel", "c_perpendicular", "c_tangent", "c_equal", "c_fix"], menu: ["c_coincident", "c_collinear", "c_concentric", "c_midpoint", "c_fix", "|", "c_parallel", "c_perpendicular", "c_hv", "c_tangent", "c_equal"] },
  { label: "INSPECT", icons: ["measure", "sectionAnalysis"], menu: ["measure", "sectionAnalysis"] },
];
// The selected tab is remembered across restarts. A contextual tab (SKETCH while sketching, or the
// study's setup tab while a placeholder study is open) is added after the others; `ctxPeek` is a
// regular tab the user clicked to look at meanwhile (null = the contextual tab). Tools on a peeked
// tab finish the sketch first, as in Fusion.
const ribbonTab = () => { const ws = workspace(); return ws.tabs.find((t) => t.id === getPref(ws.tabPref, ws.defaultTab)) || ws.tabs[0]; };
let ctxPeek = null, ctxLast = null;
function selectRibbonTab(id) {
  logEvent("ribbon tab", { tab: id });
  if (contextTab()) ctxPeek = id === "context" ? null : id;
  if (id !== "context") setPref(workspace().tabPref, id);
  buildToolbar();
}

// ---------- placeholder simulation studies: setup ribbon + Study Settings, nothing is solved ----------
let simStudy = null; // { type, setup, values }
function studyGroups(st) {
  const groups = st.setup.groups.map((g) => ({ label: g.label, icons: g.tools.map((k) => `sim_${k}`), menu: (g.menu || g.tools).map((k) => (k === "|" ? k : `sim_${k}`)) }));
  if (groups[0].label === "STUDY") { groups[0].icons.unshift("studySettings"); groups[0].menu.unshift("studySettings", "|"); }
  else groups.unshift({ label: "STUDY", icons: ["studySettings"], menu: ["studySettings"] });
  return groups;
}
function contextTab() {
  if (app.mode === "sketch") return { id: "sketch", label: "SKETCH", groups: SKETCH_GROUPS, finish: ["FINISH SKETCH", finishSketch] };
  if (simStudy) return { id: `study:${simStudy.type.id}`, label: simStudy.type.label.toUpperCase(), groups: studyGroups(simStudy), finish: ["FINISH STUDY", finishStudySetup], preview: true };
  return null;
}
function startStudySetup(type) {
  if (workspaceId() !== "simulation") setWorkspace("simulation");
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const setup = STUDY_SETUP[type.id];
  logEvent("study setup", { type: type.id });
  simStudy = { type, setup, values: defaultValues(setup) };
  ctxPeek = null;
  showStudyOptions();
  buildToolbar();
}
function showStudyOptions() {
  if (!simStudy) return;
  openStudyOptions({ host: $("#workspace"), type: simStudy.type, setup: simStudy.setup, values: simStudy.values, icons });
}
function finishStudySetup() {
  if (!simStudy) return;
  logEvent("study setup", { type: simStudy.type.id, action: "finish" });
  closeStudyOptions();
  simStudy = null;
  buildToolbar();
}
function runCommand(key) {
  const c = COMMANDS[key];
  if (!c || c.soon) { if (c) toast(`${c.label} is under construction`); return; }
  if (SIM_ONLY.has(key) || key === "newStudy") setWorkspace("simulation");
  if (c.sketch && app.mode !== "sketch") return;
  closeMenus();
  c.run();
}
function buildToolbar() {
  const tb = $("#toolbar");
  tb.innerHTML = "";
  const sketchMode = app.mode === "sketch";
  const ctx = contextTab();
  if (!ctx || ctx.id !== ctxLast) ctxPeek = null;
  ctxLast = ctx && ctx.id;
  const ws = workspace();
  const shown = ctx && !ctxPeek ? ctx : (ctx && ws.tabs.find((t) => t.id === ctxPeek)) || (ctx ? ctx : ribbonTab());
  tb.append(h("button", { class: "ws-btn", title: "Change workspace", onclick: (e) => openMenu(e.currentTarget, [{ hd: "WORKSPACES" },
    ...Object.entries(WORKSPACES).map(([id, w]) => ({ label: w.menuLabel, icon: w.icon, kb: ws === w ? "✓" : "", preview: w.uc && ws !== w, run: () => setWorkspace(id) })),
    { label: "Drawing", icon: "file", soon: true }]) }, ico(ws.icon, "ico"), h("span", { class: "cap" }, ws.label, ico("caret"))));
  if (ws.uc) tb.lastChild.classList.add("uc"), (tb.lastChild.title = `${ws.label} workspace — under construction`);
  const main = h("div", { class: "tb-main" });
  const tabs = h("div", { class: "tb-tabs" });
  for (const t of ws.tabs) tabs.append(h("div", { class: `tb-tab${shown === t ? " active" : ""}${t.uc ? " uc" : ""}`, title: t.uc ? `${t.label} — under construction` : null, onclick: () => selectRibbonTab(t.id) }, t.label));
  if (ctx) tabs.append(h("div", { class: `tb-tab sketch-tab${ctx.preview ? " uc" : ""}${shown === ctx ? " active" : ""}`, title: ctx.preview ? "Study setup preview — under construction" : null, onclick: () => selectRibbonTab("context") }, ctx.label));
  const groups = h("div", { class: "tb-groups" });
  for (const g of shown.groups) {
    const icRow = h("div", { class: "icons" });
    for (const k of g.icons) {
      const c = COMMANDS[k];
      const active = (sketchMode && shown === ctx && sketcher.tool === k) || (app.cmd && ((app.cmd.type === k) || (app.cmd.kind === "pickPlane" && k === "sketch") || (app.cmd.kind === "measure" && k === "measure") || (app.cmd.kind === "section" && k === "sectionAnalysis")));
      icRow.append(h("button", { class: `tb-icon${c.soon ? " uc" : c.preview ? " uc pv" : ""}${active ? " active" : ""}`, "data-cmd": k, title: `${c.label}${c.key ? `  (${c.key})` : ""}${c.soon || c.preview ? " — under construction" : ""}`, html: icons[c.icon], onclick: () => runCommand(k) }));
    }
    const label = h("div", { class: "tb-label", onclick: (e) => openMenu(e.currentTarget, g.menu.map((k) => (k === "|" ? "|" : { label: COMMANDS[k].label, icon: COMMANDS[k].icon, kb: COMMANDS[k].key, soon: COMMANDS[k].soon, preview: COMMANDS[k].preview, run: () => runCommand(k) }))) }, g.label, ico("caret"));
    groups.append(h("div", { class: "tb-group" }, icRow, label));
  }
  if (shown.uc || shown.preview) groups.append(h("div", { class: "tb-uc-note" }, h("span", { class: "uc-tag" }, "UNDER CONSTRUCTION"), h("span", {}, shown.preview ? "Study setup preview: the tools are placeholders and nothing is solved" : `${shown.label[0]}${shown.label.slice(1).toLowerCase()} tools are placeholders for now`)));
  if (ctx) groups.append(h("div", { class: "tb-finish" }, h("button", { class: "tb-icon", title: ctx.finish[0][0] + ctx.finish[0].slice(1).toLowerCase(), html: icons.finish, onclick: ctx.finish[1] }), h("div", { class: "tb-label", onclick: ctx.finish[1] }, ctx.finish[0], ico("caret"))));
  main.append(tabs, groups);
  tb.append(main);
  // a placeholder study's settings panel shares the feature dialog's spot: keep it out of the way
  const sp = $(".ss-panel");
  if (sp) sp.style.display = sketchMode || !$("#dialog").classList.contains("hidden") ? "none" : "";
}
function setSketchTool(t) {
  if (app.mode !== "sketch") return;
  logEvent("sketch tool", { tool: t });
  sketcher.setTool(t);
  buildToolbar();
}

// ======================= menus =======================
function closeMenus() { $("#menus").innerHTML = ""; }
function openMenu(anchor, items, pos) {
  closeMenus();
  const m = h("div", { class: "menu" });
  for (const it of items) {
    if (it === "|") { m.append(h("div", { class: "sep" })); continue; }
    if (it.hd) { m.append(h("div", { class: "hd" }, it.hd)); continue; }
    // `soon` items aren't built yet: they show the under-construction tape and do nothing
    // `preview` items open an under-construction preview: they keep the tag but still run
    m.append(h("div", { class: `mi${it.disabled || it.soon ? " disabled" : ""}${it.soon || it.preview ? " uc" : ""}`, title: it.soon ? "Under construction" : it.preview ? "Under construction (opens a preview)" : null, onclick: () => { if (it.disabled || it.soon) return; closeMenus(); it.run && it.run(); } }, it.icon ? ico(it.icon) : h("i", { class: "ic" }), h("span", { class: "lb" }, it.label), it.soon || it.preview ? h("span", { class: "uc-tag" }, "UNDER CONSTRUCTION") : it.kb ? h("span", { class: "kb" }, it.kb) : null));
  }
  $("#menus").append(m);
  let x, y;
  if (pos) ({ x, y } = pos);
  else { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
  const mr = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - mr.width - 4)}px`;
  m.style.top = `${Math.min(y, innerHeight - mr.height - 4)}px`;
  return m;
}
window.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu, .mm, .search, .tb-label, .ws-btn, .nb-btn.dd, #btnFile, #btnHelp")) closeMenus(); }, true);

function markingMenu(e) {
  closeMenus();
  const sketchMode = app.mode === "sketch";
  const last = app.lastCmd && COMMANDS[app.lastCmd];
  const slots = sketchMode
    ? [["N", last ? { label: `Repeat ${last.label}`, icon: last.icon, run: () => runCommand(app.lastCmd) } : null], ["E", { label: "Finish Sketch", icon: "finish", run: finishSketch }], ["S", { label: "Line", icon: "line", run: () => setSketchTool("line") }], ["W", { label: "Undo", icon: "undo", run: undo }], ["NE", { label: "Delete", icon: "trash", run: () => sketcher.deleteSelected() }], ["NW", { label: "Redo", icon: "redo", run: redo }], ["SE", { label: "Circle", icon: "circle", run: () => setSketchTool("circle") }], ["SW", { label: "2-Point Rectangle", icon: "rect", run: () => setSketchTool("rect") }]]
    : [["N", last ? { label: `Repeat ${last.label}`, icon: last.icon, run: () => runCommand(app.lastCmd) } : null], ["E", { label: "Press Pull", icon: "presspull", run: () => runCommand("presspull") }], ["S", { label: "Create Sketch", icon: "sketch", run: startCreateSketch }], ["W", { label: "Undo", icon: "undo", run: undo }], ["NE", { label: "Delete", icon: "trash", run: deleteSelection }], ["NW", { label: "Redo", icon: "redo", run: redo }], ["SE", { label: "Fillet", icon: "fillet", run: () => runCommand("fillet") }], ["SW", { label: "Extrude", icon: "extrude", run: () => runCommand("extrude") }]];
  const off = { N: [0, -78], NE: [100, -50], E: [118, 0], SE: [100, 50], S: [0, 78], SW: [-100, 50], W: [-118, 0], NW: [-100, -50] };
  const mm = h("div", { class: "mm" }, h("div", { class: "ring" }));
  mm.style.left = `${e.clientX}px`; mm.style.top = `${e.clientY}px`;
  for (const [dir, it] of slots) {
    if (!it) continue;
    const el = h("div", { class: "it", onclick: () => { closeMenus(); it.run(); } }, ico(it.icon), it.label);
    el.style.left = `${off[dir][0]}px`; el.style.top = `${off[dir][1]}px`;
    mm.append(el);
  }
  const overflow = sketchMode
    ? [{ label: "Look At", icon: "lookat", run: () => vp.lookAtPlane(app.sk.plane) }, { label: "Center Rectangle", icon: "rectCenter", run: () => setSketchTool("rectCenter") }, { label: "3-Point Arc", icon: "arc", run: () => setSketchTool("arc") }, { label: "Sketch Dimension", icon: "dimension", kb: "D", run: () => setSketchTool("dimension") }, { label: "Normal / Construction", icon: "construction", kb: "X", run: () => runCommand("construction") }]
    : [...modelContextItems(e), { label: "Measure", icon: "measure", kb: "I", run: startMeasure }, { label: "Offset Plane", icon: "plane", run: () => runCommand("plane") }, { label: "Shell", icon: "shell", run: () => runCommand("shell") }, "|", { label: "Fit", icon: "fit", kb: "F6", run: () => vp.fit() }, { label: "Home View", icon: "home", run: () => vp.home() }];
  const ov = h("div", { class: "menu ov" });
  for (const it of overflow) ov.append(it === "|" ? h("div", { class: "sep" }) : h("div", { class: "mi", onclick: () => { closeMenus(); it.run(); } }, ico(it.icon), h("span", { class: "lb" }, it.label), it.kb ? h("span", { class: "kb" }, it.kb) : null));
  ov.style.position = "absolute"; ov.style.left = "-95px"; ov.style.top = "110px";
  mm.append(ov);
  $("#menus").append(mm);
}

function commandSearch() {
  closeMenus();
  const box = h("div", { class: "search" });
  const inp = h("input", { placeholder: "Search commands…" });
  const res = h("div", { class: "res" });
  box.append(h("div", { class: "in" }, ico("search"), inp), res);
  const r = $("#workspace").getBoundingClientRect();
  box.style.left = `${r.left + r.width / 2 - 150}px`; box.style.top = `${r.top + 60}px`;
  $("#menus").append(box);
  let hot = 0, list = [];
  const render = () => {
    const q = inp.value.toLowerCase();
    list = Object.entries(COMMANDS).filter(([, c]) => !c.soon && (!c.sketch || app.mode === "sketch") && c.label.toLowerCase().includes(q)).slice(0, 12);
    hot = Math.min(hot, Math.max(0, list.length - 1));
    res.innerHTML = "";
    list.forEach(([k, c], i) => res.append(h("div", { class: `mi${i === hot ? " hot" : ""}`, onclick: () => { closeMenus(); runCommand(k); } }, ico(c.icon), h("span", { class: "lb" }, c.label), c.key ? h("span", { class: "kb" }, c.key) : null)));
  };
  inp.addEventListener("input", () => { hot = 0; render(); });
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") { hot = Math.min(list.length - 1, hot + 1); render(); }
    else if (e.key === "ArrowUp") { hot = Math.max(0, hot - 1); render(); }
    else if (e.key === "Enter" && list[hot]) { closeMenus(); runCommand(list[hot][0]); }
    else if (e.key === "Escape") closeMenus();
  });
  render();
  setTimeout(() => inp.focus(), 0);
}

// ======================= browser =======================
const ui = { open: { root: true, bodies: true, sketches: true, construction: true, origin: false, settings: false, views: false }, browserCollapsed: false };
function refreshBrowser() {
  const el = $("#browser");
  el.innerHTML = "";
  el.append(h("div", { class: "br-head" }, h("span", {}, "BROWSER"), h("button", { html: ui.browserCollapsed ? icons.plus : icons.caret, title: "Collapse", onclick: () => { ui.browserCollapsed = !ui.browserCollapsed; refreshBrowser(); } })));
  if (ui.browserCollapsed) return;
  const tree = h("div", { class: "br-tree" });
  const st = app.mode === "sketch" ? app.sk.base : app.state;
  const hidden = new Set(doc().hidden);
  const row = (depth, { key, icon, name, eye, eyeId, leaf, sel, onclick, ondbl, onctx, err, sub, dim }) => {
    const r = h("div", { class: `br-row${sel ? " selected" : ""}${dim ? " dim" : ""}`, style: `padding-left:${4 + depth * 14}px`, onclick, ondblclick: ondbl, oncontextmenu: onctx ? (e) => { e.preventDefault(); e.stopPropagation(); onctx(e); } : null });
    r.append(h("i", { class: `tw${leaf ? " leaf" : ""}`, html: ui.open[key] ? icons.caret : icons.caretRight, onclick: (e) => { e.stopPropagation(); ui.open[key] = !ui.open[key]; refreshBrowser(); } }));
    if (eye !== undefined) r.append(h("i", { class: `eye${eye ? "" : " off"}`, html: eye ? icons.eye : icons.eyeOff, title: "Show/Hide", onclick: (e) => { e.stopPropagation(); toggleVisible(eyeId); } }));
    r.append(ico(icon), h("span", { class: `nm${err ? " err" : ""}` }, name));
    if (sub) r.append(h("span", { class: "sub" }, sub));
    tree.append(r);
  };
  { const k = docKind(doc()); row(0, { key: "root", icon: KIND_ICON[k], name: `${doc().name} v1`, sub: k === "part" ? null : KIND_LABEL[k] }); }
  if (ui.open.root) {
    row(1, { key: "settings", icon: "gear", name: "Document Settings" });
    if (ui.open.settings) row(2, { key: "units", icon: "gear", name: `Units: ${unitLabel()}`, leaf: true, onclick: (e) => openUnitsMenu(e), onctx: (e) => openUnitsMenu(e) });
    row(1, { key: "views", icon: "camera", name: "Named Views" });
    if (ui.open.views) for (const [n, d] of [["TOP", [0, 0, 1]], ["FRONT", [0, -1, 0]], ["RIGHT", [1, 0, 0]], ["ISOMETRIC", [1, -1, 1]], ["HOME", null]]) row(2, { key: n, icon: "camera", name: n, leaf: true, onclick: () => (d ? vp.setViewDir(d) : vp.home()) });
    row(1, { key: "origin", icon: "folder", name: "Origin", eye: !hidden.has("origin"), eyeId: "origin" });
    if (ui.open.origin) {
      row(2, { key: "o", icon: "origin", name: "O", leaf: true });
      for (const n of ["X", "Y", "Z"]) row(2, { key: n, icon: "line", name: n, leaf: true });
      for (const n of ["XY", "XZ", "YZ"]) row(2, { key: n, icon: "plane", name: n, leaf: true, onclick: () => { app.selection = [{ kind: "plane", planeRef: { kind: "origin", name: n }, plane: K.ORIGIN_PLANES[n] }]; refreshHighlights(); } });
    }
    row(1, { key: "bodies", icon: "folder", name: "Bodies", eye: !hidden.has("bodies"), eyeId: "bodies" });
    if (ui.open.bodies) for (const b of st.bodies) {
      const sel = app.selection.some((x) => x.kind === "body" && x.body === b.id);
      const ap = (doc().appearances || {})[b.id];
      const pick = () => { if (!app.selection.some((x) => x.kind === "body" && x.body === b.id)) app.selection = [{ kind: "body", body: b.id }]; ui.sketchSel = null; refreshHighlights(); refreshBrowser(); };
      row(2, { key: b.id, icon: "body", name: b.name, sub: ap ? describeAppearance(ap) : "", leaf: true, eye: !hidden.has(b.id), eyeId: b.id, sel, onclick: (e) => { ui.sketchSel = null; app.selection = e.ctrlKey || e.shiftKey ? [...app.selection, { kind: "body", body: b.id }] : [{ kind: "body", body: b.id }]; refreshHighlights(); refreshBrowser(); },
        onctx: (e) => { pick(); openMenu(null, bodyMenuItems(), { x: e.clientX, y: e.clientY }); } });
    }
    if (asmUI) asmUI.browserRows(tree, ui.open, hidden); // Components + Joints folders
    const sketches = Object.values(st.sketches);
    if (sketches.length || app.mode === "sketch") {
      row(1, { key: "sketches", icon: "folder", name: "Sketches", eye: !hidden.has("sketches"), eyeId: "sketches" });
      if (ui.open.sketches) {
        for (const s of sketches) {
          const i = doc().features.findIndex((f) => f.id === s.id);
          row(2, { key: s.id, icon: "sketchSmall", name: s.name, leaf: true, eye: !hidden.has(s.id), eyeId: s.id, sub: s.profiles.length ? `${s.profiles.length} profile${s.profiles.length > 1 ? "s" : ""}` : "", ondbl: () => editFeature(i),
            sel: ui.sketchSel === s.id, onclick: () => { ui.sketchSel = s.id; app.selection = []; refreshHighlights(); refreshBrowser(); },
            onctx: (e) => { ui.sketchSel = s.id; refreshBrowser(); openMenu(null, [
              { label: "Edit Sketch", icon: "sketch", run: () => editFeature(i) },
              "|",
              { label: "Copy", icon: "copy", kb: "Ctrl+C", run: () => copySketch(s.id) },
              ...(app.clip ? [{ label: `Paste ${app.clip.kind === "sketch" ? "Sketch" : "Bodies"}`, icon: "paste", kb: "Ctrl+V", run: pasteClip }] : []),
              "|",
              { label: hidden.has(s.id) ? "Show" : "Hide", icon: hidden.has(s.id) ? "eye" : "eyeOff", run: () => toggleVisible(s.id) },
              { label: "Delete", icon: "trash", run: () => { if (i >= 0) deleteFeature(i); } },
            ], { x: e.clientX, y: e.clientY }); } });
        }
        if (app.mode === "sketch" && app.sk.editIndex == null) row(2, { key: "new", icon: "sketchSmall", name: `${app.sk.feature.name} (editing)`, leaf: true });
      }
    }
    const planes = Object.values(st.planes);
    if (planes.length) {
      row(1, { key: "construction", icon: "folder", name: "Construction", eye: !hidden.has("construction"), eyeId: "construction" });
      if (ui.open.construction) for (const p of planes) row(2, { key: p.id, icon: "plane", name: p.name, leaf: true, eye: !hidden.has(p.id), eyeId: p.id, onclick: () => { app.selection = [{ kind: "plane", planeRef: { kind: "cplane", id: p.id }, plane: p.plane }]; refreshHighlights(); } });
    }
    sectionBrowserRows(row, ui.open, hidden); // Analysis folder (sectionui.js)
    const studies = workspaceId() === "simulation" ? doc().studies || [] : [];
    if (studies.length) {
      if (ui.open.studies === undefined) ui.open.studies = true;
      row(1, { key: "studies", icon: "folder", name: "Simulations" });
      const open = currentResults();
      if (ui.open.studies) for (const sd of studies) {
        if (sd.kind === "fea") { feaStudyRow(row, sd); continue; } // static stress studies (feastudy.js / fearesults.js)
        const r = sd.results || {};
        const sub = sd.status === "running" ? "solving…" : r.Cd != null ? `Cd ${fmt(r.Cd, 3)}` : sd.status || "";
        row(2, { key: sd.id, icon: "wind", name: sd.name, leaf: true, sub, sel: !!(open && open.study.id === sd.id), err: sd.status === "failed" || sd.status === "diverged",
          onclick: () => showStudy(sd.id), onctx: (e) => openMenu(null, [
            { label: "Show Results", icon: "wind", run: () => showStudy(sd.id) },
            { label: "Open Case Folder", icon: "folder", run: () => platform.cfd.revealCase(sd.casePath) },
            "|",
            { label: "Remove from Simulations", icon: "trash", run: () => removeStudy(sd.id) },
          ], { x: e.clientX, y: e.clientY }) });
      }
    }
  }
  el.append(tree);
}
function toggleVisible(id) {
  const hs = new Set(doc().hidden);
  if (hs.has(id)) hs.delete(id); else hs.add(id);
  sectionToggle(hs, String(id)); // showing a section analysis hides the others
  doc().hidden = [...hs];
  applyVisibility(app.mode === "sketch" ? app.sk.base : app.state);
  applySection();
  save(); refreshBrowser();
}
// folder-level eyes (Bodies / Sketches / Construction / Origin) combine with per-item eyes
function applyVisibility(st) {
  const hs = new Set(doc().hidden);
  const groupOf = { bodies: st.bodies.map((b) => b.id), sketches: Object.keys(st.sketches), construction: Object.keys(st.planes) };
  const forced = (app.cmd && app.cmd.showSketches) || new Set(); // sketches a feature edit uses (startFeature)
  for (const [g, ids] of Object.entries(groupOf)) for (const x of ids) vp.setVisibility(x, forced.has(x) || (!hs.has(g) && !hs.has(x) && !(g === "bodies" && asmUI && asmUI.bodyHiddenByComponent(x, hs))));
  vp.axisLines[0].visible = vp.axisLines[1].visible = !hs.has("origin") && getPref("showAxes", true) !== false; // Origin eye, Grid and Snaps > Origin Axes
  vp.requestRender();
}

// ======================= timeline =======================
function refreshTimeline() {
  const tl = $("#timeline");
  tl.innerHTML = "";
  const setMarker = (m) => { if (app.mode === "sketch") finishSketch(); cancelCommand(); doc().marker = Math.max(0, Math.min(doc().features.length, m)); regen(); };
  tl.append(h("div", { class: "tl-ctrls" },
    h("button", { html: icons.first, title: "Move to beginning", onclick: () => setMarker(0) }),
    h("button", { html: icons.prev, title: "Step back", onclick: () => setMarker(doc().marker - 1) }),
    h("button", { html: icons.play, title: "Step forward", onclick: () => setMarker(doc().marker + 1) }),
    h("button", { html: icons.last, title: "Move to end", onclick: () => setMarker(doc().features.length) })));
  const track = h("div", { class: "tl-track" });
  const editingIdx = app.mode === "sketch" ? app.sk.editIndex : app.cmd && app.cmd.kind === "feature" ? app.cmd.editIndex : null;
  const marker = h("div", { class: "tl-marker", title: "Drag to roll back history" });
  // assembly joints / mates show in the history after the feature they were made after (j.after; older
  // joints without one at the end). They aren't replayed features: rolling back doesn't suppress them.
  const joints = ((doc().assembly && doc().assembly.joints) || []);
  const ids = new Set(doc().features.map((f) => f.id));
  const jointsAfter = (id) => joints.filter((j) => (j.after && ids.has(j.after) ? j.after : j.after === null ? "__start" : "__end") === id);
  const jointItem = (j) => h("div", {
    class: "tl-item tl-joint", title: `${j.name} (${j.type === "rigid" ? "mate" : `${j.type} joint`}; assembly, not rolled back)`, html: icons[jointIcon[j.type] || "joint"] || "",
    ondblclick: () => asmUI.editJoint(j.id),
    oncontextmenu: (e) => {
      e.preventDefault();
      openMenu(null, [
        { label: j.type === "rigid" ? "Edit Mate" : "Edit Joint", icon: jointIcon[j.type] || "joint", run: () => asmUI.editJoint(j.id) },
        "|",
        { label: "Delete", icon: "trash", run: () => asmUI.deleteJoint(j.id) },
      ], { x: e.clientX, y: e.clientY - 150 });
    },
  });
  jointsAfter("__start").forEach((j) => track.append(jointItem(j)));
  doc().features.forEach((f, i) => {
    if (i === doc().marker) track.append(marker);
    const err = app.state.errors[f.id];
    const item = h("div", {
      class: `tl-item${i >= doc().marker ? " rolled" : ""}${err ? " error" : ""}${editingIdx === i ? " editing" : ""}`,
      title: `${f.name}${err ? `\n⚠ ${err}` : ""}`, html: icons[featureIcon[f.type]] || "",
      ondblclick: () => editFeature(i),
      oncontextmenu: (e) => {
        e.preventDefault();
        openMenu(null, [
          { label: "Edit Feature", icon: featureIcon[f.type], run: () => editFeature(i) },
          { label: "Roll History Marker Here", icon: "prev", run: () => setMarker(i + 1) },
          "|",
          { label: f.type === "sketch" ? "Copy Sketch" : "Copy Body", icon: "copy", run: () => copyFeature(i) },
          ...(app.clip ? [{ label: `Paste ${app.clip.kind === "sketch" ? "Sketch" : "Bodies"}`, icon: "paste", run: pasteClip }] : []),
          "|",
          { label: f.suppressed ? "Unsuppress Feature" : "Suppress Feature", icon: "eyeOff", run: () => { pushUndo(); f.suppressed = !f.suppressed; regen(); } },
          { label: "Delete", icon: "trash", run: () => deleteFeature(i) },
        ], { x: e.clientX, y: e.clientY - 150 });
      },
    });
    item.dataset.idx = i;
    track.append(item);
    jointsAfter(f.id).forEach((j) => track.append(jointItem(j)));
  });
  if (doc().marker >= doc().features.length) track.append(marker);
  jointsAfter("__end").forEach((j) => track.append(jointItem(j)));
  marker.addEventListener("pointerdown", (e) => {
    // listen on window: moving the marker in the DOM (insertBefore) drops pointer capture, so the
    // pointerup used to land on a timeline item and the rollback never happened (bug report 2026-10-21 20:50)
    e.preventDefault();
    const items = [...track.querySelectorAll(".tl-item[data-idx]")];
    const mv = (ev) => {
      let m = 0;
      for (const it of items) { const r = it.getBoundingClientRect(); if (ev.clientX > r.left + r.width / 2) m = +it.dataset.idx + 1; }
      marker.dataset.m = m;
      const ref = items[m];
      if (ref) track.insertBefore(marker, ref); else track.append(marker);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      if (marker.dataset.m != null && +marker.dataset.m !== doc().marker) setMarker(+marker.dataset.m);
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  });
  tl.append(track, h("button", { class: "tl-gear", html: icons.gear, title: "Timeline settings" }));
}
function deleteFeature(i) {
  pushUndo();
  doc().features.splice(i, 1);
  if (doc().marker > i) doc().marker--;
  regen();
}
function deleteSelection() {
  if (app.mode === "sketch") { sketcher.deleteSelected(); return; }
  const bodies = app.selection.filter((it) => it.kind === "body" || it.kind === "face");
  const ids = [...new Set(bodies.map((it) => it.body))];
  if (!ids.length) { toast("Select a body in the browser to delete it"); return; }
  pushUndo();
  for (const id of ids) { doc().features.splice(doc().marker, 0, { id: fid(), type: "remove", name: nextName("remove"), body: id }); doc().marker++; }
  app.selection = [];
  regen();
}

// ======================= app bar, nav bar, misc =======================
function refreshAppbar() {
  $("#btnUndo").disabled = !app.undo.length && app.mode !== "sketch";
  $("#btnRedo").disabled = !app.redo.length && app.mode !== "sketch";
  renderTabs();
}

// ---------- design tabs (each tab is its own document with its own undo history and camera) ----------
let tabsKey = "";
let partsPanel = null; // { toggle, render } from partsui.js
const tabDoc = (i) => (i === app.tab ? app.doc : app.tabs[i].doc); // undo/redo replace app.doc, so the active tab's record lags
function renderTabs() {
  const host = $(".ab-tabs"), plus = $("#btnNewTab");
  const key = app.tabs.map((t, i) => t.id + ":" + docKind(tabDoc(i))).join() + "|" + app.tab; // kind: the tab icon
  if (key === tabsKey) { host.querySelectorAll(".doc-tab").forEach((el, i) => { const nm = el.querySelector(".doc-nm"); if (nm) nm.textContent = el.title = tabDoc(i).name; }); return; }
  tabsKey = key;
  host.querySelectorAll(".doc-tab").forEach((el) => el.remove());
  app.tabs.forEach((t, i) => {
    const active = i === app.tab;
    const x = h("span", { class: "doc-x", title: "Close" }, "✕");
    const name = tabDoc(i).name;
    const kind = docKind(tabDoc(i));
    const el = h("div", { class: `doc-tab${active ? " active" : ""}`, title: `${name}
${KIND_LABEL[kind]}` }, h("span", { class: "doc-ico", html: icons[KIND_ICON[kind]] || icons.body }), h("span", { class: "doc-nm", ...(active ? { id: "docTitle" } : {}) }, name), x);
    el.addEventListener("click", (e) => { if (e.target === x) closeTab(i); else switchTab(i); });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } });
    host.insertBefore(el, plus);
  });
  // double-click a tab's name to rename the design in place. On the host, because the first click on
  // an inactive tab switches to it and rebuilds the tab elements before the dblclick arrives
  if (!host.dataset.renameHooked) {
    host.dataset.renameHooked = "1";
    host.addEventListener("dblclick", (e) => { const t = e.target.closest(".doc-tab"); if (t && !e.target.closest(".doc-x") && !e.target.closest(".doc-rename")) renameTab(); });
  }
}
// in-place name editor on the active tab (Enter or click away keeps it, Esc cancels)
function renameTab() {
  const el = $(".ab-tabs .doc-tab.active"), nm = el && el.querySelector(".doc-nm");
  if (!nm) return;
  const d = doc(), inp = h("input", { class: "doc-rename", value: d.name, spellcheck: "false" });
  nm.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (ok) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (inp.isConnected) inp.replaceWith(nm);
    if (ok && v && v !== d.name && d === doc()) {
      logEvent("tab", { action: "rename", from: d.name, name: v });
      d.name = v; nm.textContent = el.title = v;
      save(); refreshAppbar(); refreshBrowser();
    }
  };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  for (const t of ["pointerdown", "click", "dblclick"]) inp.addEventListener(t, (e) => e.stopPropagation());
  inp.addEventListener("blur", () => finish(true));
}
// tidy the workspace before the document under it changes
function leaveDoc() {
  if (app.mode === "sketch") finishSketch();
  finishStudySetup();
  closeResults(); closeFeaResults(); closeFlow2D(); closeTopo(); closeFeaStudy(); closeCfdStudy();
  cancelCommand();
}
// Save a document that may not be the active tab any more (an async solve that finishes after a tab switch)
function saveDocAnywhere(d) {
  if (d === app.doc) { save(); refreshBrowser(); return; }
  const i = app.tabs.findIndex((t) => t.doc === d);
  if (i >= 0) try { localStorage.setItem(`${STORE}#${app.tabs[i].id}`, JSON.stringify(d)); } catch (e) {}
}
function stashTab() {
  const t = app.tabs[app.tab];
  Object.assign(t, { doc: app.doc, undo: app.undo, redo: app.redo, view: { az: vp.view.az, pol: vp.view.pol, dist: vp.view.dist, target: vp.view.target.clone() } });
  try { localStorage.setItem(`${STORE}#${t.id}`, JSON.stringify(t.doc)); } catch (e) { toast("Out of storage space: save this design to a file"); }
}
function activateTab(i) {
  const t = app.tabs[i];
  app.tab = i; app.doc = t.doc; app.undo = t.undo; app.redo = t.redo; app.selection = []; app.hover = null;
  try { localStorage.removeItem(`${STORE}#${t.id}`); } catch (e) {}
  regen(); buildToolbar();
  if (partsPanel) partsPanel.render(); // its "Open designs" list leaves out the active tab
  if (t.view) { vp.anim = null; Object.assign(vp.view, { az: t.view.az, pol: t.view.pol, dist: t.view.dist }); vp.view.target.copy(t.view.target); vp.dirty = true; vp.requestRender(); }
  else if (app.state.bodies.length || Object.keys(app.state.sketches).length) vp.fit(false);
  else vp.home();
}
function switchTab(i) {
  if (i === app.tab || !app.tabs[i]) return;
  logEvent("tab", { action: "switch", name: app.tabs[i].doc.name });
  leaveDoc(); stashTab(); activateTab(i);
}
function newTab(d = newDoc()) {
  logEvent("tab", { action: "new", name: d.name });
  leaveDoc(); stashTab();
  app.tabs.splice(app.tab + 1, 0, makeTab(d));
  activateTab(app.tab + 1);
}
function closeTab(i) {
  const t = app.tabs[i];
  if (!t) return;
  const d = i === app.tab ? app.doc : t.doc;
  if (tabDirty(i) && !confirm(`Close "${d.name}" without saving?\n\nIts changes aren't in a file. Cancel, then File > Save to keep them.`)) return;
  logEvent("tab", { action: "close", name: d.name });
  try { localStorage.removeItem(`${STORE}#${t.id}`); } catch (e) {}
  if (i !== app.tab) { app.tabs.splice(i, 1); if (i < app.tab) app.tab--; saveTabs(); renderTabs(); return; }
  leaveDoc();
  app.tabs.splice(i, 1);
  if (!app.tabs.length) app.tabs.push(makeTab());
  activateTab(Math.min(i, app.tabs.length - 1));
}
function buildAppbar() {
  const set = (id, icon, fn) => { const b = $(id); b.innerHTML = icons[icon]; if (fn) b.addEventListener("click", fn); };
  set("#btnFile", "file", (e) => openMenu(e.currentTarget, [
    { label: "Start Page", icon: "home", run: openStartPage },
    "|",
    { label: "New Design", icon: "plus", run: newDesign },
    { label: "Open…", icon: "file", run: openFile },
    "|",
    { label: "Save", icon: "save", kb: "Ctrl+S", run: () => saveFile() },
    { label: "Save As…", icon: "save", kb: "Ctrl+Shift+S", run: () => saveFile(true) },
    "|",
    { label: "Import…", icon: "insert", kb: "Ctrl+I", run: startImport },
    { label: "Export…", icon: "file", kb: "Ctrl+E", run: () => startExport() },
    { label: "Export Robot (URDF / USD for Isaac Sim)…", icon: "file", run: () => openRobot() },
  ]));
  set("#btnSave", "save", () => saveFile());
  set("#btnUndo", "undo", undo);
  set("#btnRedo", "redo", redo);
  set("#btnNewTab", "plus", () => newTab());
  set("#btnBell", "bell", () => toast("Notifications are under construction"));
  // controls that are only there for the Fusion look get the black-and-yellow tape
  for (const sel of ["#btnBell", "#comments"]) { const el = $(sel); el.classList.add("uc"); el.title = `${el.title ? el.title + " — " : ""}under construction`; }
  set("#btnHelp", "help", (e) => openMenu(e.currentTarget, [{ hd: "SHORTCUTS" },
    { label: "Orbit: Shift+Middle drag or Right drag", icon: "orbit" }, { label: "Pan: Middle drag", icon: "pan" }, { label: "Zoom: Wheel", icon: "zoom" }, "|",
    { label: "Extrude", icon: "extrude", kb: "E" }, { label: "Press Pull", icon: "presspull", kb: "Q" }, { label: "Fillet", icon: "fillet", kb: "F" }, { label: "Measure", icon: "measure", kb: "I" },
    { label: "Line / Rectangle / Circle", icon: "line", kb: "L R C" }, { label: "Arc / Polygon / Dimension", icon: "arc", kb: "A P D" }, { label: "Construction toggle", icon: "construction", kb: "X" },
    { label: "Command search", icon: "search", kb: "S" }, { label: "Fit view", icon: "fit", kb: "F6" }]));
  set("#btnSettings", "settings", () => { closeMenus(); logEvent("settings", { action: "open" }); openSettings(settingsCtx()); });
}
const settingsCtx = () => ({ vp, icons, toast, logEvent, getDisplay: () => app.display, setDisplay, setGrid, refresh: buildNavbar,
  units: { list: Object.entries(UNITS).map(([k, u]) => [k, `${u.plural} (${u.label})`]), current: () => units(), docUnits: () => doc().units || null, setDoc: setDocUnits } });

// Insert McMaster-Carr Component: desktop opens mcmaster.com in its own window and CAD files downloaded
// there (product page > CAD > 3-D STEP > Save) come back through platform.mcmaster.onFile (hooked at boot)
async function openMcMaster() {
  logEvent("mcmaster", { action: "open" });
  try { await platform.mcmaster.open(); } catch (e) { toast(`Couldn't open McMaster-Carr: ${e.message}`); return; }
  toast(platform.mcmaster.direct ? "Find the part, then CAD > 3-D STEP > Save: it's inserted into this design" : "McMaster-Carr opened in a new tab: download the 3-D STEP, then use Insert CAD", 6000);
}
function onMcMasterFile(f) {
  if (f.error) { toast(`McMaster-Carr download failed: ${f.error}`); return; }
  logEvent("mcmaster", { action: "insert", name: f.name, bytes: f.data.byteLength });
  importFileData(f.name, f.data);
}
// Simulation workspace > STUDIES > Results: pick a study from the Simulations folder and show it
function openStudiesMenu() {
  const studies = doc().studies || [];
  const anchor = document.querySelector('#toolbar .tb-icon[data-cmd="studies"]') || $("#toolbar");
  openMenu(anchor, studies.length
    ? [{ hd: "SIMULATION STUDIES" }, ...studies.map((sd) => ({ label: `${sd.name}${sd.status && sd.status !== "done" ? ` (${sd.status})` : ""}`, icon: sd.kind === "fea" ? "stress" : "wind", run: () => window.__showStudy(sd.id) }))]
    : [{ hd: "SIMULATION STUDIES" }, { label: "No studies yet: run a CFD Study or Static Stress", icon: "studies", disabled: true }]);
}
const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
function buildNavbar() {
  const nb = $("#navbar");
  nb.innerHTML = "";
  const btn = (icon, title, fn, cls = "") => { const b = h("button", { class: `nb-btn ${cls}`, title, html: icons[icon], onclick: fn }); nb.append(b); return b; };
  const navToggle = (mode) => () => { setNavMode(vp.navMode === mode ? null : mode); };
  btn("orbit", "Orbit: drag to orbit, click a point to orbit around it", navToggle("orbit"), vp.navMode === "orbit" ? "active" : "");
  btn("lookat", "Look At: pick a face or plane to look straight at", () => startLookAt(), app.cmd && app.cmd.kind === "lookAt" ? "active" : "");
  nb.append(h("div", { class: "nb-sep" }));
  btn("pan", "Pan: drag to pan", navToggle("pan"), vp.navMode === "pan" ? "active" : "");
  btn("zoom", "Zoom: drag up / down to zoom", navToggle("zoom"), vp.navMode === "zoom" ? "active" : "");
  btn("fit", "Fit (F6)", () => vp.fit());
  nb.append(h("div", { class: "nb-sep" }));
  btn("display", "Display Settings", (e) => openMenu(e.currentTarget, [
    { hd: "VISUAL STYLE" },
    { label: "Shaded with Visible Edges", icon: "body", kb: app.display === "shadedEdges" ? "✓" : "", run: () => setDisplay("shadedEdges") },
    { label: "Shaded", icon: "sphere", kb: app.display === "shaded" ? "✓" : "", run: () => setDisplay("shaded") },
    { label: "Wireframe", icon: "grid", kb: app.display === "wire" ? "✓" : "", run: () => setDisplay("wire") },
    "|", { hd: "RENDERING" },
    { label: "Ground Shadow", icon: "body", kb: vp.renderOptions.shadows ? "✓" : "", run: () => vp.setRenderOptions({ shadows: !vp.renderOptions.shadows }) },
    { label: "Ambient Occlusion", icon: "sphere", kb: vp.renderOptions.ao ? "✓" : "", run: () => vp.setRenderOptions({ ao: !vp.renderOptions.ao }) },
    ...[["studio", "Studio Lighting"], ["neutral", "Neutral Lighting"], ["dark", "Dark Sky Lighting"]].map(([id, label]) => ({ label, icon: "display", kb: vp.renderOptions.environment === id ? "✓" : "", run: () => vp.setRenderOptions({ environment: id }) })),
    "|", { hd: "CAMERA" },
    ...cameraMenuItems(),
    "|", { hd: "THEME" },
    { label: "Dark Theme", icon: "display", kb: getTheme() === "dark" ? "✓" : "", run: toggleTheme },
  ], posAbove(e.currentTarget, 520)), "dd");
  btn("camera", "Camera: Perspective / Orthographic / Isometric", (e) => openMenu(e.currentTarget, [{ hd: "CAMERA" }, ...cameraMenuItems()], posAbove(e.currentTarget, 150)), "dd");
  btn("grid", "Grid and Snaps", (e) => openMenu(e.currentTarget, [
    { hd: "GRID AND AXES" },
    { label: "Layout Grid", icon: "grid", kb: vp.showGrid ? "✓" : "", run: () => { setGrid(!vp.showGrid); buildNavbar(); } },
    { label: "Origin Axes", icon: "line", kb: getPref("showAxes", true) !== false ? "✓" : "", run: () => { setPref("showAxes", getPref("showAxes", true) === false); applyVisibility(app.mode === "sketch" ? app.sk.base : app.state); } },
  ], posAbove(e.currentTarget, 90)), "dd");
  btn("viewports", "Viewports — under construction", () => toast("Multiple viewports are under construction"), "dd uc");
}
// Orbit / Pan / Zoom buttons: left-drag does that until Esc or the button again
const NAV_TIPS = { orbit: "Drag to orbit · click a point to orbit around it · Esc to finish", pan: "Drag to pan · Esc to finish", zoom: "Drag up or down to zoom · Esc to finish" };
function setNavMode(mode) {
  vp.navMode = mode || null;
  vp.canvas.style.cursor = mode ? (mode === "pan" ? "move" : mode === "zoom" ? "ns-resize" : "grab") : "";
  setTip(mode ? NAV_TIPS[mode] : "");
  logEvent("nav mode", { mode: vp.navMode });
  buildNavbar();
}
function onNavClick(e, mode) {
  if (mode !== "orbit") return;
  const hit = vp.pick(e.clientX, e.clientY, ["face"]);
  if (!hit || !hit.point) { setTip("Click on the model to orbit around that point · Esc to finish"); return; }
  vp.setPivot(hit.point.clone ? hit.point.clone() : hit.point);
  setTip(NAV_TIPS.orbit);
  logEvent("orbit pivot", { point: hit.point });
}
// Look At (Fusion): with a face or plane selected look at it now, else pick one
function lookAtItem(it) {
  if (it.kind === "plane") { vp.lookAtPlane(it.plane); return true; }
  if (it.kind !== "face") return false;
  const p = K.planeFromFace(K.faceOf(app.state, it.body, it.idx));
  const m = vp.bodyXform && vp.bodyXform(it.body); // assembly placement
  if (m && m.length === 16) {
    const e = m, pt = (q) => [e[0] * q[0] + e[4] * q[1] + e[8] * q[2] + e[12], e[1] * q[0] + e[5] * q[1] + e[9] * q[2] + e[13], e[2] * q[0] + e[6] * q[1] + e[10] * q[2] + e[14]];
    const dir = (q) => { const v = [e[0] * q[0] + e[4] * q[1] + e[8] * q[2], e[1] * q[0] + e[5] * q[1] + e[9] * q[2], e[2] * q[0] + e[6] * q[1] + e[10] * q[2]]; const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
    vp.lookAtPlane({ origin: pt(p.origin), xDir: dir(p.xDir), normal: dir(p.normal) });
  } else vp.lookAtPlane(p);
  return true;
}
function startLookAt() {
  if (app.mode === "sketch") { vp.lookAtPlane(app.sk.plane); return; }
  const pre = app.selection.find((it) => it.kind === "face" || it.kind === "plane");
  if (pre && lookAtItem(pre)) { logEvent("look at", { item: pre.kind }); return; }
  cancelCommand();
  app.cmd = {
    kind: "lookAt",
    pickKinds: () => ["face", "plane"],
    onCancel: () => { setTip(""); buildNavbar(); },
    onPick: (it) => {
      if (!it) return;
      lookAtItem(it);
      logEvent("look at", { item: it.kind });
      app.cmd = null; vp.setOriginPlanesVisible(false); setTip(""); app.hover = null; refreshHighlights(); buildNavbar();
    },
  };
  vp.setOriginPlanesVisible(true);
  setTip("Select a face or plane to look at · Esc to cancel");
  refreshHighlights(); buildNavbar();
}
function cameraMenuItems() {
  const mode = (m, label) => ({ label, icon: "camera", kb: vp.cameraMode === m ? "✓" : "", run: () => vp.setCameraMode(m) });
  return [mode("perspective", "Perspective"), mode("orthographic", "Orthographic"), mode("perspOrtho", "Perspective with Ortho Faces"), { label: "Isometric View", icon: "box", run: () => vp.isoView() }];
}
const posAbove = (el, hgt) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top - hgt }; };

function setTip(t) { app.tip = t; const el = $("#cursorTip"); el.textContent = t; if (!t) el.style.display = "none"; }
function updateTipPos(e) {
  const el = $("#cursorTip");
  if (!app.tip) { el.style.display = "none"; return; }
  const host = $("#workspace").getBoundingClientRect();
  el.style.display = "block";
  el.style.left = `${e.clientX - host.left + 18}px`;
  el.style.top = `${e.clientY - host.top + 20}px`;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
// text: free text box; raw: value is the initial text and cb gets the typed text (sketch dimensions parse it themselves)
function promptValue({ x, y, label, value, unit, text, raw, onClose }, cb) {
  $("#hud").querySelectorAll(".dimbox.prompt").forEach((d) => d.remove());
  const host = $("#hud").getBoundingClientRect();
  const inp = h("input", { value: text || raw ? value : fmtVal(value, unit), spellcheck: "false" });
  if (text) inp.style.width = "160px";
  const fit = () => { inp.style.width = `${Math.max(70, Math.min(260, 8 * inp.value.length + 24))}px`; };
  if (raw) { fit(); inp.addEventListener("input", fit); }
  const box = h("div", { class: "dimbox prompt" }, label ? h("span", {}, label) : null, inp, unit ? h("em", {}, unitText(unit)) : null);
  box.style.left = `${x - host.left}px`; box.style.top = `${y - host.top}px`;
  $("#hud").append(box);
  inp.focus(); inp.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; box.remove(); if (ok) cb(text || raw ? inp.value.trim() : parseVal(inp.value, unit)); else if (onClose) onClose(); };
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(false));
}

// ---------- appearance / physical material ----------
function openAppearance(mode = "appearance") {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const bodies = app.state.bodies.map((b) => ({ id: b.id, name: b.name }));
  if (!bodies.length) { toast("Make or import a body first"); return; }
  const selectedIds = [...new Set(app.selection.filter((x) => x.body).map((x) => x.body))];
  const stored = () => doc().appearances || (doc().appearances = {});
  logEvent("command started", { name: mode });
  closeDialog();
  openAppearanceDialog({
    host: $("#workspace"), bodies, selectedIds, mode,
    title: mode === "physical" ? "Physical Material" : "Appearance",
    getAppearance: (id) => stored()[id] || null,
    onPreview: (ids, a) => {
      const map = { ...stored() };
      for (const id of ids) { if (a) map[id] = a; else if (stored()[id]) map[id] = stored()[id]; else delete map[id]; }
      vp.setAppearances(map);
    },
    onApply: (ids, a) => {
      pushUndo();
      for (const id of ids) stored()[id] = a;
      vp.setAppearances(stored());
      logEvent("appearance", { ids, appearance: a });
      save(); refreshBrowser();
      toast(`${describeAppearance(a)} applied to ${ids.length} bod${ids.length === 1 ? "y" : "ies"}`);
    },
    onClose: () => vp.setAppearances(stored()),
  });
}

// ---------- CFD Sim hand-off ----------
// robot export (URDF / USD for Isaac Sim / Isaac Lab): src/robotexportui.js, docs/robot-export.md
const robotCtx = () => ({ getDoc: () => app.doc, getState: () => app.state, toast, logEvent, host: $("#workspace") });
function openRobot() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  if (!app.state.bodies.length) { toast("Make or import a body first"); return; }
  openRobotExport(robotCtx());
}
function openCfd() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  if (!app.state.bodies.length) { toast("Make or import a body first"); return; }
  logEvent("command started", { name: "cfd" });
  const owner = doc(); // the study belongs to this design even if the tab changes mid-solve
  openCfdStudy({
    designName: doc().name,
    getBodies: () => app.state.bodies.map((b) => ({ id: b.id, name: b.name, shape: b.shape, visible: !doc().hidden.includes(b.id) && !doc().hidden.includes("bodies") })),
    exportSTL: (bodies) => K.exportSTL(bodies, { quality: "fine" }),
    getAppearance: (id) => (doc().appearances && doc().appearances[id]) || null,
    getMaterial,
    bodyInfo: K.bodyInfo,
    toast, logEvent,
    host: $("#workspace"),
    appVersion: "0.2.0",
    onSolve: ({ casePath, folderName, settings, bodies }) => {
      const studies = (owner.studies = owner.studies || []);
      const n = studies.length + 1;
      const sd = { id: fid(), name: `CFD ${n} · ${settings.speed} m/s ${settings.direction}`, casePath, folderName, settings, bodies, createdAt: new Date().toISOString(), status: "running", results: null };
      studies.push(sd);
      saveDocAnywhere(owner);
      logEvent("cfd study", { id: sd.id, folderName });
      if (owner === doc()) showStudy(sd.id);
    },
  });
}
// In-app CFD results for a study in doc().studies (cfdresults.js)
function showStudy(id) {
  const sd = (doc().studies || []).find((x) => x.id === id);
  if (!sd) return;
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  closeFeaResults();
  openCfdResults({
    vp, host: $("#workspace"), toast, logEvent,
    setModelVisible: (v) => { vp.groups.bodies.visible = v; vp.requestRender(); },
    onStudyUpdate: (sid, patch) => {
      const x = (doc().studies || []).find((y) => y.id === sid);
      if (!x) return;
      x.status = patch.status;
      x.results = { Cd: patch.Cd, Cl: patch.Cl, Cs: patch.Cs, forces_N: patch.forces_N, finishedAt: patch.finishedAt };
      save(); refreshBrowser();
    },
    rerun: async (study) => {
      const r = await platform.cfd.run(study.casePath);
      if (!r || !r.ok) { toast("Could not start the solver: " + ((r && r.error) || "unknown error")); return false; }
      const x = (doc().studies || []).find((y) => y.id === study.id);
      if (x) { x.status = "running"; save(); refreshBrowser(); }
      return true;
    },
  }, { id: sd.id, name: sd.name, casePath: sd.casePath, design: doc().name });
  refreshBrowser();
}
async function removeStudy(id) {
  const sd = (doc().studies || []).find((x) => x.id === id);
  if (!sd) return;
  const open = sd.kind === "fea" ? currentFeaResults() : currentResults();
  if (open && open.study.id === id) open.close();
  const P = sd.kind === "fea" ? platform.fea : platform.cfd;
  try { const st = await P.status(sd.casePath); if (st && st.running) await P.stop(sd.casePath); } catch {}
  doc().studies = doc().studies.filter((x) => x.id !== id);
  save(); refreshBrowser();
  toast("Study removed from the list (its case folder is kept)");
}


// ---------- 2D Flow: GPU lattice Boltzmann on a sketch's closed profiles (cfd2dui.js) ----------
function openFlow2DStudy() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const feats = doc().features.slice(0, doc().marker);
  const sketches = feats.filter((f) => f.type === "sketch").map((f) => ({ id: f.id, name: f.name, flat: SM.flatten(SM.normalizeSketch(f)) }));
  const selected = (app.selection.find((it) => it.sketch) || {}).sketch;
  logEvent("command started", { name: "flow2d" });
  openFlow2D({ host: $("#workspace"), sketches: () => sketches, selectedSketchId: selected, toast, logEvent, icon: icons.flow2d, closeIcon: icons.close, isDark: () => getTheme() === "dark" });
}


// ---------- Shape Optimization (generative design): topo.js in a worker, dialog in topoui.js ----------
function openTopo() {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  if (!app.state.bodies.length) { toast("Make or import a body to use as the design space"); return; }
  closeResults(); closeFeaResults(); closeFlow2D();
  const bodyOf = (id) => app.state.bodies.find((x) => x.id === id);
  logEvent("command started", { name: "topo" });
  openTopoStudy({
    host: $("#workspace"), vp, toast, logEvent, icons, picker: feaPicker,
    getBodies: () => app.state.bodies.map((b) => ({ id: b.id, name: b.name, shape: b.shape, visible: !doc().hidden.includes(b.id) && !doc().hidden.includes("bodies") })),
    faceInfo: (b, i) => K.faceInfo(bodyOf(b).shape, i),
    getAppearance: (id) => (doc().appearances && doc().appearances[id]) || null,
    getMaterial, bodyInfo: K.bodyInfo,
    selectedBodyId: (app.selection.find((x) => x.body) || {}).body,
    setModelVisible: (v) => { vp.groups.bodies.visible = v; vp.requestRender(); },
    // the optimized shape goes into the timeline as an imported mesh body; the design space is hidden
    addBody: ({ stl, name, hideBodyId }) => {
      const f = { id: fid(), type: "import", fileName: `${name}.stl`, format: "stl", data: K.bytesToBase64(stl), scale: 1, bodyNames: name };
      const trial = K.previewFeature(app.state, f);
      if (trial.error) { toast(`Couldn't make a solid from the optimized shape: ${trial.error}`); return false; }
      pushUndo();
      f.name = nextName("import");
      doc().features.splice(doc().marker, 0, f);
      doc().marker++;
      const ap = doc().appearances && doc().appearances[hideBodyId];
      if (hideBodyId && !doc().hidden.includes(hideBodyId)) doc().hidden.push(hideBodyId);
      regen();
      // carry the material over to the new body
      const nb = app.state.bodies[app.state.bodies.length - 1];
      if (nb && ap) { doc().appearances[nb.id] = { ...ap, auto: undefined }; save(); show(app.state); }
      logEvent("topo body", { name });
      toast(`${name} added to the timeline (the original body is hidden)`);
      return true;
    },
  });
}

// ---------- FEA: static stress (feastudy.js dialog, fearesults.js viewport results, FEA Sim solver) ----------
// Viewport face picking for the study dialog, through the generic app.cmd hooks (pickKinds / pickFilter / onPick / onCancel).
const feaPicker = {
  start(o) {
    if (app.mode === "sketch") finishSketch();
    if (app.cmd && app.cmd.kind !== "feaPick") cancelCommand();
    app.cmd = { kind: "feaPick", pickKinds: () => o.kinds || ["face"], pickFilter: o.filter || null,
      onPick: (it) => { if (it) o.onPick(it); app.hover = null; refreshHighlights(); }, onCancel: () => o.onEnd && o.onEnd() };
    setTip(o.prompt || ""); app.hover = null; refreshHighlights();
  },
  stop() { if (app.cmd && app.cmd.kind === "feaPick") { app.cmd.onCancel = null; cancelCommand(); } },
};
function feaCtx(extra = {}) {
  const bodyOf = (id) => app.state.bodies.find((x) => x.id === id);
  const owner = doc(); // the study belongs to this design even if the tab changes mid-solve
  return {
    designName: doc().name,
    getBodies: () => app.state.bodies.map((b) => ({ id: b.id, name: b.name, shape: b.shape, visible: !doc().hidden.includes(b.id) && !doc().hidden.includes("bodies") })),
    exportSTEP: (bodies) => K.exportSTEP(bodies),
    faceRef: (b, i) => K.faceRef(app.state, b, i),
    faceInfo: (b, i) => K.faceInfo(bodyOf(b).shape, i),
    faceCount: (b) => bodyOf(b).shape.faces.length,
    resolveFace: (ref) => { const r = K.resolveFace(app.state, ref); return { body: r.body.id, idx: r.idx }; },
    getAppearance: (id) => (doc().appearances && doc().appearances[id]) || null,
    getMaterial, bodyInfo: K.bodyInfo, picker: feaPicker, vp, toast, logEvent,
    host: $("#workspace"), appVersion: "0.2.0",
    selectedBodyId: (app.selection.find((s) => s.body) || {}).body,
    onSolve: ({ casePath, folderName, settings, bodies }) => {
      const studies = (owner.studies = owner.studies || []);
      const n = studies.filter((x) => x.kind === "fea").length + 1;
      const sd = { id: fid(), kind: "fea", name: `Static Stress ${n}${settings.summary ? " · " + settings.summary : ""}`, casePath, folderName, settings, bodies, createdAt: new Date().toISOString(), status: "running", results: null };
      const b = owner === doc() && bodyOf(settings.bodyId);
      if (b) sd.bodySig = bodySignature(b.shape); // to tell later whether the model changed since solving
      studies.push(sd);
      saveDocAnywhere(owner);
      logEvent("fea study", { id: sd.id, folderName });
      if (owner === doc()) { if (workspaceId() !== "simulation") setWorkspace("simulation"); showFeaStudy(sd.id); }
    },
    ...extra,
  };
}
function openFea(extra = {}) {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  if (!app.state.bodies.length) { toast("Make or import a body first"); return; }
  closeResults(); closeFeaResults();
  logEvent("command started", { name: "fea" });
  openFeaStudy(feaCtx(extra));
}
// The analysed body as it is now vs when the study was solved: "missing" | "changed" | null (current)
function bodySignature(shape) {
  const i = K.bodyInfo(shape);
  return { volume: +i.volume.toPrecision(7), bounds: i.bounds ? i.bounds.map((p) => p.map((v) => +v.toFixed(4))) : null };
}
const sigCache = new WeakMap();
function studyStale(sd) {
  const id = sd.settings && sd.settings.bodyId;
  if (!id) return null;
  const b = app.state.bodies.find((x) => x.id === id);
  if (!b) return "missing";
  const ref = sd.bodySig || sd.meshBounds;
  if (!ref) return null;
  if (sd.bodySig) {
    if (!sigCache.has(b.shape)) sigCache.set(b.shape, bodySignature(b.shape));
    const now = sigCache.get(b.shape), was = sd.bodySig;
    if (Math.abs(now.volume - was.volume) > 1e-4 * Math.max(1, Math.abs(was.volume))) return "changed";
    if (now.bounds && was.bounds && now.bounds.some((p, k) => p.some((v, j) => Math.abs(v - was.bounds[k][j]) > 1e-3))) return "changed";
    return null;
  }
  // older studies: the solved mesh's box vs the body's display mesh
  const bv = vp.bodyViews.find((v) => v.id === id);
  if (!bv) return null;
  const g = bv.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
  const lo = g.boundingBox.min.toArray(), hi = g.boundingBox.max.toArray();
  const ext = Math.max(...hi.map((v, k) => v - lo[k]), 1e-6);
  const [mlo, mhi] = sd.meshBounds;
  return lo.some((v, k) => Math.abs(v - mlo[k]) > 0.02 * ext) || hi.some((v, k) => Math.abs(v - mhi[k]) > 0.02 * ext) ? "changed" : null;
}
function showFeaStudy(id) {
  const sd = (doc().studies || []).find((x) => x.id === id);
  if (!sd) return;
  const stale = studyStale(sd);
  if (stale === "missing") { toast("This study's body is no longer in the design. Remove the study, or run a new one on the current model."); return; }
  if (stale === "changed") toast("Out of date: the model changed since this study was solved. Edit Study → Solve to update it.", 5000);
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  closeResults();
  openFeaResults({
    vp, host: $("#workspace"), toast, logEvent,
    onLoaded: ({ bounds }) => {
      // remember the solved geometry's box (older studies have no body signature), then re-check
      const x = (doc().studies || []).find((y) => y.id === sd.id);
      if (x && !x.bodySig && !x.meshBounds) { x.meshBounds = bounds; save(); }
      if (x && studyStale(x) === "changed") { toast("Out of date: the model changed since this study was solved. Edit Study → Solve to update it.", 5000); refreshBrowser(); }
    },
    setModelVisible: (v) => { vp.groups.bodies.visible = v; vp.requestRender(); },
    bodyMatrix: (bodyId) => (vp.bodyXform ? vp.bodyXform(bodyId) : null),
    onStudyUpdate: (sid, patch) => {
      const x = (doc().studies || []).find((y) => y.id === sid);
      if (!x) return;
      x.status = patch.status; x.results = patch;
      save(); refreshBrowser();
    },
    rerun: async (study) => {
      const r = await platform.fea.run(study.casePath);
      if (!r || !r.ok) { toast("Could not start the FEA solver: " + ((r && r.error) || "unknown error")); return false; }
      const x = (doc().studies || []).find((y) => y.id === study.id);
      if (x) { x.status = "running"; save(); refreshBrowser(); }
      return true;
    },
    edit: () => openFea({ initial: sd.settings }),
  }, { id: sd.id, name: sd.name, casePath: sd.casePath, design: doc().name, bodyId: sd.settings && sd.settings.bodyId });
  refreshBrowser();
}
function feaStudyRow(row, sd) {
  const open = currentFeaResults();
  const stale = sd.status === "running" ? null : studyStale(sd);
  const sub = sd.status === "running" ? "solving…" : stale === "missing" ? "body deleted" : stale ? "out of date" : feaSummary(sd.results) || sd.status || "";
  row(2, { key: sd.id, icon: "stress", name: sd.name, leaf: true, sub, dim: !!stale, sel: !!(open && open.study.id === sd.id), err: sd.status === "failed" || (sd.results && sd.results.minSafetyFactor != null && sd.results.minSafetyFactor < 1),
    onclick: () => showFeaStudy(sd.id), onctx: (e) => openMenu(null, [
      { label: "Show Results", icon: "stress", run: () => showFeaStudy(sd.id) },
      { label: "Edit Study", icon: "stress", run: () => openFea({ initial: sd.settings }) },
      { label: "Open Case Folder", icon: "folder", run: () => platform.fea.revealCase(sd.casePath) },
      "|",
      { label: "Remove from Simulations", icon: "trash", run: () => removeStudy(sd.id) },
    ], { x: e.clientX, y: e.clientY }) });
}

// ---------- file operations ----------
const DESIGN_FILTER = { name: "CAD Modeler design", extensions: ["cadm.json", "json"] };
const IMPORT_FILTERS = [{ name: "CAD and mesh files", extensions: ["step", "stp", "stl", "obj", "json"] }, { name: "STEP", extensions: ["step", "stp"] }, { name: "STL mesh", extensions: ["stl"] }, { name: "OBJ mesh", extensions: ["obj"] }, DESIGN_FILTER];
const cleanName = (n) => n.replace(/[\\/:*?"<>|]+/g, "_") || "Untitled";
async function saveFile(as = false) {
  if (app.mode === "sketch") finishSketch();
  const ok = await saveTabFile(app.tab, as);
  if (ok) { toast("Design saved"); refreshAppbar(); }
  return ok;
}
// Save tab i (active or not): its known file when there is one (desktop), else a Save dialog
async function saveTabFile(i, as = false) {
  const t = app.tabs[i], d = tabDoc(i);
  let path = null;
  if (!as && t.file) path = await platform.saveFileTo(t.file, JSON.stringify(d, null, 1));
  if (!path) {
    path = await platform.saveFile({ defaultName: `${cleanName(d.name)}.cadm.json`, filters: [DESIGN_FILTER], data: JSON.stringify(d, null, 1), where: "parts" });
    if (!path) return false;
    // an untitled design takes the file's name (written into the file on the next save)
    const base = String(path).split(/[\\/]/).pop().replace(/\.cadm\.json$|\.json$/i, "");
    if (/^Untitled/.test(d.name) && base && base !== d.name) {
      d.name = base;
      if (platform.isDesktop) await platform.saveFileTo(path, JSON.stringify(d, null, 1));
      if (i === app.tab) save();
    }
  }
  t.file = platform.isDesktop ? path : null;
  t.saved = JSON.stringify(d);
  logEvent("file", { action: "save", path, tab: i });
  // saved into the Parts folder: refresh its thumbnail (only the active tab is on screen to draw one)
  if (i === app.tab && t.file) {
    const png = designThumb();
    if (png) platform.parts.writeThumb(t.file, png).then((ok) => { if (ok) partsPanel && partsPanel.render(); }).catch(() => {});
  }
  return true;
}
/** PNG data URL of the viewport cropped to the visible bodies (Parts panel thumbnails), or null. */
function designThumb(W = 320, H = 220) {
  try {
    vp.renderer.render(vp.scene, vp.camera); // the WebGL buffer is only readable straight after a render
    const r = vp.canvas.getBoundingClientRect(), sx = vp.canvas.width / r.width, sy = vp.canvas.height / r.height;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // silhouette extent from sampled mesh vertices (a box's corners overshoot round parts a lot)
    for (const bv of vp.bodyViews || []) {
      if (bv.grp && !bv.grp.visible) continue;
      const pos = bv.mesh && bv.mesh.geometry && bv.mesh.geometry.attributes.position;
      if (!pos) continue;
      const m = bv.grp ? bv.grp.matrix.elements : null, step = Math.max(1, Math.floor(pos.count / 3000));
      for (let i = 0; i < pos.count; i += step) {
        let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (m) [x, y, z] = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        const p = vp.worldToScreen([x, y, z]);
        x0 = Math.min(x0, p.x - r.left); x1 = Math.max(x1, p.x - r.left); y0 = Math.min(y0, p.y - r.top); y1 = Math.max(y1, p.y - r.top);
      }
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = r.width; y1 = r.height; }
    // pad, match the thumbnail's aspect, keep on the canvas
    let w = (x1 - x0) * 1.15 + 16, hh = (y1 - y0) * 1.15 + 16;
    if (w / hh < W / H) w = hh * W / H; else hh = w * H / W;
    w = Math.min(w, r.width); hh = Math.min(hh, r.height);
    const cx = Math.max(w / 2, Math.min(r.width - w / 2, (x0 + x1) / 2)), cy = Math.max(hh / 2, Math.min(r.height - hh / 2, (y0 + y1) / 2));
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const g = out.getContext("2d");
    g.fillStyle = getComputedStyle(document.body).getPropertyValue("--doctab").trim() || "#f4f4f4";
    g.fillRect(0, 0, W, H);
    const k = Math.min(W / w, H / hh);
    g.drawImage(vp.canvas, (cx - w / 2) * sx, (cy - hh / 2) * sy, w * sx, hh * sy, (W - w * k) / 2, (H - hh * k) / 2, w * k, hh * k);
    return out.toDataURL("image/png");
  } catch (e) { return null; }
}
/** Tab i has changes that aren't in a file: anything in it, and different from the last save/open. */
function tabDirty(i) {
  const d = tabDoc(i);
  if (!docHasContent(d)) return false;
  return JSON.stringify(d) !== app.tabs[i].saved;
}
function loadDesign(d) {
  if (!Array.isArray(d.features)) throw new Error("Not a design file");
  const nd = fromStored(d);
  // an opened design gets its own tab, unless this tab is still blank
  if (doc().features.length || app.undo.length || app.mode === "sketch") { newTab(nd); vp.fit(); return; }
  leaveDoc(); pushUndo();
  app.doc = app.tabs[app.tab].doc = nd;
  regen(); buildToolbar(); vp.fit();
}
async function openFile() {
  const files = await platform.openFile({ filters: [DESIGN_FILTER], where: "parts" });
  if (!files) return;
  try {
    loadDesign(JSON.parse(new TextDecoder().decode(files[0].data)));
    const t = app.tabs[app.tab];
    t.file = files[0].path || null; t.saved = JSON.stringify(app.doc); // opened = nothing unsaved yet
    logEvent("file", { action: "open", name: files[0].name });
  }
  catch (e) { toast(`Couldn't open: ${e.message}`); }
}
function newDesign() { newTab(); } // Fusion opens a new design in its own tab
// Parts panel: open a design from the Parts folder (switches to its tab when it's already open)
async function openPart(part) {
  const open = app.tabs.findIndex((t) => t.file && part.path && t.file.toLowerCase() === part.path.toLowerCase());
  if (open >= 0) { switchTab(open); return; }
  try {
    const f = await platform.parts.open(part.file);
    if (!f) throw new Error("not found");
    loadDesign(JSON.parse(new TextDecoder().decode(f.data)));
    const t = app.tabs[app.tab];
    t.file = f.path || null; t.saved = JSON.stringify(app.doc);
    logEvent("file", { action: "open part", name: part.file });
  } catch (e) { toast(`Couldn't open ${part.name}: ${e.message}`); }
}

// ---------- inserting a design into this one (hybrid.js; kernel "insert" feature) ----------
// src from the Parts panel: { file, path, name } (a Parts-folder design) or { tab, name } (an open design tab)
async function insertDesignFrom(src) {
  try {
    if (src.tab) {
      const i = app.tabs.findIndex((t) => t.id === src.tab);
      if (i < 0) throw new Error("that tab was closed");
      insertDesignDoc(tabDoc(i), app.tabs[i].file, src.name);
      return;
    }
    const f = await platform.parts.open(src.file);
    if (!f) throw new Error("not found");
    insertDesignDoc(JSON.parse(new TextDecoder().decode(f.data)), f.path || src.path || null, src.name);
  } catch (e) { toast(`Couldn't insert ${src.name || "the design"}: ${e.message}`); }
}
/** Insert design d (read from file path `path`, may be null) as a new timeline feature; refuses loops. */
function insertDesignDoc(d, path, fallbackName) {
  if (!d || !Array.isArray(d.features)) { toast("Not a CAD Modeler design"); return; }
  const name = (d.name && d.name !== "Untitled" ? d.name : fallbackName) || d.name || "design";
  const why = insertLoop(doc(), app.tabs[app.tab].file, d, path);
  if (why) { toast(why, 6000); logEvent("insert design", { name, refused: why }); return; }
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const f = makeInsertFeature({ ...d, name }, { id: fid(), file: path });
  const trial = K.previewFeature(app.state, f);
  if (trial.error) { toast(`Couldn't insert ${name}: ${trial.error}`); return; }
  const wasHybrid = docKind(doc()) === "hybrid";
  pushUndo();
  doc().features.splice(doc().marker, 0, f);
  doc().marker++;
  logEvent("insert design", { name, file: path, bodies: trial.state.bodies.length - app.state.bodies.length });
  const before = new Set(app.state.bodies.map((b) => b.id));
  regen();
  toast(wasHybrid ? `Inserted ${name}` : `Inserted ${name}: this design is now a hybrid (it contains other designs)`, 5000);
  placeNewBodies(before);
}
/**
 * After an import / insert: open Move/Copy on the new bodies so they can be turned and dragged into
 * position (feature request 2026-10-21 20:51). Cancel leaves them where they landed. prefs.importPlace.
 */
function placeNewBodies(before) {
  if (getPref("importPlace", true) === false) return;
  const ids = app.state.bodies.filter((b) => !before.has(b.id)).map((b) => b.id);
  if (!ids.length) return;
  app.selection = ids.map((body) => ({ kind: "body", body }));
  startMove();
  setTip("Place it: drag the gizmo, turn it 90° or Drop to Ground, then OK (Cancel leaves it where it is)");
}

// ---------- start page (hero.js): continue, new design / assembly, open, import, workspaces, recent ----------
function startPageCtx() {
  return {
    // empty designs are never offered: no Continue button / Recent chip for them (null = none)
    ...startPageOffer(app.tabs.map((t, i) => tabDoc(i)), app.tab, bootSession.used ? 0 : bootSession.count),
    showAtStart: getPref("startPage", true) !== false,
    onShowAtStart: (on) => setPref("startPage", on),
    onAction: startPageAction,
  };
}
function startPageAction(act, arg) {
  logEvent("start page", { action: act, arg });
  if (act === "drawing") { toast("Drawing is under construction"); return; }
  closeHero();
  if (act === "newDesign" || act === "newAssembly") {
    setWorkspace(act === "newAssembly" ? "assembly" : "design");
    if (!bootSession.used && bootSession.count) {
      bootSession.used = true;
      // designs left over from the last run go away, so the new design starts a fresh session
      if (confirm(`Close the ${bootSession.count} design${bootSession.count > 1 ? "s" : ""} left open from your last session?\n\nThey weren't saved to a file. Cancel keeps them open in their tabs.`)) discardAllTabs();
      else newDesign();
    } else if (!doc().features.length && !app.undo.length && app.tabs.length === 1) { /* this blank tab is the new design */ }
    else newDesign();
    if (act === "newAssembly") {
      doc().name = "Untitled assembly"; doc().kind = "assembly"; save(); refreshAppbar(); refreshBrowser();
      toast("New assembly: COMPONENTS → New Component, or INSERT parts, then add Joints", 5000);
    }
  } else if (act === "open") openFile();
  else if (act === "import") startImport();
  else if (act === "simulation" || act === "cam" || act === "assembly") setWorkspace(act);
  else if (act === "recent") switchTab(arg);
  bootSession.used = true;
}
// close every tab without asking and start over with one blank design
function discardAllTabs() {
  leaveDoc();
  for (const t of app.tabs) try { localStorage.removeItem(`${STORE}#${t.id}`); } catch (e) {}
  app.tabs = [makeTab()];
  activateTab(0);
  saveTabs(); renderTabs();
  logEvent("tab", { action: "close all (start page)" });
}

// ---------- exit: prompt to save, then a clean exit clears the session ----------
async function confirmExit() {
  if (app.mode === "sketch") finishSketch();
  stashTab();
  const dirty = app.tabs.map((t, i) => i).filter(tabDirty);
  if (dirty.length && !(await exitDialog(dirty))) return false;
  // a clean exit: the next start opens one blank design (only a crash leaves designs to recover)
  app.closing = true;
  try {
    for (const t of app.tabs) localStorage.removeItem(`${STORE}#${t.id}`);
    localStorage.removeItem(STORE); localStorage.removeItem(TABS_STORE);
  } catch (e) {}
  logEvent("app exit", { saved: dirty.length });
  return true;
}
// "Save changes before closing?" for every design with unsaved changes. Resolves true = close.
function exitDialog(dirty) {
  return new Promise((resolve) => {
    closeMenus();
    const checks = dirty.map((i) => { const c = h("input", { type: "checkbox" }); c.checked = true; return c; });
    const msg = h("div", { class: "exit-msg" });
    const rows = dirty.map((i, k) => h("label", { class: "exit-row" }, checks[k],
      h("span", { class: "exit-nm" }, tabDoc(i).name),
      h("span", { class: "exit-sub" }, app.tabs[i].file ? String(app.tabs[i].file).split(/[\\/]/).pop() : "not saved to a file yet")));
    let busy = false;
    const done = (v) => { overlay.remove(); window.removeEventListener("keydown", onEsc, true); resolve(v); };
    const onEsc = (e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); e.stopPropagation(); done(false); } };
    const saveAll = async () => {
      if (busy) return; busy = true; msg.textContent = "";
      for (let k = 0; k < dirty.length; k++) {
        if (!checks[k].checked) continue;
        const ok = await saveTabFile(dirty[k]).catch(() => false);
        if (!ok) { busy = false; msg.textContent = `"${tabDoc(dirty[k]).name}" wasn't saved. Save it, untick it, or Cancel.`; return; }
        rows[k].classList.add("saved"); checks[k].checked = false; checks[k].disabled = true;
      }
      done(true);
    };
    const card = h("div", { class: "exit-card", role: "dialog" },
      h("div", { class: "dlg-head" }, ico("save"), h("span", {}, "Save changes before closing?")),
      h("div", { class: "exit-body" },
        h("div", { class: "exit-lead" }, dirty.length > 1 ? `${dirty.length} designs have changes that aren't saved to a file.` : "This design has changes that aren't saved to a file."),
        rows, msg),
      h("div", { class: "dlg-foot" },
        h("button", { class: "btn", onclick: () => { if (!busy) done(true); } }, "Don't Save"), h("div", { class: "sp" }),
        h("button", { class: "btn primary", onclick: saveAll }, "Save and Close"),
        h("button", { class: "btn", onclick: () => { if (!busy) done(false); } }, "Cancel")));
    const overlay = h("div", { class: "exit-overlay" }, card);
    window.addEventListener("keydown", onEsc, true);
    document.body.append(overlay);
    card.querySelector(".btn.primary").focus();
  });
}
function openStartPage() { closeMenus(); logEvent("start page", { action: "open" }); showHero(startPageCtx()); }

// ---------- import (STEP / STL / OBJ become an Import feature in the timeline) ----------
async function startImport() {
  const files = await platform.openFile({ filters: IMPORT_FILTERS, multiple: true });
  if (files && files.length) importFileData(files[0].name, files[0].data, files[0].path || null);
}
function importFileData(name, data, path = null) {
  if (/\.json$/i.test(name)) {
    // a CAD Modeler design is inserted into this one (hybrid); File > Open opens designs
    let d = null;
    try { d = JSON.parse(new TextDecoder().decode(data)); } catch (e) { toast(`Couldn't read ${name}: ${e.message}`); return; }
    insertDesignDoc(d, path, name.replace(/\.cadm\.json$|\.json$/i, ""));
    return;
  }
  const format = K.importFormat(name);
  if (!format) { toast(`Can't import ${name}: use STEP, STL or OBJ`); return; }
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const isMesh = format !== "step";
  const tris = format === "stl" ? K.stlTriangleCount(data) : format === "obj" ? (new TextDecoder().decode(data).match(/^f\s/gm) || []).length : 0;
  const unitSel = h("select", {}, [["1", "Millimeters"], ["10", "Centimeters"], ["1000", "Meters"], ["25.4", "Inches"], ["304.8", "Feet"]].map(([v, l]) => h("option", { value: v }, l)));
  // remembered choice; default centres the part (STEP files often carry an assembly-level origin far
  // from the part, bug report 2026-10-18 15:36: a gearbox landed 213 mm above the ground)
  const posSel = h("select", {}, h("option", { value: "ground" }, "Center on origin, on the ground"), h("option", { value: "center" }, "Center on origin"), h("option", { value: "keep" }, "Keep file coordinates"));
  posSel.value = ["ground", "center", "keep"].includes(getPref("importPosition")) ? getPref("importPosition") : "ground";
  const info = [`<b>${name}</b>`, `${format.toUpperCase()} · ${(data.length / 1024).toFixed(0)} KB`];
  if (isMesh) info.push(`${tris.toLocaleString()} triangles, converted to a solid body (booleans and fillets work on it)`);
  if (tris > 8000) info.push(`<span style="color:#d08a00">Large mesh: conversion may take ${Math.round(tris / 650)}+ seconds</span>`);
  const rows = [h("div", { class: "dlg-info", html: info.join("<br>") })];
  if (isMesh) rows.push(h("div", { class: "dlg-row" }, h("label", {}, "File units"), h("div", { class: "ctl" }, unitSel)));
  else rows.push(h("div", { class: "dlg-info", html: "STEP units are converted to millimeters automatically." }));
  rows.push(h("div", { class: "dlg-row" }, h("label", {}, "Position"), h("div", { class: "ctl" }, posSel)));
  const placeCk = h("input", { type: "checkbox" }); placeCk.checked = getPref("importPlace", true) !== false;
  rows.push(h("div", { class: "dlg-row" }, h("label", {}, ""), h("label", { class: "ctl", title: "Opens Move/Copy on the imported bodies: gizmo, 90° turns, Drop to Ground" }, placeCk, h("span", {}, " Move / rotate into place after import"))));
  dialogFrame("Insert", "insert", rows, {
    ok: "Import",
    onCancel: () => closeDialog(),
    onOK: () => {
      const scale = isMesh ? parseFloat(unitSel.value) : 1, position = posSel.value;
      setPref("importPosition", position);
      setPref("importPlace", placeCk.checked);
      closeDialog();
      toast(`Importing ${name}…`);
      // let the toast paint before the synchronous kernel import runs
      setTimeout(() => doImport(name, format, data, scale, position), 30);
    },
  });
}
function doImport(name, format, data, scale, position) {
  const f = { id: fid(), type: "import", fileName: name, format, data: K.bytesToBase64(data), scale, bodyNames: name.replace(/\.[^.]+$/, "") };
  const trial = K.previewFeature(app.state, f);
  if (trial.error) { toast(`Import failed: ${trial.error}`); return; }
  const added = trial.state.bodies.slice(app.state.bodies.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of added) { const bb = K.bodyInfo(b.shape).bounds; if (bb) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], bb[0][i]); hi[i] = Math.max(hi[i], bb[1][i]); } }
  let note = "";
  if (isFinite(lo[0])) {
    const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
    // "ground": centre on the origin and rest on Z = 0; "center": bounding-box centre on the origin
    if (position === "ground") f.translate = [-c[0], -c[1], -lo[2]];
    else if (position === "center") f.translate = c.map((v) => -v);
    else {
      const off = Math.hypot(c[0], c[1], Math.max(0, lo[2]));
      const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      if (off > 0.5 * size && off > 10) note = ` (its file origin is ${fmtLen(off)} away; import again with "Center on origin" to bring it home)`;
    }
  }
  pushUndo();
  f.name = nextName("import");
  doc().features.splice(doc().marker, 0, f);
  doc().marker++;
  logEvent("file", { action: "import", name, format, scale });
  const before = new Set(app.state.bodies.map((b) => b.id));
  regen(); vp.fit();
  toast(`Imported ${name}${note}`, note ? 6000 : 2600);
  placeNewBodies(before);
}

// ---------- export ----------
const EXPORT_TYPES = [
  { id: "step", label: "STEP (*.step)", ext: "step", mesh: false },
  { id: "stl", label: "STL binary (*.stl)", ext: "stl", mesh: true },
  { id: "stla", label: "STL ASCII (*.stl)", ext: "stl", mesh: true },
  { id: "obj", label: "OBJ (*.obj)", ext: "obj", mesh: true },
  { id: "glb", label: "glTF binary with materials (*.glb)", ext: "glb", mesh: true },
  { id: "design", label: "CAD Modeler design (*.cadm.json)", ext: "cadm.json", mesh: false },
];
function startExport(type = "step") {
  if (app.mode === "sketch") finishSketch();
  cancelCommand();
  const typeSel = h("select", {}, EXPORT_TYPES.map((t) => h("option", { value: t.id }, t.label)));
  typeSel.value = type;
  const visible = app.state.bodies.filter((b) => !doc().hidden.includes(b.id));
  const selectedIds = [...new Set(app.selection.filter((x) => x.body).map((x) => x.body))];
  const whichSel = h("select", {}, h("option", { value: "visible" }, `All visible bodies (${visible.length})`), selectedIds.length ? h("option", { value: "selected" }, `Selected bodies (${selectedIds.length})`) : null);
  if (selectedIds.length) whichSel.value = "selected";
  const qualSel = h("select", {}, h("option", { value: "coarse" }, "Low"), h("option", { value: "medium" }, "Medium"), h("option", { value: "fine" }, "High"));
  qualSel.value = "medium";
  const nameInp = h("input", { value: cleanName(doc().name), spellcheck: "false" });
  const qualRow = h("div", { class: "dlg-row" }, h("label", {}, "Refinement"), h("div", { class: "ctl" }, qualSel));
  const bodiesRow = h("div", { class: "dlg-row" }, h("label", {}, "Bodies"), h("div", { class: "ctl" }, whichSel));
  const sync = () => { const t = EXPORT_TYPES.find((x) => x.id === typeSel.value); qualRow.classList.toggle("hidden", !t.mesh); bodiesRow.classList.toggle("hidden", t.id === "design"); };
  typeSel.addEventListener("change", sync);
  dialogFrame("Export", "file", [
    h("div", { class: "dlg-row" }, h("label", {}, "Name"), h("div", { class: "ctl" }, h("div", { class: "num" }, nameInp))),
    h("div", { class: "dlg-row" }, h("label", {}, "Type"), h("div", { class: "ctl" }, typeSel)),
    bodiesRow, qualRow,
  ], {
    ok: "Export",
    onCancel: () => closeDialog(),
    onOK: async () => {
      const t = EXPORT_TYPES.find((x) => x.id === typeSel.value);
      const bodies = whichSel.value === "selected" ? app.state.bodies.filter((b) => selectedIds.includes(b.id)) : visible;
      if (t.id !== "design" && !bodies.length) { toast("Nothing to export"); return; }
      let data;
      try {
        if (t.id === "design") data = JSON.stringify(app.doc, null, 1);
        else if (t.id === "step") data = K.exportSTEP(bodies);
        else if (t.id === "stl" || t.id === "stla") data = K.exportSTL(bodies, { quality: qualSel.value, binary: t.id === "stl" });
        else if (t.id === "obj") data = K.exportOBJ(bodies, { quality: qualSel.value });
        else if (t.id === "glb") data = await exportGLB(bodies.map((b) => b.id));
      } catch (e) { toast(`Export failed: ${e.message || e}`); return; }
      const name = cleanName(nameInp.value.trim() || doc().name);
      const path = await platform.saveFile({ defaultName: `${name}.${t.ext}`, filters: [{ name: t.label, extensions: [t.ext.split(".").pop()] }], data });
      if (path) { closeDialog(); logEvent("file", { action: "export", type: t.id, bodies: bodies.length }); toast(`Exported ${t.label.split(" (")[0]}`); }
    },
  });
  sync();
}
// glTF built from the viewport's own meshes, so appearances (material + colour) come along
async function exportGLB(bodyIds) {
  const [{ GLTFExporter }, THREE] = await Promise.all([import("three/examples/jsm/exporters/GLTFExporter.js"), import("three")]);
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // glTF is Y-up; models here are Z-up
  root.scale.setScalar(0.001); // and in metres
  scene.add(root);
  for (const bv of vp.bodyViews) if (bodyIds.includes(bv.id)) { const m = bv.mesh.clone(); m.applyMatrix4(bv.grp.matrix); /* assembly placement */ m.name = (app.state.bodies.find((b) => b.id === bv.id) || {}).name || bv.id; root.add(m); }
  const out = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([out], { type: "model/gltf-binary" });
}
// drag & drop files anywhere onto the window
function setupDropImport() {
  window.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.some((ty) => ty.startsWith("application/x-cad-"))) return; // a Parts panel card (partsui.js handles it)
    const file = e.dataTransfer.files[0];
    if (file) importFileData(file.name, new Uint8Array(await file.arrayBuffer()), platform.droppedFilePath(file));
  });
}

// ======================= keyboard =======================
function onKey(e) {
  if (heroOpen()) { if (e.key === "Escape") startPageAction("continue"); return; } // the start page is up
  const typing = e.target.closest && e.target.closest("input, select, textarea");
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && !typing) {
    if (k === "z" || k === "Z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (k === "y") { e.preventDefault(); redo(); return; }
    if (k === "s") { e.preventDefault(); saveFile(e.shiftKey); return; }
    if (k === "i") { e.preventDefault(); startImport(); return; }
    if (k === "e") { e.preventDefault(); startExport(); return; }
    if (k === "o") { e.preventDefault(); openFile(); return; }
    if ((k === "c" || k === "C") && app.mode !== "sketch" && !app.cmd) { e.preventDefault(); copySelection(); return; }
    if ((k === "v" || k === "V") && app.mode !== "sketch" && !app.cmd) { e.preventDefault(); pasteClip(); return; }
  }
  if (typing) {
    if (k === "Enter" && app.cmd && dialogEl().contains(e.target)) { e.preventDefault(); okCommand(); }
    if (k === "Escape") { e.target.blur(); }
    return;
  }
  if ($("#menus").children.length && k === "Escape") { closeMenus(); return; }
  if (app.mode === "sketch") {
    if (sketcher.key(e)) return;
    if (k === "Escape") { if (!sketcher.escape()) setTip(""); buildToolbar(); return; }
    if (k === "Delete" || k === "Backspace") { sketcher.deleteSelected(); return; }
    const map = { l: "line", r: "rect", c: "circle", a: "arc", p: "polygon", d: "dimension", o: "offset" };
    if (map[k.toLowerCase()] && !e.ctrlKey) { setSketchTool(map[k.toLowerCase()]); return; }
    if (k.toLowerCase() === "x") { runCommand("construction"); return; }
    if (k.toLowerCase() === "s") { e.preventDefault(); commandSearch(); return; }
    if (k === "Enter" && !sketcher.pts.length) { finishSketch(); return; }
    if (k === "F6") { e.preventDefault(); vp.fit(); }
    return;
  }
  if (k === "Escape") { if (app.cmd) cancelCommand(); else { app.selection = []; refreshHighlights(); refreshBrowser(); } if (vp.navMode) setNavMode(null); else buildNavbar(); return; }
  if (k === "Enter" && app.cmd) { okCommand(); return; }
  if (k === "Delete" || k === "Backspace") { deleteSelection(); return; }
  if (k === "F6") { e.preventDefault(); vp.fit(); return; }
  if (e.ctrlKey || e.altKey) return;
  if (k.toLowerCase() === "o" && !e.ctrlKey) { vp.setCameraMode(vp.cameraMode === "orthographic" ? "perspOrtho" : "orthographic"); toast(`Camera: ${vp.cameraMode === "orthographic" ? "Orthographic" : "Perspective with Ortho Faces"}`); return; }
  const map = { e: "extrude", q: "presspull", f: "fillet", i: "measure", a: "appearance", j: "joint", m: "move", k: "stock", g: "gear" };
  if (map[k.toLowerCase()]) { runCommand(map[k.toLowerCase()]); return; }
  if (k.toLowerCase() === "s") { e.preventDefault(); commandSearch(); }
}

// ======================= boot =======================
async function boot() {
  await K.initKernel(() => wasmUrl);
  vp = new Viewport($("#workspace"), $("#view"));
  initSectionUI({
    app, vp, h, ico, fmt, K, doc, isPlanarFace, logEvent, toast, setTip, pushUndo, save, refreshBrowser, refreshHighlights, buildToolbar, openMenu, dialogFrame,
    prepare: () => { if (app.mode === "sketch") finishSketch(); cancelCommand(); },
    endCommand: () => { app.cmd = null; vp.hideArrow(); vp.setOriginPlanesVisible(false); closeDialog(); setTip(""); refreshHighlights(); buildToolbar(); },
  });
  new ViewCube($("#viewcube"), vp);
  app.vp = vp;
  vp.showGrid = getPref("showGrid", true) !== false; vp.grid.visible = vp.showGrid;
  platform.mcmaster.onFile(onMcMasterFile);
  sketcher = new Sketcher(app);
  app.setCursorTip = setTip;
  app.promptValue = promptValue;
  app.onSketchChanged = () => { refreshBrowser(); refreshSketchStatus(); };
  app.toast = toast;
  onThemeChange(() => { if (app.mode === "sketch") { show(app.sk.base, { activeSketchId: app.sk.feature.id }); sketcher.render(); } else show(app.state); refreshHighlights(); });
  app.onSketchToolChanged = () => buildToolbar();
  asmUI = createAssemblyUI({ // assemblies; also sets window.__asm
    app, vp, h, ico, fmt, pushUndo, save, logEvent, toast, setTip, openMenu, promptValue,
    dialogFrame, closeDialog, cancelCommand, finishSketch, buildToolbar, refreshHighlights, toggleVisible,
    refreshBrowser: () => { refreshBrowser(); refreshTimeline(); }, // joints / mates also show in the timeline
    applyVisibility: () => applyVisibility(app.mode === "sketch" ? app.sk.base : app.state),
    onApplied: (a) => driveLoops(a, app.mode === "sketch" && app.sk ? app.sk.base : app.state),
  });
  vp.handlers = {
    move: onMove, click: onClick, dblclick: onDblClick, navClick: onNavClick,
    context: (e) => markingMenu(e),
    down: (e) => app.mode === "sketch" && sketcher.down(e),
    drag: (e) => sketcher.dragMove(e),
    up: (e, moved) => sketcher.dragEnd(e, moved),
    leave: () => { app.hover = null; if (app.mode !== "sketch") refreshHighlights(); $("#cursorTip").style.display = "none"; },
  };
  vp.onFrame(positionArrowBox);
  setSaveHandler(async (p) => { const r = await platform.saveBugReport(p); refreshBugBadge(); return r; });
  setReportsHandler((kind) => openBugList({ logEvent, kind }));
  refreshBugBadge();
  initBugReporter(() => ({
    doc: app.doc,
    appState: {
      mode: app.mode,
      command: app.cmd ? { kind: app.cmd.kind, type: app.cmd.type, active: app.cmd.active, values: app.cmd.values, editIndex: app.cmd.editIndex } : null,
      sketch: app.mode === "sketch" ? { name: app.sk.feature.name, plane: app.sk.plane, tool: sketcher.tool, model: sketcher.m, dof: sketcher.status && sketcher.status.dof } : null,
      selection: app.selection,
      marker: doc().marker,
      featureErrors: app.state.errors,
      bodies: app.state.bodies.map((b) => b.id),
      camera: { az: vp.view.az, pol: vp.view.pol, dist: vp.view.dist, target: vp.view.target.toArray(), mode: vp.cameraMode },
      display: app.display,
    },
    // WebGL clears its buffer after compositing, so render right before reading it
    screenshot: (() => { vp.renderer.render(vp.scene, vp.camera); return vp.canvas.toDataURL("image/png"); })(),
  }));
  buildAppbar(); buildToolbar(); buildNavbar();
  // Parts panel on the left edge (under construction)
  partsPanel = initPartsPanel({ host: $("#workspace"), icons, toast, logEvent, parts: platform.parts, openPart, insertDesign: insertDesignFrom, openDesigns: () => app.tabs.map((t, i) => ({ name: tabDoc(i).name, active: i === app.tab, tab: t.id, kind: docKind(tabDoc(i)) })) });
  window.addEventListener("keydown", onKey);
  setupDropImport();
  regen();
  if (app.state.bodies.length || Object.keys(app.state.sketches).length) vp.fit(false, { az: vp.view.az, pol: vp.view.pol });
  // the hero loading screen (hero.js) becomes the start page, unless that's switched off
  if (getPref("startPage", true) !== false) heroReady(startPageCtx());
  else closeHero();
  platform.onCloseRequest(confirmExit);
  window.__exit = { confirm: confirmExit, dirty: () => app.tabs.map((t, i) => tabDirty(i)) }; // scripting
  window.__startPage = { open: openStartPage, close: () => startPageAction("continue"), isOpen: heroOpen };
  document.documentElement.dataset.appReady = "1"; // smoke test / feature tour: the app is usable
  window.__app = app; window.__vp = vp; window.__sk = sketcher; window.__io = { importFileData, loadDesign, startExport, exportGLB, designThumb, openPart, insertDesignFrom, insertDesignDoc }; // handy for debugging in the console
  window.__K = K; window.__runPreview = runPreview; // scripting: the kernel; run a pending feature preview now (rAF is paused in hidden panes)
  window.__run = runCommand; window.__feature = startFeature; window.__beginSketch = (name = "XY") => beginSketch({ kind: "plane", plane: K.ORIGIN_PLANES[name], planeRef: { kind: "origin", name } }); window.__markingMenu = markingMenu; window.__showStudy = (id) => { const sd = (doc().studies || []).find((x) => x.id === id); if (sd && sd.kind === "fea") showFeaStudy(id); else showStudy(id); }; // scripting: run any COMMANDS key / start a feature dialog (tools/feature-tour.cjs)
  window.__topo = { ...topoDebugApi(), open: openTopo };       // shape optimization (topoui.js)
  window.__flow2d = { open: openFlow2DStudy, close: closeFlow2D, current: currentFlow2D }; // 2D flow (cfd2dui.js)
  window.__section = sectionDebugApi(); // Section Analysis scripting (sectionui.js)
  window.__fea = { ...feaDebugApi(() => feaCtx()), show: showFeaStudy, results: () => currentFeaResults(), studies: () => (doc().studies || []).filter((s) => s.kind === "fea") }; // static stress scripting (feastudy.js)
  installRobotDebugHook(robotCtx()); // window.__robot.build(opts) / .export(opts)
  initStockUI({ app, startFeature: () => startFeature("stock"), okCommand }); // window.__stock.insert(id, opts)
}
boot().catch((e) => { console.error(e); $("#loading").innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#f66">Failed to start: ${e.message}</div>`; });
