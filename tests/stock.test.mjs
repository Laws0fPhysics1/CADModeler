// Shop stock library: node tests/stock.test.mjs
import * as K from "../src/kernel.js";
import * as S from "../src/stock.js";
import * as F from "../src/fasteners.js";
import * as R from "replicad";
await K.initKernel();

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL", msg); } else console.log("ok  ", msg); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const bounds = (shape) => shape.boundingBox.bounds;
const ext = (bb) => [0, 1, 2].map((i) => bb[1][i] - bb[0][i]);

// ---- catalog
const counts = {};
for (const it of S.STOCK_ITEMS) counts[it.category] = (counts[it.category] || 0) + 1;
console.log("catalog:", JSON.stringify(counts), "total", S.STOCK_ITEMS.length);
ok(S.CATEGORIES.every((c) => counts[c.id] > 0), "every category has items");
ok(S.STOCK_ITEMS.every((it) => it.id && it.category && it.name && it.size && it.family), "every item has id, category, name, size, family");
ok(new Set(S.STOCK_ITEMS.map((i) => i.id)).size === S.STOCK_ITEMS.length, "ids are unique");

// ---- every non-hardware item builds with positive volume and the cross-section its catalogue entry claims
{
  let bad = [], t0 = performance.now();
  for (const it of S.STOCK_ITEMS) {
    if (it.fastener) continue;
    try {
      const L = it.length != null ? 50 : 0;
      const { shape, env } = S.buildStock(it.id, L, S.defaultParams(it.id));
      const v = R.measureVolume(shape);
      const e = ext(bounds(shape));
      if (!(v > 0)) { bad.push(`${it.id}: volume ${v}`); continue; }
      if (it.plate) { if (!near(e[0], 50, 1e-3) || !near(e[1], 200, 1e-3) || !near(e[2], it.thickness, 1e-3)) bad.push(`${it.id}: plate ${e}`); continue; }
      if (it.length != null && !near(e[2], 50, 1e-3)) bad.push(`${it.id}: length ${e[2]}`);
      if (!near(e[0], env[1] - env[0], 0.02) || !near(e[1], env[3] - env[2], 0.02)) bad.push(`${it.id}: section ${e[0].toFixed(2)} × ${e[1].toFixed(2)} vs env ${(env[1] - env[0]).toFixed(2)} × ${(env[3] - env[2]).toFixed(2)}`);
    } catch (e) { bad.push(`${it.id}: ${e.message || e}`); }
  }
  ok(!bad.length, `all ${S.STOCK_ITEMS.filter((i) => !i.fastener).length} stock items build with the catalogued section (${(performance.now() - t0).toFixed(0)} ms)${bad.length ? "\n   " + bad.join("\n   ") : ""}`);
}

// ---- spot checks against the standards
{
  const { shape } = S.buildStock("tslot-1530", 100);
  const e = ext(bounds(shape));
  ok(near(e[0], 38.1, 1e-3) && near(e[1], 76.2, 1e-3), `80/20 1530 is 38.1 × 76.2 mm (${e[0].toFixed(3)} × ${e[1].toFixed(3)})`);
  const area = R.measureVolume(shape) / 100;
  ok(area > 600 && area < 2000, `1530 section area ${area.toFixed(0)} mm² is plausible (cored, not solid 2903)`);
  const m20 = R.measureVolume(S.buildStock("tslot-m2020", 1000).shape) * 2.7e-6;
  ok(m20 > 0.4 && m20 < 0.65, `2020 weighs ${m20.toFixed(2)} kg/m (Misumi HFS5-2020: about 0.5)`);
}
{
  const it = S.stockItem("pipe-steel-s40-1_2");
  ok(near(it.dims.od, 21.336, 1e-3) && near(it.dims.wall, 2.7686, 1e-3), `1/2" Sch 40 pipe: OD ${it.dims.od.toFixed(2)}, wall ${it.dims.wall.toFixed(2)} (21.34 / 2.77)`);
  const { shape } = S.buildStock(it.id, 100);
  const e = ext(bounds(shape));
  const v = R.measureVolume(shape), expect = (Math.PI / 4) * (21.336 ** 2 - (21.336 - 2 * 2.7686) ** 2) * 100;
  ok(near(e[0], 21.336, 1e-3) && near(v, expect, expect * 1e-4), `pipe OD ${e[0].toFixed(3)} and wall from volume`);
  ok(near(S.stockItem("pipe-steel-s80-1_2").dims.wall, 3.7338, 1e-3), "1/2\" Sch 80 wall 3.73");
}
{
  const { shape } = S.buildStock("bearing-608");
  const e = ext(bounds(shape));
  ok(near(e[0], 22, 1e-3) && near(e[2], 7, 1e-3), `608 bearing 22 OD × 7 wide (${e[0].toFixed(2)} × ${e[2].toFixed(2)})`);
  const hole = R.measureDistanceBetween(shape, R.makeVertex([0, 0, 3.5]));
  ok(near(hole, 4, 1e-3), `608 bore radius 4 (${hole.toFixed(3)})`);
  const n = S.buildStock("nema17", 0, { bodyLength: 48 }).shape;
  const en = ext(bounds(n));
  ok(near(en[0], 42.3, 1e-3) && near(en[2], 48 + 24, 1e-3), `NEMA 17 × 48: ${en.map((x) => x.toFixed(1)).join(" × ")}`);
}

// ---- search
const first = (q) => (S.searchStock(q)[0] || {}).id;
ok(first("1530") === "tslot-1530", `"1530" → ${first("1530")}`);
ok(first("1/2 pipe") === "pipe-steel-s40-1_2", `"1/2 pipe" → ${first("1/2 pipe")}`);
ok(S.searchStock("m4 bolt").slice(0, 4).every((it) => it.fastener && it.fastener.size === "M4"), `"m4 bolt" → ${S.searchStock("m4 bolt").slice(0, 3).map((i) => i.name).join(", ")}`);
ok(first("608") === "bearing-608" && first("nema 17") === "nema17" && first("1/4-20 nut") === "fastener-hexNut-1/4-20", "608, nema 17, 1/4-20 nut");
ok(S.searchStock("zzzz").length === 0, "nonsense finds nothing");

// ---- hardware becomes fastener features
{
  const f = S.stockFeature({ item: "fastener-socketCap-M4", params: { threads: "cosmetic" } });
  ok(f.type === "fastener" && f.kind === "socketCap" && f.size === "M4" && f.length === 16, `M4 SHCS → fastener feature, default length ${f.length}`);
  const st = K.evaluate([{ id: "a", ...f }]);
  ok(!Object.keys(st.errors).length && st.bodies[0].name === "M4 × 16 Socket Cap Screw", `builds as ${st.bodies[0] && st.bodies[0].name}`);
  const imp = S.stockFeature({ item: "fastener-socketCap-1/4-20", params: { threads: "cosmetic" } });
  const si = K.evaluate([{ id: "b", ...imp }]);
  const e = ext(bounds(si.bodies[0].shape));
  ok(!Object.keys(si.errors).length && near(imp.length, 25.4) && near(e[0], 0.375 * 25.4, 1e-3) && near(e[2], 25.4 + 6.35, 1e-3), `1/4-20 × 1" SHCS: head Ø${e[0].toFixed(2)}, overall ${e[2].toFixed(2)} mm`);
  ok(F.autoSize(6.6) === "M6", "imperial sizes stay out of autoSize");
}

// ---- kernel feature: standalone, named, material
const stockF = (o) => ({ id: "s" + Math.random().toString(36).slice(2), ...S.stockFeature(o) });
{
  const f = stockF({ item: "tslot-1530", length: 500 });
  const st = K.evaluate([f]);
  const b = st.bodies[0];
  ok(!Object.keys(st.errors).length && b && b.name === "1530 T-slot × 500 mm", `body name "${b && b.name}"`);
  const bb = bounds(b.shape);
  ok(near(bb[0][2], 0) && near(bb[1][2], 500) && near(bb[0][0], -19.05) && near(bb[1][1], 38.1), "stands on the origin along +Z, centred");
  ok(b.stockAppearance && b.stockAppearance.materialId === "aluminum-6061", "default material aluminium");
  const ov = K.evaluate([{ ...f, material: "steel-mild" }]).bodies[0];
  ok(ov.stockAppearance.materialId === "steel-mild", "material override");
  const again = K.evaluate([f]).bodies[0];
  ok(again.shape === b.shape, "placed shape is reused on replay");
  // lying along X on the ground, rotated 90° about its axis
  const lx = K.evaluate([{ ...f, direction: "x" }]).bodies[0];
  let e = bounds(lx.shape);
  ok(near(e[0][0], 0) && near(e[1][0], 500) && near(e[0][2], 0, 1e-3) && near(e[1][2] - e[0][2], 38.1, 1e-3), `along X, resting on XY (z ${e[0][2].toFixed(2)}..${e[1][2].toFixed(2)})`);
  const lr = K.evaluate([{ ...f, direction: "x", rotation: 90 }]).bodies[0];
  e = bounds(lr.shape);
  ok(near(e[0][2], 0, 1e-3) && near(e[1][2] - e[0][2], 76.2, 1e-3), `rotated 90° stands on its narrow side (height ${(e[1][2] - e[0][2]).toFixed(2)})`);
  const plate = K.evaluate([stockF({ item: "plate-al-1_4", length: 300, params: { width: 150 } })]).bodies[0];
  e = ext(bounds(plate.shape));
  ok(near(e[0], 300) && near(e[1], 150) && near(e[2], 6.35) && plate.name === '1/4" Aluminum Plate 300 × 150 mm', `plate ${plate.name}`);
  const bad = K.evaluate([{ ...f, length: 0 }]);
  ok(/Length/.test(Object.values(bad.errors)[0] || ""), "zero length is an error");
}

// ---- placement on a face and in a hole (a 10 mm plate with an 8 mm hole)
{
  const sk = { id: "s1", type: "sketch", name: "Sketch1", plane: K.ORIGIN_PLANES.XY, entities: [
    { id: "a", type: "line", a: [-30, -30], b: [30, -30] }, { id: "b", type: "line", a: [30, -30], b: [30, 30] },
    { id: "c", type: "line", a: [30, 30], b: [-30, 30] }, { id: "d", type: "line", a: [-30, 30], b: [-30, -30] },
    { id: "h", type: "circle", c: [10, 5], r: 4 }] };
  let st = K.evaluate([sk]);
  const prof = st.sketches.s1.profiles.reduce((a, b) => (a.area > b.area ? a : b));
  const ex = { id: "e1", type: "extrude", profiles: [{ kind: "profile", sketch: "s1", pt: prof.center2d, area: prof.area }], distance: 10, direction: "one", operation: "auto" };
  st = K.evaluate([sk, ex]);
  const plate = st.bodies[0].shape;
  const top = plate.faces.findIndex((f) => f.geomType === "PLANE" && near(f.center.z, 10));
  const side = plate.faces.findIndex((f) => f.geomType === "PLANE" && near(f.center.x, 30));
  const rim = plate.edges.findIndex((e) => e.geomType === "CIRCLE" && near(e.pointAt(0).z, 10));

  let s2 = K.evaluate([sk, ex, stockF({ item: "tslot-m2020", length: 100, place: { kind: "face", ...K.faceRef(st, "Body1", top) } })]);
  let bb = bounds(s2.bodies[1].shape);
  ok(!Object.keys(s2.errors).length && near(bb[0][2], 10) && near(bb[1][2], 110) && near((bb[0][0] + bb[1][0]) / 2, plate.faces[top].center.x, 1e-3), `2020 on the top face (at its centroid) stands up from it (z ${bb[0][2].toFixed(1)}..${bb[1][2].toFixed(1)})`);
  s2 = K.evaluate([sk, ex, stockF({ item: "tslot-m2020", length: 100, place: { kind: "face", ...K.faceRef(st, "Body1", side) } })]);
  bb = bounds(s2.bodies[1].shape);
  ok(near(bb[0][0], 30) && near(bb[1][0], 130) && near(bb[0][2], -5) && near(bb[1][2], 15), `on the +X side face it runs along +X (x ${bb[0][0].toFixed(1)}..${bb[1][0].toFixed(1)})`);
  s2 = K.evaluate([sk, ex, stockF({ item: "shaft-m8", length: 40, place: { kind: "edge", ...K.edgeRef(st, "Body1", rim) }, direction: "flip", offset: -30 })]);
  bb = bounds(s2.bodies[1].shape);
  ok(near((bb[0][0] + bb[1][0]) / 2, 10, 1e-3) && near((bb[0][1] + bb[1][1]) / 2, 5, 1e-3) && near(bb[1][2], 40) && near(bb[0][2], 0), `8 mm shaft through the hole rim, flipped with -30 offset (z ${bb[0][2].toFixed(1)}..${bb[1][2].toFixed(1)})`);
}

// ---- default appearances follow the stock bodies
{
  const ap = { Body9: { materialId: "abs" } };
  const bodies = [{ id: "Body1", stockAppearance: { materialId: "aluminum-6061" } }, { id: "Body2", stockAppearance: { materialId: "abs", color: "#f1f1ec" } }, { id: "Body3" }];
  ok(S.syncStockAppearances(bodies, ap) && ap.Body1.materialId === "aluminum-6061" && ap.Body1.auto && ap.Body2.color === "#f1f1ec" && ap.Body9.materialId === "abs", "stock defaults are written with auto: true");
  ap.Body2 = { materialId: "brass" };                                   // user override (no auto flag) wins
  bodies[0].stockAppearance = { materialId: "steel-mild" };
  ok(S.syncStockAppearances(bodies, ap) && ap.Body1.materialId === "steel-mild" && ap.Body2.materialId === "brass", "auto entries update; user ones stay");
  ok(!S.syncStockAppearances(bodies, ap), "no change the second time");
  ok(S.syncStockAppearances([{ id: "Body3" }], ap) && !ap.Body1 && ap.Body2 && ap.Body9, "auto entries go when the stock body does");
}

console.log(fails ? `${fails} stock test(s) FAILED` : "all stock tests passed");
process.exit(fails ? 1 : 0);
