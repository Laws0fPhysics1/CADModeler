// GPU (WebGL2) version of the 2D lattice Boltzmann solver in cfd2d.js: same D2Q9 BGK +
// Smagorinsky collision, pull streaming, halfway bounce-back, inlet / far-field / outlet and
// sponge, so its forces match the CPU class (tests/cfd2d.test.mjs runs the CPU one).
//
// State lives in float textures (nx * ny): A = f0..f3, B = f4..f7, C = (f8, rho, ux, uy),
// ping-ponged through one framebuffer with four colour attachments; the fourth (F) holds each
// fluid cell's bounce-back momentum, read back over the body's bounding box for the forces.
// The same GL context draws the colour-mapped field (draw()).
import { W } from "./cfd2d.js";

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const STEP_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D A, B, C, M;
uniform ivec2 size;
uniform vec2 uin;
uniform float tau0, cs2, sx0;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
layout(location = 3) out vec4 oF;
const ivec2 CI[9] = ivec2[9](ivec2(0,0), ivec2(1,0), ivec2(0,1), ivec2(-1,0), ivec2(0,-1), ivec2(1,1), ivec2(-1,1), ivec2(-1,-1), ivec2(1,-1));
const float WI[9] = float[9](${W.map((w) => w.toFixed(9)).join(", ")});
const int OPP[9] = int[9](0, 3, 4, 1, 2, 7, 8, 5, 6);
float comp(ivec2 q, int i) {
  if (i < 4) return texelFetch(A, q, 0)[i];
  if (i < 8) return texelFetch(B, q, 0)[i - 4];
  return texelFetch(C, q, 0).x;
}
float feq(int i, float rho, vec2 u) {
  float cu = 3.0 * dot(vec2(CI[i]), u);
  return WI[i] * rho * (1.0 + cu + 0.5 * cu * cu - 1.5 * dot(u, u));
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  if (texelFetch(M, q, 0).r > 0.5) { oA = vec4(0); oB = vec4(0); oC = vec4(0, 1, 0, 0); oF = vec4(0); return; }
  float f[9];
  vec2 mom = vec2(0);
  for (int i = 0; i < 9; i++) {
    ivec2 n = q - CI[i];
    if (n.x < 0) { f[i] = feq(i, 1.0, uin); continue; }
    n = clamp(n, ivec2(0), size - 1); // zero-gradient top, bottom and outlet
    if (texelFetch(M, n, 0).r > 0.5) { float b = comp(q, OPP[i]); f[i] = b; mom += 2.0 * b * vec2(CI[i]); continue; }
    f[i] = comp(n, i);
  }
  float rho = 0.0; vec2 u = vec2(0);
  for (int i = 0; i < 9; i++) { rho += f[i]; u += f[i] * vec2(CI[i]); }
  u /= rho;
  float pxx = 0.0, pyy = 0.0, pxy = 0.0;
  float ne[9];
  for (int i = 0; i < 9; i++) {
    ne[i] = f[i] - feq(i, rho, u);
    vec2 c = vec2(CI[i]);
    pxx += c.x * c.x * ne[i]; pyy += c.y * c.y * ne[i]; pxy += c.x * c.y * ne[i];
  }
  float Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  float t = q.x + 1 <= int(sx0) ? 0.0 : (float(q.x + 1) - sx0) / (float(size.x + 2) - sx0);
  float t0 = tau0 + t * t * 1.2;
  float om = 2.0 / (t0 + sqrt(t0 * t0 + cs2 * Q / rho));
  for (int i = 0; i < 9; i++) f[i] -= om * ne[i];
  oA = vec4(f[0], f[1], f[2], f[3]);
  oB = vec4(f[4], f[5], f[6], f[7]);
  oC = vec4(f[8], rho, u);
  oF = vec4(mom, 0, 0);
}`;

const INIT_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 oA; layout(location = 1) out vec4 oB; layout(location = 2) out vec4 oC; layout(location = 3) out vec4 oF;
void main() {
  oA = vec4(${W.slice(0, 4).map((w) => w.toFixed(9)).join(", ")});
  oB = vec4(${W.slice(4, 8).map((w) => w.toFixed(9)).join(", ")});
  oC = vec4(${W[8].toFixed(9)}, 1.0, 0.0, 0.0); oF = vec4(0);
}`;

// field display: speed / vorticity / pressure through a colour map, the body in grey
const DRAW_FS = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D C, M;
uniform ivec2 size;
uniform vec4 view;      // x0, y0, x1, y1 in cells
uniform int mode;       // 0 speed, 1 vorticity, 2 pressure
uniform float U, range, solidShade;
in vec2 uv; out vec4 o;
vec3 rainbow(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.05, 0.19, 0.85), c1 = vec3(0.0, 0.72, 0.95), c2 = vec3(0.15, 0.85, 0.25), c3 = vec3(1.0, 0.85, 0.05), c4 = vec3(0.9, 0.08, 0.05);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
vec3 diverge(float t) { // blue - white - red
  t = clamp(t, -1.0, 1.0);
  return t < 0.0 ? mix(vec3(0.97), vec3(0.1, 0.3, 0.85), -t) : mix(vec3(0.97), vec3(0.85, 0.12, 0.08), t);
}
vec4 at(ivec2 q) { return texelFetch(C, clamp(q, ivec2(0), size - 1), 0); }
void main() {
  vec2 cell = mix(view.xy, view.zw, uv);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= float(size.x) || cell.y >= float(size.y)) { o = vec4(0.12, 0.13, 0.15, 1); return; }
  ivec2 q = ivec2(cell);
  if (texelFetch(M, q, 0).r > 0.5) { o = vec4(vec3(solidShade), 1); return; }
  vec4 c = at(q);
  vec3 col;
  if (mode == 0) col = rainbow(length(c.zw) / (U * range));
  else if (mode == 1) {
    float w = (at(q + ivec2(1, 0)).w - at(q - ivec2(1, 0)).w - at(q + ivec2(0, 1)).z + at(q - ivec2(0, 1)).z) * 0.5;
    col = diverge(w / (U * 0.08 * range));
  } else col = diverge(((c.y - 1.0) / 3.0) / (0.5 * U * U) / range);
  o = vec4(col, 1);
}`;

function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("2D flow shader: " + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "p");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("2D flow shader link: " + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}

/** True when this browser can run the GPU solver (WebGL2 + float render targets). */
export function gpuAvailable() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ok = !!(gl && gl.getExtension("EXT_color_buffer_float"));
    gl && gl.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch { return false; }
}

export class LBM2DGPU {
  /** cs: a case from cfd2d.setupCase; canvas: the panel's canvas (its WebGL2 context is used for both solve and display). */
  constructor(cs, canvas) {
    this.cs = cs;
    const gl = (this.gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true }));
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) throw new Error("WebGL2 float render targets aren't available");
    const { nx, ny } = cs;
    if (nx > gl.getParameter(gl.MAX_TEXTURE_SIZE) || ny > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("Grid too large for this GPU");
    this.step_ = compile(gl, VS, STEP_FS);
    this.init_ = compile(gl, VS, INIT_FS);
    this.draw_ = compile(gl, VS, DRAW_FS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (fmt, type, ifmt, data = null) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, nx, ny, 0, fmt, type, data);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const mask = new Uint8Array(nx * ny);
    for (let k = 0; k < mask.length; k++) mask[k] = cs.solid[k] ? 255 : 0;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.mask = tex(gl.RED, gl.UNSIGNED_BYTE, gl.R8, mask);
    this.sets = [0, 1].map(() => {
      const t = [0, 1, 2, 3].map(() => tex(gl.RGBA, gl.FLOAT, gl.RGBA32F));
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      t.forEach((x, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, x, 0));
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("2D flow framebuffer incomplete");
      return { t, fb };
    });
    this.cur = 0;
    // forces: read F over the body's bounding box plus a cell
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (cs.solid[j * nx + i]) { i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    this.box = { x: Math.max(0, i0 - 1), y: Math.max(0, j0 - 1) };
    this.box.w = Math.min(nx, i1 + 2) - this.box.x; this.box.h = Math.min(ny, j1 + 2) - this.box.y;
    this.fbuf = new Float32Array(this.box.w * this.box.h * 4);
    this.t = 0;
    this.ramp = Math.max(400, Math.round((2 * cs.refCells) / cs.U));
    this.sx0 = Math.floor((nx + 2) * 0.88);
    this.Fx = 0; this.Fy = 0;
    this.history = [];
    this.init();
  }
  uIn() { const s = Math.min(1, this.t / this.ramp); return this.cs.U * (s * s * (3 - 2 * s)); }
  vIn() { return this.t < this.ramp ? 0.03 * this.cs.U * Math.sin((2 * Math.PI * this.t) / this.ramp) : 0; }
  quad() { this.gl.bindVertexArray(this.vao); this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4); }
  init() {
    const gl = this.gl;
    gl.useProgram(this.init_.p);
    gl.viewport(0, 0, this.cs.nx, this.cs.ny);
    for (const s of this.sets) { gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb); this.quad(); }
    this.t = 0; this.history = [];
  }
  step(n = 1, { sampleEvery = 10 } = {}) {
    const gl = this.gl, { p, u } = this.step_, { nx, ny } = this.cs;
    gl.useProgram(p);
    gl.viewport(0, 0, nx, ny);
    gl.uniform2i(u.size, nx, ny);
    gl.uniform1f(u.tau0, this.cs.tau);
    gl.uniform1f(u.cs2, this.cs.cs * this.cs.cs * 18 * Math.SQRT2);
    gl.uniform1f(u.sx0, this.sx0);
    ["A", "B", "C", "M"].forEach((k, i) => gl.uniform1i(u[k], i));
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.mask);
    for (let s = 0; s < n; s++) {
      const src = this.sets[this.cur], dst = this.sets[1 - this.cur];
      for (let i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, src.t[i]); }
      gl.uniform2f(u.uin, this.uIn(), this.vIn());
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      this.quad();
      this.cur = 1 - this.cur;
      this.t++;
      if (this.t % sampleEvery === 0) this.sampleForces();
    }
  }
  sampleForces() {
    const gl = this.gl, b = this.box;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sets[this.cur].fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT3);
    gl.readPixels(b.x, b.y, b.w, b.h, gl.RGBA, gl.FLOAT, this.fbuf);
    let fx = 0, fy = 0;
    for (let k = 0; k < this.fbuf.length; k += 4) { fx += this.fbuf[k]; fy += this.fbuf[k + 1]; }
    this.Fx = -fx; this.Fy = -fy;
    const U = this.cs.U, q = 0.5 * U * U * this.cs.refCells;
    this.history.push({ t: this.t, cd: this.Fx / q, cl: this.Fy / q });
    if (this.history.length > 6000) this.history.splice(0, this.history.length - 6000);
  }
  get passes() { return (this.t * this.cs.U) / this.cs.refCells; }
  mean(window = 2) {
    const U = this.cs.U, Lc = this.cs.refCells;
    const tMin = Math.max(this.ramp * 1.5, this.t - (window * Lc) / U);
    const h = this.history.filter((p) => p.t >= tMin);
    if (h.length < 5) return null;
    let cd = 0, cl = 0, clMin = Infinity, clMax = -Infinity;
    for (const p of h) { cd += p.cd; cl += p.cl; clMin = Math.min(clMin, p.cl); clMax = Math.max(clMax, p.cl); }
    return { cd: cd / h.length, cl: cl / h.length, clAmp: (clMax - clMin) / 2, n: h.length };
  }
  physical(c) {
    const { fluid, speed, refLength } = this.cs;
    const q = 0.5 * fluid.rho * speed * speed * refLength * 1e-3;
    return { drag: c.cd * q, lift: c.cl * q };
  }
  /** Read rho / ux / uy back (for streamlines and probes). */
  fields(out) {
    const gl = this.gl, { nx, ny } = this.cs, n = nx * ny;
    const raw = (this._raw = this._raw && this._raw.length === n * 4 ? this._raw : new Float32Array(n * 4));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sets[this.cur].fb);
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(0, 0, nx, ny, gl.RGBA, gl.FLOAT, raw);
    out = out || { rho: new Float32Array(n), ux: new Float32Array(n), uy: new Float32Array(n) };
    for (let k = 0; k < n; k++) { out.rho[k] = raw[4 * k + 1]; out.ux[k] = raw[4 * k + 2]; out.uy[k] = raw[4 * k + 3]; }
    return out;
  }
  /** Draw the field into the canvas. view = [x0, y0, x1, y1] in cells; mode 0 speed, 1 vorticity, 2 pressure. */
  draw(view, mode = 0, range = 1, dark = false) {
    const gl = this.gl, { p, u } = this.draw_;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sets[this.cur].t[2]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.uniform1i(u.C, 0); gl.uniform1i(u.M, 1);
    gl.uniform2i(u.size, this.cs.nx, this.cs.ny);
    gl.uniform4f(u.view, ...view);
    gl.uniform1i(u.mode, mode);
    gl.uniform1f(u.U, this.cs.U);
    gl.uniform1f(u.range, range);
    gl.uniform1f(u.solidShade, dark ? 0.55 : 0.42);
    this.quad();
  }
  dispose() {
    const gl = this.gl;
    for (const s of this.sets) { s.t.forEach((t) => gl.deleteTexture(t)); gl.deleteFramebuffer(s.fb); }
    gl.deleteTexture(this.mask);
    for (const x of [this.step_, this.init_, this.draw_]) gl.deleteProgram(x.p);
  }
}
