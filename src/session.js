// Design tabs left over from the last run (DOM-free, tested by tests/startpage.test.mjs).
// An empty design (no features, studies, analyses or assembly content) is never worth continuing:
// the start page doesn't offer it, and leftovers that are empty are dropped at startup.

/** A design has something in it worth keeping / continuing. */
export function docHasContent(d) {
  if (!d) return false;
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const asm = d.assembly || {};
  return !!(n(d.features) || n(d.studies) || n(d.analyses) || n(asm.components) || n(asm.joints) || n(asm.links));
}

/**
 * Keep only the tabs with content. tabs: [{ id, doc }], active: index into tabs.
 * Returns { tabs, active, dropped }: active = the old active tab if it was kept, else the nearest kept
 * tab before it (or after it); -1 when nothing is left (start on one blank design). dropped = removed tabs.
 */
export function pruneEmptyTabs(tabs, active) {
  const keep = [], dropped = [];
  let newActive = -1, before = -1, after = -1;
  tabs.forEach((t, i) => {
    if (!docHasContent(t.doc)) { dropped.push(t); return; }
    if (i === active) newActive = keep.length;
    else if (i < active) before = keep.length;
    else if (after < 0) after = keep.length;
    keep.push(t);
  });
  if (newActive < 0) newActive = before >= 0 ? before : after;
  return { tabs: keep, active: newActive, dropped };
}

/**
 * What the start page offers. docs: the open designs, active: the current one, leftover: how many
 * designs the last session left (only while that offer still stands, else 0).
 * Returns { continueName: string | null (null = no Continue button), recent: [{ name, index, active }] }.
 */
export function startPageOffer(docs, active, leftover = 0) {
  const recent = docs.map((d, i) => ({ name: d.name, index: i, active: i === active })).filter((r) => docHasContent(docs[r.index]));
  let continueName = null;
  if (leftover > 1) continueName = `Last session · ${leftover} designs`;
  else if (docHasContent(docs[active])) continueName = docs[active].name;
  return { continueName, recent };
}
