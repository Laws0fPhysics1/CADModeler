// Material library + appearance model. Pure data/logic (no DOM, no three.js) so it runs in Node.
//
// A body's appearance is { materialId, color?: "#rrggbb", finish?: "polished" | "satin" | "matte" }.
//   - materialId picks a physical material (render look + engineering properties).
//   - color overrides the material's base colour but keeps its metalness/roughness, so
//     { materialId: "aluminum-6061", color: "#c0392b" } reads as red anodised aluminium.
//   - finish adjusts roughness (and clearcoat for polished plastics).
//
// `physical` holds typical handbook values in SI units for future FEA / CFD / CAM work.
// They are representative room-temperature values, NOT certified design data: real values
// depend on grade, temper, process, orientation and temperature.

const TYPICAL = "Typical handbook values at room temperature (MatWeb / ASM / supplier datasheets); not certified design data.";

const m = (id, name, category, render, physical) => ({ id, name, category, render, physical: { source: TYPICAL, ...physical } });

export const CATEGORIES = ["Metal", "Plastic", "Rubber", "Glass", "Wood", "Composite", "Other"];

export const MATERIALS = [
  // ---------------- Other ----------------
  m("generic", "Generic (Steel - Satin)", "Other",
    { color: "#c9ced4", metalness: 0.3, roughness: 0.42 },
    { density_kg_m3: 7850, youngs_modulus_Pa: 200e9, poissons_ratio: 0.29, yield_strength_Pa: 250e6, ultimate_strength_Pa: 400e6,
      thermal_conductivity_W_mK: 50, specific_heat_J_kgK: 490, thermal_expansion_1_K: 12e-6, melting_point_K: 1773, surface_roughness_m: 4.5e-5,
      note: "Fusion-style default: generic structural steel properties with a neutral satin grey look." }),

  // ---------------- Metals ----------------
  m("aluminum-6061", "Aluminum 6061-T6", "Metal",
    { color: "#c9cdd2", metalness: 0.85, roughness: 0.38 }, // a little diffuse: pure metal went dark side-on (bug report 2026-10-18 19:27)
    { density_kg_m3: 2700, youngs_modulus_Pa: 68.9e9, poissons_ratio: 0.33, yield_strength_Pa: 276e6, ultimate_strength_Pa: 310e6,
      thermal_conductivity_W_mK: 167, specific_heat_J_kgK: 896, thermal_expansion_1_K: 23.6e-6, melting_point_K: 855, surface_roughness_m: 1.6e-6,
      note: "Melting point is the solidus (582 C). Roughness ~ machined finish (Ra 1.6 um)." }),
  m("aluminum-anodized", "Aluminum (anodized)", "Metal",
    { color: "#34373c", metalness: 0.9, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.35 },
    { density_kg_m3: 2700, youngs_modulus_Pa: 68.9e9, poissons_ratio: 0.33, yield_strength_Pa: 276e6, ultimate_strength_Pa: 310e6,
      thermal_conductivity_W_mK: 167, specific_heat_J_kgK: 896, thermal_expansion_1_K: 23.6e-6, melting_point_K: 855, surface_roughness_m: 1.6e-6,
      note: "6061-T6 substrate with a type II anodised layer (black by default)." }),
  m("steel-mild", "Steel (mild)", "Metal",
    { color: "#8e9399", metalness: 1, roughness: 0.42 },
    { density_kg_m3: 7870, youngs_modulus_Pa: 205e9, poissons_ratio: 0.29, yield_strength_Pa: 370e6, ultimate_strength_Pa: 440e6,
      thermal_conductivity_W_mK: 51.9, specific_heat_J_kgK: 486, thermal_expansion_1_K: 11.5e-6, melting_point_K: 1773, surface_roughness_m: 4.5e-5,
      note: "AISI 1018 cold drawn. Roughness = commercial steel equivalent sand-grain roughness (0.045 mm)." }),
  m("stainless-304", "Stainless steel 304", "Metal",
    { color: "#c3c6c8", metalness: 1, roughness: 0.24 },
    { density_kg_m3: 8000, youngs_modulus_Pa: 193e9, poissons_ratio: 0.29, yield_strength_Pa: 215e6, ultimate_strength_Pa: 505e6,
      thermal_conductivity_W_mK: 16.2, specific_heat_J_kgK: 500, thermal_expansion_1_K: 17.3e-6, melting_point_K: 1673, surface_roughness_m: 1.5e-6,
      note: "Annealed. Melting range 1400-1450 C." }),
  m("titanium-6al4v", "Titanium Ti-6Al-4V", "Metal",
    { color: "#b6aea4", metalness: 1, roughness: 0.34 },
    { density_kg_m3: 4430, youngs_modulus_Pa: 113.8e9, poissons_ratio: 0.342, yield_strength_Pa: 880e6, ultimate_strength_Pa: 950e6,
      thermal_conductivity_W_mK: 6.7, specific_heat_J_kgK: 526, thermal_expansion_1_K: 8.6e-6, melting_point_K: 1877, surface_roughness_m: 1.6e-6,
      note: "Grade 5, annealed." }),
  m("brass", "Brass", "Metal",
    { color: "#d8b45f", metalness: 1, roughness: 0.24 },
    { density_kg_m3: 8500, youngs_modulus_Pa: 97e9, poissons_ratio: 0.31, yield_strength_Pa: 310e6, ultimate_strength_Pa: 385e6,
      thermal_conductivity_W_mK: 115, specific_heat_J_kgK: 380, thermal_expansion_1_K: 20.5e-6, melting_point_K: 1158, surface_roughness_m: 1.5e-6,
      note: "C360 free-machining brass, half hard. Melting point is the solidus (885 C)." }),
  m("copper", "Copper", "Metal",
    { color: "#d88a62", metalness: 1, roughness: 0.25 },
    { density_kg_m3: 8940, youngs_modulus_Pa: 117e9, poissons_ratio: 0.33, yield_strength_Pa: 69e6, ultimate_strength_Pa: 220e6,
      thermal_conductivity_W_mK: 391, specific_heat_J_kgK: 385, thermal_expansion_1_K: 17e-6, melting_point_K: 1358, surface_roughness_m: 1.5e-6,
      note: "C110 (ETP) annealed." }),
  m("cast-iron", "Cast iron", "Metal",
    { color: "#5c5f62", metalness: 0.85, roughness: 0.72 },
    { density_kg_m3: 7200, youngs_modulus_Pa: 100e9, poissons_ratio: 0.26, yield_strength_Pa: 140e6, ultimate_strength_Pa: 214e6,
      thermal_conductivity_W_mK: 46, specific_heat_J_kgK: 490, thermal_expansion_1_K: 11e-6, melting_point_K: 1473, surface_roughness_m: 2.6e-4,
      note: "Grey iron class 30. Brittle, no distinct yield: yield is an approximate 0.1% proof stress. Roughness = cast surface (0.26 mm)." }),

  // ---------------- Plastics ----------------
  m("abs", "ABS", "Plastic",
    { color: "#2c2d30", metalness: 0, roughness: 0.5, clearcoat: 0.1, clearcoatRoughness: 0.4 },
    { density_kg_m3: 1050, youngs_modulus_Pa: 2.3e9, poissons_ratio: 0.35, yield_strength_Pa: 43e6, ultimate_strength_Pa: 44e6,
      thermal_conductivity_W_mK: 0.17, specific_heat_J_kgK: 1400, thermal_expansion_1_K: 90e-6, glass_transition_K: 378, surface_roughness_m: 1e-6,
      note: "Injection-moulded general purpose ABS." }),
  m("pla", "PLA", "Plastic",
    { color: "#efeee9", metalness: 0, roughness: 0.45, clearcoat: 0.15, clearcoatRoughness: 0.35 },
    { density_kg_m3: 1240, youngs_modulus_Pa: 3.5e9, poissons_ratio: 0.36, yield_strength_Pa: 60e6, ultimate_strength_Pa: 65e6,
      thermal_conductivity_W_mK: 0.13, specific_heat_J_kgK: 1800, thermal_expansion_1_K: 68e-6, glass_transition_K: 333, melting_point_K: 443, surface_roughness_m: 1e-5,
      note: "Bulk (moulded) values; 3D-printed parts are weaker and anisotropic." }),
  m("petg", "PETG", "Plastic",
    { color: "#3b7cc4", metalness: 0, roughness: 0.22, clearcoat: 0.4, clearcoatRoughness: 0.15 },
    { density_kg_m3: 1270, youngs_modulus_Pa: 2.1e9, poissons_ratio: 0.38, yield_strength_Pa: 50e6, ultimate_strength_Pa: 53e6,
      thermal_conductivity_W_mK: 0.2, specific_heat_J_kgK: 1200, thermal_expansion_1_K: 60e-6, glass_transition_K: 353, surface_roughness_m: 1e-6,
      note: "Amorphous copolyester." }),
  m("nylon-66", "Nylon 6/6", "Plastic",
    { color: "#e8e3d4", metalness: 0, roughness: 0.62, sheen: 0.2 },
    { density_kg_m3: 1140, youngs_modulus_Pa: 2.8e9, poissons_ratio: 0.39, yield_strength_Pa: 70e6, ultimate_strength_Pa: 82e6,
      thermal_conductivity_W_mK: 0.25, specific_heat_J_kgK: 1670, thermal_expansion_1_K: 80e-6, glass_transition_K: 323, melting_point_K: 537, surface_roughness_m: 1e-6,
      note: "Dry as moulded; properties drop noticeably when moisture-conditioned." }),
  m("polycarbonate", "Polycarbonate", "Plastic",
    { color: "#f2f5f8", metalness: 0, roughness: 0.06, transmission: 0.9, ior: 1.586, thickness: 3, clearcoat: 0.3, clearcoatRoughness: 0.05 },
    { density_kg_m3: 1200, youngs_modulus_Pa: 2.35e9, poissons_ratio: 0.37, yield_strength_Pa: 62e6, ultimate_strength_Pa: 68e6,
      thermal_conductivity_W_mK: 0.2, specific_heat_J_kgK: 1250, thermal_expansion_1_K: 68e-6, glass_transition_K: 420, surface_roughness_m: 1e-6,
      note: "Clear general purpose grade." }),
  m("acrylic", "Acrylic (PMMA)", "Plastic",
    { color: "#f4f8fa", metalness: 0, roughness: 0.03, transmission: 0.95, ior: 1.49, thickness: 3 },
    { density_kg_m3: 1180, youngs_modulus_Pa: 3.1e9, poissons_ratio: 0.37, yield_strength_Pa: 70e6, ultimate_strength_Pa: 72e6,
      thermal_conductivity_W_mK: 0.19, specific_heat_J_kgK: 1470, thermal_expansion_1_K: 75e-6, glass_transition_K: 378, surface_roughness_m: 1e-6,
      note: "Cast sheet. Fairly brittle; yield taken close to tensile strength." }),
  m("hdpe", "HDPE", "Plastic",
    { color: "#f1f0eb", metalness: 0, roughness: 0.6, sheen: 0.15 },
    { density_kg_m3: 955, youngs_modulus_Pa: 1.0e9, poissons_ratio: 0.42, yield_strength_Pa: 26e6, ultimate_strength_Pa: 32e6,
      thermal_conductivity_W_mK: 0.48, specific_heat_J_kgK: 1900, thermal_expansion_1_K: 120e-6, glass_transition_K: 163, melting_point_K: 403, surface_roughness_m: 1.5e-6,
      note: "Semi-crystalline; properties vary widely with grade." }),

  // ---------------- Rubber ----------------
  m("rubber", "Rubber", "Rubber",
    { color: "#1f1f21", metalness: 0, roughness: 0.88, sheen: 0.35 },
    { density_kg_m3: 1150, youngs_modulus_Pa: 5e6, poissons_ratio: 0.49, yield_strength_Pa: null, ultimate_strength_Pa: 15e6,
      thermal_conductivity_W_mK: 0.16, specific_heat_J_kgK: 1900, thermal_expansion_1_K: 200e-6, glass_transition_K: 213, surface_roughness_m: 1e-5,
      note: "Generic vulcanised rubber (~60 Shore A). Hyperelastic: no yield point; modulus is the small-strain value." }),
  m("silicone", "Silicone", "Rubber",
    { color: "#e1e4e6", metalness: 0, roughness: 0.5, transmission: 0.25, ior: 1.41, thickness: 4, sheen: 0.2 },
    { density_kg_m3: 1150, youngs_modulus_Pa: 2e6, poissons_ratio: 0.49, yield_strength_Pa: null, ultimate_strength_Pa: 7e6,
      thermal_conductivity_W_mK: 0.25, specific_heat_J_kgK: 1460, thermal_expansion_1_K: 300e-6, glass_transition_K: 148, surface_roughness_m: 1e-6,
      note: "Silicone elastomer ~50 Shore A. Hyperelastic: no yield point." }),

  // ---------------- Glass ----------------
  m("glass", "Glass", "Glass",
    { color: "#ffffff", metalness: 0, roughness: 0.02, transmission: 1, ior: 1.52, thickness: 3 },
    { density_kg_m3: 2500, youngs_modulus_Pa: 70e9, poissons_ratio: 0.22, yield_strength_Pa: null, ultimate_strength_Pa: 45e6,
      thermal_conductivity_W_mK: 1.0, specific_heat_J_kgK: 840, thermal_expansion_1_K: 9e-6, glass_transition_K: 837, surface_roughness_m: 1e-7,
      note: "Soda-lime float glass. Brittle: no yield; tensile strength is a practical design-level value." }),

  // ---------------- Composite ----------------
  m("carbon-fiber", "Carbon fiber composite", "Composite",
    { color: "#1c1d20", metalness: 0.15, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 },
    { density_kg_m3: 1550, youngs_modulus_Pa: 70e9, poissons_ratio: 0.3, yield_strength_Pa: null, ultimate_strength_Pa: 600e6,
      thermal_conductivity_W_mK: 5, specific_heat_J_kgK: 1000, thermal_expansion_1_K: 2e-6, glass_transition_K: 393, surface_roughness_m: 1e-6,
      note: "Quasi-isotropic CFRP laminate (in-plane values; strongly anisotropic). Brittle: no yield. Tg is the epoxy matrix." }),

  // ---------------- Wood ----------------
  m("oak", "Oak wood", "Wood",
    { color: "#b48a58", metalness: 0, roughness: 0.66, clearcoat: 0.2, clearcoatRoughness: 0.5 },
    { density_kg_m3: 750, youngs_modulus_Pa: 11e9, poissons_ratio: 0.35, yield_strength_Pa: null, ultimate_strength_Pa: 90e6,
      thermal_conductivity_W_mK: 0.17, specific_heat_J_kgK: 2000, thermal_expansion_1_K: 5e-6, decomposition_K: 573, surface_roughness_m: 5e-4,
      note: "Red/white oak, 12% moisture, along the grain (orthotropic: much weaker across the grain). No melting point; it chars/decomposes around 300 C." }),
];

const BY_ID = new Map(MATERIALS.map((x) => [x.id, x]));

export const DEFAULT_MATERIAL_ID = "generic";

/** Material by id; unknown ids fall back to the default material. */
export function getMaterial(id) { return BY_ID.get(id) || BY_ID.get(DEFAULT_MATERIAL_ID); }
export function hasMaterial(id) { return BY_ID.has(id); }

export const FINISHES = ["polished", "satin", "matte"];

export const COLOR_PRESETS = [
  { id: "red", name: "Red", hex: "#c0392b" },
  { id: "orange", name: "Orange", hex: "#e67e22" },
  { id: "yellow", name: "Yellow", hex: "#f1c40f" },
  { id: "lime", name: "Lime", hex: "#8bc34a" },
  { id: "green", name: "Green", hex: "#27ae60" },
  { id: "teal", name: "Teal", hex: "#16a085" },
  { id: "blue", name: "Blue", hex: "#2a6fdb" },
  { id: "navy", name: "Navy", hex: "#1f3a5f" },
  { id: "purple", name: "Purple", hex: "#8e44ad" },
  { id: "pink", name: "Pink", hex: "#e84393" },
  { id: "white", name: "White", hex: "#f4f4f2" },
  { id: "light-grey", name: "Light Grey", hex: "#c7cacd" },
  { id: "grey", name: "Grey", hex: "#808489" },
  { id: "gunmetal", name: "Gunmetal", hex: "#4a4f55" },
  { id: "black", name: "Black", hex: "#1e1f22" },
  { id: "gold", name: "Gold", hex: "#d4af37" },
  { id: "bronze", name: "Bronze", hex: "#a87132" },
];

const HEX_RE = /^#[0-9a-f]{6}$/;
/** "#RGB" / "#RRGGBB" / "RRGGBB" -> "#rrggbb", or null if not a colour. */
export function normalizeHex(c) {
  if (typeof c !== "string") return null;
  let s = c.trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  return HEX_RE.test(s) ? s : null;
}

/** Clean an appearance object: known material, valid colour and finish. Returns null for null/undefined. */
export function normalizeAppearance(app) {
  if (!app || typeof app !== "object") return null;
  const out = { materialId: hasMaterial(app.materialId) ? app.materialId : DEFAULT_MATERIAL_ID };
  const c = normalizeHex(app.color);
  if (c) out.color = c;
  if (FINISHES.includes(app.finish)) out.finish = app.finish;
  return out;
}

/** Stable cache key for an appearance ("generic", "aluminum-6061|#c0392b|polished", ...). */
export function appearanceKey(app) {
  const a = normalizeAppearance(app) || { materialId: DEFAULT_MATERIAL_ID };
  return [a.materialId, a.color || "", a.finish || ""].join("|").replace(/\|+$/, "");
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Roughness after applying a finish to the material's base roughness. */
export function finishRoughness(base, finish) {
  if (finish === "polished") return clamp(base * 0.3, 0.03, 0.12);
  if (finish === "satin") return clamp(base, 0.3, 0.45);
  if (finish === "matte") return clamp(Math.max(base * 1.6, 0.68), 0, 0.95);
  return base;
}

/**
 * Resolve an appearance to { material, color, finish, renderParams }.
 * renderParams are plain MeshPhysicalMaterial-style params with colour as "#rrggbb".
 */
export function resolveAppearance(app) {
  const a = normalizeAppearance(app) || { materialId: DEFAULT_MATERIAL_ID };
  const material = getMaterial(a.materialId);
  const color = a.color || material.render.color;
  const renderParams = { ...material.render, color };
  if (a.finish) {
    renderParams.roughness = finishRoughness(material.render.roughness, a.finish);
    if (a.finish === "polished" && material.render.metalness < 0.5) {
      renderParams.clearcoat = Math.max(material.render.clearcoat || 0, 0.6);
      renderParams.clearcoatRoughness = 0.05;
    } else if (a.finish === "matte") {
      renderParams.clearcoat = 0;
      if (renderParams.sheen === undefined && material.render.metalness < 0.5) renderParams.sheen = 0.15;
    }
  }
  return { material, color, finish: a.finish || null, renderParams };
}

/** Name of a preset colour ("Red"), or null. */
export function colorName(hex) {
  const h = normalizeHex(hex);
  const p = h && COLOR_PRESETS.find((c) => c.hex === h);
  return p ? p.name : null;
}

const FINISH_LABEL = { polished: "Polished", satin: "Satin", matte: "Matte" };

/** Human label, e.g. "Red Aluminum 6061-T6", "Aluminum 6061-T6", "#12ab34 ABS (Matte)". */
export function describe(app) {
  const a = normalizeAppearance(app) || { materialId: DEFAULT_MATERIAL_ID };
  const mat = getMaterial(a.materialId);
  let s = mat.name;
  if (a.color && a.color !== normalizeHex(mat.render.color)) s = `${colorName(a.color) || a.color} ${s}`;
  if (a.finish) s += ` (${FINISH_LABEL[a.finish]})`;
  return s;
}

// ---- unit helpers for UIs (SI in, friendly units out) ----
export const fmtUnits = {
  density: (v) => (v == null ? "-" : `${(v / 1000).toFixed(v < 1000 ? 3 : 2)} g/cm³`),
  modulus: (v) => (v == null ? "-" : v >= 1e9 ? `${+(v / 1e9).toPrecision(3)} GPa` : `${+(v / 1e6).toPrecision(3)} MPa`),
  stress: (v) => (v == null ? "n/a" : `${+(v / 1e6).toPrecision(3)} MPa`),
  conductivity: (v) => (v == null ? "-" : `${+v.toPrecision(3)} W/m·K`),
  specificHeat: (v) => (v == null ? "-" : `${+v.toPrecision(4)} J/kg·K`),
  expansion: (v) => (v == null ? "-" : `${+(v * 1e6).toPrecision(3)} µm/m·K`),
  temperature: (k) => (k == null ? "-" : `${Math.round(k - 273.15)} °C`),
  roughness: (v) => (v == null ? "-" : `${+(v * 1e6).toPrecision(3)} µm`),
};

/** Rows for a read-only property table: [{ label, value }] in friendly units. */
export function physicalRows(materialOrId) {
  const mat = typeof materialOrId === "string" ? getMaterial(materialOrId) : materialOrId;
  const p = mat.physical, f = fmtUnits, rows = [];
  rows.push({ label: "Density", value: f.density(p.density_kg_m3) });
  rows.push({ label: "Young's modulus", value: f.modulus(p.youngs_modulus_Pa) });
  rows.push({ label: "Poisson's ratio", value: p.poissons_ratio == null ? "-" : String(p.poissons_ratio) });
  rows.push({ label: "Yield strength", value: f.stress(p.yield_strength_Pa) });
  rows.push({ label: "Ultimate strength", value: f.stress(p.ultimate_strength_Pa) });
  rows.push({ label: "Thermal conductivity", value: f.conductivity(p.thermal_conductivity_W_mK) });
  rows.push({ label: "Specific heat", value: f.specificHeat(p.specific_heat_J_kgK) });
  rows.push({ label: "Thermal expansion", value: f.expansion(p.thermal_expansion_1_K) });
  if (p.melting_point_K != null) rows.push({ label: "Melting point", value: f.temperature(p.melting_point_K) });
  if (p.glass_transition_K != null) rows.push({ label: "Glass transition", value: f.temperature(p.glass_transition_K) });
  if (p.decomposition_K != null) rows.push({ label: "Decomposition", value: f.temperature(p.decomposition_K) });
  if (p.surface_roughness_m != null) rows.push({ label: "Surface roughness", value: f.roughness(p.surface_roughness_m) });
  return rows;
}
