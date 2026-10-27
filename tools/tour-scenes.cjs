// Feature tour scenes for tools/feature-tour.cjs. Each `run` executes inside the app page (it's sent as
// source text), after `helpers` has set up window.T. A scene with `doc` starts from that design (written
// to the tour's own localStorage and reloaded); without one it carries on from the previous scene.
const path = require("node:path");
const os = require("node:os");

const EMPTY = (name) => ({ name, features: [], marker: 0, counters: {}, hidden: [], appearances: {}, studies: [], assembly: { components: [], joints: [], links: [] } });
const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const DOCS = path.join(os.homedir(), "Documents");

// a constrained plate sketch: 90 x 56 rectangle on the origin, two equal Ø16 holes (one dimensioned)
const plateSketch = () => {
  const P = { O: { x: 0, y: 0, fixed: true, origin: true }, pb: { x: 90, y: 0 }, pc: { x: 90, y: 56 }, pd: { x: 0, y: 56 }, h1: { x: 22, y: 28 }, h2: { x: 68, y: 28 } };
  const L = (id, a, b) => ({ id, type: "line", p1: a, p2: b });
  return {
    id: "fsk1", type: "sketch", name: "Sketch1", plane: XY, planeRef: { kind: "origin", name: "XY" }, points: P,
    entities: [L("l1", "O", "pb"), L("l2", "pb", "pc"), L("l3", "pc", "pd"), L("l4", "pd", "O"), { id: "c1", type: "circle", c: "h1", r: 8 }, { id: "c2", type: "circle", c: "h2", r: 8 }],
    constraints: [
      { id: "k1", type: "horizontal", e: ["l1"] }, { id: "k2", type: "horizontal", e: ["l3"] }, { id: "k3", type: "vertical", e: ["l2"] }, { id: "k4", type: "vertical", e: ["l4"] },
      { id: "k5", type: "dim", kind: "distance", p: ["O", "pb"], orient: "h", pos: [45, -12], value: 90 },
      { id: "k6", type: "dim", kind: "distance", p: ["pb", "pc"], orient: "v", pos: [102, 28], value: 56 },
      { id: "k7", type: "dim", kind: "diameter", e: ["c1"], pos: [34, 42], value: 16 },
      { id: "k8", type: "equal", e: ["c1", "c2"] },
      { id: "k9", type: "dim", kind: "distance", p: ["O", "h1"], orient: "h", pos: [11, 62], value: 22 },
    ],
  };
};

function helpers() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const K = () => import("/src/kernel.js");
  window.T = {
    sleep,
    async ok(wait = 700) { const b = document.querySelector("#dialog .btn.primary"); if (b) b.click(); await sleep(wait); },
    async cancel() {
      if (__app.cmd) { const b = [...document.querySelectorAll("#dialog .btn")].find((x) => x.textContent === "Cancel"); if (b) b.click(); else __app.cmd = null; }
      // floating panels (appearance, studies…) close with their header ×
      for (const x of document.querySelectorAll(".panel:not(#browser):not(#dialog) .dlg-head button.x")) if (x.offsetParent) x.click();
      await sleep(300);
    },
    rims(cx, cy, r, z) { return T.edges((e) => e.type === "CIRCLE" && Math.abs(e.mid[2] - z) < 0.01 && Math.abs(Math.hypot(e.mid[0] - cx, e.mid[1] - cy) - r) < 0.5); },
    /** Start a feature dialog with the current selection (consumed by its first pick field) and optional field values. */
    async feature(type, values = {}) {
      __feature(type); await sleep(200);
      for (const [k, v] of Object.entries(values)) {
        const inp = __app.cmd.fieldInputs && __app.cmd.fieldInputs[k];
        if (inp) { inp.value = String(v); inp.dispatchEvent(new Event("input")); } else __app.cmd.values[k] = v;
      }
      await sleep(400);
    },
    body(i = 0) { return __app.state.bodies[i]; },
    async edges(filter, i = 0) { const k = await K(); const b = T.body(i); return b.shape.edges.map((e, idx) => ({ idx, body: b.id, ...k.edgeInfo(b.shape, idx) })).filter(filter); },
    async faces(filter, i = 0) { const k = await K(); const b = T.body(i); return b.shape.faces.map((f, idx) => ({ idx, body: b.id, ...k.faceInfo(b.shape, idx) })).filter(filter); },
    dblTimeline(title) { const el = [...document.querySelectorAll("#timeline .tl-item")].find((e) => e.title === title || e.title.startsWith(title)); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); },
    key(k) { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); },
    // home = fit at the default 3/4 angle in one move (isoView + fit would fight: fit keeps the old angles)
    view() { __vp.home(); },
    async select(sel, value) { const s = typeof sel === "string" ? document.querySelector(sel) : sel; s.value = value; s.dispatchEvent(new Event("change")); await sleep(300); },
    async type(sel, text) { const i = typeof sel === "string" ? document.querySelector(sel) : sel; i.value = text; i.dispatchEvent(new Event("input")); await sleep(300); },
  };
}

const scenes = [
  {
    id: "sketch", title: "Constrained sketching",
    blurb: "Sketches on planes or faces with lines, rectangles, circles, arcs and polygons, driven by a constraint solver. Sketch Dimension (D) infers lengths, distances, angles, diameters and radii; constraint glyphs are selectable, fully constrained geometry turns black, and the Sketch Palette shows the remaining degrees of freedom.",
    doc: { ...EMPTY("Plate"), features: [plateSketch()], marker: 1, counters: { sketch: 1 } },
    async run() { T.dblTimeline("Sketch1"); await T.sleep(1500); },
  },
  {
    id: "extrude", title: "Extrude with live preview",
    blurb: "Extrude, Revolve and Press Pull pick sketch profiles or planar faces. One side, symmetric or two sides; Join, Cut, Intersect or New Body. The preview updates live, with a drag arrow and an in-canvas value box.",
    async run() {
      __run("finish"); await T.sleep(800);
      const sk = __app.state.sketches.fsk1;
      const outer = sk.profiles.map((p, idx) => ({ idx, a: p.area })).sort((a, b) => b.a - a.a)[0];
      __app.selection = [{ kind: "profile", sketch: "fsk1", idx: outer.idx }];
      await T.feature("extrude", { distance: 12 });
      T.view("iso"); await T.sleep(900);
    },
  },
  {
    id: "fillet", title: "Fillet, chamfer and shell",
    blurb: "Fillet, Chamfer and Shell work on the real B-rep (OpenCascade), with live previews. Every feature lands on the parametric timeline: double-click to edit, drag the marker to roll back, and failed features turn red with the reason.",
    async run() {
      await T.ok(900);
      const vert = await T.edges((e) => e.type === "LINE" && Math.abs(e.length - 12) < 1e-6);
      __app.selection = vert.map((e) => ({ kind: "edge", body: e.body, idx: e.idx }));
      await T.feature("fillet", { radius: 10 });
      await T.ok(1200);
      const top = await T.edges((e) => Math.abs(e.mid[2] - 12) < 1e-6 && e.type === "CIRCLE");
      __app.selection = top.map((e) => ({ kind: "edge", body: e.body, idx: e.idx }));
      await T.feature("chamfer", { distance: 1.5 });
      T.view("iso"); await T.sleep(900);
    },
  },
  {
    id: "fasteners", title: "ISO fasteners with modeled threads",
    blurb: "M2–M24 and UNC bolts, cap screws, button and countersunk heads, set screws, threaded rod, nuts and washers. Click a hole rim and the part seats in it, sized automatically; threads are real helical geometry or cosmetic.",
    async run() {
      await T.ok(1200);
      // (the chamfer made each top hole rim a ring of edges: pick the outer one, 8 + 1.5 mm out)
      const pick = async (cx, z, kind, length) => {
        const rims = (await T.rims(cx, 28, 8, z)).concat(await T.rims(cx, 28, 9.5, z));
        if (!rims.length) return;
        __app.selection = [{ kind: "edge", body: rims[0].body, idx: rims[0].idx }];
        __feature("fastener"); await T.sleep(200);
        __app.cmd.values.kind = kind; __app.cmd.values.size = "M16"; if (length) __app.cmd.values.length = length;
        await T.ok(2500);
      };
      await pick(22, 12, "socketCap", 30);
      await pick(22, 0, "hexNut");
      await pick(68, 12, "hexBolt", 35);
      __app.selection = [];
      T.view("iso"); await T.sleep(1200);
    },
  },
  {
    id: "appearance", title: "Materials and appearance",
    blurb: "21 engineering materials with render settings and real physical properties (density, Young's modulus, yield strength, thermal data) used by the simulations. Any colour on any material with a polished, satin or matte finish; studio lighting, ground shadow and ambient occlusion.",
    async run() { __app.selection = [{ kind: "body", body: T.body(0).id }]; __run("appearance"); await T.sleep(1200); },
  },
  {
    id: "measure", title: "Measure",
    blurb: "INSPECT → Measure (I): face areas, edge lengths and the minimum distance between any two faces or edges.",
    async run() {
      await T.cancel(); await T.sleep(300);
      const f = await T.faces((x) => x.type === "PLANE" && Math.abs(Math.abs(x.normal[2]) - 1) < 1e-6);
      __app.selection = f.slice(0, 2).map((x) => ({ kind: "face", body: x.body, idx: x.idx }));
      __run("measure"); await T.sleep(800);
    },
  },
  {
    id: "search", title: "Command search and shortcuts",
    blurb: "Press S anywhere to search every command by name; single-key shortcuts (E extrude, Q press pull, F fillet, J joint, K shop stock, G gears…) work as in Fusion.",
    async run() { await T.cancel(); T.key("s"); await T.sleep(300); const i = document.querySelector(".search input"); i.value = "gea"; i.dispatchEvent(new Event("input")); await T.sleep(500); },
  },
  {
    id: "marking-menu", title: "Right-click marking menu",
    blurb: "Right-click in the canvas for Fusion's radial marking menu: repeat the last command, press pull, sketch, extrude, fillet, undo / redo, plus an overflow menu.",
    async run() { T.key("Escape"); await T.sleep(200); const r = document.querySelector("#view").getBoundingClientRect(); __markingMenu({ clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.45 }); await T.sleep(500); },
  },
  {
    id: "export", title: "Import and export",
    blurb: "Import STEP, STL and OBJ (meshes become real solids) by menu or drag-and-drop. Export STEP, STL, OBJ, GLB (with materials) or the design file.",
    async run() { T.key("Escape"); await T.sleep(200); __run("exportCmd"); await T.sleep(700); },
  },
  {
    id: "stock", title: "Shop Stock library",
    blurb: "About 440 things you buy rather than design: T-slot extrusion, pipe, tube, angle and channel, bar and plate, bearings, shafts, steppers and servos, and all the fasteners. Search, pick a size and length, place it on a face or in a hole; it arrives with the right material.",
    doc: EMPTY("Stock"),
    async run() { __run("stock"); await T.sleep(1500); T.view("iso"); await T.sleep(800); },
  },
  {
    id: "gear-wizard", title: "Gear Wizard",
    blurb: "Involute spur, helical, internal ring and rack gears: pairs, trains, ring + pinion, rack + pinion, planetary sets, or a new gear meshed onto one already in the design. Teeth are phased so meshing gears never overlap; the panel shows diameters, centre distances, contact ratio, ratio and output speed.",
    doc: EMPTY("Gearbox"),
    async run() {
      __run("gear"); await T.sleep(600);
      await T.select(document.querySelector(".gw select"), "planetary");
      await T.sleep(1500); T.view("iso"); await T.sleep(1000);
    },
  },
  {
    id: "gears-drive", title: "Gears that move: joints and motion links",
    blurb: "With “Make it move”, each gear gets a component and an axle joint on a Gear Frame, and meshing gears are tied by motion links. Drive Joints turns the sun and the planets, carrier and ring follow; links show up in the browser and export to URDF as mimic joints.",
    async run() {
      await T.ok(2500);
      // add a pair beside the planetary set, meshed onto it with a third gear
      __run("gear"); await T.sleep(500);
      await T.select(document.querySelector(".gw select"), "train");
      const tr = [...document.querySelectorAll(".gw input")].find((i) => i.value.includes(","));
      if (tr) await T.type(tr, "24, 12, 30");
      const cx = [...document.querySelectorAll(".gw .dlg-row")].find((r) => r.textContent.startsWith("Centre X"));
      if (cx) await T.type(cx.querySelector("input"), "130");
      await T.ok(3000);
      const a = __asm.state();
      const sunJ = a.joints.find((j) => /^18T axle/.test(j.name)) || a.joints[1];
      __asm.drive(sunJ.id); await T.sleep(500);
      const sl = document.querySelector("#dialog input[type=range]");
      if (sl) { sl.value = "40"; sl.dispatchEvent(new Event("input")); }
      T.view("iso"); await T.sleep(1200);
    },
  },
  {
    id: "motion-link", title: "Motion Link",
    blurb: "ASSEMBLY workspace → MOTION → Motion Link ties any two moving joints by tooth counts or a ratio, including rotation driving a slider (rack and pinion). Links chain into trains and are checked for loops.",
    async run() { await T.ok(800); __asm.motionLink(); await T.sleep(700); },
  },
  {
    id: "robot-export", title: "Robot export for Isaac Sim / Isaac Lab",
    blurb: "Turns the assembly into a robot package: robot.usda (UsdPhysics articulation) and robot.urdf with meshes, mass and inertia from the exact geometry and materials, drives, limits and gear mimic joints.",
    async run() { await T.cancel(); await T.sleep(300); __run("robotExport"); await T.sleep(900); },
  },
  {
    id: "chains-belts", title: "Sprockets, roller chain, pulleys and timing belts",
    blurb: "Chain drive and belt drive modes in the Gear Wizard: ANSI / ISO / bicycle roller chain on real sprocket tooth forms, GT2 / HTD timing belts on grooved pulleys. The centre distance is solved so the chain is a whole number of links (or the belt whole teeth); chaining onto a wheel that already carries a chain adds a twin sprocket on its shaft. Driving a sprocket carries the chain and belt round with it.",
    doc: EMPTY("Drives"),
    async run() {
      const wiz = async (spec, partner) => {
        __run("gear"); await T.sleep(400);
        await T.select(document.querySelector(".gw select"), spec.mode);
        if (partner) { __app.cmd.values.partner = [partner]; __app.cmd.def.onPreview(__app.cmd); await T.sleep(200); }
        Object.assign(__app.cmd.values.spec, spec); await T.ok(3000);
      };
      await wiz({ mode: "chain", teeth1: 15, teeth2: 30, chain: "40", centerDist: 250, bore: 10 });
      await wiz({ mode: "mesh", teeth1: 12, centerDist: 180, dir: 60 }, { kind: "face", body: "Body2", idx: 0 });
      await wiz({ mode: "belt", teeth1: 20, teeth2: 40, belt: "GT2", centerDist: 140, v: -150 });
      __asm.setJointValue("j1", 17, null, true); __asm.setJointValue("j4", 23, null, true);
      __asm.drive("j1"); await T.sleep(500);
      T.view(); await T.sleep(1200);
    },
  },
  {
    id: "airfoil", title: "NACA airfoil sketches",
    blurb: "CREATE → NACA Airfoil: 4- and 5-digit sections from a code, chord and angle of attack, as a sketch on any plane or added to the open sketch, with a live preview and the section's thickness and camber.",
    doc: EMPTY("Wing"),
    async run() { __run("airfoil"); await T.sleep(400); const i = document.querySelector("#dialog input"); await T.type(i, "4415"); },
  },
  {
    id: "flow2d", title: "2D Flow (GPU lattice Boltzmann)",
    blurb: "A quick 2D CFD of any closed sketch on the GPU: speed, vorticity or pressure with streamlines, live lift and drag coefficients and forces per metre of span, and an inviscid panel-method lift alongside.",
    async run() {
      await T.ok(1200);
      __flow2d.open(); await T.sleep(1500);
      const api = __flow2d.current(); api.setRunning(false);
      const row = [...document.querySelectorAll(".f2-side .dlg-row")].find((r) => r.textContent.startsWith("Angle of attack"));
      const inp = row.querySelector("input"); inp.value = "6"; inp.dispatchEvent(new Event("change")); await T.sleep(500);
      api.setRunning(false);
      const s = api.state.sim;
      while (s.passes < 9) { s.step(400, { sampleEvery: 20 }); await T.sleep(1); }
      api.setRunning(true); await T.sleep(700); api.setRunning(false);
      await T.sleep(300);
    },
  },
  {
    id: "cfd", title: "3D CFD inside the app",
    blurb: "SIMULATION workspace → CFD Study runs the GPU CFD Sim solver in the background and draws the results in the viewport: surface pressure, vortex surfaces, streamlines, slices, legends and a frame player, with drag, lift and side force.",
    doc: {
      ...EMPTY("Block in wind"), features: [{ id: "fb", type: "box", name: "Box1", length: 50, width: 50, height: 20, operation: "new" }], marker: 1, counters: { box: 1 },
      studies: [{ id: "st1", name: "Airflow 1 · 20 m/s", casePath: path.join(DOCS, "CAD-CFD Exchange", "Untitled_20261007-210014"), folderName: "Untitled_20261007-210014", settings: {}, bodies: ["Body1"], createdAt: "2026-10-08T04:00:14.449Z", status: "stopped", results: { Cd: 1.0355, Cl: 1.2838 } }],
    },
    async run() { __showStudy("st1"); await T.sleep(6000); T.view("iso"); await T.sleep(2500); },
  },
  {
    id: "fea", title: "Static stress (FEA) inside the app",
    blurb: "SIMULATION workspace → Static Stress: pick fixed faces and load faces, forces or pressure and gravity; FEA Sim meshes the exact geometry into quadratic tetrahedra and solves on the GPU. Results: deformed shape, safety factor, von Mises, displacement and principal stresses with min / max probes.",
    doc: null, // set by the runner from the user's FEA design (read-only copy)
    async run() { __showStudy("fmuznixfs1"); await T.sleep(6000); T.view("iso"); await T.sleep(2500); },
  },
  {
    id: "topo", title: "Shape Optimization (generative design)",
    blurb: "Pick the faces that hold a part and the faces that carry loads, then ask for the lightest part that meets a safety factor (or a target mass). The body is voxelised and material is shaved away live over a ghost of the original; Create Body puts the result in the timeline.",
    doc: { ...EMPTY("Bracket blank"), features: [{ id: "fb", type: "box", name: "Box1", length: 120, width: 30, height: 40, operation: "new" }], marker: 1, counters: { box: 1 } },
    async run() {
      __topo.open(); await T.sleep(400);
      const api = __topo.current(), st = api.state;
      st.fixtures = [{ body: st.bodyId, idx: 0 }];
      st.loads[0].faces = [{ body: st.bodyId, idx: 1 }]; st.loads[0].direction = "-Z"; st.loads[0].magnitude = 5000;
      const rs = [...document.querySelectorAll(".topo-dlg select")].find((x) => [...x.options].some((o) => o.value === "coarse"));
      rs.value = "coarse"; rs.dispatchEvent(new Event("change"));
      api.run();
      for (let i = 0; i < 240 && st.running; i++) await T.sleep(1000);
      T.view("iso"); await T.sleep(1200);
    },
  },
  {
    id: "under-construction", title: "Under-construction tape",
    blurb: "Every control that's there for the Fusion look but isn't built yet carries black-and-yellow tape: toolbar icons, menu items, the other tabs, and the Data Panel, notifications, comments and viewports buttons.",
    doc: EMPTY("Untitled"),
    async run() { const l = [...document.querySelectorAll(".tb-label")].find((e) => e.textContent.startsWith("CREATE")); l.click(); await T.sleep(500); },
  },
  {
    id: "bug-report", title: "Bug reports",
    blurb: "The Bug report button saves your memo with the last five minutes of clicks and keys, a screenshot, the design and the app state into bug-reports/, ready for the next session to pick up.",
    async run() { T.key("Escape"); await T.sleep(200); document.querySelector("#btnBug").click(); await T.sleep(800); },
  },
  {
    id: "dark-theme", title: "Dark theme",
    blurb: "Light and dark themes (Settings cog or Display Settings), perspective / orthographic / perspective-with-ortho-faces cameras, ViewCube, and shaded / shaded-with-edges / wireframe styles.",
    doc: null, // the runner reuses the gears design here
    theme: "dark",
    async run() { T.view("iso"); await T.sleep(1500); },
  },
];

module.exports = { scenes, helpers, EMPTY };
