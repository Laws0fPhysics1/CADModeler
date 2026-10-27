// Gears: involute geometry, meshing placement (checked by B-rep interference), the wizard's plans,
// assembly motion links and URDF mimic export: node tests/gears.test.mjs   (about 20 s)
import assert from "node:assert/strict";
import * as R from "replicad";
import * as K from "../src/kernel.js";
import * as G from "../src/gears.js";
import * as A from "../src/assembly.js";
import { planGears } from "../src/gearplan.js";
import { buildRobot } from "../src/robotexport.js";
await K.initKernel();

let n = 0;
const t = (name, fn) => { const t0 = Date.now(); fn(); n++; console.log("ok -", name, `(${Date.now() - t0} ms)`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ±${tol}`);
const frame = K.ORIGIN_PLANES.XY;
const vol = (s) => R.measureVolume(s);
const overlap = (a, b) => { try { return vol(a.intersect(b)); } catch { return 0; } };

t("sizes: pitch, tip, root, base", () => {
  const S = G.gearSizes({ module: 2, teeth: 20 });
  near(S.pitchDia, 40, 1e-9, "pitch"); near(S.tipRadius, 22, 1e-9, "tip"); near(S.rootRadius, 17.5, 1e-9, "root");
  near(S.baseRadius, 20 * Math.cos((20 * Math.PI) / 180), 1e-9, "base");
  assert.equal(S.minTeethNoUndercut, 18);
  const ring = G.gearSizes({ kind: "ring", module: 2, teeth: 60 });
  near(ring.tipRadius, 58, 1e-9, "ring tip inside the pitch circle");
});
t("solids: spur, helical, ring, rack, hub + bore are valid with sensible volumes", () => {
  const spur = vol(G.buildGear({ module: 2, teeth: 20, width: 10 }));
  assert.ok(spur > Math.PI * 17.5 ** 2 * 10 && spur < Math.PI * 22 ** 2 * 10, `spur ${spur}`);
  near(vol(G.buildGear({ module: 2, teeth: 20, width: 10, helixAngle: 20 })), spur, spur * 0.01, "helical keeps the volume");
  const ring = vol(G.buildGear({ kind: "ring", module: 2, teeth: 60, width: 10 }));
  assert.ok(ring > 0 && ring < Math.PI * (68.5 ** 2 - 58 ** 2) * 10, `ring ${ring}`);
  assert.ok(vol(G.buildGear({ kind: "rack", module: 2, teeth: 10, width: 10 })) > 0);
  const hub = vol(G.buildGear({ module: 1, teeth: 12, width: 5, bore: 4, hubDia: 8, hubLength: 5 }));
  const plain = vol(G.buildGear({ module: 1, teeth: 12, width: 5 }));
  near(hub, plain + Math.PI * 16 * 5 - Math.PI * 4 * 10, 2, "hub added, bore cut through both");
});
t("meshing: zero interference at rest and after turning by the ratio; collision when mis-phased", () => {
  const base = { module: 2, width: 8, pressureAngle: 20 };
  const cases = [
    [{ ...base, teeth: 17, center: [0, 0], phase: 7 }, { ...base, teeth: 31 }, 30],
    [{ ...base, kind: "ring", teeth: 60, center: [0, 0], phase: 3 }, { ...base, teeth: 18 }, 45],
    [{ ...base, teeth: 16, center: [0, 0], phase: 11 }, { ...base, kind: "rack", teeth: 12 }, -90],
    [{ ...base, teeth: 19, helixAngle: 15, center: [0, 0], phase: 0 }, { ...base, teeth: 27, helixAngle: 15, hand: "left" }, 0],
  ];
  for (const [a, bk, dir] of cases) {
    const m = G.meshWith(a, bk, dir);
    const b = { ...bk, center: m.center, phase: m.phase, rackAngle: m.rackAngle };
    const st = K.evaluate([{ id: "g", type: "gear", frame, gears: [a, b] }]);
    const [A0, B0] = st.bodies;
    const turnA = (d) => A0.shape.clone().rotate(d, A0.gear.axisPoint, A0.gear.axisDir);
    const moveB = (x) => (b.kind === "rack" ? B0.shape.clone().translate(B0.gear.travelDir.map((v) => v * x)) : B0.shape.clone().rotate(x, B0.gear.axisPoint, B0.gear.axisDir));
    assert.ok(overlap(A0.shape, B0.shape) < 0.01, `${G.gearName(bk)} at rest`);
    assert.ok(overlap(turnA(3.7), moveB(m.ratio * 3.7)) < 0.05, `${G.gearName(bk)} turned`);
    assert.ok(overlap(turnA(3.7), moveB(-m.ratio * 3.7)) > 1, `${G.gearName(bk)} wrong way collides`);
  }
});
t("contact ratios are in the normal range", () => {
  const cr = G.contactRatio({ module: 2, teeth: 20 }, { module: 2, teeth: 40 });
  assert.ok(cr > 1.5 && cr < 1.8, `${cr}`);
});
t("wizard plans: train ratios, planetary relations, rack travel", () => {
  const tr = planGears({ mode: "train", train: "20, 40, 16" });
  assert.equal(tr.gears.length, 3);
  near(tr.links[0].ratio * tr.links[1].ratio, (-20 / 40) * (-40 / 16), 1e-12, "train ratio");
  assert.deepEqual(tr.gears.map((g) => g.hand), ["right", "left", "right"]);
  const pl = planGears({ mode: "planetary", sun: 18, planet: 15, planets: 3 });
  assert.equal(pl.gears.length, 5); assert.deepEqual(pl.fixed, [4]);
  near(pl.links[0].ratio, 18 / 66, 1e-12, "sun to carrier");
  near(Math.hypot(...pl.gears[4].center), 0, 1e-9, "ring concentric with the sun");
  assert.equal(planGears({ mode: "planetary", sun: 18, planet: 15, planets: 4 }).warnings.length > 0, true, "4 planets don't fit 18/15/48");
  const rk = planGears({ mode: "rack", teeth1: 20, module: 2 });
  near(rk.links[0].ratio * 360, Math.PI * 40, 1e-9, "one pinion turn = pitch circumference");
});
t("assembly motion links: chains, offsets, loops and limits", () => {
  const asm = A.normalizeAssembly({
    components: [{ id: "f", bodies: [], grounded: true }, { id: "a", bodies: ["B1"] }, { id: "b", bodies: ["B2"] }, { id: "c", bodies: ["B3"] }],
    joints: ["a", "b", "c"].map((c, i) => ({ id: `j${i + 1}`, type: "revolute", parent: "f", child: c, value: i === 0 ? 30 : 999 })),
    links: [{ id: "l1", driver: "j1", driven: "j2", ratio: -0.5 }, { id: "l2", driver: "j2", driven: "j3", ratio: -2, offset: 5 }],
  });
  const s = A.solveAssembly(asm);
  near(s.values.get("j2"), -15, 1e-12, "driven"); near(s.values.get("j3"), 35, 1e-12, "chained + offset");
  near(Math.atan2(s.transforms.get("b")[1], s.transforms.get("b")[0]) * 180 / Math.PI, -15, 1e-9, "placement follows");
  asm.links.push({ id: "l3", driver: "j3", driven: "j1", ratio: 1, offset: 0 });
  const s2 = A.solveAssembly(asm);
  assert.ok(s2.errors.some((e) => e.link && /loop/.test(e.message)), "loop reported");
  asm.links = [{ id: "x", driver: "j1", driven: "j2", ratio: 1, offset: 0 }, { id: "y", driver: "j3", driven: "j2", ratio: 1, offset: 0 }];
  assert.ok(A.solveAssembly(asm).errors.some((e) => e.link === "y"), "second driver refused");
});
t("robot export writes motion links as URDF mimic joints", () => {
  const st = K.evaluate([{ id: "g", type: "gear", frame, gears: [{ module: 2, teeth: 20, center: [0, 0], phase: 0 }, { module: 2, teeth: 40, center: [60, 0], phase: 0 }] }]);
  const doc = { name: "gears", features: [], hidden: [], appearances: {}, assembly: A.normalizeAssembly({
    components: [{ id: "f", bodies: [], grounded: true }, { id: "a", bodies: ["Body1"] }, { id: "b", bodies: ["Body2"] }],
    joints: [{ id: "j1", name: "pinion", type: "revolute", parent: "f", child: "a" },
      { id: "j2", name: "wheel", type: "revolute", parent: "f", child: "b", frameParent: A.toArray(A.translation(60, 0, 0)), frameChild: A.toArray(A.translation(60, 0, 0)) }],
    links: [{ id: "l", driver: "j1", driven: "j2", ratio: -0.5 }],
  }) };
  const pkg = buildRobot(doc, st, { format: "urdf" });
  const urdf = Object.entries(pkg.files || {}).filter(([k]) => k.endsWith(".urdf")).map(([, v]) => String(v)).join("") || String(pkg.urdf || "");
  assert.match(urdf, /<mimic joint="pinion" multiplier="-0\.5" offset="0"\/>/);
});
console.log(`\n${n} gear tests passed`);
