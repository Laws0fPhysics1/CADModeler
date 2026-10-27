// Assembly UI (Fusion-style): New Component, Joint, Move (free components), Ground, Drive Joints,
// the Components / Joints folders in the browser, and the viewport placement of every body.
// The maths lives in assembly.js; main.js only forwards a few hooks (see createAssemblyUI's return value).
import * as A from "./assembly.js";
import { applyGizmoDelta, moveMatrix } from "./viewport.js";
import { moveToolsRow, movedBounds, snapFor, keyStep, readoutText, showReadout, hideReadout } from "./movetools.js";
import { icons, jointIcon } from "./icons.js";
import "./assembly.css";

const clone = (o) => JSON.parse(JSON.stringify(o));
const HID = (id) => `asm:${id}`; // key of a component in doc.hidden

/** Snap a picked face / edge to a joint origin (see assembly.js snapToGeometry). */
export function snapJointOrigin(state, it) {
  const body = state.bodies.find((b) => b.id === it.body);
  if (!body) return null;
  const r = A.snapToGeometry(body.shape, it);
  return r ? { body: body.id, ...r } : null;
}

export function createAssemblyUI(ctx) {
  const { app, vp, h, ico, fmt } = ctx;
  const doc = () => app.doc;
  const ui = { selJoint: null, selJointFor: null, anim: null };

  // ---------------------------------------------------------------- model access
  function asm() {
    const d = doc();
    if (!d.assembly || !Array.isArray(d.assembly.components) || !Array.isArray(d.assembly.joints)) d.assembly = A.normalizeAssembly(d.assembly);
    return d.assembly;
  }
  const comp = (a, id) => a.components.find((c) => c.id === id) || null;
  const jointById = (a, id) => a.joints.find((j) => j.id === id) || null;
  /** The assembly to display: a running command's preview, else the document's. */
  const shown = () => (app.cmd && app.cmd.kind === "asm" && app.cmd.preview) || asm();
  const bodyIdsOf = (st) => (st || app.state).bodies.map((b) => b.id);
  const bodyName = (id) => (app.state.bodies.find((b) => b.id === id) || {}).name || id;

  function transformsFor(state, a = shown()) {
    if (!a.components.length) return null;
    const st = state || app.state, map = A.bodyTransforms(a, bodyIdsOf(st));
    // bodies made from a sketch on a placed component's face (kernel tagHost) follow that component
    for (const b of st.bodies) {
      if (!b.host || A.componentOfBody(a, b.id)) continue;
      const m = map.get(b.host);
      if (m) map.set(b.id, m);
    }
    // sketches and construction planes on a body's face follow it too ("sk:<id>" / "pl:<id>" keys, read by the viewport)
    for (const [pre, list] of [["sk", st.sketches], ["pl", st.planes]]) for (const x of Object.values(list || {})) {
      if (!x.host) continue;
      const m = map.get(x.host);
      if (m) map.set(`${pre}:${x.id}`, m);
    }
    return map;
  }
  /** Push the current (or a given) assembly's placement to the viewport, with no re-meshing. */
  function apply(a = shown()) {
    const st = app.mode === "sketch" && app.sk ? app.sk.base : app.state;
    vp.setBodyTransforms(transformsFor(st, a));
    if (ctx.onApplied) ctx.onApplied(a); // chains / belts follow their wheels (drivemotion.js)
    refreshGlyphs();
  }
  function commit(mutate, { log } = {}) {
    ctx.pushUndo();
    mutate(asm());
    if (log) ctx.logEvent("assembly", log);
    ctx.save(); apply(); ctx.refreshBrowser(); ctx.refreshHighlights();
  }
  function solveNow(a = asm()) { return A.solveAssembly(a, { bodyIds: bodyIdsOf() }); }
  function worldOf(a, compId) { return A.solveAssembly(a).transforms.get(compId) || A.identity(); }
  function selectedBodyIds() {
    return [...new Set(app.selection.filter((x) => x.body).map((x) => x.body))].filter((id) => app.state.bodies.some((b) => b.id === id));
  }
  function selectedComponents() {
    const a = asm(), out = new Set();
    for (const b of selectedBodyIds()) { const c = A.componentOfBody(a, b); if (c) out.add(c.id); }
    return [...out];
  }
  function nextName(base, list) { let n = 1; const used = new Set(list.map((x) => x.name)); while (used.has(`${base}${n}`)) n++; return `${base}${n}`; }
  function begin(cmd) {
    if (app.mode === "sketch") ctx.finishSketch();
    ctx.cancelCommand();
    app.cmd = { kind: "asm", ...cmd };
    if (cmd.type) app.lastCmd = cmd.type;
    ctx.logEvent("command started", { name: cmd.type });
    return app.cmd;
  }
  function endCmd() {
    stopAnim();
    app.cmd = null;
    ctx.closeDialog(); ctx.setTip("");
    apply(asm());
    ctx.refreshHighlights(); ctx.buildToolbar();
  }

  // ---------------------------------------------------------------- glyphs (joint origins)
  function jointWorldFrame(a, j, solved) {
    const s = solved || A.solveAssembly(a);
    const Tp = s.transforms.get(j.parent);
    if (!Tp) return null;
    return A.mul(Tp, A.toMat(j.frameParent));
  }
  function refreshGlyphs() {
    const list = [];
    const c = app.cmd;
    if (c && c.kind === "asm" && c.type === "joint") {
      const a = c.preview || asm();
      const s = A.solveAssembly(a);
      const at = (pick) => {
        const cid = pick.comp || (A.componentOfBody(a, pick.body) || {}).id; // preview wraps loose bodies in temp components
        const cm = cid ? s.transforms.get(cid) : null;
        const T = cm || A.identity();
        return A.mul(T, A.frameFromPoint(pick.origin, pick.z));
      };
      if (c.picks.child) list.push({ matrix: at(c.picks.child), color: 0xf39a1e });
      if (c.picks.parent) list.push({ matrix: at(c.picks.parent), color: 0x2b9a48 });
      if (c.hoverSnap) list.push({ matrix: c.hoverSnap.world, color: 0x5db4ec, dim: true });
    } else if (ui.selJoint && app.selection === ui.selJointFor) {
      const a = asm(), j = jointById(a, ui.selJoint);
      const F = j && jointWorldFrame(a, j);
      if (F) list.push({ matrix: F, color: 0xf39a1e });
    } else ui.selJoint = null;
    vp.setJointGlyphs(list);
  }

  // ---------------------------------------------------------------- New Component
  function newComponent() {
    const ids = selectedBodyIds();
    if (ids.length) { makeComponent(ids); return; }
    const c = begin({ type: "newComponent", bodies: [] });
    c.pickKinds = () => ["body"];
    c.onPick = (it) => {
      if (!it || !it.body) return;
      const i = c.bodies.indexOf(it.body);
      if (i >= 0) c.bodies.splice(i, 1); else c.bodies.push(it.body);
      render(); ctx.refreshHighlights();
    };
    c.highlights = () => c.bodies.map((b) => ({ item: { kind: "body", body: b }, style: "select" }));
    c.onOK = () => { if (!c.bodies.length) { ctx.toast("Select one or more bodies"); return; } const ids2 = [...c.bodies], nm = nameInp.value.trim() || null, gr = groundCb.checked; endCmd(); makeComponent(ids2, nm, { grounded: gr }); };
    const nameInp = h("input", { value: nextName("Component", asm().components), spellcheck: "false" });
    const groundCb = h("input", { type: "checkbox" });
    groundCb.checked = !asm().components.some((x) => x.grounded);
    const sel = h("button", { class: "sel-btn active" });
    const render = () => { sel.innerHTML = ""; sel.className = `sel-btn active${c.bodies.length ? " filled" : ""}`; sel.append(ico("select", "arrow"), h("span", { class: "cnt" }, c.bodies.length ? `${c.bodies.length} bod${c.bodies.length === 1 ? "y" : "ies"}` : "Select")); };
    render();
    ctx.dialogFrame("New Component", "newComponent", [
      h("div", { class: "dlg-row" }, h("label", {}, "Bodies"), h("div", { class: "ctl" }, sel)),
      h("div", { class: "dlg-row" }, h("label", {}, "Name"), h("div", { class: "ctl" }, h("div", { class: "num" }, nameInp))),
      h("div", { class: "dlg-row" }, h("label", {}, "Ground"), h("div", { class: "ctl" }, groundCb, h("span", { class: "asm-hint" }, "fixed in place"))),
      h("div", { class: "dlg-info" }, "Bodies keep their timeline geometry; the component places them as a group. Joints connect components."),
    ], { ok: "OK", onOK: c.onOK, onCancel: ctx.cancelCommand });
    ctx.setTip("Select bodies for the new component");
    ctx.refreshHighlights(); ctx.buildToolbar();
  }
  function makeComponent(bodyIds, name = null, opts = {}) {
    const a = asm();
    let id = null;
    commit((x) => {
      // keep the bodies where they are now: start from the first body's current world placement
      const bt = A.bodyTransforms(x, bodyIds);
      const T = bt.get(bodyIds[0]) || A.identity();
      const grounded = opts.grounded ?? !x.components.some((cc) => cc.grounded);
      const cnew = A.addComponent(x, bodyIds, { name: name || nextName("Component", x.components), grounded, transform: T });
      // drop components left empty, along with their joints
      for (const old of [...x.components]) if (old !== cnew && !old.bodies.length && !old.keep) A.removeComponent(x, old.id);
      id = cnew.id;
    }, { log: { action: "new component", bodies: bodyIds } });
    ctx.toast(`${comp(asm(), id).name}: ${bodyIds.length} bod${bodyIds.length === 1 ? "y" : "ies"}`);
    return id;
  }

  // ---------------------------------------------------------------- Joint
  // Rigid joints are "mates" (user, bug report 2026-10-18 15:32: "joint" implies motion), made with the
  // Mate command and listed in their own Mates folder; the data model is the same (type "rigid").
  function jointCmd(editId = null, { mate = false } = {}) {
    const a0 = asm();
    const editing = editId ? jointById(a0, editId) : null;
    if (editId && !editing) return;
    if (editing) mate = editing.type === "rigid";
    const c = begin({ type: "joint", editId });
    c.mate = mate;
    const u = (editing && editing.ui) || {};
    c.v = {
      type: editing ? editing.type : mate ? "rigid" : "revolute",
      flip: !!u.flip, angle: +u.angle || 0, offset: +u.offset || 0, offsetX: +u.offsetX || 0, offsetY: +u.offsetY || 0,
      lower: editing ? editing.limits.lower : null, upper: editing ? editing.limits.upper : null,
      value: editing ? editing.value : 0, value2: editing ? editing.value2 : 0,
      name: editing ? editing.name : null,
    };
    // picks: { body, comp, origin (modelled), z (modelled), what }
    c.picks = { child: null, parent: null };
    if (editing) {
      const fc = A.frameAxes(A.toMat(u.baseChild || editing.frameChild)), fp = A.frameAxes(A.toMat(u.baseParent || editing.frameParent));
      // base child frame is stored mated (z flipped); un-flip for the pick
      c.picks.child = { comp: editing.child, origin: fc.origin, z: fc.z.map((x) => -x), what: "joint origin", xHint: fc.x };
      c.picks.parent = { comp: editing.parent, origin: fp.origin, z: fp.z, what: "joint origin", xHint: fp.x };
      c.active = null;
    } else c.active = "child";
    c.pickKinds = () => (c.active ? ["edge", "face"] : []);
    c.onPick = (it) => {
      if (!c.active) return;
      const snap = it && snapJointOrigin(app.state, it);
      if (!snap) return;
      const cc = A.componentOfBody(asm(), snap.body);
      const other = c.active === "child" ? c.picks.parent : c.picks.child;
      if (other && ((cc && other.comp === cc.id) || (!cc && other.body === snap.body))) { ctx.toast("Pick a different component"); return; }
      c.picks[c.active] = { ...snap, comp: cc ? cc.id : null };
      c.active = c.active === "child" && !c.picks.parent ? "parent" : null;
      c.hoverSnap = null;
      update();
    };
    c.highlights = () => {
      const list = [];
      c.hoverSnap = null;
      if (c.active && app.hover && (app.hover.kind === "edge" || app.hover.kind === "face")) {
        const s = snapJointOrigin(app.state, app.hover);
        if (s) {
          const cc = A.componentOfBody(c.preview || asm(), s.body);
          const T = cc ? (A.solveAssembly(c.preview || asm()).transforms.get(cc.id) || A.identity()) : A.identity();
          c.hoverSnap = { world: A.mul(T, A.frameFromPoint(s.origin, s.z)) };
        }
      }
      refreshGlyphs();
      return list;
    };
    c.onCancel = () => { stopAnim(); vp.setJointGlyphs([]); apply(asm()); };
    c.onOK = () => {
      const built = buildJoint(c);
      if (built.error) { ctx.toast(built.error); return; }
      const pv = previewAssembly(c);
      if (pv.error) { ctx.toast(pv.error); return; }
      stopAnim();
      ctx.pushUndo();
      const a = asm();
      // create components for bodies that are not in one yet (Fusion needs components to joint)
      const ensure = (pick) => {
        if (pick.comp && comp(a, pick.comp)) return pick.comp;
        const cnew = A.addComponent(a, [pick.body], { name: nextName("Component", a.components), grounded: false });
        ctx.toast(`Made ${cnew.name} from ${bodyName(pick.body)}`);
        return cnew.id;
      };
      const childId = ensure(c.picks.child), parentId = ensure(c.picks.parent);
      // Fusion grounds the first component: ground the root of the parent's chain if nothing is grounded yet
      if (!a.components.some((x) => x.grounded)) {
        let root = parentId;
        for (let k = 0; k < 100 && A.parentJointOf(a, root); k++) root = A.parentJointOf(a, root).parent;
        if (root !== childId) comp(a, root).grounded = true;
      }
      const j = { ...built.joint, parent: parentId, child: childId };
      // timeline position: after the feature that was last before the marker when it was made
      if (!c.editId) { const d = doc(), f = d.features[Math.min(d.marker, d.features.length) - 1]; j.after = f ? f.id : null; }
      if (c.editId) { const i = a.joints.findIndex((x) => x.id === c.editId); a.joints[i] = { ...a.joints[i], ...j, id: c.editId }; }
      else a.joints.push({ ...j, id: A.nextId(a.joints, "j") });
      ctx.logEvent("assembly", { action: c.editId ? "edit joint" : "joint", joint: j.name, type: j.type });
      app.cmd = null;
      ctx.closeDialog(); ctx.setTip("");
      ctx.save(); apply(); ctx.refreshBrowser(); ctx.refreshHighlights(); ctx.buildToolbar();
    };
    openJointDialog(c);
    update();
    function update() { refreshJointDialog(c); preview(c); ctx.refreshHighlights(); }
    c.update = update;
  }
  function buildJoint(c) {
    const { child, parent } = c.picks;
    if (!child) return { error: "Select the joint origin on the component that moves" };
    if (!parent) return { error: "Select the joint origin on the component it attaches to" };
    const v = c.v;
    const baseParent = A.frameFromPoint(parent.origin, parent.z, parent.xHint);
    // child frame is mated: its z points into the part, so picked faces end up face to face
    const baseChild = A.frameFromPoint(child.origin, child.z.map((x) => -x), child.xHint);
    const frameParent = A.mulAll(baseParent, A.rotZ(v.angle || 0), A.translation(v.offsetX || 0, v.offsetY || 0, v.offset || 0));
    const frameChild = v.flip ? A.mul(baseChild, A.rotX(180)) : baseChild;
    const a = asm();
    const name = v.name || nextName(v.type === "rigid" ? "Mate" : A.JOINT_LABELS[v.type], a.joints);
    const joint = {
      name, type: v.type,
      frameParent: A.toArray(frameParent), frameChild: A.toArray(frameChild),
      value: +v.value || 0, value2: +v.value2 || 0,
      limits: { lower: v.lower, upper: v.upper },
      effort: null, velocity: null,
      ui: { baseParent: A.toArray(baseParent), baseChild: A.toArray(baseChild), flip: !!v.flip, angle: +v.angle || 0, offset: +v.offset || 0, offsetX: +v.offsetX || 0, offsetY: +v.offsetY || 0 },
    };
    if (c.editId) { const old = jointById(a, c.editId); if (old) { joint.effort = old.effort; joint.velocity = old.velocity; } }
    return { joint };
  }
  function previewAssembly(c) {
    const built = buildJoint(c);
    if (built.error) return { a: null, error: null };
    const a = clone(asm());
    const tmp = (pick, tag) => {
      if (pick.comp && comp(a, pick.comp)) return pick.comp;
      const cnew = A.addComponent(a, [pick.body], { id: `__${tag}`, name: bodyName(pick.body) });
      return cnew.id;
    };
    const childId = tmp(c.picks.child, "child"), parentId = tmp(c.picks.parent, "parent");
    let swapNote = null;
    const cc = comp(a, childId);
    if (cc.grounded) swapNote = `${cc.name} is grounded: pick the moving component first (or unground it)`;
    const j = { ...built.joint, id: c.editId || "__new", parent: parentId, child: childId };
    if (c.editId) a.joints = a.joints.map((x) => (x.id === c.editId ? j : x)); else a.joints.push(j);
    const s = A.solveAssembly(a);
    const err = s.errors.find((e) => e.joint === j.id);
    return { a, error: swapNote || (err && err.message) || null };
  }
  function preview(c) {
    const p = previewAssembly(c);
    c.preview = p.a;
    if (c.errEl) { c.errEl.textContent = p.error || ""; c.errEl.classList.toggle("show", !!p.error); }
    apply(c.preview || asm());
  }
  function openJointDialog(c) {
    const v = c.v;
    const typeRow = h("div", { class: "asm-types" });
    for (const t of A.JOINT_TYPES.filter((t) => (c.mate ? t === "rigid" : t !== "rigid"))) {
      const b = h("button", { class: "asm-type", title: A.JOINT_LABELS[t], onclick: () => { v.type = t; if (!A.jointDofs(t).length) { v.value = 0; v.value2 = 0; } c.update(); } }, ico(jointIcon[t]), h("span", {}, A.JOINT_LABELS[t]));
      b.dataset.type = t;
      typeRow.append(b);
    }
    const selBtn = (key) => h("button", { class: "sel-btn", onclick: () => { c.active = key; c.update(); } });
    c.selChild = selBtn("child"); c.selParent = selBtn("parent");
    const num = (key, unit, onchange) => {
      const inp = h("input", { value: fmt(v[key] ?? 0), spellcheck: "false" });
      inp.addEventListener("input", () => { const x = parseFloat(inp.value); if (Number.isFinite(x)) { v[key] = x; onchange && onchange(); c.update(); } });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); v[key] = +((+v[key] || 0) + (e.key === "ArrowUp" ? 1 : -1) * (unit === "deg" ? 15 : 1)).toFixed(4); inp.value = fmt(v[key]); c.update(); }
      });
      (c.inputs = c.inputs || {})[key] = inp;
      return h("div", { class: "num" }, inp, h("em", {}, unit));
    };
    const limit = (key, label) => {
      const cb = h("input", { type: "checkbox" });
      cb.checked = v[key] != null;
      const inp = h("input", { value: v[key] != null ? fmt(v[key]) : "", spellcheck: "false", placeholder: "none" });
      const unitEl = h("em", {}, "");
      cb.addEventListener("change", () => { v[key] = cb.checked ? (parseFloat(inp.value) || 0) : null; if (cb.checked && !inp.value) inp.value = "0"; c.update(); });
      inp.addEventListener("input", () => { const x = parseFloat(inp.value); if (Number.isFinite(x)) { v[key] = x; cb.checked = true; c.update(); } });
      (c.limitEls = c.limitEls || {})[key] = { cb, inp, unitEl };
      return h("div", { class: "dlg-row" }, h("label", {}, label), h("div", { class: "ctl" }, cb, h("div", { class: "num" }, inp, unitEl)));
    };
    const flipBtn = h("button", { class: "btn asm-flip", title: "Flip the moving component over (reverse its joint axis)", onclick: () => { v.flip = !v.flip; c.update(); } }, ico("revolve"), "Flip");
    c.flipBtn = flipBtn;
    c.motionRow = h("div", { class: "dlg-row" }, h("label", {}, "Position"), h("div", { class: "ctl" }, num("value", "deg"), h("button", { class: "mini asm-play", title: "Animate the joint through its range", html: icons.drive, onclick: () => toggleJointAnim(c) })));
    c.motion2Row = h("div", { class: "dlg-row" }, h("label", {}, "Slide"), h("div", { class: "ctl" }, num("value2", "mm")));
    c.limHead = h("div", { class: "asm-sec" }, "Joint Limits");
    c.limLower = limit("lower", "Minimum"); c.limUpper = limit("upper", "Maximum");
    c.errEl = h("div", { class: "dlg-err" });
    c.typeRow = typeRow;
    const kind = c.mate ? "Mate" : "Joint";
    ctx.dialogFrame(c.editId ? `Edit ${kind}` : c.mate ? "Rigid Mate" : "Joint", c.mate ? "jointRigid" : "joint", [
      ...(c.mate ? [h("div", { class: "dlg-info" }, "Locks Component 1 to Component 2 (no motion). Use Joint for parts that move.")] : [h("div", { class: "asm-sec" }, "Type"), typeRow]),
      h("div", { class: "asm-sec" }, "Position"),
      h("div", { class: "dlg-row" }, h("label", { title: "The component that moves: snap to a circle centre, face centre, axis or vertex" }, "Component 1"), h("div", { class: "ctl" }, c.selChild)),
      h("div", { class: "dlg-row" }, h("label", { title: "The component it attaches to (stays put)" }, "Component 2"), h("div", { class: "ctl" }, c.selParent)),
      h("div", { class: "dlg-row" }, h("label", {}, "Alignment"), h("div", { class: "ctl" }, flipBtn)),
      h("div", { class: "dlg-row" }, h("label", { title: "Rotate the alignment about the joint axis" }, "Angle"), h("div", { class: "ctl" }, num("angle", "deg"))),
      h("div", { class: "dlg-row" }, h("label", { title: "Offset across the joint axis (x of the origin on Component 2)" }, "Offset X"), h("div", { class: "ctl" }, num("offsetX", "mm"))),
      h("div", { class: "dlg-row" }, h("label", { title: "Offset across the joint axis (y of the origin on Component 2)" }, "Offset Y"), h("div", { class: "ctl" }, num("offsetY", "mm"))),
      h("div", { class: "dlg-row" }, h("label", { title: "Offset along the joint axis" }, "Offset Z"), h("div", { class: "ctl" }, num("offset", "mm"))),
      (c.motionHead = h("div", { class: "asm-sec" }, "Motion")), c.motionRow, c.motion2Row,
      c.limHead, c.limLower, c.limUpper,
      c.errEl,
    ], { ok: "OK", onOK: () => c.onOK(), onCancel: ctx.cancelCommand });
  }
  function refreshJointDialog(c) {
    const v = c.v;
    c.typeRow.querySelectorAll(".asm-type").forEach((b) => b.classList.toggle("active", b.dataset.type === v.type));
    const fill = (btn, key, label) => {
      const p = c.picks[key];
      btn.className = `sel-btn${c.active === key ? " active" : ""}${p ? " filled" : ""}`;
      btn.innerHTML = "";
      const nm = p ? `${p.comp ? (comp(asm(), p.comp) || {}).name || p.comp : bodyName(p.body)} · ${p.what}` : label;
      btn.append(ico("select", "arrow"), h("span", { class: "cnt" }, nm));
      if (p) btn.append(h("i", { class: "clr", html: icons.close, title: "Clear", onclick: (e) => { e.stopPropagation(); c.picks[key] = null; c.active = key; c.update(); } }));
    };
    fill(c.selChild, "child", "Select"); fill(c.selParent, "parent", "Select");
    c.flipBtn.classList.toggle("on", !!v.flip);
    const dofs = A.jointDofs(v.type);
    const unit = dofs[0] ? dofs[0].unit : "";
    c.motionRow.classList.toggle("hidden", !dofs.length);
    c.motionRow.querySelector("label").textContent = unit === "mm" ? "Distance" : "Angle";
    c.motionRow.querySelector("em").textContent = unit;
    c.motion2Row.classList.toggle("hidden", dofs.length < 2);
    for (const el of [c.motionHead, c.limHead, c.limLower, c.limUpper]) el.classList.toggle("hidden", !dofs.length);
    for (const k of ["lower", "upper"]) c.limitEls[k].unitEl.textContent = unit;
    for (const [k, inp] of Object.entries(c.inputs)) if (document.activeElement !== inp) inp.value = fmt(v[k] ?? 0);
    ctx.setTip(c.active === "child" ? "Select a joint origin on the component that moves (circle centre, face centre, vertex)" : c.active === "parent" ? "Select a joint origin on the component to attach to" : "");
  }
  function stopAnim() { if (ui.anim) { cancelAnimationFrame(ui.anim.raf); ui.anim = null; } }
  function rangeOf(type, limits, key = "value") {
    const deg = key === "value" && type !== "slider";
    const lo = limits && limits.lower != null && key === "value" ? limits.lower : deg ? -180 : -Math.max(50, Math.round(vp.modelSize * 0.5));
    const hi = limits && limits.upper != null && key === "value" ? limits.upper : deg ? 180 : Math.max(50, Math.round(vp.modelSize * 0.5));
    return [lo, Math.max(hi, lo)];
  }
  // sweep a value back and forth through its range; step(v) applies it
  function animate(lo, hi, start, step, onStop) {
    stopAnim();
    const span = hi - lo || 1, period = 2600;
    let ph = Math.asin(Math.max(-1, Math.min(1, ((start - lo) / span) * 2 - 1)));
    const t0 = performance.now() - (ph / (2 * Math.PI)) * period;
    const tick = () => {
      if (!ui.anim) return;
      const t = (performance.now() - t0) / period;
      step(lo + (Math.sin(t * 2 * Math.PI) + 1) / 2 * span);
      ui.anim.raf = requestAnimationFrame(tick);
    };
    ui.anim = { raf: requestAnimationFrame(tick), onStop };
  }
  function toggleJointAnim(c) {
    if (ui.anim) { stopAnim(); c.update(); return; }
    const dofs = A.jointDofs(c.v.type);
    if (!dofs.length || !c.picks.child || !c.picks.parent) return;
    const [lo, hi] = rangeOf(c.v.type, { lower: c.v.lower, upper: c.v.upper });
    animate(lo, hi, c.v.value, (x) => {
      c.v.value = +x.toFixed(3);
      preview(c);
      if (c.inputs.value && document.activeElement !== c.inputs.value) c.inputs.value.value = fmt(c.v.value, 1);
    });
  }

  // ---------------------------------------------------------------- Move (free components)
  function moveCmd(compId = null) {
    const a = asm();
    let id = compId || selectedComponents()[0] || null;
    const loose = !id ? selectedBodyIds() : [];
    if (!id && loose.length) id = makeComponent(loose, null, { grounded: false }); // Fusion moves components; wrap loose bodies in one
    if (!id) { ctx.toast("Select a component (or bodies) to move"); return; }
    const cc = comp(asm(), id);
    const pj = A.parentJointOf(asm(), id);
    if (pj) { ctx.toast(`${cc.name} is placed by joint ${pj.name}: use Drive Joints, or delete the joint`); return; }
    if (cc.grounded) { ctx.toast(`${cc.name} is grounded: unground it to move it`); return; }
    const c = begin({ type: "move", compId: id, v: { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 } });
    const T0 = worldOf(asm(), id);
    // rotate about the component's bounding-box centre
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const bv of vp.bodyViews) if (cc.bodies.includes(bv.id)) { const b = vp.bodyWorldBox(bv); lo = lo.map((x, i) => Math.min(x, b.min.getComponent(i))); hi = hi.map((x, i) => Math.max(x, b.max.getComponent(i))); }
    const pivot = Number.isFinite(lo[0]) ? lo.map((x, i) => (x + hi[i]) / 2) : [0, 0, 0];
    const compose = () => {
      const v = c.v;
      return A.mulAll(A.translation(v.dx, v.dy, v.dz), A.translation(...pivot), A.rotZ(v.rz), A.rotY(v.ry), A.rotX(v.rx), A.translation(-pivot[0], -pivot[1], -pivot[2]), T0);
    };
    const update = () => { const p = clone(asm()); comp(p, id).transform = A.toArray(compose()); c.preview = p; apply(p); };
    c.onCancel = () => apply(asm());
    c.onOK = () => {
      const T = compose();
      app.cmd = null; vp.hideGizmo(); ctx.closeDialog(); ctx.setTip("");
      commit((x) => { comp(x, id).transform = A.toArray(T); }, { log: { action: "move", component: id, ...c.v } });
      ctx.buildToolbar();
    };
    const inputs = {};
    const gizmoAt = () => [pivot[0] + c.v.dx, pivot[1] + c.v.dy, pivot[2] + c.v.dz];
    const num = (key, unit) => {
      const inp = h("input", { value: "0", spellcheck: "false" });
      inputs[key] = inp;
      inp.addEventListener("input", () => vp.setGizmoPosition(gizmoAt()));
      inp.addEventListener("input", () => { const x = parseFloat(inp.value); if (Number.isFinite(x)) { c.v[key] = x; update(); } });
      inp.addEventListener("keydown", (e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); c.v[key] = +(c.v[key] + (e.key === "ArrowUp" ? 1 : -1) * keyStep(unit)).toFixed(4); inp.value = fmt(c.v[key]); update(); vp.setGizmoPosition(gizmoAt()); } });
      return h("div", { class: "dlg-row" }, h("label", {}, { dx: "X Distance", dy: "Y Distance", dz: "Z Distance", rx: "X Angle", ry: "Y Angle", rz: "Z Angle" }[key]), h("div", { class: "ctl" }, h("div", { class: "num" }, inp, h("em", {}, unit))));
    };
    const setV = (v) => {
      for (const k of Object.keys(inputs)) { c.v[k] = v[k]; inputs[k].value = fmt(c.v[k]); }
      update(); vp.setGizmoPosition(gizmoAt());
    };
    // the component's vertices in world space where the move started (for Drop to Ground / Center)
    let startPts = null;
    const worldPts = () => startPts || (startPts = vp.bodyViews.filter((bv) => cc.bodies.includes(bv.id)).map((bv) => {
      const src = bv.mesh.geometry.getAttribute("position").array, m = bv.grp.matrix.elements, out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) for (let k = 0; k < 3; k++) out[i + k] = m[k] * src[i] + m[4 + k] * src[i + 1] + m[8 + k] * src[i + 2] + m[12 + k];
      return out;
    }));
    ctx.dialogFrame("Move/Copy", "move", [
      h("div", { class: "dlg-row" }, h("label", {}, "Component"), h("div", { class: "ctl" }, h("span", { class: "asm-pill" }, ico("component"), cc.name))),
      h("div", { class: "asm-sec" }, "Translate"), num("dx", "mm"), num("dy", "mm"), num("dz", "mm"),
      h("div", { class: "asm-sec" }, "Rotate (about the component centre)"), num("rx", "deg"), num("ry", "deg"), num("rz", "deg"),
      h("div", { class: "dlg-row wide" }, moveToolsRow({ get: () => c.v, set: setV, bounds: (v) => movedBounds(worldPts(), moveMatrix(v, pivot)) })),
      h("div", { class: "dlg-info" }, "Moves a free component (no joint, not grounded) and everything jointed to it. Drag the gizmo's arrows, squares or rings; they step by the Snap setting (hold Shift for fine steps)."),
    ], { ok: "OK", onOK: c.onOK, onCancel: ctx.cancelCommand });
    // drag gizmo: arrows / squares / ball translate, rings rotate about the world axes through the centre
    vp.showGizmo({
      position: gizmoAt(),
      onStart: () => { c.gz0 = { ...c.v }; },
      onDrag: (d, e) => {
        const snap = snapFor(e);
        Object.assign(c.v, applyGizmoDelta(c.gz0, d, snap));
        for (const k in inputs) if (document.activeElement !== inputs[k]) inputs[k].value = fmt(c.v[k]);
        update(); vp.setGizmoPosition(gizmoAt());
        showReadout(e, readoutText(d, c.v, snap));
      },
      onEnd: () => hideReadout(),
    });
    ctx.refreshHighlights(); ctx.buildToolbar();
  }

  // ---------------------------------------------------------------- Ground
  function setGrounded(id, on) {
    const a = asm(), cc = comp(a, id);
    if (!cc) return;
    if (on && A.parentJointOf(a, id)) { ctx.toast(`${cc.name} is placed by joint ${A.parentJointOf(a, id).name}; delete the joint to ground it`); return; }
    commit((x) => { A.bakeTransforms(x, [id]); comp(x, id).grounded = !!on; }, { log: { action: on ? "ground" : "unground", component: id } });
  }
  function groundCmd() {
    const ids = selectedComponents();
    if (!ids.length) { ctx.toast(asm().components.length ? "Select a component's bodies (or use the browser's right-click menu)" : "Make a component first (ASSEMBLE > New Component)"); return; }
    const a = asm();
    const on = !ids.every((id) => comp(a, id).grounded);
    for (const id of ids) setGrounded(id, on);
  }

  // ---------------------------------------------------------------- Drive Joints
  function driveCmd(focusId = null) {
    const a0 = asm();
    const drivenBy = new Map((a0.links || []).map((l) => [l.driven, l]));
    const drivable = a0.joints.filter((j) => A.jointDofs(j.type).length && !drivenBy.has(j.id));
    if (!drivable.length) { ctx.toast("No movable joints: make a Revolute, Slider or Cylindrical joint first"); return; }
    const c = begin({ type: "drive" });
    c.preview = clone(a0);
    const rows = [];
    c.onCancel = () => { stopAnim(); apply(asm()); };
    c.onOK = () => {
      stopAnim();
      const p = c.preview;
      app.cmd = null; ctx.closeDialog(); ctx.setTip("");
      // linked joints store the value their link gives them, so unlinking leaves them where they are
      const lv = A.resolveLinks(p);
      commit((x) => { for (const j of x.joints) { const q = jointById(p, j.id); if (q) { j.value = lv.has(j.id) ? lv.get(j.id) : q.value; j.value2 = q.value2; } } }, { log: { action: "drive" } });
      ctx.buildToolbar();
    };
    const ordered = focusId ? [...drivable.filter((j) => j.id === focusId), ...drivable.filter((j) => j.id !== focusId)] : drivable;
    for (const j0 of ordered) {
      for (const dof of A.jointDofs(j0.type)) {
        const j = jointById(c.preview, j0.id);
        const [lo, hi] = rangeOf(j.type, j.limits, dof.key);
        const step = dof.unit === "deg" ? 0.5 : 0.1;
        const slider = h("input", { type: "range", min: lo, max: hi, step, value: j[dof.key] });
        const inp = h("input", { value: fmt(j[dof.key]), spellcheck: "false" });
        const set = (x, from) => {
          const val = dof.key === "value" ? A.clampToLimits(x, j.limits) : x;
          j[dof.key] = val;
          if (from !== "slider") slider.value = val;
          if (from !== "input" || val !== x) inp.value = fmt(val, 2);
          apply(c.preview);
        };
        slider.addEventListener("input", () => { stopAnim(); set(+slider.value, "slider"); });
        inp.addEventListener("input", () => { const x = parseFloat(inp.value); if (Number.isFinite(x)) set(x, "input"); });
        const play = h("button", { class: "mini asm-play", title: "Animate", html: icons.drive, onclick: () => {
          if (ui.anim && ui.anim.key === `${j.id}:${dof.key}`) { stopAnim(); return; }
          animate(lo, hi, j[dof.key], (x) => set(+x.toFixed(2)));
          ui.anim.key = `${j.id}:${dof.key}`;
        } });
        const label = `${j.name}${dof.key === "value2" ? " (slide)" : ""}`;
        rows.push(h("div", { class: `asm-drive${j.id === focusId ? " focus" : ""}` },
          h("div", { class: "asm-drive-head" }, ico(jointIcon[j.type]), h("span", {}, label), h("span", { class: "asm-range" }, `${fmt(lo, 1)} … ${fmt(hi, 1)} ${dof.unit}`)),
          h("div", { class: "asm-drive-ctl" }, slider, h("div", { class: "num" }, inp, h("em", {}, dof.unit)), play)));
      }
    }
    const followers = a0.joints.filter((j) => drivenBy.has(j.id));
    ctx.dialogFrame("Drive Joints", "drive", [
      ...rows,
      followers.length ? h("div", { class: "dlg-info asm-followers" }, `Following through motion links: ${followers.map((j) => j.name).join(", ")}`) : null,
      h("div", { class: "dlg-info" }, "Values stop at the joint limits. OK keeps the new positions."),
    ], { ok: "OK", onOK: c.onOK, onCancel: ctx.cancelCommand });
    ctx.refreshHighlights(); ctx.buildToolbar();
  }

  // ---------------------------------------------------------------- delete / rename
  function deleteComponent(id) {
    commit((x) => { A.bakeTransforms(x); A.removeComponent(x, id); }, { log: { action: "delete component", component: id } });
    doc().hidden = doc().hidden.filter((k) => k !== HID(id));
    ctx.applyVisibility(); ctx.save();
  }
  function deleteJoint(id) {
    commit((x) => {
      const j = jointById(x, id);
      if (j) A.bakeTransforms(x, [j.child]);
      x.joints = x.joints.filter((jj) => jj.id !== id);
      x.links = (x.links || []).filter((l) => l.driver !== id && l.driven !== id);
    }, { log: { action: "delete joint", joint: id } });
  }
  function rename(kind, id, e) {
    const a = asm(), obj = kind === "component" ? comp(a, id) : jointById(a, id);
    if (!obj) return;
    ctx.promptValue({ x: e.clientX, y: e.clientY, label: "Name", value: obj.name, text: true }, (v) => { if (v) commit((x) => { (kind === "component" ? comp(x, id) : jointById(x, id)).name = v; }); });
  }

  // ---------------------------------------------------------------- browser rows
  function browserRows(tree, open, hidden, depth = 1) {
    const a = asm();
    if (!a.components.length && !a.joints.length) return;
    a.links = a.links || [];
    const solved = solveNow(a);
    const badJ = new Map(solved.errors.filter((e) => e.joint).map((e) => [e.joint, e.message]));
    const have = new Set(bodyIdsOf(app.mode === "sketch" && app.sk ? app.sk.base : app.state));
    const row = (d, { key, icon, name, eye, eyeId, leaf, sel, onclick, ondbl, onctx, err, sub, dim, extra, title }) => {
      const r = h("div", { class: `br-row${sel ? " selected" : ""}${dim ? " dim" : ""}`, style: `padding-left:${4 + d * 14}px`, title: title || null, onclick, ondblclick: ondbl, oncontextmenu: onctx ? (ev) => { ev.preventDefault(); ev.stopPropagation(); onctx(ev); } : null });
      r.append(h("i", { class: `tw${leaf ? " leaf" : ""}`, html: open[key] ? icons.caret : icons.caretRight, onclick: (ev) => { ev.stopPropagation(); open[key] = !open[key]; ctx.refreshBrowser(); } }));
      if (eye !== undefined) r.append(h("i", { class: `eye${eye ? "" : " off"}`, html: eye ? icons.eye : icons.eyeOff, title: "Show/Hide", onclick: (ev) => { ev.stopPropagation(); ctx.toggleVisible(eyeId); } }));
      r.append(ico(icon), h("span", { class: `nm${err ? " err" : ""}` }, name));
      if (sub) r.append(h("span", { class: "sub" }, sub));
      if (extra) r.append(extra);
      tree.append(r);
    };
    if (open.asmComponents === undefined) open.asmComponents = true;
    if (open.asmJoints === undefined) open.asmJoints = true;
    if (a.components.length) {
      row(depth, { key: "asmComponents", icon: "folder", name: "Components", sub: `${a.components.length}` });
      if (open.asmComponents) for (const cc of a.components) {
        const key = `asmc:${cc.id}`;
        const present = cc.bodies.filter((b) => have.has(b));
        const sel = present.length > 0 && present.every((b) => app.selection.some((x) => x.kind === "body" && x.body === b));
        const pj = A.parentJointOf(a, cc.id);
        const pin = h("i", { class: `asm-pin${cc.grounded ? " on" : ""}`, html: icons.pin, title: cc.grounded ? "Grounded (click to unground)" : "Ground", onclick: (ev) => { ev.stopPropagation(); setGrounded(cc.id, !cc.grounded); } });
        row(depth + 1, {
          key, icon: "component", name: cc.name, eye: !hidden.has(HID(cc.id)), eyeId: HID(cc.id), sel, dim: !present.length && !cc.keep,
          sub: !present.length ? (cc.keep ? "mount" : "no bodies") : pj ? `⟵ ${pj.name}` : "", extra: pin,
          title: `${cc.name}: ${cc.bodies.length} bod${cc.bodies.length === 1 ? "y" : "ies"}${cc.grounded ? ", grounded" : ""}`,
          onclick: (ev) => { const items = present.map((b) => ({ kind: "body", body: b })); app.selection = ev.ctrlKey || ev.shiftKey ? [...app.selection, ...items] : items; ctx.refreshHighlights(); ctx.refreshBrowser(); },
          onctx: (ev) => ctx.openMenu(null, [
            { label: "Rename", icon: "sketchSmall", run: () => rename("component", cc.id, ev) },
            { label: cc.grounded ? "Unground" : "Ground", icon: "ground", run: () => setGrounded(cc.id, !cc.grounded) },
            { label: "Move/Copy", icon: "move", run: () => moveCmd(cc.id) },
            ...(pj ? [{ label: `Drive ${pj.name}`, icon: "drive", run: () => driveCmd(pj.id) }] : []),
            "|",
            { label: "Delete Component (keep bodies)", icon: "trash", run: () => deleteComponent(cc.id) },
          ], { x: ev.clientX, y: ev.clientY }),
        });
        if (open[key]) for (const b of cc.bodies) {
          const ok = have.has(b);
          row(depth + 2, { key: `asmb:${cc.id}:${b}`, icon: "body", name: ok ? bodyName(b) : b, leaf: true, dim: !ok, sub: ok ? "" : "not in timeline", sel: app.selection.some((x) => x.kind === "body" && x.body === b),
            onclick: (ev) => { if (!ok) return; const it = { kind: "body", body: b }; app.selection = ev.ctrlKey || ev.shiftKey ? [...app.selection, it] : [it]; ctx.refreshHighlights(); ctx.refreshBrowser(); } });
        }
      }
    }
    for (const [fkey, fname, list] of [["asmMates", "Mates", a.joints.filter((j) => j.type === "rigid")], ["asmJoints", "Joints", a.joints.filter((j) => j.type !== "rigid")]]) {
      if (!list.length) continue;
      row(depth, { key: fkey, icon: "folder", name: fname, sub: `${list.length}` });
      if (open[fkey]) for (const j of list) {
        const dofs = A.jointDofs(j.type);
        const lk = a.links.find((l) => l.driven === j.id);
        const val = dofs.length ? `${lk ? "⚙ " : ""}${fmt(solved.values.get(j.id) ?? j.value, 1)} ${dofs[0].unit}` : A.JOINT_LABELS[j.type];
        const pc = comp(a, j.parent), cc = comp(a, j.child);
        row(depth + 1, {
          key: `asmj:${j.id}`, icon: jointIcon[j.type] || "joint", name: j.name, leaf: true, sub: val, err: badJ.has(j.id),
          title: badJ.get(j.id) || `${A.JOINT_LABELS[j.type]}: ${cc ? cc.name : j.child} on ${pc ? pc.name : j.parent}`,
          sel: ui.selJoint === j.id && app.selection === ui.selJointFor,
          onclick: () => { app.selection = []; ui.selJoint = j.id; ui.selJointFor = app.selection; ctx.refreshHighlights(); ctx.refreshBrowser(); },
          ondbl: () => jointCmd(j.id),
          onctx: (ev) => ctx.openMenu(null, [
            { label: j.type === "rigid" ? "Edit Mate" : "Edit Joint", icon: jointIcon[j.type] || "joint", run: () => jointCmd(j.id) },
            ...(dofs.length ? [{ label: "Drive Joint", icon: "drive", run: () => driveCmd(j.id) }] : []),
            { label: "Rename", icon: "sketchSmall", run: () => rename("joint", j.id, ev) },
            "|",
            { label: "Delete", icon: "trash", run: () => deleteJoint(j.id) },
          ], { x: ev.clientX, y: ev.clientY }),
        });
      }
    }
    if (a.links.length) {
      const badL = new Map(solved.errors.filter((e) => e.link).map((e) => [e.link, e.message]));
      if (open.asmLinks === undefined) open.asmLinks = true;
      row(depth, { key: "asmLinks", icon: "folder", name: "Motion Links", sub: `${a.links.length}` });
      if (open.asmLinks) for (const l of a.links) {
        const dj = jointById(a, l.driver), sj = jointById(a, l.driven);
        row(depth + 1, {
          key: `asml:${l.id}`, icon: "gearLink", name: l.name, leaf: true, err: badL.has(l.id), sub: linkText(l),
          title: badL.get(l.id) || `${sj ? sj.name : l.driven} follows ${dj ? dj.name : l.driver}`,
          ondbl: () => linkCmd(l.id),
          onctx: (ev) => ctx.openMenu(null, [
            { label: "Edit Motion Link", icon: "gearLink", run: () => linkCmd(l.id) },
            { label: `Drive ${dj ? dj.name : "driver"}`, icon: "drive", run: () => driveCmd(l.driver) },
            { label: "Rename", icon: "sketchSmall", run: () => renameLink(l.id, ev) },
            "|",
            { label: "Delete", icon: "trash", run: () => commit((x) => { x.links = x.links.filter((y) => y.id !== l.id); }, { log: { action: "delete link", link: l.id } }) },
          ], { x: ev.clientX, y: ev.clientY }),
        });
      }
    }
  }
  function linkText(l) {
    const r = +l.ratio;
    if (l.type === "rack") return `${fmt(r * 360, 2)} mm/rev`;
    if (l.teeth) return `${l.teeth[0]}:${l.teeth[1]}${r < 0 ? " (reversed)" : ""}`;
    return `× ${fmt(r, 4)}`;
  }
  function renameLink(id, e) {
    const l = (asm().links || []).find((x) => x.id === id);
    if (!l) return;
    ctx.promptValue({ x: e.clientX, y: e.clientY, label: "Name", value: l.name, text: true }, (v) => { if (v) commit((x) => { x.links.find((y) => y.id === id).name = v; }); });
  }

  // ---------------------------------------------------------------- Motion Link (Fusion: ASSEMBLE → Motion Link)
  function linkCmd(editId = null) {
    const a0 = asm();
    a0.links = a0.links || [];
    const movable = a0.joints.filter((j) => A.jointDofs(j.type).length);
    if (movable.length < 2) { ctx.toast("A motion link needs two movable joints (Revolute, Slider or Cylindrical)"); return; }
    const old = editId ? a0.links.find((l) => l.id === editId) : null;
    const c = begin({ type: "motionLink" });
    c.preview = clone(a0);
    const v = old ? { driver: old.driver, driven: old.driven, mode: old.teeth ? "teeth" : "ratio", ratio: Math.abs(old.ratio), t1: old.teeth ? old.teeth[0] : 20, t2: old.teeth ? old.teeth[1] : 40, reverse: old.ratio < 0 }
      : { driver: movable[0].id, driven: movable[1].id, mode: "teeth", ratio: 1, t1: 20, t2: 40, reverse: true };
    const unitOf = (id) => { const j = jointById(a0, id); return j && A.jointDofs(j.type)[0].unit; };
    const sel = (key, opts) => { const s = h("select", {}, opts.map(([k, l]) => h("option", { value: k }, l))); s.value = v[key]; s.addEventListener("change", () => { v[key] = s.value; refresh(); }); return s; };
    const num = (key) => { const i = h("input", { value: fmt(v[key]), spellcheck: "false" }); i.addEventListener("input", () => { const x = parseFloat(i.value); if (Number.isFinite(x)) { v[key] = x; refresh(); } }); i.addEventListener("keydown", (e) => e.stopPropagation()); return h("div", { class: "num" }, i); };
    const rev = h("input", { type: "checkbox" }); rev.checked = v.reverse; rev.addEventListener("change", () => { v.reverse = rev.checked; refresh(); });
    const jopts = movable.map((j) => [j.id, `${j.name} (${A.JOINT_LABELS[j.type]})`]);
    const info = h("div", { class: "dlg-info" });
    const teethRow = h("div", { class: "dlg-row" }, h("label", {}, "Teeth"), h("div", { class: "ctl asm-teeth" }, num("t1"), h("span", {}, ":"), num("t2")));
    const ratioRow = h("div", { class: "dlg-row" }, h("label", {}, "Ratio"), h("div", { class: "ctl" }, num("ratio")));
    const ratioOf = () => {
      const r = v.mode === "teeth" ? (+v.t1 || 1) / (+v.t2 || 1) : +v.ratio || 0;
      return v.reverse ? -r : r;
    };
    function refresh() {
      teethRow.classList.toggle("hidden", v.mode !== "teeth");
      ratioRow.classList.toggle("hidden", v.mode !== "ratio");
      const r = ratioOf(), u1 = unitOf(v.driver), u2 = unitOf(v.driven);
      info.textContent = v.driver === v.driven ? "Pick two different joints." : `${fmt(1, 0)} ${u1} of the first joint moves the second ${fmt(r, 4)} ${u2}.`;
      // live: rebuild the preview's link and show it
      const p = clone(a0);
      p.links = p.links.filter((l) => l.id !== editId && l.driven !== v.driven);
      if (v.driver !== v.driven) p.links.push(makeLink(p, v, r, old));
      c.preview = p; apply(p);
    }
    c.onCancel = () => apply(asm());
    c.onOK = () => {
      if (v.driver === v.driven) { ctx.toast("Pick two different joints"); return; }
      const r = ratioOf();
      app.cmd = null; ctx.closeDialog(); ctx.setTip("");
      commit((x) => {
        x.links = (x.links || []).filter((l) => l.id !== editId && l.driven !== v.driven);
        x.links.push(makeLink(x, v, r, old));
      }, { log: { action: editId ? "edit link" : "motion link", driver: v.driver, driven: v.driven, ratio: r } });
      ctx.buildToolbar();
    };
    ctx.dialogFrame(old ? "Edit Motion Link" : "Motion Link", "gearLink", [
      h("div", { class: "dlg-row" }, h("label", {}, "Joint 1 (drives)"), h("div", { class: "ctl" }, sel("driver", jopts))),
      h("div", { class: "dlg-row" }, h("label", {}, "Joint 2 (follows)"), h("div", { class: "ctl" }, sel("driven", jopts))),
      h("div", { class: "dlg-row" }, h("label", {}, "Relation"), h("div", { class: "ctl" }, sel("mode", [["teeth", "Gear teeth"], ["ratio", "Ratio"]]))),
      teethRow, ratioRow,
      h("label", { class: "dlg-row cfd-check" }, rev, h("span", {}, "Reverse (external gears turn opposite ways)")),
      info,
    ], { ok: "OK", onOK: c.onOK, onCancel: ctx.cancelCommand });
    refresh();
    ctx.refreshHighlights(); ctx.buildToolbar();
  }
  function makeLink(x, v, r, old) {
    const dj = jointById(x, v.driver), sj = jointById(x, v.driven);
    // keep both joints where they are now
    const cur = A.resolveLinks(x);
    const dv = cur.has(dj.id) ? cur.get(dj.id) : A.clampToLimits(dj.value, dj.limits), sv = cur.has(sj.id) ? cur.get(sj.id) : A.clampToLimits(sj.value, sj.limits);
    const rack = A.jointDofs(sj.type)[0].unit === "mm" && A.jointDofs(dj.type)[0].unit === "deg";
    return {
      id: old ? old.id : A.nextId(x.links || [], "ml"), name: old ? old.name : nextName("Motion Link ", x.links || []),
      type: rack ? "rack" : v.mode === "teeth" ? "gear" : "ratio", driver: dj.id, driven: sj.id, ratio: r, offset: sv - r * dv,
      ...(v.mode === "teeth" ? { teeth: [+v.t1, +v.t2] } : {}),
    };
  }

  /**
   * Make a set of gears (from one gear feature) work in the assembly in one undo step: a component and a
   * revolute joint (slider for racks) per gear on a mount, and motion links between meshing gears.
   * spec: { gears: [{ bodyId, name, axisPoint, axisDir, travelDir?, kind }], mount: "new" | componentId,
   *         links: [{ driver: index | { jointId }, driven: index, ratio, teeth? }], fixed: [indices welded to the mount],
   *         carrier?: { axisPoint, axisDir, planets: [indices], ratio } }
   * Returns { components, joints, links } ids.
   */
  function addGearAssembly(spec) {
    const out = { components: [], joints: [], links: [] };
    commit((x) => {
      x.links = x.links || [];
      const solved = A.solveAssembly(x);
      // the mount (the component the axles are fixed to) is made only when some gear needs a new joint
      let mount = spec.mount && spec.mount !== "new" ? comp(x, spec.mount) : null, mountInv = null;
      // meshing onto gears that already turn: share their mount instead of making another frame
      if (!mount) for (const g of spec.gears) { const cc = A.componentOfBody(x, g.bodyId), pj = cc && A.parentJointOf(x, cc.id); if (pj && comp(x, pj.parent)) { mount = comp(x, pj.parent); break; } }
      const getMount = () => {
        if (!mount) {
          mount = A.addComponent(x, [], { name: nextName("Gear Frame ", x.components), grounded: true });
          mount.keep = true;
          out.components.push(mount.id);
        }
        if (!mountInv) mountInv = A.invert(solved.transforms.get(mount.id) || A.toMat(mount.transform)) || A.identity();
        return mount;
      };
      const toMount = (p) => A.applyToPoint(mountInv, p), dirToMount = (d) => A.applyToDir(mountInv, d);
      // planetary: an empty carrier component turning on the mount, the planets turn on it
      let carrier = null, carrierJoint = null;
      if (spec.carrier) {
        // re-edit: the planets already ride a carrier
        for (const i of spec.carrier.planets) {
          const cc = A.componentOfBody(x, spec.gears[i].bodyId), pj = cc && A.parentJointOf(x, cc.id), pc = pj && comp(x, pj.parent);
          if (pc && pc.keep && !pc.grounded) { carrier = pc; carrierJoint = A.parentJointOf(x, pc.id); break; }
        }
      }
      if (spec.carrier && !carrier) {
        getMount();
        carrier = A.addComponent(x, [], { name: nextName("Carrier ", x.components), grounded: false });
        carrier.keep = true;
        out.components.push(carrier.id);
        carrierJoint = {
          id: A.nextId(x.joints, "j"), name: `${carrier.name} axle`, type: "revolute", parent: mount.id, child: carrier.id,
          frameParent: A.toArray(A.frameFromPoint(toMount(spec.carrier.axisPoint), dirToMount(spec.carrier.axisDir))),
          frameChild: A.toArray(A.frameFromPoint(spec.carrier.axisPoint, spec.carrier.axisDir)),
          value: 0, value2: 0, limits: { lower: null, upper: null }, effort: null, velocity: null,
        };
        x.joints.push(carrierJoint); out.joints.push(carrierJoint.id);
      }
      const jointOf = [];
      spec.gears.forEach((g, i) => {
        // a twin wheel is fixed to another wheel's shaft: it joins that wheel's component
        if (g.attachTo) {
          const host = A.componentOfBody(x, g.attachTo);
          if (host && !A.componentOfBody(x, g.bodyId)) host.bodies.push(g.bodyId);
          if (host) return;
        }
        // chains and belts ride on the frame (the viewport moves their links; drivemotion.js)
        if (g.kind === "chain" || g.kind === "belt") {
          if (!A.componentOfBody(x, g.bodyId)) { const m = getMount(); m.bodies.push(g.bodyId); }
          return;
        }
        // reuse the body's component if it already has one, else make one
        let cc = A.componentOfBody(x, g.bodyId);
        if (!cc) { cc = A.addComponent(x, [g.bodyId], { name: g.name, grounded: false }); out.components.push(cc.id); }
        const existing = A.parentJointOf(x, cc.id);
        if (existing) {
          jointOf[i] = existing.id;
          // a wizard axle whose gear moved (re-edited tooth counts): follow it
          if (existing.gear) {
            const par = comp(x, existing.parent);
            const inv = A.invert(solved.transforms.get(par.id) || A.toMat(par.transform)) || A.identity();
            const ax = g.kind === "rack" ? g.travelDir : g.axisDir;
            existing.frameParent = A.toArray(A.frameFromPoint(A.applyToPoint(inv, g.axisPoint), A.applyToDir(inv, ax)));
            existing.frameChild = A.toArray(A.frameFromPoint(g.axisPoint, ax));
            if (g.kind !== "rack") existing.name = existing.name.replace(/^(Ring )?\d+T axle/, `${g.short || g.name} axle`);
          }
          return;
        }
        if (cc.grounded) return; // a grounded gear stays put (its partners can still turn)
        const onCarrier = carrier && spec.carrier.planets.includes(i);
        const parent = onCarrier && !(spec.fixed || []).includes(i) ? carrier : getMount();
        const pT = parent === carrier ? (p) => p : toMount, pD = parent === carrier ? (d) => d : dirToMount;
        const rack = g.kind === "rack";
        const axis = rack ? g.travelDir : g.axisDir;
        const j = {
          id: A.nextId(x.joints, "j"), name: nextName(rack ? "Rack slide " : `${g.short || g.name} axle `, x.joints).replace(/ 1$/, ""),
          type: (spec.fixed || []).includes(i) ? "rigid" : rack ? "slider" : "revolute", parent: parent.id, child: cc.id,
          frameParent: A.toArray(A.frameFromPoint(pT(g.axisPoint), pD(axis))),
          frameChild: A.toArray(A.frameFromPoint(g.axisPoint, axis)),
          value: 0, value2: 0, limits: { lower: null, upper: null }, effort: null, velocity: null, gear: true,
        };
        x.joints.push(j); out.joints.push(j.id); jointOf[i] = j.id;
      });
      for (const L of spec.links || []) {
        const driver = typeof L.driver === "object" ? L.driver.jointId : L.driver === "carrier" ? carrierJoint && carrierJoint.id : jointOf[L.driver];
        const driven = L.driven === "carrier" ? carrierJoint && carrierJoint.id : jointOf[L.driven];
        if (!driver || !driven || driver === driven) continue;
        const had = x.links.find((l) => l.driven === driven);
        if (had) {
          // re-running the wizard on the same gears: update the relation it made before
          if (had.driver === driver) { had.ratio = L.ratio; had.offset = 0; if (L.teeth) had.teeth = L.teeth; else delete had.teeth; }
          continue;
        }
        // the wizard meshes the teeth with every joint at 0, so the relation has no offset
        const lk = { id: A.nextId(x.links, "ml"), name: L.name || nextName("Motion Link ", x.links), type: L.type || "gear", driver, driven, ratio: L.ratio, offset: 0, ...(L.teeth ? { teeth: L.teeth } : {}) };
        x.links.push(lk); out.links.push(lk.id);
      }
    }, { log: { action: "gear assembly", gears: spec.gears.length } });
    ctx.toast(out.joints.length || out.links.length
      ? `Gears are live: ${out.joints.length} joint${out.joints.length === 1 ? "" : "s"}, ${out.links.length} motion link${out.links.length === 1 ? "" : "s"}. Use Drive Joints to turn them.`
      : "Gear joints and motion links updated");
    return out;
  }

  /** Bodies hidden because their component's eye is off. */
  function bodyHiddenByComponent(bodyId, hs) {
    const c = A.componentOfBody(asm(), bodyId);
    return !!(c && hs.has(HID(c.id)));
  }
  function highlights() {
    const c = app.cmd;
    if (c && c.kind === "asm" && c.highlights) return c.highlights();
    refreshGlyphs();
    return [];
  }

  // ---------------------------------------------------------------- debug / scripting hooks
  const hooks = {
    /** Wrap bodies in a component. Returns its id. */
    makeComponent: (bodyIds, name, opts = {}) => makeComponent(bodyIds, name, opts),
    /**
     * Add a joint. Either give frames directly ({ frameParent, frameChild } as 16-number arrays) or points + axes
     * in each component's modelled coordinates ({ parentPoint, parentAxis, childPoint, childAxis }; the child frame
     * is used as given, z = childAxis, so pass childAxis = parentAxis to align them). Returns the joint id.
     */
    addJoint: (o) => {
      let id;
      commit((x) => {
        id = o.id || A.nextId(x.joints, "j");
        x.joints.push({
          id, name: o.name || nextName(A.JOINT_LABELS[o.type || "revolute"], x.joints), type: o.type || "revolute", parent: o.parent, child: o.child,
          frameParent: A.toArray(o.frameParent || A.frameFromPoint(o.parentPoint || [0, 0, 0], o.parentAxis || [0, 0, 1], o.parentX)),
          frameChild: A.toArray(o.frameChild || A.frameFromPoint(o.childPoint || [0, 0, 0], o.childAxis || o.parentAxis || [0, 0, 1], o.childX || o.parentX)),
          value: +o.value || 0, value2: +o.value2 || 0, limits: { lower: o.lower ?? (o.limits && o.limits.lower) ?? null, upper: o.upper ?? (o.limits && o.limits.upper) ?? null },
          effort: o.effort ?? null, velocity: o.velocity ?? null,
        });
      }, { log: { action: "joint (script)" } });
      return id;
    },
    /** Set a joint's value (deg or mm; clamped to limits when displayed). Undoable; live = true skips the undo step. */
    setJointValue: (id, v, v2, live = false) => {
      const set = (x) => { const j = jointById(x, id); if (j) { j.value = +v; if (v2 != null) j.value2 = +v2; } };
      if (live) { set(asm()); ctx.save(); apply(); ctx.refreshBrowser(); } else commit(set);
    },
    ground: (id, on = true) => setGrounded(id, on),
    deleteJoint, deleteComponent,
    solve: () => { const s = solveNow(); return { transforms: Object.fromEntries([...s.transforms].map(([k, m]) => [k, A.toArray(m)])), errors: s.errors, values: Object.fromEntries(s.values) }; },
    bodyTransform: (bodyId) => A.toArray(A.bodyTransforms(asm(), [bodyId]).get(bodyId)),
    state: () => asm(),
    newComponent, joint: jointCmd, move: moveCmd, drive: driveCmd, groundSelected: groundCmd, motionLink: linkCmd,
    addGearAssembly,
    snap: (it) => snapJointOrigin(app.state, it),
    A,
  };
  if (typeof window !== "undefined") window.__asm = hooks;

  return {
    transformsFor, apply, browserRows, bodyHiddenByComponent, highlights,
    newComponent, joint: () => jointCmd(), mate: () => jointCmd(null, { mate: true }), editJoint: jointCmd, deleteJoint, move: () => moveCmd(), ground: groundCmd, drive: () => driveCmd(),
    motionLink: () => linkCmd(), addGearAssembly,
    hooks,
  };
}
