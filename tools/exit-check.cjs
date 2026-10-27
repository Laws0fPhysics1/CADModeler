#!/usr/bin/env node
// Checks the close prompt in the real desktop app, in a throwaway profile (never the user's tabs):
//   1. make a design and close the window: "Save changes before closing?" must appear,
//      Cancel must keep the window open, Don't Save must close it
//   2. start again in the same profile: the clean exit left nothing behind (one blank design)
//   3. simulated crashes (tabs seeded into storage, exit without the prompt): on the next start empty
//      leftovers are dropped and never offered as Continue; designs with content still are
// Run after `node electron/run.cjs build`:  node tools/exit-check.cjs
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const electron = require(path.join(ROOT, "node_modules", "electron")); // path to electron.exe
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cadm-exit-"));
let failed = false;
try {
  for (const phase of ["run", "verify", "crash-mixed", "after-mixed", "crash-empty", "after-empty"]) {
    const r = spawnSync(electron, [path.join(ROOT, "electron", "main.cjs"), `--user-data=${profile}`, `--exit-check=${phase}`], { encoding: "utf8", timeout: 120000 });
    const line = `${r.stdout || ""}${r.stderr || ""}`.split(/\r?\n/).find((l) => l.startsWith("EXIT-CHECK")) || `EXIT-CHECK ${phase} FAIL: no result (exit ${r.status})`;
    console.log(line);
    if (!/ OK:/.test(line)) { failed = true; break; }
  }
} finally {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
