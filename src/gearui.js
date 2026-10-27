// GEAR WIZARD: the dialog for the kernel's `gear` feature (geometry in gears.js).
//
// One wizard run makes a set of meshing gears as one timeline feature (live preview, double-click to
// re-edit): a single gear, a pair, a train, a ring + pinion, a rack + pinion, a planetary set, or a new
// gear meshed onto a gear that's already in the design. With "Make it move", OK also wires the set into
// the assembly (assemblyui.addGearAssembly): a component and a revolute joint (slider for racks) per gear
// on a grounded Gear Frame, plus motion links, so Drive Joints turns the whole train.
//
//   makeGearDef({ K, faceFilter, gearFaceFilter, components: () => [{id, name}], addGearAssembly, toast })
import "./gears.css";
import * as G from "./gears.js";
import * as CH from "./chains.js";
import { MODES, DEFAULT_SPEC, planGears } from "./gearplan.js";

export { planGears };
const fmt = (v, d = 3) => String(+(+v).toFixed(d));

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

let lastSpec = { ...DEFAULT_SPEC };

/** The feature definition for main.js's DEFS. */
export function makeGearDef({ K, faceFilter, gearFaceFilter, components, addGearAssembly, toast }) {
  const partnerOf = (v, st) => {
    const it = v.partner && v.partner[0];
    const b = it && st.bodies.find((x) => x.id === it.body);
    if (!b || !b.gear) return null;
    // does a chain / belt already run on this wheel? (then a new one goes on a twin wheel beside it)
    const at = (c) => Math.hypot(c[0] - b.gear.center[0], c[1] - b.gear.center[1]) < 1e-6;
    const hasLoop = st.bodies.some((x) => x.gear && x.gear.layout && (x.gear.layout.wheels ? x.gear.layout.wheels.some((w) => at(w.c)) : x.gear.layout.c1 && (at(x.gear.layout.c1) || at(x.gear.layout.c2))) && Math.abs((x.gear.zMid || 0) - ((b.gear.z0 || 0) + G.gearParams(b.gear).width / 2)) < G.gearParams(b.gear).width);
    return { ...b.gear, bodyId: b.id, bodyName: b.name, hasLoop };
  };
  const frameOf = (v, st) => {
    const s = v.spec;
    if (s.mode === "mesh") { const p = partnerOf(v, st); return p ? p.frame : K.ORIGIN_PLANES.XY; }
    const it = v.place && v.place[0];
    if (it && it.kind === "face") { try { return K.planeFromFace(K.faceOf(st, it.body, it.idx)); } catch (e) { /* fall through */ } }
    return K.ORIGIN_PLANES[s.plane] || K.ORIGIN_PLANES.XY;
  };
  const def = {
    title: "Gear Wizard", icon: "gear",
    fields: [
      { type: "custom", key: "spec", value: lastSpec, render: (c, changed) => renderWizard(c, changed) },
      { type: "select", key: "place", label: "Plane / face", kinds: ["face"], multi: false, optional: true, filter: faceFilter, prompt: "Select a planar face for the gears (or leave empty: the plane above)", showIf: (v) => v.spec.mode !== "mesh" },
      { type: "select", key: "partner", label: "Mesh with", kinds: ["face"], multi: false, optional: true, filter: gearFaceFilter, prompt: "Select a face of the gear to mesh with", showIf: (v) => v.spec.mode === "mesh" },
    ],
    build: (v, st) => {
      const plan = planGears(v.spec, v.spec.mode === "mesh" ? partnerOf(v, st) : null);
      // a gear's name says what it is; record the wizard spec so double-click re-opens it
      const pl = v.place && v.place[0], pa = v.partner && v.partner[0];
      return {
        type: "gear", frame: frameOf(v, st), gears: plan.gears, spec: { ...v.spec },
        // the picks, so double-click re-opens the wizard with them
        place: pl && v.spec.mode !== "mesh" ? { kind: "face", ...K.faceRef(st, pl.body, pl.idx) } : null,
        partner: pa && v.spec.mode === "mesh" ? { kind: "face", ...K.faceRef(st, pa.body, pa.idx) } : null,
      };
    },
    onPreview: (c) => c.gearRefresh && c.gearRefresh(),
    // (main.js) after OK: wire the new gears into the assembly when asked
    after: (f, c, st) => {
      const v = c.values;
      if (!v.spec.functional) return;
      const partner = v.spec.mode === "mesh" ? partnerOf(v, c.base) : null;
      const plan = planGears(v.spec, partner);
      const bodies = st.bodies.filter((b) => b.gear && b.gear.feature === f.id).sort((a, b) => a.gear.index - b.gear.index);
      if (bodies.length !== plan.gears.length) return;
      const entry = (b) => ({ bodyId: b.id, name: b.name, short: b.gear.kind === "ring" ? `Ring ${b.gear.teeth}T` : `${b.gear.teeth}T`, kind: b.gear.kind, axisPoint: b.gear.axisPoint, axisDir: b.gear.axisDir, travelDir: b.gear.travelDir,
        ...(plan.gears[b.gear.index] && plan.gears[b.gear.index].attachToPartner && partner ? { attachTo: partner.bodyId } : {}) });
      const gears = bodies.map(entry);
      let links = plan.links;
      if (partner) {
        const pb = st.bodies.find((b) => b.id === partner.bodyId);
        if (pb) { gears.unshift(entry(pb)); links = links.map((l) => ({ ...l, driver: 0, driven: l.driven + 1 })); }
      }
      const fr = f.frame, n = fr.normal;
      const carrier = plan.carrier ? { axisPoint: K.to3D(fr, plan.carrier.center), axisDir: n, planets: plan.carrier.planets } : null;
      addGearAssembly({ gears, links, fixed: plan.fixed.map((i) => i + (partner ? 1 : 0)), carrier, mount: v.spec.mount });
    },
  };
  return def;

  // ---------------------------------------------------------------- the wizard panel
  function renderWizard(c, changed) {
    const box = h("div", { class: "gw" });
    c.values.spec = { ...DEFAULT_SPEC, ...(c.values.spec || {}) };
    const draw = () => {
      const s = c.values.spec;
      lastSpec = { ...s };
      box.innerHTML = "";
      const set = (k, val, redraw = false) => { s[k] = val; lastSpec = { ...s }; if (redraw) draw(); else refreshInfo(); changed(); };
      const row = (label, ctl, title) => h("div", { class: "dlg-row" }, h("label", { title: title || null }, label), h("div", { class: "ctl" }, ctl));
      const num = (k, unit, { int = false, title } = {}) => {
        const i = h("input", { value: String(s[k]), spellcheck: "false" });
        i.addEventListener("input", () => { const x = parseFloat(i.value); if (Number.isFinite(x)) set(k, int ? Math.round(x) : x); });
        i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const st = int ? 1 : k === "module" ? 0.25 : 1; const x = +(s[k] + (e.key === "ArrowUp" ? st : -st)).toFixed(4); i.value = String(x); set(k, x); } });
        return { el: h("div", { class: "num" }, i, unit ? h("em", {}, unit) : null), title };
      };
      const sel = (k, opts, redraw = true) => { const e = h("select", {}, opts.map(([v, l]) => h("option", { value: v }, l))); e.value = String(s[k]); e.addEventListener("change", () => set(k, isNaN(+e.value) || e.value === "" ? e.value : +e.value, redraw)); return e; };
      const rowN = (label, k, unit, o) => { const n = num(k, unit, o); return row(label, n.el, o && o.title); };
      const sec = (t) => h("div", { class: "cfd-sec" }, t);
      const m = s.mode;
      // in mesh mode the picked part decides what can be added (a gear, or a chained / belted wheel)
      const pIt = c.values.partner && c.values.partner[0], pBody = pIt && c.base.bodies.find((b) => b.id === pIt.body);
      const pKind = pBody && pBody.gear ? pBody.gear.kind : null;
      const loopMode = m === "chain" || m === "belt" || (m === "mesh" && G.isWheel(pKind));
      const wheelKind = m === "chain" || pKind === "sprocket" || (m === "single" && s.kind === "sprocket") ? "sprocket" : m === "belt" || pKind === "pulley" || (m === "single" && s.kind === "pulley") ? "pulley" : null;
      box.append(row("Make", sel("mode", MODES)));
      // teeth
      box.append(sec("Teeth"));
      if (m === "single") { box.append(row("Type", sel("kind", Object.entries(G.KINDS)))); box.append(rowN(s.kind === "rack" ? "Rack teeth" : "Teeth", "teeth1", "", { int: true })); }
      if (m === "pair") { box.append(rowN("Driving gear", "teeth1", "T", { int: true })); box.append(rowN("Driven gear", "teeth2", "T", { int: true })); }
      if (m === "train") {
        const i = h("input", { value: s.train, spellcheck: "false", title: "Tooth counts in order, e.g. 20, 40, 16" });
        i.addEventListener("input", () => set("train", i.value)); i.addEventListener("keydown", (e) => e.stopPropagation());
        box.append(row("Tooth counts", i, "Each gear meshes with the next, in a line"));
      }
      if (m === "internal") { box.append(rowN("Pinion", "teeth1", "T", { int: true })); box.append(rowN("Ring", "teeth2", "T", { int: true })); }
      if (m === "rack") { box.append(rowN("Pinion", "teeth1", "T", { int: true })); box.append(rowN("Rack length", "rackTeeth", "teeth", { int: true })); }
      if (m === "planetary") { box.append(rowN("Sun", "sun", "T", { int: true })); box.append(rowN("Planets", "planet", "T", { int: true })); box.append(rowN("Planet count", "planets", "", { int: true })); }
      if (m === "chain") { box.append(rowN("Driving sprocket", "teeth1", "T", { int: true })); box.append(rowN("Driven sprocket", "teeth2", "T", { int: true })); }
      if (m === "belt") { box.append(rowN("Driving pulley", "teeth1", "T", { int: true })); box.append(rowN("Driven pulley", "teeth2", "T", { int: true })); }
      if (m === "mesh" && loopMode) {
        box.append(h("div", { class: "cfd-muted fea-hint" }, `A new ${pKind === "sprocket" ? "sprocket and chain" : "pulley and belt"} from the picked ${pKind}.`));
        box.append(rowN(pKind === "sprocket" ? "New sprocket" : "New pulley", "teeth1", "T", { int: true }));
      } else if (m === "mesh") {
        box.append(row("New part", sel("kind", Object.entries(G.KINDS).filter(([k]) => !G.isWheel(k)))));
        if (s.kind === "rack") box.append(rowN("Rack length", "rackTeeth", "teeth", { int: true }));
        else box.append(rowN("Teeth", s.kind === "ring" ? "teeth2" : "teeth1", "T", { int: true }));
      }
      // chain / belt: the size, and roughly how far apart (the solver fits whole links / teeth)
      if (wheelKind === "sprocket" && m !== "mesh") box.append(row("Chain", sel("chain", Object.entries(CH.CHAINS).map(([k, x]) => [k, x.label]), false)));
      if (wheelKind === "pulley" && m !== "mesh") {
        box.append(row("Belt", sel("belt", Object.entries(CH.BELTS).map(([k, x]) => [k, x.label]), false)));
        box.append(rowN("Belt width", "beltWidth", "mm"));
        const fl = h("input", { type: "checkbox" }); fl.checked = !!s.flanges;
        fl.addEventListener("change", () => set("flanges", fl.checked));
        box.append(h("label", { class: "dlg-row cfd-check" }, fl, h("span", {}, "Flanges")));
      }
      if (loopMode) box.append(rowN("Centre distance", "centerDist", "mm", { title: "Roughly: it's adjusted so the chain / belt is a whole number of links / teeth" }));
      // tooth size (a meshed gear inherits it from its partner; sprockets and pulleys take it from the chain / belt)
      if (m !== "mesh" && !wheelKind) {
        box.append(sec("Tooth size"));
        box.append(rowN("Module", "module", "mm", { title: "Pitch diameter ÷ teeth. Meshing gears share it" }));
        box.append(row("Pressure angle", sel("pressureAngle", G.PRESSURE_ANGLES.map((a) => [a, `${a}°`]), false)));
        if (m !== "rack" && !(m === "single" && s.kind === "rack")) box.append(rowN("Helix angle", "helixAngle", "deg", { title: "0 = spur. Meshing external gears get opposite hands automatically" }));
      }
      box.append(sec("Body"));
      if (!wheelKind) box.append(rowN("Face width", "width", "mm"));
      box.append(rowN("Bore", "bore", "mm", { title: "0 = solid" }));
      box.append(rowN("Hub Ø", "hubDia", "mm", { title: "0 = no hub" }));
      if (s.hubDia > 0) box.append(rowN("Hub length", "hubLength", "mm"));
      if (!wheelKind) box.append(rowN("Backlash", "backlash", "mm", { title: "Total circular backlash taken off the teeth (e.g. 0.1–0.2 mm for 3D printing)" }));
      box.append(sec("Placement"));
      if (m !== "mesh") {
        box.append(row("Plane", sel("plane", [["XY", "XY (axles along Z)"], ["XZ", "XZ (axles along Y)"], ["YZ", "YZ (axles along X)"]], false)));
        box.append(rowN("Centre X", "u", "mm")); box.append(rowN("Centre Y", "v", "mm")); box.append(rowN("Offset", "z0", "mm", { title: "Along the axle" }));
      }
      box.append(rowN(m === "rack" || (m === "mesh" && s.kind === "rack") ? "Rack side" : "Direction", "dir", "deg", { title: "Angle (from the plane's X axis) to the next gear" }));
      box.append(sec("Motion"));
      const ck = h("input", { type: "checkbox" }); ck.checked = !!s.functional;
      ck.addEventListener("change", () => set("functional", ck.checked, true));
      box.append(h("label", { class: "dlg-row cfd-check" }, ck, h("span", {}, "Make it move (components, joints, motion links)")));
      if (s.functional) {
        const comps = components();
        box.append(row("Axles on", sel("mount", [["new", "New grounded Gear Frame"], ...comps.map((x) => [x.id, x.name])], false), "The component the gear axles are fixed to"));
      }
      if (["pair", "train", "planetary", "chain", "belt"].includes(m)) box.append(rowN("Input speed", "rpm", "rpm"));
      box.append(info);
      refreshInfo();
    };
    const info = h("div", { class: "dlg-info gw-info" });
    function refreshInfo() {
      const s = c.values.spec;
      let plan;
      try {
        const it = c.values.partner && c.values.partner[0];
        const pb = it && c.base.bodies.find((b) => b.id === it.body);
        plan = planGears(s, pb && pb.gear ? pb.gear : null);
      } catch (e) { info.innerHTML = `<span class="gw-warn">${e.message}</span>`; return; }
      const rows = plan.gears.filter((g) => g.kind !== "chain" && g.kind !== "belt").map((g) => {
        const S = G.gearSizes(g);
        return g.kind === "rack" ? `<tr><td>${G.gearName(g)}</td><td>${fmt(g.teeth * Math.PI * g.module, 1)} mm long</td></tr>` : `<tr><td>${G.gearName(g)}</td><td>Ø ${fmt(S.pitchDia, 2)} pitch · ${fmt(g.kind === "ring" ? S.tipRadius * 2 : S.tipRadius * 2, 2)} ${g.kind === "ring" ? "inner" : "tip"}</td></tr>`;
      });
      const d = [];
      for (let i = 1; i < plan.gears.length && !["planetary", "chain", "belt"].includes(s.mode) && !plan.loops; i++) {
        const a = plan.gears[i - 1], b = plan.gears[i];
        if (s.mode === "internal" || s.mode === "rack") { if (i > 1) break; }
        const dist = b.kind === "rack" ? G.gearSizes(a).pitchRadius : Math.hypot(b.center[0] - a.center[0], b.center[1] - a.center[1]);
        d.push(`centre distance ${fmt(dist, 3)} mm · contact ratio ${fmt(G.contactRatio(a, b), 2)}`);
      }
      info.innerHTML = `<table class="gw-tab">${rows.join("")}</table>` + [...d, ...plan.notes].map((t) => `<div>${t}</div>`).join("") + plan.warnings.map((t) => `<div class="gw-warn">${t}</div>`).join("");
    }
    // re-plan when the partner pick changes (the dialog calls render once; picks call changed elsewhere)
    // picking a different kind of partner (gear / sprocket / pulley) changes the fields, so redraw then
    let lastKind;
    const partnerKind = () => { const it = c.values.partner && c.values.partner[0], b = it && c.base.bodies.find((x) => x.id === it.body); return b && b.gear ? b.gear.kind : null; };
    c.gearRefresh = () => { const k = partnerKind(); if (k !== lastKind) { lastKind = k; draw(); } else refreshInfo(); };
    lastKind = partnerKind();
    draw();
    return box;
  }
}

export function setLastGearSpec(s) { lastSpec = { ...DEFAULT_SPEC, ...s }; }
