// Interactive 2D sketch mode on top of the constraint model (sketchmodel.js)
// and solver (solver.js): drawing tools with auto-constraints, snapping,
// typed dimensions, a smart Sketch Dimension tool, geometric constraint tools,
// constrained dragging, and Fusion-style annotation (dimensions + glyphs).
import * as K from "./kernel.js";
import { COLORS } from "./viewport.js";
import { d2, entityPolyline, distToEntity, arcParams, circleFrom3 } from "./sketchgeom.js";
import * as SM from "./sketchmodel.js";
import { fmtLen, fmtDim, unitLabel, parseLength, parseNumber, exprNames } from "./units.js";
import { findChain, offsetChain, chainSide, itemsToFlat } from "./sketchoffset.js";
import { solve, analyze, rankOf, measureDim } from "./solver.js";

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const fmt = (v) => (Math.abs(v) < 1e-9 ? "0" : String(+v.toFixed(3)));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1e-12; return [a[0] / l, a[1] / l]; };
const perp = (a) => [-a[1], a[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const hex = (c) => `#${c.toString(16).padStart(6, "0")}`;

const TOOL_FIELDS = {
  line: [{ key: "len", label: "", unit: "mm" }, { key: "ang", label: "", unit: "°" }],
  rect: [{ key: "w", label: "", unit: "mm" }, { key: "h", label: "", unit: "mm" }],
  rectCenter: [{ key: "w", label: "", unit: "mm" }, { key: "h", label: "", unit: "mm" }],
  circle: [{ key: "dia", label: "⌀", unit: "mm" }],
  polygon: [{ key: "dia", label: "⌀", unit: "mm" }],
  arc: [],
  arcCenter: [{ key: "r", label: "R", unit: "mm" }, { key: "sweep", label: "", unit: "°" }],
  circle2p: [{ key: "dia", label: "⌀", unit: "mm" }],
  circle3p: [],
  offset: [{ key: "dist", label: "", unit: "mm" }],
};
export const CONSTRAINT_TOOLS = {
  c_coincident: { label: "Coincident", tip: "Select a point, then a point or curve" },
  c_hv: { label: "Horizontal/Vertical", tip: "Select a line, or two points" },
  c_parallel: { label: "Parallel", tip: "Select two lines" },
  c_perpendicular: { label: "Perpendicular", tip: "Select two lines" },
  c_collinear: { label: "Collinear", tip: "Select two lines" },
  c_equal: { label: "Equal", tip: "Select two lines, or two circles/arcs" },
  c_tangent: { label: "Tangent", tip: "Select a line or arc, then a circle or arc" },
  c_concentric: { label: "Concentric", tip: "Select two circles or arcs" },
  c_midpoint: { label: "Midpoint", tip: "Select a point and a line" },
  c_fix: { label: "Fix/Unfix", tip: "Select a point or curve to lock it in place" },
};
const GLYPH = { horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "≡", equal: "=", tangent: "⌒", concentric: "◎", midpoint: "△", coincident: "⊙" };

export class Sketcher {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.hud = document.getElementById("hud");
    this.annot = document.getElementById("annot");
    this.glyph = document.getElementById("snapGlyph");
    this.active = false;
    this.options = { grid: true, snap: false, modelSnap: true, cutEdges: true, profiles: true, construction: false, polygonSides: 6, constraints: true, dimensions: true };
    this.vp.onFrame(() => { this.positionHud(); this.positionAnnot(); });
  }

  // ======================= lifecycle =======================
  begin({ plane, model, name }) {
    this.active = true;
    this.plane = plane;
    this.name = name;
    this.m = model;
    this.undoStack = []; this.redoStack = [];
    this.selected = new Set();
    this.hover = null;
    this.tool = "select"; this.annot.classList.remove("passive");
    this.modelPts = null; // model snap points, built on the first snap (vp.modelSnapPoints)
    this.cutEdges = []; // where the sketch plane cuts the bodies (setCutEdges, computed by main.js)
    this.resetToolState();
    solve(this.m);
    this.afterChange();
  }
  /** Cross-section of the bodies on this plane (flat entities): drawn dashed, snappable, addable. */
  setCutEdges(list) {
    this.cutEdges = list || [];
    this.modelPts = null;
    if (this.active) this.render(false);
  }
  /** Intersect: add the cut edges to the sketch as fixed projected geometry (skipping ones already there). */
  addCutEdges() {
    const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4;
    const have = (e) => (this.flat || []).some((f) => f.type === e.type && (
      e.type === "circle" ? same(f.c, e.c) && Math.abs(f.r - e.r) < 1e-4
        : (same(f.a, e.a) && same(f.b, e.b)) || (same(f.a, e.b) && same(f.b, e.a))));
    const add = this.cutEdges.filter((e) => !have(e));
    if (!add.length) return 0;
    this.snapshot();
    SM.addFlat(this.m, add.map((e) => ({ ...e, id: undefined })), { fixed: true, projected: true });
    this.afterChange();
    return add.length;
  }
  end() {
    this.active = false;
    this.clearHud();
    this.annot.innerHTML = "";
    this.vp.setSketchOverlay(null);
    this.glyph.style.display = "none";
    SM.pruneOrphans(this.m);
    return this.m;
  }
  resetToolState() {
    this.pts = [];
    this.chainLast = null; this.chainStart = null;
    this.picks = [];
    this.pending = null;
    this.mouse = null;
    this.snap = null;
    this.fields = (TOOL_FIELDS[this.tool] || []).map((f) => ({ ...f, value: 0, locked: false }));
    this.fieldIdx = 0;
    this.offsetSel = null; this.offsetRes = null;
    this.clearHud();
  }
  setTool(t) {
    const preselected = [...this.selected];
    this.tool = t;
    // While a drawing tool is active, clicks go to the tool, never to a dimension label or
    // constraint glyph under the cursor (bug report 2026-10-09: a circle centre click opened a dimension)
    this.annot.classList.toggle("passive", t !== "select" && t !== "dimension" && !CONSTRAINT_TOOLS[t]);
    this.resetToolState();
    this.selected.clear();
    if (t === "offset") { const e = preselected.find((k) => k.startsWith("e:")); if (e) this.startOffset(e.slice(2)); }
    // constraint tools apply straight away to a compatible pre-selection
    if (CONSTRAINT_TOOLS[t] && preselected.length) {
      this.picks = preselected.filter((k) => !k.startsWith("c:")).map((k) => ({ kind: k[0] === "p" ? "point" : "entity", id: k.slice(2) }));
      this.tryConstraint();
    }
    this.app.setCursorTip(this.tipFor());
    this.render();
  }
  tipFor() {
    const p = this.pts.length;
    if (CONSTRAINT_TOOLS[this.tool]) return CONSTRAINT_TOOLS[this.tool].tip;
    switch (this.tool) {
      case "line": return p ? "Pick next point, or type length · Tab for angle · Esc to stop" : "Pick start point";
      case "rect": return p ? "Pick opposite corner, or type width · Tab for height" : "Pick first corner";
      case "rectCenter": return p ? "Pick corner, or type width · Tab for height" : "Pick center point";
      case "circle": return p ? "Pick a point on the circle, or type diameter" : "Pick center point";
      case "polygon": return p ? "Pick a vertex, or type diameter" : "Pick center point";
      case "arc": return p === 0 ? "Pick start point" : p === 1 ? "Pick end point" : "Pick a point on the arc";
      case "arcCenter": return p === 0 ? "Pick center point" : p === 1 ? "Pick start point, or type radius" : "Pick end point (move the other way round to flip), or type sweep angle";
      case "circle2p": return p ? "Pick the opposite end of the diameter, or type diameter" : "Pick first point on the circle";
      case "circle3p": return p === 0 ? "Pick first point on the circle" : p === 1 ? "Pick second point" : "Pick third point";
      case "offset": return this.offsetSel ? "Move to the side and click, or type the distance + Enter (a negative value flips the side) · Esc to pick another curve" : "Pick a curve: the curves joined to it are offset with it";
      case "dimension": return this.pending ? "Click to place the dimension (or pick another line for an angle)" : this.picks.length ? "Pick a second point or line" : "Pick a line, circle, arc or two points";
      default: return "";
    }
  }

  // ======================= model helpers =======================
  ent(id) { return this.m.entities.find((e) => e.id === id); }
  P(id) { return SM.P(this.m, id); }
  addPoint(p) { const id = SM.sid("p"); this.m.points[id] = { x: p[0], y: p[1] }; return id; }
  addEntity(e) { e.id = SM.sid("e"); if (this.options.construction && !e.construction) e.construction = true; this.m.entities.push(e); return e.id; }
  snapshot() { this.undoStack.push(JSON.stringify(this.m)); this.redoStack = []; if (this.undoStack.length > 100) this.undoStack.shift(); }
  restore(json) { const m = JSON.parse(json); this.m.points = m.points; this.m.entities = m.entities; this.m.constraints = m.constraints; }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.m)); this.restore(this.undoStack.pop()); this.selected.clear(); this.afterChange(); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.m)); this.restore(this.redoStack.pop()); this.afterChange(); }

  // add a constraint, refusing (or demoting a dimension to "driven") when it adds no information
  addConstraint(c, { quiet = false } = {}) {
    c.id = c.id || SM.sid("c");
    const before = rankOf(this.m);
    this.m.constraints.push(c);
    if (rankOf(this.m) <= before) {
      if (c.type === "dim") { c.driven = true; if (!quiet) this.toast("Sketch is already constrained there: added as a driven (reference) dimension"); }
      else { this.m.constraints.pop(); if (!quiet) this.toast("That constraint is redundant or conflicts with existing ones"); return false; }
    }
    return true;
  }
  toast(msg) { this.app.toast && this.app.toast(msg); }

  afterChange(full = true) {
    if (full) this.syncDims();
    this.flat = SM.flatten(this.m);
    if (full) {
      try { this.status = analyze(this.m); } catch (e) { this.status = { determined: new Set(), dof: 0 }; }
      try { this.profiles = K.sketchProfiles(this.plane, this.flat); } catch (e) { this.profiles = []; }
      this.app.onSketchChanged && this.app.onSketchChanged();
    }
    this.render();
  }
  // dimension names, driven values and linked expressions ("d1 / 2") kept current
  syncDims() {
    SM.ensureDimNames(this.m);
    const refreshDriven = () => { for (const c of this.m.constraints) if (c.type === "dim" && c.driven) { try { c.value = measureDim(this.m, c); } catch (e) { /* keep */ } } };
    refreshDriven();
    const before = JSON.stringify(this.m);
    if (SM.applyDimExprs(this.m, (c, vars) => this.evalDim(c.expr, c, vars))) {
      if (!this.solveHolding(null)) { this.restore(before); this.toast("A linked dimension can't be solved with the current constraints"); }
      refreshDriven();
    }
  }
  // Solve after a dimension change. Offset distances (lineDist from a source line) move the offset, not the
  // source: try with the source lines' points held first, then without.
  solveHolding(c) {
    const hold = new Set();
    if (!c || c.kind === "lineDist") for (const x of this.m.constraints) {
      if (x.type !== "dim" || x.kind !== "lineDist" || !(x === c || x.expr)) continue;
      const src = this.ent(x.e[0]);
      if (src) for (const p of SM.entityPoints(src)) if (!this.m.points[p].fixed) hold.add(p);
    }
    if (hold.size) {
      const before = JSON.stringify(this.m);
      if (solve(this.m, { fixedKeys: hold }).ok) return true;
      this.restore(before);
    }
    return solve(this.m).ok;
  }
  evalDim(text, c, vars) { return c.kind === "angle" ? parseNumber(text, vars) : parseLength(text, undefined, vars); }
  pointDetermined(id) { const p = this.m.points[id]; return p && (p.fixed || (this.status && this.status.determined.has(`${id}.x`) && this.status.determined.has(`${id}.y`))); }
  entityDetermined(e) { return SM.entityPoints(e).every((p) => this.pointDetermined(p)) && (e.type !== "circle" || (this.status && this.status.determined.has(`r:${e.id}`))); }
  get fullyConstrained() { return this.status && this.status.dof === 0 && this.m.entities.length > 0; }

  // ======================= snapping =======================
  wpp() { return this.vp.worldPerPixel(); }
  local(e) { return this.vp.screenToPlane(e.clientX, e.clientY, this.plane); }
  keyPoints() {
    const out = [];
    const centers = new Set(this.m.entities.filter((e) => e.c).map((e) => e.c));
    for (const [id, p] of Object.entries(this.m.points)) out.push({ p: [p.x, p.y], type: p.origin ? "origin" : centers.has(id) ? "center" : "end", pid: id });
    for (const e of this.m.entities) if (e.type === "line") { const a = this.P(e.p1), b = this.P(e.p2); out.push({ p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], type: "mid", eid: e.id }); }
    for (const q of this.pts) if (!q.pid) out.push({ p: q.p, type: "end" });
    return out;
  }
  snapPoint(p) {
    const tol = 10 * this.wpp();
    let best = null, bd = tol;
    for (const k of this.keyPoints()) { const d = d2(k.p, p); if (d < bd || (best && best.type === "mid" && d <= bd + 1e-9 && k.pid)) { bd = d; best = k; } }
    if (best) return { ...best, p: [...best.p] };
    // model geometry seen through the sketch plane: body vertices, edge midpoints, hole centres
    if (this.options.modelSnap !== false) {
      if (!this.modelPts) this.modelPts = [...(this.vp.modelSnapPoints ? this.vp.modelSnapPoints(this.plane) : []), ...cutSnapPoints(this.options.cutEdges !== false ? this.cutEdges : [])];
      bd = tol;
      for (const k of this.modelPts) { const d = d2(k.p, p); if (d < bd || (best && best.type === "mid" && k.type !== "mid" && d <= bd + 1e-9)) { bd = d; best = k; } }
      if (best) return { ...best, p: [...best.p] };
    }
    // on-curve snap: projected point + a coincident constraint
    let bestE = null; bd = tol * 0.8;
    for (const e of this.flat) { const dd = distToEntity(p, e); if (dd < bd) { bd = dd; bestE = e; } }
    if (bestE) return { p: projectOn(bestE, p), type: "on", eid: bestE.id };
    if (this.options.snap) { const s = this.vp.gridStep || 1; return { p: [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s], type: "grid" }; }
    return { p, type: null };
  }
  inferHV(start, p, snapped) {
    if (snapped) { // still infer when the snap lands exactly level
      if (Math.abs(p[1] - start[1]) < 1e-9 && Math.abs(p[0] - start[0]) > 1e-9) return { p, inf: "H" };
      if (Math.abs(p[0] - start[0]) < 1e-9 && Math.abs(p[1] - start[1]) > 1e-9) return { p, inf: "V" };
      return { p, inf: null };
    }
    const dx = p[0] - start[0], dy = p[1] - start[1], t = Math.tan(rad(2.5));
    if (Math.abs(dy) < Math.abs(dx) * t) return { p: [p[0], start[1]], inf: "H" };
    if (Math.abs(dx) < Math.abs(dy) * t) return { p: [start[0], p[1]], inf: "V" };
    return { p, inf: null };
  }
  // turn a clicked spot into a point id (+ constraints for mid / on-curve snaps)
  resolvePoint(q, deferred) {
    if (q.snap && q.snap.pid && d2(q.snap.p, q.p) < 1e-9) return q.snap.pid;
    const id = this.addPoint(q.p);
    // snapped onto model geometry: the point is fixed there, like projected edges
    if (q.snap && q.snap.model && d2(q.snap.p, q.p) < 1e-9) { this.m.points[id].fixed = true; return id; }
    if (q.snap && d2(q.snap.p, q.p) < 1e-9) {
      if (q.snap.type === "mid") deferred.push({ type: "midpoint", p: [id], e: [q.snap.eid] });
      if (q.snap.type === "on") deferred.push({ type: "coincident", p: [id], e: [q.snap.eid] });
    }
    return id;
  }

  // compute the tool's current point honoring typed (locked) field values
  constrained(raw) {
    const f = Object.fromEntries(this.fields.map((x) => [x.key, x]));
    const s = this.pts.length ? this.pts[this.pts.length - 1].p : null;
    let p = raw, inf = null;
    if (this.tool === "line" && s) {
      ({ p, inf } = this.inferHV(s, raw, this.snap && this.snap.type && this.snap.type !== "grid"));
      let L = d2(s, p), ang = Math.atan2(p[1] - s[1], p[0] - s[0]);
      if (f.len.locked) L = f.len.value;
      if (f.ang.locked) { ang = rad(f.ang.value); inf = null; }
      if (f.len.locked || f.ang.locked) p = [s[0] + L * Math.cos(ang), s[1] + L * Math.sin(ang)];
      if (!f.len.locked) f.len.value = L;
      if (!f.ang.locked) f.ang.value = deg(ang);
    } else if ((this.tool === "rect" || this.tool === "rectCenter") && s) {
      const half = this.tool === "rectCenter" ? 2 : 1;
      let w = (p[0] - s[0]) * half, h = (p[1] - s[1]) * half;
      if (f.w.locked) w = Math.sign(w || 1) * Math.abs(f.w.value);
      if (f.h.locked) h = Math.sign(h || 1) * Math.abs(f.h.value);
      p = [s[0] + w / half, s[1] + h / half];
      if (!f.w.locked) f.w.value = Math.abs(w);
      if (!f.h.locked) f.h.value = Math.abs(h);
    } else if ((this.tool === "circle" || this.tool === "polygon") && s) {
      let r = d2(s, p);
      const ang = r > 1e-9 ? Math.atan2(p[1] - s[1], p[0] - s[0]) : 0;
      if (f.dia.locked) r = f.dia.value / 2;
      p = [s[0] + r * Math.cos(ang), s[1] + r * Math.sin(ang)];
      if (!f.dia.locked) f.dia.value = 2 * r;
    } else if (this.tool === "arcCenter" && s) {
      const c = this.pts[0].p;
      if (this.pts.length === 1) {
        let r = d2(c, p);
        const ang = r > 1e-9 ? Math.atan2(p[1] - c[1], p[0] - c[0]) : 0;
        if (f.r.locked) r = Math.abs(f.r.value);
        p = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
        if (!f.r.locked) f.r.value = r;
      } else {
        // end point: on the circle through the start point; the sweep follows the mouse round
        // (unwrapped, so going past 180° keeps the direction instead of flipping to the short way)
        const st = this.pts[1].p, r = d2(c, st), a0 = Math.atan2(st[1] - c[1], st[0] - c[0]);
        const am = Math.atan2(p[1] - c[1], p[0] - c[0]);
        let rel = am - a0;
        const prev = this.arcSweep || 0;
        rel += 2 * Math.PI * Math.round((prev - rel) / (2 * Math.PI));
        if (Math.abs(rel) > 2 * Math.PI - 1e-3) rel = Math.sign(rel) * (2 * Math.PI - 1e-3);
        if (f.sweep.locked) rel = Math.sign(rel || 1) * Math.min(Math.abs(rad(f.sweep.value)), 2 * Math.PI - 1e-3);
        this.arcSweep = rel;
        p = [c[0] + r * Math.cos(a0 + rel), c[1] + r * Math.sin(a0 + rel)];
        if (!f.sweep.locked) f.sweep.value = Math.abs(deg(rel));
      }
    } else if (this.tool === "circle2p" && s) {
      let dia = d2(s, p);
      const ang = dia > 1e-9 ? Math.atan2(p[1] - s[1], p[0] - s[0]) : 0;
      if (f.dia.locked) dia = Math.abs(f.dia.value);
      p = [s[0] + dia * Math.cos(ang), s[1] + dia * Math.sin(ang)];
      if (!f.dia.locked) f.dia.value = dia;
    }
    this.inference = inf;
    return p;
  }

  // flat preview entities for the active drawing tool
  previewEntities(p) {
    const s = this.pts[0] && this.pts[0].p;
    if (!p) return [];
    switch (this.tool) {
      case "line": return this.pts.length ? [{ type: "line", a: this.pts[this.pts.length - 1].p, b: p }] : [];
      case "rect": return s ? rectPts(s, p).map((q, i, a) => ({ type: "line", a: q, b: a[(i + 1) % 4] })) : [];
      case "rectCenter": return s ? rectPts([2 * s[0] - p[0], 2 * s[1] - p[1]], p).map((q, i, a) => ({ type: "line", a: q, b: a[(i + 1) % 4] })) : [];
      case "circle": return s ? [{ type: "circle", c: s, r: d2(s, p) }] : [];
      case "polygon": return s ? polyPts(s, p, this.options.polygonSides).map((q, i, a) => ({ type: "line", a: q, b: a[(i + 1) % a.length] })) : [];
      case "arc":
        if (this.pts.length === 1) return [{ type: "line", a: s, b: p }];
        if (this.pts.length === 2 && circleFrom3(this.pts[0].p, p, this.pts[1].p)) return [{ type: "arc", a: this.pts[0].p, b: this.pts[1].p, m: p }];
        if (this.pts.length === 2) return [{ type: "line", a: this.pts[0].p, b: this.pts[1].p }];
        break;
      case "arcCenter": {
        if (!s) return [];
        if (this.pts.length === 1) return [{ type: "line", a: s, b: p }];
        const c = s, st = this.pts[1].p, r = d2(c, st), a0 = Math.atan2(st[1] - c[1], st[0] - c[0]), sw = this.arcSweep || 0;
        if (Math.abs(sw) < 1e-6) return [{ type: "line", a: c, b: st }];
        const m = [c[0] + r * Math.cos(a0 + sw / 2), c[1] + r * Math.sin(a0 + sw / 2)];
        return [{ type: "line", a: c, b: st, construction: true }, { type: "arc", a: st, b: p, m }];
      }
      case "circle2p": return s ? [{ type: "circle", c: mid(s, p), r: d2(s, p) / 2 }] : [];
      case "offset": return this.offsetRes && this.offsetRes.items ? itemsToFlat(this.offsetRes.items) : [];
      case "circle3p": {
        if (!s) return [];
        if (this.pts.length === 1) return [{ type: "line", a: s, b: p }];
        const cc = this.pts.length === 2 && circleFrom3(s, this.pts[1].p, p);
        return cc ? [{ type: "circle", c: cc.c, r: cc.r }] : this.pts.length === 2 ? [{ type: "line", a: s, b: this.pts[1].p }] : [];
      }
    }
    return [];
  }

  // ======================= pointer handling =======================
  move(e) {
    const raw = this.local(e);
    if (!raw) return;
    this.mouse = raw;
    if (this.tool === "select" || CONSTRAINT_TOOLS[this.tool]) { this.hover = this.hitTest(raw); this.render(false); return; }
    if (this.tool === "dimension") {
      this.hover = this.hitTest(raw);
      if (this.pending) this.updatePending(raw);
      this.render(false);
      return;
    }
    if (this.tool === "offset") {
      if (!this.offsetSel) { const h = this.hitTest(raw); this.hover = h && h.kind === "entity" ? h : null; this.render(false); return; }
      this.updateOffset();
      this.render();
      return;
    }
    this.snap = this.snapPoint(raw);
    this.mouse = this.constrained(this.snap.p);
    this.showGlyph(e);
    this.render();
  }
  click(e) {
    const raw = this.local(e);
    if (!raw) return;
    if (this.tool === "select") {
      const h = this.hitTest(raw);
      if (!e.shiftKey && !e.ctrlKey) this.selected.clear();
      if (h) { const k = `${h.kind === "point" ? "p" : "e"}:${h.id}`; if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k); }
      this.render();
      return;
    }
    if (this.tool === "dimension") { this.dimClick(raw); return; }
    if (this.tool === "offset") {
      if (this.offsetSel) { this.commitOffset(); return; }
      const h = this.hitTest(raw);
      if (h && h.kind === "entity") this.startOffset(h.id);
      return;
    }
    if (CONSTRAINT_TOOLS[this.tool]) {
      const h = this.hitTest(raw);
      if (!h) { this.picks = []; this.render(); return; }
      this.picks.push({ kind: h.kind === "point" ? "point" : "entity", id: h.id });
      this.tryConstraint();
      this.render();
      return;
    }
    this.snap = this.snapPoint(raw);
    this.commitPoint(this.constrained(this.snap.p));
  }
  dblclick() { if (this.tool === "line") this.endChain(); }

  commitPoint(p) {
    const t = this.tool;
    const here = { p, snap: this.snap };
    const typed = Object.fromEntries(this.fields.filter((f) => f.locked).map((f) => [f.key, f.value]));
    const deferred = [];
    const wp = this.wpp();
    if (t === "line") {
      if (!this.pts.length) { this.pts.push(here); this.afterTool(); return; }
      const prev = this.pts[this.pts.length - 1];
      if (d2(prev.p, p) < 1e-9) { this.endChain(); return; }
      this.snapshot();
      const a = this.chainLast || this.resolvePoint(prev, deferred);
      this.chainStart = this.chainStart || a;
      const b = this.resolvePoint(here, deferred);
      const id = this.addEntity({ type: "line", p1: a, p2: b });
      if (this.inference === "H") deferred.push({ type: "horizontal", e: [id] });
      if (this.inference === "V") deferred.push({ type: "vertical", e: [id] });
      if (typed.len != null) deferred.push(this.dimFor({ kind: "distance", p: [a, b], orient: "a" }, add(mid(this.P(a), p), mul(perp(unit(sub(p, this.P(a)))), 22 * wp))));
      this.commitDeferred(deferred);
      this.chainLast = b;
      this.pts.push({ p: this.P(b), pid: b });
      if (b === this.chainStart) { this.endChain(); return; }
    } else if (t === "rect" || t === "rectCenter" || t === "polygon" || t === "circle") {
      if (!this.pts.length) { this.pts.push(here); this.afterTool(); return; }
      const first = this.pts[0];
      this.snapshot();
      if (t === "circle") {
        const r = d2(first.p, p);
        if (r > 1e-9) {
          const c = this.resolvePoint(first, deferred);
          const id = this.addEntity({ type: "circle", c, r });
          if (here.snap && here.snap.type === "on" && d2(here.snap.p, p) < 1e-9) deferred.push({ type: "tangent", e: [here.snap.eid, id], internal: false, soft: true });
          if (typed.dia != null) deferred.push(this.dimFor({ kind: "diameter", e: [id] }, add(this.P(c), mul([0.7071, 0.7071], r + 18 * wp))));
        }
      } else if (t === "polygon") {
        const n = this.options.polygonSides, verts = polyPts(first.p, p, n);
        if (d2(first.p, p) > 1e-9) {
          const c = this.resolvePoint(first, deferred);
          const ids = verts.map((v) => this.addPoint(v));
          const lines = ids.map((v, i) => this.addEntity({ type: "line", p1: v, p2: ids[(i + 1) % n] }));
          const circ = this.addEntity({ type: "circle", c, r: d2(first.p, p), construction: true });
          ids.forEach((v) => deferred.push({ type: "coincident", p: [v], e: [circ] }));
          for (let i = 1; i < n; i++) deferred.push({ type: "equal", e: [lines[0], lines[i]] });
          if (typed.dia != null) deferred.push(this.dimFor({ kind: "diameter", e: [circ] }, add(first.p, [0, d2(first.p, p) + 18 * wp])));
        }
      } else {
        const corners = t === "rect" ? rectPts(first.p, p) : rectPts([2 * first.p[0] - p[0], 2 * first.p[1] - p[1]], p);
        if (Math.abs(corners[0][0] - corners[2][0]) > 1e-9 && Math.abs(corners[0][1] - corners[2][1]) > 1e-9) {
          let ids;
          if (t === "rect") { const a = this.resolvePoint(first, deferred), c = this.resolvePoint(here, deferred); ids = [a, this.addPoint(corners[1]), c, this.addPoint(corners[3])]; }
          else { const c = this.resolvePoint(here, deferred); ids = [this.addPoint(corners[0]), this.addPoint(corners[1]), c, this.addPoint(corners[3])]; }
          const lines = ids.map((v, i) => this.addEntity({ type: "line", p1: v, p2: ids[(i + 1) % 4] }));
          deferred.push({ type: "horizontal", e: [lines[0]] }, { type: "horizontal", e: [lines[2]] }, { type: "vertical", e: [lines[1]] }, { type: "vertical", e: [lines[3]] });
          if (t === "rectCenter") {
            const diag = this.addEntity({ type: "line", p1: ids[0], p2: ids[2], construction: true });
            const ctr = this.resolvePoint(first, deferred);
            deferred.push({ type: "midpoint", p: [ctr], e: [diag] });
          }
          const [c0, c1, c2] = corners.map((q) => q);
          if (typed.w != null) deferred.push(this.dimFor({ kind: "distance", p: [ids[0], ids[1]], orient: "h" }, [(c0[0] + c1[0]) / 2, Math.min(c0[1], c2[1]) - 22 * wp]));
          if (typed.h != null) deferred.push(this.dimFor({ kind: "distance", p: [ids[1], ids[2]], orient: "v" }, [Math.max(c1[0], c0[0]) + 22 * wp, (c1[1] + c2[1]) / 2]));
        }
      }
      this.commitDeferred(deferred);
      this.pts = [];
    } else if (t === "arcCenter") {
      if (this.pts.length < 2) {
        if (this.pts.length === 1 && d2(this.pts[0].p, p) < 1e-9) return;
        this.pts.push(here); this.arcSweep = 0; this.afterTool(); return;
      }
      const sw = this.arcSweep || 0;
      if (Math.abs(sw) > 1e-6) {
        this.snapshot();
        const c = this.resolvePoint(this.pts[0], deferred), a = this.resolvePoint(this.pts[1], deferred), b = this.resolvePoint(here, deferred);
        const [p1, p2] = sw > 0 ? [a, b] : [b, a];
        const id = this.addEntity({ type: "arc", c, p1, p2 });
        if (typed.r != null) deferred.push(this.dimFor({ kind: "radius", e: [id] }, add(this.P(c), mul([0.7071, 0.7071], d2(this.P(c), this.P(a)) + 18 * wp))));
        this.commitDeferred(deferred);
      }
      this.pts = []; this.arcSweep = 0;
    } else if (t === "circle2p" || t === "circle3p") {
      const need = t === "circle2p" ? 1 : 2;
      if (this.pts.length < need) {
        if (this.pts.some((q) => d2(q.p, p) < 1e-9)) return;
        this.pts.push(here); this.afterTool(); return;
      }
      const picks = [...this.pts, here];
      const cc = t === "circle2p" ? { c: mid(picks[0].p, p), r: d2(picks[0].p, p) / 2 } : circleFrom3(picks[0].p, picks[1].p, p);
      if (cc && cc.r > 1e-9) {
        this.snapshot();
        const c = this.addPoint(cc.c);
        const id = this.addEntity({ type: "circle", c, r: cc.r });
        // picks that landed on existing points stay on the circle
        for (const q of picks) if (q.snap && q.snap.pid && d2(q.snap.p, q.p) < 1e-9) deferred.push({ type: "coincident", p: [q.snap.pid], e: [id] });
        if (typed.dia != null) deferred.push(this.dimFor({ kind: "diameter", e: [id] }, add(cc.c, mul([0.7071, 0.7071], cc.r + 18 * wp))));
        this.commitDeferred(deferred);
      }
      this.pts = [];
    } else if (t === "arc") {
      if (this.pts.length < 2) { this.pts.push(here); this.afterTool(); return; }
      const ap = arcParams(this.pts[0].p, p, this.pts[1].p);
      if (ap) {
        this.snapshot();
        const a = this.resolvePoint(this.pts[0], deferred), b = this.resolvePoint(this.pts[1], deferred);
        const c = this.addPoint(ap.c);
        const [p1, p2] = ap.sweep > 0 ? [a, b] : [b, a];
        this.addEntity({ type: "arc", c, p1, p2 });
        this.commitDeferred(deferred);
      }
      this.pts = [];
    }
    this.afterTool();
  }
  dimFor(c, pos) { return { type: "dim", ...c, pos, value: measureDim(this.m, { type: "dim", ...c }) }; }
  commitDeferred(list) {
    for (const c of list) this.addConstraint(c, { quiet: true });
    solve(this.m);
    this.afterChange();
  }
  afterTool() {
    for (const f of this.fields) f.locked = false;
    this.fieldIdx = 0;
    this.clearHud();
    this.app.setCursorTip(this.tipFor());
    this.render();
  }
  endChain() { this.pts = []; this.chainLast = null; this.chainStart = null; this.afterTool(); }

  // Escape: first stop the current chain / picks, then drop the tool
  escape() {
    if (document.activeElement && this.hud.contains(document.activeElement)) { document.activeElement.blur(); for (const f of this.fields) f.locked = false; this.fieldIdx = 0; this.render(); return true; }
    if (this.offsetSel) { this.offsetSel = null; this.offsetRes = null; this.picks = []; for (const f of this.fields) f.locked = false; this.clearHud(); this.app.setCursorTip(this.tipFor()); this.render(); return true; }
    if (this.pts.length || this.picks.length || this.pending) { this.pts = []; this.picks = []; this.pending = null; this.endChain(); return true; }
    if (this.tool !== "select") { this.setTool("select"); this.app.onSketchToolChanged && this.app.onSketchToolChanged(); return true; }
    if (this.selected.size) { this.selected.clear(); this.render(); return true; }
    return false;
  }
  deleteSelected() {
    if (!this.selected.size) return false;
    this.snapshot();
    const sel = [...this.selected];
    const ents = sel.filter((k) => k.startsWith("e:")).map((k) => k.slice(2));
    const cons = sel.filter((k) => k.startsWith("c:")).map((k) => k.slice(2));
    // a selected free-standing point deletes the geometry attached to it
    const pts = sel.filter((k) => k.startsWith("p:")).map((k) => k.slice(2)).filter((id) => !this.m.points[id]?.origin);
    for (const k of sel) if (k.startsWith("fixglyph:") && this.m.points[k.slice(9)]) this.m.points[k.slice(9)].fixed = false;
    SM.deleteItems(this.m, { entities: ents, constraints: cons, points: pts });
    this.selected.clear();
    solve(this.m);
    this.afterChange();
    return true;
  }
  toggleConstruction() {
    const ents = [...this.selected].filter((k) => k.startsWith("e:")).map((k) => this.ent(k.slice(2))).filter(Boolean);
    if (ents.length) { this.snapshot(); for (const e of ents) e.construction = !e.construction; this.afterChange(); }
    else this.options.construction = !this.options.construction;
  }

  // ======================= hit testing & dragging =======================
  hitTest(p) {
    const tol = 8 * this.wpp();
    let best = null, bd = tol;
    for (const [id, q] of Object.entries(this.m.points)) { const d = d2(p, [q.x, q.y]); if (d < bd) { bd = d; best = { kind: "point", id, p: [q.x, q.y] }; } }
    if (best) return best;
    bd = tol;
    for (const e of this.flat) { const d = distToEntity(p, e); if (d < bd) { bd = d; best = { kind: "entity", id: e.id }; } }
    return best;
  }
  down(e) {
    if (this.tool !== "select") return false;
    const raw = this.local(e);
    const h = raw && this.hitTest(raw);
    if (!h) return false;
    let ids = [], radius = null;
    if (h.kind === "point") ids = [h.id];
    else {
      const en = this.ent(h.id);
      if (en.type === "circle") radius = en;
      else ids = SM.entityPoints(en);
    }
    ids = ids.filter((id) => !this.m.points[id].fixed);
    if (!ids.length && !radius) return false;
    this.snapshot();
    this.drag = { ids, radius, start: raw, orig: ids.map((id) => this.P(id)) };
    return true;
  }
  dragMove(e) {
    const d = this.drag; if (!d) return;
    const raw = this.local(e); if (!raw) return;
    const good = JSON.stringify(this.m);
    const fixedKeys = new Set();
    if (d.radius) { d.radius.r = Math.max(1e-3, d2(this.P(d.radius.c), raw)); fixedKeys.add(`r:${d.radius.id}`); }
    else {
      const delta = sub(raw, d.start);
      d.ids.forEach((id, i) => { this.m.points[id].x = d.orig[i][0] + delta[0]; this.m.points[id].y = d.orig[i][1] + delta[1]; fixedKeys.add(id); });
    }
    // constrained drag: hold the dragged geometry where the mouse is and let the solver move the rest
    if (!solve(this.m, { fixedKeys }).ok) this.restore(good);
    this.afterChange(false);
  }
  // released without moving = a click: select it (pressing on draggable geometry used to swallow the click,
  // so free lines could never be selected or deleted: bug report 2026-10-20 18:38)
  dragEnd(e, moved = true) {
    if (!this.drag) return;
    this.drag = null;
    if (!moved && e) { this.undoStack.pop(); this.click(e); return; }
    this.selected.clear();
    this.afterChange();
  }

  // ======================= constraint tools =======================
  tryConstraint() {
    const type = this.tool.slice(2);
    const ent = (pk) => (pk && pk.kind === "entity" ? this.ent(pk.id) : null);
    const isPt = (pk) => pk && pk.kind === "point";
    const isLine = (pk) => ent(pk) && ent(pk).type === "line";
    const isRound = (pk) => ent(pk) && ent(pk).type !== "line";
    const [A, B] = this.picks;
    let result = null, wait = false;
    switch (type) {
      case "coincident":
        if (!B) wait = isPt(A) || !!ent(A);
        else if (isPt(A) && isPt(B)) result = { merge: [A.id, B.id] };
        else if (isPt(A) && ent(B)) result = { c: { type: "coincident", p: [A.id], e: [B.id] } };
        else if (ent(A) && isPt(B)) result = { c: { type: "coincident", p: [B.id], e: [A.id] } };
        break;
      case "hv":
        if (isLine(A)) { const d = sub(this.P(ent(A).p2), this.P(ent(A).p1)); result = { c: { type: Math.abs(d[0]) >= Math.abs(d[1]) ? "horizontal" : "vertical", e: [A.id] } }; }
        else if (isPt(A) && !B) wait = true;
        else if (isPt(A) && isPt(B)) { const d = sub(this.P(B.id), this.P(A.id)); result = { c: { type: Math.abs(d[0]) >= Math.abs(d[1]) ? "horizontal" : "vertical", p: [A.id, B.id] } }; }
        break;
      case "parallel": case "perpendicular": case "collinear":
        if (isLine(A) && !B) wait = true;
        else if (isLine(A) && isLine(B)) result = { c: { type, e: [A.id, B.id] } };
        break;
      case "equal":
        if ((isLine(A) || isRound(A)) && !B) wait = true;
        else if ((isLine(A) && isLine(B)) || (isRound(A) && isRound(B))) result = { c: { type, e: [A.id, B.id] } };
        break;
      case "tangent":
        if (ent(A) && !B) wait = true;
        else if ((isLine(A) && isRound(B)) || (isRound(A) && isLine(B))) result = { c: { type, e: [A.id, B.id] } };
        else if (isRound(A) && isRound(B)) {
          const ea = ent(A), eb = ent(B), dd = d2(this.P(ea.c), this.P(eb.c));
          const ra = SM.radiusOf(this.m, ea), rb = SM.radiusOf(this.m, eb);
          result = { c: { type, e: [A.id, B.id], internal: dd < Math.max(ra, rb) } };
        }
        break;
      case "concentric":
        if (isRound(A) && !B) wait = true;
        else if (isRound(A) && isRound(B)) result = { c: { type, e: [A.id, B.id] } };
        break;
      case "midpoint":
        if ((isPt(A) || isLine(A)) && !B) wait = true;
        else if (isPt(A) && isLine(B)) result = { c: { type, p: [A.id], e: [B.id] } };
        else if (isLine(A) && isPt(B)) result = { c: { type, p: [B.id], e: [A.id] } };
        break;
      case "fix":
        if (A) result = { fix: isPt(A) ? [A.id] : SM.entityPoints(ent(A)) };
        break;
    }
    if (wait) return;
    if (!result) { // start over with the newest pick
      const last = this.picks[this.picks.length - 1];
      this.picks = last && this.picks.length > 1 ? [last] : [];
      if (this.picks.length) this.tryConstraint();
      return;
    }
    this.picks = [];
    this.snapshot();
    const undoTo = this.undoStack[this.undoStack.length - 1];
    if (result.merge) {
      const [a, b] = result.merge;
      const sameLine = this.m.entities.some((e) => e.type === "line" && [e.p1, e.p2].includes(a) && [e.p1, e.p2].includes(b));
      if (sameLine) { this.undoStack.pop(); this.toast("Can't make a line's own endpoints coincident"); return; }
      SM.mergePoints(this.m, a, b);
    } else if (result.fix) {
      const pts = result.fix.filter((id) => !this.m.points[id].origin && !this.isProjectedPoint(id));
      const allFixed = pts.every((id) => this.m.points[id].fixed);
      for (const id of pts) this.m.points[id].fixed = !allFixed;
    } else if (!this.addConstraint(result.c)) { this.undoStack.pop(); return; }
    if (!solve(this.m).ok) { this.restore(undoTo); this.undoStack.pop(); this.toast("Can't satisfy that constraint with the existing ones"); }
    this.afterChange();
  }
  isProjectedPoint(id) { return this.m.entities.some((e) => e.projected && SM.entityPoints(e).includes(id)); }

  // ======================= offset tool (feature request 2026-10-20) =======================
  startOffset(entityId) {
    const chain = findChain(this.m, entityId);
    if (!chain) return;
    this.offsetSel = { chain };
    this.picks = chain.segs.map((sg) => ({ kind: "entity", id: sg.id })); // drawn highlighted
    this.hover = null;
    this.updateOffset();
    this.app.setCursorTip(this.tipFor());
    this.render();
  }
  // signed distance: typed value (its sign flips the side the mouse is on) or the mouse's distance from the chain
  offsetDistance() {
    const side = this.mouse ? chainSide(this.m, this.offsetSel.chain, this.mouse) : 1;
    const f = this.fields[0];
    if (f && f.locked) return (side < 0 ? -1 : 1) * f.value;
    if (f) f.value = Math.abs(side);
    return side;
  }
  updateOffset() {
    if (!this.offsetSel) return;
    this.offsetRes = offsetChain(this.m, this.offsetSel.chain, this.offsetDistance());
  }
  commitOffset() {
    if (!this.offsetSel) return;
    this.updateOffset();
    const d = this.offsetDistance(), res = this.offsetRes;
    if (!res || res.error) { this.toast(res && res.error ? res.error : "Can't offset that"); return; }
    this.snapshot();
    const srcOf = new Map(this.m.entities.map((e) => [e.id, e]));
    const first = srcOf.get(this.offsetSel.chain.segs[0].id);
    const construction = !!(first && first.construction);
    const items = res.items, n = items.length, closed = this.offsetSel.chain.closed && items[0].type !== "circle";
    const ids = [];
    let startId = null, firstStart = null;
    const newLines = [];
    items.forEach((it, i) => {
      let e;
      if (it.type === "circle") e = { type: "circle", c: it.centerId, r: it.r };
      else {
        const a = startId || this.addPoint(it.a);
        if (i === 0) firstStart = a;
        const b = closed && i === n - 1 ? firstStart : this.addPoint(it.b);
        startId = b;
        if (it.type === "line") e = { type: "line", p1: a, p2: b };
        else {
          const c = it.corner || it.centerId; // offset arcs share their centre point (concentric); round corners sit on the vertex
          e = it.ccw ? { type: "arc", c, p1: a, p2: b } : { type: "arc", c, p1: b, p2: a };
        }
      }
      e.id = SM.sid("e");
      if (construction) e.construction = true;
      this.m.entities.push(e);
      ids.push(e.id);
      if (it.type === "line" && it.src) newLines.push([it.src, e.id]);
    });
    // keep it an offset: each new line parallel to its source at one distance (the first is a dimension, the
    // rest are hidden dimensions linked to it), so editing that one dimension moves the whole offset
    const geometryOnly = JSON.stringify(this.m);
    if (newLines.length) {
      SM.ensureDimNames(this.m);
      let lead = null;
      for (const [src, id] of newLines) {
        this.addConstraint({ type: "parallel", e: [src, id] }, { quiet: true });
        const L = this.ent(id), mp = mid(this.P(L.p1), this.P(L.p2));
        const dim = { type: "dim", kind: "lineDist", e: [src, id], value: Math.abs(d), pos: mp, id: SM.sid("d") };
        if (lead) Object.assign(dim, { expr: lead.name, deps: [lead.name.toLowerCase()], hidden: true });
        this.addConstraint(dim, { quiet: true });
        if (!lead && !dim.driven) { SM.ensureDimNames(this.m); lead = dim; }
      }
      if (!solve(this.m).ok) this.restore(geometryOnly);
    }
    this.offsetSel = null; this.offsetRes = null; this.picks = [];
    for (const f of this.fields) f.locked = false;
    this.clearHud();
    this.selected = new Set(ids.map((id) => `e:${id}`));
    this.afterChange();
    this.app.setCursorTip(this.tipFor());
  }

  // ======================= smart dimension tool =======================
  dimClick(raw) {
    const h = this.hitTest(raw);
    if (h) {
      const item = { kind: h.kind === "point" ? "point" : "entity", id: h.id };
      if (this.picks.some((x) => x.kind === item.kind && x.id === item.id)) return;
      const next = [...this.picks, item];
      this.picks = this.dimCombo(next) ? next : this.dimCombo([item]) ? [item] : [];
      this.pending = this.pendingFor(this.picks, raw);
      this.app.setCursorTip(this.tipFor());
      this.render(false);
      return;
    }
    if (this.pending) this.placeDim();
    else { this.picks = []; this.render(false); }
  }
  dimCombo(picks) {
    const k = picks.map((pk) => (pk.kind === "point" ? "pt" : this.ent(pk.id)?.type));
    const s = k.join(",");
    // a circle / arc with another (concentric: the gap between them, else centre to centre), a point or a line
    // (bug report 2026-10-20 19:14: two concentric circles couldn't be dimensioned to each other)
    const round = (t) => t === "circle" || t === "arc";
    if (k.length === 2 && (round(k[0]) || round(k[1])) && k.every((t) => t === "pt" || t === "line" || round(t))) return true;
    return ["pt", "line", "circle", "arc", "pt,pt", "pt,line", "line,pt", "line,line"].includes(s);
  }
  pendingFor(picks, mouse) {
    const k = picks.map((pk) => (pk.kind === "point" ? "pt" : this.ent(pk.id).type)).join(",");
    const [A, B] = picks;
    let c = null;
    if (k === "pt,pt") c = { kind: "distance", p: [A.id, B.id] };
    else if (k === "line") { const l = this.ent(A.id); c = { kind: "distance", p: [l.p1, l.p2] }; }
    else if (k === "pt,line") c = { kind: "pointLine", p: [A.id], e: [B.id] };
    else if (k === "line,pt") c = { kind: "pointLine", p: [B.id], e: [A.id] };
    else if (k === "line,line") {
      const l1 = this.ent(A.id), l2 = this.ent(B.id);
      const d1 = unit(sub(this.P(l1.p2), this.P(l1.p1))), d2_ = unit(sub(this.P(l2.p2), this.P(l2.p1)));
      c = Math.abs(d1[0] * d2_[1] - d1[1] * d2_[0]) < 1e-6 ? { kind: "lineDist", e: [A.id, B.id] } : { kind: "angle", e: [A.id, B.id] };
    } else if (/^(circle|arc),(circle|arc)$/.test(k)) {
      const ca = this.ent(A.id).c, cb = this.ent(B.id).c;
      c = ca === cb || len(sub(this.P(ca), this.P(cb))) < 1e-6 ? { kind: "radialGap", e: [A.id, B.id] } : { kind: "distance", p: [ca, cb] };
    } else if (/^pt,(circle|arc)$/.test(k)) c = { kind: "distance", p: [A.id, this.ent(B.id).c] };
    else if (/^(circle|arc),pt$/.test(k)) c = { kind: "distance", p: [this.ent(A.id).c, B.id] };
    else if (/^line,(circle|arc)$/.test(k)) c = { kind: "pointLine", p: [this.ent(B.id).c], e: [A.id] };
    else if (/^(circle|arc),line$/.test(k)) c = { kind: "pointLine", p: [this.ent(A.id).c], e: [B.id] };
    else if (k === "circle") c = { kind: "diameter", e: [A.id] };
    else if (k === "arc") c = { kind: "radius", e: [A.id] };
    if (!c) return null;
    c.type = "dim";
    this.updatePending(mouse, c);
    return c;
  }
  // orientation follows where the mouse is, like Fusion: above/below -> horizontal, left/right -> vertical
  updatePending(mouse, c = this.pending) {
    if (!c) return;
    c.pos = mouse;
    if (c.kind === "distance") {
      const a = this.P(c.p[0]), b = this.P(c.p[1]);
      const inX = mouse[0] > Math.min(a[0], b[0]) && mouse[0] < Math.max(a[0], b[0]);
      const inY = mouse[1] > Math.min(a[1], b[1]) && mouse[1] < Math.max(a[1], b[1]);
      c.orient = inX && !inY ? "h" : inY && !inX ? "v" : "a";
      if (Math.abs(a[1] - b[1]) < 1e-9) c.orient = "h";
      if (Math.abs(a[0] - b[0]) < 1e-9) c.orient = "v";
    }
    if (c.kind === "angle") {
      const l1 = this.ent(c.e[0]), l2 = this.ent(c.e[1]);
      const I = lineIntersect(this.P(l1.p1), this.P(l1.p2), this.P(l2.p1), this.P(l2.p2));
      if (I) {
        c.s1 = Math.sign(dot(sub(mouse, I), sub(this.P(l1.p2), this.P(l1.p1)))) || 1;
        c.s2 = Math.sign(dot(sub(mouse, I), sub(this.P(l2.p2), this.P(l2.p1)))) || 1;
      }
    }
    c.value = measureDim(this.m, c);
  }
  placeDim() {
    const c = { ...this.pending, id: SM.sid("d") };
    this.pending = null; this.picks = [];
    this.snapshot();
    this.addConstraint(c);
    this.afterChange();
    this.app.setCursorTip(this.tipFor());
    if (!c.driven) this.editDim(c.id);
  }
  // The edit box takes a value, math ("sqrt(2)*10", "cos(30)") or other dimensions by name ("d1 / 2");
  // while it is open, clicking another dimension inserts its name (like Fusion).
  editDim(id) {
    const c = this.m.constraints.find((x) => x.id === id);
    if (!c) return;
    SM.ensureDimNames(this.m);
    const g = this.dimGraphic(c);
    const sp = this.vp.worldToScreen(K.to3D(this.plane, g.label));
    const isAngle = c.kind === "angle";
    const text = c.expr || (isAngle ? String(+c.value.toFixed(3)) : fmtLen(c.value));
    this.editingDim = c.id; this.buildAnnot();
    const done = () => { if (this.editingDim === c.id) { this.editingDim = null; this.buildAnnot(); } };
    this.app.promptValue({ x: sp.x - 30, y: sp.y - 11, value: text, raw: true, unit: isAngle ? "deg" : "mm", label: `${c.name} ${c.kind === "diameter" ? "⌀" : c.kind === "radius" ? "R" : ""}`.trim(), onClose: done }, (typed) => {
      done();
      if (c.driven) { this.toast("Driven dimensions only report the current value"); return; }
      const vars = SM.dimVars(this.m, c.id);
      const v = this.evalDim(typed, c, vars);
      if (!isFinite(v)) {
        const unknown = exprNames(typed).filter((n) => !(n in vars));
        this.toast(unknown.length ? `Unknown name: ${unknown.join(", ")}${unknown.includes(String(c.name).toLowerCase()) ? " (a dimension can't use itself)" : ""}` : "Can't read that value");
        return;
      }
      if (v <= 0 && !isAngle) { this.toast("A dimension must be greater than zero"); return; }
      const names = exprNames(typed).filter((n) => n in vars);
      if (names.length && SM.dimExprLoop(this.m, c.id, names)) { this.toast("Those dimensions would refer to each other in a loop"); return; }
      const before = JSON.stringify(this.m);
      c.value = v;
      if (names.length) { c.expr = typed.trim(); c.deps = names; } else { delete c.expr; delete c.deps; }
      SM.applyDimExprs(this.m, (d, vs) => this.evalDim(d.expr, d, vs));
      if (!this.solveHolding(c)) { this.restore(before); this.toast("That value can't be solved with the current constraints"); }
      else this.undoStack.push(before);
      this.afterChange();
    });
  }

  // ======================= dimension / glyph geometry =======================
  dimGraphic(c) {
    const wp = this.wpp(), segs = [], gap = 3 * wp, ext = 6 * wp, ah = 9 * wp;
    const arrow = (tip, dir) => { const d = unit(dir), n = perp(d); segs.push([tip, add(tip, add(mul(d, -ah), mul(n, ah * 0.35)))], [tip, add(tip, add(mul(d, -ah), mul(n, -ah * 0.35)))]); };
    const linear = (p1, p2, dir, pos) => {
      const n = perp(dir);
      const off = dot(sub(pos, p1), n);
      const q1 = add(p1, mul(n, dot(sub(p1, p1), n) + off)), q2 = add(p2, mul(n, off - dot(sub(p2, p1), n)));
      const s = Math.sign(off) || 1;
      segs.push([add(p1, mul(n, s * gap)), add(q1, mul(n, s * ext))], [add(p2, mul(n, s * gap)), add(q2, mul(n, s * ext))], [q1, q2]);
      const u = sub(q2, q1);
      if (len(u) > 1e-9) { arrow(q1, mul(u, -1)); arrow(q2, u); }
      return mid(q1, q2);
    };
    let label = c.pos || [0, 0], text = "";
    const val = c.value;
    const mm = (v) => fmtDim(v); // in the design's units (units.js)
    if (c.kind === "distance") {
      const a = this.P(c.p[0]), b = this.P(c.p[1]);
      const dir = c.orient === "h" ? [1, 0] : c.orient === "v" ? [0, 1] : unit(sub(b, a));
      // for h/v the measured points are projected onto the measuring axis
      const aa = c.orient === "h" || c.orient === "v" ? a : a, bb = b;
      label = linear(aa, bb, dir, c.pos);
      text = mm(val);
    } else if (c.kind === "pointLine" || c.kind === "lineDist") {
      const l = this.ent(c.e[0]);
      const pt = c.kind === "pointLine" ? this.P(c.p[0]) : this.P(this.ent(c.e[1]).p1);
      const a = this.P(l.p1), d = unit(sub(this.P(l.p2), a));
      const foot = add(a, mul(d, dot(sub(pt, a), d)));
      const along = d;
      label = linear(pt, foot, unit(sub(foot, pt).every((v) => Math.abs(v) < 1e-12) ? perp(d) : sub(foot, pt)), c.pos);
      void along;
      text = mm(val);
    } else if (c.kind === "diameter" || c.kind === "radius") {
      const e = this.ent(c.e[0]), ctr = this.P(e.c), r = SM.radiusOf(this.m, e);
      let u = unit(sub(c.pos, ctr)); if (!isFinite(u[0])) u = [1, 0];
      const far = add(ctr, mul(u, r));
      if (c.kind === "diameter") { const near = add(ctr, mul(u, -r)); segs.push([near, far]); arrow(far, u); arrow(near, mul(u, -1)); }
      else { segs.push([ctr, far]); arrow(far, u); }
      if (len(sub(c.pos, ctr)) > r) segs.push([far, c.pos]);
      label = c.pos;
      text = `${c.kind === "diameter" ? "⌀" : "R"}${fmtDim(val, false)}`;
    } else if (c.kind === "radialGap") {
      const e1 = this.ent(c.e[0]), e2 = this.ent(c.e[1]), ctr = this.P(e1.c);
      const r1 = SM.radiusOf(this.m, e1), r2 = SM.radiusOf(this.m, e2);
      let u = unit(sub(c.pos, ctr)); if (!isFinite(u[0])) u = [1, 0];
      const p1 = add(ctr, mul(u, Math.min(r1, r2))), p2 = add(ctr, mul(u, Math.max(r1, r2)));
      segs.push([p1, p2]);
      if (len(sub(p2, p1)) > 1e-9) { arrow(p1, mul(u, -1)); arrow(p2, u); }
      const dp = dot(sub(c.pos, ctr), u);
      if (dp > Math.max(r1, r2)) segs.push([p2, c.pos]); else if (dp < Math.min(r1, r2)) segs.push([p1, c.pos]);
      label = c.pos;
      text = mm(val);
    } else if (c.kind === "angle") {
      const l1 = this.ent(c.e[0]), l2 = this.ent(c.e[1]);
      const I = lineIntersect(this.P(l1.p1), this.P(l1.p2), this.P(l2.p1), this.P(l2.p2)) || this.P(l1.p1);
      const u1 = mul(unit(sub(this.P(l1.p2), this.P(l1.p1))), c.s1 || 1), u2 = mul(unit(sub(this.P(l2.p2), this.P(l2.p1))), c.s2 || 1);
      const R = Math.max(len(sub(c.pos, I)), 10 * wp);
      const t1 = Math.atan2(u1[1], u1[0]);
      let sw = Math.atan2(u2[1], u2[0]) - t1;
      while (sw > Math.PI) sw -= 2 * Math.PI;
      while (sw < -Math.PI) sw += 2 * Math.PI;
      const k = 24;
      let prev = add(I, [R * Math.cos(t1), R * Math.sin(t1)]);
      for (let i = 1; i <= k; i++) { const t = t1 + (sw * i) / k; const q = add(I, [R * Math.cos(t), R * Math.sin(t)]); segs.push([prev, q]); prev = q; }
      const tm = t1 + sw / 2;
      label = add(I, [R * Math.cos(tm), R * Math.sin(tm)]);
      text = `${val.toFixed(1)}°`;
    }
    if (c.driven) text = `(${text})`;
    if (c.expr) text = `ƒx: ${text}`;
    if (this.editingDim && c.name) text = `${c.name}: ${text}`; // names show while a dimension is being edited
    return { segs, label, text };
  }
  glyphs() {
    const wp = this.wpp(), out = [], count = new Map();
    const anchorFor = (eid) => {
      const e = this.ent(eid); if (!e) return null;
      let p, t;
      if (e.type === "line") { const a = this.P(e.p1), b = this.P(e.p2); p = mid(a, b); t = unit(sub(b, a)); }
      else { const ctr = this.P(e.c), r = SM.radiusOf(this.m, e); const ang = e.type === "arc" ? SM.arcInfo(this.m, e).a0 + SM.arcInfo(this.m, e).sweep / 2 : Math.PI / 4; p = add(ctr, [r * Math.cos(ang), r * Math.sin(ang)]); t = [-Math.sin(ang), Math.cos(ang)]; }
      const i = count.get(eid) || 0; count.set(eid, i + 1);
      return add(add(p, mul(perp(t), 13 * wp)), mul(t, (i * 17 - 0) * wp));
    };
    for (const c of this.m.constraints) {
      if (c.type === "dim") continue;
      const g = GLYPH[c.type]; if (!g) continue;
      if (c.p && (c.type === "midpoint" || c.type === "coincident")) { const q = this.P(c.p[0]); out.push({ id: c.id, text: g, p: add(q, [11 * wp, -11 * wp]) }); continue; }
      if (c.p && !c.e) { out.push({ id: c.id, text: g, p: add(mid(this.P(c.p[0]), this.P(c.p[1])), [0, 12 * wp]) }); continue; }
      for (const eid of c.e || []) { const a = anchorFor(eid); if (a) out.push({ id: c.id, text: g, p: a }); }
    }
    for (const [id, p] of Object.entries(this.m.points)) if (p.fixed && !p.origin && !this.isProjectedPoint(id)) out.push({ id: `fix:${id}`, text: "🔒", p: [p.x + 10 * wp, p.y + 10 * wp], fix: id });
    return out;
  }

  // ======================= typed dimension boxes =======================
  key(e) {
    if (!this.fields.length || !this.hudActive()) return false;
    const inputs = [...this.hud.querySelectorAll(".dimbox:not(.prompt) input")];
    const focused = inputs.indexOf(document.activeElement);
    if (/^[0-9.\-]$/.test(e.key) && focused < 0) {
      const free = this.fields.findIndex((f) => !f.locked);
      this.fieldIdx = free >= 0 ? free : 0;
      const inp = inputs[this.fieldIdx];
      if (!inp) return false;
      inp.focus(); inp.value = e.key; inp.dispatchEvent(new Event("input"));
      e.preventDefault();
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const cur = this.fields[focused >= 0 ? focused : this.fieldIdx];
      if (cur && focused >= 0) { const v = parseFloat(inputs[focused].value); if (isFinite(v)) { cur.value = v; cur.locked = true; } }
      this.fieldIdx = ((focused >= 0 ? focused : this.fieldIdx) + 1) % this.fields.length;
      const inp = inputs[this.fieldIdx];
      if (inp) { inp.focus(); inp.select(); }
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (this.tool === "offset") { const inp = inputs[0]; if (inp && focused >= 0) inp.dispatchEvent(new Event("input")); this.commitOffset(); return true; }
      if (this.mouse) this.commitPoint(this.constrained(this.snap ? this.snap.p : this.mouse));
      return true;
    }
    return false;
  }
  clearHud() { this.hud.querySelectorAll(".dimbox:not(.prompt)").forEach((d) => d.remove()); this.hudInputs = null; }
  ensureHud() {
    if (this.hudInputs || !this.fields.length) return;
    this.hudInputs = this.fields.map((f, i) => {
      const wrap = document.createElement("div");
      wrap.className = "dimbox";
      const isLen = f.unit === "mm"; // lengths show and parse in the design's units
      wrap.innerHTML = `${f.label ? `<span>${f.label}</span>` : ""}<input spellcheck="false"><em>${isLen ? unitLabel() : f.unit}</em>`;
      const inp = wrap.querySelector("input");
      inp.addEventListener("input", () => {
        const v = isLen ? parseLength(inp.value) : parseNumber(inp.value);
        if (isFinite(v)) { f.value = v; f.locked = true; } else f.locked = false;
        this.fieldIdx = i;
        if (this.tool === "offset") { this.updateOffset(); this.render(false); return; }
        if (this.mouse) { this.mouse = this.constrained(this.snap ? this.snap.p : this.mouse); this.render(false); }
      });
      inp.addEventListener("keydown", (ev) => { if (["Tab", "Enter", "Escape"].includes(ev.key)) { ev.stopPropagation(); if (ev.key === "Escape") { inp.blur(); for (const x of this.fields) x.locked = false; this.fieldIdx = 0; this.render(); } else this.key(ev); } });
      this.hud.appendChild(wrap);
      return { wrap, inp, f };
    });
  }
  hudActive() { return this.pts.length > 0 || !!this.offsetSel; }
  positionHud() {
    if (!this.active || !this.hudInputs || !this.mouse || !this.hudActive()) return;
    const s = this.pts.length ? this.pts[this.pts.length - 1].p : this.mouse;
    const anchor = this.tool === "line" ? [(s[0] + this.mouse[0]) / 2, (s[1] + this.mouse[1]) / 2] : this.mouse;
    const sp = this.vp.worldToScreen(K.to3D(this.plane, anchor));
    const host = this.hud.getBoundingClientRect();
    this.hudInputs.forEach(({ wrap }, i) => { wrap.style.left = `${sp.x - host.left + 14}px`; wrap.style.top = `${sp.y - host.top - 30 + i * 26}px`; });
  }
  updateHudValues() {
    if (!this.hudActive() || !this.fields.length) { this.clearHud(); return; }
    this.ensureHud();
    for (const { inp, f, wrap } of this.hudInputs) { if (document.activeElement !== inp) inp.value = f.unit === "mm" ? fmtLen(f.value) : fmt(f.value); wrap.classList.toggle("locked", f.locked); }
    this.positionHud();
  }
  showGlyph(e) {
    const t = this.snap && this.snap.type;
    const label = { end: "▣", mid: "△", center: "◎", origin: "⊕", on: "⊙" }[t] || (this.inference === "H" ? "H" : this.inference === "V" ? "V" : "");
    if (!label) { this.glyph.style.display = "none"; return; }
    this.glyph.classList.toggle("model", !!(this.snap && this.snap.model)); // snapped to a body, not the sketch
    const host = this.glyph.parentElement.getBoundingClientRect();
    this.glyph.textContent = label;
    this.glyph.style.display = "block";
    this.glyph.style.left = `${e.clientX - host.left + 12}px`;
    this.glyph.style.top = `${e.clientY - host.top + 10}px`;
  }

  // ======================= annotation DOM (dimension text + constraint glyphs) =======================
  buildAnnot() {
    this.annot.innerHTML = "";
    this.annotEls = [];
    const mk = (cls, text, p, onclick, ondbl) => {
      const el = document.createElement("div");
      el.className = cls; el.textContent = text;
      if (onclick) el.addEventListener("click", (ev) => { ev.stopPropagation(); onclick(ev); });
      if (ondbl) el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); ondbl(ev); });
      this.annot.appendChild(el);
      this.annotEls.push({ el, p });
      return el;
    };
    const selectKey = (k, ev) => { if (!ev.shiftKey && !ev.ctrlKey) this.selected.clear(); if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k); this.render(false); };
    if (this.options.dimensions) {
      for (const c of this.m.constraints) {
        if (c.type !== "dim" || c.hidden) continue;
        const g = this.dimGraphic(c);
        const el = mk(`dimlabel${c.driven ? " driven" : ""}${this.selected.has(`c:${c.id}`) ? " sel" : ""}`, g.text, g.label, (ev) => selectKey(`c:${c.id}`, ev), () => this.editDim(c.id));
        el.title = `${c.name || ""}${c.expr ? ` = ${c.expr}` : ""}${c.driven ? " (driven dimension)" : " · double-click to edit"}`;
        // while another dimension's edit box is open, a click inserts this one's name instead of selecting it
        if (this.editingDim && c.name) {
          el.classList.add("ref");
          el.addEventListener("mousedown", (ev) => ev.preventDefault(), true);
          el.addEventListener("click", (ev) => {
            if (!this.editingDim || this.editingDim === c.id) return;
            ev.stopImmediatePropagation();
            const inp = document.querySelector("#hud .dimbox.prompt input");
            if (!inp) return;
            const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a;
            inp.value = inp.value.slice(0, a) + c.name + inp.value.slice(b);
            inp.dispatchEvent(new Event("input"));
            inp.focus(); inp.setSelectionRange(a + c.name.length, a + c.name.length);
          }, true);
        }
      }
      if (this.pending) mk("dimlabel pending", this.dimGraphic(this.pending).text, this.dimGraphic(this.pending).label);
    }
    if (this.options.constraints) {
      for (const g of this.glyphs()) {
        const key = g.fix ? `p:${g.fix}` : `c:${g.id}`;
        mk(`cglyph${this.selected.has(key) ? " sel" : ""}`, g.text, g.p, (ev) => selectKey(g.fix ? `fixglyph:${g.fix}` : key, ev));
      }
    }
    this.positionAnnot();
  }
  positionAnnot() {
    if (!this.active || !this.annotEls) return;
    const host = this.annot.getBoundingClientRect();
    for (const { el, p } of this.annotEls) {
      const sp = this.vp.worldToScreen(K.to3D(this.plane, p));
      el.style.transform = `translate(${sp.x - host.left}px, ${sp.y - host.top}px) translate(-50%, -50%)`;
    }
  }

  // ======================= rendering =======================
  render(updateHud = true) {
    if (!this.active) return;
    const buckets = { free: [], done: [], construction: [], projected: [], selected: [], hover: [], preview: [], dims: [], pend: [] };
    const push = (arr, e) => { const pts = entityPolyline(e); for (let i = 0; i < pts.length - 1; i++) arr.push(pts[i][0], pts[i][1], 0, pts[i + 1][0], pts[i + 1][1], 0); };
    const hoverId = this.hover && this.hover.kind === "entity" ? this.hover.id : null;
    const picked = new Set(this.picks.filter((p) => p.kind === "entity").map((p) => p.id));
    const byId = new Map(this.m.entities.map((e) => [e.id, e]));
    for (const e of this.flat || []) {
      const me = byId.get(e.id);
      if (this.selected.has(`e:${e.id}`) || picked.has(e.id)) push(buckets.selected, e);
      else if (e.id === hoverId) push(buckets.hover, e);
      else if (e.construction) push(buckets.construction, e);
      else if (e.projected) push(buckets.projected, e);
      else if (me && this.entityDetermined(me)) push(buckets.done, e);
      else push(buckets.free, e);
    }
    const cut = [];
    if (this.options.cutEdges !== false) for (const e of this.cutEdges || []) push(cut, e);
    const drawing = !["select", "dimension"].includes(this.tool) && !CONSTRAINT_TOOLS[this.tool];
    if (drawing) for (const e of this.previewEntities(this.mouse)) push(buckets.preview, e);
    const segPush = (arr, segs) => { for (const [a, b] of segs) arr.push(a[0], a[1], 0, b[0], b[1], 0); };
    if (this.options.dimensions) for (const c of this.m.constraints) if (c.type === "dim" && !c.hidden) segPush(buckets.dims, this.dimGraphic(c).segs);
    if (this.pending) segPush(buckets.pend, this.dimGraphic(this.pending).segs);
    const points = Object.values(this.m.points).map((p) => [p.x, p.y]);
    for (const q of this.pts) points.push(q.p);
    const snapPts = [];
    if (drawing && this.snap && this.snap.type && this.snap.type !== "grid") snapPts.push(this.snap.p);
    if (this.hover && this.hover.kind === "point") snapPts.push(this.hover.p);
    for (const pk of this.picks) if (pk.kind === "point") snapPts.push(this.P(pk.id));
    for (const k of this.selected) if (k.startsWith("p:") && this.m.points[k.slice(2)]) snapPts.push(this.P(k.slice(2)));
    const profiles = this.options.profiles ? (this.profiles || []).map((p) => ({ face: p.face, color: COLORS.profile, opacity: 0.36 })) : [];
    this.vp.setSketchOverlay({
      plane: this.plane, showGrid: this.options.grid, profiles,
      segments: [
        { pos: buckets.free, color: COLORS.sketch, width: 1.8 },
        { pos: buckets.done, color: COLORS.constrained, width: 1.8 },
        { pos: buckets.projected, color: 0x9b30d9, width: 1.6 },
        { pos: cut, color: 0xb57be0, width: 1.3, dashed: true }, // cut edges (not in the sketch until Intersect)
        { pos: buckets.construction, color: COLORS.construction, width: 1.4, dashed: true },
        { pos: buckets.dims, color: COLORS.dim, width: 1 },
        { pos: buckets.pend, color: COLORS.sketch, width: 1 },
        { pos: buckets.hover, color: COLORS.hover, width: 3 },
        { pos: buckets.selected, color: COLORS.select, width: 3 },
        { pos: buckets.preview, color: COLORS.sketch, width: 1.8 },
      ],
      points, snapPoints: snapPts,
    });
    this.buildAnnot();
    this.annot.style.setProperty("--dim", hex(COLORS.dim));
    if (updateHud) this.updateHudValues();
  }
}

function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
function rectPts(p, q) { return [[p[0], p[1]], [q[0], p[1]], [q[0], q[1]], [p[0], q[1]]]; }
function polyPts(c, v, n) {
  const r = d2(c, v), a0 = Math.atan2(v[1] - c[1], v[0] - c[0]), pts = [];
  for (let i = 0; i < n; i++) pts.push([c[0] + r * Math.cos(a0 + (i * 2 * Math.PI) / n), c[1] + r * Math.sin(a0 + (i * 2 * Math.PI) / n)]);
  return pts;
}
function lineIntersect(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c), den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return add(a, mul(r, t));
}
function projectOn(e, p) {
  if (e.type === "line") { const d = sub(e.b, e.a), l2 = dot(d, d) || 1e-12; const t = Math.max(0, Math.min(1, dot(sub(p, e.a), d) / l2)); return add(e.a, mul(d, t)); }
  const c = e.type === "circle" ? e.c : circleFrom3(e.a, e.m, e.b).c;
  const r = e.type === "circle" ? e.r : circleFrom3(e.a, e.m, e.b).r;
  return add(c, mul(unit(sub(p, c)), r));
}
/** Snap targets on cut edges: line ends + midpoints, arc ends, circle / arc centres. */
function cutSnapPoints(list) {
  const out = [];
  for (const e of list || []) {
    if (e.type === "line") out.push({ p: e.a, type: "end", model: true }, { p: e.b, type: "end", model: true }, { p: mid(e.a, e.b), type: "mid", model: true });
    else if (e.type === "circle") out.push({ p: e.c, type: "center", model: true });
    else if (e.type === "arc") { out.push({ p: e.a, type: "end", model: true }, { p: e.b, type: "end", model: true }); const c = circleFrom3(e.a, e.m, e.b); if (c) out.push({ p: c.c, type: "center", model: true }); }
  }
  return out;
}
