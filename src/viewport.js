// Three.js viewport: camera + Fusion-style navigation, body/sketch rendering,
// picking, highlights, grid and drag manipulators.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import * as K from "./kernel.js";
import { entityPolyline } from "./sketchgeom.js";
import { getTheme, onThemeChange, getPref, setPref } from "./theme.js";
import { resolveAppearance, appearanceKey } from "./materials.js";

export const COLORS = {
  body: 0xc9ced4, edge: 0x1b1b1b,
  hover: 0x5db4ec, select: 0x0696d7,
  profile: 0xffa53d, profileHover: 0xff6f00, // saturated: pale fills vanished on light-grey parts (bug report 2026-10-18 19:18)
  sketch: 0x1f63c6, sketchDone: 0x1747a6, construction: 0xf08c00,
  plane: 0xf0a030, join: 0x2e8fe0, cut: 0xe0403a, newBody: 0x7a9fbe,
  constrained: 0x111111, dim: 0x3a3a3a,
};
// Theme palettes. COLORS is mutated in place by Viewport.setTheme() because other modules
// import the shared object. LIGHT is a snapshot of the defaults above.
const LIGHT_COLORS = { ...COLORS };
const PROFILE_OPACITY = 0.38; // finished-sketch profile fill (was 0.22: too faint over parts)
const DARK_COLORS = {
  edge: 0x101010, sketch: 0x5aa0ff, sketchDone: 0x2f7bff, // finished sketches sit on light parts, so not a pale blue
  constrained: 0xe8e8e8, dim: 0xd0d0d0,
};
const THEME_SCENE = {
  // env/head/hemi are multipliers on the environment preset's lighting; shadow = contact-shadow opacity
  light: { grid: 0x9aa4ae, sketchGrid: 0x7d8b99, gridOpacity: 1, env: 1, head: 1, hemi: 1, shadow: 0.55 },
  dark: { grid: 0xb4bec8, sketchGrid: 0xc2ccd6, gridOpacity: 0.8, env: 0.95, head: 0.95, hemi: 0.9, shadow: 0.75 },
};

// ---------- rendering options / procedural studio environments ----------
export const ENVIRONMENTS = ["studio", "neutral", "dark"];
export const DEFAULT_RENDER_OPTIONS = { shadows: true, ao: true, environment: "studio" };
function cleanRenderOptions(o) {
  const d = DEFAULT_RENDER_OPTIONS;
  o = o && typeof o === "object" ? o : {};
  return {
    shadows: typeof o.shadows === "boolean" ? o.shadows : d.shadows,
    ao: typeof o.ao === "boolean" ? o.ao : d.ao,
    environment: ENVIRONMENTS.includes(o.environment) ? o.environment : d.environment,
  };
}
// Lighting that goes with each environment (scene.environmentIntensity, headlight, hemisphere fill).
const ENV_LIGHTING = {
  studio: { env: 1.0, head: 1.45, hemi: 0.3 },
  neutral: { env: 0.95, head: 1.2, hemi: 0.35 },
  dark: { env: 1.1, head: 1.35, hemi: 0.15 },
};
// Z-up studio "photo booth": a gradient shell (bright ceiling, mid-grey walls, darker floor so metals
// show a horizon line) plus soft rectangular light panels. All values are linear HDR radiance.
const ENV_SPECS = {
  studio: {
    // the band around the horizon is what level-viewed vertical metal faces reflect: it was 0.2, so
    // aluminium sides went near-black side-on (bug report 2026-10-18 19:27); a softer dip keeps the line
    shell: [[-1, 0.4], [-0.25, 0.42], [-0.03, 0.38], [0.06, 0.58], [0.45, 0.62], [1, 0.75]],
    panels: [
      { pos: [-14, -20, 20], size: [14, 9], i: 5.5 }, // key softbox, front-left above
      { pos: [24, -6, 9], size: [8, 15], i: 2.2 }, // fill, right
      { pos: [4, 26, 14], size: [20, 5], i: 3.2 }, // rim, behind
      { pos: [-6, 0, 30], size: [26, 2.6], i: 4.0, up: [1, 0, 0] }, // overhead strip lights
      { pos: [6, 0, 30], size: [26, 2.6], i: 4.0, up: [1, 0, 0] },
      { pos: [0, -28, 2], size: [30, 3], i: 1.4 }, // low bounce strips all round, at eye level
      { pos: [0, 28, 2], size: [30, 3], i: 1.2 },
      { pos: [28, 0, 2], size: [30, 3], i: 1.2 },
      { pos: [-28, 0, 2], size: [30, 3], i: 1.2 },
    ],
  },
  neutral: {
    shell: [[-1, 0.3], [-0.15, 0.4], [0, 0.55], [0.4, 0.65], [1, 0.8]],
    panels: [
      { pos: [-14, -20, 20], size: [16, 12], i: 2.2 },
      { pos: [20, 14, 16], size: [16, 12], i: 1.6 },
      { pos: [0, 0, 30], size: [20, 20], i: 1.6 },
    ],
  },
  dark: {
    shell: [[-1, 0.05], [-0.15, 0.07], [0, 0.1], [0.4, 0.12], [1, 0.15]],
    panels: [
      { pos: [-14, -20, 18], size: [12, 7], i: 7 },
      { pos: [26, -2, 10], size: [2.5, 18], i: 5 },
      { pos: [-26, 6, 10], size: [2.5, 18], i: 3.5 },
      { pos: [0, 0, 30], size: [28, 2.2], i: 6, up: [1, 0, 0] },
      { pos: [4, 26, 12], size: [22, 3], i: 4.5 },
    ],
  },
};
function buildEnvScene(kind) {
  const spec = ENV_SPECS[kind] || ENV_SPECS.studio;
  const scene = new THREE.Scene();
  const R = 50;
  const geo = new THREE.SphereGeometry(R, 64, 32);
  geo.rotateX(Math.PI / 2); // poles on Z
  const pos = geo.getAttribute("position"), col = new Float32Array(pos.count * 3);
  const stops = spec.shell;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getZ(i) / R;
    let v = stops[stops.length - 1][1];
    for (let k = 0; k < stops.length - 1; k++) {
      const [t0, v0] = stops[k], [t1, v1] = stops[k + 1];
      if (t <= t1) { const u = THREE.MathUtils.smoothstep(t, t0, t1); v = v0 + (v1 - v0) * u; break; }
    }
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v * 1.02; // a hint of cool
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false })));
  for (const p of spec.panels) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(p.size[0], p.size[1]), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }));
    m.material.color.setRGB(p.i, p.i, p.i);
    m.position.set(...p.pos);
    m.up.set(...(p.up || [0, 0, 1]));
    m.lookAt(0, 0, 0);
    scene.add(m);
  }
  return scene;
}
function disposeScene(scene) {
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
}

export const CAMERA_MODES = ["perspective", "orthographic", "perspOrtho"];
const DEFAULT_HOME = { az: -55, pol: 62 }; // degrees
const ALIGN_COS = Math.cos((0.5 * Math.PI) / 180); // "Perspective with Ortho Faces" snap tolerance

const FOV = 30;
const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

function gridMaterial(color = 0x9aa4ae) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    extensions: { derivatives: true },
    uniforms: { uStep: { value: 10 }, uCenter: { value: new THREE.Vector2() }, uFade: { value: 500 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 }, uScale: { value: 1e5 } },
    vertexShader: `uniform float uScale; varying vec2 vP; void main(){ vP = position.xy * uScale; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uStep; uniform vec2 uCenter; uniform float uFade; uniform vec3 uColor; uniform float uOpacity; varying vec2 vP;
      // each line family fades out as its cells shrink toward a few pixels on screen: at grazing angles
      // (orthographic especially) the grid turned into moire (bug report 2026-10-18 19:27)
      float line(vec2 p, float s){
        vec2 q = p / s, w = fwidth(q);
        vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-6));
        vec2 fade = 1.0 - smoothstep(vec2(0.12), vec2(0.35), w);
        vec2 l = (1.0 - min(g, vec2(1.0))) * fade;
        return max(l.x, l.y);
      }
      void main(){
        float minor = line(vP, uStep), major = line(vP, uStep * 10.0);
        float a = max(minor * 0.2, major * 0.45);
        a *= 1.0 - smoothstep(uFade * 0.35, uFade, distance(vP, uCenter));
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a * uOpacity);
      }`,
  });
}

function squareSprite() {
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#1b2a3a"; g.fillRect(4, 4, 24, 24);
  g.fillStyle = "#ffffff"; g.fillRect(9, 9, 14, 14);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function planeMatrix(p) {
  const x = new THREE.Vector3(...p.xDir), z = new THREE.Vector3(...p.normal);
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  m.setPosition(...p.origin);
  return m;
}

/**
 * Move values { dx, dy, dz, rx, ry, rz } (deg; rotation = Rz·Ry·Rx about a pivot, then the translation)
 * after a gizmo drag `d` that started at values `v0`. A ring turns about the world axis, so the new
 * rotation is R(axis, angle)·R0, decomposed back to X/Y/Z angles. `snap` = { t: mm, r: deg } steps
 * (movetools.js snapFor); a boolean is the old Shift flag (0.1 mm / 1°, Shift 1 mm / 15°).
 */
export function applyGizmoDelta(v0, d, snap = false) {
  if (typeof snap !== "object" || !snap) snap = snap ? { t: 1, r: 15 } : { t: 0.1, r: 1 };
  const v = { ...v0 };
  const r6 = (x) => +x.toFixed(6);
  if (d.kind === "t") {
    const st = snap.t;
    ["dx", "dy", "dz"].forEach((k, i) => { v[k] = r6(Math.round(((v0[k] || 0) + d.vec[i]) / st) * st); });
    return v;
  }
  const st = snap.r, ang = Math.round(d.angle / st) * st;
  const R0 = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...["rx", "ry", "rz"].map((k) => THREE.MathUtils.degToRad(v0[k] || 0)), "ZYX"));
  const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)][d.axis];
  const R = new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(ang)).multiply(R0);
  const e = new THREE.Euler().setFromRotationMatrix(R, "ZYX");
  // keep untouched angles exactly as typed (no 1e-15 noise), round the rest to 0.01°
  ["rx", "ry", "rz"].forEach((k, i) => { const x = THREE.MathUtils.radToDeg([e.x, e.y, e.z][i]); v[k] = Math.abs(x - (v0[k] || 0)) < 1e-7 ? (v0[k] || 0) : +x.toFixed(2); });
  return v;
}
/** Column-major 4×4 of the move: T(t)·T(p)·Rz·Ry·Rx·T(−p). */
export function moveMatrix(v, pivot) {
  const p = new THREE.Vector3(...pivot);
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...["rx", "ry", "rz"].map((k) => THREE.MathUtils.degToRad(v[k] || 0)), "ZYX"));
  return new THREE.Matrix4().makeTranslation(v.dx || 0, v.dy || 0, v.dz || 0)
    .multiply(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)).multiply(R)
    .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)).toArray();
}

export class Viewport {
  constructor(container, canvas) {
    this.container = container;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true }); // stencil: section caps
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    // Khronos PBR Neutral keeps base colours (red stays red) while rolling off bright highlights.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMaps = {};
    this._renderOptions = cleanRenderOptions(getPref("renderOptions", null));
    this.scene.environment = this.envMap(this._renderOptions.environment);
    this.scene.environmentIntensity = 1;
    this.appearances = {};
    this.matCache = new Map();
    this.ghost = null;

    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e6);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    this.view = { target: new THREE.Vector3(0, 0, 0), az: THREE.MathUtils.degToRad(DEFAULT_HOME.az), pol: THREE.MathUtils.degToRad(DEFAULT_HOME.pol), dist: 220 };
    // legacy flag: reading it returns whether the ortho camera is in use right now;
    // writing it maps to setCameraMode("orthographic" | "perspective").
    Object.defineProperty(this.view, "ortho", {
      get: () => this.isOrtho(),
      set: (v) => this.setCameraMode(v ? "orthographic" : "perspective"),
      enumerable: false, configurable: true,
    });
    const savedMode = getPref("cameraMode", "perspOrtho");
    this._cameraMode = CAMERA_MODES.includes(savedMode) ? savedMode : "perspOrtho";
    this.sceneExtent = 0;
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.7);
    this.scene.add(this.headlight, this.headlight.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x7d8692, 0.55);
    this.scene.add(this.hemi);

    this.groups = {};
    for (const n of ["bodies", "results", "sketches", "planes", "section", "highlight", "preview", "overlay", "manip", "assembly"]) {
      this.groups[n] = new THREE.Group(); this.scene.add(this.groups[n]);
    }
    this.groups.overlay.renderOrder = 10;

    // ground grid on XY + axis lines
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gridMaterial());
    this.grid.scale.set(1e5, 1e5, 1); this.grid.renderOrder = -1;
    this.scene.add(this.grid);
    this.axes = new THREE.Group();
    const axis = (dir, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...dir).multiplyScalar(-1e4), new THREE.Vector3(...dir).multiplyScalar(1e4)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }));
      l.userData.axis = dir[0] ? "X" : dir[1] ? "Y" : "Z"; return l;
    };
    this.axisLines = [axis([1, 0, 0], 0xd0453a), axis([0, 1, 0], 0x4aa04a), axis([0, 0, 1], 0x3a6fd0)];
    this.axisLines[2].visible = false;
    this.axes.add(...this.axisLines);
    this.scene.add(this.axes);
    this.sketchGrid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gridMaterial(0x7d8b99));
    this.sketchGrid.matrixAutoUpdate = false; this.sketchGrid.visible = false; this.sketchGrid.renderOrder = -1;
    this.scene.add(this.sketchGrid);

    // body proxies (shared geometry) used by the contact shadow and AO passes
    this.proxyScene = new THREE.Scene();
    this.proxyScene.matrixWorldAutoUpdate = false;
    this.proxyMat = new THREE.MeshBasicMaterial();
    this.initContactShadow();
    this.ao = null; // GTAO passes, created lazily
    this.modelSize = 100;

    this.lineMats = [];
    this.pointTex = squareSprite();
    this.bodyViews = [];
    this.sketchViews = [];
    this.planeViews = [];
    this.originPlanes = this.makeOriginPlanes();
    this.showGrid = true;
    this.hidden = new Set();
    this.raycaster = new THREE.Raycaster();
    this.handlers = {};
    this.navMode = null;
    this.drag = null;
    this.anim = null;
    this.dirty = true;
    this.frameCallbacks = [];
    this.arrow = null;
    this.section = null; // Section Analysis: { normal, point, cap } in world space (sectionui.js)
    this.clipPlanes = null;
    this.capMats = new Map();

    this.setTheme(getTheme() === "dark");
    onThemeChange((t) => this.setTheme(t === "dark"));
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); this.tick(); };
    loop();
  }

  get camera() { return this.isOrtho() ? this.ortho : this.persp; }

  // ---------- projection modes ----------
  /** "perspective" | "orthographic" | "perspOrtho" (perspective, but ortho when looking straight at a cube face). */
  get cameraMode() { return this._cameraMode; }
  set cameraMode(m) { this.setCameraMode(m); }
  /** persist: false = a temporary switch (sketch mode) that isn't saved as the user's preference. */
  setCameraMode(mode, { persist = true } = {}) {
    if (!CAMERA_MODES.includes(mode)) return this._cameraMode;
    this._cameraMode = mode;
    if (persist) setPref("cameraMode", mode);
    this.dirty = true;
    return mode;
  }
  /** True when the view direction is within ~0.5 deg of a principal axis. */
  isAxisAligned() {
    const { dir } = this.basis();
    return Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)) >= ALIGN_COS;
  }
  /** Whether the orthographic camera is the one being rendered right now. */
  isOrtho() {
    const m = this._cameraMode;
    return m === "orthographic" || (m === "perspOrtho" && this.isAxisAligned());
  }
  /** Half-depth of the ortho frustum around the camera, large enough to never clip the model. */
  orthoSpan() {
    return Math.max(this.view.dist * 20, this.view.target.length() + this.sceneExtent * 2 + 10, 1000);
  }

  // ---------- theme ----------
  /** Switch scene colours for the dark (true) or light (false) theme. Called automatically on theme changes. */
  setTheme(dark) {
    this.dark = !!dark;
    Object.assign(COLORS, LIGHT_COLORS, dark ? DARK_COLORS : {});
    const t = THEME_SCENE[dark ? "dark" : "light"];
    const gu = this.grid.material.uniforms, su = this.sketchGrid.material.uniforms;
    gu.uColor.value.setHex(t.grid); gu.uOpacity.value = t.gridOpacity;
    su.uColor.value.setHex(t.sketchGrid); su.uOpacity.value = t.gridOpacity;
    this.applyLighting();
    // live-update existing edge and finished-sketch lines (bodies keep their material otherwise)
    for (const v of this.bodyViews) v.lines.material.color.setHex(COLORS.edge);
    this.groups.sketches.traverse((o) => { const k = o.userData && o.userData.colorKey; if (k && o.material) o.material.color.setHex(COLORS[k]); });
    this.requestRender();
  }

  applyLighting() {
    const t = THEME_SCENE[this.dark ? "dark" : "light"], l = ENV_LIGHTING[this._renderOptions.environment];
    this.scene.environmentIntensity = l.env * t.env;
    this.headlight.intensity = l.head * t.head;
    this.hemi.intensity = l.hemi * t.hemi;
    if (this.shadow) this.shadow.plane.material.opacity = t.shadow;
  }

  // ---------- render options (environment, contact shadow, ambient occlusion) ----------
  /** PMREM texture for an environment preset (built once, then cached). */
  envMap(kind) {
    if (!this.envMaps[kind]) {
      const sc = buildEnvScene(kind);
      this.envMaps[kind] = this.pmrem.fromScene(sc, 0.035, 0.1, 200).texture;
      disposeScene(sc);
    }
    return this.envMaps[kind];
  }
  /** Current options: { shadows, ao, environment: "studio" | "neutral" | "dark" } (a copy). */
  get renderOptions() { return { ...this._renderOptions }; }
  set renderOptions(o) { this.setRenderOptions(o); }
  /** Merge and apply render options; persisted in prefs.renderOptions. Returns the new options. */
  setRenderOptions(opts = {}) {
    const next = cleanRenderOptions({ ...this._renderOptions, ...opts });
    const prev = this._renderOptions;
    this._renderOptions = next;
    if (next.environment !== prev.environment) this.scene.environment = this.envMap(next.environment);
    if (next.shadows !== prev.shadows) this.shadow.dirty = true;
    this.applyLighting();
    setPref("renderOptions", next);
    this.dirty = true;
    return { ...next };
  }

  // ---------- contact shadow ----------
  // Bodies are rendered from just below their lowest Z, looking up, into a small render target with a
  // depth-fade material (dark near the ground, fading with height), blurred twice, and shown on a
  // plane just under the model. It only depends on the geometry, so it is re-rendered when bodies or
  // their visibility change, not every frame.
  initContactShadow() {
    const RES = 256;
    const rt = new THREE.WebGLRenderTarget(RES, RES, { type: THREE.HalfFloatType });
    rt.texture.generateMipmaps = false;
    const rtBlur = new THREE.WebGLRenderTarget(RES, RES, { type: THREE.HalfFloatType });
    rtBlur.texture.generateMipmaps = false;
    // the camera looks up (+Z) with +Y up, so screen-right is world -X: flip u on the plane
    rt.texture.repeat.set(-1, 1); rt.texture.offset.set(1, 0);
    const depthMat = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
    depthMat.userData.darkness = { value: 1.25 };
    depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = depthMat.userData.darkness;
      shader.fragmentShader = "uniform float darkness;\n" + shader.fragmentShader.replace(
        "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
        "gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 1.6 ) * darkness );");
    };
    depthMat.depthTest = false; depthMat.depthWrite = false;
    const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader); hBlur.depthTest = false;
    const vBlur = new THREE.ShaderMaterial(VerticalBlurShader); vBlur.depthTest = false;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    plane.renderOrder = -2; // under the grid lines
    plane.visible = false;
    plane.raycast = () => {}; // never pickable
    this.scene.add(plane);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.shadow = { RES, rt, rtBlur, depthMat, hBlur, vBlur, quad: new FullScreenQuad(null), plane, cam, dirty: true };
  }
  updateContactShadow() {
    const s = this.shadow;
    s.dirty = false;
    const box = new THREE.Box3();
    for (const v of this.bodyViews) if (v.grp.visible) box.union(this.bodyWorldBox(v)); // assembly transforms included
    if (!this._renderOptions.shadows || box.isEmpty()) { s.plane.visible = false; return; }
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const ext = Math.max(size.x, size.y, size.z, 1e-3);
    const pad = ext * 0.4;
    const W = size.x + pad * 2, H = size.y + pad * 2;
    const z0 = box.min.z - Math.max(ext * 0.002, 0.005);
    const far = Math.max(size.z, ext * 0.3) * 0.9;
    Object.assign(s.cam, { left: -W / 2, right: W / 2, top: H / 2, bottom: -H / 2, near: 0, far });
    s.cam.position.set(c.x, c.y, z0); s.cam.up.set(0, 1, 0); s.cam.lookAt(c.x, c.y, z0 + 1);
    s.cam.updateProjectionMatrix(); s.cam.updateMatrixWorld();
    s.plane.position.set(c.x, c.y, z0); s.plane.scale.set(W, H, 1);
    // render
    const r = this.renderer, prevRT = r.getRenderTarget(), prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha(), prevAuto = r.autoClear;
    r.setClearColor(0x000000, 0); r.autoClear = true;
    this.proxyScene.overrideMaterial = s.depthMat;
    this.proxyScene.updateMatrixWorld(true);
    r.setRenderTarget(s.rt); r.clear(); r.render(this.proxyScene, s.cam);
    this.proxyScene.overrideMaterial = null;
    // blur: soft overall, then a finer pass; amount in texels relative to the target
    const blur = (amount) => {
      s.hBlur.uniforms.tDiffuse.value = s.rt.texture; s.hBlur.uniforms.h.value = amount / s.RES;
      s.quad.material = s.hBlur; r.setRenderTarget(s.rtBlur); r.clear(); s.quad.render(r);
      s.vBlur.uniforms.tDiffuse.value = s.rtBlur.texture; s.vBlur.uniforms.v.value = amount / s.RES;
      s.quad.material = s.vBlur; r.setRenderTarget(s.rt); r.clear(); s.quad.render(r);
    };
    blur(6); blur(4); blur(2.5); blur(1.2);
    r.setRenderTarget(prevRT); r.setClearColor(prevClear, prevAlpha); r.autoClear = prevAuto;
    s.plane.visible = true;
  }
  /** Rebuild the proxy meshes (visible bodies, sharing their geometry) for shadow/AO rendering. */
  rebuildProxies() {
    this.proxyScene.clear();
    for (const v of this.bodyViews) {
      if (!v.grp.visible) continue;
      const p = new THREE.Mesh(v.mesh.geometry, this.proxyMat);
      p.userData.ghost = !!(this.ghost && this.ghost.has(v.id));
      p.userData.transmissive = (v.mesh.material.userData.seeThrough || 0) > 0.5;
      p.matrixAutoUpdate = false; p.matrix.copy(v.grp.matrix); v.proxy = p; // assembly placement
      this.proxyScene.add(p);
    }
    this.proxyScene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const v of this.bodyViews) box.union(this.bodyWorldBox(v));
    this.modelSize = box.isEmpty() ? 100 : Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
    this.shadow.dirty = true;
    this.dirty = true;
  }

  // ---------- ambient occlusion ----------
  // GTAO computed from the body proxies only, then multiplied onto the frame before the overlays
  // (highlights, preview, sketch overlay, manipulator) are drawn, so those stay clean.
  aoPass(cam) {
    if (!this.ao) this.ao = {};
    const key = cam.isPerspectiveCamera ? "persp" : "ortho";
    let p = this.ao[key];
    const pr = this.renderer.getPixelRatio(), w = Math.max(1, Math.round(this.width * pr)), h = Math.max(1, Math.round(this.height * pr));
    if (!p) {
      p = new GTAOPass(this.proxyScene, cam, w, h);
      p.output = GTAOPass.OUTPUT.Off; // we composite pdRenderTarget ourselves
      p.pdMaterial.defines.PERSPECTIVE_CAMERA = cam.isPerspectiveCamera ? 1 : 0;
      p.pdMaterial.needsUpdate = true;
      p.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      p.blendMaterial.uniforms.intensity.value = 1.5; // mix(1, ao, 1.5): a bit stronger than raw GTAO
      p._size = [w, h];
      this.ao[key] = p;
      if (!this.aoQuad) this.aoQuad = new FullScreenQuad(p.blendMaterial);
    }
    if (p._size[0] !== w || p._size[1] !== h) { p.setSize(w, h); p._size = [w, h]; }
    if (p._modelSize !== this.modelSize) {
      const s = this.modelSize;
      p.updateGtaoMaterial({ radius: s * 0.2, thickness: s * 0.15, distanceExponent: 1, distanceFallOff: 1, scale: 1, samples: 16, screenSpaceRadius: false });
      p._modelSize = s;
    }
    return p;
  }
  renderFrame() {
    const r = this.renderer, cam = this.camera;
    if (this.section) this.applyClipping();
    // AO is computed from the unclipped proxies, so it would shade the caps: off while sectioned
    const useAO = this._renderOptions.ao && !this.section && this.proxyScene.children.some((p) => !p.userData.ghost && !p.userData.transmissive);
    if (!useAO) { r.render(this.scene, cam); return; }
    const over = [this.groups.highlight, this.groups.preview, this.groups.overlay, this.groups.manip, this.groups.assembly];
    const base = [this.groups.bodies, this.groups.section, this.groups.results, this.groups.sketches, this.groups.planes, this.grid, this.axes, this.sketchGrid, this.originPlanes, this.shadow.plane];
    const overVis = over.map((o) => o.visible), baseVis = base.map((o) => o.visible);
    // 1) scene without overlays
    over.forEach((o) => { o.visible = false; });
    r.render(this.scene, cam);
    // 2) AO from opaque, non-ghosted bodies, multiplied onto the frame
    const pass = this.aoPass(cam);
    const hiddenProxies = this.proxyScene.children.filter((p) => p.userData.ghost || p.userData.transmissive);
    hiddenProxies.forEach((p) => { p.visible = false; });
    pass.camera = cam;
    const prevAuto = r.autoClear;
    pass.render(r, null, null);
    hiddenProxies.forEach((p) => { p.visible = true; });
    this.aoQuad.material = pass.blendMaterial;
    pass.blendMaterial.uniforms.tDiffuse.value = pass.pdRenderTarget.texture;
    r.setRenderTarget(null);
    r.autoClear = false;
    this.aoQuad.render(r);
    // 3) overlays on top, keeping the depth buffer from pass 1
    base.forEach((o) => { o.visible = false; });
    over.forEach((o, i) => { o.visible = overVis[i]; });
    r.render(this.scene, cam);
    base.forEach((o, i) => { o.visible = baseVis[i]; });
    r.autoClear = prevAuto;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.dirty = true;
  }

  // ---------- camera ----------
  basis() {
    const { az, pol } = this.view;
    const dir = new THREE.Vector3(Math.sin(pol) * Math.cos(az), Math.sin(pol) * Math.sin(az), Math.cos(pol));
    const right = new THREE.Vector3(-Math.sin(az), Math.cos(az), 0);
    const up = new THREE.Vector3().crossVectors(dir, right);
    return { dir, right, up };
  }
  updateCamera() {
    const { dir, right, up } = this.basis();
    const { target, dist } = this.view;
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir));
    const span = this.orthoSpan();
    for (const cam of [this.persp, this.ortho]) cam.quaternion.copy(q);
    this.persp.position.copy(target).addScaledVector(dir, dist);
    // the orthographic eye sits behind the whole scene (its projection doesn't depend on distance):
    // at `dist` the eye could end up in front of parts when the orbit target is away from them, and
    // GTAO blacked out everything behind the eye (bug report 2026-10-18 19:27, "lighting")
    this.ortho.position.copy(target).addScaledVector(dir, span);
    this.persp.near = Math.max(0.01, dist * 0.005);
    this.persp.far = dist * 200 + 5000;
    const hh = dist * tanHalf, hw = hh * (this.width / this.height || 1);
    Object.assign(this.ortho, { left: -hw, right: hw, top: hh, bottom: -hh, near: Math.max(0.01, span * 1e-4), far: 2 * span });
    this.persp.updateProjectionMatrix(); this.ortho.updateProjectionMatrix();
    this.persp.updateMatrixWorld(); this.ortho.updateMatrixWorld();
    this.headlight.position.copy(this.persp.position).addScaledVector(up, dist * 0.6).addScaledVector(right, -dist * 0.3);
    this.headlight.target.position.copy(target);
    // grid scale follows zoom
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(dist, 1e-3) / 8)));
    const u = this.grid.material.uniforms;
    u.uStep.value = step; u.uFade.value = dist * 2.2; u.uCenter.value.set(target.x, target.y);
    const su = this.sketchGrid.material.uniforms;
    su.uStep.value = step; su.uFade.value = dist * 2.2;
    if (this.sketchPlane) { const c = K.to2D(this.sketchPlane, target.toArray()); su.uCenter.value.set(c[0], c[1]); }
    this.gridStep = step;
    for (const m of this.lineMats) m.resolution.set(this.width, this.height);
  }
  worldPerPixel(at) {
    const d = this.isOrtho() || !at ? this.view.dist : Math.max(this.camera.position.distanceTo(at), 1e-6);
    return (2 * d * tanHalf) / this.height;
  }
  animateTo(goal, ms = 350) {
    const from = { target: this.view.target.clone(), az: this.view.az, pol: this.view.pol, dist: this.view.dist };
    let daz = (goal.az ?? from.az) - from.az;
    daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    this.anim = { from, to: { target: goal.target ? goal.target.clone() : from.target, az: from.az + daz, pol: goal.pol ?? from.pol, dist: goal.dist ?? from.dist }, t0: performance.now(), ms };
  }
  setViewDir(d, opts = {}) {
    const v = new THREE.Vector3(...d).normalize();
    const pol = Math.acos(THREE.MathUtils.clamp(v.z, -1, 1));
    // straight down: +X right, +Y up. Straight up (BOTTOM): -X right, +Y up, so FRONT stays at the bottom.
    let az = Math.abs(v.z) > 0.9999 ? (opts.az ?? (v.z > 0 ? -Math.PI / 2 : Math.PI / 2)) : Math.atan2(v.y, v.x);
    this.animateTo({ az, pol, ...opts });
  }
  /** True isometric view: looking from (1,-1,1) (front-right-top), Z up. Keeps the current target/zoom. */
  isoView() { this.setViewDir([1, -1, 1]); }
  /** Go to the saved home view, or fit at the default home angles. */
  home() {
    const h = getPref("homeView", null);
    if (h && [h.az, h.pol, h.dist].every(Number.isFinite) && Array.isArray(h.target) && h.target.length === 3 && h.target.every(Number.isFinite)) {
      this.animateTo({ az: h.az, pol: h.pol, dist: h.dist, target: new THREE.Vector3(...h.target) }, 400);
      return;
    }
    this.fit(true, { az: THREE.MathUtils.degToRad(DEFAULT_HOME.az), pol: THREE.MathUtils.degToRad(DEFAULT_HOME.pol) });
  }
  /** Store the current camera as Home (persisted in prefs.homeView). */
  setHomeView() {
    const { az, pol, dist, target } = this.view;
    setPref("homeView", { az, pol, dist, target: target.toArray() });
  }
  /** Forget the custom Home; home() goes back to fit-at-default-angles. */
  resetHome() { setPref("homeView", null); }
  hasCustomHome() { return !!getPref("homeView", null); }
  updateSceneExtent() {
    this.scene.updateMatrixWorld();
    const box = this.sceneBounds();
    if (box.isEmpty()) { this.sceneExtent = 0; return; }
    const s = box.getBoundingSphere(new THREE.Sphere());
    this.sceneExtent = s.center.length() + s.radius;
  }
  sceneBounds() {
    const box = new THREE.Box3();
    for (const g of [this.groups.bodies, this.groups.sketches, this.groups.planes]) {
      g.traverse((o) => { if (o.visible && (o.isMesh || o.isLine || o.isLineSegments) && o.geometry) { o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); if (isFinite(b.min.x)) box.union(b); } });
    }
    return box;
  }
  fit(animate = true, extra = {}) {
    const box = this.sceneBounds();
    if (box.isEmpty()) { this.animateTo({ target: new THREE.Vector3(), dist: 220, ...extra }); return; }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(FOV / 2)) * 1.15;
    this.animateTo({ target: sphere.center, dist, ...extra }, animate ? 400 : 1);
  }
  /** Orbit around a world point from now on, without moving the camera (Orbit mode: click a point). */
  setPivot(p) {
    const cam = this.persp.position.clone(), d = cam.clone().sub(p), dist = d.length(); // the eye at view.dist (the ortho eye sits far back)
    if (dist < 1e-6) return;
    d.divideScalar(dist);
    this.anim = null;
    Object.assign(this.view, { az: Math.atan2(d.y, d.x), pol: Math.acos(THREE.MathUtils.clamp(d.z, -1, 1)), dist });
    this.view.target.copy(p);
    this.dirty = true;
  }
  lookAtPlane(p) {
    const n = p.normal, x = p.xDir;
    const pol = Math.acos(THREE.MathUtils.clamp(n[2], -1, 1));
    let az;
    if (Math.abs(n[2]) > 0.9999) {
      // looking straight down/up the Z axis: choose az so that screen-right == plane x
      az = Math.atan2(-x[0], x[1]);
      if (n[2] < 0) az = Math.atan2(x[0], -x[1]);
    } else az = Math.atan2(n[1], n[0]);
    this.animateTo({ az, pol, target: new THREE.Vector3(...p.origin).lerp(this.view.target, 0) });
  }

  tick() {
    if (this.anim) {
      const a = this.anim, t = Math.min(1, (performance.now() - a.t0) / a.ms), e = 1 - Math.pow(1 - t, 3);
      this.view.az = a.from.az + (a.to.az - a.from.az) * e;
      this.view.pol = a.from.pol + (a.to.pol - a.from.pol) * e;
      this.view.dist = a.from.dist + (a.to.dist - a.from.dist) * e;
      this.view.target.lerpVectors(a.from.target, a.to.target, e);
      if (t >= 1) this.anim = null;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.updateCamera();
    this.updateManipScale();
    this.originPlanes.scale.setScalar(this.view.dist * 0.18);
    if (this.shadow.dirty) this.updateContactShadow();
    this.renderFrame();
    for (const cb of this.frameCallbacks) cb();
  }
  requestRender() { this.dirty = true; }
  onFrame(cb) { this.frameCallbacks.push(cb); }

  // ---------- coordinate helpers ----------
  ndc(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }
  ray(cx, cy) {
    this.updateCamera();
    const cam = this.camera;
    this.raycaster.setFromCamera(this.ndc(cx, cy), cam);
    // (the ortho eye sits behind the whole scene, see updateCamera, so its rays already start outside it)
    return this.raycaster.ray;
  }
  worldToScreen(v) {
    if (this.dirty) this.updateCamera(); // keep in step with picking even before the next frame renders
    const p = new THREE.Vector3(...(Array.isArray(v) ? v : v.toArray())).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, behind: p.z > 1 };
  }
  screenToPlane(cx, cy, plane) {
    const ray = this.ray(cx, cy);
    const n = new THREE.Vector3(...plane.normal), o = new THREE.Vector3(...plane.origin);
    const denom = n.dot(ray.direction);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return K.to2D(plane, p.toArray());
  }

  // ---------- events / navigation ----------
  bindEvents() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.anim = null;
      const start = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
      const gh = e.button === 0 && this.gizmo && this.hitGizmo(e.clientX, e.clientY);
      if (gh) { this.drag = { mode: "gizmo", ...this.gizmoStart(gh, e), ...start }; return; }
      if (e.button === 0 && this.arrow && this.hitArrow(e.clientX, e.clientY)) {
        const t0 = this.axisParam(e.clientX, e.clientY);
        this.drag = { mode: "arrow", t0, v0: this.arrow.value, ...start };
        return;
      }
      if (e.button === 1) { this.drag = { mode: e.shiftKey ? "orbit" : "pan", ...start }; e.preventDefault(); return; }
      if (e.button === 2) { this.drag = { mode: "rightPending", ...start }; return; }
      if (e.button === 0) {
        if (this.navMode) { this.drag = { mode: this.navMode, nav: true, ...start }; return; }
        if (this.handlers.down && this.handlers.down(e)) { this.drag = { mode: "handler", ...start }; return; }
        this.drag = { mode: "clickPending", ...start };
      }
    });
    c.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) { this.handlers.move && this.handlers.move(e); this.updateArrowHover(e); this.updateGizmoHover(e); return; }
      const dx = e.clientX - (d.lx ?? d.x), dy = e.clientY - (d.ly ?? d.y);
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
      d.lx = e.clientX; d.ly = e.clientY;
      if (d.mode === "rightPending" && d.moved) d.mode = "orbit";
      if (d.mode === "orbit") this.orbit(dx, dy);
      else if (d.mode === "pan") this.pan(dx, dy);
      else if (d.mode === "zoom") this.zoomAt(e.clientX, e.clientY, Math.exp(dy * 0.005), d.x, d.y);
      else if (d.mode === "arrow") {
        const t = this.axisParam(e.clientX, e.clientY);
        if (t != null && d.t0 != null) { this.arrow.value = Math.max(this.arrow.min ?? -Infinity, d.v0 + (t - d.t0)); this.positionArrow(); this.arrow.onDrag(this.arrow.value); }
      } else if (d.mode === "gizmo") this.gizmoMove(d, e);
      else if (d.mode === "handler") { if (d.moved) this.handlers.drag && this.handlers.drag(e); } // a press without movement is a click (pointerup)
      else if (d.mode === "clickPending") this.handlers.move && this.handlers.move(e);
    });
    c.addEventListener("pointerup", (e) => {
      const d = this.drag; this.drag = null;
      if (!d) return;
      if (d.mode === "clickPending" && !d.moved) this.handlers.click && this.handlers.click(e);
      else if (d.mode === "rightPending") this.handlers.context && this.handlers.context(e);
      else if (d.mode === "handler") this.handlers.up && this.handlers.up(e, d.moved);
      else if (d.mode === "arrow") this.arrow && this.arrow.onEnd && this.arrow.onEnd(this.arrow.value);
      else if (d.mode === "gizmo") { if (this.gizmo && this.gizmo.onEnd) this.gizmo.onEnd(); this.updateGizmoHover(e); }
      else if (d.nav && !d.moved) this.handlers.navClick && this.handlers.navClick(e, d.mode); // a click in Orbit / Pan / Zoom mode
    });
    c.addEventListener("dblclick", (e) => this.handlers.dblclick && this.handlers.dblclick(e));
    c.addEventListener("wheel", (e) => { e.preventDefault(); this.anim = null; this.zoomAt(e.clientX, e.clientY, Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016)); }, { passive: false });
    c.addEventListener("pointerleave", () => this.handlers.leave && this.handlers.leave());
  }
  orbit(dx, dy) {
    this.view.az -= dx * 0.008;
    this.view.pol = THREE.MathUtils.clamp(this.view.pol - dy * 0.008, 0, Math.PI);
    this.dirty = true;
  }
  pan(dx, dy) {
    const { right, up } = this.basis();
    const wpp = (2 * this.view.dist * tanHalf) / this.height;
    this.view.target.addScaledVector(right, -dx * wpp).addScaledVector(up, dy * wpp);
    this.dirty = true;
  }
  zoomAt(cx, cy, factor, ax, ay) {
    const n = this.ndc(ax ?? cx, ay ?? cy);
    const { right, up } = this.basis();
    const hh = this.view.dist * tanHalf, hw = hh * (this.width / this.height);
    const P = this.view.target.clone().addScaledVector(right, n.x * hw).addScaledVector(up, n.y * hh);
    const nd = THREE.MathUtils.clamp(this.view.dist * factor, 0.05, 2e5);
    const f = nd / this.view.dist;
    this.view.target.sub(P).multiplyScalar(f).add(P);
    this.view.dist = nd;
    this.dirty = true;
  }

  // ---------- body rendering ----------
  lineMat(color, width, opts = {}) {
    const m = new LineMaterial({ color, linewidth: width, worldUnits: false, transparent: true, depthTest: opts.depthTest ?? true, dashed: !!opts.dashed, dashSize: 2, gapSize: 1.5, ...opts.extra });
    m.resolution.set(this.width || 1, this.height || 1);
    this.lineMats.push(m);
    return m;
  }
  fatLines(positions, color, width, opts) {
    const g = new LineSegmentsGeometry().setPositions(positions);
    const l = new LineSegments2(g, this.lineMat(color, width, opts));
    if (opts && opts.dashed) l.computeLineDistances();
    return l;
  }
  disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !(o.material.userData && o.material.userData.cached)) { const i = this.lineMats.indexOf(o.material); if (i >= 0) this.lineMats.splice(i, 1); o.material.dispose && o.material.dispose(); }
    });
    g.clear();
  }

  // ---------- materials / appearances ----------
  /** Shared MeshPhysicalMaterial for an appearance (cached by appearance key; ghost = see-through). */
  bodyMaterial(app, ghost = false) {
    const key = appearanceKey(app) + (ghost ? "#ghost" : "");
    let mat = this.matCache.get(key);
    if (mat) return mat;
    const r = resolveAppearance(app).renderParams;
    mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(r.color), metalness: r.metalness, roughness: r.roughness,
      clearcoat: r.clearcoat || 0, clearcoatRoughness: r.clearcoatRoughness ?? 0.1,
      sheen: r.sheen || 0, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xffffff),
      ior: r.ior ?? 1.5, specularIntensity: 1,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide,
    });
    // Clear materials: real transmission samples a buffer cleared to white on a transparent canvas
    // (glass would render milky white over the CSS background), so use alpha see-through instead.
    // The reflections still come from the environment.
    if (r.transmission) {
      mat.transparent = true;
      mat.opacity = 1 - 0.72 * r.transmission;
      mat.userData.seeThrough = r.transmission;
    }
    if (ghost) { mat.transparent = true; mat.opacity = 0.25; mat.depthWrite = false; }
    Object.assign(mat.userData, { cached: true, key });
    this.matCache.set(key, mat);
    return mat;
  }
  /** Drop cached materials that no body uses, once the cache grows (e.g. after dragging a colour picker). */
  pruneMaterials() {
    if (this.matCache.size <= 40) return;
    const used = new Set(this.bodyViews.map((v) => v.mesh.material));
    for (const [k, m] of this.matCache) if (!used.has(m)) { m.dispose(); this.matCache.delete(k); }
  }
  /**
   * Set body appearances: { [bodyId]: { materialId, color?, finish? } }. Bodies without an entry get
   * the default material. Remembered and re-applied on every setState. Cheap (no re-meshing), so it
   * can be called for live previews.
   */
  setAppearances(map) {
    this.appearances = map && typeof map === "object" ? { ...map } : {};
    for (const v of this.bodyViews) v.mesh.material = this.bodyMaterial(this.appearances[v.id], !!(this.ghost && this.ghost.has(v.id)));
    this.rebuildCaps();
    this.pruneMaterials();
    this.rebuildProxies();
    this.dirty = true;
  }
  getAppearance(id) { return this.appearances[id] || null; }

  setState(state, opts = {}) {
    this.state = state;
    if (opts.appearances !== undefined) this.appearances = opts.appearances && typeof opts.appearances === "object" ? { ...opts.appearances } : {};
    this.ghost = opts.ghost || null;
    this.disposeGroup(this.groups.bodies);
    this.bodyViews = [];
    for (const b of state.bodies) {
      let m;
      try { m = K.meshBody(b.shape, b.meshTol); } catch (e) { console.warn("mesh failed", e); continue; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(m.faces.vertices, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.faces.normals, 3));
      geo.setIndex(m.faces.triangles);
      const triFace = new Int32Array(m.faces.triangles.length / 3);
      m.faces.faceGroups.forEach((g, fi) => { for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) triFace[t] = fi; });
      const mat = this.bodyMaterial(this.appearances[b.id], !!(opts.ghost && opts.ghost.has(b.id)));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { kind: "body", body: b.id };
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(m.edges.lines, 3));
      const vertEdge = new Int32Array(m.edges.lines.length / 3);
      m.edges.edgeGroups.forEach((g, ei) => { for (let v = g.start; v < g.start + g.count; v++) vertEdge[v] = ei; });
      const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLORS.edge }));
      lines.userData = { kind: "edges", body: b.id };
      const grp = new THREE.Group(); grp.add(mesh, lines);
      grp.visible = !this.hidden.has(b.id);
      this.applyBodyXform({ id: b.id, grp }); // assembly placement (a matrix; never re-meshes)
      this.groups.bodies.add(grp);
      this.bodyViews.push({ id: b.id, grp, mesh, lines, triFace, faceGroups: m.faces.faceGroups, edgeGroups: m.edges.edgeGroups, vertEdge, mesh_: m });
    }
    this.rebuildCaps();
    this.groups.bodies.updateMatrixWorld(true);
    this.setSketches(state, opts.activeSketchId);
    this.setPlanes(state);
    this.pruneMaterials();
    this.rebuildProxies();
    this.updateSceneExtent();
    this.dirty = true;
  }

  setSketches(state, activeId) {
    this.disposeGroup(this.groups.sketches);
    this.sketchViews = [];
    for (const sk of Object.values(state.sketches)) {
      if (sk.id === activeId) continue;
      const grp = new THREE.Group();
      grp.visible = !this.hidden.has(sk.id);
      const lines = new THREE.Group(); lines.matrixAutoUpdate = false; lines.matrix.copy(planeMatrix(sk.plane));
      const pos = [], cpos = [];
      for (const e of sk.entities) {
        const pts = entityPolyline(e);
        const arr = e.construction ? cpos : pos;
        for (let i = 0; i < pts.length - 1; i++) arr.push(pts[i][0], pts[i][1], 0, pts[i + 1][0], pts[i + 1][1], 0);
      }
      if (pos.length) { const l = this.fatLines(pos, COLORS.sketchDone, 2.4); l.userData.colorKey = "sketchDone"; lines.add(l); }
      if (cpos.length) { const l = this.fatLines(cpos, COLORS.construction, 1.2, { dashed: true }); l.userData.colorKey = "construction"; lines.add(l); }
      grp.add(lines);
      const profiles = sk.profiles.map((p, i) => {
        const pm = this.faceMesh(K.meshFace(p.face), COLORS.profile, PROFILE_OPACITY);
        pm.userData = { kind: "profile", sketch: sk.id, idx: i };
        grp.add(pm);
        return pm;
      });
      this.groups.sketches.add(grp);
      const sv = { id: sk.id, grp, profiles, sketch: sk };
      this.applySketchXform(sv);
      this.sketchViews.push(sv);
    }
    this.groups.sketches.updateMatrixWorld(true);
  }
  /** A sketch on a body's face is drawn in that body's assembly placement (key "sk:<id>", see transformsFor). */
  applySketchXform(sv) {
    const m = this.bodyXform(`sk:${sv.id}`);
    sv.grp.matrixAutoUpdate = false;
    if (m && m.length === 16) sv.grp.matrix.fromArray(Array.from(m)); else sv.grp.matrix.identity();
  }
  faceMesh(m, color, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(m.vertices, 3));
    g.setIndex(m.triangles);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return new THREE.Mesh(g, mat);
  }

  setPlanes(state) {
    this.disposeGroup(this.groups.planes);
    this.planeViews = [];
    for (const pl of Object.values(state.planes)) {
      const m = this.planeQuad(pl.plane, 40, COLORS.plane, 0.18);
      // assign in place: planeQuad shares this object with the quad mesh and stores .mesh on it
      Object.assign(m.userData, { kind: "plane", planeRef: { kind: "cplane", id: pl.id }, plane: pl.plane, modelPlane: pl.plane, name: pl.name });
      m.visible = !this.hidden.has(pl.id);
      // wrapped so a plane made on a placed component's face can follow it ("pl:<id>", see transformsFor)
      const holder = new THREE.Group(); holder.matrixAutoUpdate = false; holder.add(m);
      this.groups.planes.add(holder);
      this.planeViews.push(m);
      this.applyPlaneXform(m);
    }
  }
  applyPlaneXform(m) {
    const x = this.bodyXform(`pl:${m.userData.planeRef.id}`), holder = m.parent;
    if (x && x.length === 16) holder.matrix.fromArray(Array.from(x)); else holder.matrix.identity();
    m.userData.plane = transformPlane(m.userData.modelPlane, x); // world plane for Look At and picks
    holder.updateMatrixWorld(true);
  }
  planeQuad(p, size, color, opacity) {
    const grp = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    const s = size / 2;
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, y]) => new THREE.Vector3(x, y, 0))), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    grp.add(mesh, edge);
    grp.matrixAutoUpdate = false; grp.matrix.copy(planeMatrix(p));
    grp.userData.mesh = mesh;
    mesh.userData = grp.userData;
    return grp;
  }
  makeOriginPlanes() {
    const grp = new THREE.Group();
    for (const name of ["XY", "XZ", "YZ"]) {
      const p = K.ORIGIN_PLANES[name];
      const q = this.planeQuad({ ...p, origin: [0, 0, 0] }, 1, COLORS.plane, 0.25);
      // place each quad in the positive quadrant like Fusion's origin planes
      const m = planeMatrix(p).multiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0));
      q.matrix.copy(m);
      q.userData.kind = "plane"; q.userData.planeRef = { kind: "origin", name }; q.userData.plane = p; q.userData.name = name;
      grp.add(q);
    }
    grp.visible = false;
    this.scene.add(grp);
    return grp;
  }
  setOriginPlanesVisible(v) { this.originPlanes.visible = v; this.dirty = true; }
  setVisibility(id, visible) {
    if (visible) this.hidden.delete(id); else this.hidden.add(id);
    for (const v of this.bodyViews) if (v.id === id) { v.grp.visible = visible; if (v.caps) v.caps[2].visible = visible; this._proxiesStale = true; }
    for (const v of this.sketchViews) if (v.id === id) v.grp.visible = visible;
    for (const p of this.planeViews) if (p.userData.planeRef.id === id) p.visible = visible;
    if (this._proxiesStale) { this._proxiesStale = false; this.rebuildProxies(); }
    this.dirty = true;
  }

  /** Translucent feature tool; matrix (16 numbers) = the assembly placement of the sketch / body it starts from. */
  setPreviewTool(shape, color, matrix = null) {
    this.disposeGroup(this.groups.preview);
    if (shape) {
      try {
        const m = K.meshBody(shape);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(m.faces.vertices, 3));
        g.setAttribute("normal", new THREE.Float32BufferAttribute(m.faces.normals, 3));
        g.setIndex(m.faces.triangles);
        // cached materials (userData.cached): a new material per preview update recompiled its shader
        this.hlMats = this.hlMats || new Map();
        let mat = this.hlMats.get(`p${color}`);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.38, depthWrite: false, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1 });
          mat.userData.cached = true; this.hlMats.set(`p${color}`, mat);
        }
        const mesh = new THREE.Mesh(g, mat);
        mesh.renderOrder = 5;
        let lmat = this.hlMats.get(`pl${color}`);
        if (!lmat) { lmat = this.lineMat(color, 1.4); lmat.userData.cached = true; this.hlMats.set(`pl${color}`, lmat); }
        const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(m.edges.lines), lmat);
        const holder = new THREE.Group(); holder.matrixAutoUpdate = false;
        if (matrix && matrix.length === 16) holder.matrix.fromArray(Array.from(matrix));
        holder.add(mesh, lines);
        this.groups.preview.add(holder);
      } catch (e) { console.warn(e); }
    }
    this.dirty = true;
  }

  // ---------- assembly placement ----------
  // Each body view's group carries its component's world transform as a plain matrix (column-major
  // 16 numbers, from assembly.js bodyTransforms). Geometry stays in modelled coordinates, so moving or
  // articulating never re-meshes. Highlights, proxies (shadow/AO), picking and bounds follow it.
  /** map: Map<bodyId, 16 numbers> or { bodyId: 16 numbers }; missing ids = identity. Cheap: call per frame. */
  setBodyTransforms(map) {
    this.bodyXforms = map || null;
    for (const v of this.bodyViews) {
      this.applyBodyXform(v);
      if (v.proxy) { v.proxy.matrix.copy(v.grp.matrix); v.proxy.matrixWorld.copy(v.grp.matrix); }
    }
    this.groups.bodies.updateMatrixWorld(true);
    for (const sv of this.sketchViews || []) this.applySketchXform(sv);
    for (const m of this.planeViews || []) this.applyPlaneXform(m);
    this.groups.sketches.updateMatrixWorld(true);
    this.groups.highlight.children.forEach((o) => { const bv = o.userData.followBody && this.bodyViews.find((b) => b.id === o.userData.followBody); if (bv) o.matrix.copy(bv.grp.matrix); });
    const box = new THREE.Box3();
    for (const v of this.bodyViews) box.union(this.bodyWorldBox(v));
    this.modelSize = box.isEmpty() ? 100 : Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
    if (!box.isEmpty()) { const s = box.getBoundingSphere(new THREE.Sphere()); this.sceneExtent = Math.max(this.sceneExtent, s.center.length() + s.radius); } // ortho span
    this.shadow.dirty = true;
    this.dirty = true;
  }
  bodyXform(id) {
    const x = this.bodyXforms;
    if (!x) return null;
    return (typeof x.get === "function" ? x.get(id) : x[id]) || null;
  }
  applyBodyXform(v) {
    const m = this.bodyXform(v.id);
    v.grp.matrixAutoUpdate = false;
    if (m && m.length === 16) v.grp.matrix.fromArray(Array.from(m)); else v.grp.matrix.identity();
  }
  /** Keep an overlay object (highlight) in a body's placement. */
  followBody(obj, bv) {
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(bv.grp.matrix);
    obj.userData.followBody = bv.id;
  }
  /** World-space bounding box of a body view (cached local box x placement). */
  bodyWorldBox(v) {
    const g = v.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox.clone().applyMatrix4(v.grp.matrix);
  }
  /**
   * Snap targets for sketching (bug report 2026-10-18 15:35: geometry behind the sketch plane couldn't be
   * grabbed): every visible body's vertices, straight-edge midpoints and circle / arc centres, projected
   * onto the sketch plane as [{ p: [u, v], type: "end" | "mid" | "center" }]. Taken from the display
   * mesh's edge polylines (in each body's placement), deduplicated in 2D.
   */
  modelSnapPoints(plane) {
    const out = [], seen = new Set();
    const o = plane.origin, n = plane.normal, x = plane.xDir;
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const v = new THREE.Vector3();
    const uv = (a, i, mat) => {
      v.set(a[3 * i], a[3 * i + 1], a[3 * i + 2]).applyMatrix4(mat);
      const d = [v.x - o[0], v.y - o[1], v.z - o[2]];
      return [d[0] * x[0] + d[1] * x[1] + d[2] * x[2], d[0] * y[0] + d[1] * y[1] + d[2] * y[2]];
    };
    const add = (p, type) => {
      const k = `${type[0]}${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`;
      if (seen.has(k)) return;
      seen.add(k); out.push({ p, type, model: true });
    };
    for (const bv of this.bodyViews) {
      if (!bv.grp.visible || !bv.mesh_ || !bv.edgeGroups) continue;
      const L = bv.mesh_.edges.lines, mat = bv.grp.matrix;
      for (const g of bv.edgeGroups) {
        if (!g || g.count < 2) continue;
        // lines are segment pairs: vertex 2k-1 equals vertex 2k
        const a = uv(L, g.start, mat), b = uv(L, g.start + g.count - 1, mat);
        add(a, "end"); add(b, "end");
        if (g.count === 2) { add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], "mid"); continue; }
        // circle / arc: circumcentre of start, middle, end, checked against two more points
        const m3 = (k) => { const pt = []; v.set(L[3 * k], L[3 * k + 1], L[3 * k + 2]).applyMatrix4(mat); pt.push(v.x, v.y, v.z); return pt; };
        const P = [0, 0.25, 0.5, 0.75, 1].map((t) => m3(g.start + Math.min(g.count - 1, Math.round(t * (g.count - 1)))));
        const c = circumcentre(P[0], P[2], P[4] && dist3(P[0], P[4]) > 1e-6 ? P[4] : P[3]);
        if (!c) continue;
        const r = dist3(c, P[0]);
        if (r < 1e-6 || [P[1], P[3]].some((q) => Math.abs(dist3(c, q) - r) > 0.01 * r + 1e-4)) continue;
        add(uv(c, 0, new THREE.Matrix4()), "center");
      }
    }
    return out;
  }
  /** World point -> the body's modelled coordinates (as a plain [x, y, z]). */
  toBodyLocal(bv, p) {
    const inv = new THREE.Matrix4().copy(bv.grp.matrix).invert();
    return p.clone().applyMatrix4(inv).toArray();
  }
  /**
   * Joint glyphs: [{ matrix: 16 numbers (world frame), color?, size? (world units), label? }].
   * Drawn on top of everything as a small triad (z arrow, x tick, ring in the xy plane).
   */
  setJointGlyphs(list) {
    this.disposeGroup(this.groups.assembly);
    for (const gl of list || []) {
      const s = gl.size || Math.max(this.modelSize * 0.06, 1);
      const color = gl.color ?? 0xf39a1e;
      const grp = new THREE.Group();
      grp.matrixAutoUpdate = false; grp.matrix.fromArray(Array.from(gl.matrix));
      const ring = [];
      for (let i = 0; i < 32; i++) {
        const a0 = (i / 32) * Math.PI * 2, a1 = ((i + 1) / 32) * Math.PI * 2;
        ring.push(Math.cos(a0) * s * 0.5, Math.sin(a0) * s * 0.5, 0, Math.cos(a1) * s * 0.5, Math.sin(a1) * s * 0.5, 0);
      }
      // cached materials (see hlLineMat): glyphs are rebuilt on every hover during the Joint command
      const op = gl.dim ? 0.45 : 1;
      const fl = (pos, c, w) => new LineSegments2(new LineSegmentsGeometry().setPositions(pos), this.hlLineMat(c, w, op));
      const r = fl(ring, color, 2.2);
      const z = fl([0, 0, 0, 0, 0, s * 1.2, 0, 0, s * 1.2, s * 0.12, 0, s * 0.95, 0, 0, s * 1.2, -s * 0.12, 0, s * 0.95], 0x3a6fd0, 2.6);
      const x = fl([0, 0, 0, s * 0.8, 0, 0], 0xd0453a, 2.2);
      for (const o of [r, z, x]) { o.renderOrder = 12; grp.add(o); }
      this.groups.assembly.add(grp);
    }
    this.dirty = true;
  }

  // ---------- highlights ----------
  // Highlight materials are cached (userData.cached keeps disposeGroup off them): a new material per
  // hover change made three.js recompile its program every time the hovered item changed.
  hlFaceMat(color, opacity) {
    const key = `f${color}:${opacity}`;
    this.hlMats = this.hlMats || new Map();
    let m = this.hlMats.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      m.userData.cached = true; this.hlMats.set(key, m);
    }
    return m;
  }
  hlLineMat(color, width, opacity = 1) {
    const key = `l${color}:${width}:${opacity}`;
    this.hlMats = this.hlMats || new Map();
    let m = this.hlMats.get(key);
    if (!m) { m = this.lineMat(color, width, { depthTest: false }); m.opacity = opacity; m.userData.cached = true; this.hlMats.set(key, m); }
    return m;
  }
  setHighlights(items) {
    this.disposeGroup(this.groups.highlight);
    for (const v of this.sketchViews) v.profiles.forEach((p) => { p.material.color.setHex(COLORS.profile); p.material.opacity = PROFILE_OPACITY; });
    this.originPlanes.children.forEach((q) => { q.userData.mesh.material.color.setHex(COLORS.plane); q.userData.mesh.material.opacity = 0.25; });
    this.planeViews.forEach((q) => { q.userData.mesh.material.color.setHex(COLORS.plane); q.userData.mesh.material.opacity = 0.18; });
    for (const { item, style } of items) {
      const color = style === "select" ? COLORS.select : COLORS.hover;
      if (item.kind === "face" || item.kind === "body") {
        const bv = this.bodyViews.find((b) => b.id === item.body);
        if (!bv) continue;
        const groups = item.kind === "body" ? bv.faceGroups : [bv.faceGroups[item.idx]];
        // own compact vertex buffer: sharing the body's position attribute meant disposing the highlight
        // also freed the body's GPU buffer, so every hover re-uploaded the whole body (big STEP imports lagged)
        const tri = bv.mesh_.faces.triangles, src = bv.mesh.geometry.getAttribute("position").array;
        const remap = new Map(), pos = [], idx = [];
        for (const g of groups) if (g) for (let i = g.start; i < g.start + g.count; i++) {
          const v = tri[i]; let k = remap.get(v);
          if (k === undefined) { k = remap.size; remap.set(v, k); pos.push(src[3 * v], src[3 * v + 1], src[3 * v + 2]); }
          idx.push(k);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        const mesh = new THREE.Mesh(geo, this.hlFaceMat(color, style === "select" ? 0.55 : 0.4));
        mesh.renderOrder = 3;
        this.followBody(mesh, bv);
        this.groups.highlight.add(mesh);
      } else if (item.kind === "edge") {
        const bv = this.bodyViews.find((b) => b.id === item.body);
        const g = bv && bv.edgeGroups[item.idx];
        if (!g) continue;
        const pos = bv.mesh_.edges.lines.slice(g.start * 3, (g.start + g.count) * 3);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), this.hlLineMat(color, style === "select" ? 3.5 : 3));
        l.renderOrder = 6;
        this.followBody(l, bv);
        this.groups.highlight.add(l);
      } else if (item.kind === "profile") {
        const sv = this.sketchViews.find((s) => s.id === item.sketch);
        const p = sv && sv.profiles[item.idx];
        if (p) { p.material.color.setHex(style === "select" ? COLORS.select : COLORS.profileHover); p.material.opacity = style === "select" ? 0.6 : 0.62; }
      } else if (item.kind === "plane") {
        const list = item.planeRef.kind === "origin" ? this.originPlanes.children : this.planeViews;
        const q = list.find((x) => JSON.stringify(x.userData.planeRef) === JSON.stringify(item.planeRef));
        if (q) { q.userData.mesh.material.color.setHex(color); q.userData.mesh.material.opacity = 0.45; }
      } else if (item.kind === "axis" || item.kind === "sketchline") {
        const pos = item.kind === "axis"
          ? { X: [-1e4, 0, 0, 1e4, 0, 0], Y: [0, -1e4, 0, 0, 1e4, 0], Z: [0, 0, -1e4, 0, 0, 1e4] }[item.name]
          : [...K.to3D(item.plane, item.a), ...K.to3D(item.plane, item.b)];
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), this.hlLineMat(color, 3));
        l.renderOrder = 6;
        this.groups.highlight.add(l);
      }
    }
    this.dirty = true;
  }

  // ---------- picking ----------
  /**
   * Ray hits on a body's edge polylines within `thr` (world units), like a Line raycast but with a
   * bounding-sphere test per B-rep edge first: a 4,700-edge STEP import has 36k segments, and testing
   * every one on each mouse move cost ~10 ms. Returns [{ point (world), distance, index (vertex) }].
   */
  edgeHits(bv, ray, thr) {
    const L = bv.mesh_.edges.lines, groups = bv.edgeGroups;
    if (!bv.edgeSpheres) {
      const sp = new Float32Array(groups.length * 4);
      groups.forEach((g, i) => {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let v = g.start; v < g.start + g.count; v++) for (let k = 0; k < 3; k++) { const x = L[3 * v + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
        sp[4 * i] = (lo[0] + hi[0]) / 2; sp[4 * i + 1] = (lo[1] + hi[1]) / 2; sp[4 * i + 2] = (lo[2] + hi[2]) / 2;
        sp[4 * i + 3] = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
      });
      bv.edgeSpheres = sp;
    }
    const sp = bv.edgeSpheres, inv = new THREE.Matrix4().copy(bv.grp.matrix).invert();
    const lr = ray.clone().applyMatrix4(inv); // placements are rigid, so distances carry over
    const c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    const out = [], t2 = thr * thr;
    for (let i = 0; i < groups.length; i++) {
      c.set(sp[4 * i], sp[4 * i + 1], sp[4 * i + 2]);
      const rr = sp[4 * i + 3] + thr;
      if (lr.distanceSqToPoint(c) > rr * rr) continue;
      const g = groups[i];
      for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
        a.set(L[3 * v], L[3 * v + 1], L[3 * v + 2]); b.set(L[3 * v + 3], L[3 * v + 4], L[3 * v + 5]);
        if (lr.distanceSqToSegment(a, b, onRay, onSeg) > t2) continue;
        const d = lr.origin.distanceTo(onRay);
        out.push({ point: onSeg.clone().applyMatrix4(bv.grp.matrix), distance: d, index: v });
      }
    }
    return out.sort((x, y) => x.distance - y.distance);
  }
  /** Ray hits on a body's triangles, with a bounding-sphere test per B-rep face first (see edgeHits). */
  faceHits(bv, ray) {
    const tri = bv.mesh_.faces.triangles, V = bv.mesh_.faces.vertices, groups = bv.faceGroups;
    if (!bv.faceSpheres) {
      const sp = new Float32Array(groups.length * 4);
      groups.forEach((g, i) => {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let k = g.start; k < g.start + g.count; k++) { const v = tri[k]; for (let j = 0; j < 3; j++) { const x = V[3 * v + j]; if (x < lo[j]) lo[j] = x; if (x > hi[j]) hi[j] = x; } }
        sp[4 * i] = (lo[0] + hi[0]) / 2; sp[4 * i + 1] = (lo[1] + hi[1]) / 2; sp[4 * i + 2] = (lo[2] + hi[2]) / 2;
        sp[4 * i + 3] = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
      });
      bv.faceSpheres = sp;
    }
    const sp = bv.faceSpheres, inv = new THREE.Matrix4().copy(bv.grp.matrix).invert();
    const lr = ray.clone().applyMatrix4(inv);
    const c = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), hit = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      c.set(sp[4 * i], sp[4 * i + 1], sp[4 * i + 2]);
      if (lr.distanceSqToPoint(c) > sp[4 * i + 3] * sp[4 * i + 3]) continue;
      const g = groups[i];
      for (let k = g.start; k < g.start + g.count; k += 3) {
        const i0 = tri[k], i1 = tri[k + 1], i2 = tri[k + 2];
        a.set(V[3 * i0], V[3 * i0 + 1], V[3 * i0 + 2]); b.set(V[3 * i1], V[3 * i1 + 1], V[3 * i1 + 2]); d.set(V[3 * i2], V[3 * i2 + 1], V[3 * i2 + 2]);
        if (!lr.intersectTriangle(a, b, d, false, hit)) continue;
        const p = hit.clone().applyMatrix4(bv.grp.matrix);
        out.push({ point: p, distance: ray.origin.distanceTo(p), faceIndex: k / 3 });
      }
    }
    return out;
  }
  pick(cx, cy, kinds) {
    if (!kinds || !kinds.length) return null;
    const ray = this.ray(cx, cy);
    const rc = this.raycaster;
    const wpp = this.worldPerPixel(this.view.target);
    let face = null, edge = null, profile = null, plane = null, axis = null, sline = null;
    const visibleBodies = this.bodyViews.filter((b) => b.grp.visible);
    if (kinds.some((k) => k === "face" || k === "body" || k === "edge")) {
      const hits = visibleBodies.flatMap((bv) => this.faceHits(bv, ray).map((x) => ({ ...x, bv }))).sort((x, y) => x.distance - y.distance).filter((x) => this.keptBySection(x.point));
      if (hits.length) {
        const h = hits[0], bv = h.bv;
        face = { kind: "face", body: bv.id, idx: bv.triFace[h.faceIndex], dist: h.distance, point: h.point, localPoint: this.toBodyLocal(bv, h.point) };
      }
    }
    if (kinds.includes("edge")) {
      let best = null;
      for (const bv of visibleBodies) {
        const hits = this.edgeHits(bv, ray, wpp * 6);
        for (const h of hits) {
          if (!this.keptBySection(h.point)) continue;
          const px = ray.distanceToPoint(h.point) / this.worldPerPixel(h.point);
          if (px > 7) continue;
          if (face && h.distance > face.dist + wpp * 8) continue; // occluded
          if (!best || px < best.px) best = { kind: "edge", body: bv.id, idx: bv.vertEdge[h.index], dist: h.distance, px, point: h.point, localPoint: this.toBodyLocal(bv, h.point) };
        }
      }
      edge = best;
    }
    if (kinds.includes("profile")) {
      const objs = this.sketchViews.filter((s) => s.grp.visible).flatMap((s) => s.profiles);
      const hits = rc.intersectObjects(objs, false);
      if (hits.length) { const h = hits[0]; profile = { kind: "profile", sketch: h.object.userData.sketch, idx: h.object.userData.idx, dist: h.distance, point: h.point }; }
    }
    if (kinds.includes("plane")) {
      const objs = [];
      if (this.originPlanes.visible) this.originPlanes.children.forEach((q) => objs.push(q.userData.mesh));
      this.planeViews.filter((q) => q.visible).forEach((q) => objs.push(q.userData.mesh));
      this.scene.updateMatrixWorld();
      const hits = rc.intersectObjects(objs, false);
      if (hits.length) { const u = hits[0].object.userData; plane = { kind: "plane", planeRef: u.planeRef, plane: u.plane, dist: hits[0].distance, name: u.name }; }
    }
    if (kinds.includes("axis")) {
      rc.params.Line.threshold = wpp * 6;
      const hits = rc.intersectObjects(this.axisLines.filter((l) => l.visible), false);
      const near = hits.filter((h) => ray.distanceToPoint(h.point) / this.worldPerPixel(h.point) < 7);
      if (near.length) axis = { kind: "axis", name: near[0].object.userData.axis, dist: near[0].distance };
    }
    if (kinds.includes("sketchline") && this.state) {
      let best = null;
      for (const sv of this.sketchViews) {
        if (!sv.grp.visible) continue;
        for (const e of sv.sketch.entities) {
          if (e.type !== "line") continue;
          const a = new THREE.Vector3(...K.to3D(sv.sketch.plane, e.a)).applyMatrix4(sv.grp.matrix), b = new THREE.Vector3(...K.to3D(sv.sketch.plane, e.b)).applyMatrix4(sv.grp.matrix);
          const pr = new THREE.Vector3(), ps = new THREE.Vector3();
          const d2 = ray.distanceSqToSegment(a, b, pr, ps);
          const px = Math.sqrt(d2) / this.worldPerPixel(ps);
          if (px < 7 && (!best || px < best.px)) best = { kind: "sketchline", sketch: sv.id, entity: e.id, a: e.a, b: e.b, plane: transformPlane(sv.sketch.plane, sv.grp.matrix.elements), px, dist: ray.origin.distanceTo(ps) };
        }
      }
      sline = best;
    }
    const tol = wpp * 3;
    if (edge) return edge;
    if (sline) return sline;
    if (axis && (!face || axis.dist < face.dist)) return axis;
    if (profile && (!face || profile.dist <= face.dist + tol)) return profile;
    if (face) return kinds.includes("face") ? face : kinds.includes("body") ? { kind: "body", body: face.body } : null;
    if (plane) return plane;
    if (profile) return profile;
    return null;
  }

  // ---------- active sketch overlay ----------
  // The overlay is rebuilt on every sketch mouse move, so its objects are kept and only the parts whose
  // data changed are replaced: disposing the materials each move made three.js drop and recompile their
  // shader programs, ~12 ms a frame (bug report 2026-10-18 15:35, "it lags a bunch" while sketching).
  setSketchOverlay(data) {
    const c = this.ovCache || (this.ovCache = { prof: null, segs: [], pts: {} });
    if (!data) {
      this.disposeGroup(this.groups.overlay); this.ovCache = null;
      this.sketchGrid.visible = false; this.sketchPlane = null; this.grid.visible = this.showGrid; this.dirty = true; return;
    }
    this.sketchPlane = data.plane;
    const m = planeMatrix(data.plane);
    this.sketchGrid.matrix.copy(m).multiply(new THREE.Matrix4().makeScale(1e5, 1e5, 1));
    this.sketchGrid.visible = data.showGrid !== false;
    this.grid.visible = false;
    if (!c.grp || c.grp.parent !== this.groups.overlay) {
      this.disposeGroup(this.groups.overlay);
      c.prof = null; c.segs = []; c.pts = {};
      c.grp = new THREE.Group(); c.grp.matrixAutoUpdate = false;
      c.profGrp = new THREE.Group();
      this.groups.overlay.add(c.profGrp, c.grp);
    }
    c.grp.matrix.copy(m);
    // profiles: same face objects (the sketcher keeps them until the sketch changes) -> same meshes
    const profs = data.profiles || [];
    const same = c.prof && c.prof.length === profs.length && profs.every((p, i) => p.face === c.prof[i].face && p.color === c.prof[i].color && p.opacity === c.prof[i].opacity);
    if (!same) {
      this.disposeGroup(c.profGrp);
      for (const p of profs) c.profGrp.add(this.faceMesh(K.meshFace(p.face), p.color ?? COLORS.profile, p.opacity ?? 0.25));
      c.prof = profs.map((p) => ({ face: p.face, color: p.color, opacity: p.opacity }));
    }
    const sameArr = (a, b) => { if (!a || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    const drop = (o) => { if (!o) return; c.grp.remove(o); o.geometry.dispose(); };
    const segs = data.segments || [];
    for (let i = 0; i < Math.max(segs.length, c.segs.length); i++) {
      const s = segs[i], old = c.segs[i];
      if (!s || !s.pos.length) { if (old) { drop(old.obj); c.segs[i] = null; } continue; }
      if (old && sameArr(old.pos, s.pos) && old.color === s.color && old.width === (s.width || 2) && old.dashed === !!s.dashed) continue;
      if (old && old.obj && old.color === s.color && old.width === (s.width || 2) && old.dashed === !!s.dashed) {
        // same style: swap the geometry only, keeping the material (and its compiled program)
        old.obj.geometry.dispose();
        old.obj.geometry = new LineSegmentsGeometry().setPositions(s.pos);
        if (s.dashed) old.obj.computeLineDistances();
        old.pos = s.pos.slice();
        continue;
      }
      if (old) { drop(old.obj); old.obj.material.dispose(); const k = this.lineMats.indexOf(old.obj.material); if (k >= 0) this.lineMats.splice(k, 1); }
      const l = this.fatLines(s.pos, s.color, s.width || 2, { dashed: s.dashed, depthTest: false });
      l.renderOrder = 8;
      c.grp.add(l);
      c.segs[i] = { obj: l, pos: s.pos.slice(), color: s.color, width: s.width || 2, dashed: !!s.dashed };
    }
    const pointsObj = (key, list, mat) => {
      const flat = list.flatMap((p) => [p[0], p[1], 0]);
      let o = c.pts[key];
      if (o && sameArr(o.flat, flat)) return;
      if (!o) {
        const obj = new THREE.Points(new THREE.BufferGeometry(), mat());
        obj.renderOrder = 9; c.grp.add(obj);
        o = c.pts[key] = { obj, flat: null };
      }
      o.obj.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
      o.obj.geometry = g; o.obj.visible = flat.length > 0; o.flat = flat;
    };
    pointsObj("points", data.points || [], () => new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, map: this.pointTex, transparent: true, depthTest: false }));
    pointsObj("snap", data.snapPoints || [], () => new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, color: COLORS.select, depthTest: false }));
    this.dirty = true;
  }

  // ---------- section analysis ----------
  // A clipping plane on the bodies (their shared materials, edges and highlights) plus stencil caps
  // (the three.js clipping-stencil technique): per body, its clipped back faces increment and its
  // front faces decrement the stencil, so it's nonzero exactly where a view ray enters the solid
  // through the cut; then a quad on the plane is drawn there with a normal depth test. The cap sits on
  // the true plane, so kept faces in front hide it and edges behind it don't show through. All GPU,
  // so dragging costs nothing; exact outlines and properties come from the kernel (sectionui.js).
  // (Two cheaper tries failed: back faces moved onto the plane in the shader jumped in front of real
  // faces; plain back faces let edges on steep inner walls show through the hatch.)
  /** sec: { normal: [x,y,z] pointing at the removed side, point: [x,y,z] on the plane, cap: "hatch"|"solid"|"none" } or null. */
  setSection(sec) {
    this.section = sec ? { cap: "hatch", ...sec } : null;
    this.renderer.localClippingEnabled = !!sec;
    if (sec) {
      const n = new THREE.Vector3(...sec.normal).normalize();
      const c = n.dot(new THREE.Vector3(...sec.point));
      // three.js keeps the positive side of a clipping plane: -n·x + c >= 0
      if (this.clipPlanes) this.clipPlanes[0].set(n.negate(), c); else this.clipPlanes = [new THREE.Plane(n.negate(), c)];
    } else this.clipPlanes = null;
    this.applyClipping();
    this.rebuildCaps();
    if (!sec) this.setSectionOutlines(null);
    this.dirty = true;
  }
  /** True when a world point is on the kept side of the section plane (or there's no section). */
  keptBySection(p) { return !this.clipPlanes || this.clipPlanes[0].distanceToPoint(p) >= -1e-6 * this.modelSize; }
  applyClipping() {
    const planes = this.clipPlanes;
    const set = (o) => {
      const m = o.material;
      if (!m || o.userData.noClip) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        if (x.clippingPlanes === planes) continue;
        x.clippingPlanes = planes;
        if (x.isShaderMaterial) x.clipping = !!planes; // LineMaterial (fat lines)
      }
    };
    this.groups.bodies.traverse(set);
    this.groups.highlight.traverse(set);
  }
  capMaterial(color, style) {
    const key = `${color}:${style}`;
    let m = this.capMats.get(key);
    if (m) return m;
    const base = new THREE.Color(color);
    const fill = style === "hatch" ? base.clone().lerp(new THREE.Color(0xffffff), 0.3) : base.clone().multiplyScalar(0.8);
    const u = { uHatch: { value: style === "hatch" ? 1 : 0 }, uInk: { value: base.clone().lerp(new THREE.Color(0x000000), 0.6) }, uPx: { value: this.renderer.getPixelRatio() } };
    m = new THREE.MeshBasicMaterial({
      color: fill, side: THREE.DoubleSide, toneMapped: false,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      // reset the stencil wherever the quad goes, so the next body starts from zero
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uHatch, uPx;\nuniform vec3 uInk;")
        .replace("#include <color_fragment>", "#include <color_fragment>\n  if (uHatch > 0.5 && mod(gl_FragCoord.x + gl_FragCoord.y, 9.0 * uPx) < 1.25 * uPx) diffuseColor.rgb = uInk;");
    };
    m.customProgramCacheKey = () => "sectionCap";
    m.userData.cached = true;
    this.capMats.set(key, m);
    return m;
  }
  stencilMaterial(side) {
    const k = side === THREE.BackSide ? "back" : "front";
    this._stencilMats = this._stencilMats || {};
    let m = this._stencilMats[k];
    if (!m) {
      const op = side === THREE.BackSide ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp;
      m = new THREE.MeshBasicMaterial({ side, colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op });
      m.userData.cached = true;
      this._stencilMats[k] = m;
    }
    m.clippingPlanes = this.clipPlanes;
    return m;
  }
  rebuildCaps() {
    for (const v of this.bodyViews) if (v.caps) { for (const o of v.caps) o.parent && o.parent.remove(o); v.caps = null; }
    if (this.capGroup) { this.scene.remove(this.capGroup); this.capGroup.traverse((o) => { if (o.geometry && o.userData.ownGeo) o.geometry.dispose(); }); this.capGroup = null; }
    const sec = this.section;
    if (!sec || sec.cap === "none") { this.dirty = true; return; }
    // one quad on the plane per body, big enough for the whole model
    const n = new THREE.Vector3(...sec.normal).normalize();
    const p0 = new THREE.Vector3(...sec.point);
    const box = new THREE.Box3();
    for (const v of this.bodyViews) box.union(this.bodyWorldBox(v));
    const c = box.isEmpty() ? p0.clone() : box.getCenter(new THREE.Vector3());
    c.addScaledVector(n, -n.dot(c.clone().sub(p0)));
    const size = Math.max(this.modelSize, 1) * 4;
    const quadGeo = new THREE.PlaneGeometry(size, size);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.capGroup = new THREE.Group();
    this.scene.add(this.capGroup);
    let order = 100;
    for (const v of this.bodyViews) {
      if (this.ghost && this.ghost.has(v.id)) continue;
      const back = new THREE.Mesh(v.mesh.geometry, this.stencilMaterial(THREE.BackSide));
      const front = new THREE.Mesh(v.mesh.geometry, this.stencilMaterial(THREE.FrontSide));
      back.renderOrder = order; front.renderOrder = order + 1;
      back.userData = front.userData = { kind: "capStencil", noClip: true, body: v.id };
      v.grp.add(back, front);
      const ap = resolveAppearance(this.appearances[v.id]).renderParams;
      const quad = new THREE.Mesh(quadGeo, this.capMaterial(new THREE.Color(ap.color).getHex(), sec.cap));
      quad.position.copy(c); quad.quaternion.copy(quat);
      quad.renderOrder = order + 2;
      quad.userData = { kind: "cap", body: v.id, noClip: true };
      quad.visible = v.grp.visible;
      this.capGroup.add(quad);
      v.caps = [back, front, quad];
      order += 3;
    }
    if (this.capGroup.children[0]) this.capGroup.children[0].userData.ownGeo = true;
    this.capGroup.updateMatrixWorld(true);
    this.dirty = true;
  }
  /** Exact section outlines: [{ body, lines (flat xyz, in the body's modelled coordinates) }] or null. */
  setSectionOutlines(list) {
    this.disposeGroup(this.groups.section);
    if (list && this.section) {
      // nudge toward the removed side (the viewer's side of the cap) so the lines win the depth test
      const n = new THREE.Vector3(...this.section.normal).normalize().multiplyScalar(this.modelSize * 4e-4);
      for (const o of list) {
        const bv = this.bodyViews.find((b) => b.id === o.body);
        if (!bv || !bv.grp.visible || !o.lines || !o.lines.length) continue;
        const l = this.fatLines(o.lines, COLORS.edge, 1.8);
        l.userData.noClip = true;
        this.followBody(l, bv);
        l.matrix.premultiply(new THREE.Matrix4().makeTranslation(n.x, n.y, n.z));
        this.groups.section.add(l);
      }
      this.groups.section.updateMatrixWorld(true);
    }
    this.dirty = true;
  }

  // ---------- move / rotate gizmo (feature request 2026-10-09) ----------
  // World-aligned triad at `position`: X/Y/Z arrows translate along an axis, the small squares in a
  // plane, the centre ball in the screen plane, and the rings rotate about an axis. Handlers get the
  // total change since the drag started: onDrag({ kind: "t", vec: [x,y,z] } | { kind: "r", axis, angle (deg) }, event).
  showGizmo(opts) {
    this.hideGizmo();
    const grp = new THREE.Group();
    const AX = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const COL = [0xd0453a, 0x3fae4a, 0x3a6fd0];
    const handles = [];
    const mat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity, side: THREE.DoubleSide });
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    const up = new THREE.Vector3(0, 1, 0);
    const add = (handle, visuals, hit) => {
      for (const v of visuals) { v.renderOrder = 21; grp.add(v); }
      hit.userData.handle = handle; grp.add(hit);
      handle.visuals = visuals; handle.hit = hit;
      handles.push(handle);
    };
    for (let i = 0; i < 3; i++) {
      const q = new THREE.Quaternion().setFromUnitVectors(up, AX[i]);
      // translate arrow
      const m = mat(COL[i]);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.8, 8), m);
      shaft.position.copy(AX[i]).multiplyScalar(0.25 + 0.4); shaft.quaternion.copy(q);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 16), m);
      head.position.copy(AX[i]).multiplyScalar(1.16); head.quaternion.copy(q);
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.05, 8), hidden);
      hit.position.copy(AX[i]).multiplyScalar(0.25 + 0.525); hit.quaternion.copy(q);
      add({ kind: "axis", axis: i, color: COL[i], mats: [m] }, [shaft, head], hit);
      // rotation ring about axis i (a torus lies in its local XY plane: turn its Z onto the axis)
      const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), AX[i]);
      const rm = mat(COL[i], 0.85);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.014, 6, 64), rm);
      ring.quaternion.copy(rq);
      const rhit = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 6, 48), hidden);
      rhit.quaternion.copy(rq);
      add({ kind: "ring", axis: i, color: COL[i], mats: [rm] }, [ring], rhit);
      // plane square (normal = axis i), between the other two arrows
      const a = AX[(i + 1) % 3], b = AX[(i + 2) % 3];
      const pm = mat(COL[i], 0.45);
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), pm);
      sq.quaternion.copy(rq); sq.position.copy(a).add(b).multiplyScalar(0.3);
      const shit = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), hidden);
      shit.quaternion.copy(rq); shit.position.copy(sq.position);
      add({ kind: "plane", axis: i, color: COL[i], mats: [pm] }, [sq], shit);
    }
    const cm = mat(0xdddddd);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), cm);
    add({ kind: "screen", color: 0xdddddd, mats: [cm] }, [ball], new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), hidden));
    grp.matrixAutoUpdate = true;
    this.gizmo = { ...opts, grp, handles, hover: null };
    this.groups.manip.add(grp);
    this.setGizmoPosition(opts.position || [0, 0, 0]);
  }
  hideGizmo() {
    if (!this.gizmo) return;
    this.groups.manip.remove(this.gizmo.grp);
    this.gizmo.grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.gizmo = null;
    if (this.drag && this.drag.mode === "gizmo") this.drag = null;
    this.dirty = true;
  }
  setGizmoPosition(p) {
    const g = this.gizmo; if (!g) return;
    g.grp.position.set(p[0], p[1], p[2]);
    this.updateManipScale();
    this.dirty = true;
  }
  hitGizmo(cx, cy) {
    const g = this.gizmo; if (!g || !g.grp.visible) return null;
    this.ray(cx, cy);
    g.grp.updateMatrixWorld(true);
    const hits = this.raycaster.intersectObjects(g.handles.map((h) => h.hit), false);
    if (!hits.length) return null;
    // the arrows and squares win over the rings they overlap
    const rank = { screen: 0, plane: 1, axis: 2, ring: 3 };
    hits.sort((a, b) => rank[a.object.userData.handle.kind] - rank[b.object.userData.handle.kind] || a.distance - b.distance);
    return hits[0].object.userData.handle;
  }
  updateGizmoHover(e) {
    const g = this.gizmo; if (!g) return false;
    const h = this.drag && this.drag.mode === "gizmo" ? this.drag.handle : this.hitGizmo(e.clientX, e.clientY);
    if (h !== g.hover) {
      if (g.hover) g.hover.mats.forEach((m) => m.color.setHex(g.hover.color));
      if (h) h.mats.forEach((m) => m.color.setHex(0xffc83d));
      g.hover = h; this.dirty = true;
    }
    if (h) this.canvas.style.cursor = "grab";
    return !!h;
  }
  /** Ray hit on the plane through `o` with normal `n` (THREE vectors), or null. */
  rayPlane(cx, cy, o, n) {
    const ray = this.ray(cx, cy), den = n.dot(ray.direction);
    if (Math.abs(den) < 1e-6) return null;
    return ray.origin.clone().addScaledVector(ray.direction, o.clone().sub(ray.origin).dot(n) / den);
  }
  /** Parameter along the line o + u·t closest to the cursor ray. */
  lineParam(cx, cy, o, u) {
    const ray = this.ray(cx, cy), w0 = o.clone().sub(ray.origin);
    const b = u.dot(ray.direction), d = u.dot(w0), e = ray.direction.dot(w0), den = 1 - b * b;
    return den < 1e-6 ? null : (b * e - d) / den;
  }
  gizmoStart(handle, e) {
    const g = this.gizmo, o = g.grp.position.clone();
    const d = { handle, o };
    const AX = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    if (handle.kind === "axis") { d.u = AX[handle.axis]; d.t0 = this.lineParam(e.clientX, e.clientY, o, d.u); }
    else {
      d.n = handle.kind === "screen" ? this.camera.getWorldDirection(new THREE.Vector3()) : AX[handle.axis].clone();
      d.p0 = this.rayPlane(e.clientX, e.clientY, o, d.n);
      d.angle = 0; d.prev = d.p0 && d.p0.clone().sub(o);
    }
    if (g.onStart) g.onStart(handle);
    return d;
  }
  gizmoMove(d, e) {
    const g = this.gizmo; if (!g) return;
    const h = d.handle;
    if (h.kind === "axis") {
      const t = this.lineParam(e.clientX, e.clientY, d.o, d.u);
      if (t == null || d.t0 == null) return;
      g.onDrag({ kind: "t", vec: d.u.clone().multiplyScalar(t - d.t0).toArray(), axis: h.axis }, e);
    } else if (h.kind === "plane" || h.kind === "screen") {
      const p = this.rayPlane(e.clientX, e.clientY, d.o, d.n);
      if (!p || !d.p0) return;
      const v = p.sub(d.p0);
      const far = this.worldPerPixel(d.o) * Math.max(this.width, this.height) * 4; // grazing angles shoot off to infinity
      if (v.length() > far) return;
      g.onDrag({ kind: "t", vec: v.toArray() }, e);
    } else if (h.kind === "ring") {
      const p = this.rayPlane(e.clientX, e.clientY, d.o, d.n);
      if (!p || !d.prev) return;
      const v = p.sub(d.o);
      if (v.length() < 1e-9) return;
      // unwrap: add the small signed step since the last event
      const step = Math.atan2(d.prev.clone().cross(v).dot(d.n), d.prev.dot(v));
      d.angle += step; d.prev = v;
      g.onDrag({ kind: "r", axis: h.axis, angle: THREE.MathUtils.radToDeg(d.angle) }, e);
    }
  }

  // ---------- arrow manipulator ----------
  showArrow(opts) {
    this.hideArrow();
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x2b7fd4, depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 8), mat);
    shaft.position.y = 0.375;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 16), mat);
    head.position.y = 0.85;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.05, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.5;
    const inner = new THREE.Group(); inner.add(shaft, head, hit);
    grp.add(inner);
    grp.renderOrder = 20; shaft.renderOrder = head.renderOrder = 20;
    this.arrow = { ...opts, grp, inner, mat, hit, value: opts.value };
    this.groups.manip.add(grp);
    this.positionArrow();
  }
  hideArrow() { if (this.arrow) { this.disposeGroup(this.groups.manip); this.arrow = null; this.dirty = true; } }
  positionArrow() {
    const a = this.arrow; if (!a) return;
    const dir = new THREE.Vector3(...a.dir).normalize();
    const flip = a.value < 0 ? -1 : 1;
    a.grp.position.set(...a.origin).addScaledVector(dir, a.value * (a.scaleValue ?? 1));
    a.grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().multiplyScalar(flip));
    this.updateManipScale();
    this.dirty = true;
  }
  updateManipScale() {
    if (this.gizmo) this.gizmo.grp.scale.setScalar(this.worldPerPixel(this.gizmo.grp.position) * 95);
    if (!this.arrow) return;
    const s = this.worldPerPixel(this.arrow.grp.position) * 70;
    this.arrow.grp.scale.setScalar(s);
  }
  hitArrow(cx, cy) {
    this.ray(cx, cy);
    this.scene.updateMatrixWorld();
    return this.raycaster.intersectObject(this.arrow.hit, false).length > 0;
  }
  updateArrowHover(e) {
    if (!this.arrow) return;
    const h = this.hitArrow(e.clientX, e.clientY);
    const c = h ? 0x63b8f2 : 0x2b7fd4;
    if (this.arrow.mat.color.getHex() !== c) { this.arrow.mat.color.setHex(c); this.dirty = true; }
    this.canvas.style.cursor = h ? "grab" : "";
  }
  axisParam(cx, cy) {
    const a = this.arrow, ray = this.ray(cx, cy);
    const p0 = new THREE.Vector3(...a.origin), u = new THREE.Vector3(...a.dir).normalize();
    const w0 = p0.clone().sub(ray.origin);
    const b = u.dot(ray.direction), d = u.dot(w0), e = ray.direction.dot(w0);
    const den = 1 - b * b;
    if (den < 1e-6) return null;
    return ((b * e - d) / den) / (a.scaleValue ?? 1);
  }
  arrowTipScreen() {
    if (!this.arrow) return null;
    const dir = new THREE.Vector3(...this.arrow.dir).normalize();
    const p = this.arrow.grp.position.clone().addScaledVector(dir, this.arrow.grp.scale.x * 1.1 * (this.arrow.value < 0 ? -1 : 1));
    return this.worldToScreen(p);
  }
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Centre of the circle through three 3D points, or null when they're (nearly) collinear. */
function circumcentre(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (nn < 1e-12 * Math.pow(ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2], 2)) return null;
  const ab2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2], ac2 = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
  // a + (|ab|^2 (ac x n) + |ac|^2 (n x ab)) / (2 |n|^2)
  const t1 = [ac[1] * n[2] - ac[2] * n[1], ac[2] * n[0] - ac[0] * n[2], ac[0] * n[1] - ac[1] * n[0]];
  const t2 = [n[1] * ab[2] - n[2] * ab[1], n[2] * ab[0] - n[0] * ab[2], n[0] * ab[1] - n[1] * ab[0]];
  return [0, 1, 2].map((i) => a[i] + (ab2 * t1[i] + ac2 * t2[i]) / (2 * nn));
}

/** A sketch plane moved by a column-major 4x4 placement (rigid), as a new { origin, xDir, normal }. */
export function transformPlane(p, m) {
  if (!m || m.length !== 16) return p;
  const pt = (v) => [0, 1, 2].map((i) => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i]);
  const dir = (v) => [0, 1, 2].map((i) => m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2]);
  return { ...p, origin: pt(p.origin), xDir: dir(p.xDir), normal: dir(p.normal) };
}
/** Inverse of a rigid column-major 4x4 placement (rotation + translation), or null. */
export function invertRigid(m) {
  if (!m || m.length !== 16) return null;
  const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], t = [m[12], m[13], m[14]];
  // R^T, -R^T t
  const out = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) out[12 + i] = -(out[i] * t[0] + out[4 + i] * t[1] + out[8 + i] * t[2]);
  return out;
}
