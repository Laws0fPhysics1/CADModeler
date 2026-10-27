// Section Analysis: exact plane cuts (area, centroid, second moments) against closed-form values
import * as K from "../src/kernel.js";
await K.initKernel();
let fails = 0;
const near = (a, b, tol, msg) => { const ok = Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)); console.log(`${ok ? "ok  " : "FAIL"} ${msg}: ${a.toFixed(4)} vs ${b.toFixed(4)}`); if (!ok) fails++; };
const body = (f) => K.evaluate([{ id: "f1", name: "p", ...f }], 1).bodies[0].shape;

// 40 x 20 x 10 box at the origin (x 0..40? use the kernel's convention: read the bounds)
const box = body({ type: "box", length: 40, width: 20, height: 10, operation: "new" });
const bb = K.bodyInfo(box).bounds;
const mid = (i) => (bb[0][i] + bb[1][i]) / 2;
// cut with YZ through the middle: a 20 x 10 rectangle
let s = K.sectionBody(box, { origin: [mid(0), 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] });
near(s.area, 200, 1e-6, "box YZ area");
near(s.perimeter, 60, 1e-6, "box YZ perimeter");
near(s.Iu, (20 * 10 ** 3) / 12, 1e-6, "box Iu = b h³/12");
near(s.Iv, (10 * 20 ** 3) / 12, 1e-6, "box Iv = h b³/12");
near(s.Iuv, 0, 1e-6, "box Iuv");
near(s.centroid[2], mid(2), 1e-6, "box centroid z");
// a plane that misses the body
const miss = K.sectionBody(box, { origin: [bb[1][0] + 5, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] });
console.log(`${miss === null ? "ok  " : "FAIL"} miss returns null`); if (miss !== null) fails++;

// cylinder r 10: XY cut through it = circle, I = π r⁴ / 4
const cyl = body({ type: "cylinder", radius: 10, height: 30, operation: "new" });
const cb = K.bodyInfo(cyl).bounds;
s = K.sectionBody(cyl, { origin: [0, 0, (cb[0][2] + cb[1][2]) / 2], xDir: [1, 0, 0], normal: [0, 0, 1] });
near(s.area, Math.PI * 100, 1e-6, "cylinder area (exact B-rep)");
near(s.perimeter, 2 * Math.PI * 10, 1e-6, "cylinder perimeter");
near(s.Iu, (Math.PI * 1e4) / 4, 2e-3, "cylinder Iu = π r⁴/4 (triangulated)");
console.log(`${s.lines.length > 0 ? "ok  " : "FAIL"} outline has segments (${s.lines.length / 6})`); if (!s.lines.length) fails++;

console.log(fails ? `\n${fails} failed` : "\nall section tests passed");
process.exit(fails ? 1 : 0);
