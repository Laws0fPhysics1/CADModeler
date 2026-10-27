// New Study gallery (SIMULATE > New Study): every study type as a card, grouped by physics.
// Working types run their command; the rest carry the under-construction tape and do nothing.
import "./studygallery.css";
import { STUDY_CATEGORIES, STUDY_TYPES } from "./studytypes.js";

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

/** ctx: { icons, run(commandKey), logEvent }. `cat` preselects a category ("all" by default). */
export function openStudyGallery(ctx, cat = "all") {
  closeStudyGallery();
  const { icons } = ctx;
  let sel = cat;
  let picked = null;
  const nav = h("div", { class: "sg-nav" });
  const grid = h("div", { class: "sg-grid" });
  const detail = h("div", { class: "sg-detail" });
  const createBtn = h("button", { class: "btn primary", onclick: () => create(picked) }, "Create Study");

  const render = () => {
    nav.innerHTML = "";
    for (const [id, label] of [["all", "All studies"], ...STUDY_CATEGORIES.map((c) => [c.id, c.label])]) {
      const n = id === "all" ? STUDY_TYPES.length : STUDY_TYPES.filter((t) => t.cat === id).length;
      nav.append(h("button", { class: `sg-navbtn${id === sel ? " active" : ""}`, onclick: () => { sel = id; render(); } }, label, h("span", { class: "sg-n" }, String(n))));
    }
    grid.innerHTML = "";
    const cats = sel === "all" ? STUDY_CATEGORIES : STUDY_CATEGORIES.filter((c) => c.id === sel);
    for (const c of cats) {
      const types = STUDY_TYPES.filter((t) => t.cat === c.id);
      if (sel === "all") grid.append(h("div", { class: "sg-cat" }, c.label));
      for (const t of types) {
        const card = h("div", { class: `sg-card${t.cmd ? "" : " soon"}${picked === t ? " picked" : ""}`, tabindex: "0", title: t.cmd ? null : "Under construction: opens a setup preview",
          onclick: () => { picked = t; render(); }, ondblclick: () => create(t), onkeydown: (e) => { if (e.key === "Enter") create(t); } },
          h("i", { class: "sg-ico", html: icons[t.icon] || "" }),
          h("div", { class: "sg-tx" }, h("div", { class: "sg-nm" }, t.label, t.added ? h("span", { class: "sg-new" }, "SUGGESTED") : null), h("div", { class: "sg-ds" }, t.desc)),
          t.cmd ? null : h("span", { class: "uc-tag" }, "UNDER CONSTRUCTION"));
        grid.append(card);
      }
    }
    detail.innerHTML = "";
    if (picked) detail.append(h("b", {}, picked.label), h("span", {}, picked.cmd ? " — ready" : " — under construction: opens its setup ribbon and settings, nothing is solved"));
    else detail.append(h("span", {}, "Pick a study type"));
    createBtn.disabled = !picked;
  };
  function create(t) {
    if (!t) return;
    ctx.logEvent && ctx.logEvent("new study", { type: t.id });
    closeStudyGallery();
    ctx.run(t.cmd || t.id); // types without a solver open their setup preview (main.js startStudySetup)
  }

  const panel = h("div", { class: "sg-panel", role: "dialog", "aria-label": "New Study" },
    h("div", { class: "sg-title" }, h("i", { class: "sg-tico", html: icons.newStudy }), "New Study", h("div", { class: "sg-sp" }), h("button", { class: "sg-x", title: "Close", html: icons.close, onclick: closeStudyGallery })),
    h("div", { class: "sg-main" }, nav, grid),
    h("div", { class: "sg-foot" }, detail, h("div", { class: "sg-sp" }), createBtn, h("button", { class: "btn", onclick: closeStudyGallery }, "Cancel")));
  const scrim = h("div", { class: "sg-scrim", onpointerdown: (e) => { if (e.target === scrim) closeStudyGallery(); } }, panel);
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeStudyGallery(); } };
  window.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  current = { scrim, onKey };
  render();
}

export function closeStudyGallery() {
  if (!current) return;
  current.scrim.remove();
  window.removeEventListener("keydown", current.onKey, true);
  current = null;
}
