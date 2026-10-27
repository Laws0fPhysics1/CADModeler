// Appearance / Physical Material dialog (Fusion-style, docked on the right).
//
//   openAppearanceDialog({
//     host,                       // element to put the panel in (the #workspace)
//     bodies: [{ id, name }],
//     selectedIds: [...],         // initial "Apply to" (all bodies when empty)
//     getAppearance(id),          // stored appearance or null
//     onPreview(ids, appearance), // live preview; appearance === null means "revert to stored"
//     onApply(ids, appearance),   // commit (OK and Apply)
//     onClose(),
//     title?, mode?: "appearance" | "physical"   // "physical" opens with the properties panel first
//   }) -> { el, close() }
import "./appearance.css";
import {
  MATERIALS, CATEGORIES, getMaterial, DEFAULT_MATERIAL_ID, resolveAppearance, COLOR_PRESETS, describe,
  normalizeAppearance, normalizeHex, physicalRows, FINISHES,
} from "./materials.js";

const CLOSE_SVG = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
const SPHERE_SVG = '<svg viewBox="0 0 20 20"><defs><radialGradient id="apprIco" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="#e2574c"/><stop offset="1" stop-color="#7a1f17"/></radialGradient></defs><circle cx="10" cy="10" r="8" fill="url(#apprIco)"/></svg>';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

// ---- colour helpers for the CSS "sphere" swatches ----
const rgb = (hex) => { const h = normalizeHex(hex) || "#808080"; return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const hex = (c) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };

/** CSS background for a rendered-looking sphere of the given render params. */
export function swatchBackground(r) {
  const c = r.color;
  if ((r.transmission || 0) > 0.5) {
    return `radial-gradient(circle at 32% 26%, rgba(255,255,255,.95) 0, rgba(255,255,255,0) 16%),
      radial-gradient(circle at 50% 55%, ${mix(c, "#ffffff", 0.2)}22 0, ${mix(c, "#8aa0b0", 0.4)}88 70%, ${mix(c, "#2a3540", 0.4)}cc 100%),
      repeating-conic-gradient(#d8d8d8 0 25%, #f4f4f4 0 50%) 0 0 / 8px 8px`;
  }
  if (r.metalness >= 0.5) {
    const soft = r.roughness > 0.5 ? 10 : 0;
    return `radial-gradient(circle at 34% 28%, ${mix(c, "#ffffff", 0.8)} 0, ${mix(c, "#ffffff", 0.3)} ${12 + soft}%, ${c} ${32 + soft}%, ${mix(c, "#000000", 0.6)} ${60 + soft / 2}%, ${mix(c, "#000000", 0.35)} 78%, ${mix(c, "#ffffff", 0.3)} 100%)`;
  }
  const spec = Math.max(0.12, 0.95 * (1 - r.roughness) + (r.clearcoat || 0) * 0.3);
  return `radial-gradient(circle at 32% 26%, rgba(255,255,255,${spec.toFixed(2)}) 0, rgba(255,255,255,0) ${r.roughness > 0.5 ? 34 : 20}%),
    radial-gradient(circle at 40% 36%, ${mix(c, "#ffffff", 0.12)} 0, ${c} 42%, ${mix(c, "#000000", 0.5)} 100%)`;
}
function swatch(r, cls = "appr-sw") { const s = el("span", { class: cls }); s.style.background = swatchBackground(r); return s; }

const FINISH_OPTS = [[null, "Default"], ...FINISHES.map((f) => [f, f[0].toUpperCase() + f.slice(1)])];

export function openAppearanceDialog(ctx) {
  const bodies = ctx.bodies || [];
  const allIds = bodies.map((b) => b.id);
  const sel = (ctx.selectedIds || []).filter((id) => allIds.includes(id));
  const checked = new Set(sel.length ? sel : allIds);
  const touched = new Set();
  const first = [...checked][0];
  const start = normalizeAppearance(first ? ctx.getAppearance(first) : null) || { materialId: DEFAULT_MATERIAL_ID };
  const cur = { materialId: start.materialId, color: start.color || null, finish: start.finish || null };
  let closed = false;

  const appearance = (over = {}) => {
    const a = { ...cur, ...over }, out = { materialId: a.materialId };
    if (a.color) out.color = a.color;
    if (a.finish) out.finish = a.finish;
    return out;
  };
  const ids = () => allIds.filter((id) => checked.has(id));
  const preview = (over) => {
    const list = ids();
    if (!list.length) return;
    list.forEach((id) => touched.add(id));
    ctx.onPreview && ctx.onPreview(list, appearance(over));
  };

  // ---------- Apply to ----------
  const bodyBox = el("div", { class: "appr-bodies" });
  const countLbl = el("span", { class: "appr-count" });
  function renderBodies() {
    bodyBox.innerHTML = "";
    if (!bodies.length) bodyBox.append(el("div", { class: "appr-empty" }, "No bodies in the design"));
    for (const b of bodies) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = checked.has(b.id);
      cb.addEventListener("change", () => {
        if (cb.checked) { checked.add(b.id); touched.add(b.id); ctx.onPreview && ctx.onPreview([b.id], appearance()); }
        else { checked.delete(b.id); ctx.onPreview && ctx.onPreview([b.id], null); }
        updateCount();
      });
      const app = ctx.getAppearance(b.id);
      bodyBox.append(el("label", { class: "appr-row", title: describe(app) }, cb, el("span", { class: "nm" }, b.name || b.id), el("em", {}, describe(app))));
    }
    updateCount();
  }
  function updateCount() {
    countLbl.textContent = `${checked.size} of ${bodies.length}`;
    okBtn && (okBtn.disabled = applyBtn.disabled = !checked.size);
  }
  const allBtn = el("button", { class: "appr-link", onclick: () => {
    const all = checked.size !== bodies.length;
    for (const b of bodies) { if (all) checked.add(b.id); else checked.delete(b.id); }
    if (all) preview(); else ctx.onPreview && ctx.onPreview(allIds, null);
    renderBodies();
  } }, "All / none");

  // ---------- material library ----------
  const search = el("input", { class: "appr-search", type: "search", placeholder: "Search materials", spellcheck: "false" });
  const list = el("div", { class: "appr-list" });
  const rows = new Map();
  function renderList() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = ""; rows.clear();
    let n = 0;
    for (const cat of CATEGORIES) {
      const mats = MATERIALS.filter((m) => m.category === cat && (!q || m.name.toLowerCase().includes(q) || cat.toLowerCase().includes(q) || m.id.includes(q)));
      if (!mats.length) continue;
      list.append(el("div", { class: "appr-cat" }, cat));
      for (const m of mats) {
        const row = el("div", { class: "appr-mat" + (m.id === cur.materialId ? " on" : ""), tabindex: "-1", title: m.physical.note || m.name },
          swatch(m.render), el("span", { class: "nm" }, m.name));
        row.addEventListener("mouseenter", () => preview({ materialId: m.id }));
        row.addEventListener("click", () => { cur.materialId = m.id; update(); preview(); });
        row.addEventListener("dblclick", () => { cur.materialId = m.id; ok(); });
        list.append(row); rows.set(m.id, row); n++;
      }
    }
    if (!n) list.append(el("div", { class: "appr-empty" }, "No matching materials"));
  }
  list.addEventListener("mouseleave", () => preview());
  search.addEventListener("input", renderList);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const firstId = [...rows.keys()][0];
      if (firstId) { cur.materialId = firstId; update(); preview(); }
    }
  });

  // ---------- colour ----------
  const colorBox = el("div", { class: "appr-colors" });
  const custom = el("input", { type: "color", class: "appr-custom", title: "Custom colour" });
  const defSw = el("button", { class: "appr-col def", title: "Material default" });
  defSw.addEventListener("mouseenter", () => preview({ color: null }));
  defSw.addEventListener("click", () => { cur.color = null; update(); preview(); });
  colorBox.append(defSw);
  const colBtns = COLOR_PRESETS.map((p) => {
    const b = el("button", { class: "appr-col", title: p.name, style: { background: p.hex } });
    b.dataset.hex = p.hex;
    b.addEventListener("mouseenter", () => preview({ color: p.hex }));
    b.addEventListener("click", () => { cur.color = p.hex; update(); preview(); });
    colorBox.append(b);
    return b;
  });
  colorBox.addEventListener("mouseleave", () => preview());
  custom.addEventListener("input", () => { cur.color = normalizeHex(custom.value); update(); preview(); });
  const colorLbl = el("span", { class: "appr-colname" });

  // ---------- finish ----------
  const finishBox = el("div", { class: "appr-seg" });
  const finBtns = FINISH_OPTS.map(([f, label]) => {
    const b = el("button", { class: "appr-segbtn" }, label);
    b.addEventListener("mouseenter", () => preview({ finish: f }));
    b.addEventListener("click", () => { cur.finish = f; update(); preview(); });
    finishBox.append(b);
    return [f, b];
  });
  finishBox.addEventListener("mouseleave", () => preview());

  // ---------- current + physical ----------
  const bigSw = el("span", { class: "appr-sw big" });
  const curName = el("div", { class: "appr-curname" });
  const curSub = el("div", { class: "appr-cursub" });
  const props = el("div", { class: "appr-props" });
  const propsNote = el("div", { class: "appr-note" });
  const physSec = el("details", { class: "appr-sec appr-phys", open: ctx.mode === "physical" ? true : null },
    el("summary", {}, "Physical properties ", el("em", {}, "for simulation")), props, propsNote);

  function update() {
    const r = resolveAppearance(appearance());
    bigSw.style.background = swatchBackground(r.renderParams);
    curName.textContent = describe(appearance());
    curSub.textContent = `${r.material.category} · ${r.renderParams.metalness >= 0.5 ? "metallic" : "dielectric"} · roughness ${r.renderParams.roughness.toFixed(2)}`;
    for (const [id, row] of rows) row.classList.toggle("on", id === cur.materialId);
    const def = getMaterial(cur.materialId).render;
    defSw.style.background = swatchBackground({ ...def });
    defSw.classList.toggle("on", !cur.color);
    for (const b of colBtns) b.classList.toggle("on", b.dataset.hex === cur.color);
    custom.value = cur.color || normalizeHex(def.color) || "#808080";
    custom.classList.toggle("on", !!cur.color && !COLOR_PRESETS.some((p) => p.hex === cur.color));
    colorLbl.textContent = cur.color ? (COLOR_PRESETS.find((p) => p.hex === cur.color)?.name || cur.color) : "Material default";
    for (const [f, b] of finBtns) b.classList.toggle("on", f === cur.finish);
    props.innerHTML = "";
    for (const row of physicalRows(r.material)) props.append(el("div", { class: "appr-prop" }, el("span", {}, row.label), el("b", {}, row.value)));
    propsNote.textContent = `${r.material.physical.note ? r.material.physical.note + " " : ""}${r.material.physical.source}`;
  }

  // ---------- frame ----------
  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove();
    ctx.onClose && ctx.onClose();
  };
  const cancel = () => {
    if (closed) return;
    const list = [...touched];
    if (list.length && ctx.onPreview) ctx.onPreview(list, null);
    close();
  };
  const apply = () => {
    const list = ids();
    if (!list.length) return;
    ctx.onApply && ctx.onApply(list, appearance());
    // what's applied is now the stored state; unchecked bodies were already reverted
    touched.clear();
    renderBodies();
  };
  const ok = () => { if (!ids().length) return; apply(); close(); };

  const head = el("div", { class: "dlg-head" }, el("span", { class: "ic", html: SPHERE_SVG }), el("span", {}, ctx.title || (ctx.mode === "physical" ? "Physical Material" : "Appearance")),
    el("button", { class: "x", title: "Cancel", html: CLOSE_SVG, onclick: cancel }));
  const body = el("div", { class: "dlg-body appr-body" },
    el("div", { class: "appr-sec" }, el("div", { class: "appr-h" }, "Apply to", countLbl, allBtn), bodyBox),
    el("div", { class: "appr-cur" }, bigSw, el("div", { class: "appr-curtxt" }, curName, curSub)),
    el("div", { class: "appr-sec" }, el("div", { class: "appr-h" }, "Material"), search, list),
    el("div", { class: "appr-sec" }, el("div", { class: "appr-h" }, "Color", colorLbl), el("div", { class: "appr-colrow" }, colorBox, el("label", { class: "appr-customwrap", title: "Custom colour" }, custom, el("span", {}, "Custom")))),
    el("div", { class: "appr-sec" }, el("div", { class: "appr-h" }, "Finish"), finishBox),
    physSec);
  const okBtn = el("button", { class: "btn primary", onclick: ok }, "OK");
  const applyBtn = el("button", { class: "btn", onclick: apply }, "Apply");
  const foot = el("div", { class: "dlg-foot" }, el("div", { class: "sp" }), okBtn, applyBtn, el("button", { class: "btn", onclick: cancel }, "Cancel"));
  const panel = el("div", { class: "panel appr-dlg", role: "dialog", "aria-label": "Appearance" }, head, body, foot);

  // keep app shortcuts from firing while the dialog has focus / is typed in
  for (const type of ["keydown", "keyup", "keypress"]) panel.addEventListener(type, (e) => {
    e.stopPropagation();
    if (type !== "keydown") return;
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter" && e.target !== search && e.target.tagName !== "BUTTON") { e.preventDefault(); ok(); }
  });
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  panel.addEventListener("contextmenu", (e) => e.stopPropagation());

  // drag by the header, like the command dialogs
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect(), hr = panel.parentElement.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(Math.max(ev.clientX - dx - hr.left, 0), hr.width - r.width);
      const y = Math.min(Math.max(ev.clientY - dy - hr.top, 0), hr.height - 40);
      Object.assign(panel.style, { left: x + "px", top: y + "px", right: "auto" });
    };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
  });

  (ctx.host || document.body).append(panel);
  renderBodies();
  renderList();
  update();
  const onRow = rows.get(cur.materialId);
  if (onRow) onRow.scrollIntoView({ block: "nearest" });
  if (ctx.mode !== "physical") setTimeout(() => !closed && search.focus({ preventScroll: true }), 0);
  return { el: panel, close: cancel, apply, get appearance() { return appearance(); }, get ids() { return ids(); } };
}
