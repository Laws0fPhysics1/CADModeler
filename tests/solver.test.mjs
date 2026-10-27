// Solver smoke test: node tests/solver.test.mjs
import { emptyModel, sid, flatten } from "../src/sketchmodel.js";
import { solve, analyze, rankOf, measureDim } from "../src/solver.js";
const m = emptyModel();
const pt = (x, y) => { const id = sid("p"); m.points[id] = { x, y }; return id; };
// rough rectangle, first corner on the origin
const a = "O", b = pt(41, 1), c = pt(39, 23), d = pt(-1, 26);
const L = (p1, p2) => { const e = { id: sid("e"), type: "line", p1, p2 }; m.entities.push(e); return e.id; };
const l1 = L(a, b), l2 = L(b, c), l3 = L(c, d), l4 = L(d, a);
m.constraints.push({ id: "h1", type: "horizontal", e: [l1] }, { id: "h2", type: "horizontal", e: [l3] }, { id: "v1", type: "vertical", e: [l2] }, { id: "v2", type: "vertical", e: [l4] });
let r = solve(m); console.log("H/V solve", r.ok, JSON.stringify(flatten(m).map((e) => e.a.map((v) => +v.toFixed(3)))));
console.log("dof after H/V", analyze(m).dof);
const before = rankOf(m);
m.constraints.push({ id: "d1", type: "dim", kind: "distance", orient: "h", p: [a, b], value: 50 });
m.constraints.push({ id: "d2", type: "dim", kind: "distance", orient: "v", p: [b, c], value: 20 });
r = solve(m); const an = analyze(m);
console.log("dims solve", r.ok, "dof", an.dof, "rank", before, "->", rankOf(m), JSON.stringify(flatten(m).map((e) => e.a.map((v) => +v.toFixed(3)))));
// redundant dim: rank should not grow
const extra = { id: "d3", type: "dim", kind: "distance", orient: "h", p: [d, c], value: 50 };
console.log("redundant rank", rankOf(m), rankOf(m, [...m.constraints, extra]));
// circle tangent to top line, diameter 10
const cc = pt(20, 10); const circ = { id: "c1", type: "circle", c: cc, r: 3 }; m.entities.push(circ);
m.constraints.push({ id: "t", type: "tangent", e: [l3, "c1"] }, { id: "dd", type: "dim", kind: "diameter", e: ["c1"], value: 10 });
r = solve(m); console.log("tangent", r.ok, circ.r.toFixed(3), (m.points[cc].y + circ.r).toFixed(3));
// angle between two lines
const m2 = emptyModel(); m2.points.q = { x: 10, y: 2 }; m2.points.w = { x: 5, y: 8 };
m2.entities.push({ id: "A", type: "line", p1: "O", p2: "q" }, { id: "B", type: "line", p1: "O", p2: "w" });
m2.constraints.push({ id: "hh", type: "horizontal", e: ["A"] }, { id: "an", type: "dim", kind: "angle", e: ["A", "B"], value: 30, s1: 1, s2: 1 });
r = solve(m2); console.log("angle", r.ok, measureDim(m2, m2.constraints[1]).toFixed(4));
// conflicting: fix a fully-defined point elsewhere
const m3 = JSON.parse(JSON.stringify(m)); m3.constraints.push({ id: "bad", type: "dim", kind: "distance", orient: "h", p: [d, c], value: 70 });
console.log("conflict", solve(m3).ok);
