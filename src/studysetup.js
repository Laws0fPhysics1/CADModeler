// Setup ribbons and Study Settings options for the simulation study types that aren't built yet
// (studytypes.js entries without `cmd`). DOM-free. Everything here is a placeholder: the tools are
// under construction and the options aren't saved or used by any solver.
//
// SIM_TOOLS: key -> [label, icon]; main.js registers each as a `soon` command named `sim_<key>`.
// STUDY_SETUP[typeId] = { groups: [{ label, tools: [key...], menu?: [key | "|"...] }], options: [{ title, fields }] }
// Field: { label, type: "number" | "select" | "check" | "text", value, unit?, options?: [value | [value, label]] }

export const SIM_TOOLS = {
  // study
  studyMaterials: ["Study Materials", "physical"], simplify: ["Simplify (remove small features)", "shell"], loadCase: ["New Load Case", "newStudy"],
  // constraints
  fixed: ["Fixed", "simFixed"], pin: ["Pin", "simPin"], frictionless: ["Frictionless", "simFrictionless"], prescribed: ["Prescribed Displacement", "simDisplacement"],
  // structural loads
  force: ["Force", "simForce"], pressure: ["Pressure", "simPressure"], moment: ["Moment", "simMoment"], bearing: ["Bearing Load", "simBearing"],
  remoteForce: ["Remote Force", "simRemote"], gravity: ["Gravity", "simGravity"], pointMass: ["Point Mass", "simMass"], loadSteps: ["Load Steps", "simSteps"],
  // contacts
  autoContacts: ["Automatic Contacts", "simContact"], manualContacts: ["Manual Contacts", "simContact"], contactSettings: ["Contact Settings", "simContact"],
  // events
  eventSettings: ["Event Settings (duration, output steps)", "simSteps"], initialVelocity: ["Initial Velocity", "simVelocity"], rigidWall: ["Rigid Wall / Drop Floor", "simWall"],
  angularVelocity: ["Initial Angular Velocity", "simMoment"], failure: ["Material Failure", "fatigue"],
  // fatigue
  sourceStudy: ["Source Static Stress Study", "stress"], loadCycle: ["Load Cycle", "fatigue"], snCurve: ["S-N Curve", "fatigue"],
  // modal / buckling
  modes: ["Number of Modes", "modal"], prestress: ["Prestress Load", "simForce"],
  // thermal
  appliedTemp: ["Applied Temperature", "thermal"], heatSource: ["Heat Source", "simHeat"], convection: ["Convection", "simConvection"],
  radiation: ["Radiation", "simRadiation"], thermalContact: ["Thermal Contact", "simContact"], refTemp: ["Stress-Free Temperature", "thermal"],
  // electronics cooling
  pcb: ["Board (PCB)", "electronicsCooling"], component: ["Heat-Generating Component", "simChip"], heatSink: ["Heat Sink", "simHeatSink"],
  fan: ["Fan", "simFan"], vent: ["Vent / Opening", "simVent"], enclosure: ["Enclosure (air volume)", "box"], maxTemp: ["Maximum Allowed Temperature", "thermal"],
  // aero loads
  cfdSource: ["Pick CFD Study", "wind"], mapPressure: ["Map Pressure to Faces", "aeroLoads"], loadScale: ["Load Factor", "simForce"],
  // injection molding
  plastic: ["Plastic Material", "physical"], gate: ["Injection Location (gate)", "simGate"], process: ["Process Settings", "injectionMolding"],
  moldTemp: ["Mold Temperature", "thermal"], runner: ["Runners and Sprue", "simGate"],
  // design check
  addCheck: ["Add Check", "designCheck"], targets: ["Targets", "designCheck"], sharedLoads: ["Shared Loads and Constraints", "simForce"], runAll: ["Run All Checks", "simSolve"],
  // internal flow
  fluidVolume: ["Fluid Volume (extract the cavity)", "internalFlow"], capOpenings: ["Cap Openings", "simVent"], fluidMaterial: ["Fluid", "physical"],
  inlet: ["Inlet", "simInlet"], outlet: ["Outlet", "simOutlet"], wallBC: ["Wall (roughness, slip)", "simWall"], porous: ["Porous Region (filter, radiator)", "simVent"],
  fanFace: ["Fan / Pressure Jump Face", "simFan"], pressureDrop: ["Pressure Drop", "simResults"], uniformity: ["Flow Uniformity", "simResults"], cutPlane: ["Cut Plane", "section"], streamlines: ["Streamlines", "wind"],
  // pumps and fans
  rotatingRegion: ["Rotating Region (impeller)", "turbomachinery"], rpm: ["Rotation Speed", "simMoment"], opPoints: ["Operating Points (flow sweep)", "simSteps"],
  performanceCurve: ["Performance Curve (head, efficiency)", "simCompare"], cavitation: ["Cavitation Risk (NPSH)", "simResults"], shaftTorque: ["Shaft Torque and Power", "simMoment"],
  // multibody dynamics
  rigidFlex: ["Rigid / Flexible Bodies", "multibody"], massProps: ["Mass Properties", "simMass"], fromJoints: ["Use Assembly Joints", "joint"], bushing: ["Bushings", "simContact"],
  springDamper: ["Springs and Dampers", "simSpring"], driveContacts: ["Gear / Chain Contacts", "gear"], bodyContacts: ["Body Contacts (collision)", "simContact"],
  motor: ["Motors and Drivers", "drive"], forceMbd: ["Forces and Torques", "simForce"], timeSettings: ["Time Settings", "simSteps"],
  jointForces: ["Joint Reaction Forces", "simResults"], plots: ["Plots (position, velocity, torque)", "simCompare"], exportLoads: ["Peak Loads to Static Stress", "stress"],
  // design exploration / parametric optimization
  designVars: ["Design Variables (any dimension)", "dimension"], varRanges: ["Ranges and Levels", "simSteps"], responses: ["Responses (from studies)", "simResults"],
  constraintsOpt: ["Constraints", "designCheck"], objectives: ["Objectives (minimize / maximize)", "parametricOptimization"], linkStudies: ["Linked Studies", "studies"],
  samplingPlan: ["Sampling Plan", "designExploration"], runDesigns: ["Run Design Set", "simSolve"], searchMethod: ["Search Strategy", "parametricOptimization"],
  budget: ["Evaluation Budget", "simSteps"], runOpt: ["Run Optimization", "simSolve"], designTable: ["Design Table", "setupSheet"], parallelPlot: ["Parallel Coordinates", "simCompare"],
  sensitivity: ["Sensitivity (Pareto chart)", "simCompare"], responseSurface: ["Response Surface", "designExploration"], history: ["Optimization History", "simCompare"],
  paretoFront: ["Pareto Front", "designExploration"], applyBest: ["Apply Best Design", "designCheck"],
  // adjoint
  adjSource: ["Pick Flow or Stress Study", "studies"], adjObjective: ["Objective (drag, lift, pressure drop, stiffness)", "adjointShape"],
  morphRegion: ["Morph Region (faces allowed to move)", "adjointShape"], frozenFaces: ["Frozen Faces", "simFixed"], adjointSolve: ["Solve Adjoint", "simSolve"],
  sensitivityMap: ["Sensitivity Map", "adjointShape"], morphPreview: ["Preview Shape Change", "adjointShape"], morphApply: ["Apply as New Body", "body"], adjointLoop: ["Iterate (gradient loop)", "simSteps"],
  // mesh / solve / results (every study)
  mesh: ["Generate Mesh", "simMesh"], meshSettings: ["Mesh Settings", "simMesh"], localMesh: ["Local Mesh Control", "simMesh"],
  precheck: ["Pre-check", "simPrecheck"], solve: ["Solve", "simSolve"],
  results: ["Results", "simResults"], probe: ["Probe", "measure"], animateResults: ["Animate", "play"], compare: ["Compare", "simCompare"], report: ["Report", "setupSheet"],
};

const STUDY = { label: "STUDY", tools: ["studyMaterials", "simplify"], menu: ["studyMaterials", "simplify", "|", "loadCase"] };
const CONSTRAINTS = { label: "CONSTRAINTS", tools: ["fixed", "pin", "frictionless"], menu: ["fixed", "pin", "frictionless", "prescribed"] };
const LOADS = { label: "LOADS", tools: ["force", "pressure", "moment", "gravity"], menu: ["force", "pressure", "moment", "|", "bearing", "remoteForce", "|", "gravity", "pointMass"] };
const CONTACTS = { label: "CONTACTS", tools: ["autoContacts"], menu: ["autoContacts", "manualContacts", "|", "contactSettings"] };
const MESH = { label: "MESH", tools: ["mesh"], menu: ["mesh", "meshSettings", "localMesh"] };
const SOLVE = { label: "SOLVE", tools: ["precheck", "solve"], menu: ["precheck", "solve"] };
const RESULTS = { label: "RESULTS", tools: ["results", "probe", "report"], menu: ["results", "probe", "animateResults", "|", "compare", "report"] };
const THERMAL_LOADS = { label: "THERMAL LOADS", tools: ["appliedTemp", "heatSource", "convection", "radiation"], menu: ["appliedTemp", "heatSource", "convection", "radiation", "|", "thermalContact"] };

const n = (label, value, unit) => ({ label, type: "number", value, unit });
const sel = (label, options, value) => ({ label, type: "select", options, value: value ?? (Array.isArray(options[0]) ? options[0][0] : options[0]) });
const chk = (label, value = false) => ({ label, type: "check", value });
const MESH_OPTS = { title: "Mesh", fields: [sel("Element size", ["Adaptive", "Coarse", "Medium", "Fine", "Custom"], "Medium"), sel("Element order", ["Parabolic (TET10)", "Linear (TET4)"]), n("Curvature angle", 30, "°")] };
const SOLVE_OPTS = { title: "Solve", fields: [sel("Solver", ["On this computer (GPU)", "On this computer (CPU)"]), chk("Remove rigid body modes", false)] };
const LINEAR_MAT = sel("Material model", ["Linear elastic", "Elastic-plastic", "Hyperelastic"]);

const FLOW_MESH = { title: "Mesh", fields: [sel("Lattice spacing", ["Automatic", "Coarse", "Medium", "Fine", "Custom"], "Automatic"), n("Cells across the smallest opening", 12), n("Maximum cells", 30, "M"), chk("Refine near walls", true)] };
const FLUIDS = ["Air (20 °C)", "Water (20 °C)", "Engine oil (40 °C)", "Coolant (50/50 glycol)", "Custom"];
const DESIGN_VARS = { title: "Design variables", fields: [sel("Source", ["Timeline feature parameters", "Sketch dimensions", "Both"]), n("Variables", 3), sel("Each variable", ["Continuous range", "Discrete levels"])] };
const RESPONSES = { title: "Responses", fields: [chk("Mass", true), chk("Min safety factor (Static Stress)", true), chk("Max displacement", false), chk("First natural frequency (Modal)", false), chk("Drag / lift (CFD)", false), chk("Pressure drop (Internal Flow)", false), chk("Max temperature (Thermal)", false)] };

export const STUDY_SETUP = {
  nonlinearStress: {
    groups: [STUDY, CONSTRAINTS, { ...LOADS, menu: [...LOADS.menu, "|", "loadSteps"] }, CONTACTS, MESH, SOLVE, RESULTS],
    options: [
      { title: "Nonlinear", fields: [chk("Large deformation", true), sel("Material model", ["Elastic-plastic", "Hyperelastic", "Linear elastic"]), n("Load increments", 10), n("Max iterations per increment", 25), n("Convergence tolerance", 0.5, "%")] },
      { title: "Contacts", fields: [sel("Default contact", ["Bonded", "Separation", "Sliding", "Separation + friction"]), n("Friction coefficient", 0.2)] },
      MESH_OPTS, SOLVE_OPTS,
    ],
  },
  fatigue: {
    groups: [{ label: "SOURCE", tools: ["sourceStudy"], menu: ["sourceStudy"] }, { label: "LOADING", tools: ["loadCycle", "snCurve"], menu: ["loadCycle", "snCurve"] }, SOLVE, RESULTS],
    options: [
      { title: "Loading", fields: [sel("Static stress study", ["(pick a Static Stress study)"]), sel("Load type", ["Fully reversed (R = −1)", "Zero-based (R = 0)", "Custom stress ratio"]), n("Stress ratio R", -1), n("Target life", 1e6, "cycles")] },
      { title: "Material", fields: [sel("S-N curve", ["From the physical material", "Estimated from ultimate strength", "Custom table"]), sel("Mean stress correction", ["Goodman", "Gerber", "Soderberg", "None"]), sel("Surface finish", ["Polished", "Machined", "Hot rolled", "As forged"], "Machined"), n("Reliability", 90, "%")] },
    ],
  },
  modal: {
    groups: [STUDY, { ...CONSTRAINTS, tools: ["fixed", "pin", "frictionless"] }, { label: "LOADS", tools: ["pointMass", "prestress"], menu: ["pointMass", "|", "prestress"] }, CONTACTS, MESH, SOLVE, { ...RESULTS, menu: ["results", "animateResults", "|", "compare", "report"] }],
    options: [
      { title: "Modes", fields: [n("Number of modes", 8), n("Lowest frequency", 0, "Hz"), n("Highest frequency", 0, "Hz (0 = no limit)"), chk("Free-free (no constraints)", false), chk("Include prestress", false)] },
      MESH_OPTS, SOLVE_OPTS,
    ],
  },
  buckling: {
    groups: [STUDY, CONSTRAINTS, { ...LOADS, tools: ["force", "pressure", "gravity"] }, CONTACTS, MESH, SOLVE, { ...RESULTS, menu: ["results", "animateResults", "|", "compare", "report"] }],
    options: [
      { title: "Buckling", fields: [n("Number of modes", 4), n("Lowest load multiplier", 0), chk("Include nonlinear prestress", false)] },
      MESH_OPTS, SOLVE_OPTS,
    ],
  },
  quasiStatic: {
    groups: [STUDY, CONSTRAINTS, { ...LOADS, tools: ["force", "pressure", "prescribed"], menu: ["force", "pressure", "prescribed", "|", "gravity"] }, CONTACTS, { label: "EVENT", tools: ["eventSettings"], menu: ["eventSettings", "failure"] }, MESH, SOLVE, RESULTS],
    options: [
      { title: "Event", fields: [n("Event duration", 1, "s"), n("Output steps", 20), chk("Mass scaling", true), LINEAR_MAT] },
      { title: "Contacts", fields: [sel("Default contact", ["Separation + friction", "Bonded", "Sliding"]), n("Friction coefficient", 0.3)] },
      MESH_OPTS,
    ],
  },
  dynamicEvent: {
    groups: [STUDY, CONSTRAINTS, { ...LOADS, tools: ["force", "pressure", "gravity"] }, { label: "INITIAL CONDITIONS", tools: ["initialVelocity", "angularVelocity", "rigidWall"], menu: ["initialVelocity", "angularVelocity", "|", "rigidWall"] }, CONTACTS, { label: "EVENT", tools: ["eventSettings", "failure"], menu: ["eventSettings", "failure"] }, MESH, SOLVE, RESULTS],
    options: [
      { title: "Event", fields: [n("Event duration", 0.005, "s"), n("Output intervals", 40), sel("Scenario", ["General", "Drop test", "Impact into wall"]), n("Drop height", 1000, "mm"), n("Impact velocity", 0, "m/s (0 = from drop height)")] },
      { title: "Material", fields: [LINEAR_MAT, chk("Material failure (element deletion)", false), chk("Mass scaling", false)] },
      { title: "Contacts", fields: [sel("Default contact", ["Separation + friction", "Bonded"]), n("Friction coefficient", 0.3)] },
      MESH_OPTS,
    ],
  },
  thermal: {
    groups: [STUDY, THERMAL_LOADS, CONTACTS, MESH, SOLVE, RESULTS],
    options: [
      { title: "Environment", fields: [n("Ambient temperature", 20, "°C"), n("Default convection coefficient", 10, "W/m²·K"), chk("Include radiation", false), n("Default emissivity", 0.9)] },
      { title: "Solve", fields: [sel("Analysis", ["Steady state"]), n("Convergence tolerance", 0.1, "%")] },
      MESH_OPTS,
    ],
  },
  thermalStress: {
    groups: [STUDY, CONSTRAINTS, { ...LOADS, tools: ["force", "pressure", "gravity"] }, THERMAL_LOADS, CONTACTS, MESH, SOLVE, RESULTS],
    options: [
      { title: "Thermal", fields: [n("Ambient temperature", 20, "°C"), n("Stress-free (reference) temperature", 20, "°C"), n("Default convection coefficient", 10, "W/m²·K"), chk("Include radiation", false)] },
      { title: "Coupling", fields: [sel("Coupling", ["Thermal, then stress (one way)"]), chk("Temperature-dependent material", false)] },
      MESH_OPTS, SOLVE_OPTS,
    ],
  },
  electronicsCooling: {
    groups: [STUDY, { label: "COMPONENTS", tools: ["pcb", "component", "heatSink"], menu: ["pcb", "component", "heatSink", "|", "maxTemp"] }, { label: "COOLING", tools: ["fan", "vent", "enclosure"], menu: ["fan", "vent", "enclosure"] }, MESH, SOLVE, RESULTS],
    options: [
      { title: "Cooling", fields: [sel("Cooling", ["Natural convection", "Forced air (fan)"]), n("Ambient temperature", 25, "°C"), sel("Gravity direction", ["−Z", "+Z", "−Y", "+Y", "−X", "+X"]), n("Altitude", 0, "m"), chk("Include radiation", true)] },
      { title: "Fan", fields: [n("Flow rate", 10, "CFM"), n("Static pressure", 20, "Pa"), sel("Fan curve", ["Constant flow", "From a fan curve table"])] },
      { title: "Limits", fields: [n("Default max component temperature", 85, "°C"), n("Default component power", 1, "W")] },
      { title: "Mesh", fields: [sel("Resolution", ["Coarse", "Medium", "Fine"], "Medium")] },
    ],
  },
  aeroLoads: {
    groups: [{ label: "SOURCE", tools: ["cfdSource", "mapPressure", "loadScale"], menu: ["cfdSource", "mapPressure", "|", "loadScale"] }, CONSTRAINTS, { ...LOADS, tools: ["gravity", "pointMass"], menu: ["gravity", "pointMass"] }, MESH, SOLVE, RESULTS],
    options: [
      { title: "Flow loads", fields: [sel("CFD study", ["(pick a CFD study)"]), sel("Frame", ["Final frame", "Average of the last frames", "Peak drag frame"]), n("Frames to average", 10), chk("Include wall shear", false), n("Load factor", 1.5, "×")] },
      { title: "Structure", fields: [sel("Mesh quality", ["Draft", "Medium", "Fine"], "Medium"), chk("Include gravity", true)] },
    ],
  },
  injectionMolding: {
    groups: [STUDY, { label: "SETUP", tools: ["plastic", "gate", "process"], menu: ["plastic", "|", "gate", "runner", "|", "process", "moldTemp"] }, MESH, SOLVE, { ...RESULTS, menu: ["results", "animateResults", "|", "compare", "report"] }],
    options: [
      { title: "Material", fields: [sel("Plastic", ["ABS", "PC", "PC/ABS", "PP", "HDPE", "Nylon 6", "PA66 30% glass", "POM (acetal)", "PEEK", "TPU"]), n("Melt temperature", 230, "°C"), n("Mold temperature", 60, "°C")] },
      { title: "Process", fields: [sel("Fill control", ["Automatic", "Injection time", "Flow rate"]), n("Injection time", 1.5, "s"), n("Velocity/pressure switch-over", 99, "% filled"), n("Packing pressure", 80, "% of fill pressure"), n("Packing time", 10, "s"), n("Cooling time", 20, "s")] },
      { title: "Gates", fields: [n("Number of gates", 1), sel("Gate type", ["Edge", "Pin point", "Sub (tunnel)", "Fan"])] },
      { title: "Results", fields: [chk("Fill time and confidence", true), chk("Weld lines and air traps", true), chk("Sink marks", true), chk("Warpage", true)] },
    ],
  },
  internalFlow: {
    groups: [STUDY, { label: "FLOW DOMAIN", tools: ["fluidVolume", "capOpenings"], menu: ["fluidVolume", "capOpenings", "|", "fluidMaterial"] },
      { label: "BOUNDARIES", tools: ["inlet", "outlet", "wallBC"], menu: ["inlet", "outlet", "wallBC", "|", "porous", "fanFace"] }, MESH, SOLVE,
      { label: "RESULTS", tools: ["pressureDrop", "uniformity", "streamlines"], menu: ["results", "|", "pressureDrop", "uniformity", "|", "cutPlane", "streamlines", "probe", "|", "report"] }],
    options: [
      { title: "Fluid", fields: [sel("Fluid", FLUIDS), n("Temperature", 20, "°C"), chk("Compressible (Mach > 0.3)", false), chk("Heat transfer with the walls", false)] },
      { title: "Inlet", fields: [sel("Specify", ["Velocity", "Mass flow rate", "Volume flow rate", "Total pressure"]), n("Value", 10, "m/s"), n("Turbulence intensity", 5, "%")] },
      { title: "Outlet", fields: [sel("Specify", ["Static pressure", "Mass flow split", "Open to atmosphere"]), n("Gauge pressure", 0, "Pa"), chk("Allow backflow", false)] },
      { title: "Physics", fields: [sel("Turbulence", ["LES (Smagorinsky, GPU lattice)", "RANS k-ω SST (planned)", "Laminar"]), sel("Run", ["Until the pressure drop settles", "Fixed time"])] },
      FLOW_MESH,
      { title: "Results", fields: [chk("Pressure drop inlet → outlet", true), chk("Flow split between outlets", true), chk("Outlet uniformity index", true), chk("Swirl angle", false), chk("Wall shear", false)] },
    ],
  },
  turbomachinery: {
    groups: [STUDY, { label: "FLOW DOMAIN", tools: ["fluidVolume", "rotatingRegion"], menu: ["fluidVolume", "capOpenings", "|", "rotatingRegion", "|", "fluidMaterial"] },
      { label: "BOUNDARIES", tools: ["inlet", "outlet", "wallBC"], menu: ["inlet", "outlet", "wallBC"] },
      { label: "OPERATING POINT", tools: ["rpm", "opPoints"], menu: ["rpm", "opPoints"] }, MESH, SOLVE,
      { label: "RESULTS", tools: ["performanceCurve", "cavitation", "shaftTorque"], menu: ["results", "|", "performanceCurve", "cavitation", "shaftTorque", "|", "streamlines", "cutPlane", "|", "report"] }],
    options: [
      { title: "Machine", fields: [sel("Type", ["Centrifugal pump", "Axial pump", "Centrifugal fan / blower", "Axial fan", "Propeller (open)"]), n("Rotation speed", 2900, "rpm"), sel("Rotation", ["Counterclockwise about the axis", "Clockwise about the axis"]), n("Blades", 6)] },
      { title: "Rotor model", fields: [sel("Model", ["Frozen rotor (rotating frame, steady)", "Moving blades (transient)", "Rotating immersed boundary (GPU lattice)"]), n("Revolutions to average", 3)] },
      { title: "Fluid", fields: [sel("Fluid", FLUIDS, "Water (20 °C)"), n("Vapor pressure (cavitation)", 2339, "Pa")] },
      { title: "Operating points", fields: [n("Flow rate from", 2, "L/s"), n("to", 20, "L/s"), n("Points on the curve", 6)] },
      FLOW_MESH,
      { title: "Results", fields: [chk("Head / pressure rise", true), chk("Hydraulic efficiency", true), chk("Shaft torque and power", true), chk("NPSH required", false), chk("Blade surface pressure", false)] },
    ],
  },
  multibody: {
    groups: [{ label: "BODIES", tools: ["rigidFlex", "massProps"], menu: ["rigidFlex", "massProps"] },
      { label: "CONNECTIONS", tools: ["fromJoints", "springDamper", "bodyContacts"], menu: ["fromJoints", "bushing", "springDamper", "|", "driveContacts", "bodyContacts"] },
      { label: "LOADS AND DRIVERS", tools: ["motor", "forceMbd", "gravity"], menu: ["motor", "forceMbd", "gravity"] },
      { label: "SOLVE", tools: ["timeSettings", "solve"], menu: ["timeSettings", "precheck", "solve"] },
      { label: "RESULTS", tools: ["animateResults", "jointForces", "plots"], menu: ["animateResults", "|", "jointForces", "plots", "|", "exportLoads", "report"] }],
    options: [
      { title: "Analysis", fields: [sel("Type", ["Dynamic (time history)", "Kinematic (motion only)", "Static equilibrium", "Linearized modes"]), n("End time", 2, "s"), n("Output steps", 200), sel("Integrator", ["Implicit HHT-α (stiff, contacts)", "BDF (variable step)", "Explicit (impacts)"])] },
      { title: "Bodies", fields: [sel("Bodies", ["All rigid", "Pick flexible bodies (modal reduction from FEA)"]), sel("Mass from", ["Physical material", "Override per body"])] },
      { title: "Contacts", fields: [sel("Detection", ["Off", "Picked pairs", "All bodies (broad phase)"]), n("Friction coefficient", 0.2), n("Restitution", 0.3), n("Contact stiffness", 1e5, "N/mm")] },
      { title: "Gravity", fields: [chk("Gravity", true), sel("Direction", ["-Z", "-Y", "-X"]), n("Magnitude", 9.81, "m/s²")] },
      { title: "Results", fields: [chk("Joint reaction forces", true), chk("Motor torque and power", true), chk("Body positions, velocities, accelerations", true), chk("Contact forces", false), chk("Hand peak loads to Static Stress", false)] },
    ],
  },
  designExploration: {
    groups: [{ label: "VARIABLES", tools: ["designVars", "varRanges"], menu: ["designVars", "varRanges"] },
      { label: "STUDIES", tools: ["linkStudies", "responses"], menu: ["linkStudies", "responses", "constraintsOpt"] },
      { label: "RUN", tools: ["samplingPlan", "runDesigns"], menu: ["samplingPlan", "runDesigns"] },
      { label: "RESULTS", tools: ["designTable", "parallelPlot", "sensitivity", "responseSurface"], menu: ["designTable", "parallelPlot", "sensitivity", "responseSurface", "|", "report"] }],
    options: [
      DESIGN_VARS,
      { title: "Sampling plan", fields: [sel("Method", ["Latin hypercube", "Full factorial", "Sobol sequence", "Box-Behnken", "Central composite"]), n("Designs", 30), n("Random seed", 1)] },
      RESPONSES,
      { title: "Run", fields: [n("Designs at once", 2), chk("Reuse the mesh when the topology doesn't change", true), chk("Keep designs that fail to rebuild", false)] },
    ],
  },
  parametricOptimization: {
    groups: [{ label: "VARIABLES", tools: ["designVars", "varRanges"], menu: ["designVars", "varRanges"] },
      { label: "GOALS", tools: ["objectives", "constraintsOpt"], menu: ["objectives", "constraintsOpt", "|", "linkStudies"] },
      { label: "SEARCH", tools: ["searchMethod", "budget", "runOpt"], menu: ["searchMethod", "budget", "|", "runOpt"] },
      { label: "RESULTS", tools: ["history", "paretoFront", "applyBest"], menu: ["history", "paretoFront", "designTable", "|", "applyBest", "report"] }],
    options: [
      DESIGN_VARS,
      { title: "Objectives", fields: [sel("Objective 1", ["Minimize mass", "Maximize min safety factor", "Minimize displacement", "Maximize first frequency", "Minimize drag", "Minimize pressure drop", "Minimize max temperature"]), sel("Objective 2", ["None", "Minimize mass", "Maximize min safety factor", "Minimize drag", "Minimize pressure drop"])] },
      { title: "Constraints", fields: [n("Min safety factor ≥", 2), n("Max displacement ≤", 1, "mm"), n("First frequency ≥", 0, "Hz"), n("Mass ≤", 0, "g")] },
      { title: "Search", fields: [sel("Strategy", ["Adaptive hybrid (several searches, adapts as it learns)", "Genetic (NSGA-II, Pareto)", "Gradient (SQP; adjoint gradients where available)", "Surrogate (Kriging response surface)", "Simulated annealing"]), n("Evaluations", 100), n("At once", 2)] },
      { title: "Robustness", fields: [chk("Check the best design for tolerance spread", false), n("Variable tolerance", 1, "%"), n("Samples", 20)] },
    ],
  },
  adjointShape: {
    groups: [{ label: "SOURCE", tools: ["adjSource"], menu: ["adjSource"] },
      { label: "GOAL", tools: ["adjObjective", "morphRegion", "frozenFaces"], menu: ["adjObjective", "|", "morphRegion", "frozenFaces"] },
      { label: "SENSITIVITY", tools: ["adjointSolve", "sensitivityMap"], menu: ["adjointSolve", "sensitivityMap"] },
      { label: "MORPH", tools: ["morphPreview", "morphApply", "adjointLoop"], menu: ["morphPreview", "morphApply", "|", "adjointLoop"] }],
    options: [
      { title: "Physics", fields: [sel("Source study", ["Flow: CFD (3D Flow) or Internal Flow", "Structure: Static Stress"])] },
      { title: "Objective", fields: [sel("Flow", ["Drag force", "Lift force", "Lift / drag", "Pressure drop", "Outlet uniformity", "Swirl"]), sel("Structure", ["Compliance (stiffness)", "Max von Mises stress", "Displacement at a point"]), sel("Direction", ["Minimize", "Maximize"])] },
      { title: "Morphing", fields: [n("Max surface movement", 2, "mm"), n("Smoothing", 5, "mm"), chk("Keep symmetry", false), chk("Keep volume", false)] },
      { title: "Loop", fields: [n("Iterations", 5), n("Step size", 25, "% of max movement"), n("Stop below improvement", 0.5, "%")] },
    ],
  },
  designCheck: {
    groups: [{ label: "CHECKS", tools: ["addCheck", "targets"], menu: ["addCheck", "targets"] }, { label: "SETUP", tools: ["studyMaterials", "sharedLoads"], menu: ["studyMaterials", "sharedLoads"] }, CONSTRAINTS, LOADS, { label: "RUN", tools: ["runAll"], menu: ["precheck", "runAll"] }, { label: "REPORT", tools: ["report", "compare"], menu: ["results", "report", "compare"] }],
    options: [
      { title: "Checks and targets", fields: [chk("Static stress: min safety factor", true), n("Safety factor ≥", 2), chk("Modal: first natural frequency", true), n("Frequency ≥", 100, "Hz"), chk("Buckling: load multiplier", false), n("Multiplier ≥", 3), chk("Thermal: max temperature", false), n("Temperature ≤", 85, "°C"), chk("CFD: drag", false), n("Drag ≤", 0, "N"), chk("Injection molding: fills with confidence", false), chk("Fatigue: life", false), n("Life ≥", 1e6, "cycles")] },
      { title: "Run", fields: [sel("Mesh quality for all checks", ["Draft", "Medium", "Fine"], "Medium"), chk("Stop at the first failed check", false)] },
    ],
  },
};
