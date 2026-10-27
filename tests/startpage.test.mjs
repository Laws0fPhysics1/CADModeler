// Start page offer / leftover-tab pruning (src/session.js): node tests/startpage.test.mjs
import { docHasContent, pruneEmptyTabs, startPageOffer } from "../src/session.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };

const blank = (name = "Untitled") => ({ name, features: [], marker: 0, counters: {}, hidden: [], appearances: {}, studies: [], assembly: { components: [], joints: [], links: [] } });
const full = (name) => ({ ...blank(name), features: [{ id: "f1", type: "box" }], marker: 1 });

// ---- docHasContent
ok(!docHasContent(blank()), "blank design is empty");
ok(!docHasContent(null), "missing design is empty");
ok(!docHasContent({ name: "x", features: [] }), "old doc without studies / assembly is empty");
ok(!docHasContent({ ...blank("Renamed"), hidden: ["asm:c1"], appearances: { b: {} }, counters: { sketch: 3 } }), "name / counters / hidden alone aren't content");
ok(docHasContent(full("A")), "features are content");
ok(docHasContent({ ...blank(), studies: [{ id: "s" }] }), "studies are content");
ok(docHasContent({ ...blank(), analyses: [{ id: "a" }] }), "analyses are content");
ok(docHasContent({ ...blank(), assembly: { components: [{ id: "c", keep: true }], joints: [], links: [] } }), "assembly components are content");

// ---- pruneEmptyTabs
const T = (id, doc) => ({ id, doc });
let r = pruneEmptyTabs([T("a", blank())], 0);
ok(r.tabs.length === 0 && r.active === -1 && r.dropped.length === 1, "one empty leftover: dropped, nothing to continue");
r = pruneEmptyTabs([T("a", blank()), T("b", blank()), T("c", blank())], 1);
ok(r.tabs.length === 0 && r.dropped.length === 3, "all empty leftovers dropped");
r = pruneEmptyTabs([T("a", full("A")), T("b", blank()), T("c", full("C"))], 2);
ok(r.tabs.map((t) => t.id).join() === "a,c" && r.active === 1 && r.dropped[0].id === "b", "mix: empty dropped, active kept and re-indexed");
r = pruneEmptyTabs([T("a", full("A")), T("b", blank()), T("c", full("C"))], 1);
ok(r.active === 0, "active empty: the nearest kept tab before it becomes active");
r = pruneEmptyTabs([T("a", blank()), T("b", full("B"))], 0);
ok(r.active === 0 && r.tabs[0].id === "b", "active empty and first: the next kept tab becomes active");
r = pruneEmptyTabs([T("a", full("A")), T("b", full("B"))], 1);
ok(r.tabs.length === 2 && r.active === 1 && !r.dropped.length, "no empties: nothing changes");

// ---- startPageOffer
let o = startPageOffer([blank()], 0, 0);
ok(o.continueName === null && o.recent.length === 0, "blank design: no Continue, no Recent");
o = startPageOffer([full("Bracket")], 0, 1);
ok(o.continueName === "Bracket" && o.recent.length === 1 && o.recent[0].active, "one design with content: Continue <name>");
o = startPageOffer([full("A"), full("B"), full("C")], 1, 3);
ok(o.continueName === "Last session · 3 designs" && o.recent.length === 3, "several leftovers: Last session · N designs");
o = startPageOffer([full("A"), blank("Untitled"), full("C")], 1, 0);
ok(o.continueName === null && o.recent.map((x) => x.index).join() === "0,2", "File > Start Page on an empty tab: no Continue, Recent lists only designs with content (indexes kept)");
o = startPageOffer([full("A"), blank()], 0, 0);
ok(o.continueName === "A" && o.recent.length === 1, "current design with content is offered; empty tab hidden");

console.log(fails ? `${fails} FAILED` : "all ok");
process.exit(fails ? 1 : 0);
