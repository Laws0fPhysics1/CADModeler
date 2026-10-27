// Sprockets + roller chain, timing pulleys + belts: node tests/chains.test.mjs   (about 15 s)
import assert from "node:assert/strict";
import * as R from "replicad";
import * as K from "../src/kernel.js";
import * as G from "../src/gears.js";
import * as CH from "../src/chains.js";
import { planGears } from "../src/gearplan.js";
await K.initKernel();

let n = 0;
const t = (name, fn) => { const t0 = Date.now(); fn(); n++; console.log("ok -", name, `(${Date.now() - t0} ms)`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ±${tol}`);
const frame = K.ORIGIN_PLANES.XY;
const overlap = (a, b) => { try { return R.measureVolume(a.intersect(b)); } catch { return 0; } };

t("sprocket and pulley sizes follow ANSI / GT2", () => {
  const S = CH.sprocketSizes({ teeth: 18, chain: "40" });
  near(S.pitchDia, 73.14, 0.01, "#40 18T pitch Ø");
  near(2 * S.tipRadius, 12.7 * (0.6 + 1 / Math.tan(Math.PI / 18)), 1e-9, "OD");
  const P = CH.pulleySizes({ teeth: 20, belt: "GT2" });
  near(P.pitchDia, 12.732, 0.001, "GT2 20T pitch Ø"); near(2 * P.tipRadius, 12.224, 0.001, "GT2 20T OD");
});
t("wheels build as valid solids for small and large tooth counts", () => {
  for (const z of [9, 12, 18, 40]) assert.ok(R.measureVolume(G.buildGear({ kind: "sprocket", teeth: z, chain: "25" })) > 0, `sprocket ${z}`);
  for (const z of [12, 20, 60]) assert.ok(R.measureVolume(G.buildGear({ kind: "pulley", teeth: z, belt: "GT2", width: 7, flanges: true, bore: 5 })) > 0, `pulley ${z}`);
});
t("chain drives close with whole links matching the standard chain-length formula", () => {
  for (const [n1, n2, C, ch, free] of [[18, 36, 300, "40", true], [12, 12, 150, "25", true], [9, 45, 400, "35", true], [40, 15, 250, "bike", true], [11, 30, 200, "25", false]]) {
    const cd = CH.chainDrive({ teeth: n1, chain: ch, center: [5, 5], phase: 3 }, n2, C, 30, { freePhase: free });
    const p = CH.chainOf(ch).p;
    const L = (2 * cd.C) / p + (n1 + n2) / 2 + (p * (n2 - n1) ** 2) / (4 * Math.PI ** 2 * cd.C);
    near(cd.links, L, 0.6, `${n1}/${n2} links`);
    for (let i = 0; i < cd.links; i++) near(Math.hypot(cd.rollers[i][0] - cd.rollers[(i + 1) % cd.links][0], cd.rollers[i][1] - cd.rollers[(i + 1) % cd.links][1]), p, 1e-6, "pitch");
  }
});
t("chain rollers sit in both sprockets' seats (no interference) and follow them round", () => {
  const a = { kind: "sprocket", teeth: 18, chain: "40", center: [0, 0], phase: 7 };
  const cd = CH.chainDrive(a, 36, 300, 20);
  a.phase = cd.phaseA;
  const st = K.evaluate([{ id: "g", type: "gear", frame, gears: [a, { kind: "sprocket", teeth: 36, chain: "40", center: cd.center, phase: cd.phase }] }]);
  const w = CH.sprocketSizes(a).width, c = CH.chainOf("40");
  const rollers = R.makeCompound(cd.rollers.map((r) => R.makeCylinder(c.dr / 2, c.w, [r[0], r[1], w / 2 - c.w / 2], [0, 0, 1])));
  assert.ok(overlap(st.bodies[0].shape, rollers) < 0.01 && overlap(st.bodies[1].shape, rollers) < 0.01, "rollers clear the teeth");
  // turning sprocket 1 by a fraction of a tooth moves the seated rollers round its pitch circle
  const wheels = cd.wheels, R1 = wheels[0].r;
  for (let i = 0; i < cd.links; i++) {
    const r = cd.rollers[i];
    if (Math.abs(Math.hypot(r[0], r[1]) - R1) < 1e-6 && Math.abs(Math.hypot(cd.rollers[(i + 1) % cd.links][0], cd.rollers[(i + 1) % cd.links][1]) - R1) < 1e-6) {
      const q = CH.chainPoint(cd.rollers, i + 0.37, wheels);
      near(Math.hypot(q[0], q[1]), R1, 1e-9, "on the pitch circle mid-step");
    }
  }
});
t("belt drives: whole teeth on the pitch line, teeth in the grooves", () => {
  const pa = { kind: "pulley", teeth: 20, belt: "GT2", center: [0, 0], phase: 3, width: 7 };
  const bd = CH.beltDrive(pa, 40, 120, -30);
  near(CH.beltPath(bd.layout).total, bd.beltTeeth * 2, 1e-6, "pitch length");
  const st = K.evaluate([{ id: "g", type: "gear", frame, gears: [pa, { kind: "pulley", teeth: 40, belt: "GT2", center: bd.center, phase: bd.phase, width: 7 },
    { kind: "belt", belt: "GT2", width: 6, center: [0, 0], phase: 0, zMid: 3.5, layout: bd.layout }] }]);
  assert.ok(overlap(st.bodies[0].shape, st.bodies[2].shape) < 0.05 && overlap(st.bodies[1].shape, st.bodies[2].shape) < 0.05, "belt clears both pulleys");
});
t("wizard plans: chain / belt drives, and a twin wheel when chaining onto a wheel that already has a chain", () => {
  const ch = planGears({ mode: "chain", teeth1: 15, teeth2: 30, chain: "35", centerDist: 250 });
  assert.deepEqual(ch.gears.map((g) => g.kind), ["sprocket", "sprocket", "chain"]);
  near(ch.links[0].ratio, 0.5, 1e-12, "same direction, 15:30");
  const bt = planGears({ mode: "belt", teeth1: 20, teeth2: 60, centerDist: 150 });
  assert.deepEqual(bt.gears.map((g) => g.kind), ["pulley", "pulley", "belt"]);
  const partner = { kind: "sprocket", teeth: 30, chain: "40", center: [100, 0], phase: 0, z0: 0, hasLoop: true };
  const tw = planGears({ mode: "mesh", teeth1: 12, centerDist: 180, dir: 60 }, partner);
  assert.deepEqual(tw.gears.map((g) => g.kind), ["sprocket", "chain", "sprocket"]);
  assert.ok(tw.gears[2].attachToPartner && tw.gears[2].z0 > 13, "twin beside the first chain");
  near(tw.links[0].ratio, 2.5, 1e-12, "30:12");
});
console.log(`\n${n} chain / belt tests passed`);
