// Hybrid designs (inserting a design into another): node tests/hybrid.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as K from "../src/kernel.js";
import * as H from "../src/hybrid.js";
await K.initKernel();

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
const vol = (b) => K.bodyInfo(b.shape).volume;
const sum = (bodies) => bodies.reduce((s, b) => s + vol(b), 0);
const close = (a, b, rel = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${msg} ${a} != ${b}`);

// the user's dome (sketch + 270° revolve) as the source design, like "Test Dome 1" in the Parts folder
const domeFeats = JSON.parse(readFileSync(new URL("./fixtures-dome.json", import.meta.url), "utf8"));
const dome = { id: H.newDocId(), name: "Test Dome 1", kind: "part", features: domeFeats, marker: domeFeats.length, appearances: { Body1: { materialId: "aluminum", color: "#cc8844" } }, assembly: { components: [], joints: [] } };
const domeState = K.evaluate(dome.features, dome.marker);
assert.ok(domeState.bodies.length >= 1, "dome evaluates");
const domeVol = sum(domeState.bodies);

const box = { id: "bx", type: "box", length: 50, width: 50, height: 20, operation: "auto" };
const target = { id: H.newDocId(), name: "Untitled", kind: "part", features: [box], marker: 1, appearances: {} };

t("doc kinds", () => {
  assert.equal(H.docKind(target), "part");
  assert.equal(H.docKind({ name: "Untitled assembly", features: [] }), "assembly");
  assert.equal(H.docKind({ name: "x", features: [], assembly: { components: [{ id: "c" }] } }), "assembly");
  assert.equal(H.docKind({ name: "x", kind: "hybrid", features: [] }), "part", "hybrid without inserts falls back");
  assert.equal(H.docKind({ name: "x", kind: "assembly", features: [{ type: "insert" }] }), "hybrid");
});

t("insert evaluates the source design's bodies (volume, appearance, translate)", () => {
  const f = H.makeInsertFeature(dome, { id: "i1", file: "C:\\Parts\\Test Dome 1.cadm.json" });
  assert.equal(f.type, "insert");
  assert.equal(f.source.id, dome.id);
  assert.equal(f.snapshot.features.length, dome.features.length);
  const st = K.evaluate([box, f]);
  assert.deepEqual(st.errors, {});
  assert.equal(st.bodies.length, 1 + domeState.bodies.length, "new bodies, not joined");
  const ins = st.bodies.filter((b) => b.inserted);
  close(sum(ins), domeVol, 1e-6, "inserted volume");
  close(vol(st.bodies[0]), 50 * 50 * 20, 1e-6, "box untouched");
  assert.equal(ins[0].name, "Test Dome 1");
  assert.equal(ins[0].stockAppearance.materialId, "aluminum");
  // moved copy
  const g = { ...f, id: "i2", translate: [100, 0, 0] };
  const st2 = K.evaluate([box, g]);
  const b0 = K.bodyInfo(st.bodies[1].shape).bounds, b1 = K.bodyInfo(st2.bodies[1].shape).bounds;
  close(b1[0][0] - b0[0][0], 100, 1e-6, "translate x");
  // replaying again (cache) gives the same thing and doesn't consume the cached shapes
  const st3 = K.evaluate([box, f]);
  close(sum(st3.bodies.filter((b) => b.inserted)), domeVol, 1e-6, "cached replay");
  // a rolled-back source (marker) inserts only what's before its marker
  const early = H.makeInsertFeature({ ...dome, marker: 1 }, { id: "i3" }); // sketch only: no bodies
  const st4 = K.evaluate([box, early]);
  assert.ok(st4.errors.i3, "no bodies -> feature error");
});

t("nested insert (a hybrid inserted into another design)", () => {
  const hybrid = { ...target, id: H.newDocId(), name: "Box with dome", features: [box, H.makeInsertFeature(dome, { id: "i1" })], marker: 2 };
  hybrid.kind = H.docKind(hybrid);
  assert.equal(hybrid.kind, "hybrid");
  const cyl = { id: "cy", type: "cylinder", radius: 5, height: 10, operation: "new" };
  const outer = { id: H.newDocId(), name: "Outer", features: [cyl, H.makeInsertFeature(hybrid, { id: "o1", translate: [0, 200, 0] })], marker: 2 };
  assert.equal(outer.features[1].snapshot.kind, "hybrid");
  const st = K.evaluate(outer.features, outer.marker);
  assert.deepEqual(st.errors, {});
  assert.equal(st.bodies.length, 1 + 1 + domeState.bodies.length);
  close(sum(st.bodies), Math.PI * 25 * 10 + 50 * 50 * 20 + domeVol, 1e-4, "nested volume");
  assert.ok(st.bodies.slice(1).every((b) => b.name.startsWith("Box with dome · ")), "nested names");
});

t("loop detection: self and indirect loops", () => {
  const A = { id: "dA", name: "A", features: [box], marker: 1 };
  // self: same id, or same file even when the file has no id
  assert.match(H.insertLoop(A, null, A, null), /itself/);
  assert.match(H.insertLoop({ ...A, id: "other" }, "C:/Parts/A.cadm.json", { name: "A", features: [] }, "c:\\parts\\a.cadm.json"), /itself/);
  // B contains A; inserting B into A is a loop; inserting A into B is just a second copy (allowed: no loop)
  const B = { id: "dB", name: "B", features: [box, H.makeInsertFeature(A, { id: "x" })], marker: 2 };
  assert.match(H.insertLoop(A, null, B, null), /loop/);
  assert.equal(H.insertLoop(B, null, A, null), null);
  // C contains B contains A: inserting C into A is a loop (two levels down), message names the chain
  const C = { id: "dC", name: "C", features: [H.makeInsertFeature(B, { id: "y" })], marker: 1 };
  const why = H.insertLoop(A, null, C, null);
  assert.match(why, /C → B → A/);
  // matched by file path for older files without ids
  const Aold = { name: "A", features: [box], marker: 1 };
  const B2 = { id: "dB2", name: "B2", features: [H.makeInsertFeature(Aold, { id: "z", file: "C:\\Parts\\A.cadm.json" })], marker: 1 };
  assert.match(H.insertLoop({ id: "fresh", name: "A", features: [] }, "C:/Parts/A.cadm.json", B2, null), /loop/);
  // unrelated designs are fine
  assert.equal(H.insertLoop({ id: "dD", name: "D", features: [] }, null, C, null), null);
});

console.log(`hybrid: ${n} tests passed`);
