// Study Settings panel for the placeholder simulation studies (studysetup.js). Looks like a feature
// dialog; the values can be edited but nothing saves or uses them yet (under construction).
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

/** Default values for a setup: { "<section>/<label>": value }. */
export function defaultValues(setup) {
  const v = {};
  for (const s of setup.options) for (const f of s.fields) v[`${s.title}/${f.label}`] = f.value;
  return v;
}

/** ctx: { host, type (studytypes entry), setup, values (edited in place), icons, onClose } */
export function openStudyOptions(ctx) {
  closeStudyOptions();
  const { type, setup, values, icons } = ctx;
  const body = h("div", { class: "dlg-body" },
    h("div", { class: "ss-uc" }, h("span", { class: "uc-tag" }, "UNDER CONSTRUCTION"), h("span", {}, "These settings aren't saved or used yet.")));
  for (const s of setup.options) {
    body.append(h("div", { class: "ss-sec" }, s.title));
    for (const f of s.fields) {
      const key = `${s.title}/${f.label}`;
      let ctl;
      if (f.type === "select") {
        ctl = h("select", { onchange: () => { values[key] = ctl.value; } }, f.options.map((o) => (Array.isArray(o) ? h("option", { value: o[0] }, o[1]) : h("option", { value: o }, o))));
        ctl.value = values[key];
      } else if (f.type === "check") {
        ctl = h("input", { type: "checkbox", onchange: () => { values[key] = ctl.checked; } });
        ctl.checked = !!values[key];
      } else {
        const inp = h("input", { type: f.type === "number" ? "text" : "text", value: String(values[key] ?? ""), spellcheck: "false",
          onchange: () => { values[key] = f.type === "number" && inp.value.trim() !== "" && Number.isFinite(+inp.value) ? +inp.value : inp.value; } });
        ctl = h("div", { class: "num" }, inp, f.unit ? h("em", {}, f.unit) : null);
      }
      body.append(h("div", { class: `dlg-row${f.type === "check" ? " ss-check" : ""}` }, h("label", { title: f.label }, f.label), h("div", { class: "ctl" }, ctl)));
    }
  }
  const close = () => { closeStudyOptions(); ctx.onClose && ctx.onClose(); };
  const el = h("div", { class: "panel ss-panel" },
    h("div", { class: "dlg-head" }, h("i", { class: "ic", html: icons[type.icon] || "" }), h("span", {}, `${type.label} — Study Settings`), h("button", { class: "x", title: "Close", html: icons.close, onclick: close })),
    body,
    h("div", { class: "dlg-foot" }, h("div", { class: "sp" }), h("button", { class: "btn primary", onclick: close }, "OK"), h("button", { class: "btn", onclick: close }, "Cancel")));
  ctx.host.append(el);
  current = el;
  return el;
}

export function closeStudyOptions() { if (current) { current.remove(); current = null; } }
export const studyOptionsOpen = () => !!current;
