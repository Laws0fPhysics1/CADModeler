// Reports panel: bug reports and feature requests with their status (Untouched / In work /
// Resolved, shown as "Done" for features) and a note, plus History: everything finished, newest
// first, with the note saying what was changed. Opened from "Reports…" in either dialog. The Bug
// report and Feature request buttons each show a badge with their open count (untouched + in work).
// Status lives in <bug-reports|feature-requests>/<report>/status.json (electron/bugreport-writer.cjs);
// agents set it with `node tools/bugstatus.cjs set <name> <status> "note"`.
import * as platform from "./platform.js";

const LABELS = { bug: { untouched: "Untouched", "in-work": "In work", resolved: "Resolved" }, feature: { untouched: "Untouched", "in-work": "In work", resolved: "Done" } };
let overlay = null, view = "bug", filter = "open";

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.filter((x) => x != null && x !== false));
  return n;
}
const fmtDate = (iso, fallback) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : fallback;
};

/** Badges on #btnBug / #btnFeature with their open counts. */
export async function refreshBugBadge() {
  let list = [];
  try { list = await platform.listBugReports(); } catch (e) {}
  for (const [id, kind] of [["btnBug", "bug"], ["btnFeature", "feature"]]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const open = list.filter((r) => (r.kind || "bug") === kind && r.status !== "resolved").length;
    let b = btn.querySelector(".bug-badge");
    if (!open) { if (b) b.remove(); continue; }
    if (!b) { b = el("span", { class: "bug-badge" }); btn.append(b); }
    b.textContent = String(open);
    b.title = `${open} open ${kind === "feature" ? "feature request" : "bug report"}${open > 1 ? "s" : ""}`;
  }
}

export function closeBugList() { if (overlay) { overlay.remove(); overlay = null; } }

/** kind: "bug" | "feature" | "history" (the tab to open on). */
export async function openBugList({ logEvent, kind = "bug" } = {}) {
  closeBugList();
  view = kind === "feature" || kind === "history" ? kind : "bug";
  const listEl = el("div", { class: "bl-list" }, el("div", { class: "bl-empty" }, "Loading…"));
  const views = el("div", { class: "bl-views" });
  const tabs = el("div", { class: "bl-tabs" });
  const card = el("div", { class: "bug-card bl-card", role: "dialog", "aria-label": "Reports" },
    el("div", { class: "bug-head" }, el("span", {}, "REPORTS"), el("button", { class: "bug-x", title: "Close", html: "&times;", onclick: closeBugList })),
    views, tabs, listEl,
    el("div", { class: "bug-foot" }, el("span", { class: "bug-hint" }, "Status and notes are saved next to each report, so agents see them too."), el("button", { onclick: closeBugList }, "Close")));
  overlay = el("div", { class: "bug-overlay" }, card);
  overlay.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeBugList(); });
  for (const t of ["keyup", "keypress", "wheel", "contextmenu", "pointerdown"]) overlay.addEventListener(t, (e) => e.stopPropagation());
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeBugList(); });
  document.body.append(overlay);

  let reports = [];
  const row = (r, history) => {
    const kind = r.kind || "bug", L = LABELS[kind];
    const sel = el("select", { class: `bl-status st-${r.status}`, title: "Status" },
      ...Object.entries(L).map(([v, l]) => { const o = el("option", { value: v }, l); if (v === r.status) o.selected = true; return o; }));
    const note = el("input", { class: "bl-note", placeholder: history ? "What was changed" : "Note (optional)", value: r.note || "", spellcheck: "false" });
    const save = async (status) => {
      const res = await platform.setBugStatus(r.name, status, note.value.trim(), kind);
      if (res && res.ok) {
        Object.assign(r, res.status);
        logEvent && logEvent("report status", { kind, name: r.name, status: r.status });
        render(); refreshBugBadge();
      } else { sel.value = r.status; alert(`Couldn't save the status: ${(res && res.error) || "unknown error"}`); }
    };
    sel.addEventListener("change", () => save(sel.value));
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(r.status); } });
    note.addEventListener("change", () => { if (note.value.trim() !== (r.note || "")) save(r.status); });
    return el("div", { class: `bl-row st-${r.status}` },
      el("div", { class: "bl-top" },
        history ? el("span", { class: `bl-kind k-${kind}` }, kind === "feature" ? "Feature" : "Bug") : null,
        el("span", { class: "bl-when", title: history ? "Finished" : "Reported" }, history ? fmtDate(r.updatedAt, "") : fmtDate(r.createdAt, r.name.slice(0, 16))),
        history ? el("span", { class: "bl-by" }, `reported ${fmtDate(r.createdAt, r.name.slice(0, 10))}`) : null,
        r.screenshot ? el("span", { class: "bl-tag", title: "Has a screenshot" }, "screenshot") : null,
        !history && r.by && r.updatedAt ? el("span", { class: "bl-by", title: new Date(r.updatedAt).toLocaleString() }, `set by ${r.by}`) : null,
        sel),
      el("div", { class: "bl-memo", title: r.memo }, r.memo || "(no description)"),
      note);
  };
  const render = () => {
    views.innerHTML = "";
    const open = (k) => reports.filter((r) => (r.kind || "bug") === k && r.status !== "resolved").length;
    for (const [k, l] of [["bug", `Bug reports (${open("bug")} open)`], ["feature", `Feature requests (${open("feature")} open)`], ["history", "History"]]) {
      views.append(el("button", { class: `bl-view${view === k ? " on" : ""}`, onclick: () => { view = k; filter = "open"; render(); } }, l));
    }
    tabs.innerHTML = ""; listEl.innerHTML = "";
    if (view === "history") {
      // everything finished, newest first: the running record of what changed in the app
      tabs.append(el("span", { class: "bl-sub" }, "Every resolved bug and finished feature, newest first, with what was changed."));
      const done = reports.filter((r) => r.status === "resolved").sort((a, b) => String(b.updatedAt || b.name).localeCompare(String(a.updatedAt || a.name)));
      if (!done.length) listEl.append(el("div", { class: "bl-empty" }, "Nothing finished yet."));
      for (const r of done) listEl.append(row(r, true));
      return;
    }
    const mine = reports.filter((r) => (r.kind || "bug") === view);
    const L = LABELS[view];
    const counts = { open: 0, untouched: 0, "in-work": 0, resolved: 0, all: mine.length };
    for (const r of mine) { counts[r.status]++; if (r.status !== "resolved") counts.open++; }
    for (const [k, l] of [["open", "Open"], ["untouched", L.untouched], ["in-work", L["in-work"]], ["resolved", L.resolved], ["all", "All"]]) {
      tabs.append(el("button", { class: `bl-tab${filter === k ? " on" : ""}`, onclick: () => { filter = k; render(); } }, `${l} (${counts[k]})`));
    }
    const rows = mine.filter((r) => filter === "all" || (filter === "open" ? r.status !== "resolved" : r.status === filter));
    if (!rows.length) { listEl.append(el("div", { class: "bl-empty" }, mine.length ? "Nothing here." : view === "feature" ? "No feature requests yet: use the Feature request button." : "No bug reports saved yet.")); return; }
    for (const r of rows) listEl.append(row(r, false));
  };
  try { reports = await platform.listBugReports(); } catch (e) { reports = []; }
  if (!overlay) return;
  render();
}
