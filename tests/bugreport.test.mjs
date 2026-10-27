// Bug report endpoint test: node tests/bugreport.test.mjs [baseUrl]
// Without a baseUrl it starts its own Vite dev server on port 5191.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server = null;
let base = process.argv[2];
if (!base) {
  const { createServer } = await import("vite");
  server = await createServer({ root, configFile: path.join(root, "vite.config.js"), server: { port: 5191, strictPort: true }, logLevel: "warn" });
  await server.listen();
  base = "http://localhost:5191";
}

const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("ok  " + m); };
// 1x1 red PNG
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const payload = {
  version: 1,
  memo: "TEST fillet fails after undo!",
  createdAt: new Date().toISOString(),
  nowT: 20000,
  url: "http://localhost:5180/",
  userAgent: "node-test",
  viewport: { w: 1600, h: 900, dpr: 1, canvas: { x: 0, y: 90, w: 1600, h: 810 } },
  appState: { mode: "model", features: 3 },
  doc: { version: 1, features: [{ type: "box" }] },
  screenshot: png,
  events: [
    { t: 7700, type: "pointerdown", btn: "L", x: 512, y: 300, target: "button#btnSave" },
    { t: 8000, type: "wheel", count: 6, dy: -600, x: 800, y: 400, target: "canvas#view" },
    { t: 9000, type: "keydown", key: "f" },
    { t: 9500, type: "input", value: "2 mm", target: "input[type=text] in #dialog" },
    { t: 10000, type: "app", name: "command started", data: { name: "Fillet" } },
    { t: 11000, type: "console.error", message: "boom\nstack" },
  ],
  padding: "x".repeat(20 * 1024 * 1024), // exercise large bodies
};

try {
  const res = await fetch(base + "/api/bug-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json();
  assert(res.ok && data.ok, "POST /api/bug-report -> ok");
  assert(/^bug-reports\/\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_test-fillet-fails-after-undo$/.test(data.path), "path " + data.path);
  const dir = path.join(root, data.path);
  const files = (await fs.readdir(dir)).sort();
  assert(files.join() === "README.md,design.cadm.json,report.json,screenshot.png", "files: " + files.join(", "));
  const readme = await fs.readFile(path.join(dir, "README.md"), "utf8");
  assert(readme.includes("-12.3s  pointerdown L @(512,300) on button#btnSave"), "readme event line");
  assert(readme.includes("wheel x6 dy=-600"), "readme wheel line");
  const report = JSON.parse(await fs.readFile(path.join(dir, "report.json"), "utf8"));
  assert(report.screenshot === "screenshot.png" && report.events.length === 6, "report.json without screenshot data");
  const shot = await fs.readFile(path.join(dir, "screenshot.png"));
  assert(shot.subarray(1, 4).toString() === "PNG", "screenshot decoded");
  const get = await fetch(base + "/api/bug-report");
  assert(get.status === 405, "GET rejected");
  if (!process.env.KEEP) await fs.rm(dir, { recursive: true });
  console.log(process.env.KEEP ? "kept " + dir : "cleaned up test report");
} finally {
  if (server) await server.close();
}
