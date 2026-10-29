# CFD Sim

GPU lattice-Boltzmann external-flow solver with a desktop viewer. Drop in an OBJ / STL / FBX,
set speed, fluid and resolution, hit Run, then scrub through the flow.

```
run.bat                      # GUI
python main.py --headless samples/sphere.stl --length 0.3 --speed 10 --res 80   # no GUI
python main.py --open runs/sphere_test                                          # viewer on an old run
python main.py --case "<CAD case folder>" [--headless]                          # from CAD Modeler (below)
```

## What it does

* **Solver** – D3Q19 lattice Boltzmann, single-precision CUDA kernels via CuPy.
  * **39 bytes per cell**: one population buffer updated in place (AA pattern) and stored as a custom 16-bit
    float (sign, 4-bit exponent, 11-bit mantissa — twice IEEE half's precision over the range used) of the
    populations shifted by the lattice weights; arithmetic stays float32. The old two-buffer float32 layout
    needed 169 B/cell, so the same 10 GB card holds ~4× the cells, and it runs faster (≈3900 vs 2700 MLUPS
    at 38 M cells). `--precision fp32` keeps 32-bit storage (77 B/cell) as a reference. Boundary conditions
    run in a separate fill kernel over the boundary cells only.
  * Sphere checks of the storage change: Re 100 (3 levels) Cd 1.2937 old / 1.2938 AA-fp32 / 1.2952 fp16;
    Re 2e5 (LES, τ floor) Cd 0.551 ± 0.004 and 0.555 ± 0.005 (two fp32 realizations), fp16c 0.558 ± 0.005.
  * Regularized BGK collision (much more stable than plain BGK near τ → 0.5).
  * Smagorinsky LES sub-grid model so high-Reynolds cases run on affordable grids.
  * Half-way bounce-back on the voxelized body; momentum-exchange drag / lift / side force.
  * Velocity inlet and pressure outlet (non-equilibrium extrapolation), free-slip lateral walls,
    optional no-slip ground plane, viscous + acoustic sponge layers so start-up pressure waves and
    wake eddies do not reflect back into the domain.
  * Smooth inlet ramp to avoid an impulsive start.
  * NumPy fallback if there is no CUDA device (≈ 100× slower — fine for tiny test grids only).
* **Geometry** – OBJ / STL / PLY / GLB directly; **.blend and FBX** are converted headlessly to GLB with
  the Blender install on this machine, keeping materials and textures for the viewer. Multi-part models
  show a parts list (untick landing gear, props, …). Any orientation: pick which model axis faces the
  flow and which is up. Voxelized with VTK's scanline stencil (+ a surface shell for open / thin meshes).
* **Scale** – model units are whatever the file used. Pick a unit (mm / cm / dm / m / in / ft) or use the
  **dimension tool**: the preview shows the bounding box with red / green / blue edges (length / width /
  height); click one, type its real length, the other two follow.
* **Adaptive grid** – nested refinement blocks (default 3 levels: far field, wake block at 2×, body block
  at 4×), each at half the cell size and half the time step of its parent, with proper LBM grid-refinement
  coupling (interpolated ghost rims with non-equilibrium rescaling, child→parent restriction). Sphere
  check: Cd 1.31 (3 levels) vs 1.30 (uniform) with the far field at 7 cells across the sphere. The cell
  budget goes where the flow is; "Cells across" always refers to the finest grid.
* **Half model** – tick *Half model* for a symmetric body at zero yaw: the domain is cut at the centre plane
  (free-slip = symmetry), one half is simulated, playback mirrors it, forces are doubled. 2× cheaper.
* **Full-resolution vortex output** – every frame, Q-criterion and vorticity are computed on the GPU at
  the solver's full resolution; the Q isosurface is extracted there (flying edges, ~0.3 s for 30 M cells)
  and stored as a compact mesh with normals and speed, and |vorticity| is stored as a uint8 volume.
  Playback therefore shows grid-resolution vortex structure, not a subsampled version.
* **Viewer** – PyVista (VTK) inside a Qt window: slice planes (speed, pressure, vorticity, Q, u/v/w),
  streamline tubes seeded in the slice plane, vortex-core isosurfaces (precomputed full-res or
  adjustable-level from the playback grid), volume rendering (full-res vorticity), surface Cp on the
  body, live Cd/Cl/Cs trace, timeline scrubbing with background prefetch, video / GIF export.
  Physically-based shading, SSAO and FXAA; the **Cinematic preset** button gives the dark "vortex
  surface only" look with a rear-quarter camera. Frames update live while the solver runs.

## Using the app

Start screen → **Open model** (or pick a recent run). The left panel is the whole setup:

* **Scenario** preset (car / aircraft / building / drone / underwater) sets speed, fluid, ground, belt and padding.
* **Quality** preset (Draft 8 M → Max 150 M cells) sets resolution, frame count and lattice speed from a cell
  budget; **Duration** sets flow-throughs. The card shows cells, GPU memory, estimated time, Re, cell size.
* **Advanced** folds out every numeric knob if you want it. **Run simulation**; frames appear live.

Right panel: **Look** dropdown (Cinematic / Engineering / Vortex + slice / Volume / Surface pressure),
**Detail** (large or fine vortex structures), field, colours, slice. "More" holds the individual toggles and
render options. Icons: reset camera, cinematic camera, screenshot, export video.

## Every parameter

| Setting | Meaning |
|---|---|
| Yaw | Crosswind angle about the vertical axis (Advanced). |
| Object length | Real size of the model's longest dimension. This sets the scale; mesh units are ignored. |
| Flow / up axis | Which model axis points into the flow, which is up. Internally the flow is always +X, up is +Z. |
| Ground plane | Floor under the object (cars, buildings). Clearance sets the gap. |
| Moving ground | Belt at free-stream speed, like a vehicle tunnel (default). Carries no shear, so it is modelled as a free-slip floor (moving-wall bounce-back is unstable at τ→0.5). Untick for buildings (no-slip floor). |
| Adaptive grid | Advanced: number of levels (2 or 3) and the padding of the wake and body blocks (multiples of L). |
| Half model | Symmetric body, zero yaw only. Halves the cell count. |
| Q levels | Set by the scenario preset: bluff bodies 2 / 8 (U/L)², aircraft 15 / 60 because L is the fuselage length and the interesting structures are wing-scale. |
| Speed, fluid | Free-stream speed; air / water presets or custom ν, ρ. |
| Cells across object | Grid resolution. Cell count and GPU memory are shown live. 80–150 is a good range on a 10 GB card. |
| Padding | Domain size in multiples of the object length. Upstream 2 L, downstream 4 L, sides / top at least 1.5 L. The side and top padding is then widened until the bounding-box frontal area is ≤ `max_blockage` (default 1 %, `--max-blockage`, case.json `solver.maxBlockage`; 0 = off) of the tunnel section, because the free-slip walls act as wind-tunnel walls: a cube in the old 4 L-wide box (6 % blockage) read Cd 1.34 instead of ~1.05–1.19. A compact body gets ~4.5 L per side and a car is barely changed. The extra cells are all on the coarsest grid (a draft cube went from 8.4 M to 10.2 M cells and 0.47 GB to 0.54 GB), and quality presets size the resolution without the widening. |
| Duration | Domain flow-throughs. 3–4 is enough for a developed wake; 6+ for clean averaged forces. |
| Frames | Number of snapshots written for playback. |
| Playback resolution | Frames are subsampled to about this many cells so playback stays snappy. The **final** frame is also written at full resolution ("Use full-resolution final frame"). |
| Full-res outputs | Vortex surface: Q isosurface level in units of (U/L)². 2 shows the big structures, 5–10 the finer ones (smaller files). Vorticity volume: 1 byte per cell per frame. |
| Advanced: u_lb | Lattice Mach setting. 0.05 default; 0.03 is more accurate but needs 1.7× more steps. |
| Advanced: τ min | Viscosity floor (0.502). Keeps the free stream noise-free; the LES model carries the unresolved Reynolds number. |
| Advanced: LES / Cs | Sub-grid model. Turn off only for laminar (Re < ~1000) cases. |
| Advanced: Sponge | Absorbing layer thickness next to inlet/outlet/lateral walls. |

The estimate box shows Reynolds number, grid, τ, time-step, number of steps and a rough ETA.

## CAD Modeler integration

CAD Modeler (`Documents\CAD Modeler`, **Simulation → CFD Study**) exports a *case folder*: `geometry.stl`
(millimetres, CAD axes, Z up) plus `case.json` (flow direction, speed, fluid, ground, quality, bodies and
their materials). Spec: `CAD Modeler/docs/cfd-exchange.md`. Code: `cfd/cadlink.py`.

```
python main.py --case "<case folder>"              # GUI with the model loaded and the setup pre-filled
python main.py --case "<case folder>" --headless   # no GUI (add --cpu to force NumPy)
```

* mm are converted with `prepare_mesh(..., scale=0.001)`, so the real size is kept; `flow.direction` (the
  free-stream direction in CAD axes) becomes the flow axis, `flow.up` the up axis.
* The quality preset maps to the same cell budgets as the Quality box; an explicit `solver.resolution` wins.
* The window title / Model section show "From CAD Modeler: <design>".
* Runs started from a case write `progress.json` (≤ 1/s) and `results.json` (Cd/Cl/Cs, forces in N,
  reference area/length, run folder, timings; status completed / stopped / diverged / failed) back into the
  case folder, atomically, for both GUI and headless runs. The CAD dialog polls them.
* **CAD Modeler runs this solver itself.** Its Solve button starts `main.py --case <folder> --headless` in the
  background and shows the results in its own viewport. For those runs `cfd/cadviz.py` converts every frame into
  `<case>/viz/`, in CAD millimetres and CAD axes: surface Cp, the Q isosurface, three centre slices and streamlines.
  This costs about 0.2 s per frame. Creating `<case>/stop.request` stops a headless case run gracefully: it still
  writes its results with status "stopped". The file formats are in `CAD Modeler/docs/cfd-exchange.md`.

## Output (`runs/<name>/`)

* `frame_NNNN.npz` – ux, uy, uz (float16, m/s) and p (float32, Pa, gauge) on the playback grid.
* `frame_full.npz` – last state at full resolution.
* `iso_NNNN.npz` – full-resolution Q isosurface (points, triangles, int8 normals, float16 speed).
* `vort_NNNN.npy` – full-resolution |vorticity| as uint8 (0..255 ↔ 0..`vort_scale` in meta.json).
* `forces.csv` – step, time, Fx/Fy/Fz [N], Cd, Cl, Cs (reference area = projected frontal area).
* `mesh.npz`, `solid.npz`, `meta.json` – geometry in simulation coordinates and all run settings.

Disk use: a 37 M-cell run with 80 frames is ≈ 7 GB (about half isosurfaces, half vorticity volumes).
Turn either output off in the setup panel if that matters.

## Getting the "cinematic" vortex look

1. Resolution is everything: the finer the grid, the finer the hairpins. 90–120 cells across a car-sized
   body (35–60 M cells) is where it starts to look like the marketing renders; 6–8 GB of GPU memory.
2. Ground vehicles: ground plane on, moving ground on, clearance = ride height.
3. Duration 3+ flow-throughs so the wake is fully developed before the frames you care about.
4. In the viewer press **Cinematic preset**, then adjust the Q level at run time (setup panel) if you want
   thinner structures; colour by speed with `turbo`.

## Accuracy notes

* Validated on a sphere: Cd = 1.25 at Re 100 with 30 cells across (reference 1.09, and the half-cell
  wall offset accounts for most of the difference). At high Re a 40-cell sphere over-predicts Cd
  (staircase surface, thin boundary layer); resolution is the lever — use as many cells as memory allows.
* Blunt bodies (cars, buildings) are far less sensitive to this than smooth bodies.
* Blockage check (2026-10-27, draft, 3 flow-throughs): cube face-on Cd 1.34 → 1.19 at 110 cells, 1.21 → 1.00 at 60,
  1.43 → 1.35 at 150 (old 1.5 L box → 1 % blockage; Hoerner 1.05). Sphere Re 1.3e5, 110 cells, 6 flow-throughs: 0.52.
  Re 100 sphere (30 cells/D, 3 levels): 1.30 → 1.21 (ref 1.09). **Open:** cube Cd still rises with resolution at fixed
  blockage (1.00 / 1.19 / 1.35 at 60 / 110 / 150 cells). Enlarging the refinement blocks 2× doesn't change it (1.22), so suspect
  the τ-floor / LES regime (grid-resolved Re ∝ resolution).
* results.json carries `blockage`, `Cd_maskell` (Cd / (1 + 2.5 Cd S/C), an extra, not a replacement) and `convergence`
  (last 20 % vs the 20 % before; settled if within 3 %). Spheres need ~6 flow-throughs; 3 gives ±10 % swings.
* Cd/Cl during the first flow-through include the added-mass transient of the inlet ramp; read the
  "mean of last 20 %" number in the force plot.
* Everything is incompressible / low-Mach: keep speed below ~0.3 × speed of sound (100 m/s in air).

## Fidelity roadmap

1. ~~In-place AA streaming + fp16 storage~~ (done: 169 → 39 B/cell).
2. Collision model stable at the true viscosity (recursive / hybrid regularized or cumulant) so the
   τ_min floor can go: today the grid carries a Reynolds number thousands of times below the real one.
3. Surface-hugging sparse refinement (6–8 levels as offsets of the body, not nested boxes).
4. Interpolated (Bouzidi) bounce-back for sub-cell wall placement.
5. Wall model (wall function at the first fluid cell).
