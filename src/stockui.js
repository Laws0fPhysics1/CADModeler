// Shop Stock browser: the feature dialog for the kernel's `stock` feature (catalog in stock.js).
//
// main.js registers `DEFS.stock = makeStockDef(...)` and runs it through its generic feature command
// (live preview, placement picks, OK into the timeline, double-click to re-edit). This module adds a
// "custom" dialog field that renders the browser: search, category list, item list, and the item
// card (size, item parameters, material override). Hardware items expand into fastener features.
//
//   initStockUI({ app, startFeature, okCommand })   // debug hook: window.__stock.insert("tslot-1530", { length: 300 })
import "./stock.css";
import { icons } from "./icons.js";
import { MATERIALS, CATEGORIES as MAT_CATEGORIES, getMaterial } from "./materials.js";
import * as S from "./stock.js";

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
const ico = (name, cls = "ic") => h("i", { class: cls, html: icons[name] || icons.stock || "" });
const fmt = (v) => String(+(+v).toFixed(3));
const catIcon = (it) => (S.CATEGORIES.find((c) => c.id === it.category) || {}).icon || "stock";

// browser state that survives between openings (Fusion keeps the last insert)
const ui = { query: "", category: null, lastItem: "tslot-m2020" };
const hooks = { app: null, startFeature: null, okCommand: null };

/** Put item `id` into the command, with its default parameters (and length, unless only the size changed). */
function chooseItem(c, id) {
  const it = S.stockItem(id);
  if (!it) return false;
  const prev = S.stockItem(c.values.item);
  const sameFamily = prev && prev.family === it.family;
  const defs = S.defaultParams(id);
  const params = {};
  for (const k of Object.keys(defs)) params[k] = sameFamily && c.values.params && c.values.params[k] !== undefined ? c.values.params[k] : defs[k];
  c.values.item = id;
  c.values.params = params;
  if (it.length != null && (!sameFamily || !(c.values.length > 0))) c.values.length = it.length;
  if (!sameFamily) c.values.material = "";
  ui.lastItem = id;
  const inp = c.fieldInputs && c.fieldInputs.length;
  if (inp) inp.value = fmt(c.values.length);
  return true;
}

/**
 * The feature definition for main.js's DEFS.
 * @param {{ K: object, placeFilter: (st, it) => boolean }} o
 */
export function makeStockDef({ K, placeFilter }) {
  const def = {
    title: "Shop Stock", icon: "stock",
    fields: [
      { type: "custom", key: "item", value: ui.lastItem, render: (c, changed) => renderBrowser(c, changed) },
      { type: "hidden", key: "params", value: {} },
      { type: "hidden", key: "material", value: "" },
      { type: "select", key: "place", label: "Position", kinds: ["edge", "face"], multi: false, optional: true, filter: placeFilter, prompt: "Select a planar face, a hole edge or a hole (or leave empty: origin)" },
      { type: "number", key: "length", label: "Length", unit: "mm", value: 500, showIf: (v) => S.itemHasLength(v.item) },
      { type: "dropdown", key: "direction", label: "Direction", options: [["normal", "Out of the face (+Z)"], ["flip", "Flipped"], ["x", "Along X (no position)"], ["y", "Along Y (no position)"]], value: "normal" },
      { type: "number", key: "offset", label: "Offset", unit: "mm", value: 0 },
      { type: "number", key: "rotation", label: "Rotation", unit: "deg", value: 0, showIf: (v) => !S.isFastenerItem(v.item) },
    ],
    build: (v, st) => {
      const it = v.place && v.place[0];
      const place = !it ? null : it.kind === "edge" ? { kind: "edge", ...K.edgeRef(st, it.body, it.idx) } : { kind: "face", ...K.faceRef(st, it.body, it.idx) };
      return S.stockFeature({ ...v, place });
    },
    // modeled threads take about a second; the live preview uses plain shanks (OK builds the real thing)
    previewBuild: (v, st) => { const f = def.build(v, st); return f.type === "fastener" ? { ...f, threads: "cosmetic" } : f; },
  };
  return def;
}

// ---------------------------------------------------------------- the browser
function renderBrowser(c, changed) {
  // a new command starts from the last item with its defaults; an edit keeps the feature's values
  if (c.editIndex == null && !c.stockInit) {
    const id = S.stockItem(c.values.item) ? c.values.item : ui.lastItem;
    c.values.item = null;
    chooseItem(c, id);
  }
  c.stockInit = true;
  const root = h("div", { class: "stock-browser" });
  const input = h("input", { class: "sb-q", placeholder: "Search: m4 bolt, 1/2 pipe, 1530…", spellcheck: "false", value: ui.query });
  const clear = h("button", { class: "sb-clear", title: "Clear search", html: icons.close, onclick: () => { input.value = ""; ui.query = ""; renderLists(); input.focus(); } });
  const cats = h("div", { class: "sb-cats" });
  const list = h("div", { class: "sb-items" });
  const card = h("div", { class: "sb-card" });
  root.append(h("div", { class: "sb-search" }, ico("search", "sb-sico"), input, clear), h("div", { class: "sb-cols" }, cats, list), card);
  let results = [];

  const pick = (id, scroll) => {
    chooseItem(c, id);
    renderCard();
    for (const el of list.children) el.classList.toggle("sel", el.dataset.id === id);
    if (scroll) { const el = list.querySelector(".sel"); if (el) el.scrollIntoView({ block: "nearest" }); }
    changed();
  };
  function renderLists() {
    clear.style.visibility = ui.query ? "visible" : "hidden";
    cats.innerHTML = "";
    const all = S.searchStock(ui.query, { limit: 1000 });
    const count = (cat) => (cat ? all.filter((it) => it.category === cat).length : all.length);
    for (const cat of [{ id: null, name: "All", icon: "stock" }, ...S.CATEGORIES]) {
      const n = count(cat.id);
      cats.append(h("div", { class: `sb-cat${ui.category === cat.id ? " sel" : ""}${n ? "" : " empty"}`, title: cat.name, onclick: () => { ui.category = cat.id; renderLists(); } },
        ico(cat.icon), h("span", { class: "nm" }, cat.name), h("span", { class: "n" }, String(n))));
    }
    results = ui.category ? all.filter((it) => it.category === ui.category) : all;
    list.innerHTML = "";
    if (!results.length) list.append(h("div", { class: "sb-none" }, "No matching stock"));
    for (const it of results.slice(0, 400)) {
      list.append(h("div", { class: `sb-item${it.id === c.values.item ? " sel" : ""}`, "data-id": it.id, title: `${it.name}\n${it.size}`,
        onclick: () => pick(it.id), ondblclick: () => { pick(it.id); hooks.okCommand && hooks.okCommand(); } },
      ico(catIcon(it)), h("div", { class: "tx" }, h("div", { class: "nm" }, it.name), h("div", { class: "sz" }, it.size))));
    }
    const sel = list.querySelector(".sel");
    if (sel) requestAnimationFrame(() => sel.scrollIntoView({ block: "nearest" }));
  }
  function renderCard() {
    const it = S.stockItem(c.values.item);
    card.innerHTML = "";
    if (!it) { card.append(h("div", { class: "sb-none" }, "Pick an item")); return; }
    card.append(h("div", { class: "sb-head" }, ico(catIcon(it), "ic big"), h("div", { class: "tx" }, h("div", { class: "nm" }, it.name), h("div", { class: "sz" }, it.size))));
    const row = (label, ctl, hint) => card.append(h("div", { class: "dlg-row" }, h("label", { title: hint || null }, label), h("div", { class: "ctl" }, ctl)));
    // sizes of the same family
    const fam = S.familyOf(it.id);
    if (fam.length > 1) {
      const sel = h("select", {}, fam.map((x) => h("option", { value: x.id }, x.fastener ? x.fastener.size : x.size)));
      sel.value = it.id;
      sel.addEventListener("change", () => { pick(sel.value, true); });
      row("Size", sel);
    }
    for (const p of it.params || []) {
      const cur = (c.values.params || {})[p.key] ?? p.value;
      const set = (val) => { c.values.params = { ...(c.values.params || {}), [p.key]: val }; changed(); };
      if (p.type === "select") {
        const sel = h("select", {}, p.options.map((o) => (Array.isArray(o) ? h("option", { value: o[0] }, o[1]) : h("option", { value: String(o) }, `${o}${p.unit ? ` ${p.unit}` : ""}`))));
        sel.value = String(cur);
        sel.addEventListener("change", () => set(typeof p.value === "number" ? +sel.value : sel.value));
        row(p.label, sel);
      } else {
        const inp = h("input", { value: fmt(cur), spellcheck: "false" });
        inp.addEventListener("input", () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
        row(p.label, h("div", { class: "num" }, inp, h("em", {}, p.unit || "")));
      }
    }
    if (it.material) {
      const sel = h("select", {}, h("option", { value: "" }, `Default (${getMaterial(it.material).name})`),
        MAT_CATEGORIES.map((cat) => {
          const ms = MATERIALS.filter((m) => m.category === cat);
          return ms.length ? h("optgroup", { label: cat }, ms.map((m) => h("option", { value: m.id }, m.name))) : null;
        }));
      sel.value = c.values.material || "";
      sel.addEventListener("change", () => { c.values.material = sel.value; changed(); });
      row("Material", sel, "Physical material and look of the new body (change it later with Appearance)");
    } else card.append(h("div", { class: "sb-note" }, "Inserted as a Fastener feature (edit it from the timeline)."));
  }
  input.addEventListener("input", () => { ui.query = input.value; if (ui.query) ui.category = null; renderLists(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();                                   // keep Enter / letters away from the app shortcuts
    const i = results.findIndex((x) => x.id === c.values.item);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = results[Math.max(0, Math.min(results.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) pick(n.id, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (i < 0 && results[0]) pick(results[0].id, true);
      else if (hooks.okCommand) hooks.okCommand();
    } else if (e.key === "Escape") { if (input.value) { input.value = ""; ui.query = ""; renderLists(); } else input.blur(); }
  });
  renderLists();
  renderCard();
  if (c.editIndex == null) setTimeout(() => { if (root.isConnected) input.focus(); }, 0);
  return root;
}

// ---------------------------------------------------------------- hooks
/**
 * Wire the debug / scripting hook. `startFeature()` opens the Shop Stock command, `okCommand()` commits it.
 *   window.__stock.insert("tslot-1530", { length: 300, direction: "x", material: "steel-mild", params: {...}, place: {kind:"face", body, idx} })
 */
export function initStockUI({ app, startFeature, okCommand }) {
  Object.assign(hooks, { app, startFeature, okCommand });
  const api = {
    items: S.STOCK_ITEMS,
    categories: S.CATEGORIES,
    search: (q) => S.searchStock(q).map((it) => ({ id: it.id, name: it.name, size: it.size })),
    open: () => startFeature(),
    /** Insert an item through the real command (undo, timeline, appearance). Returns the new body's name or an error. */
    insert(id, o = {}) {
      if (!S.stockItem(id)) return `unknown item ${id}`;
      startFeature();
      const c = app.cmd;
      if (!c || c.type !== "stock") return "could not start the Shop Stock command";
      chooseItem(c, id);
      for (const k of ["length", "material", "direction", "offset", "rotation"]) if (o[k] !== undefined) c.values[k] = o[k];
      if (o.params) c.values.params = { ...c.values.params, ...o.params };
      c.values.place = o.place ? [o.place] : [];
      const before = app.doc.features.length;
      okCommand();
      if (app.doc.features.length === before) return "insert failed (see the toast)";
      const b = app.state.bodies[app.state.bodies.length - 1];
      return b ? b.name : "inserted";
    },
  };
  window.__stock = api;
  return api;
}
