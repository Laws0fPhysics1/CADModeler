# Simulation roadmap: internal flow, multibody dynamics, design exploration

Status 2026-10-08: **all three are under construction.** Each has a study type in `src/studytypes.js`,
a setup preview (ribbon + Study Settings) in `src/studysetup.js`, and a taped button in the Simulation
workspace (FLUIDS > INTERNAL FLOW, MOTION > MULTIBODY, OPTIMIZE > DESIGN EXPLORATION / ADJOINT) and in
the Assembly workspace (MOTION > STUDY > Multibody Dynamics). Nothing is solved yet. This file says
where each one is going, what it reuses, and the order to build it in.

## What they share (build this first)

1. **Design variables.** Any numeric field of a timeline feature (`doc.features[i][key]`) or a sketch
   dimension constraint value, addressed as `{ featureId, key }` / `{ sketchId, constraintId }`.
   `K.evaluate(features)` is DOM-free and runs in Node, so a variant is "copy the feature list, set
   the values, evaluate". That's the core of design exploration and of any optimisation loop.
2. **Headless study runner.** CFD Sim and FEA Sim already run headless on a case folder
   (`main.py --case <dir> --headless`, results in `results.json`). A queue that runs N case folders
   (N at once, GPU-aware: one CFD at a time, several FEA) is needed by every study here.
3. **Responses.** Read from `results.json` (FEA: max von Mises, min safety factor, max displacement;
   CFD: Cd, Cl, forces) plus kernel values (mass from `K.bodyInfo` volume × material density).
4. **Study records.** New `doc.studies` kinds: `"internalFlow"`, `"mbd"`, `"explore"`, `"optimize"`,
   `"adjoint"`, keeping the `settings` / `results` / `status` shape the FEA and CFD studies use, plus
   the `bodySig` signature (`main.js bodySignature`) so results show as out of date after an edit.

## 1. Internal flow: ducts, intakes, manifolds, pumps, fans

**Where:** Simulation > FLUIDS > INTERNAL FLOW (Internal Flow, Pumps and Fans).

**Solver:** CFD Sim's GPU lattice Boltzmann (LBM). Today it does external flow: the body sits in a
wind-tunnel box. Internal flow needs:

- **Fluid volume.** The user caps the openings (pick each opening's boundary loop; OCCT makes a
  planar face, as Patch would) and the fluid domain is the enclosed cavity. Voxelise the cavity
  (inside test against the capped shell) instead of the body. The cap faces become the inlet and
  outlet patches.
- **Boundary conditions on the lattice.** Velocity / mass-flow inlets (regularised or Zou-He),
  pressure outlets, bounce-back walls (already there), porous zones (Darcy-Forchheimer body force),
  fan faces as a pressure jump.
- **Results:** pressure drop inlet to outlet, mass flow per outlet, outlet uniformity index
  γ = 1 − Σ|u − ū|A / (2ūA), swirl, wall shear, plus the existing viz (slices, streamlines,
  surface pressure) in `cfdresults.js`.
- **Exchange:** the same case folder with `case.json` `"mode": "internal"`, `boundaries:
  [{ faceRef, type, value }]` and the fluid volume as an STL. Spec goes in `docs/cfd-exchange.md`.

**Pumps and fans.** A rotating region around the impeller:

- *Frozen rotor (steady):* Coriolis and centrifugal body forces in a cylindrical zone (Guo forcing
  in LBM). Cheap, and good for the performance curve.
- *Moving blades (transient):* the impeller rotates through the lattice as a moving bounce-back
  boundary. LBM handles this naturally on the GPU; it gives the true unsteady flow and torque ripple.
- *Performance curve:* sweep the operating points (outlet pressure or flow rate). Head
  H = Δp_total / ρg, efficiency η = ρgQH / (Tω). Cavitation risk: minimum pressure vs vapour pressure.

**Honest limits.** LBM is low-Mach (fine for ducts, intakes, pumps; not compressor stages). Re is
grid-limited, as in 2D Flow: a 50 mm duct at 10 m/s is Re ≈ 33 000, which needs LES with a wall
model and enough cells across the duct. The setup will show the cells-across-the-opening count and
warn when it's too coarse.

**Validation, in order:** Poiseuille pipe (Δp exact), 90° bend loss coefficient against published
K values, backward-facing step reattachment length, then a centrifugal pump against affinity laws
and a published benchmark (the ERCOFTAC centrifugal pump).

**Order:** fluid volume + caps → inlet/outlet BCs in CFD Sim → pressure drop / uniformity results →
porous / fan faces → frozen rotor → moving blades + performance curve.

## 2. Multibody dynamics (Ansys Motion-style)

**Where:** Simulation > MOTION > Multibody Dynamics, also Assembly > MOTION > STUDY.

**Inputs that already exist:** `assembly.js` components, joints (revolute, slider, cylindrical,
planar, ball, rigid), limits, motion links (gear ratios, chains via `drivemotion.js`); materials with
density (`materials.js`); mass properties from OCCT GProp (as `robotexport.js` does for URDF/USD).

**Solver plan:**

- **In-app (first):** a JS solver in a worker for quick runs. Rigid bodies in maximal coordinates
  with joint constraints (index-3 DAE with stabilisation), implicit HHT-α integration, motion links
  as linear velocity constraints, so closed loops (four-bars, chains) work. Drivers: joint
  position/velocity profiles and motors with torque limits. Springs, dampers and bushings as force
  elements.
- **Contacts:** a BVH on the display meshes for the broad phase, mesh penetration and a penalty
  force for the narrow phase (with friction μ and restitution). This also finally gives the
  assembly workspace its missing collision detection.
- **Heavy cases (later):** the same exchange-folder pattern as CFD/FEA, with
  [Project Chrono](https://projectchrono.org) (BSD, PyChrono) as the Python back end. It's mature
  for multibody, contact, and flexible bodies. The URDF/USD export already gives Isaac Sim as a
  third route for robots.
- **Flexible bodies:** Craig-Bampton modal reduction from FEA Sim (needs the Modal study first).

**Outputs:** time histories (position, velocity, acceleration), joint reaction forces, motor torque
and power, contact forces, an animation that reuses the assembly drive, and **peak loads to Static
Stress** (the instant of max reaction force becomes a load case on the part).

**Validation:** simple pendulum period, slider-crank against the closed form, four-bar coupler
curve, a dropped block's rest height and bounce against restitution.

**Order:** kinematics (drive the joints over time, plots) → rigid dynamics with gravity, springs and
motors → reaction forces + peak loads to Static Stress → contacts → Chrono back end → flexible bodies.

## 3. Design exploration, optimisation (HEEDS-style) and adjoint

**Where:** Simulation > OPTIMIZE > DESIGN EXPLORATION (Design Exploration, Parametric
Optimization) and ADJOINT (Adjoint Shape Optimization). Shape Optimization (topology, `topo*.js`)
stays as the generative tool.

**Design exploration (DOE).** Pick design variables and ranges, a sampling plan (Latin hypercube,
Sobol, full factorial, Box-Behnken), linked studies and responses. Every design is a feature list
plus a case folder per linked study, run by the shared runner. Results: design table, parallel
coordinates, sensitivity (Pareto chart of effects), and a response surface (Kriging / RBF) you can
drag through.

**Parametric optimisation.** The same variables and studies, with objectives and constraints. The
search is a hybrid like HEEDS SHERPA: several strategies run together (NSGA-II for Pareto fronts,
CMA-ES / Nelder-Mead locally, surrogate-assisted expected improvement) and the budget moves to
whichever is improving. Gradient (SQP) is used where adjoint gradients exist. "Apply Best Design"
writes the variables back into the timeline (one undo step).

**Adjoint shape optimisation.** One extra solve gives d(objective)/d(surface normal movement) at
every surface point:

- **Structure first:** compliance is self-adjoint, so the sensitivity comes straight from the
  static solution (−uᵀ ∂K/∂x u, in FEA Sim next to its existing SIMP sensitivities). Stress
  objectives need a real adjoint load case.
- **Flow later:** adjoint lattice Boltzmann is published (continuous / discrete adjoint LBM, as in
  TCLB) but it's a real project. Until then the flow objectives use finite differences on morph
  parameters through Design Exploration.
- **Morphing:** the sensitivity map drives a smoothed surface displacement (RBF / Laplacian), capped
  at the max movement, with frozen faces fixed. The result is a mesh body, as Shape Optimization's
  is (there's no B-rep reconstruction), with "Apply as New Body" plus a gradient loop that repeats.

**Order:** design variables + runner + DOE on mass and static stress → parametric optimisation →
structural adjoint sensitivity map → morph + loop → flow objectives (finite differences, then an
adjoint LBM).
