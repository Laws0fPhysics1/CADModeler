// Start-page update check (electron/update-check.cjs) against local sandbox repos. node tests/updatecheck.test.mjs
// (UPDTEST_DIR=<dir> puts the sandbox there instead of the system temp folder; needs git on PATH, ~5 s)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const U = require("../electron/update-check.cjs");
let fails = 0;
const check = (name, ok, extra) => { console.log(ok ? "ok  " : "FAIL", name, ok ? "" : JSON.stringify(extra ?? "")); if (!ok) fails++; };

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const base = process.env.UPDTEST_DIR ? path.resolve(process.env.UPDTEST_DIR) : os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const tmp = fs.mkdtempSync(path.join(base, "updcheck-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_TERMINAL_PROMPT: "0" };
const g = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const commit = (cwd, file, msg) => { fs.writeFileSync(path.join(cwd, file), msg); g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", msg); };

try {
  // not a clone / packaged / no git
  const plain = path.join(tmp, "plain"); fs.mkdirSync(plain);
  check("not a git clone -> unavailable", (await U.checkForUpdates({ root: plain })).state === "unavailable");
  check("packaged -> unavailable", (await U.checkForUpdates({ root: plain, packaged: true })).state === "unavailable");
  check("no root -> unavailable", (await U.checkForUpdates({})).state === "unavailable");
  if (!hasGit) { console.log("git not on PATH: skipping the repo cases"); }
  else {
    const origin = path.join(tmp, "origin.git"), friend = path.join(tmp, "friend"), owner = path.join(tmp, "owner");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin);
    g(tmp, "clone", "-q", origin, owner);
    g(owner, "checkout", "-q", "-b", "main");
    commit(owner, "a.txt", "first");
    g(owner, "push", "-q", "origin", "main");
    g(tmp, "clone", "-q", "-b", "main", origin, friend);

    const r0 = await U.checkForUpdates({ root: friend });
    check("fresh clone -> current", r0.state === "current", r0);

    const noGit = await U.checkForUpdates({ root: friend, gitCmd: "git-does-not-exist-xyz" });
    check("git missing -> unavailable", noGit.state === "unavailable", noGit);

    commit(owner, "b.txt", "second");
    commit(owner, "c.txt", "Gear wizard: helical racks");
    g(owner, "push", "-q", "origin", "main");
    const head0 = g(friend, "rev-parse", "HEAD");
    const r1 = await U.checkForUpdates({ root: friend });
    check("origin ahead by 2 -> available, behind 2", r1.state === "available" && r1.behind === 2, r1);
    check("subject of the latest remote commit", r1.subject === "Gear wizard: helical racks", r1);
    check("date is ISO", !isNaN(Date.parse(r1.date)), r1);
    check("working tree untouched (HEAD, no new files)", g(friend, "rev-parse", "HEAD") === head0 && !fs.existsSync(path.join(friend, "b.txt")) && g(friend, "status", "--porcelain") === "");

    // owner's own PC: local commits ahead of origin only
    commit(owner, "d.txt", "local only");
    const r2 = await U.checkForUpdates({ root: owner });
    check("local commits ahead, none behind -> current", r2.state === "current", r2);
    // diverged: ahead 1 and behind 1 -> available
    commit(friend, "e.txt", "friend local edit");
    const r3 = await U.checkForUpdates({ root: friend });
    check("ahead and behind -> available (behind counted)", r3.state === "available" && r3.behind === 2, r3);

    // offline: origin path gone
    const gone = path.join(tmp, "offline"); g(tmp, "clone", "-q", "-b", "main", origin, gone);
    g(gone, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
    const r4 = await U.checkForUpdates({ root: gone });
    check("unreachable remote -> offline", r4.state === "offline", r4);
    // offline by timeout: an address that never answers, killed after 1.5 s
    g(gone, "remote", "set-url", "origin", "http://10.255.255.1:81/x.git");
    const t0 = Date.now();
    const r5 = await U.checkForUpdates({ root: gone, timeoutMs: 1500 });
    const dt = Date.now() - t0;
    check(`hanging fetch killed on timeout (${dt} ms) -> offline`, r5.state === "offline" && dt < 6000, r5);
  }
  // updater launcher refuses a folder without the bat (never spawns anything)
  check("launchUpdater: no bat -> false", U.launchUpdater(plain) === false);
  check("updater path is the bat in the root", U.updateBatPath(plain) === path.join(plain, "Update CAD Modeler.bat"));
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
if (fails) { console.log(fails, "failed"); process.exitCode = 1; } else console.log("update check: all ok");
