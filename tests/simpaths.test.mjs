// Where the in-app solvers and their Python come from (electron/sim-paths.cjs), the pre-launch check and
// the runner's "not installed" messages. node tests/simpaths.test.mjs (~2 s; the Python checks are skipped
// when no system python is on PATH)
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const S = require("../electron/sim-paths.cjs");
const { createCfdRunner } = require("../electron/cfd-runner.cjs");
const { createFeaRunner } = require("../electron/fea-runner.cjs");
let fails = 0;
const check = (name, ok, extra = "") => { console.log(ok ? "ok  " : "FAIL", name, extra); if (!ok) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cad simpaths "));
const mk = (...p) => { const f = path.join(tmp, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "#"); return f; };
try {
  // a friend's PC: Documents without sims, app root with a bundled sims/ folder
  const docs = path.join(tmp, "friend docs"); fs.mkdirSync(docs, { recursive: true });
  const root = path.join(tmp, "CAD Modeler");
  mk("CAD Modeler", "sims", "CFD Sim", "main.py");
  mk("CAD Modeler", "sims", "FEA Sim", "main.py");
  const venv = S.venvPython(path.join(root, "sims"));
  const roots = S.appRoots({ root, packaged: false });
  check("app root from source = project folder", roots.length === 1 && roots[0] === path.resolve(root));
  const exe = path.join(tmp, "inst"), res = path.join(tmp, "inst", "resources");
  const pr = S.appRoots({ packaged: true, resourcesPath: res, exeDir: exe, root });
  check("packaged: resources folder, then the exe folder", pr.join("|") === [res, exe].join("|"));

  let r = S.resolveSim("cfd", { documents: docs, roots });
  check("friend, no venv yet: bundled CFD Sim + system python", r.dirSource === "bundled" && r.dir === path.join(root, "sims", "CFD Sim") && r.pythonSource === "system" && r.pythonCmd === "python" && r.label === "Bundled");
  mk("CAD Modeler", "sims", ".venv", ...path.relative(path.join(root, "sims", ".venv"), venv).split(path.sep));
  r = S.resolveSim("fea", { documents: docs, roots });
  check("friend: bundled FEA Sim + bundled venv python", r.dirSource === "bundled" && r.dir === path.join(root, "sims", "FEA Sim") && r.pythonSource === "bundled" && r.pythonCmd === venv);
  r = S.resolveSim("cfd", { documents: docs, roots, overrides: { pythonCmd: "py -3.12" } });
  check("pythonCmd set in Settings wins over the venv", r.pythonSource === "custom" && r.pythonCmd === "py -3.12");
  const sc = S.splitCmd("py -3.12");
  check("py launcher command split into exe + args", sc.exe === "py" && sc.pre.join() === "-3.12");
  check("a python path with spaces stays whole", S.splitCmd(venv).exe === venv && !S.splitCmd(venv).pre.length);

  // the owner's PC: Documents\CFD Sim with main.py wins over the bundled copy, with system python
  mk("friend docs", "CFD Sim", "main.py");
  r = S.resolveSim("cfd", { documents: docs, roots });
  check("Documents\\CFD Sim (has main.py) before the bundled copy", r.dirSource === "documents" && r.dir === path.join(docs, "CFD Sim") && r.label === path.join("friend docs", "CFD Sim"));
  check("... and it uses system python, not the bundled venv", r.pythonSource === "system" && r.pythonCmd === "python");
  fs.mkdirSync(path.join(docs, "FEA Sim"));
  r = S.resolveSim("fea", { documents: docs, roots });
  check("Documents\\FEA Sim without main.py is skipped", r.dirSource === "bundled");

  // Settings override
  const mine = path.join(tmp, "My CFD"); fs.mkdirSync(mine);
  r = S.resolveSim("cfd", { documents: docs, roots, overrides: { cfdDir: mine } });
  check("folder set in Settings wins when it exists", r.dirSource === "custom" && r.dir === mine && !r.overrideMissing);
  r = S.resolveSim("cfd", { documents: docs, roots, overrides: { cfdDir: path.join(tmp, "gone") } });
  check("a missing Settings folder falls through (and is flagged)", r.dirSource === "documents" && r.overrideMissing);

  // nothing anywhere
  const bare = path.join(tmp, "bare root"); fs.mkdirSync(bare);
  r = S.resolveSim("cfd", { documents: path.join(tmp, "nodocs"), roots: [bare] });
  check("nothing installed -> missing, pointing at <app root>/sims", r.dirSource === "missing" && r.dir === path.join(bare, "sims", "CFD Sim") && r.label === "Not installed");

  // friendly errors from a solver log
  check("cupy import error -> GPU message", S.friendlyError("Traceback\nModuleNotFoundError: No module named 'cupy'") === S.NO_GPU);
  check("other missing module -> install message", /trimesh/.test(S.friendlyError("ModuleNotFoundError: No module named 'trimesh'")) && S.friendlyError("ModuleNotFoundError: No module named 'trimesh'").includes("Update CAD Modeler.bat"));
  check("CUDA driver error -> GPU message", S.friendlyError("cupy_backends.cuda.api.runtime.CUDARuntimeError: cudaErrorInsufficientDriver") === S.NO_GPU);
  check("ordinary errors are left alone", S.friendlyError("ValueError: bad case") === null);

  // runner messages (a case in a temp exchange folder)
  const exch = path.join(tmp, "exchange");
  const nothing = createCfdRunner({ getConfig: () => ({ ...S.resolveSim("cfd", { documents: path.join(tmp, "nodocs"), roots: [bare] }), cfdDir: path.join(bare, "sims", "CFD Sim"), pythonCmd: "python", exchangeDir: exch }) });
  const casePath = await nothing.writeCase("case1", { "case.json": "{}" });
  let out = await nothing.run(casePath);
  check("Solve with no sims -> 'Simulations aren't installed yet'", !out.ok && out.error.startsWith(S.NOT_INSTALLED), JSON.stringify(out.error.slice(0, 80)));
  const fakeSim = path.join(tmp, "fake sim"); mk("fake sim", "main.py");
  const noPy = createFeaRunner({ getConfig: () => ({ feaDir: fakeSim, pythonCmd: path.join(tmp, "no python", "python.exe"), exchangeDir: exch }) });
  out = await noPy.run(casePath);
  check("Solve with a Python that isn't there -> Python not found + install hint", !out.ok && /Python not found/.test(out.error) && out.error.includes("Update CAD Modeler.bat"), JSON.stringify(out.error.slice(0, 90)));

  const havePy = spawnSync("python", ["-c", "print(1)"], { windowsHide: true, encoding: "utf8" }).stdout?.trim() === "1";
  if (!havePy) console.log("skip Python checks (no python on PATH)");
  else {
    let c = await S.checkPython({ pythonCmd: "python", cwd: tmp, modules: ["json", "no_such_pkg_xyz"] });
    check("checkPython names missing packages", !c.ok && /no_such_pkg_xyz/.test(c.error) && c.error.includes("Update CAD Modeler.bat"), c.error);
    c = await S.checkPython({ pythonCmd: "python", cwd: tmp, modules: ["json"] });
    check("checkPython passes with the packages there", c.ok, c.version || c.error);
    const missingPkgs = createCfdRunner({ getConfig: () => ({ cfdDir: fakeSim, pythonCmd: "python", exchangeDir: exch }), requires: { modules: ["no_such_pkg_xyz"], gpu: false } });
    out = await missingPkgs.run(casePath);
    check("Solve with packages missing -> refused before launch", !out.ok && /packages missing/.test(out.error) && !missingPkgs.status(casePath).known, out.error);
  }

  // the owner's machine: the real Documents and this project resolve to the live Documents copies
  const realDocs = path.join(os.homedir(), "Documents"), projRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const kind of ["cfd", "fea"]) {
    const name = S.SIMS[kind].name;
    if (!S.hasMain(path.join(realDocs, name))) { console.log(`skip owner check for ${name} (not in Documents on this PC)`); continue; }
    const o = S.resolveSim(kind, { documents: realDocs, roots: S.appRoots({ root: projRoot, packaged: false }) });
    check(`this PC: ${name} -> Documents\\${name} with system python`, o.dirSource === "documents" && o.dir === path.join(realDocs, name) && o.pythonCmd === "python", o.dir);
    if (havePy && !process.env.SIMPATHS_SKIP_PY) {
      const c = await S.checkPython({ pythonCmd: o.pythonCmd, cwd: o.dir, modules: S.SIMS[kind].modules, gpu: S.SIMS[kind].gpu });
      check(`this PC: ${name} pre-launch check passes (packages${S.SIMS[kind].gpu ? " + CUDA GPU" : ""})`, c.ok, c.error || c.version);
      if (S.SIMS[kind].gpu && c.ok) { // hide the GPU: a PC without an NVIDIA card
        process.env.CUDA_VISIBLE_DEVICES = "-1";
        const g = await S.checkPython({ pythonCmd: o.pythonCmd, cwd: o.dir, modules: [], gpu: true });
        delete process.env.CUDA_VISIBLE_DEVICES;
        check("no CUDA device -> '3D CFD needs an NVIDIA graphics card (CUDA)'", !g.ok && g.error.startsWith(S.NO_GPU), g.error);
      }
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (fails) { console.log(fails, "failed"); process.exitCode = 1; } else console.log("sim paths: all ok");
