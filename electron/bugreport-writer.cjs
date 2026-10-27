// Writes a bug report folder: report.json (no screenshot), screenshot.png,
// design.cadm.json and README.md with a readable event log.
// Shared by the Vite dev middleware (vite.config.js) and the Electron main
// process (electron/main.cjs), so both produce the same layout.
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const pad = (n) => String(n).padStart(2, "0");
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "report";

// One readable line per event, e.g. "-12.3s pointerdown L @(512,300) on button#btnSave"
function formatEvent(e, nowT) {
  const rel = ((e.t - nowT) / 1000).toFixed(1).padStart(7) + "s";
  const at = e.x != null ? ` @(${e.x},${e.y})` : "";
  const on = e.target ? ` on ${e.target}` : "";
  const m = e.mods ? ` [${e.mods}]` : "";
  let body;
  switch (e.type) {
    case "pointerdown": case "pointerup": case "dblclick": case "contextmenu":
      body = `${e.type} ${e.btn}${m}${at}${on}`; break;
    case "wheel":
      body = `wheel x${e.count} dy=${e.dy}${m}${at}${on}`; break;
    case "drag":
      body = `drag buttons=${e.buttons}${at}${on}`; break;
    case "keydown":
      body = `keydown ${JSON.stringify(e.key)}${m}${e.repeat ? " (repeat)" : ""}${e.inInput ? " (in input)" : ""}${on}`; break;
    case "input": case "change":
      body = `${e.type} = ${JSON.stringify(e.value)}${on}`; break;
    case "app":
      body = `APP ${e.name}${e.data !== undefined ? " " + JSON.stringify(e.data) : ""}`; break;
    case "error":
      body = `ERROR ${e.message}${e.source ? ` (${e.source}:${e.line}:${e.col})` : ""}`; break;
    case "unhandledrejection":
      body = `UNHANDLED REJECTION ${e.message}`; break;
    case "console.error": case "console.warn":
      body = `${e.type} ${String(e.message ?? "").split("\n")[0]}`; break;
    default: {
      const { t, time, type, ...rest } = e;
      body = `${type} ${JSON.stringify(rest)}`;
    }
  }
  return `${rel}  ${body}`;
}

function buildReadme(p, files) {
  const events = Array.isArray(p.events) ? p.events : [];
  const nowT = p.nowT ?? (events.length ? events[events.length - 1].t : 0);
  const errors = events.filter((e) => e.type === "error" || e.type === "unhandledrejection" || e.type === "console.error");
  const lines = [
    `# ${p.kind === "feature" ? "Feature request" : "Bug report"}: ${p.createdAt || ""}`,
    "",
    p.kind === "feature" ? "## Request" : "## What happened",
    "",
    p.memo ? p.memo.split("\n").map((l) => "> " + l).join("\n") : "_(no description)_",
    "",
    "## Environment",
    "",
    `- Time: ${p.createdAt ?? "?"}`,
    `- URL: ${p.url ?? "?"}`,
    `- User agent: ${p.userAgent ?? "?"}`,
    `- Viewport: ${p.viewport ? `${p.viewport.w}x${p.viewport.h} @${p.viewport.dpr}x, canvas ${JSON.stringify(p.viewport.canvas)}` : "?"}`,
    `- Theme: ${p.theme || "?"}`,
    `- Files: ${files.join(", ")}`,
    p.contextError ? `- getContext() threw: \`${p.contextError.split("\n")[0]}\`` : null,
    "",
    "## App state",
    "",
    "```json",
    JSON.stringify(p.appState ?? null, null, 2),
    "```",
    "",
  ];
  if (errors.length) {
    lines.push("## Errors in the log", "");
    for (const e of errors) lines.push("```", formatEvent(e, nowT), e.stack || "", "```");
    lines.push("");
  }
  lines.push(`## Event log (${events.length} events, seconds relative to submit; clientX/Y in CSS px)`, "", "```");
  for (const e of events) lines.push(formatEvent(e, nowT));
  lines.push("```", "");
  return lines.filter((l) => l !== null).join("\n");
}

// Writes the report into a new folder under baseDir (created if needed).
// Returns { dir, name } where dir is absolute and name is the folder name.
async function writeBugReport(baseDir, p) {
  if (!p || typeof p !== "object") throw new Error("invalid bug report payload");
  let name = `${stamp(new Date())}_${slug(p.memo)}`;
  let dir = path.join(baseDir, name);
  for (let i = 2; await fs.stat(dir).then(() => true, () => false); i++) dir = path.join(baseDir, `${name}-${i}`);
  name = path.basename(dir);
  await fs.mkdir(dir, { recursive: true });

  const files = ["report.json"];
  const shot = typeof p.screenshot === "string" && p.screenshot.match(/^data:image\/png;base64,(.+)$/);
  if (shot) { await fs.writeFile(path.join(dir, "screenshot.png"), Buffer.from(shot[1], "base64")); files.push("screenshot.png"); }
  if (p.doc != null) { await fs.writeFile(path.join(dir, "design.cadm.json"), JSON.stringify(p.doc, null, 1)); files.push("design.cadm.json"); }
  const { screenshot, ...rest } = p;
  await fs.writeFile(path.join(dir, "report.json"), JSON.stringify({ ...rest, screenshot: shot ? "screenshot.png" : null }, null, 1));
  files.push("README.md");
  await fs.writeFile(path.join(dir, "README.md"), buildReadme(p, files));
  return { dir, name };
}

// ---------- status: <report>/status.json { status, note, updatedAt, by } (missing = untouched) ----------
const STATUSES = ["untouched", "in-work", "resolved"];
// a report is a direct child folder of baseDir; anything else (.., separators) is refused
function reportDir(baseDir, name) {
  if (typeof name !== "string" || !name || name !== path.basename(name) || name.startsWith(".")) throw new Error("invalid report name");
  return path.join(baseDir, name);
}
async function readJSON(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }

/** Every report under baseDir, newest first: { name, memo, createdAt, status, note, updatedAt, by, screenshot }. */
async function listBugReports(baseDir, kind = "bug") {
  let names = [];
  try { names = (await fs.readdir(baseDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(baseDir, name);
    const rep = (await readJSON(path.join(dir, "report.json"))) || {};
    if (rep.memo === "smoke test") continue; // `npm run smoke` writes (and deletes) one
    const st = (await readJSON(path.join(dir, "status.json"))) || {};
    out.push({
      kind, name, memo: typeof rep.memo === "string" ? rep.memo : "", createdAt: rep.createdAt || null,
      status: STATUSES.includes(st.status) ? st.status : "untouched", note: st.note || "", updatedAt: st.updatedAt || null, by: st.by || null,
      screenshot: rep.screenshot === "screenshot.png",
    });
  }
  return out.sort((x, y) => (x.name < y.name ? 1 : -1));
}
/** Set a report's status (and optional note). by = "user" (in-app) or "agent" (tools/bugstatus.cjs). */
async function setBugStatus(baseDir, name, { status, note, by } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  const dir = reportDir(baseDir, name);
  if (!(await fs.stat(path.join(dir, "report.json")).then(() => true, () => false))) throw new Error("no such report");
  const prev = (await readJSON(path.join(dir, "status.json"))) || {};
  const st = { status, note: typeof note === "string" ? note.slice(0, 2000) : prev.note || "", updatedAt: new Date().toISOString(), by: by === "agent" ? "agent" : "user" };
  await fs.writeFile(path.join(dir, "status.json"), JSON.stringify(st, null, 1));
  return st;
}

module.exports = { stamp, slug, formatEvent, buildReadme, writeBugReport, listBugReports, setBugStatus, STATUSES };
