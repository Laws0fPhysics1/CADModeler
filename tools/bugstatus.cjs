#!/usr/bin/env node
// Bug report / feature request status from the command line (for agents; the user does the same in
// the app's Reports panel). Status lives in <bug-reports|feature-requests>/<report>/status.json.
//
//   node tools/bugstatus.cjs                      open items (untouched + in work), bugs and features
//   node tools/bugstatus.cjs all                  everything
//   node tools/bugstatus.cjs history              everything finished, newest first, with its note
//   node tools/bugstatus.cjs set <name|prefix> <untouched|in-work|resolved> ["note"]
//
// "resolved" means fixed (bugs) / done (features). Make the note say what was wrong or what was
// built and what changed: the History tab in the app is the record of every change.
"use strict";
const path = require("node:path");
const { listBugReports, setBugStatus, STATUSES } = require("../electron/bugreport-writer.cjs");

const ROOT = path.join(__dirname, "..");
const DIRS = { bug: path.join(ROOT, "bug-reports"), feature: path.join(ROOT, "feature-requests") };
const [cmd, a, b, note] = process.argv.slice(2);
const label = (r) => (r.kind === "feature" ? "feature" : "bug    ");
const clip = (s) => (s || "").replace(/\s+/g, " ").slice(0, 160);

(async () => {
  const list = [...(await listBugReports(DIRS.bug, "bug")), ...(await listBugReports(DIRS.feature, "feature"))];
  if (!cmd || cmd === "all" || cmd === "list") {
    const rows = cmd === "all" ? list : list.filter((r) => r.status !== "resolved");
    if (!rows.length) { console.log(cmd === "all" ? "no reports" : "no open bug reports or feature requests"); return; }
    for (const r of rows) {
      console.log(`${label(r)} ${r.status.padEnd(10)} ${r.name}`);
      console.log(`                   ${clip(r.memo) || "(no description)"}`);
      if (r.note) console.log(`                   note: ${clip(r.note)}`);
    }
    return;
  }
  if (cmd === "history") {
    const done = list.filter((r) => r.status === "resolved").sort((x, y) => String(y.updatedAt || y.name).localeCompare(String(x.updatedAt || x.name)));
    if (!done.length) { console.log("nothing finished yet"); return; }
    for (const r of done) console.log(`${(r.updatedAt || "").slice(0, 16).replace("T", " ")}  ${label(r)}  ${clip(r.memo)}\n                    -> ${clip(r.note) || "(no note)"}`);
    return;
  }
  if (cmd === "set") {
    const hits = list.filter((r) => r.name === a || r.name.startsWith(a || "\0"));
    if (hits.length !== 1) { console.error(hits.length ? `"${a}" matches ${hits.length} reports; be more specific` : `no report matches "${a}"`); process.exit(1); }
    if (!STATUSES.includes(b)) { console.error(`status must be one of ${STATUSES.join(", ")}`); process.exit(1); }
    const r = hits[0];
    const st = await setBugStatus(DIRS[r.kind] || DIRS.bug, r.name, { status: b, note, by: "agent" });
    console.log(`${r.kind} ${r.name}: ${st.status}${st.note ? ` (${st.note})` : ""}`);
    return;
  }
  console.error("usage: bugstatus.cjs [all | history] | set <name|prefix> <untouched|in-work|resolved> [note]");
  process.exit(1);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
