// Display units (feature request 2026-10-09 "i should be able to change units"). DOM-free.
// The model is always millimetres; these helpers convert only where a length is shown or typed.
// The active unit comes from a source function (main.js: the design's doc.units, else the
// "units" preference), so switching tabs needs no syncing.

export const UNITS = {
  mm: { label: "mm", name: "Millimetre", plural: "Millimetres", f: 1, d: 3 },
  cm: { label: "cm", name: "Centimetre", plural: "Centimetres", f: 10, d: 4 },
  m: { label: "m", name: "Metre", plural: "Metres", f: 1000, d: 5 },
  in: { label: "in", name: "Inch", plural: "Inches", f: 25.4, d: 4 },
  ft: { label: "ft", name: "Foot", plural: "Feet", f: 304.8, d: 5 },
};
// suffixes a typed value may carry, mapped to a unit
const SUFFIX = { mm: "mm", cm: "cm", m: "m", in: "in", inch: "in", '"': "in", ft: "ft", "'": "ft" };

let source = () => "mm";
export function setUnitSource(fn) { source = fn; }
export function units() { const u = source(); return UNITS[u] ? u : "mm"; }
export const unitLabel = (u = units()) => UNITS[u].label;
/** mm → number in display units */
export const toDisp = (mm, u = units()) => mm / UNITS[u].f;
/** number in display units → mm */
export const fromDisp = (x, u = units()) => x * UNITS[u].f;
/** mm → display string (no suffix), trimmed to the unit's precision */
export function fmtLen(mm, d, u = units()) {
  if (mm == null || !isFinite(mm)) return "";
  return String(+toDisp(+mm, u).toFixed(d ?? UNITS[u].d));
}

// math functions a typed value may use (feature request 2026-10-20 "basic math functions");
// trig works in degrees, like Fusion
const RAD = Math.PI / 180;
export const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: (a) => Math.sin(a * RAD), cos: (a) => Math.cos(a * RAD), tan: (a) => Math.tan(a * RAD),
  asin: (x) => Math.asin(x) / RAD, acos: (x) => Math.acos(x) / RAD, atan: (x) => Math.atan(x) / RAD,
  atan2: (y, x) => Math.atan2(y, x) / RAD, exp: Math.exp, ln: Math.log, log: Math.log10,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
};
const CONSTS = { pi: Math.PI, e: Math.E };

/** Identifiers in a typed expression that aren't functions or constants (parameter / dimension names). */
export function exprNames(text) {
  const out = new Set();
  const s = String(text || "").toLowerCase().replace(/(?<![a-z0-9_.])\d*\.?\d+(e[+-]?\d+)?\s*(mm|cm|inch|in|ft|m(?![a-z]))?/g, " ");
  for (const m of s.matchAll(/[a-z_][a-z0-9_]*/g)) if (!FUNCS[m[0]] && !(m[0] in CONSTS)) out.add(m[0]);
  return [...out];
}

/**
 * Typed length → mm, or NaN. A bare number is in the display unit; numbers may carry their own
 * unit ("1in", "25.4 mm", '2"', "3ft"); + − × ÷ ^ and brackets work ("1in + 3mm", "100/3");
 * so do functions ("sqrt(2)*10", "cos(30)") and the constants pi / e.
 * `vars` maps names (lower case) to values in mm (lengths) or plain numbers (angles: pass unit "mm"),
 * so a dimension can reference another ("d1 / 2"). Everything is evaluated in display units.
 */
export function parseLength(text, u = units(), vars = null) {
  if (typeof text === "number") return fromDisp(text, u);
  const s0 = String(text || "").trim().toLowerCase().replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^");
  // a comma is a decimal point ("1,5"), unless the text calls a function ("max(3,4)")
  const s = /[a-z_]\w*\s*\(/.test(s0) ? s0 : s0.replace(/(\d),(\d)/g, "$1.$2");
  if (!s) return NaN;
  const f = UNITS[u].f;
  const toks = [];
  const re = /\s*(?:(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|inch|in|ft|m(?![a-z])|"|')?|([a-z_][a-z0-9_]*)|([-+*/()^,]))/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m || m[0] === "") { if (/^\s+$/.test(s.slice(i))) break; return NaN; }
    i = re.lastIndex;
    if (m[1] != null) toks.push(m[2] ? (+m[1] * UNITS[SUFFIX[m[2]]].f) / f : +m[1]);
    else if (m[3] != null) {
      const id = m[3];
      if (FUNCS[id]) toks.push({ fn: id });
      else if (id in CONSTS) toks.push(CONSTS[id]);
      else if (vars && id in vars && isFinite(vars[id])) toks.push(vars[id] / f);
      else return NaN;
    } else toks.push(m[4]);
  }
  // expr = term (± term)*, term = power (*/ power)*, power = unary (^ power)?, unary = ±unary | atom
  let p = 0;
  const atom = () => {
    const t = toks[p++];
    if (typeof t === "number") return t;
    if (t && t.fn) {
      if (toks[p++] !== "(") return NaN;
      const args = [expr()];
      while (toks[p] === ",") { p++; args.push(expr()); }
      if (toks[p++] !== ")") return NaN;
      return FUNCS[t.fn](...args);
    }
    if (t === "(") { const v = expr(); if (toks[p++] !== ")") return NaN; return v; }
    return NaN;
  };
  const unary = () => { if (toks[p] === "-") { p++; return -unary(); } if (toks[p] === "+") { p++; return unary(); } return power(); };
  const power = () => { const b = atom(); if (toks[p] === "^") { p++; return Math.pow(b, unary()); } return b; };
  const term = () => { let v = unary(); while (toks[p] === "*" || toks[p] === "/") { const op = toks[p++], w = unary(); v = op === "*" ? v * w : v / w; } return v; };
  const expr = () => { let v = term(); while (toks[p] === "+" || toks[p] === "-") { const op = toks[p++], w = term(); v = op === "+" ? v + w : v - w; } return v; };
  const v = expr();
  return p === toks.length && isFinite(v) ? v * f : NaN;
}
/** A plain typed number (angles, counts); arithmetic works ("90/4"). */
export const parseNumber = (text, vars = null) => parseLength(text, "mm", vars);
/** Sketch dimension text: fixed decimals per unit ("25.00 mm", "0.984 in"). */
const DIM_DECIMALS = { mm: 2, cm: 3, m: 4, in: 3, ft: 4 };
export function fmtDim(mm, withUnit = true, u = units()) {
  const t = toDisp(mm, u).toFixed(DIM_DECIMALS[u]);
  return withUnit ? `${t} ${UNITS[u].label}` : t;
}
