# FEA Sim

Linear static stress analysis for **CAD Modeler** studies. CAD Modeler writes a case folder
(`cadmodeler-fea-case` v1: `case.json` plus the exact B-rep as `geometry.step`), this program meshes
it into quadratic tetrahedra, solves, and writes progress, results and viewport data back into the
same folder. CAD runs it headless as a child process (`electron/fea-runner.cjs`), the same way it runs
CFD Sim. Spec of the folder: `CAD Modeler/docs/fea-exchange.md`.

```
pip install -r requirements.txt        # numpy, scipy, gmsh (+ optional cupy-cuda12x)
python main.py --case "<case folder>" --headless [--cpu] [--quality coarse|medium|fine|finest]
python tests/validate.py [--quick]      # validation suite (exit code 0 = all checks pass)
```

There is no GUI yet; `--headless` is accepted for symmetry with CFD Sim and is the only mode.

## How it works

| Step | Code | Notes |
|---|---|---|
| Case I/O | `fea/caseio.py` | `load_case`, `validate` (same rules as `validateCase()` in `src/fealink.js`), atomic JSON/binary writes (`<name>.<pid>.tmp` then `os.replace`), `Reporter` (progress.json, results.json, `stop.request`) |
| Meshing | `fea/mesher.py` | gmsh OCC imports the STEP (target unit mm). Several solids are **fragmented** so touching bodies share nodes (bonded contact). Element size `h = min(f_L · largest extent, f_t · 2V/A)` (2V/A = characteristic thickness, so thin parts still get several elements through the thickness) plus curvature refinement (`Mesh.MeshSizeFromCurvature`, 8 to 20 elements per 2π) for holes and fillets. HXT 3D mesher, second order with mid-nodes on the true geometry. Each surface records centre of mass, normal, area and closest point. |
| Elements | `fea/elements.py` | TET10, 4-point Gauss stiffness (exact for straight-sided elements; an 11-point Keast rule is available), consistent body forces, TRI6 consistent surface loads (6-point rule, works on curved faces), nodal strains, von Mises, principal stresses |
| Assembly / solve | `fea/solver.py` | Vectorised NumPy element stiffness in chunks of 15 k elements, scattered into SciPy CSR. Fixed DOFs eliminated. ≤ 45 k equations: SuperLU (`splu`, MMD_AT_PLUS_A). Larger: block-Jacobi (3×3 nodal blocks) preconditioned CG on the GPU with CuPy (RTX 3080, float64), falling back to the same PCG on the CPU. Relative residual 1e-8. |
| Run | `fea/run.py` | face matching, loads, fixtures, solve, reactions `R = K u − f`, nodal-averaged stresses, safety factor, `viz/` export, results.json |

Units inside the solver: mm, N, MPa, tonne/mm³, mm/s². Inputs come in SI (Pa, kg/m³, m/s²) from `case.json` and are converted.

### Boundary conditions and loads
* **Fixed** faces: every node of the face (corners and mid-sides) fixed in x, y, z.
* **Force** on faces: total force vector (N) spread as a uniform traction over the summed area of all the load's faces, converted into consistent nodal loads.
* **Pressure** on faces (Pa): normal traction, positive pushes into the material. The normal is the element's own outward normal at each quadrature point (curved faces are handled).
* **Gravity**: `ρ g` body force from each body's material density.
* Several bodies in one case are **bonded** at shared faces (gmsh fragment), each with its own material. CAD Modeler's dialog currently analyses one body per study.

### Face identification
CAD refers to faces by index in replicad's `shape.faces` order plus a centre point (`pt`, the face's centre of mass), a normal `n` at that point and its area. Each reference is matched to the gmsh surface (among the surfaces bounding that body's volumes) with the smallest `distance(centre) / extent + 0.05 (1 − |n·n'|) [planar faces] + 0.05 · relative area difference`, the B-rep order being only a tie-breaker. In the end-to-end test (`CAD Modeler/tests/fealink.test.mjs`, a replicad-exported beam with a hole) every CAD face matched at distance < 1e-3 mm and gmsh kept replicad's order (surface tag = idx + 1). The matching for every face of the body is written to `results.json → faceMap`, and each fixture / load lists its matches with the distance.

### Outputs
* `results.json`: status, `maxVonMises_MPa`, `maxDisplacement_mm`, `minSafetyFactor`, max/min principal, their locations, per-fixture `reactions` (force N), `reactionTotal_N` vs `appliedTotal_N` and the relative `equilibriumError`, materials, mass, node / element / DOF counts, mesh info, solver info (method, backend, iterations, residual), timings, warnings.
* **Safety factor** = yield strength / von Mises at each node (the yield of the weakest material touching the node). Materials without a yield strength (glass, rubber, CFRP) use the ultimate strength and say so; if neither exists the safety factor is not available.
* `viz/`: the boundary of the TET10 mesh as linear triangles (each TRI6 split into 4), per-vertex displacement, von Mises, safety factor, principal stresses, plus min/max markers. Layouts in `docs/fea-exchange.md`.

Stresses are averaged at nodes, so the maximum von Mises sits at the clamp corners where the theoretical stress is singular (the fixed face also blocks Poisson contraction); it grows slowly with refinement there. Judge stresses a little away from fixtures.

## Validation (`python tests/validate.py`, 2026-10-08, RTX 3080)

**(a) Cantilever** 200 × 20 × 10 mm steel (E = 200 GPa, ν = 0.3), root face fixed, 100 N tip load (−Z) on the end face.
Euler-Bernoulli PL³/3EI = 0.80000 mm (with the Timoshenko shear term 0.80156 mm); Mc/I = 60 MPa at the root.

* Medium mesh (7,244 nodes, 3,802 TET10): tip deflection **0.79562 mm (−0.55 % vs PL³/3EI)**.
* Bending stress σxx vs M(x)c/I: at x = 50 mm **45.01 / −44.99 MPa vs 45.00**; at x = 100 mm **30.02 / −29.97 MPa vs 30.00** (top / bottom fibre, < 0.1 %).
* Max von Mises 60.0 MPa at the root (Mc/I = 60 MPa; the clamp corners add a local concentration).
* Reaction 100.000000 N, equilibrium error ~1e-10; safety factor = 250 / max von Mises exactly.

**(b) Bar in tension** 100 × 10 × 10 mm, 10 kN on the end face, other end fixed:
σxx in the middle 40 % = **100.000 MPa** (F/A = 100 MPa), spread < 0.001 %, other components < 1e-4 MPa; strain between x = 30 and 70 mm 4.99999e-4 (F/AE = 5e-4). Reaction = −F.

**(c) Mesh convergence** (cantilever):

| quality | h (mm) | nodes | TET10 | tip defl. (mm) | vs EB | vs Timoshenko | σxx x=100 top (MPa) | max vM (MPa) | solver | solve (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| coarse | 6.45 | 2,248 | 1,017 | 0.79471 | −0.66 % | −0.85 % | 29.98 | 60.4 | direct SuperLU | 0.39 |
| medium | 3.87 | 7,244 | 3,802 | 0.79562 | −0.55 % | −0.74 % | 30.02 | 60.0 | direct SuperLU | 0.40 |
| fine | 2.58 | 20,226 | 11,653 | 0.79588 | −0.52 % | −0.71 % | 29.99 | 59.0 | PCG, GPU | 5.5 |
| finest | 1.81 | 51,293 | 31,645 | 0.79607 | −0.49 % | −0.69 % | 30.00 | 63.5 | PCG, GPU | 4.1 |

The converged 3D answer sits about 0.5 % below Euler-Bernoulli because the fully fixed root also stops the Poisson contraction (stiffer than a beam's ideal clamp); the beam-theory stress is matched to < 0.1 % away from the root. The max von Mises column shows the clamp-corner singularity. (gmsh's parallel mesher is not bit-for-bit deterministic, so node counts vary by ~1 % between runs.)

**(d) Other loads:** 1 MPa pressure on a 100 × 40 plate: reactions sum to 4000.0000 N (p·A), the two end reactions match within 0.02 %. Gravity on the cantilever: reaction 3.07929 N = m g exactly, tip deflection 0.009163 mm vs qL⁴/8EI = 0.009238 (−0.8 %). A force spread over two faces is reacted in full and the faces map to two surfaces.

**(e)** `main.py --case --headless` exits 0 and writes `results.json`, `progress.json` and consistent `viz/` binaries in CAD mm.

Also checked by hand: two bonded boxes (steel 100 mm + aluminium 100 mm) as one cantilever: tip deflection 0.9826 mm vs 0.9857 mm from beam theory with the two moduli (−0.3 %); `stop.request` during a CPU solve ends the run in about a second with `status: "stopped"` in both JSON files.

**Solver timing:** SuperLU is fastest up to ~45 k equations (41 k: 1.8 s), but its fill-in explodes beyond that (76 k equations: 220 s), hence the switch to GPU PCG (60 k equations ≈ 3,500 iterations ≈ 4 s; 150 k ≈ 4,700 iterations ≈ 4 s). The first GPU solve in a process adds ~0.5 s of CUDA start-up.

## Roadmap
1. **Better iterative solver**: algebraic multigrid (pyamg / AmgX) or a CUDA sparse Cholesky so meshes of 1 M+ equations solve in seconds; adaptive refinement at stress hot spots.
2. **More boundary conditions**: frictionless (normal-only) and pin (cylindrical) supports, prescribed displacement, remote force / moment, bolt preload, bearing loads.
3. **Contact and assemblies**: separation / sliding contact between bodies (augmented Lagrangian), bolted joints, the assembly's joints as constraints; today touching bodies are bonded only.
4. **Modal analysis** (natural frequencies: generalized eigenproblem K φ = ω² M φ with the consistent TET10 mass matrix, LOBPCG/shift-invert), **thermal** (steady conduction, then thermal stress with `thermal_expansion_1_K` from materials.js), **buckling**.
5. **Nonlinear analysis**: large deflection (total Lagrangian), plasticity (J2 with the yield strength), hyperelastic rubbers.
6. **CFD pressure as loads** (one-way FSI): map CFD Sim's surface Cp (`viz/surf_NNNN.bin`, already in CAD mm) onto the FEA surface as a pressure load.
7. A small PySide6 viewer for case folders, like CFD Sim's GUI.
