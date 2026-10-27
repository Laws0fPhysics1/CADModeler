// Gear Wizard planning (DOM-free): turns the wizard's settings into the `gear` feature's gear list and
// the assembly plan (motion links, fixed gears, planetary carrier). gearui.js is the dialog; tests use this.
import * as G from "./gears.js";
import * as CH from "./chains.js";

const fmt = (v, d = 3) => String(+(+v).toFixed(d));

export const MODES = [
  ["pair", "Gear pair"], ["train", "Gear train"], ["single", "Single gear"], ["internal", "Ring + pinion (internal)"],
  ["rack", "Rack + pinion"], ["planetary", "Planetary set"], ["chain", "Chain drive (sprockets + chain)"], ["belt", "Belt drive (pulleys + timing belt)"],
  ["mesh", "Mesh / chain / belt to an existing one"],
];
export const DEFAULT_SPEC = {
  mode: "pair", module: 2, pressureAngle: 20, width: 10, helixAngle: 0, backlash: 0, bore: 6, hubDia: 0, hubLength: 0,
  kind: "spur", teeth1: 20, teeth2: 40, train: "20, 40, 16", sun: 18, planet: 18, planets: 3, rackTeeth: 16,
  plane: "XY", u: 0, v: 0, z0: 0, dir: 0, rpm: 100, functional: true, mount: "new",
  chain: "40", belt: "GT2", beltWidth: 6, flanges: true, centerDist: 200,
};

/**
 * Turn the wizard spec (+ the partner gear's body metadata in mesh mode) into the feature's gear list and
 * the assembly plan. Pure: tests call it directly.
 * Returns { gears: [...], links: [{driver, driven, ratio, teeth?, type?}], fixed: [indices], carrier?, notes: [], warnings: [] }.
 */
export function planGears(spec, partner = null) {
  const s = { ...DEFAULT_SPEC, ...spec };
  const common = { module: +s.module, pressureAngle: +s.pressureAngle, width: +s.width, backlash: +s.backlash, bore: +s.bore, hubDia: +s.hubDia, hubLength: +s.hubLength };
  const helix = +s.helixAngle || 0;
  const out = { gears: [], links: [], fixed: [], notes: [], warnings: [] };
  const c0 = [+s.u || 0, +s.v || 0], z0 = +s.z0 || 0, dir = +s.dir || 0;
  const spur = (teeth, extra = {}) => ({ ...common, kind: "spur", teeth: Math.round(teeth), helixAngle: helix, hand: "right", z0, ...extra });
  const place = (g, m) => Object.assign(g, { center: m.center, phase: m.phase, ...(m.rackAngle != null ? { rackAngle: m.rackAngle } : {}) });
  const flip = (hand) => (hand === "left" ? "right" : "left");
  const ratioNote = (a, b, r) => out.notes.push(`${a} → ${b}: ${fmt(Math.abs(r), 4)} : 1${r < 0 ? ", turns the other way" : ""}`);
  const minT = G.gearSizes({ ...common, teeth: 20 }).minTeethNoUndercut;
  const hubs = { bore: +s.bore, hubDia: +s.hubDia, hubLength: +s.hubLength };
  const sprocket = (teeth, extra = {}) => ({ ...hubs, kind: "sprocket", teeth: Math.round(teeth), chain: s.chain, z0, ...extra });
  const pulley = (teeth, extra = {}) => ({ ...hubs, kind: "pulley", teeth: Math.round(teeth), belt: s.belt, width: +s.beltWidth + 1, flanges: !!s.flanges, z0, ...extra });
  /**
   * Second wheel + the chain / belt round both. `a` is wheel 1 (placed); wheelIndex is the index in out.gears of the wheel
   * the loop's motion is measured from (it moves one pitch per tooth that wheel turns).
   */
  const loopDrive = (a, nB, wheelIndex, freePhase) => {
    if (a.kind === "sprocket") {
      const cd = CH.chainDrive(a, nB, +s.centerDist, dir, { freePhase });
      if (freePhase) a.phase = cd.phaseA;
      const w = G.gearParams(a).width;
      const b = { ...hubs, kind: "sprocket", teeth: Math.round(nB), chain: a.chain, z0: a.z0 || 0, center: cd.center, phase: cd.phase };
      const loop = { kind: "chain", chain: a.chain, center: [0, 0], phase: 0, z0: 0, zMid: (a.z0 || 0) + w / 2, layout: { rollers: cd.rollers, wheels: cd.wheels }, wheel: { index: wheelIndex, teeth: wheelIndex === -1 ? a.teeth : null } };
      out.notes.push(`${CH.chainOf(a.chain).label} chain: ${cd.links} links${cd.even ? "" : " (odd: needs an offset link)"}, ${fmt(cd.length, 1)} mm · centre distance ${fmt(cd.C, 3)} mm`);
      return { b, loop, ratio: cd.ratio };
    }
    if (a.kind === "pulley") {
      const bd = CH.beltDrive(a, nB, +s.centerDist, dir);
      const P = G.gearParams(a), wTot = CH.pulleyWidth(P);
      const b = { ...hubs, kind: "pulley", teeth: Math.round(nB), belt: a.belt, width: P.width, flanges: P.flanges, z0: a.z0 || 0, center: bd.center, phase: bd.phase };
      const loop = { kind: "belt", belt: a.belt, width: Math.max(1, P.width - 1), center: [0, 0], phase: 0, z0: 0, zMid: (a.z0 || 0) + wTot / 2, layout: bd.layout, wheel: { index: wheelIndex } };
      out.notes.push(`${CH.beltOf(a.belt).label} belt: ${bd.beltTeeth} teeth = ${fmt(bd.length, 1)} mm closed loop · centre distance ${fmt(bd.C, 3)} mm`);
      return { b, loop, ratio: bd.ratio };
    }
    throw new Error("Chains go on sprockets and belts on pulleys");
  };
  switch (s.mode) {
    case "chain": case "belt": {
      const a = (s.mode === "chain" ? sprocket : pulley)(s.teeth1, { center: c0, phase: 0 });
      const d = loopDrive(a, s.teeth2, 0, true);
      d.loop.wheel.teeth = a.teeth;
      out.gears.push(a, d.b, d.loop);
      out.links.push({ driver: 0, driven: 1, ratio: d.ratio, teeth: [a.teeth, d.b.teeth], type: "gear" });
      out.loops = [2];
      ratioNote(`${a.teeth}T`, `${d.b.teeth}T`, d.ratio);
      out.notes.push(`Output ${fmt(d.ratio * s.rpm, 2)} rpm at ${fmt(s.rpm, 2)} rpm in · both turn the same way`);
      break;
    }
    case "single": {
      if (s.kind === "sprocket" || s.kind === "pulley") { out.gears.push((s.kind === "sprocket" ? sprocket : pulley)(s.teeth1, { center: c0, phase: dir })); break; }
      const g = s.kind === "rack" ? { ...common, kind: "rack", teeth: Math.round(s.teeth1), center: c0, rackAngle: dir, z0 } : { ...common, kind: s.kind, teeth: Math.round(s.teeth1), helixAngle: helix, hand: "right", center: c0, phase: dir, z0, ...(s.kind === "ring" ? { bore: 0, hubDia: 0 } : {}) };
      out.gears.push(g);
      break;
    }
    case "pair": case "train": {
      const list = s.mode === "pair" ? [s.teeth1, s.teeth2] : String(s.train).split(/[,\s;]+/).map(Number).filter((x) => x >= 6);
      if (list.length < 2) throw new Error("A gear train needs at least two tooth counts, e.g. 20, 40, 16");
      let prev = place(spur(list[0]), { center: c0, phase: 0 });
      out.gears.push(prev);
      for (let i = 1; i < list.length; i++) {
        const g = spur(list[i], { hand: i % 2 ? "left" : "right" });
        const m = G.meshWith(prev, g, dir);
        place(g, m);
        out.gears.push(g);
        out.links.push({ driver: i - 1, driven: i, ratio: m.ratio, teeth: [prev.teeth, g.teeth] });
        prev = g;
      }
      const total = out.links.reduce((r, l) => r * l.ratio, 1);
      ratioNote(`${list[0]}T`, `${list[list.length - 1]}T`, total);
      out.notes.push(`Output ${fmt(Math.abs(total) * s.rpm, 2)} rpm at ${fmt(s.rpm, 2)} rpm in`);
      break;
    }
    case "internal": {
      const ring = { ...common, kind: "ring", teeth: Math.round(s.teeth2), helixAngle: helix, hand: "left", center: c0, phase: 0, z0, bore: 0, hubDia: 0 };
      const pin = spur(s.teeth1, { hand: "left" });
      const m = G.meshWith(ring, pin, dir);
      place(pin, m);
      out.gears.push(pin, ring); // the pinion drives
      out.links.push({ driver: 0, driven: 1, ratio: 1 / m.ratio, teeth: [pin.teeth, ring.teeth] });
      ratioNote(`${pin.teeth}T pinion`, `${ring.teeth}T ring`, 1 / m.ratio);
      break;
    }
    case "rack": {
      const pin = place(spur(s.teeth1, { helixAngle: 0 }), { center: c0, phase: 0 });
      const rack = { ...common, kind: "rack", teeth: Math.round(s.rackTeeth), z0, hubDia: 0, bore: 0 };
      const m = G.meshWith(pin, rack, dir - 90);
      place(rack, m);
      out.gears.push(pin, rack);
      out.links.push({ driver: 0, driven: 1, ratio: m.ratio, type: "rack" });
      out.notes.push(`${fmt(m.ratio * 360, 3)} mm of rack travel per pinion turn`);
      if (helix) out.warnings.push("Racks are straight-cut: helix angle ignored");
      break;
    }
    case "planetary": {
      const zs = Math.round(s.sun), zp = Math.round(s.planet), n = Math.max(1, Math.round(s.planets)), zr = zs + 2 * zp;
      if ((zs + zr) % n) out.warnings.push(`${n} planets won't fit evenly: (sun + ring) = ${zs + zr} must divide by ${n}`);
      const sun = place(spur(zs), { center: c0, phase: 0 });
      out.gears.push(sun);
      const planets = [];
      for (let i = 0; i < n; i++) {
        const p = spur(zp, { hand: "left", bore: Math.min(+s.bore, G.gearSizes({ ...common, teeth: zp }).rootRadius), hubDia: 0 });
        place(p, G.meshWith(sun, p, dir + (360 * i) / n));
        planets.push(out.gears.length); out.gears.push(p);
      }
      const ring = { ...common, kind: "ring", teeth: zr, helixAngle: helix, hand: "left", z0, bore: 0, hubDia: 0 };
      place(ring, G.meshWith(out.gears[planets[0]], ring, dir));
      out.gears.push(ring);
      out.fixed.push(out.gears.length - 1); // ring held still; the carrier is the output
      const cr = zs / (zs + zr);
      out.carrier = { center: c0, planets };
      out.links.push({ driver: 0, driven: "carrier", ratio: cr, type: "ratio", name: "Sun → carrier" });
      for (const i of planets) out.links.push({ driver: 0, driven: i, ratio: (-zs * zr) / (zp * (zs + zr)), type: "ratio" });
      out.notes.push(`Ring ${zr}T fixed: sun → carrier ${fmt(1 / cr, 4)} : 1 reduction`);
      out.notes.push(`Output ${fmt(s.rpm * cr, 2)} rpm at ${fmt(s.rpm, 2)} rpm in`);
      break;
    }
    case "mesh": {
      if (!partner) throw new Error("Pick a face of the gear to mesh with");
      const a = { ...partner, center: partner.center, phase: partner.phase };
      if (a.kind === "rack") throw new Error("Pick a spur or ring gear (a new rack meshes with a spur gear)");
      if (a.kind === "sprocket" || a.kind === "pulley") {
        // a new wheel chained / belted to the picked one; the loop moves with the new wheel (index 0).
        // If the picked wheel already carries a chain / belt, a twin wheel goes on its shaft, beside it
        // (a double sprocket / pulley), and the new loop runs on that.
        let from = { ...a };
        const twin = !!partner.hasLoop;
        if (twin) {
          // clear the existing loop: a chain is wider than its sprocket (side plates and pins)
          const c = CH.chainOf(a.chain), w = a.kind === "pulley" ? CH.pulleyWidth(G.gearParams(a)) : Math.max(G.gearParams(a).width, c.w + 4.4 * c.pt);
          from = { ...a, z0: (a.z0 || 0) + w + 2, bore: a.bore, hubDia: 0, hubLength: 0 };
        }
        const d = loopDrive(from, s.kind === "ring" ? s.teeth2 : s.teeth1, 0, false);
        d.loop.wheel.teeth = d.b.teeth;
        out.gears.push(d.b, d.loop);
        out.links.push({ driver: "partner", driven: 0, ratio: d.ratio, teeth: [a.teeth, d.b.teeth], type: "gear" });
        out.loops = [1];
        if (twin) {
          out.gears.push({ ...from, center: a.center, phase: a.phase, attachToPartner: true });
          out.notes.push(`A second ${a.teeth}T ${a.kind} is added on the picked one's shaft, ${fmt(from.z0 - (a.z0 || 0), 2)} mm along, for the new ${a.kind === "sprocket" ? "chain" : "belt"}`);
        }
        ratioNote(`${a.teeth}T`, `${d.b.teeth}T`, d.ratio);
        break;
      }
      // the new gear takes the partner's tooth size, width, plane and offset; helical hands flip on external meshes
      const k = s.kind;
      const base = { module: a.module, pressureAngle: a.pressureAngle, width: +s.width || a.width, backlash: +s.backlash, bore: +s.bore, hubDia: +s.hubDia, hubLength: +s.hubLength, z0: a.z0 || 0 };
      let g;
      if (k === "rack") g = { ...base, kind: "rack", teeth: Math.round(s.rackTeeth), bore: 0, hubDia: 0 };
      else if (k === "ring") g = { ...base, kind: "ring", teeth: Math.round(s.teeth2), helixAngle: a.helixAngle, hand: a.hand, bore: 0, hubDia: 0 };
      else g = { ...base, kind: "spur", teeth: Math.round(s.teeth1), helixAngle: a.helixAngle || 0, hand: a.kind === "ring" ? a.hand : flip(a.hand) };
      const m = G.meshWith(a, g, k === "rack" ? dir - 90 : dir);
      place(g, m);
      out.gears.push(g);
      out.links.push({ driver: "partner", driven: 0, ratio: m.ratio, teeth: k === "rack" ? undefined : [a.teeth, g.teeth], type: k === "rack" ? "rack" : "gear" });
      if (k !== "rack") ratioNote(`${a.teeth}T`, `${g.teeth}T`, m.ratio);
      break;
    }
    default: throw new Error(`Unknown wizard mode ${s.mode}`);
  }
  for (const g of out.gears) if (g.kind === "spur" && g.teeth < minT) { out.warnings.push(`${g.teeth}T is below ${minT} teeth: real gears would be undercut (shown without it)`); break; }
  return out;
}
