// Runs FEA Sim's solver headless as a child process of CAD Modeler, the same
// way electron/cfd-runner.cjs runs CFD Sim (that module is the shared runner;
// this one only supplies FEA Sim's folder key, log name and labels). Shared by
// the Electron main process (IPC "fea:*") and the Vite dev server (/api/fea).
//
//   run(casePath)            python -u main.py --case <dir> --headless   (cwd = feaDir, log = <dir>/fea-run.log)
//   stop(casePath)           creates <dir>/stop.request; the solver writes results.json (status "stopped") and exits
//   status / readFile / readResults / writeCase   exactly as in cfd-runner.cjs
//
// Every path is validated to lie inside the FEA exchange folder.
"use strict";
const path = require("node:path");
const os = require("node:os");
const { createCfdRunner } = require("./cfd-runner.cjs");
const { SIMS } = require("./sim-paths.cjs");

/**
 * Defaults for the FEA side; `documents` lets Electron pass its resolved Documents folder. These are
 * the fallbacks only: main.cjs and vite.config.js pick the folder and Python with sim-paths.cjs
 * (Settings override → Documents\FEA Sim → <app root>\sims\FEA Sim).
 */
function feaDefaults(documents = path.join(os.homedir(), "Documents")) {
  return {
    feaDir: path.join(documents, "FEA Sim"),
    pythonCmd: "python",
    exchangeDir: path.join(documents, "CAD-FEA Exchange"),
  };
}

/**
 * @param {{ getConfig: () => { feaDir: string, pythonCmd: string, exchangeDir: string } }} opts
 */
function createFeaRunner({ getConfig }) {
  return createCfdRunner({
    // cfdDir mirrors feaDir so a long-running dev server that still has an older cfd-runner.cjs
    // in Node's require cache (one without appDirKey) also finds FEA Sim's main.py
    getConfig: () => { const c = getConfig(); return { ...c, cfdDir: c.feaDir }; },
    appDirKey: "feaDir",
    logName: "fea-run.log",
    label: "FEA solver",
    settingsHint: "Or set the FEA Sim folder in Settings > Simulation (CAD_FEA_DIR for the dev server).",
    requires: SIMS.fea,
  });
}

/**
 * Connect-style handler for the Vite dev server's POST /api/fea (same ops and wire format as
 * /api/cfd: JSON { op, ... } in, { ok, value } out; readFile answers raw bytes or 404).
 * @param {ReturnType<typeof createFeaRunner>} runner
 * @param {() => object} getConfig
 * @param {(req) => Promise<string>} readBody
 */
function createDevHandler(runner, getConfig, readBody) {
  return async (req, res) => {
    const send = (status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST") return send(405, { error: "POST only" });
    try {
      const a = JSON.parse(await readBody(req));
      let out;
      switch (a.op) {
        case "getConfig": out = getConfig(); break;
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
  };
}

module.exports = { createFeaRunner, feaDefaults, createDevHandler };
