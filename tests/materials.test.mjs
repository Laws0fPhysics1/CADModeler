// Material library tests: node tests/materials.test.mjs
import assert from "node:assert/strict";
import {
  MATERIALS, CATEGORIES, getMaterial, DEFAULT_MATERIAL_ID, resolveAppearance, COLOR_PRESETS, describe,
  normalizeAppearance, appearanceKey, finishRoughness, physicalRows, normalizeHex,
} from "../src/materials.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("required materials exist", () => {
  const names = MATERIALS.map((m) => m.name.toLowerCase());
  for (const want of ["aluminum 6061-t6", "aluminum (anodized)", "steel (mild)", "stainless steel 304", "titanium ti-6al-4v", "brass", "copper", "cast iron",
    "abs", "pla", "petg", "nylon 6/6", "polycarbonate", "acrylic (pmma)", "hdpe", "rubber", "silicone", "glass", "carbon fiber composite", "oak wood"]) {
    assert.ok(names.includes(want), `missing ${want}`);
  }
  assert.ok(getMaterial(DEFAULT_MATERIAL_ID));
  assert.equal(new Set(MATERIALS.map((m) => m.id)).size, MATERIALS.length, "ids unique");
});

t("material records are well-formed", () => {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  for (const m of MATERIALS) {
    assert.ok(CATEGORIES.includes(m.category), `${m.id} category`);
    const r = m.render;
    assert.ok(normalizeHex(r.color) === r.color.toLowerCase(), `${m.id} color`);
    assert.ok(r.metalness >= 0 && r.metalness <= 1 && r.roughness >= 0 && r.roughness <= 1, `${m.id} pbr range`);
    for (const k of ["clearcoat", "clearcoatRoughness", "transmission", "sheen"]) if (r[k] !== undefined) assert.ok(r[k] >= 0 && r[k] <= 1, `${m.id} ${k}`);
    const p = m.physical;
    for (const k of ["density_kg_m3", "youngs_modulus_Pa", "poissons_ratio", "ultimate_strength_Pa", "thermal_conductivity_W_mK", "specific_heat_J_kgK", "thermal_expansion_1_K"]) {
      assert.ok(num(p[k]) && p[k] > 0, `${m.id} ${k}`);
    }
    assert.ok(p.yield_strength_Pa === null || (num(p.yield_strength_Pa) && p.yield_strength_Pa <= p.ultimate_strength_Pa * 1.001), `${m.id} yield`);
    assert.ok(p.poissons_ratio < 0.5, `${m.id} poisson`);
    assert.ok(num(p.melting_point_K) || num(p.glass_transition_K) || num(p.decomposition_K), `${m.id} temperature`);
    assert.ok(typeof p.source === "string" && /typical/i.test(p.source), `${m.id} source`);
  }
});

t("handbook sanity", () => {
  const al = getMaterial("aluminum-6061").physical, st = getMaterial("steel-mild").physical;
  assert.equal(al.density_kg_m3, 2700);
  assert.ok(Math.abs(al.youngs_modulus_Pa - 69e9) < 2e9);
  assert.ok(st.density_kg_m3 > 7800 && st.density_kg_m3 < 7900);
  assert.ok(getMaterial("copper").physical.thermal_conductivity_W_mK > 350);
  assert.ok(getMaterial("titanium-6al4v").physical.yield_strength_Pa > 800e6);
});

t("color presets", () => {
  assert.ok(COLOR_PRESETS.length >= 16);
  for (const c of COLOR_PRESETS) assert.equal(normalizeHex(c.hex), c.hex);
  for (const want of ["red", "orange", "yellow", "green", "blue", "black", "white", "grey", "gold", "bronze"]) assert.ok(COLOR_PRESETS.some((c) => c.id === want), want);
});

t("resolveAppearance: defaults and colour override", () => {
  const d = resolveAppearance(null);
  assert.equal(d.material.id, DEFAULT_MATERIAL_ID);
  assert.equal(d.color, getMaterial(DEFAULT_MATERIAL_ID).render.color);
  const red = resolveAppearance({ materialId: "aluminum-6061", color: "#C0392B" });
  assert.equal(red.material.id, "aluminum-6061");
  assert.equal(red.color, "#c0392b");
  assert.equal(red.renderParams.color, "#c0392b");
  assert.equal(red.renderParams.metalness, getMaterial("aluminum-6061").render.metalness, "keeps metalness");
  assert.equal(red.renderParams.roughness, getMaterial("aluminum-6061").render.roughness, "keeps roughness");
  assert.equal(resolveAppearance({ materialId: "nope" }).material.id, DEFAULT_MATERIAL_ID);
  // the library is not mutated
  assert.notEqual(getMaterial("aluminum-6061").render.color, "#c0392b");
});

t("finish adjusts roughness", () => {
  const base = getMaterial("abs").render.roughness;
  const pol = resolveAppearance({ materialId: "abs", finish: "polished" }).renderParams.roughness;
  const mat = resolveAppearance({ materialId: "abs", finish: "matte" }).renderParams.roughness;
  assert.ok(pol < base && base < mat, `${pol} < ${base} < ${mat}`);
  assert.ok(finishRoughness(0.9, "satin") <= 0.45 && finishRoughness(0.05, "satin") >= 0.3);
  assert.equal(normalizeAppearance({ materialId: "abs", finish: "shiny" }).finish, undefined);
});

t("describe", () => {
  assert.equal(describe({ materialId: "aluminum-6061", color: "#c0392b" }), "Red Aluminum 6061-T6");
  assert.equal(describe({ materialId: "abs", color: "#e67e22" }), "Orange ABS");
  assert.equal(describe({ materialId: "aluminum-6061" }), "Aluminum 6061-T6");
  assert.equal(describe({ materialId: "abs", color: "#123456", finish: "matte" }), "#123456 ABS (Matte)");
  assert.equal(describe(null), getMaterial(DEFAULT_MATERIAL_ID).name);
});

t("appearanceKey is stable and distinct", () => {
  assert.equal(appearanceKey(null), appearanceKey({ materialId: DEFAULT_MATERIAL_ID }));
  assert.equal(appearanceKey({ materialId: "abs", color: "#E67E22" }), appearanceKey({ materialId: "abs", color: "#e67e22" }));
  assert.notEqual(appearanceKey({ materialId: "abs" }), appearanceKey({ materialId: "abs", finish: "matte" }));
  assert.notEqual(appearanceKey({ materialId: "abs" }), appearanceKey({ materialId: "pla" }));
});

t("physicalRows friendly units", () => {
  const rows = Object.fromEntries(physicalRows("aluminum-6061").map((r) => [r.label, r.value]));
  assert.equal(rows["Density"], "2.70 g/cm³");
  assert.equal(rows["Young's modulus"], "68.9 GPa");
  assert.equal(rows["Yield strength"], "276 MPa");
  assert.equal(rows["Thermal conductivity"], "167 W/m·K");
  assert.equal(Object.fromEntries(physicalRows("glass").map((r) => [r.label, r.value]))["Yield strength"], "n/a");
});

console.log(`\n${n} materials tests passed`);
