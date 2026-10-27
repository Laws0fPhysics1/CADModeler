// Smoke test for the geometry kernel: node tests/kernel.test.mjs
import * as K from "../src/kernel.js";
await K.initKernel();
const L = (a, b) => ({ id: Math.random() + "", type: "line", a, b });
const sk = { id: "s1", type: "sketch", name: "Sketch1", plane: K.ORIGIN_PLANES.XY, entities: [L([0, 0], [40, 0]), L([40, 0], [40, 20]), L([40, 20], [0, 20]), L([0, 20], [0, 0]), { id: "c", type: "circle", c: [30, 10], r: 5 }, { id: "c2", type: "circle", c: [40, 20], r: 6 }] };
let st = K.evaluate([sk]);
console.log("profiles", st.sketches.s1.profiles.map((p) => p.area.toFixed(1) + "@" + p.center2d.map((v) => v.toFixed(1))).join(" | "));
const prof = st.sketches.s1.profiles.reduce((a, b) => (a.area > b.area ? a : b));
const ex = { id: "e1", type: "extrude", profiles: [{ kind: "profile", sketch: "s1", pt: prof.center2d, area: prof.area }], distance: 10, direction: "one", operation: "auto" };
st = K.evaluate([sk, ex]);
console.log("bodies", st.bodies.length, st.errors, K.bodyInfo(st.bodies[0].shape).volume.toFixed(1));
const top = st.bodies[0].shape.faces.findIndex((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 10) < 1e-6);
const fl = { id: "f1", type: "fillet", edges: [K.edgeRef(st, "Body1", 0)], radius: 2 };
const sh = { id: "sh", type: "shell", faces: [K.faceRef(st, "Body1", top)], thickness: 1 };
const pp = { id: "pp", type: "extrude", profiles: [{ kind: "face", ...K.faceRef(st, "Body1", top) }], distance: -3, direction: "one", operation: "auto" };
const rv = { id: "r", type: "revolve", profiles: [{ kind: "profile", sketch: "s1", pt: prof.center2d, area: prof.area }], axis: { kind: "sketchY" }, angle: 90, operation: "new" };
const bx = { id: "b", type: "box", length: 10, width: 10, height: 30, operation: "auto" };
for (const extra of [fl, sh, pp, rv, bx]) {
  const s = K.evaluate([sk, ex, extra]);
  console.log(extra.type, s.bodies.length, JSON.stringify(s.errors), s.bodies.map((b) => K.bodyInfo(b.shape).volume.toFixed(1)).join(","));
}
const m = K.meshBody(st.bodies[0].shape);
console.log("mesh", m.faces.faceGroups.length, m.edges.edgeGroups.length, JSON.stringify(m.faces.faceGroups[1]));

// Bug report 2026-10-09: a revolved quarter circle (dome) had a flipped vertex normal at its pole.
// The user's own design (sketch + 270° revolve), copied from the report.
{
  const { readFileSync } = await import("node:fs");
  const feats = JSON.parse(readFileSync(new URL("./fixtures-dome.json", import.meta.url), "utf8"));
  const sd = K.evaluate(feats);
  const fm = K.meshBody(sd.bodies[0].shape).faces;
  let bad = 0;
  for (let i = 0; i < fm.vertices.length; i += 3) {
    const r = Math.hypot(fm.vertices[i], fm.vertices[i + 1]), top = Math.abs(fm.vertices[i + 2] - 60) < 1e-6;
    if (r < 1e-6 && top && fm.normals[i + 2] < -0.5) bad++; // end caps meet the pole with sideways normals; only a flipped dome normal points down
  }
  console.log("dome pole normals", bad === 0 ? "ok" : "FLIPPED " + bad, JSON.stringify(sd.errors));
  if (bad) process.exitCode = 1;
}

// Bug report 2026-10-09 09:00: the Shell drag arrow sat at the removed face's centroid (off the surface on
// curved faces) and pointed along it, so at a real thickness its tip ended up outside the part.
// K.faceFrameAt gives a point on the face + its outward normal; K.shellFrame puts the arrow on the removed
// face's rim, pointing into the kept wall, so origin + dir·thickness is on the new inner wall.
{
  const { readFileSync } = await import("node:fs");
  const R = await import("replicad");
  let fails = 0;
  const check = (name, ok, info = "") => { console.log(ok ? "ok  " : "FAIL", name, info); if (!ok) fails++; };
  const inside = (shape, p) => R.measureDistanceBetween(R.makeVertex(p), shape) < 1e-9;
  const onFace = (shape, i, p) => R.measureDistanceBetween(R.makeVertex(p), shape.faces[i]);
  // into the material: a small step along dir, nudged into the removed face's side, stays in the solid
  const intoSolid = (shape, fr, s = 0.05) => inside(shape, K.V.sub(K.V.add(fr.origin, K.V.mul(fr.dir, s)), K.V.mul(fr.normal, s)));
  const cases = [];
  // planar: the top of the 40 x 20 x 10 plate (a hole through it)
  cases.push({ name: "plate top", shape: st.bodies[0].shape, idx: top, near: [20, 12, 10] });
  // cylinder side (curved, centroid on the axis) and its top
  const cy = K.evaluate([{ id: "c", type: "cylinder", radius: 10, height: 20, operation: "new" }]).bodies[0].shape;
  const side = cy.faces.findIndex((f) => f.geomType === "CYLINDRE"), ctop = cy.faces.findIndex((f) => f.geomType === "PLANE" && f.center.z > 10);
  cases.push({ name: "cylinder side", shape: cy, idx: side }, { name: "cylinder top", shape: cy, idx: ctop });
  // the user's design: profile (square + quarter disc) revolved 270° about the Z axis -> dome + cylinder + caps
  const dome = K.evaluate(JSON.parse(readFileSync(new URL("./fixtures-shell-dome.json", import.meta.url), "utf8"))).bodies[0].shape;
  const sph = dome.faces.findIndex((f) => f.geomType === "SPHERE"), dcy = dome.faces.findIndex((f) => f.geomType === "CYLINDRE");
  const caps = dome.faces.map((f, i) => (f.geomType === "PLANE" && Math.abs(f.center.z - 27.2) < 0.1 ? i : -1)).filter((i) => i >= 0);
  const capX = caps.find((i) => Math.abs(dome.faces[i].center.x) < 1e-6); // the cap in the x = 0 plane the user picked first
  cases.push({ name: "dome sphere", shape: dome, idx: sph }, { name: "dome cylinder", shape: dome, idx: dcy },
    { name: "dome cap (user pick)", shape: dome, idx: capX, near: [0, -5.940614193763608, 41.500997696834624] },
    { name: "dome both caps (user)", shape: dome, idx: capX, near: [0, -5.940614193763608, 41.500997696834624], removed: caps });
  for (const c of cases) {
    const ff = K.faceFrameAt(c.shape, c.idx, c.near);
    const fi = K.faceInfo(c.shape, c.idx);
    check(`faceFrameAt ${c.name} on face`, ff && onFace(c.shape, c.idx, ff.origin) < 1e-6, ff && `(${onFace(c.shape, c.idx, ff.origin).toExponential(1)}; centroid ${onFace(c.shape, c.idx, fi.center).toFixed(2)} off)`);
    check(`faceFrameAt ${c.name} normal out`, ff && !inside(c.shape, K.V.add(ff.origin, K.V.mul(ff.normal, 0.05))) && inside(c.shape, K.V.add(ff.origin, K.V.mul(ff.dir, 0.05))));
    const sf = K.shellFrame(c.shape, c.idx, c.near, c.removed || [c.idx]);
    check(`shellFrame ${c.name} on face rim`, sf && sf.rim && onFace(c.shape, c.idx, sf.origin) < 1e-6, sf && JSON.stringify(sf.origin.map((v) => +v.toFixed(2))));
    check(`shellFrame ${c.name} into material`, sf && intoSolid(c.shape, sf), sf && JSON.stringify(sf.dir.map((v) => +v.toFixed(3))));
  }
  // the user's case at their thickness (27.5 mm, both caps removed): the tip lies inside the part (it used to stick out the back)
  {
    const sf = K.shellFrame(dome, capX, [0, -5.940614193763608, 41.500997696834624], caps);
    const tip = K.V.add(sf.origin, K.V.mul(sf.dir, 27.5));
    check("dome tip at 27.5 mm inside the part", inside(dome, tip) || R.measureDistanceBetween(R.makeVertex(tip), dome) < 0.5, JSON.stringify(tip.map((v) => +v.toFixed(2))));
  }
  // plate: the arrow from the top face's rim points along the side wall's inward normal (horizontal)
  {
    const sf = K.shellFrame(st.bodies[0].shape, top, [20, 12, 10]);
    check("plate arrow horizontal", Math.abs(sf.dir[2]) < 1e-6 && Math.abs(sf.origin[2] - 10) < 1e-6, JSON.stringify(sf));
  }
  console.log("shell arrow frames", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// Move/Copy feature (feature request 2026-10-09: translate + rotate gizmo). Box 10×10×30 at the origin
// (x,y in [-5,5], z in [0,30]), turned 90° about X through its centre, then moved +100 in X.
{
  let fails = 0;
  const check = (name, ok, info = "") => { console.log(ok ? "ok  " : "FAIL", name, info); if (!ok) fails++; };
  const box = { id: "bx", type: "box", length: 10, width: 10, height: 30, operation: "new" };
  const bb = (s) => { const vs = K.meshBody(s).faces.vertices, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < vs.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], vs[i + k]); hi[k] = Math.max(hi[k], vs[i + k]); } return [lo, hi].map((p) => p.map((v) => +v.toFixed(3))); };
  const b0 = bb(K.evaluate([box]).bodies[0].shape);
  const piv = b0[0].map((v, k) => (v + b0[1][k]) / 2);
  const mv = { id: "mv", type: "move", bodies: ["Body1"], translate: [100, 0, 0], rotate: [90, 0, 0], pivot: piv };
  const s1 = K.evaluate([box, mv]);
  const b1 = bb(s1.bodies[0].shape);
  check("move: one body, no errors", s1.bodies.length === 1 && !Object.keys(s1.errors).length, JSON.stringify(s1.errors));
  // after 90° about X the 30 mm height lies along Y, centred on the pivot
  const size = b1[1].map((v, k) => +(v - b1[0][k]).toFixed(3)), ctr = b1[0].map((v, k) => +((v + b1[1][k]) / 2).toFixed(3));
  check("move: rotated extent", Math.abs(size[0] - 10) < 1e-3 && Math.abs(size[1] - 30) < 1e-3 && Math.abs(size[2] - 10) < 1e-3, JSON.stringify(size));
  check("move: centre translated", Math.abs(ctr[0] - (piv[0] + 100)) < 1e-3 && Math.abs(ctr[1] - piv[1]) < 1e-3 && Math.abs(ctr[2] - piv[2]) < 1e-3, JSON.stringify(ctr));
  const s2 = K.evaluate([box, { ...mv, copy: true }]);
  check("move copy: two bodies, original kept", s2.bodies.length === 2 && JSON.stringify(bb(s2.bodies[0].shape)) === JSON.stringify(b0), s2.bodies.map((b) => b.id).join(","));
  const s3 = K.evaluate([box, { ...mv, bodies: ["Body9"] }]);
  check("move: missing body is a feature error", !!s3.errors.mv, JSON.stringify(s3.errors));
  console.log("move feature", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// fast shape.faces / .edges (kernel patchTopoLists, bug report 2026-10-18 15:32): same items in the same
// order as replicad's own explorer + IsSame dedupe, and the mesh's face / edge groups line up with them
{
  const R = await import("replicad");
  let fails = 0;
  const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${info}`); };
  const shape = R.makeCylinder(10, 20).fuse(R.makeBox([-30, -5, 0], [30, 5, 8])).fillet(1, (e) => e.inPlane("XY", 8));
  for (const [key, topo] of [["faces", "face"], ["edges", "edge"]]) {
    const fast = shape[key], ref = [...R.iterTopo(shape.wrapped, topo)];
    check(`${key}: same count`, fast.length === ref.length, `${fast.length} vs ${ref.length}`);
    check(`${key}: same order`, fast.every((x, i) => x.wrapped.IsSame(ref[i])));
    check(`${key}: cached, fresh array`, shape[key] !== fast && shape[key][0] === fast[0]);
  }
  const m = K.meshBody(shape);
  check("mesh groups match", m.faces.faceGroups.length === shape.faces.length && m.edges.edgeGroups.length === shape.edges.length);
  console.log("topology lists", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// sketches on a body's face (and bodies extruded from them) remember that host body, so they follow
// its assembly placement on screen (bug report 2026-10-18 18:33)
{
  let fails = 0;
  const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${info}`); };
  const box = { id: "hb", type: "box", name: "Box1", length: 20, width: 20, height: 10, operation: "new" };
  const s0 = K.evaluate([box]);
  const fs = s0.bodies[0].shape.faces, top = fs.reduce((bi, f, i) => (f.center.z > fs[bi].center.z ? i : bi), 0);
  const plane = K.planeFromFace(fs[top]), tc = fs[top].center;
  const c = K.to2D(plane, [tc.x, tc.y, tc.z]);
  const L2 = (a, b) => ({ id: Math.random() + "", type: "line", a, b });
  const sq = [[c[0] - 3, c[1] - 3], [c[0] + 3, c[1] - 3], [c[0] + 3, c[1] + 3], [c[0] - 3, c[1] + 3]];
  const sk2 = { id: "hs", type: "sketch", name: "S", plane, planeRef: { kind: "face", ref: { kind: "face", body: s0.bodies[0].id, idx: top, pt: [0, 0, 10], n: [0, 0, 1] } }, entities: sq.map((p, i) => L2(p, sq[(i + 1) % 4])) };
  const s1 = K.evaluate([box, sk2]);
  check("sketch host", s1.sketches.hs.host === s0.bodies[0].id, s1.sketches.hs.host);
  const pr = s1.sketches.hs.profiles[0];
  const ex2 = { id: "he", type: "extrude", profiles: [{ kind: "profile", sketch: "hs", pt: pr.center2d, area: pr.area }], distance: 5, direction: "one", operation: "new" };
  const s2 = K.evaluate([box, sk2, ex2]);
  check("new body host", s2.bodies.length === 2 && s2.bodies[1].host === s0.bodies[0].id, JSON.stringify(s2.errors));
  console.log("sketch hosts", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// cut edges (sketch Intersect, feature request 2026-10-18 18:42): a plane through a box with a hole gives
// its rectangle + the hole circle; a plane lying on a face only touches the body and gives nothing
{
  const R = await import("replicad");
  let fails = 0;
  const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${info}`); };
  const shape = R.makeBox([0, 0, 0], [40, 20, 10]).cut(R.makeCylinder(4, 10, [20, 10, 0]));
  const mid = K.sectionEntities(shape, { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, 0, 1] });
  const lines = mid.filter((e) => e.type === "line").length, round = mid.filter((e) => e.type !== "line");
  check("cut through: 4 lines", lines === 4, `${lines}`);
  check("cut through: hole", round.length >= 1 && round.every((e) => e.type === "circle" ? Math.abs(e.r - 4) < 1e-6 : true), JSON.stringify(round.map((e) => e.type)));
  check("plane on a face: nothing", K.sectionEntities(shape, { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] }).length === 0);
  check("plane missing the body: nothing", K.sectionEntities(shape, { origin: [0, 0, 50], xDir: [1, 0, 0], normal: [0, 0, 1] }).length === 0);
  console.log("cut edges", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// incremental replay (prefix cache, bug report 2026-10-18 19:29): same results warm and cold, edits in
// place (Suppress) are picked up, and the cached prefix states aren't disturbed by later features
{
  let fails = 0;
  const check = (name, ok, info = "") => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${name} ${info}`); };
  const box = { id: "pb", type: "box", name: "Box1", length: 30, width: 20, height: 10, operation: "new" };
  const cyl = { id: "pc", type: "cylinder", name: "Cyl1", radius: 4, height: 30, operation: "new" };
  const feats = [box, cyl];
  K.clearShapeCaches();
  const cold = K.evaluate(feats);
  const warm = K.evaluate(feats);
  const vols = (st) => st.bodies.map((b) => K.bodyInfo(b.shape).volume.toFixed(3)).join(",");
  check("warm = cold", vols(cold) === vols(warm), vols(warm));
  warm.bodies.pop(); // a caller mutating its state must not change the cache
  check("cache not disturbed", vols(K.evaluate(feats)) === vols(cold));
  cyl.suppressed = true;
  check("in-place suppress seen", K.evaluate(feats).bodies.length === 1);
  delete cyl.suppressed;
  check("prefix reused after edit", K.evaluate(feats, 1).bodies.length === 1 && K.evaluate(feats).bodies.length === 2);
  console.log("incremental replay", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}

// Offset Face (feature request 2026-10-20): thicken + fuse / cut, planar and curved faces
{
  let fails = 0;
  const check = (name, ok, info = "") => { console.log(ok ? "ok  " : "FAIL", name, info); if (!ok) fails++; };
  const box = { id: "ob", type: "box", length: 10, width: 10, height: 10, operation: "new" };
  const base = K.evaluate([box]);
  const vol = (st) => K.bodyInfo(st.bodies[0].shape).volume;
  const faceAt = (st, z) => st.bodies[0].shape.faces.findIndex((f) => f.geomType === "PLANE" && Math.abs(K.faceInfo(st.bodies[0].shape, st.bodies[0].shape.faces.indexOf(f)).center[2] - z) < 1e-6);
  const top = K.faceRef(base, base.bodies[0].id, faceAt(base, 10));
  const v0 = vol(base);
  const out = K.evaluate([box, { id: "o1", type: "offsetFace", faces: [top], distance: 2 }]);
  check("offset face out", Math.abs(vol(out) - v0 * 1.2) < 1e-6, vol(out));
  const inn = K.evaluate([box, { id: "o2", type: "offsetFace", faces: [top], distance: -3 }]);
  check("offset face in", Math.abs(vol(inn) - v0 * 0.7) < 1e-6, vol(inn));
  check("faces merged", inn.bodies[0].shape.faces.length === 6, inn.bodies[0].shape.faces.length);
  const cyl = { id: "oc", type: "cylinder", radius: 5, height: 10, operation: "new" };
  const cs = K.evaluate([cyl]);
  const side = cs.bodies[0].shape.faces.map((f, i) => [f, i]).filter(([f]) => f.geomType === "CYLINDRE").map(([, i]) => K.faceRef(cs, cs.bodies[0].id, i));
  const big = K.evaluate([cyl, { id: "o3", type: "offsetFace", faces: side, distance: 1 }]);
  check("cylinder radius +1", Math.abs(vol(big) - Math.PI * 36 * 10) < 1e-3, vol(big));
  // touching faces offset together: sharp corners, no leftover corner columns (bug report 2026-10-20 19:27)
  const plate = { id: "op", type: "box", length: 40, width: 40, height: 10, operation: "new" };
  const hole = { id: "oh", type: "box", length: 10, width: 10, height: 10, operation: "cut" };
  const ps = K.evaluate([plate, hole]);
  const pshape = ps.bodies[0].shape;
  const walls = pshape.faces.map((f, i) => [K.faceInfo(pshape, i), i]).filter(([fi]) => Math.abs(fi.center[0]) <= 5.01 && Math.abs(fi.center[1]) <= 5.01 && fi.center[2] > 0.1 && fi.center[2] < 9.9).map(([, i]) => K.faceRef(ps, ps.bodies[0].id, i));
  check("square hole has 4 walls", walls.length === 4, walls.length);
  const bigger = K.evaluate([plate, hole, { id: "o4", type: "offsetFace", faces: walls, distance: -1 }]);
  check("square hole -1: sharp 12x12", Math.abs(vol(bigger) - (16000 - 1440)) < 1e-6, vol(bigger));
  check("square hole -1: 10 faces", bigger.bodies[0].shape.faces.length === 10, bigger.bodies[0].shape.faces.length);
  const smaller = K.evaluate([plate, hole, { id: "o5", type: "offsetFace", faces: walls, distance: 1 }]);
  check("square hole +1: sharp 8x8", Math.abs(vol(smaller) - (16000 - 640)) < 1e-6, vol(smaller));
  const two = K.evaluate([box, { id: "o6", type: "offsetFace", faces: [top, K.faceRef(base, base.bodies[0].id, base.bodies[0].shape.faces.findIndex((f, i) => K.faceInfo(base.bodies[0].shape, i).center[0] > 4.9))], distance: 2 }]);
  check("box top + side +2: corner filled", Math.abs(vol(two) - 1440) < 1e-6, vol(two));
  console.log("offset face", fails ? fails + " FAILED" : "ok");
  if (fails) process.exitCode = 1;
}
