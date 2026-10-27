// Bug reporter: a rolling log of user input (last 5 minutes) plus a "Bug report"
// dialog that saves memo + log + screenshot + design via saveReport().
import "./bugreport.css";

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;
const INPUT_DEBOUNCE_MS = 500;
const WHEEL_GAP_MS = 400;
const MOVE_SAMPLE_MS = 500;

const entries = [];
let getCtx = () => ({});
let overlay = null;

// ---------- ring buffer ----------
const now = () => Math.round(performance.now());

function prune() {
  const cutoff = now() - WINDOW_MS;
  let i = 0;
  while (i < entries.length && entries[i].t < cutoff) i++;
  if (entries.length - i > MAX_ENTRIES) i = entries.length - MAX_ENTRIES;
  if (i) entries.splice(0, i);
}

function push(type, data = {}) {
  const e = { t: now(), time: new Date().toISOString(), type, ...data };
  entries.push(e);
  if (entries.length > MAX_ENTRIES + 200 || entries.length % 200 === 0) prune();
  return e;
}

/** App-level semantic events, e.g. logEvent("command", { name: "Extrude" }). */
export function logEvent(type, data) {
  push("app", data === undefined ? { name: type } : { name: type, data: safeClone(data) });
}

function safeClone(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

// ---------- target description ----------
const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function describe(node) {
  if (!node || node.nodeType !== 1) return node === window ? "window" : node === document ? "document" : "?";
  if (node.tagName === "CANVAS") return "canvas" + (node.id ? "#" + node.id : "");
  const el = node.closest("button, a, input, select, textarea, label, [role], [title], li, [data-id]") || node;
  let s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (cls.length) s += "." + cls.join(".");
  if (el.tagName === "INPUT") s += `[type=${el.type}]` + (el.name ? `[name=${el.name}]` : "");
  const title = el.getAttribute("title");
  if (title) s += ` [${clip(title)}]`;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text !== title) s += ` "${clip(text)}"`;
  } else if (el.placeholder) s += ` (${clip(el.placeholder)})`;
  if (!el.id) {
    const anc = el.parentElement && el.parentElement.closest("[id]");
    if (anc) s += ` in #${anc.id}`;
  }
  return s;
}

const mods = (e) => ["ctrl", "shift", "alt", "meta"].filter((m) => e[m + "Key"]).join("+") || undefined;
const BTN = ["L", "M", "R", "B4", "B5"];
const isEditable = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const fromDialog = (e) => !!(overlay && e.target && e.target.nodeType === 1 && overlay.contains(e.target));

// ---------- capture listeners (installed at import time) ----------
function onPointer(e) {
  if (fromDialog(e)) return;
  push(e.type, { btn: BTN[e.button] ?? e.button, x: Math.round(e.clientX), y: Math.round(e.clientY), mods: mods(e), target: describe(e.target) });
}

let lastWheel = null;
function onWheel(e) {
  if (fromDialog(e)) return;
  const target = describe(e.target);
  const t = now();
  const last = entries[entries.length - 1];
  if (lastWheel && last === lastWheel && lastWheel.target === target && t - lastWheel.tEnd < WHEEL_GAP_MS) {
    lastWheel.count++;
    lastWheel.dy = Math.round(lastWheel.dy + e.deltaY);
    lastWheel.tEnd = t;
    return;
  }
  lastWheel = push("wheel", { count: 1, dy: Math.round(e.deltaY), x: Math.round(e.clientX), y: Math.round(e.clientY), mods: mods(e), target, tEnd: t });
}

let lastMove = 0;
function onMove(e) {
  if (!e.buttons || fromDialog(e)) return; // only sample drags
  const t = now();
  if (t - lastMove < MOVE_SAMPLE_MS) return;
  lastMove = t;
  push("drag", { buttons: e.buttons, x: Math.round(e.clientX), y: Math.round(e.clientY), target: describe(e.target) });
}

function onKey(e) {
  if (fromDialog(e)) return;
  const inInput = isEditable(e.target);
  push("keydown", { key: e.key, mods: mods(e), inInput: inInput || undefined, repeat: e.repeat || undefined, target: inInput ? describe(e.target) : undefined });
}

const pendingInputs = new Map();
function valueOf(el) {
  if (el.type === "checkbox" || el.type === "radio") return el.checked;
  if (el.type === "password") return "***";
  return clip(String(el.value ?? ""), 200);
}
function flushInput(el, type) {
  const p = pendingInputs.get(el);
  if (p) { clearTimeout(p); pendingInputs.delete(el); }
  push(type, { value: valueOf(el), target: describe(el) });
}
function onInput(e) {
  const el = e.target;
  if (fromDialog(e) || !el || el.nodeType !== 1 || !isEditable(el)) return;
  if (e.type === "change") return flushInput(el, "change");
  clearTimeout(pendingInputs.get(el));
  pendingInputs.set(el, setTimeout(() => { pendingInputs.delete(el); push("input", { value: valueOf(el), target: describe(el) }); }, INPUT_DEBOUNCE_MS));
}

function onError(e) {
  push("error", { message: String(e.message || e.error || "error"), source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack ? clip(String(e.error.stack), 2000) : undefined });
}
function onRejection(e) {
  const r = e.reason;
  push("unhandledrejection", { message: clip(String(r && r.message ? r.message : r), 500), stack: r && r.stack ? clip(String(r.stack), 2000) : undefined });
}

function argText(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
  return String(a);
}
function wrapConsole(level) {
  const orig = console[level];
  if (typeof orig !== "function" || orig.__bugWrapped) return;
  let busy = false;
  const wrapped = function (...args) {
    if (!busy) {
      busy = true;
      try { push("console." + level, { message: clip(args.map(argText).join(" "), 2000) }); } catch {}
      busy = false;
    }
    return orig.apply(this, args);
  };
  wrapped.__bugWrapped = true;
  console[level] = wrapped;
}

function install() {
  if (typeof window === "undefined" || window.__bugLoggerInstalled) return;
  window.__bugLoggerInstalled = true;
  const opt = { capture: true, passive: true };
  for (const t of ["pointerdown", "pointerup", "dblclick", "contextmenu"]) window.addEventListener(t, onPointer, opt);
  window.addEventListener("wheel", onWheel, opt);
  window.addEventListener("pointermove", onMove, opt);
  window.addEventListener("keydown", onKey, opt);
  window.addEventListener("input", onInput, opt);
  window.addEventListener("change", onInput, opt);
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  wrapConsole("error");
  wrapConsole("warn");
  push("page", { name: "logger started", url: location.href });
}
install();

/** Snapshot of the log (pruned to the last 5 minutes). */
export function getLog() {
  prune();
  return entries.map(({ tEnd, ...e }) => e);
}

// ---------- saving ----------
const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "report";

// Swap this for a desktop wrapper (Electron/Tauri) via setSaveHandler().
let saveHandler = defaultSave;
export function setSaveHandler(fn) { saveHandler = fn || defaultSave; }
export function saveReport(payload) { return saveHandler(payload); }
// "Reports…" in the dialog opens the status list (bugstatusui.js), wired by main.js
let reportsHandler = null;
export function setReportsHandler(fn) { reportsHandler = fn || null; }

async function defaultSave(payload) {
  try {
    const res = await fetch("/api/bug-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
      const data = await res.json();
      if (data && data.ok) return { ok: true, path: data.path, method: "server" };
    }
  } catch {}
  return downloadReport(payload);
}

function downloadReport(payload) {
  const name = `bug-report_${stamp()}_${slug(payload.memo)}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { ok: true, path: name, method: "download" };
}

// ---------- context + payload ----------
function readContext() {
  try {
    const c = getCtx();
    return c && typeof c === "object" ? { ctx: c } : { ctx: {} };
  } catch (err) {
    return { ctx: {}, error: String(err && err.stack ? err.stack : err) };
  }
}

function buildPayload(memo, snap, opts) {
  const { ctx, error } = snap;
  const canvas = document.getElementById("view");
  const r = canvas ? canvas.getBoundingClientRect() : null;
  const shot = typeof ctx.screenshot === "string" && ctx.screenshot.startsWith("data:image") ? ctx.screenshot : null;
  return {
    version: 1,
    memo,
    createdAt: new Date().toISOString(),
    nowT: now(),
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, canvas: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null },
    theme: document.documentElement.dataset.theme || "light",
    appState: ctx.appState !== undefined ? safeClone(ctx.appState) : null,
    doc: opts.design && ctx.doc !== undefined ? safeClone(ctx.doc) : null,
    screenshot: opts.screenshot ? shot : null,
    contextError: error || null,
    events: getLog(),
  };
}

// ---------- dialog ----------
const X_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

function closeDialog() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
}

const KINDS = {
  bug: { title: "REPORT A BUG", lbl: "What happened?", ph: "Describe what you did, what you expected, and what happened instead.", opened: "bug report dialog opened", saved: "bug report saved" },
  feature: { title: "REQUEST A FEATURE", lbl: "What should it do?", ph: "Describe the feature or change: what you want to do, where in the app, and how it should behave.", opened: "feature request dialog opened", saved: "feature request saved" },
};
function openDialog(kind = "bug") {
  if (!KINDS[kind]) kind = "bug";
  const K = KINDS[kind];
  if (overlay) return;
  push("app", { name: K.opened });
  const snap = readContext(); // capture state now, before the user types the memo
  const memo = el("textarea", { placeholder: K.ph });
  const cbShot = el("input", { type: "checkbox", checked: true });
  const cbDoc = el("input", { type: "checkbox", checked: true });
  const msg = el("div", { class: "bug-msg" });
  const submit = el("button", { class: "primary", onclick: () => doSubmit() }, "Submit");
  const cancel = el("button", { onclick: closeDialog }, "Cancel");

  async function doSubmit() {
    if (submit.disabled) return;
    submit.disabled = cancel.disabled = true;
    msg.className = "bug-msg";
    try {
      const payload = { ...buildPayload(memo.value.trim(), snap, { screenshot: cbShot.checked, design: cbDoc.checked }), kind };
      const res = await saveReport(payload);
      msg.textContent = res.method === "download" ? `Downloaded ${res.path}` : `Saved to ${res.path}`;
      msg.className = "bug-msg ok";
      push("app", { name: K.saved, data: { path: res.path } });
      setTimeout(closeDialog, 1600);
    } catch (err) {
      msg.textContent = "Could not save the report: " + (err && err.message ? err.message : err);
      msg.className = "bug-msg err";
      submit.disabled = cancel.disabled = false;
    }
  }

  const card = el("div", { class: "bug-card", role: "dialog", "aria-label": K.title.toLowerCase() },
    el("div", { class: "bug-head" }, el("span", {}, K.title), el("button", { class: "bug-x", title: "Cancel", html: X_ICON, onclick: closeDialog })),
    el("div", { class: "bug-body" },
      el("label", { class: "bug-lbl" }, K.lbl),
      memo,
      el("div", { class: "bug-checks" }, el("label", {}, cbShot, "Include screenshot"), el("label", {}, cbDoc, "Include design")),
      el("div", { class: "bug-note" }, "The last 5 minutes of clicks and keystrokes are attached."),
      msg),
    el("div", { class: "bug-foot" },
      reportsHandler ? el("button", { class: "bug-link", title: "All reports and their status", onclick: () => { closeDialog(); reportsHandler(kind); } }, "Reports…") : "",
      el("span", { class: "bug-hint" }, "Ctrl+Enter to submit"), submit, cancel));

  overlay = el("div", { class: "bug-overlay" }, card);
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep app shortcuts (E, F, Delete…) quiet while typing
    if (e.key === "Escape") { e.preventDefault(); closeDialog(); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSubmit(); }
  });
  for (const t of ["keyup", "keypress", "wheel", "contextmenu"]) overlay.addEventListener(t, (e) => e.stopPropagation());
  overlay.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === overlay) memo.focus(); });
  document.body.append(overlay);
  memo.focus();
}

/** Wire the #btnBug button. getContext() -> { doc, appState, screenshot } (any may be missing). */
export function initBugReporter(getContext) {
  install();
  if (typeof getContext === "function") getCtx = getContext;
  const btn = document.getElementById("btnBug");
  if (btn && !btn.__bugWired) {
    btn.__bugWired = true;
    btn.addEventListener("click", () => openDialog("bug"));
  }
  const fbtn = document.getElementById("btnFeature");
  if (fbtn && !fbtn.__bugWired) {
    fbtn.__bugWired = true;
    fbtn.addEventListener("click", () => openDialog("feature"));
  }
  return { open: openDialog, logEvent, getLog, saveReport, setSaveHandler };
}
