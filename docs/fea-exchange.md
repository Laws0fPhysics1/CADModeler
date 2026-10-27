# CAD ⇄ FEA case exchange (`cadmodeler-fea-case`, version 1)

Static stress analysis runs inside CAD Modeler the same way CFD does (see `docs/cfd-exchange.md`): CAD writes a **case folder**, runs **FEA Sim** (`C:\Users\Austi\Documents\FEA Sim`, Python: gmsh + NumPy/SciPy, CuPy optional) headless as a child process, and polls the folder for progress, results and viewport data. The folder is the whole interface.

| Side | Code |
|---|---|
| CAD, case building (pure, Node-testable) | `src/fealink.js` (`buildCase`, `validateCase`, `forceVector`, `normalizeReadback`, `parseSurface`, `parseField`) |
| CAD, Static Stress dialog | `src/feastudy.js` (`openFeaStudy(ctx)`, `submitStudy`, `feaDebugApi`), `src/fea.css` |
| CAD, results in the viewport | `src/fearesults.js` (`openFeaResults(ctx, study)`) |
| CAD, OS access | `src/platform.js` → `platform.fea.*` (Electron IPC `fea:*` in `electron/main.cjs`, dev server `POST /api/fea`) |
| CAD, solver process | `electron/fea-runner.cjs` (wraps the shared runner in `electron/cfd-runner.cjs` with FEA Sim's folder, log name and labels) |
| FEA, reader / write-back | `FEA Sim/fea/caseio.py`, `FEA Sim/fea/run.py` |
| Tests | `node tests/fealink.test.mjs` (pure tests, plus a full kernel → STEP → FEA Sim → viz round trip when Python and gmsh are installed), `python "FEA Sim/tests/validate.py"` |

## Folder layout

```
<exchangeDir>/<Design>_FEA_<YYYYMMDD-HHMMSS>/
    geometry.step     written by CAD: K.exportSTEP of the analysed body (exact B-rep, mm, CAD axes, Z up)
    case.json         written by CAD: this spec
    progress.json     written by FEA Sim while running (≤ 2 writes / s, plus every phase change)
    results.json      written by FEA Sim when the run ends (completed / stopped / failed)
    fea-run.log       stdout/stderr of the in-app solve
    stop.request      created by CAD to stop a solve; FEA Sim deletes it at the start of a run
    viz/              surface mesh + fields for CAD's viewport (see below)
```

* `exchangeDir` comes from `platform.fea.getConfig()`; the default is `Documents\CAD-FEA Exchange`. Config (Electron `userData/config.json` → `fea`): `feaDir` (default `Documents\FEA Sim`), `pythonCmd` (`python`), `exchangeDir`. The dev server reads `CAD_FEA_DIR`, `CAD_FEA_PYTHON`, `CAD_FEA_EXCHANGE`.
* Every JSON and binary file is written atomically (`<name>.<pid>.tmp`, then renamed). `viz/` files are written before `viz/manifest.json`, and the manifest before `results.json`.
* `platform.fea.readFile` only reads `viz/*` and top-level `*.json` / `*.log` / `*.stl` inside the exchange folder (same rules as CFD).

## `case.json`

```jsonc
{
  "format": "cadmodeler-fea-case",   // required, exact
  "version": 1,                       // readers accept <= their version, warn on newer
  "createdAt": "2026-10-08T14:41:26.000Z",
  "source": { "app": "CAD Modeler", "design": "FEA Cantilever", "appVersion": "0.2.0" },
  "units": "mm",                      // required, only "mm" in v1
  "analysis": "static-stress",

  "geometry": {
    "file": "geometry.step", "format": "step",
    "bbox": { "min": [0, 0, 0], "max": [200, 20, 10] }, "size": [200, 20, 10],   // mm (null if CAD had no bounds)
    "contact": null,                  // "bonded" when several bodies are in the STEP
    "bodies": [ {                     // STEP order = this order (one body per study from the dialog)
      "id": "Body1", "name": "Body1", "color": "#c0392b",
      "material": {                   // every key of materials.js `physical`, SI units (null = generic steel)
        "id": "generic", "name": "Generic (Steel - Satin)", "density_kg_m3": 7850,
        "youngs_modulus_Pa": 2e11, "poissons_ratio": 0.29, "yield_strength_Pa": 2.5e8, "ultimate_strength_Pa": 4e8, "...": 0 },
      "volume_mm3": 40000, "mass_kg": 0.314,
      "bbox": { "min": [0, 0, 0], "max": [200, 20, 10] },
      "faces": [ { "idx": 0, "pt": [100, 0, 5], "n": [0, -1, 0], "area_mm2": 2000, "type": "PLANE" }, "..." ]  // optional: every face, for results.faceMap
    } ]
  },

  "fixtures": [ { "type": "fixed", "faces": [ FACEREF, ... ] },          // ≥ 1 required; all DOFs of every face node fixed
                { "type": "pin", "faces": [ FACEREF, ... ],             // cylindrical faces (a shaft / pin in a hole); the solver fits the axis
                  "radial": true, "axial": false, "tangential": false } ], // which motions are held, in the cylinder's frame (≥ 1)
  "loads": [
    { "type": "bearing", "faces": [ FACEREF, ... ], "vector_N": [500, 0, 0] }, // shaft pushing on a hole: pushed half only, cosine spread, exact resultant
    { "type": "force", "faces": [ FACEREF, ... ],
      "vector_N": [0, 0, -100],       // total force over all the faces (uniform traction), CAD axes
      "magnitude_N": 100, "direction": "-Z", "flip": false },   // informational: how the dialog built the vector
    { "type": "pressure", "faces": [ FACEREF, ... ],
      "magnitude_Pa": 1e6 }           // normal pressure, positive pushes INTO the material
  ],
  "gravity": { "enabled": false, "direction": "-Z", "vector_m_s2": [0, 0, -9.80665] },
  "mesh": { "quality": "medium", "size_mm": null, "order": 2 },   // coarse | medium | fine | finest; size_mm overrides
  "solver": { "method": "auto", "gpu": true, "tolerance": 1e-8 },  // auto | direct | cg | cg-gpu
  "results": { "progress": "progress.json", "results": "results.json", "viz": "viz/manifest.json" }
}
```

`FACEREF` is `K.faceRef` plus face info: `{ "body": "Body1", "idx": 3, "pt": [0, 10, 5], "n": [-1, 0, 0], "area_mm2": 200, "type": "PLANE" }`. `idx` is the index in replicad's `shape.faces`; `pt` is the face's centre of mass and `n` the normal there (CAD modelled coordinates, mm). FEA Sim matches each reference to a gmsh surface by centre (and normal for planar faces, and area), using `idx` only as a tie-breaker, so a STEP reader that reorders faces is harmless.

**Force direction (dialog):** "Normal to face" = the area-weighted mean outward normal of the selected faces, reversed (the force pushes into the faces); an axis (`+X` … `-Z`) is that direction; Flip reverses either. `fealink.forceVector()` does this, and `vector_N` is what the solver uses.

**Mesh size:** `h = min(f_L × largest extent, f_t × 2V/A)` with (f_L, f_t) = coarse (0.10, 1.0), medium (0.05, 0.6), fine (0.03, 0.4), finest (0.02, 0.28), and curvature refinement of 8 / 12 / 16 / 20 elements per full circle.

## `progress.json` (FEA → CAD)

```json
{ "kind": "progress", "format": "cadmodeler-fea-case", "version": 1,
  "status": "running",          // starting | running | completed | stopped | failed
  "phase": "solving",           // starting | meshing | assembling | solving | post | writing | done
  "fraction": 0.62,             // overall 0..1 (phases: meshing 2-30 %, assembling 30-45 %, solving 45-88 %, post, writing)
  "message": "CG iteration 1200, residual 3.1e-05", "elapsed_s": 4.2, "updatedAt": "2026-10-08T07:41:50-0700",
  "error": "only when failed" }
```

## `results.json` (FEA → CAD)

```jsonc
{ "kind": "results", "format": "cadmodeler-fea-case", "version": 1,
  "status": "completed",                 // completed | stopped | failed
  "case": "FEA_Cantilever_FEA_20261008-074126", "design": "FEA Cantilever", "analysis": "static-stress",
  "units": { "length": "mm", "displacement": "mm", "stress": "MPa", "force": "N", "mass": "kg" },
  "maxVonMises_MPa": 59.48, "maxDisplacement_mm": 0.7966, "minSafetyFactor": 4.203,   // safety factor capped at 1000; null if no yield/ultimate strength
  "maxPrincipal_MPa": 61.2, "minPrincipal_MPa": -60.9,
  "locations": { "maxVonMises": [0, 0, 10], "maxDisplacement": [200, 20, 0], "minSafetyFactor": [0, 0, 10] },  // mm, CAD axes
  "materials": [ { "body": "Body1", "name": "...", "E_MPa": 200000, "nu": 0.29, "density_kg_m3": 7850, "yield_MPa": 250, "yieldFrom": "yield" } ],  // yieldFrom: yield | ultimate | null
  "reactions": [ { "fixture": 0, "force_N": [0, 0, 100] } ],       // sum of R = K u − f over each fixture's nodes
  "reactionTotal_N": [0, 0, 100], "appliedTotal_N": [0, 0, -100],
  "equilibriumError": 1.2e-10,                                     // |ΣR + ΣF| / |ΣF|
  "loads":    [ { "type": "force", "vector_N": [0, 0, -100], "area_mm2": 200, "faces": [ { "body": "Body1", "face": 1, "surface": 2, "distance_mm": 0 } ] } ],
  "fixtures": [ { "type": "fixed", "nodes": 95, "faces": [ { "body": "Body1", "face": 3, "surface": 4, "distance_mm": 0 } ] } ],
  "faceMap":  [ { "body": "Body1", "face": 0, "surface": 1, "distance_mm": 0 } ],   // every CAD face listed in geometry.bodies[].faces
  "mass_kg": 0.314, "volume_mm3": 40000,
  "nodes": 7130, "elements": 3734, "dofs": 21390, "freeDofs": 21033, "elementType": "TET10",
  "mesh": { "quality": "medium", "size_mm": 3.87, "extent_mm": 200, "thickness_mm": 6.45, "surfaces": 6, "flippedElements": 0 },
  "solver": { "method": "direct-superlu", "backend": "cpu", "iterations": 1, "residual": 1.5e-9, "converged": true },
  "timings": { "meshing_s": 0.13, "assembling_s": 0.31, "solving_s": 0.4, "post_s": 0.09, "writing_s": 0.01, "startedAt": "...", "finishedAt": "...", "wall_s": 1.2 },
  "warnings": [],
  "error": "message + traceback, only when failed" }
```

## In-app solve

**Solve** in the Static Stress dialog (or `__fea.solve`) exports the body's STEP, builds the case, writes it with `platform.fea.writeCase`, starts `python -u main.py --case <dir> --headless` (cwd = `feaDir`, log `fea-run.log`) and adds `{ id, kind: "fea", name, casePath, folderName, settings, bodies, status, results }` to `doc.studies` (listed under **Simulations** in the browser; `settings` holds the face references so **Edit Study** can reopen the dialog). Stop works like CFD: `stop.request`, then a kill after 30 s; quitting the app stops running solves.

## `viz/` (FEA → CAD, little-endian, CAD millimetres, CAD axes = the body's modelled coordinates)

`manifest.json`:
```jsonc
{ "kind": "viz", "format": "cadmodeler-fea-viz", "version": 1, "units": "mm", "stressUnits": "MPa",
  "surface": { "file": "surface.bin", "vertices": 4094, "triangles": 8184 },
  "fields": {
    "displacement": { "file": "displacement.bin", "components": 3, "units": "mm", "min": 0, "max": 0.797 },   // min/max of the magnitude
    "vonMises":     { "file": "vonmises.bin", "components": 1, "units": "MPa", "min": 0.1, "max": 59.5 },
    "safetyFactor": { "file": "safety.bin", "components": 1, "units": "", "cap": 1000, "min": 4.2, "max": 1000 },
    "principal":    { "file": "principal.bin", "components": 3, "units": "MPa", "order": "s1,s2,s3" } },
  "markers": { "maxVonMises": { "pos": [0, 0, 10], "value": 59.5 }, "maxDisplacement": { "pos": [200, 20, 0], "value": 0.797 },
               "minSafetyFactor": { "pos": [0, 0, 10], "value": 4.2 } },
  "extent_mm": 200,
  "surfaces": { "1": { "cad": { "body": "Body1", "face": 0 }, "area_mm2": 2000 }, "...": {} },   // gmsh surface tag -> CAD face
  "yield_MPa": [250],
  "status": "completed" }
```

| File | Layout |
|---|---|
| `surface.bin` | `"FSF1"`, u32 nVerts, u32 nTris, f32[3·nVerts] undeformed positions, u32[3·nTris] triangles (outward winding), i32[nTris] gmsh surface tag of each triangle (look it up in `manifest.surfaces` for the CAD face). The surface is the boundary of the TET10 mesh; each 6-node face is split into 4 linear triangles, so mid-side nodes are vertices too. |
| `displacement.bin` | f32[3·nVerts] displacement vector (mm) per vertex |
| `vonmises.bin` | f32[nVerts] von Mises stress (MPa), nodal average |
| `safety.bin` | f32[nVerts] yield / von Mises, capped at `cap` (1000) |
| `principal.bin` | f32[3·nVerts] principal stresses σ1 ≥ σ2 ≥ σ3 (MPa) |

The viewer draws `positions + s · displacement`: **Adjusted** scales the largest displacement to 5 % of the model extent (`fealink.adjustedScale`, with a 0.1× to 10× slider), **Actual** is 1:1, **Undeformed** is 0. The undeformed shape shows as a wireframe ghost (30° feature edges).

## Validation (FEA Sim `tests/validate.py`)

| Check | Result |
|---|---|
| Cantilever 200 × 20 × 10 mm steel, 100 N tip load, medium mesh (7.2 k nodes) | tip deflection 0.7956 mm vs PL³/3EI = 0.8000 mm (−0.55 %) |
| Bending stress σxx at x = 50 / 100 mm | 45.01 / 30.02 MPa vs Mc/I = 45.00 / 30.00 MPa |
| Bar 100 × 10 × 10 mm, 10 kN tension | σxx = 100.000 MPa (F/A), uniform to < 0.001 % away from the clamp; strain = F/AE |
| Mesh convergence (coarse → finest, 2.2 k → 51 k nodes) | tip deflection 0.7947 → 0.7961 mm, monotonic |
| Pressure, gravity, multi-face force | reactions = p·A, m·g, total force (to 1e-6) |
| Through CAD (`tests/fealink.test.mjs`): replicad beam with a Ø8 hole | 0.8015 mm, reaction 100 N, all 8 faces matched at < 1e-3 mm |

Full tables: `FEA Sim/README.md`.

## Versioning

Same rules as the CFD case: adding a field keeps `version`; renaming / removing / changing a unit bumps it. `progress.json`, `results.json` carry the case's `format` and `version`; `viz/manifest.json` has its own `format` (`cadmodeler-fea-viz`) and `version`.

## Roadmap

1. Supports beyond fully fixed (frictionless, pin, prescribed displacement), remote loads and moments, bolt preload.
2. Assemblies: several bodies per study with bonded contact already work in the solver (gmsh fragment, per-body materials); the dialog needs multi-body selection and the assembly transforms applied to the STEP. Then separation / sliding contact.
3. Modal, thermal and buckling studies (`analysis` field), nonlinear (large deflection, plasticity).
4. One-way FSI: CFD Sim's surface Cp (`cfd-exchange.md` roadmap item 2) as an FEA pressure load.
5. `platform.cfd` / `platform.fea` → `platform.sim(kind)` once CAM joins.
