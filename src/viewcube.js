// Fusion-style ViewCube: clickable faces / edges / corners, drag to orbit, home button,
// right-click context menu (home, projection mode, isometric, custom home). Theme-aware.
import * as THREE from "three";
import { getTheme, onThemeChange } from "./theme.js";

const FACES = [
  // three.js BoxGeometry material order: +x, -x, +y, -y, +z, -z  (Z is up)
  { label: "RIGHT", n: [1, 0, 0] }, { label: "LEFT", n: [-1, 0, 0] },
  { label: "BACK", n: [0, 1, 0] }, { label: "FRONT", n: [0, -1, 0] },
  { label: "TOP", n: [0, 0, 1] }, { label: "BOTTOM", n: [0, 0, -1] },
];

const PALETTE = {
  light: { face: "#eef1f4", hot: "#8fc8ef", border: "#9aa6b2", text: "#4a5866", hotText: "#4a5866", edges: 0x7d8995 },
  dark: { face: "#5b6169", hot: "#2f86c0", border: "#8a949e", text: "#e6e6e6", hotText: "#ffffff", edges: 0xaab4be },
};

/** Screen-right / screen-up a viewer has when looking head-on at a face with outward normal n
 *  (Z up for the side faces; for TOP/BOTTOM, +Y up so FRONT is at the bottom of the screen). */
export function desiredFaceAxes(n) {
  const N = new THREE.Vector3(...n);
  const up = Math.abs(N.z) > 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const right = N.clone().negate().cross(up); // forward x up
  return { right, up };
}

/** World directions of texture +u and +v on material group `index` of a (non-indexed-by-face) geometry. */
export function faceUVAxes(geometry, index) {
  const grp = geometry.groups.find((g) => g.materialIndex === index);
  const idx = geometry.index, pos = geometry.attributes.position, uv = geometry.attributes.uv;
  const vi = [0, 1, 2].map((k) => (idx ? idx.getX(grp.start + k) : grp.start + k));
  const P = vi.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  const T = vi.map((i) => new THREE.Vector2().fromBufferAttribute(uv, i));
  const e1 = P[1].clone().sub(P[0]), e2 = P[2].clone().sub(P[0]);
  const d1 = T[1].clone().sub(T[0]), d2 = T[2].clone().sub(T[0]);
  const r = 1 / (d1.x * d2.y - d2.x * d1.y);
  const U = e1.clone().multiplyScalar(d2.y).addScaledVector(e2, -d1.y).multiplyScalar(r).normalize();
  const V = e2.clone().multiplyScalar(d1.x).addScaledVector(e1, -d2.x).multiplyScalar(r).normalize();
  return { U, V };
}

/** Canvas rotation (radians, clockwise on the canvas) that makes the label read upright on face `index`. */
export function labelRotation(geometry, index) {
  const { U, V } = faceUVAxes(geometry, index);
  const { right } = desiredFaceAxes(FACES[index].n);
  // canvas: x right, y down; image up == +v (CanvasTexture.flipY). Text right after rotate(phi) is (cos, sin) in canvas.
  return Math.atan2(-right.dot(V), right.dot(U));
}

function faceTexture(label, hot, pal, rot) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = hot ? pal.hot : pal.face; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = pal.border; g.lineWidth = 4; g.strokeRect(2, 2, 124, 124);
  g.save();
  g.translate(64, 64); g.rotate(rot);
  g.fillStyle = hot ? pal.hotText : pal.text; g.font = "600 22px Segoe UI, Arial"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(label, 0, 2);
  g.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// hit zones: a click within the outer EDGE_FRAC of a face (as a fraction of its half-width) picks the
// edge or corner there; the highlight box below covers exactly that zone
const EDGE_FRAC = 0.42;
const HALF = 0.75; // half the cube size
const AXIS_NAMES = [["RIGHT", "LEFT"], ["BACK", "FRONT"], ["TOP", "BOTTOM"]];
/** "Top Front Right" for [1,-1,1], "Front" for [0,-1,0]. */
export function viewName(d) {
  const parts = [2, 1, 0].filter((i) => d[i]).map((i) => AXIS_NAMES[i][d[i] > 0 ? 0 : 1]);
  return parts.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}
/** Every preset direction: 6 faces, 12 edges, 8 corners. */
export const PRESET_DIRS = (() => {
  const out = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) out.push([x, y, z]);
  return out;
})();

// order in the right-click flyout: top corners, bottom corners, faces, then edges
const PRESET_MENU = [
  [1, -1, 1], [-1, -1, 1], [1, 1, 1], [-1, 1, 1], "|",
  [1, -1, -1], [-1, -1, -1], [1, 1, -1], [-1, 1, -1], "|",
  [0, 0, 1], [0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, -1], "|",
  [0, -1, 1], [1, 0, 1], [0, 1, 1], [-1, 0, 1], "|",
  [1, -1, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 0], "|",
  [0, -1, -1], [1, 0, -1], [0, 1, -1], [-1, 0, -1],
];

const MODES = [
  ["orthographic", "Orthographic"],
  ["perspective", "Perspective"],
  ["perspOrtho", "Perspective with Ortho Faces"],
];

export class ViewCube {
  constructor(el, viewport) {
    this.vp = viewport;
    this.el = el;
    this.canvas = el.querySelector("canvas");
    this.size = 110;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.size, this.size, false);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    const geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    this.rot = FACES.map((f, i) => labelRotation(geo, i));
    this.mats = FACES.map(() => new THREE.MeshBasicMaterial());
    this.cube = new THREE.Mesh(geo, this.mats);
    this.scene.add(this.cube);
    this.edgeMat = new THREE.LineBasicMaterial({ color: PALETTE.light.edges });
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), this.edgeMat));
    // axis triad at the front-left-bottom corner
    const o = new THREE.Vector3(-0.75, -0.75, -0.75);
    for (const [d, col] of [[[1, 0, 0], 0xd0453a], [[0, 1, 0], 0x4aa04a], [[0, 0, 1], 0x3a6fd0]]) {
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().add(new THREE.Vector3(...d).multiplyScalar(1.9))]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, linewidth: 2 })));
    }
    // hover highlight: a thin translucent box hugging the hovered face centre / edge strip / corner
    this.hiMat = new THREE.MeshBasicMaterial({ color: 0x3a9be0, transparent: true, opacity: 0.55, depthWrite: false });
    this.hiMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.hiMat);
    this.hiMesh.visible = false;
    this.scene.add(this.hiMesh);
    this.hot = -1;
    this.hotKey = "";
    this.menu = null;
    this.raycaster = new THREE.Raycaster();
    this.setTheme(getTheme() === "dark");
    onThemeChange((t) => this.setTheme(t === "dark"));
    this.bind();
    viewport.onFrame(() => this.render());
    this.render();
  }

  /** Rebuild the face textures for the dark (true) or light (false) palette. */
  setTheme(dark) {
    const pal = PALETTE[dark ? "dark" : "light"];
    for (const t of [...(this.normalTex || []), ...(this.hotTex || [])]) t.dispose();
    this.normalTex = FACES.map((f, i) => faceTexture(f.label, false, pal, this.rot[i]));
    this.hotTex = FACES.map((f, i) => faceTexture(f.label, true, pal, this.rot[i]));
    this.mats.forEach((m, i) => { m.map = i === this.hot ? this.hotTex[i] : this.normalTex[i]; m.needsUpdate = true; });
    this.edgeMat.color.setHex(pal.edges);
    this.render();
  }

  render() {
    const { dir, up } = this.vp.basis();
    this.camera.position.copy(dir).multiplyScalar(6);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  hitDir(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const h = this.raycaster.intersectObject(this.cube)[0];
    if (!h) return null;
    // classify the hit into face / edge / corner from the local hit point
    const p = h.point.clone().divideScalar(HALF);
    const lim = 1 - EDGE_FRAC;
    const d = [p.x, p.y, p.z].map((v) => (v > lim ? 1 : v < -lim ? -1 : 0));
    return { dir: d, face: h.face.materialIndex };
  }

  /** Highlight the zone for direction d (null = none). */
  setHotDir(d) {
    const key = d ? d.join() : "";
    if (key === this.hotKey) return;
    this.hotKey = key;
    this.hiMesh.visible = !!d;
    if (d) {
      // per axis: the outer band for a nonzero component, the middle band otherwise, puffed out a hair
      const inner = HALF * (1 - EDGE_FRAC), out = HALF + 0.03;
      const lo = [], hi = [];
      for (const v of d) { if (v > 0) { lo.push(inner); hi.push(out); } else if (v < 0) { lo.push(-out); hi.push(-inner); } else { lo.push(-inner); hi.push(inner); } }
      this.hiMesh.scale.set(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      this.hiMesh.position.set((hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2);
      this.canvas.title = `${viewName(d)} view`;
    } else this.canvas.title = "";
    this.render();
  }

  bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener("pointermove", (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.moved) { this.vp.anim = null; this.vp.orbit(dx, dy); }
        return;
      }
      const h = this.hitDir(e);
      this.setHotDir(h ? h.dir : null);
    });
    c.addEventListener("pointerleave", () => this.setHotDir(null));
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    });
    c.addEventListener("pointerup", (e) => {
      if (e.button !== 0 || !drag) return;
      const wasDrag = drag.moved; drag = null;
      if (wasDrag) return;
      const h = this.hitDir(e);
      if (h) this.vp.setViewDir(h.dir);
    });
    c.addEventListener("pointercancel", () => { drag = null; });
    // our own context menu over the whole cube area (canvas + home button), never the browser's
    this.el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openMenu(e.clientX, e.clientY); });
    this.el.querySelector(".home").addEventListener("click", () => this.vp.home());
  }

  // ---------- context menu ----------
  openMenu(x, y) {
    this.closeMenu();
    const vp = this.vp;
    const items = [
      { label: "Go Home", run: () => vp.home() },
      "|",
      ...MODES.map(([mode, label]) => ({ label, check: vp.cameraMode === mode, run: () => vp.setCameraMode(mode) })),
      "|",
      { label: "Isometric", run: () => vp.isoView() },
      { label: "Preset Views", sub: PRESET_MENU.map((d) => (d === "|" ? d : { label: viewName(d), run: () => vp.setViewDir(d) })) },
      "|",
      { label: "Set Current View as Home", run: () => vp.setHomeView() },
      { label: "Reset Home", disabled: !vp.hasCustomHome(), run: () => vp.resetHome() },
    ];
    const m = document.createElement("div");
    m.className = "menu viewcube-menu";
    for (const it of items) {
      if (it === "|") { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); continue; }
      const row = document.createElement("div");
      row.className = "mi" + (it.disabled ? " disabled" : "");
      const ck = document.createElement("span"); ck.className = "ck"; ck.textContent = it.check ? "✓" : "";
      const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = it.label;
      row.append(ck, lb);
      row.addEventListener("pointerdown", (e) => e.stopPropagation());
      if (it.sub) {
        // a flyout to the side: corners (isometric), faces, then edges
        const arrow = document.createElement("span"); arrow.className = "kb"; arrow.textContent = "›"; row.append(arrow);
        const sub = document.createElement("div");
        sub.className = "menu viewcube-sub";
        for (const si of it.sub) {
          if (si === "|") { const sp = document.createElement("div"); sp.className = "sep"; sub.appendChild(sp); continue; }
          const r2 = document.createElement("div"); r2.className = "mi";
          const l2 = document.createElement("span"); l2.className = "lb"; l2.textContent = si.label; r2.append(l2);
          r2.addEventListener("pointerdown", (e) => e.stopPropagation());
          r2.addEventListener("click", (e) => { e.stopPropagation(); this.closeMenu(); si.run(); vp.requestRender(); });
          sub.appendChild(r2);
        }
        row.addEventListener("pointerenter", () => {
          m.querySelectorAll(".viewcube-sub").forEach((x) => x !== sub && x.remove());
          if (sub.isConnected) return;
          document.body.appendChild(sub);
          const rr = row.getBoundingClientRect(), w = sub.offsetWidth, hh = sub.offsetHeight;
          const left = rr.left - w - 2 >= 4 ? rr.left - w - 2 : Math.min(rr.right + 2, window.innerWidth - w - 4);
          sub.style.left = left + "px";
          sub.style.top = Math.max(4, Math.min(rr.top, window.innerHeight - hh - 4)) + "px";
          this.menu.subs.push(sub);
        });
        m.appendChild(row);
        continue;
      }
      row.addEventListener("pointerenter", () => { if (this.menu) { this.menu.subs.forEach((x) => x.remove()); this.menu.subs = []; } });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (it.disabled) return;
        this.closeMenu();
        it.run();
        vp.requestRender();
      });
      m.appendChild(row);
    }
    m.addEventListener("contextmenu", (e) => e.preventDefault());
    m.style.left = "0px"; m.style.top = "0px"; m.style.visibility = "hidden";
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + "px";
    m.style.visibility = "";
    const onDown = (e) => { if (!m.contains(e.target) && !(this.menu && this.menu.subs.some((x) => x.contains(e.target)))) this.closeMenu(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeMenu(); } };
    const onBlur = () => this.closeMenu();
    // defer so the right-click that opened the menu doesn't immediately close it
    const t = setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    this.menu = { el: m, subs: [], cleanup: () => { clearTimeout(t); document.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); window.removeEventListener("blur", onBlur); } };
  }

  closeMenu() {
    if (!this.menu) return;
    this.menu.cleanup();
    this.menu.subs.forEach((x) => x.remove());
    this.menu.el.remove();
    this.menu = null;
  }
}
