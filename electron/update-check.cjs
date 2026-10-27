// Start-page update check (desktop app, git clones only).
// checkForUpdates({ root }) -> Promise of one of
//   { state: "available", behind, subject, date }   origin/main has commits HEAD doesn't
//   { state: "current" }                            nothing new (local commits ahead don't count)
//   { state: "offline", error }                     git fetch failed or timed out
//   { state: "unavailable", reason }                not a clone, no git on PATH, packaged build
// It never throws and never asks for credentials (GIT_TERMINAL_PROMPT=0); the fetch is killed after
// timeoutMs. It only fetches (updates origin/main), it never touches the working tree.
// updateBatPath(root) / launchUpdater(root): the "Update now" button runs "Update CAD Modeler.bat"
// from the app root in its own console window, detached, after the app has quit.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const UPDATE_BAT = "Update CAD Modeler.bat";

// run git, resolve { code, out, err, timedOut, spawnError }; never rejects
function git(args, { cwd, gitCmd = "git", timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, timedOut = false, child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ out: out.trim(), err: err.trim(), timedOut, ...r }); };
    try {
      child = spawn(gitCmd, args, {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
      });
    } catch (e) { return finish({ code: -1, spawnError: e }); }
    // on Windows kill the whole tree (git fetch runs git-remote-https as a child that would linger),
    // and answer once the kill has gone through (at most 3 s more)
    const kill = () => new Promise((done) => {
      const cap = setTimeout(done, 3000);
      const end = () => { clearTimeout(cap); done(); };
      try {
        if (process.platform === "win32" && child.pid) {
          const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          k.on("error", () => { try { child.kill(); } catch {} end(); });
          k.on("exit", end);
        } else { child.kill(); end(); }
      } catch { end(); }
    });
    const timer = setTimeout(() => { timedOut = true; kill().then(() => finish({ code: -1 })); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ code: -1, spawnError: e }));
    child.on("close", (code) => finish({ code }));
  });
}

async function checkForUpdates({ root, packaged = false, remote = "origin", branch = "main", gitCmd = "git", timeoutMs = 15000 } = {}) {
  try {
    if (packaged) return { state: "unavailable", reason: "packaged build" };
    if (!root || !fs.existsSync(path.join(root, ".git"))) return { state: "unavailable", reason: "not a git clone" };
    const o = { cwd: root, gitCmd, timeoutMs: 5000 };
    const top = await git(["rev-parse", "--show-toplevel"], o);
    if (top.spawnError) return { state: "unavailable", reason: "git is not installed" };
    if (top.code !== 0) return { state: "unavailable", reason: "not a git clone" };
    const fetch = await git(["fetch", "-q", remote, branch], { ...o, timeoutMs });
    if (fetch.code !== 0) return { state: "offline", error: fetch.timedOut ? `git fetch timed out after ${Math.round(timeoutMs / 1000)} s` : (fetch.err.split("\n")[0] || `git fetch exited ${fetch.code}`) };
    const ref = `${remote}/${branch}`;
    const count = await git(["rev-list", "--count", `HEAD..${ref}`], o);
    const behind = parseInt(count.out, 10);
    if (count.code !== 0 || !Number.isFinite(behind)) return { state: "unavailable", reason: count.err.split("\n")[0] || "rev-list failed" };
    if (behind <= 0) return { state: "current" };
    const log = await git(["log", "-1", "--format=%s%x1f%cI", ref], o);
    const [subject = "", date = ""] = log.code === 0 ? log.out.split("\x1f") : [];
    return { state: "available", behind, subject, date };
  } catch (e) {
    return { state: "unavailable", reason: String((e && e.message) || e) };
  }
}

const updateBatPath = (root) => path.join(root, UPDATE_BAT);

// Opens a new console window running exactly <root>\Update CAD Modeler.bat. Returns false if it's missing.
function launchUpdater(root) {
  const bat = updateBatPath(root);
  if (process.platform !== "win32" || !fs.existsSync(bat)) return false;
  // verbatim: cmd.exe /d /c start "" "<bat>"  (start's first quoted arg is the window title)
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", `start "" "${bat}"`], { cwd: root, detached: true, stdio: "ignore", windowsVerbatimArguments: true });
  child.on("error", () => {});
  child.unref();
  return true;
}

module.exports = { checkForUpdates, updateBatPath, launchUpdater, UPDATE_BAT };
