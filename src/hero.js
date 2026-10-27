// Hero loading screen + start page. A wing slides left to right through three sections of the screen:
// in the first it is a sketch (airfoil ribs on a blueprint grid), in the second a shaded solid, in the
// third an aero study (pressure colours plus moving streamlines).
// Loaded as its own module ahead of main.js, so it animates while the kernel loads. Once the app is
// ready, main.js calls heroReady(): the launcher underneath (continue, new design / assembly, open,
// import, workspaces, recent designs) becomes clickable. closeHero() fades it out and stops the loop;
// showHero() brings it back (File > Start Page).
import "./hero.css";
import { icons } from "./icons.js";
import { update as platformUpdate, isDesktop } from "./platform.js";

let hero = null;

const TILES = {
  newDesign: ["Design", "Part modelling", "design"],
  newAssembly: ["Assembly", "Components and joints", "newComponent"],
  open: ["Open…", "A saved design file", "file"],
  import: ["Import CAD…", "STEP, STL, OBJ", "insert"],
  assembly: ["Assembly", "Joints and motion", "component"],
  simulation: ["Simulation", "Stress, CFD, thermal…", "stress"],
  cam: ["CAM", "Toolpaths", "camSetup", true],
  drawing: ["Drawing", "2D drawings", "file", true],
};
const COLS = [["New", ["newDesign", "newAssembly"]], ["Open", ["open", "import"]], ["Workspaces", ["assembly", "simulation", "cam", "drawing"]]];

// start right away (main.js imports this module too, so a failure here must never stop the app)
const host0 = document.getElementById("loading");
if (host0) { try { hero = startHero(host0); } catch (e) { console.error("start page:", e); hero = null; } }

/**
 * The app is ready: enable the launcher. ctx: { continueName (null = no Continue button), recent: [{ name, index, active }],
 * showAtStart, onAction(action, arg), onShowAtStart(bool) }. Under-construction tiles (CAM, Drawing)
 * are taped; CAM still opens its (placeholder) workspace, Drawing does nothing yet.
 */
export function heroReady(ctx) {
  if (!hero) return;
  const { launch } = hero;
  launch.classList.remove("loading");
  launch.querySelector(".hero-msg").textContent = "Ready";
  const cont = launch.querySelector(".hl-continue");
  // continueName null: nothing worth continuing (empty designs), so no Continue button (Esc still closes)
  cont.style.display = ctx.continueName == null ? "none" : "";
  cont.querySelector(".hl-cname").textContent = ctx.continueName || "Untitled";
  cont.onclick = () => ctx.onAction("continue");
  for (const b of launch.querySelectorAll(".hl-tile")) b.onclick = () => ctx.onAction(b.dataset.act);
  const chips = launch.querySelector(".hl-chips");
  chips.innerHTML = "";
  for (const r of ctx.recent || []) {
    const c = document.createElement("button");
    c.className = `hl-chip${r.active ? " active" : ""}`;
    c.innerHTML = `<i>${icons.body}</i><span></span>`;
    c.querySelector("span").textContent = r.name;
    c.title = r.active ? `${r.name} (current design)` : `Switch to ${r.name}`;
    c.onclick = () => ctx.onAction("recent", r.index);
    chips.append(c);
  }
  launch.querySelector(".hl-recent").style.display = (ctx.recent || []).length ? "" : "none";
  const chk = launch.querySelector(".hl-show input");
  chk.checked = ctx.showAtStart !== false;
  chk.onchange = () => ctx.onShowAtStart && ctx.onShowAtStart(chk.checked);
  hero.ctx = ctx;
}
export function closeHero() {
  if (!hero || hero.host.classList.contains("closed")) return;
  const { host } = hero;
  host.classList.add("done");
  setTimeout(() => { if (host.classList.contains("done")) { host.classList.add("closed"); hero.stop(); } }, 450);
}
export function showHero(ctx) {
  if (!hero) return;
  hero.host.classList.remove("closed");
  void hero.host.offsetWidth; // restart the fade
  hero.host.classList.remove("done");
  hero.start();
  if (ctx) heroReady(ctx);
}
export const heroOpen = () => !!hero && hero.host.isConnected && !hero.host.classList.contains("done") && !hero.host.classList.contains("closed");

function startHero(host) {
  host.classList.add("hero");
  host.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "hero-canvas";
  const over = document.createElement("div");
  over.className = "hero-over";
  const tile = (act) => { const [name, sub, icon, uc] = TILES[act]; return `<button class="hl-tile${uc ? " uc" : ""}" data-act="${act}" title="${uc ? `${name} — under construction` : name}"><i>${icons[icon] || ""}</i><span class="hl-tn">${name}</span><span class="hl-ts">${sub}</span></button>`; };
  over.innerHTML = `
    <div class="hero-title"><div class="hero-name">CAD Modeler</div><div class="hero-tag">Sketch &nbsp;·&nbsp; Model &nbsp;·&nbsp; Simulate</div></div>
    <div class="hero-upd" role="status" aria-live="polite" hidden></div>
    <div class="hero-launch loading">
      <div class="hero-status"><div class="hero-bar"><i></i></div><div class="hero-msg">Loading geometry kernel…</div></div>
      <div class="hl-panel">
        <button class="hl-continue"><span class="hl-ck">Continue</span><span class="hl-cname">…</span><span class="hl-arrow">→</span></button>
        <div class="hl-cols">${COLS.map(([hd, acts]) => `<div class="hl-col"><div class="hl-hd">${hd}</div><div class="hl-tiles">${acts.map(tile).join("")}</div></div>`).join("")}</div>
        <div class="hl-foot"><div class="hl-recent"><span class="hl-hd">Recent</span><div class="hl-chips"></div></div><label class="hl-show"><input type="checkbox" checked> Show at startup</label></div>
      </div>
    </div>`;
  host.append(canvas, over);
  const launch = over.querySelector(".hero-launch");
  startUpdatePill(over.querySelector(".hero-upd"));
  let running = true;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- airfoil: NACA 2412, cosine spacing, points LE -> TE ----
  const N = 36, M = 0.02, P = 0.4, T = 0.12;
  const upper = [], lower = [];
  for (let i = 0; i <= N; i++) {
    const x = (1 - Math.cos((Math.PI * i) / N)) / 2;
    const yt = 5 * T * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = x < P ? (M / (P * P)) * (2 * P * x - x * x) : (M / ((1 - P) ** 2)) * (1 - 2 * P + 2 * P * x - x * x);
    upper.push([x, yc + yt]); lower.push([x, yc - yt]);
  }
  const zUpper = (u) => { // upper surface height at chord fraction u (0..1)
    if (u <= 0) return upper[0][1];
    for (let i = 1; i <= N; i++) if (upper[i][0] >= u) { const [x0, z0] = upper[i - 1], [x1, z1] = upper[i]; return z0 + ((z1 - z0) * (u - x0)) / (x1 - x0 || 1); }
    return upper[N][1];
  };

  // ---- geometry in px: chord along screen x (flow left to right), z up, span receding up-right ----
  // 3D coordinates are [S (span), c (chord), z (thickness)]
  let W = 0, H = 0, dpr = 1, span = 0, cr = 0, y0 = 0;
  const SX = 0.55, SY = -0.3; // span direction on screen
  const D = [-1, SX, -SY]; // toward the viewer (root side, above, slightly aft): depth sorting and culling
  const L = norm([-0.45, -0.5, 0.75]); // light from the root side, ahead and above
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = host.clientWidth; H = host.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    span = Math.min(W * 0.42, 720);
    cr = Math.min(W * 0.2, 340, H * 0.42);
    y0 = H * 0.4 - span * SY * 0.5;
  }
  const chordAt = (s) => cr * (1 - 0.45 * s);
  const leAt = (s) => cr * 0.16 * s; // sweep
  // 3D point: s = span fraction, u = chord fraction, surf = upper/lower table value -> [S, c, z]
  const pt = (s, u, zc) => { const ch = chordAt(s); return [s * span, leAt(s) + u * ch, zc * ch + s * span * 0.035]; };
  const proj = (x0, p) => [x0 + p[1] + p[0] * SX, y0 - p[2] + p[0] * SY];

  // quads of the outer surface (upper + lower) and the root cap, built once per frame position
  const SEG = 22;
  function surfaceQuads() {
    const quads = [];
    for (const [tab, isUpper] of [[upper, true], [lower, false]]) {
      for (let j = 0; j < SEG; j++) {
        const s0 = j / SEG, s1 = (j + 1) / SEG;
        for (let i = 0; i < N; i++) {
          const a = pt(s0, tab[i][0], tab[i][1]), b = pt(s0, tab[i + 1][0], tab[i + 1][1]), c = pt(s1, tab[i + 1][0], tab[i + 1][1]), d = pt(s1, tab[i][0], tab[i][1]);
          const ctr = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
          let n = cross(sub(b, a), sub(d, a));
          const sm = (s0 + s1) / 2, axis = pt(sm, 0.35, 0.02);
          if (dot(n, sub(ctr, axis)) < 0) n = n.map((v) => -v);
          n = norm(n);
          if (dot(n, D) <= 0) continue; // faces away
          quads.push({ pts: [a, b, c, d], n, depth: dot(ctr, D), u: (tab[i][0] + tab[i + 1][0]) / 2, upper: isUpper });
        }
      }
    }
    // root cap (s = 0) faces the viewer in this projection
    const cap = [...upper.map(([x, z]) => pt(0, x, z)), ...lower.slice().reverse().map(([x, z]) => pt(0, x, z))];
    quads.push({ pts: cap, n: [-1, 0, 0], depth: dot(pt(0, 0.4, 0), D) + 1, cap: true });
    quads.sort((p, q) => p.depth - q.depth);
    return quads;
  }
  let QUADS = null;

  // ---- colours ----
  const jet = (t) => { // 0 blue -> cyan -> green -> yellow -> red
    t = Math.max(0, Math.min(1, t));
    const stops = [[40, 80, 220], [30, 190, 230], [60, 200, 90], [245, 215, 50], [230, 60, 45]];
    const f = t * 4, i = Math.min(3, Math.floor(f)), k = f - i;
    return stops[i].map((v, j) => v + (stops[i + 1][j] - v) * k);
  };
  const cpColor = (q) => { // stagnation red at the leading edge, suction blue on top, mild on the bottom
    if (q.cap) return [140, 150, 165];
    const u = q.u;
    if (q.upper) return jet(u < 0.03 ? 1 - (u / 0.03) * 0.95 : 0.06 + 0.5 * u);
    return jet(u < 0.06 ? 1 - (u / 0.06) * 0.35 : 0.62 - 0.08 * u);
  };
  const rgb = (c, k = 1) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

  // ---- drawing per section ----
  function drawSketch(x0, zone) {
    // blueprint grid
    ctx.fillStyle = "rgba(40,110,190,0.10)"; ctx.fillRect(zone[0], 0, zone[1] - zone[0], H);
    ctx.lineWidth = 1;
    for (let gx = Math.floor(zone[0] / 24) * 24; gx < zone[1]; gx += 24) { ctx.strokeStyle = gx % 120 === 0 ? "rgba(110,170,255,0.16)" : "rgba(110,170,255,0.07)"; line(gx, 0, gx, H); }
    for (let gy = 0; gy < H; gy += 24) { ctx.strokeStyle = gy % 120 === 0 ? "rgba(110,170,255,0.16)" : "rgba(110,170,255,0.07)"; line(zone[0], gy, zone[1], gy); }
    const P2 = (p) => proj(x0, p);
    ctx.lineJoin = ctx.lineCap = "round";
    // spanwise leading and trailing edges
    ctx.strokeStyle = "#7fbcff"; ctx.lineWidth = 1.6;
    path([0, 1].map((s) => P2(pt(s, 0, upper[0][1])))); ctx.stroke();
    path([0, 1].map((s) => P2(pt(s, 1, upper[N][1])))); ctx.stroke();
    // ribs
    for (const s of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      ctx.strokeStyle = "#9fd0ff"; ctx.lineWidth = s === 0 ? 2 : 1.4;
      path([...upper.map(([x, z]) => P2(pt(s, x, z))), ...lower.slice().reverse().map(([x, z]) => P2(pt(s, x, z)))]); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(255,170,60,0.85)"; ctx.lineWidth = 1;
      path([P2(pt(s, 0, 0)), P2(pt(s, 1, 0))]); ctx.stroke(); ctx.setLineDash([]);
      for (const u of [0, 1]) { const [x, y] = P2(pt(s, u, u ? upper[N][1] : upper[0][1])); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1c3a5e"; ctx.fillRect(x - 2.5, y - 2.5, 5, 5); ctx.strokeRect(x - 2.5, y - 2.5, 5, 5); }
    }
    // root chord dimension
    const a = P2(pt(0, 0, -0.16)), b = P2(pt(0, 1, -0.16));
    ctx.strokeStyle = "rgba(200,230,255,0.75)"; ctx.lineWidth = 1; path([a, b]); ctx.stroke();
    ctx.fillStyle = "rgba(200,230,255,0.9)"; ctx.font = "600 11px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.save(); ctx.translate((a[0] + b[0]) / 2 - 8, (a[1] + b[1]) / 2 + 14); ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0])); ctx.fillText("NACA 2412", 0, 0); ctx.restore();
  }
  function drawSolid(x0, sim) {
    for (const q of QUADS) {
      const lam = Math.max(0, dot(q.n, L));
      const base = sim ? cpColor(q) : q.cap ? [150, 162, 178] : [178, 192, 208];
      const k = sim ? 0.6 + 0.45 * lam : 0.3 + 0.85 * lam;
      ctx.fillStyle = rgb(base, Math.min(k, 1.15));
      path(q.pts.map((p) => proj(x0, p))); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke(); // hide seams
    }
    // outline edges
    const P2 = (p) => proj(x0, p);
    ctx.strokeStyle = sim ? "rgba(10,20,35,0.55)" : "rgba(20,32,48,0.85)"; ctx.lineWidth = 1.2;
    path([...upper.map(([x, z]) => P2(pt(0, x, z))), ...lower.slice().reverse().map(([x, z]) => P2(pt(0, x, z)))]); ctx.closePath(); ctx.stroke();
    path([...upper.map(([x, z]) => P2(pt(1, x, z)))]); ctx.stroke();
    path([0, 1].map((s) => P2(pt(s, 1, upper[N][1])))); ctx.stroke();
  }
  function drawStreamlines(x0, t) {
    const P2 = (p) => proj(x0, p);
    for (let k = 0; k < 12; k++) {
      const s = (k + 0.5) / 12;
      for (const layer of [0, 1]) {
        const h0 = 0.035 + layer * 0.075;
        const pts = [];
        for (let u = -0.75; u <= 1.9; u += 0.025) {
          let zc;
          // continuous through the leading and trailing edges: rises ahead of the wing (upwash), hugs
          // the upper surface, then drops behind it (downwash)
          if (u < 0) zc = zUpper(0) + h0 - (0.07 - layer * 0.02) * (1 - Math.exp(3 * u));
          else if (u <= 1) zc = zUpper(u) + h0 * (1 - 0.25 * Math.sin(Math.PI * u)) + (layer ? 0.02 * Math.sin(Math.PI * u) : 0);
          else zc = zUpper(1) + h0 - 0.06 * (u - 1);
          pts.push(P2(pt(s, u, zc)));
        }
        ctx.strokeStyle = "rgba(220,240,255,0.22)"; ctx.lineWidth = 1; path(pts); ctx.stroke();
        ctx.setLineDash([24, 12]); ctx.lineDashOffset = -(t * 0.12 + k * 9 + layer * 13);
        ctx.strokeStyle = layer ? "rgba(160,225,255,0.75)" : "rgba(235,248,255,0.95)"; ctx.lineWidth = layer ? 1.3 : 1.7;
        path(pts); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  // ---- frame ----
  const LABELS = ["01  SKETCH", "02  MODEL", "03  SIMULATE"];
  const period = 6500, t0 = performance.now();
  function frame(now) {
    if (!canvas.isConnected || !running) return;
    const t = reduce ? 1800 : now - t0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b1119"); bg.addColorStop(1, "#16212e");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    // wing position: enters at the left, leaves at the right
    const width = cr * 1.2 + span * SX, travel = W + width;
    // window.__heroFreeze = 0..1 pins the wing at that point of its pass (debugging / screenshots)
    const f = typeof window.__heroFreeze === "number" ? window.__heroFreeze : reduce ? 0.55 : ((t % period) / period);
    const x0 = -width + f * travel;
    QUADS = surfaceQuads();
    const zones = [[0, W / 3], [W / 3, (2 * W) / 3], [(2 * W) / 3, W]];
    zones.forEach((z, i) => {
      ctx.save(); ctx.beginPath(); ctx.rect(z[0], 0, z[1] - z[0], H); ctx.clip();
      if (i === 0) drawSketch(x0, z);
      else drawSolid(x0, i === 2);
      if (i === 2) drawStreamlines(x0, t);
      ctx.restore();
    });
    // section dividers and labels
    for (let i = 1; i < 3; i++) {
      const x = (i * W) / 3, g = ctx.createLinearGradient(0, H * 0.14, 0, H * 0.62);
      g.addColorStop(0, "rgba(120,180,255,0)"); g.addColorStop(0.5, "rgba(120,180,255,0.55)"); g.addColorStop(1, "rgba(120,180,255,0)");
      ctx.strokeStyle = g; ctx.lineWidth = 1; line(x, H * 0.14, x, H * 0.62);
    }
    ctx.font = "700 11px Segoe UI, sans-serif"; ctx.textAlign = "center";
    zones.forEach((z, i) => { ctx.fillStyle = "rgba(170,200,235,0.75)"; ctx.fillText(LABELS[i].split("").join(String.fromCharCode(8202)), (z[0] + z[1]) / 2, H * 0.6); });
    if (!reduce) requestAnimationFrame(frame);
  }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function path(pts) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); }
  resize();
  window.addEventListener("resize", () => { if (canvas.isConnected) { resize(); if (reduce) frame(performance.now()); } });
  requestAnimationFrame(frame);
  return {
    host, launch,
    start() { if (running) return; running = true; resize(); requestAnimationFrame(frame); },
    stop() { running = false; },
  };
}

// ---- update pill (under the title, while loading and on the start page) ----
// platform.update.check() runs a git fetch in the Electron main process (electron/update-check.cjs), so it
// never delays loading. States: checking / available / confirm / installing / failed / current / offline;
// unavailable (browser, not a git clone, no git) shows nothing. Debug: window.__updateState = {state, ...}
// before load fakes the answer; window.__heroUpdate(state) re-renders with any state.
function startUpdatePill(el) {
  if (!el) return;
  let dismissed = false, last = null;
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const x = `<button class="hu-x" title="Dismiss" aria-label="Dismiss">×</button>`;
  function render(st) {
    last = st;
    const s = st && st.state;
    if (dismissed || !s || s === "unavailable") { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.className = `hero-upd hu-${s}`;
    if (s === "checking") el.innerHTML = `<i class="hu-dot"></i><span class="hu-t">Checking for updates…</span>`;
    else if (s === "current") el.innerHTML = `<i class="hu-ic">✓</i><span class="hu-t">Up to date</span>${x}`;
    else if (s === "offline") el.innerHTML = `<span class="hu-t">Couldn't check for updates (offline)</span>${x}`;
    else if (s === "available") {
      const n = Math.max(1, st.behind | 0);
      const when = st.date && !isNaN(Date.parse(st.date)) ? new Date(st.date).toLocaleString() : "";
      el.innerHTML = `<i class="hu-dot"></i><span class="hu-t"><b>Update available:</b> ${n} new change${n === 1 ? "" : "s"}${st.subject ? ` <span class="hu-sub">— ${esc(st.subject)}</span>` : ""}</span><button class="hu-btn">Update now</button>${x}`;
      el.querySelector(".hu-t").title = [st.subject, when && `Latest change: ${when}`].filter(Boolean).join(String.fromCharCode(10));
      el.querySelector(".hu-btn").onclick = () => render({ ...st, state: "confirm" });
    } else if (s === "confirm") {
      el.innerHTML = `<span class="hu-t">Close CAD Modeler and update? You'll be asked to save open designs first.</span><button class="hu-btn">Close and update</button><button class="hu-btn hu-sec">Cancel</button>`;
      const [go, cancel] = el.querySelectorAll(".hu-btn");
      cancel.onclick = () => render({ ...st, state: "available" });
      go.onclick = async () => {
        render({ ...st, state: "installing" });
        const ok = await platformUpdate.install();
        // still open after a while: the save prompt was cancelled (or the updater couldn't start)
        if (!ok) render({ ...st, state: "failed" });
        else setTimeout(() => { if (last && last.state === "installing") render({ ...st, state: "available" }); }, 4000);
      };
    } else if (s === "installing") el.innerHTML = `<i class="hu-dot"></i><span class="hu-t">Closing CAD Modeler to update…</span>`;
    else if (s === "failed") el.innerHTML = `<span class="hu-t">Couldn't start the updater. Close the app and run <b>Update CAD Modeler.bat</b>.</span>${x}`;
    const xb = el.querySelector(".hu-x");
    if (xb) xb.onclick = () => { dismissed = true; render(last); };
  }
  window.__heroUpdate = (st) => { dismissed = false; render(st); };
  const fake = window.__updateState;
  if (!fake && !isDesktop) return; // browser / dev server: nothing to check
  render({ state: "checking" });
  (fake ? Promise.resolve(fake) : platformUpdate.check()).then((st) => { if (last && last.state === "checking") render(st); }, () => render({ state: "unavailable" }));
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
