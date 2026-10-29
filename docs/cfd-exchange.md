# CAD ⇄ CFD case exchange (`cadmodeler-cfd-case`, version 1)

CAD Modeler and CFD Sim talk through a **case folder** on disk. CAD writes the geometry and settings. CFD Sim reads them, runs, and writes progress and results back into the same folder, where CAD polls for them. Neither app links against the other. The folder is the whole interface, so either side can be replaced, run by hand, or scripted.

| Side | Code |
|---|---|
| CAD, case building (pure, Node-testable) | `src/cfdlink.js` (`buildCase`, `validateCase`, `normalizeReadback`) |
| CAD, dialog | `src/cfdstudy.js` (`openCfdStudy(ctx)`), `src/cfdstudy.css` |
| CAD, OS access | `src/platform.js` → `platform.cfd.*` (Electron main: `electron/main.cjs`) |
| CAD, in-app solver process | `electron/cfd-runner.cjs` (Electron IPC and the dev server's `/api/cfd`) |
| CAD, results in the viewport | `src/cfdresults.js` |
| CFD, reader / write-back | `CFD Sim/cfd/cadlink.py` |
| CFD, viewport export (`viz/`) | `CFD Sim/cfd/cadviz.py` |
| Tests | `node tests/cfdlink.test.mjs` |

## Folder layout

```
<exchangeDir>/<Design>_<YYYYMMDD-HHMMSS>/
    geometry.stl      written by CAD: binary STL, millimetres, CAD coordinates (Z up)
    case.json         written by CAD: this spec
    progress.json     written by CFD while a run is going (≤ 1 write / s)
    results.json      written by CFD when a run ends (completed / stopped / diverged / failed)
    cfd-launch.log    stdout/stderr of CFD Sim when the desktop app opened its GUI
    cfd-run.log       stdout/stderr of an in-app (headless) solve
    stop.request      created by CAD to stop an in-app solve; CFD deletes it at the start of a run
    viz/              per-frame results for CAD's viewport (written by headless runs, see below)
```

* `exchangeDir` comes from `platform.cfd.getConfig()`. The default on this machine is `C:\Users\Austi\Documents\CAD-CFD Exchange`.
* `<Design>` is the design name with everything except letters, digits, `_` and `-` replaced by `_`, so it is always a single path segment. The time is local.
* CFD writes every JSON file atomically: it writes `<name>.<pid>.tmp`, then renames it over the target. A reader never sees a half-written file. If a read fails anyway, ignore it and retry on the next poll.
* Run outputs (frames, forces.csv and so on) go to CFD Sim's own `runs/<case folder name>/` folder. Their path is reported in `results.json` → `runFolder`.

## `case.json`

```jsonc
{
  "format": "cadmodeler-cfd-case",      // required, exact
  "version": 1,                          // required; readers accept <= their version, warn on newer
  "createdAt": "2026-10-08T01:44:46.366Z",
  "source": { "app": "CAD Modeler", "design": "Kernel Box", "appVersion": "0.1.0" },
  "units": "mm",                         // required, only "mm" in v1

  "geometry": {
    "file": "geometry.stl",              // relative to the case folder
    "format": "stl-binary",
    "triangles": 12,
    "bbox": { "min": [-100, -40, 0], "max": [100, 40, 60] },   // mm, CAD axes
    "size": [200, 80, 60],               // mm, bbox extents
    "lengthMm": 200,                     // max extent = CFD reference length
    "bodies": [
      {
        "id": "Body1", "name": "Body1",
        "color": "#c0392b",              // appearance colour override, or null
        "material": {                    // null if the body has no material
          "id": "aluminum-6061", "name": "Aluminum 6061-T6",
          "density_kg_m3": 2700,         // always present (null if unknown)
          "youngs_modulus_Pa": 6.89e10, "poissons_ratio": 0.33, "...": "every key of the material's `physical`, SI units"
        },
        "volume_mm3": 960000,            // optional (when the host passes bodyInfo)
        "mass_kg": 2.592                 // optional, density × volume
      }
    ]
  },

  "flow": {
    "direction": "+Y",                   // free-stream velocity in CAD axes: air MOVES toward +Y
    "up": "+Z",                          // "+Z", or "+Y" when the flow is vertical (±Z)
    "speed_m_s": 10,
    "fluid": "Air (20°C)",               // "Air (20°C)" | "Water (20°C)" | "Custom"
    "nu": 1.5e-5,                        // m²/s, always filled (preset values for Air/Water)
    "rho": 1.204                         // kg/m³
  },

  "ground": { "enabled": false, "gap_mm": 0, "moving": true },  // floor under the lowest point; forced off for vertical flow

  "solver": {                            // every key optional; null or missing = CFD default
    "quality": "standard",               // draft | standard | high | ultra | max  (CFD Sim cell budgets 8/25/60/110/150 M)
    "resolution": null,                  // cells across lengthMm; overrides quality
    "levels": 4,                         // grid levels 1..4 (1 = uniform)
    "precision": "fp16c",                // fp16c | fp16 | fp32
    "flowThroughs": 3,                   // run duration
    "frames": null,                      // playback frames; default comes from the quality preset (60..200)
    "gpu": true,
    "maxBlockage": 0.01                  // optional; side/top padding grows until bbox frontal area / tunnel section <= this.
                                         //   CFD default 0.01; 0 = the old fixed 1.5 L box (see "Domain size" below)
  },

  "estimates": { "lengthM": 0.2, "frontalAreaM2": 0.012083, "reynolds": 133333 },  // informational, from CAD
  "results": { "progress": "progress.json", "results": "results.json" },          // where CFD writes back
  "launch": true                          // optional: CAD asked CFD Sim to open the case
}
```

### How CFD Sim maps it

| case.json | CFD Sim |
|---|---|
| STL in mm | `prepare_mesh(mesh, flow, up, scale=0.001)`: metres, with the absolute size kept |
| `flow.direction` | `flow_axis`: that CAD axis becomes sim **+X** (downstream) |
| `flow.up` | `up_axis` → sim +Z |
| `ground.gap_mm` | `CaseParams.ground_gap` (m); `moving` → `moving_ground` |
| `solver.quality` | resolution from the cell budget (same rule as the GUI's Quality box), frames, u_lb = 0.05 |
| `levels` | `refine = levels > 1`, `levels`. The GUI offers 2 to 4 levels, or the adaptive grid switched off |
| `precision` | headless: CaseParams. GUI: applied to the run when it starts |
| fluid | matched on its first word (`air`, `water`, `custom`), so a mangled `°` is harmless |

The GUI also sets the scenario preset to *Custom*, the paddings to 2 / 4 / 1.5 / 1.5 L, the run name to the case folder name, and the window title to "CFD Sim · From CAD Modeler: \<design\>". A label at the top of the Model section shows the design name and its body names.

### Command line

```
python main.py --case "<case folder>"              # GUI, geometry loaded and fields pre-filled
python main.py --case "<case folder>" --headless   # no GUI; exit code 0 on success
               [--cpu] [--name RUNNAME]
```

## `progress.json` (CFD → CAD)

Written as soon as a run starts, whenever the status changes, and at most once per second while running. The GUI also writes `status: "ready"` when it opens a case.

```json
{ "kind": "progress", "format": "cadmodeler-cfd-case", "version": 1,
  "status": "running",            // ready | starting | running | completed | stopped | diverged | failed
  "step": 2600, "total": 5200, "fraction": 0.5,
  "Cd": 1.19, "Cl": 0.01, "Cs": 0.0, "MLUPS": 2800, "t_sim_s": 0.13,
  "elapsed_s": 3.1, "runFolder": "C:\\...\\CFD Sim\\runs\\Kernel_Box_20261007-184446",
  "updatedAt": "2026-10-07T18:45:01-0700", "error": "only when failed" }
```

## `results.json` (CFD → CAD)

Written once per run. A new run deletes the old `results.json` first.

```json
{ "kind": "results", "format": "cadmodeler-cfd-case", "version": 1,
  "status": "completed",          // completed | stopped | diverged | failed
  "case": "Kernel_Box_20261007-184446", "design": "Kernel Box",
  "runFolder": "C:\\...\\CFD Sim\\runs\\Kernel_Box_20261007-184446",
  "Cd": 1.1725, "Cl": -0.0002, "Cs": -0.0012,          // mean of the last 20 % of steps
  "forces_N": { "drag": 0.967, "side": -0.001, "lift": -0.0002 },   // sim axes, same window
  "forces_cad_N": [0.001, 0.967, -0.0002],             // the same force as a vector in CAD axes
  "final": { "Cd": 1.1697, "Cl": -0.0104, "Cs": -0.0006, "forces_N": { "...": 0 } },
  "averaging": "mean of the last 20 % of steps (42 samples)",
  "referenceArea_m2": 0.0137,      // projected frontal area of the voxelized body
  "referenceLength_m": 0.2, "speed_m_s": 10, "rho": 1.204, "dynamicPressure_Pa": 60.2,
  "reynolds": 133333, "cells": 735540, "resolution": 20, "levels": 1,
  "steps": 5200, "steps_total": 5200, "t_sim_s": 0.26, "frames": 2,
  "timings": { "startedAt": "...", "finishedAt": "...", "wall_s": 6.1, "steps_per_s": 852.6 },
  "backend": "gpu",
  "blockage": 0.0098,              // voxel frontal area / free-slip tunnel cross-section (full-model equivalent)
  "Cd_maskell": 1.02,              // extra only: Cd / (1 + 2.5 Cd blockage) (Maskell bluff-body correction); Cd is uncorrected
  "convergence": { "Cd_previous_window": 1.03, "drift": 0.012, "Cd_std_window": 0.02, "converged": true, "note": "..." },
  "error": "traceback, only when failed" }
```

`convergence.drift` compares the averaging window (last 20 %) with the 20 % before it; `converged` is |drift| ≤ 3 %. When it is false, run more flow-throughs.

### Domain size (blockage)

CFD Sim's lateral walls are free-slip, so the domain behaves like a wind tunnel. Its padding is 2 L upstream, 4 L downstream, and at least 1.5 L on the sides and top (L = longest body dimension). The side and top padding is then widened, by the same distance on every lateral face, until the bounding-box frontal area is at most `maxBlockage` (default 1 %) of the tunnel cross-section. A compact body such as a cube or sphere gets about 4.5 L per side. A car (L = its length) is barely changed. The extra room is on the coarsest grid only, so the cells across the body (from the quality budget, which ignores the widening) stay the same. A draft cube grows from 8.4 M to 10.2 M cells and 0.47 GB to 0.54 GB, with a few percent more time. Before this (fixed 1.5 L, ~6 % blockage) the cube read Cd 1.34 against 1.05 (bug 2026-10-26_18-12-24).

Coefficient convention: `C = F / (½ ρ U² A_ref)`. Drag acts along the flow, lift along `flow.up`, and side force along up × flow. `forces_cad_N` = Rᵀ·[drag, side, lift], where R maps CAD to sim axes.

`platform.cfd.readResults(casePath)` returns `{ results, progress }` (each one parsed JSON or null), or null when neither file exists. `normalizeReadback()` in cfdlink.js also accepts a bare file object, using its `kind` field.

## In-app solve (CAD runs the solver)

CAD's **Solve** button writes the case, then runs `<pythonCmd> -u main.py --case <dir> --headless` with `cwd = cfdDir` as a child process of the app (`electron/cfd-runner.cjs`). No CFD Sim window opens. In-app cases set `solver.frames = 30`.

* **Progress and results:** `progress.json` and `results.json`, exactly as above.
* **Stop:** CAD creates `stop.request` in the case folder. The solver's `should_stop` sees it between batches, writes the current frame and `results.json` with `status: "stopped"`, and exits. If it is still running 30 s later, CAD kills the process tree. Quitting CAD stops running solves the same way.
* **Viewport data:** `cadlink.run_headless(..., export_viz=True)` calls `cadviz.VizExporter.frame()` after every solver frame. Each frame's files are written before the manifest that lists them, and every file goes to `<name>.<pid>.tmp` first and is then renamed.

### `viz/` files (CFD → CAD, little-endian, everything in CAD millimetres and CAD axes)

`manifest.json`:
```jsonc
{ "kind": "viz", "format": "cadmodeler-cfd-viz", "version": 1, "units": "mm",
  "speed_m_s": 10, "q_Pa": 60.2,                      // free stream and dynamic pressure (Cp = (p − p∞) / q)
  "flow": { "direction": "+Y", "up": "+Z" },
  "ranges": { "cp": [-1.2, 1.0],                      // display range for the surface colours
              "slice": { "speed": [0, 1.6], "cp": [-1.5, 1.0] },   // uint8 slice quantization (speed in units of U)
              "speedScale": 100, "isoSpeedScale": 100 },           // uint8 speed = speed / U × 100
  "bodyLengthMm": 200, "symmetry": false,
  "surface": { "file": "surface.bin", "vertices": 10242, "triangles": 20480 },
  "frames": [ { "index": 0, "t": 0.035,               // simulated time, s
                "surf": { "file": "surf_0000.bin", "count": 10242, "min": -0.7, "max": 1.0 },
                "iso": { "file": "iso_0000.bin", "points": 20606, "triangles": 41028 },
                "slice": { "file": "slice_0000.bin", "planes": [ { "name": "side", "w": 282, "h": 74 }, { "name": "top", ... }, { "name": "wake", ... } ] },
                "lines": { "file": "lines_0000.bin", "lines": 169, "points": 44842 } } ],
  "status": "completed" }                              // only once the run has ended
```

| File | Layout |
|---|---|
| `surface.bin` | `"CSF1"`, u32 nVerts, u32 nTris, f32[3n] positions, u32[3m] indices. This is geometry.stl welded and subdivided to about one playback cell (at most about 400 k vertices). |
| `surf_NNNN.bin` | f32[nVerts] Cp at each surface vertex, sampled 1.25 playback cells out along the vertex normal (solid cells excluded) |
| `iso_NNNN.bin` | `"CQI1"`, u32 n, u32 m, f32[3n] positions, i8[3n] normals ×127 (padded to 4 bytes), u8[n] speed/U×100 (padded), u32[3m] triangles. This is the solver's full-resolution Q-criterion isosurface. |
| `slice_NNNN.bin` | `"CSL1"`, u32 count, then for each plane: u32 w, u32 h, f32[12] corners (origin, +u end, +v end, unused; the corners are cell centres), then u8[w·h] speed, u8[w·h] Cp and u8[w·h] fluid mask (1 = fluid), each padded to 4 bytes. Rows run along v. The planes go through the body centre: `side` (flow × up), `top` (flow × side), and `wake` (cross-flow, half a body length behind the body). |
| `lines_NNNN.bin` | `"CST1"`, u32 nLines, u32 nPts, u32[nLines+1] offsets, f32[3·nPts] positions, u8[nPts] speed/U×100 (padded). These are RK2 streamlines from a rake 0.4 L upstream, covering the frontal area plus 15 %. |

## Versioning rules

* Adding a field does not change `version`. Readers ignore keys they don't know.
* Renaming or removing a field, or changing a unit or meaning, bumps `version`. CFD Sim reads versions ≤ `cadlink.VERSION` and warns, but tries anyway, on newer ones.
* `progress.json` and `results.json` carry the same `format` and `version` as the case that produced them.

## Roadmap

1. **Live results in CAD** *(done)*: in-app Solve, a "Simulations" list in the browser (kept in `doc.studies`), and progress, coefficients and the flow drawn in the viewport while the run goes.
2. **Surface pressure on the model** *(done)*: `viz/surface.bin` plus `surf_NNNN.bin`, see above. Next: a time-averaged Cp (mean over the last 20 % of frames), and wall shear / skin-friction lines.
3. **Re-run and parametric sweeps**: CAD writes several cases (speed or yaw sweep, or design variants) under one study folder, plus a `study.json` index. CFD gets a `--queue <folder>` mode that runs them one at a time on the GPU.
4. **Two-way geometry**: CFD might suggest refinement or report voxelization problems (an open mesh, thin walls) as `warnings` in `progress.json`. CAD would show them.
5. **FEA and CAM use the same pattern**: `cadmodeler-fea-case` and `cadmodeler-cam-case`, each with the same folder, `format`, `version`, `source`, `units`, `geometry.bodies[].material`, `progress.json` and `results.json` conventions:
   * FEA: STEP (exact B-rep) next to the STL, loads and fixtures as face references (`faceRef` from kernel.js), and material elastic properties, which `bodies[].material` already carries. Results: displacement and von Mises stress per node, written back the same way. CFD surface pressures from step 2 can feed straight in as FEA loads (one-way FSI).
   * CAM: STEP plus stock, tool library and setups. Results: toolpaths (G-code plus a preview polyline JSON).
   * The `platform.cfd.*` API should grow into `platform.sim(kind).*` with the same five calls (getConfig, writeCase, launch, readResults, revealCase).
