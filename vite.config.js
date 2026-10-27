import { defineConfig } from "vite";
import path from "node:path";
import { createRequire } from "node:module";

// Shared with the Electron main process so both write the same folder layout.
const require = createRequire(import.meta.url);
const { writeBugReport, listBugReports, setBugStatus } = require("./electron/bugreport-writer.cjs");
const { createCfdRunner } = require("./electron/cfd-runner.cjs");
const { createFeaRunner, feaDefaults, createDevHandler: createFeaHandler } = require("./electron/fea-runner.cjs");
const os = require("node:os");
const partsStore = require("./electron/parts-store.cjs");

const MAX_BODY = 30 * 1024 * 1024; // screenshots + designs; ~25 MB payloads

// ---------- bug report saving (dev server only) ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("payload too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bugReportPlugin() {
  return {
    name: "bug-report",
    configureServer(server) {
      // list + status (the in-app Bug Reports panel); registered first so "/api/bug-report" doesn't swallow it
      server.middlewares.use("/api/bug-reports", async (req, res) => {
        const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        const dir = (kind) => path.join(server.config.root, kind === "feature" ? "feature-requests" : "bug-reports");
        try {
          if (req.method === "GET") return send(200, [...(await listBugReports(dir("bug"), "bug")), ...(await listBugReports(dir("feature"), "feature"))]);
          if (req.method === "POST") { const { name, status, note, kind } = JSON.parse(await readBody(req)); return send(200, { ok: true, status: await setBugStatus(dir(kind), name, { status, note, by: "user" }) }); }
          send(405, { ok: false, error: "GET or POST" });
        } catch (err) { send(400, { ok: false, error: String(err.message || err) }); }
      });
      server.middlewares.use("/api/bug-report", async (req, res) => {
        const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
        try {
          const payload = JSON.parse(await readBody(req));
          const folder = payload && payload.kind === "feature" ? "feature-requests" : "bug-reports";
          const { name } = await writeBugReport(path.join(server.config.root, folder), payload);
          const rel = `${folder}/${name}`;
          server.config.logger.info(`bug report saved: ${rel}`);
          send(200, { ok: true, path: rel });
        } catch (err) {
          send(err.status || 500, { ok: false, error: String(err.message || err) });
        }
      });
    },
  };
}

// ---------- Parts folder (dev server only; the desktop app uses IPC): read-only bin for the preview ----------
function partsPlugin() {
  return {
    name: "parts-folder",
    configureServer(server) {
      const dir = () => partsStore.resolvePartsDir({ appRoot: server.config.root, packaged: false });
      server.middlewares.use("/api/parts", async (req, res) => {
        const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        if (req.method !== "POST") return send(405, { error: "POST only" });
        try {
          const a = JSON.parse(await readBody(req));
          if (a.op === "info") return send(200, { dir: dir() });
          if (a.op === "list") return send(200, await partsStore.listParts(dir()));
          if (a.op === "open") { const r = await partsStore.readPart(dir(), a.file); return send(200, { name: r.name, text: Buffer.from(r.data).toString("utf8") }); }
          send(400, { error: "unknown op" });
        } catch (err) { send(400, { error: String(err.message || err) }); }
      });
    },
  };
}

// ---------- in-app CFD (dev server only; the desktop app uses IPC) ----------
// Same runner and defaults as electron/main.cjs, so the browser preview can run and show CFD studies.
const CFD_CONFIG = {
  cfdDir: process.env.CAD_CFD_DIR || path.join(os.homedir(), "Documents", "CFD Sim"),
  pythonCmd: process.env.CAD_CFD_PYTHON || "python",
  exchangeDir: process.env.CAD_CFD_EXCHANGE || path.join(os.homedir(), "Documents", "CAD-CFD Exchange"),
};
function cfdPlugin() {
  return {
    name: "cfd-runner",
    configureServer(server) {
      const runner = createCfdRunner({ getConfig: () => CFD_CONFIG });
      server.httpServer?.once("close", () => runner.stopAll(3000));
      server.middlewares.use("/api/cfd", async (req, res) => {
        const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        if (req.method !== "POST") return send(405, { error: "POST only" });
        try {
          const a = JSON.parse(await readBody(req));
          let out;
          switch (a.op) {
            case "getConfig": out = CFD_CONFIG; break;
            case "writeCase": {
              const files = {};
              for (const [k, v] of Object.entries(a.files || {})) files[k] = v && typeof v === "object" && "b64" in v ? Buffer.from(v.b64, "base64") : String(v);
              out = await runner.writeCase(a.folderName, files); break;
            }
            case "readResults": out = await runner.readResults(a.casePath); break;
            case "run": out = await runner.run(a.casePath, a.opts || {}); break;
            case "stop": out = await runner.stop(a.casePath, a.opts || {}); break;
            case "status": out = runner.status(a.casePath); break;
            case "readFile": {
              const buf = await runner.readFile(a.casePath, a.rel);
              if (buf == null) { res.statusCode = 404; return res.end(); }
              res.statusCode = 200; res.setHeader("Content-Type", "application/octet-stream"); return res.end(buf);
            }
            default: return send(400, { error: "unknown op " + a.op });
          }
          send(200, { ok: true, value: out ?? null });
        } catch (err) {
          send(500, { error: String(err.message || err) });
        }
      });
    },
  };
}

// ---------- in-app FEA (dev server only; the desktop app uses IPC "fea:*") ----------
const FEA_CONFIG = {
  ...feaDefaults(),
  ...(process.env.CAD_FEA_DIR ? { feaDir: process.env.CAD_FEA_DIR } : {}),
  ...(process.env.CAD_FEA_PYTHON ? { pythonCmd: process.env.CAD_FEA_PYTHON } : {}),
  ...(process.env.CAD_FEA_EXCHANGE ? { exchangeDir: process.env.CAD_FEA_EXCHANGE } : {}),
};
function feaPlugin() {
  return {
    name: "fea-runner",
    configureServer(server) {
      const runner = createFeaRunner({ getConfig: () => FEA_CONFIG });
      server.httpServer?.once("close", () => runner.stopAll(3000));
      server.middlewares.use("/api/fea", createFeaHandler(runner, () => FEA_CONFIG, readBody));
    },
  };
}

export default defineConfig({
  // relative asset URLs so the build works under the Electron app:// protocol
  base: "./",
  plugins: [bugReportPlugin(), partsPlugin(), cfdPlugin(), feaPlugin()],
  server: { port: 5180 },
  // the OpenCascade wasm build must not be pre-bundled
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  build: { chunkSizeWarningLimit: 4000 },
});
