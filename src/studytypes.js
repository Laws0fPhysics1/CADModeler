// Simulation study types: the one catalog behind the SIMULATE ribbon tab and the New Study gallery.
// DOM-free. `cmd` names an existing COMMANDS entry that opens a working study; entries without one
// are under construction (main.js turns them into `soon` placeholder commands).

export const STUDY_CATEGORIES = [
  { id: "structural", label: "Structural" },
  { id: "thermal", label: "Thermal" },
  { id: "fluids", label: "Fluids" },
  { id: "manufacturing", label: "Manufacturing" },
  { id: "motion", label: "Motion" },
  { id: "optimize", label: "Optimize" },
  { id: "combined", label: "Combined" },
];

export const STUDY_TYPES = [
  // structural
  { id: "fea", cmd: "fea", cat: "structural", label: "Static Stress", icon: "stress",
    desc: "Deformation and stress in the model from structural loads and constraints. Linear material, small deformations." },
  { id: "modal", cat: "structural", label: "Modal Frequencies", icon: "modal",
    desc: "The model's natural frequencies and mode shapes, free or constrained." },
  { id: "buckling", cat: "structural", label: "Structural Buckling", icon: "buckling",
    desc: "Buckling modes of the model and the load multiplier at which each one occurs." },
  { id: "nonlinearStress", cat: "structural", label: "Nonlinear Static Stress", icon: "nonlinear",
    desc: "Static stress and deformation with nonlinear material properties and large deformations." },
  { id: "fatigue", cat: "structural", label: "Fatigue", icon: "fatigue", added: true,
    desc: "Life in cycles under a repeating load, from a static stress result and the material's S-N curve." },
  { id: "quasiStatic", cat: "structural", label: "Quasi-Static Event", icon: "quasiStatic",
    desc: "Slow, large-motion events (snap fits engaging, clips, presses) in a single part or several bodies, with contact and nonlinear material where needed." },
  { id: "dynamicEvent", cat: "structural", label: "Dynamic Event", icon: "dynamicEvent",
    desc: "Response to rapidly changing, time-dependent loads and constraints: large deformations, initial velocities, contact and impact (drop tests)." },
  // thermal
  { id: "thermal", cat: "thermal", label: "Thermal", icon: "thermal",
    desc: "Steady-state temperatures from heat loads and thermal boundary conditions (temperature, convection, radiation)." },
  { id: "thermalStress", cat: "thermal", label: "Thermal Stress", icon: "thermalStress",
    desc: "Temperatures, then the stress and deformation they cause together with structural loads." },
  { id: "electronicsCooling", cat: "thermal", label: "Electronics Cooling", icon: "electronicsCooling",
    desc: "Whether electronic components stay under their maximum allowed temperature with natural convection or a fan." },
  // fluids
  { id: "cfd", cmd: "cfd", cat: "fluids", label: "CFD (3D Flow)", icon: "wind",
    desc: "External flow around the bodies on the GPU: drag, lift, surface pressure, streamlines and vortices." },
  { id: "flow2d", cmd: "flow2d", cat: "fluids", label: "2D Flow", icon: "flow2d",
    desc: "Quick 2D flow around a sketch section or airfoil: lift, drag and the flow field, live." },
  { id: "aeroLoads", cat: "fluids", label: "Aero Loads to Stress", icon: "aeroLoads", added: true,
    desc: "Map the surface pressure from a CFD study onto a Static Stress study, so the part is checked under its real air loads." },
  { id: "internalFlow", cat: "fluids", label: "Internal Flow", icon: "internalFlow", added: true,
    desc: "Flow through the inside of a part: ducts, intakes, manifolds, nozzles, valves. Extracts the fluid volume, then gives pressure drop, flow split and outlet uniformity." },
  { id: "turbomachinery", cat: "fluids", label: "Pumps and Fans", icon: "turbomachinery", added: true,
    desc: "Rotating machinery: an impeller or fan in its housing at a set speed. Head, pressure rise, torque, efficiency and the performance curve over a range of flow rates." },
  // motion
  { id: "multibody", cat: "motion", label: "Multibody Dynamics", icon: "multibody", added: true,
    desc: "An assembly with many moving parts over time: its joints, motors, springs, contacts and gravity. Positions, joint reaction forces and motor torques, and the peak loads handed to Static Stress." },
  // manufacturing
  { id: "injectionMolding", cat: "manufacturing", label: "Injection Molding", icon: "injectionMolding",
    desc: "How well the part fills and whether it will have quality issues (short shots, weld lines, sink, warp) for a material, process settings and gate location." },
  // optimize
  { id: "topo", cmd: "topo", cat: "optimize", label: "Shape Optimization", icon: "topo",
    desc: "Generative design: removes material the loads don't need, down to a target safety factor." },
  { id: "designExploration", cat: "optimize", label: "Design Exploration", icon: "designExploration", added: true,
    desc: "Sweep any dimensions of the design through a sampling plan, run the linked studies on every variant, and see which parameters drive mass, stress, drag or temperature." },
  { id: "parametricOptimization", cat: "optimize", label: "Parametric Optimization", icon: "parametricOptimization", added: true,
    desc: "Searches the design's own dimensions for the best design: minimize or maximize responses from the linked studies under constraints, with an adaptive hybrid search." },
  { id: "adjointShape", cat: "optimize", label: "Adjoint Shape Optimization", icon: "adjointShape", added: true,
    desc: "From one flow or stress solve, the sensitivity of drag, lift, pressure drop or stiffness to moving every point of the surface; then morphs the shape to improve it." },
  // combined
  { id: "designCheck", cat: "combined", label: "Design Check", icon: "designCheck", added: true,
    desc: "One study that runs every check you pick on the same part, loads and material (stress, frequencies, buckling, temperature, drag, molding) and gives a pass / fail report against your targets." },
];

export const studyType = (id) => STUDY_TYPES.find((t) => t.id === id);
export const studiesIn = (cat) => STUDY_TYPES.filter((t) => t.cat === cat);
