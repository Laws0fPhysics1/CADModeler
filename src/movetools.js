// Shared placement controls for Move/Copy (DEFS.move in main.js) and the assembly component Move
// (assemblyui.js), feature requests 2026-10-21 20:51 / 20:53 ("a dialog on placement to move/rotate the
// part into position", "better movement and rotation controls for the gizmo and the dialog"):
//  - drag snap steps (prefs.moveSnap), Shift = fine while dragging
//  - Rotate 90° buttons per world axis (Shift-click = −90°)
//  - Drop to Ground (lowest point onto Z = 0), Center on Origin (X/Y), Reset
//  - a readout next to the cursor while dragging the gizmo
// Values are the move's { dx, dy, dz, rx, ry, rz } (mm, degrees; rotation = Rz·Ry·Rx about a pivot).
import { getPref, setPref } from "./theme.js";
import { applyGizmoDelta } from "./viewport.js";

export const MOVE_SNAPS = {
  fine: { t: 0.1, r: 1, label: "Fine (0.1 mm, 1°)" },
  normal: { t: 1, r: 15, label: "1 mm, 15°" },
  coarse: { t: 10, r: 45, label: "10 mm, 45°" },
  square: { t: 5, r: 90, label: "5 mm, 90°" },
};
export function moveSnapId() { const id = getPref("moveSnap", "normal"); return MOVE_SNAPS[id] ? id : "normal"; }
/** The drag step: the chosen snap, or fine while Shift is held (Shift used to mean coarse). */
export function snapFor(e) { return e && e.shiftKey ? MOVE_SNAPS.fine : MOVE_SNAPS[moveSnapId()]; }
/** Arrow-key step in a Move number box. */
export function keyStep(unit) { const s = MOVE_SNAPS[moveSnapId()]; return unit === "deg" ? s.r : s.t; }

const KEYS = ["dx", "dy", "dz", "rx", "ry", "rz"];
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

/**
 * Bounds of `points` (flat xyz, world coordinates before the move) after the column-major 4×4 `M`.
 * Large meshes are sampled (every vertex up to 200 k, then a stride), enough for ground / centre.
 */
export function movedBounds(points, M) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const vs of points) {
    const n = vs.length / 3, stride = Math.max(1, Math.floor(n / 200000));
    for (let i = 0; i < n; i += stride) {
      const x = vs[3 * i], y = vs[3 * i + 1], z = vs[3 * i + 2];
      for (let k = 0; k < 3; k++) {
        const w = M[k] * x + M[4 + k] * y + M[8 + k] * z + M[12 + k];
        if (w < lo[k]) lo[k] = w;
        if (w > hi[k]) hi[k] = w;
      }
    }
  }
  return Number.isFinite(lo[0]) ? { min: lo, max: hi } : null;
}

/** Values after turning `deg` about world axis `axis` (0..2), composed like a gizmo ring turn. */
export function turn(v, axis, deg) {
  return applyGizmoDelta(v, { kind: "r", axis, angle: deg }, { t: 0.1, r: 1e-6 });
}

/**
 * The quick-placement block for a Move dialog.
 * opts.get() → values, opts.set(values) applies them (sync inputs, preview, gizmo),
 * opts.bounds(values) → {min, max} of the moved bodies with those values, or null.
 */
export function moveToolsRow(opts) {
  const btn = (label, title, on) => el("button", { class: "btn mv-btn", title, onclick: (e) => { e.preventDefault(); on(e); } }, label);
  const put = (patch) => opts.set({ ...opts.get(), ...patch });
  const rot = [0, 1, 2].map((i) => btn(`${"XYZ"[i]} 90°`, `Turn 90° about the ${"XYZ"[i]} axis (Shift-click: −90°)`, (e) => opts.set(turn(opts.get(), i, e.shiftKey ? -90 : 90))));
  const ground = btn("Drop to Ground", "Move along Z so the lowest point sits on the ground (Z = 0)", () => {
    const v = opts.get(), b = opts.bounds(v);
    if (b) put({ dz: +(v.dz - b.min[2]).toFixed(4) });
  });
  const centre = btn("Center on Origin", "Move in X and Y so the bodies are centred on the origin", () => {
    const v = opts.get(), b = opts.bounds(v);
    if (b) put({ dx: +(v.dx - (b.min[0] + b.max[0]) / 2).toFixed(4), dy: +(v.dy - (b.min[1] + b.max[1]) / 2).toFixed(4) });
  });
  const reset = btn("Reset", "Back to where it started (all distances and angles 0)", () => put(Object.fromEntries(KEYS.map((k) => [k, 0]))));
  const snap = el("select", { title: "Gizmo drag and arrow-key steps (hold Shift while dragging for fine steps)" },
    Object.entries(MOVE_SNAPS).map(([id, s]) => el("option", { value: id }, s.label)));
  snap.value = moveSnapId();
  snap.addEventListener("change", () => setPref("moveSnap", snap.value));
  return el("div", { class: "mv-tools" },
    el("div", { class: "mv-line" }, el("span", { class: "mv-lb" }, "Rotate"), ...rot),
    el("div", { class: "mv-line" }, el("span", { class: "mv-lb" }, "Place"), ground, centre),
    el("div", { class: "mv-line" }, el("span", { class: "mv-lb" }, "Snap"), snap, reset));
}

// ---------- drag readout ----------
let readout = null;
/** Text for the readout: what the drag changed. */
export function readoutText(d, v, snap = MOVE_SNAPS.fine, fmtLen = (x) => `${(+x).toFixed(1)} mm`) {
  if (d.kind === "r") { const a = Math.round(d.angle / snap.r) * snap.r; return `Turn ${"XYZ"[d.axis]} ${+a.toFixed(2)}°`; }
  if (d.axis != null) return `${"XYZ"[d.axis]} ${fmtLen(v["d" + "xyz"[d.axis]])}`;
  return `X ${fmtLen(v.dx)}  Y ${fmtLen(v.dy)}  Z ${fmtLen(v.dz)}`;
}
export function showReadout(e, text) {
  if (!readout) { readout = el("div", { class: "mv-readout" }); document.body.append(readout); }
  readout.textContent = text;
  readout.style.left = `${e.clientX + 18}px`;
  readout.style.top = `${e.clientY + 14}px`;
  readout.style.display = "block";
}
export function hideReadout() { if (readout) readout.style.display = "none"; }
