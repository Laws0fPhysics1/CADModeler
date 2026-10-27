// Settings panel (the cog in the top bar). Everything here is stored on this computer and survives
// restarts: viewport and theme settings in localStorage "cadmodeler.prefs" (theme.js), the CFD Sim /
// FEA Sim folders in the desktop app's config file (platform.cfd / platform.fea setConfig).
import "./settings.css";
import * as platform from "./platform.js";
import { getTheme, applyTheme, getPref, setPref } from "./theme.js";

const PREFS_KEY = "cadmodeler.prefs";
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
const select = (options, value, onchange) => {
  const s = h("select", { onchange: () => onchange(s.value) }, options.map(([v, l]) => h("option", { value: v }, l)));
  s.value = value;
  return s;
};
const toggle = (checked, onchange) => {
  const c = h("input", { type: "checkbox", onchange: () => onchange(c.checked) });
  c.checked = !!checked;
  return h("label", { class: "st-switch" }, c, h("span", {}));
};
const row = (label, control, hint) => h("div", { class: "st-row" }, h("div", { class: "st-lb" }, label, hint ? h("div", { class: "st-hint" }, hint) : null), h("div", { class: "st-ctl" }, control));

/**
 * ctx: { vp, icons, host, toast, logEvent,
 *        getDisplay(), setDisplay(style), setGrid(on), refresh() (rebuild the nav bar etc.) }
 */
export function openSettings(ctx) {
  if (current) { closeSettings(); return; }
  const { vp, icons } = ctx;
  const changed = (what, value) => { ctx.logEvent && ctx.logEvent("setting", { what, value }); ctx.refresh && ctx.refresh(); };
  const SECTIONS = [["general", "General"], ["viewport", "Viewport"], ["simulation", "Simulation"]];
  let section = "general";
  const body = h("div", { class: "st-body" });
  const nav = h("div", { class: "st-nav" });

  const render = () => {
    nav.innerHTML = "";
    for (const [id, label] of SECTIONS) nav.append(h("button", { class: `st-navbtn${id === section ? " active" : ""}`, onclick: () => { section = id; render(); } }, label));
    body.innerHTML = "";
    if (section === "general") {
      body.append(
        h("div", { class: "st-hd" }, "Appearance"),
        row("Theme", select([["light", "Light"], ["dark", "Dark"]], getTheme(), (v) => { applyTheme(v); changed("theme", v); })),
        h("div", { class: "st-hd" }, "Units"),
        row("This design", select(ctx.units.list, ctx.units.current(), (v) => { ctx.units.setDoc(v); changed("units", v); }), "Saved with the design (also under Browser > Document Settings). The model is always stored in mm; only displayed and typed values change."),
        row("New designs", select(ctx.units.list, getPref("units", "mm"), (v) => { setPref("units", v); changed("defaultUnits", v); }), "Typed values can always carry their own unit: 1in, 25.4mm, 2ft, 1in + 3mm."),
        h("div", { class: "st-hd" }, "Storage"),
        h("div", { class: "st-note" }, "Settings are saved on this computer and kept when the app restarts. Designs autosave separately; use File > Save to keep a copy."),
        row("Reset settings", h("button", { class: "btn", onclick: resetAll }, "Reset to defaults"), "Theme, viewport, ribbon tab and home view. Designs are not touched."),
      );
    } else if (section === "viewport") {
      const ro = vp.renderOptions;
      body.append(
        h("div", { class: "st-hd" }, "Display"),
        row("Visual style", select([["shadedEdges", "Shaded with visible edges"], ["shaded", "Shaded"], ["wire", "Wireframe"]], ctx.getDisplay(), (v) => { ctx.setDisplay(v); changed("display", v); })),
        row("Show grid", toggle(vp.showGrid, (on) => { ctx.setGrid(on); changed("showGrid", on); })),
        h("div", { class: "st-hd" }, "Camera"),
        row("Projection", select([["perspective", "Perspective"], ["orthographic", "Orthographic"], ["perspOrtho", "Perspective with ortho faces"]], vp.cameraMode, (v) => { vp.setCameraMode(v); changed("cameraMode", v); })),
        row("Orthographic while sketching", toggle(getPref("sketchOrtho", true) !== false, (on) => { setPref("sketchOrtho", on); changed("sketchOrtho", on); }), "Sketches switch to an orthographic camera (no perspective) and back when you finish."),
        row("Home view", h("button", { class: "btn", disabled: vp.hasCustomHome() ? null : true, onclick: () => { vp.resetHome(); changed("homeView", "default"); render(); } }, vp.hasCustomHome() ? "Reset to default" : "Default"), "Set a custom home from the ViewCube's right-click menu."),
        h("div", { class: "st-hd" }, "Rendering"),
        row("Lighting", select([["studio", "Studio"], ["neutral", "Neutral"], ["dark", "Dark sky"]], ro.environment, (v) => { vp.setRenderOptions({ environment: v }); changed("environment", v); })),
        row("Ground shadow", toggle(ro.shadows, (on) => { vp.setRenderOptions({ shadows: on }); changed("shadows", on); })),
        row("Ambient occlusion", toggle(ro.ao, (on) => { vp.setRenderOptions({ ao: on }); changed("ao", on); })),
      );
    } else if (section === "simulation") {
      body.append(h("div", { class: "st-note" }, "Where the in-app solvers live. Leave a box empty to use the default."));
      solverRows("CFD Sim (3D flow)", platform.cfd, [["cfdDir", "CFD Sim folder"], ["pythonCmd", "Python command"], ["exchangeDir", "Case folder"]]);
      solverRows("FEA Sim (static stress)", platform.fea, [["feaDir", "FEA Sim folder"], ["pythonCmd", "Python command"], ["exchangeDir", "Case folder"]]);
    }
  };
  // solver folders come from the desktop app's config; the browser preview can only show them
  function solverRows(title, api, fields) {
    const box = h("div", {});
    body.append(h("div", { class: "st-hd" }, title), box);
    box.append(h("div", { class: "st-note" }, "Loading…"));
    Promise.resolve(api.getConfig()).then((cfg) => {
      box.innerHTML = "";
      if (!cfg) { box.append(h("div", { class: "st-note" }, "Only available in the desktop app.")); return; }
      for (const [key, label] of fields) {
        const inp = h("input", { type: "text", spellcheck: "false", value: cfg[key] || "", disabled: platform.isDesktop ? null : true });
        inp.addEventListener("change", async () => {
          try { const next = await api.setConfig({ [key]: inp.value.trim() }); if (next) inp.value = next[key] || ""; changed(key, inp.value); ctx.toast("Saved"); }
          catch (e) { ctx.toast(`Couldn't save: ${e.message}`); }
        });
        box.append(row(label, inp));
      }
    }, (e) => { box.innerHTML = ""; box.append(h("div", { class: "st-note" }, `Couldn't read the settings: ${e.message}`)); });
  }
  function resetAll() {
    if (!confirm("Reset all settings to their defaults?\n\nYour designs are not affected. The app reloads.")) return;
    try { localStorage.removeItem(PREFS_KEY); } catch (e) {}
    location.reload();
  }

  const el = h("div", { class: "st-panel", role: "dialog", "aria-label": "Settings" },
    h("div", { class: "st-title" }, h("i", { class: "st-ico", html: icons.settings }), "Settings", h("div", { class: "st-sp" }), h("button", { class: "st-x", title: "Close", html: icons.close, onclick: closeSettings })),
    h("div", { class: "st-main" }, nav, body));
  const scrim = h("div", { class: "st-scrim", onpointerdown: (e) => { if (e.target === scrim) closeSettings(); } }, el);
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSettings(); } };
  window.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  current = { scrim, onKey };
  render();
  return { el, show: (id) => { section = id; render(); } };
}

export function closeSettings() {
  if (!current) return;
  current.scrim.remove();
  window.removeEventListener("keydown", current.onKey, true);
  current = null;
}
export const settingsOpen = () => !!current;
