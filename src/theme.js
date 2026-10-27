// Theme + small persisted preferences (localStorage "cadmodeler.prefs", a JSON object).
// Themes: "light" (default) and "dark". The theme is applied to <html data-theme="..."> as
// soon as this module is evaluated, so CSS is correct before main.js builds the UI.
const KEY = "cadmodeler.prefs";

function readPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

export function getPref(key, fallback) {
  const v = readPrefs()[key];
  return v === undefined ? fallback : v;
}

export function setPref(key, value) {
  try {
    const p = readPrefs();
    if (value === undefined || value === null) delete p[key]; else p[key] = value;
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch (e) { /* storage unavailable: ignore */ }
}

const norm = (n) => (n === "dark" ? "dark" : "light");
let current = norm(getPref("theme", "light"));
const subs = new Set();
if (typeof document !== "undefined") document.documentElement.dataset.theme = current;

export function getTheme() { return current; }

/** Apply "light" | "dark", persist it, and notify subscribers if it changed. */
export function applyTheme(name) {
  const next = norm(name);
  const changed = next !== current;
  current = next;
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next;
  setPref("theme", next);
  if (changed) for (const cb of [...subs]) { try { cb(next); } catch (e) { console.error(e); } }
  return next;
}

export function toggleTheme() { return applyTheme(current === "dark" ? "light" : "dark"); }

/** Subscribe to theme changes; cb(name). Returns an unsubscribe function. */
export function onThemeChange(cb) { subs.add(cb); return () => subs.delete(cb); }
