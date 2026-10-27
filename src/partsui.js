// Parts panel: a rail on the left edge of the viewport that opens a list of parts: the PARTS bin (every
// design saved in the Parts folder, with its thumbnail; double-click opens it), other open designs,
// recent parts, the Shop Stock and McMaster-Carr libraries.
// Dragging a Parts-bin card or an open design onto the viewport inserts that design into this one (main.js
// insertDesignFrom: a timeline "insert" feature, which makes this design a hybrid; loops are refused).
// Library cards (Shop Stock favourites, McMaster) are still UNDER CONSTRUCTION: dropping one only says so.
// Future (user, 2026-10-09): sub-folders, linked folders on other drives, network / cloud drives.
import "./parts.css";
import { getPref, setPref } from "./theme.js";

const DESIGN_MIME = "application/x-cad-design"; // drag payload: { file, path, name } (Parts bin) or { tab, name } (open design)

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

// placeholder library rows: [name, detail, icon]
const LIBRARY = {
  "Shop Stock favorites": [["2020 T-slot × 500 mm", "Aluminium extrusion", "extrusion"], ["608 ball bearing", "8 × 22 × 7 mm", "bearing"], ["NEMA 17 stepper", "42 mm, 48 mm body", "motor"], ["M5 × 16 socket head", "ISO 4762", "bolt"]],
  "McMaster-Carr": [["Search McMaster-Carr…", "Opens in the McMaster window", "mcmaster"]],
};

/**
 * ctx: { host (#workspace), icons, toast, logEvent, openDesigns() -> [{ name, active }],
 *        parts (platform.parts: info / list / reveal), openPart(part),
 *        insertDesign({ file, path, name } | { tab, name }) }
 * Returns { toggle(open?), render() }.
 */
export function initPartsPanel(ctx) {
  const { host, icons } = ctx;
  const rail = h("div", { class: "parts-rail" },
    h("button", { class: "parts-tab", title: "Parts — drag a saved design into the scene to insert it", onclick: () => toggle() }, h("i", { html: icons.component }), h("span", {}, "PARTS")));
  const panel = h("div", { class: "parts-panel" });
  host.append(rail, panel);
  let open = !!getPref("partsPanel", false);
  let query = "";
  let bin = null, binDir = null, binLoading = null; // Parts folder listing (null = not loaded / unavailable)
  let renderList = () => {};
  function loadBin() {
    if (!ctx.parts || binLoading) return binLoading;
    binLoading = Promise.all([ctx.parts.list(), binDir ? binDir : ctx.parts.info().then((i) => i && i.dir)])
      .then(([list, dir]) => { bin = Array.isArray(list) ? list : null; binDir = dir || null; })
      .catch(() => { bin = null; })
      .finally(() => { binLoading = null; if (open) renderList(); });
    return binLoading;
  }
  // one saved design in the Parts folder: thumbnail card, double-click to open
  function binCard(part) {
    const when = new Date(part.mtime);
    const el = h("div", { class: "parts-bincard", draggable: "true", title: `${part.name}
Drag onto the viewport to insert · double-click to open · saved ${when.toLocaleString()}` },
      part.thumb ? h("img", { class: "parts-binimg", src: part.thumb, alt: "", draggable: "false" }) /* else the drag carries the PNG as a file and the window's file drop rejects it (bug report 2026-10-09 09:04) */ : h("i", { class: "parts-binimg none", html: icons.body }),
      h("div", { class: "parts-binnm" }, part.name));
    el.addEventListener("dblclick", () => { ctx.logEvent && ctx.logEvent("parts", { action: "open", name: part.file }); ctx.openPart && ctx.openPart(part); });
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData(DESIGN_MIME, JSON.stringify({ file: part.file, path: part.path || null, name: part.name })); e.dataTransfer.effectAllowed = "copy"; ctx.logEvent && ctx.logEvent("parts", { action: "drag", name: part.file }); });
    return el;
  }
  // another open design tab: drag to insert it
  function designCard(d) {
    const el = h("div", { class: "parts-card", draggable: "true", title: `${d.name} — drag onto the viewport to insert it` },
      h("i", { class: "parts-thumb", html: icons[d.kind === "assembly" ? "component" : d.kind === "hybrid" ? "hybrid" : "body"] || icons.body }),
      h("div", { class: "parts-tx" }, h("div", { class: "parts-nm" }, d.name), h("div", { class: "parts-ds" }, `Open ${d.kind || "part"}`)));
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData(DESIGN_MIME, JSON.stringify({ tab: d.tab, name: d.name })); e.dataTransfer.effectAllowed = "copy"; ctx.logEvent && ctx.logEvent("parts", { action: "drag", name: d.name }); });
    return el;
  }

  function card(name, detail, icon, extra = "") {
    const el = h("div", { class: `parts-card${extra}`, draggable: "true", title: `${name} — drag into the scene (under construction)` },
      h("i", { class: "parts-thumb", html: icons[icon] || icons.body }), h("div", { class: "parts-tx" }, h("div", { class: "parts-nm" }, name), h("div", { class: "parts-ds" }, detail)));
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("application/x-cad-part", name); e.dataTransfer.effectAllowed = "copy"; ctx.logEvent && ctx.logEvent("parts", { action: "drag", name }); });
    return el;
  }
  function render() {
    panel.innerHTML = "";
    const search = h("input", { type: "search", placeholder: "Search parts…", value: query, spellcheck: "false", oninput: () => { query = search.value; renderList(); } });
    const list = h("div", { class: "parts-list" });
    panel.append(
      h("div", { class: "parts-head" }, h("span", {}, "PARTS"), h("div", { class: "parts-sp" }), h("button", { class: "parts-x", title: "Close", html: icons.close, onclick: () => toggle(false) })),
      h("div", { class: "parts-uc" }, h("span", {}, "Drag a saved design onto the viewport to insert it (this design becomes a hybrid). Shop Stock and McMaster cards: "), h("span", { class: "uc-tag" }, "UNDER CONSTRUCTION")),
      h("div", { class: "parts-search" }, h("i", { html: icons.search }), search),
      list);
    renderList = () => {
      list.innerHTML = "";
      const q = query.toLowerCase();
      const match = (name) => !q || name.toLowerCase().includes(q);
      // the PARTS bin: designs saved in the Parts folder
      if (ctx.parts) {
        const head = h("div", { class: "parts-sec parts-binhead" }, h("span", {}, "Parts"), h("div", { class: "parts-sp" }),
          h("button", { class: "parts-mini", title: "Refresh", html: icons.refresh || "⟳", onclick: () => loadBin() }),
          h("button", { class: "parts-mini", title: binDir ? `Open the Parts folder
${binDir}` : "Open the Parts folder", html: icons.folder, onclick: () => ctx.parts.reveal().then((ok) => { if (!ok) ctx.toast(binDir ? `Parts folder: ${binDir}` : "The Parts folder is in the desktop app"); }) }));
        list.append(head);
        if (bin == null) list.append(h("div", { class: "parts-empty" }, binLoading ? "Loading…" : "The Parts folder is available in the desktop app."));
        else {
          const shown = bin.filter((p) => match(p.name));
          if (!shown.length) list.append(h("div", { class: "parts-empty" }, q ? "No saved parts match." : "Designs you save go to the Parts folder and show up here."));
          else list.append(h("div", { class: "parts-bin" }, shown.map(binCard)));
        }
      }
      const section = (title, rows) => {
        const shown = rows.filter((r) => match(r[0]));
        if (!shown.length) return;
        list.append(h("div", { class: "parts-sec" }, title));
        for (const r of shown) list.append(card(...r));
      };
      const designs = (ctx.openDesigns ? ctx.openDesigns() : []).filter((d) => !d.active && match(d.name)); // not this tab: no inserting a design into itself
      if (designs.length) { list.append(h("div", { class: "parts-sec" }, "Open designs")); for (const d of designs) list.append(designCard(d)); }
      if (!designs.length && !q) list.append(h("div", { class: "parts-sec" }, "Open designs"), h("div", { class: "parts-empty" }, "Other open design tabs show up here."));
      if (!q) { list.append(h("div", { class: "parts-sec" }, "Recent parts"), h("div", { class: "parts-empty" }, "Parts you insert will show up here.")); }
      for (const [title, rows] of Object.entries(LIBRARY)) section(title, rows);
    };
    renderList();
    loadBin();
  }
  function toggle(next = !open) {
    open = next;
    setPref("partsPanel", open);
    host.classList.toggle("parts-open", open);
    rail.querySelector(".parts-tab").classList.toggle("active", open);
    if (open) render();
    ctx.logEvent && ctx.logEvent("parts", { action: open ? "open" : "close" });
  }
  // dropping onto the viewport: designs are inserted, library parts aren't built yet
  const view = host.querySelector("canvas");
  view.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("application/x-cad-part") || e.dataTransfer.types.includes(DESIGN_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  view.addEventListener("drop", (e) => {
    const design = e.dataTransfer.getData(DESIGN_MIME);
    if (design) {
      e.preventDefault();
      let src = null;
      try { src = JSON.parse(design); } catch (err) { /* ignore */ }
      if (src && ctx.insertDesign) { ctx.logEvent && ctx.logEvent("parts", { action: "drop", name: src.name }); ctx.insertDesign(src); }
      return;
    }
    const name = e.dataTransfer.getData("application/x-cad-part");
    if (!name) return;
    e.preventDefault();
    ctx.toast(`Dragging parts into the scene is under construction (${name})`);
  });
  host.classList.add("has-parts-rail");
  if (open) toggle(true);
  return { toggle, render: () => open && render() };
}
