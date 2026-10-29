# CAD Modeler

A single-part parametric 3D modeler that looks and feels like Fusion 360. It runs in the browser, with Three.js for the viewport and OpenCascade (via replicad, compiled to WASM) as a real B-rep kernel.

## Getting the app (for friends)

1. Install [Git for Windows](https://git-scm.com/download/win) and [Node.js LTS](https://nodejs.org/) (defaults are fine).
2. Clone the repo: `git clone https://github.com/Laws0fPhysics1/CADModeler.git "CAD Modeler"` (or just run `Get CAD Modeler.bat`)
3. Double-click **`Update CAD Modeler.bat`** in the cloned folder. It pulls the latest version, installs dependencies, builds and launches the app. Run it again any time to update.
4. You don't have to remember to check: the start screen says when an update is out ("Update available") and its **Update now** button closes the app and runs `Update CAD Modeler.bat` for you.

Saved designs go in the `Parts` folder inside the app folder (created on first use). Your Parts folder and design files never leave your PC.

**Simulations (optional).** CFD and FEA studies run Python code that ships with the app (in `sims\`). To turn them on, install [Python 3.12](https://www.python.org/downloads/) (3.10 to 3.13 also work) and tick **"Add python.exe to PATH"** on the installer's first screen, then run `Update CAD Modeler.bat` again. It builds a private Python environment in `sims\.venv` and installs the packages there; it tells you at the end whether CFD and FEA are ready.
- The first update with Python downloads about 500 MB (PySide6, VTK, gmsh, SciPy), plus about 1.7 GB more for CuPy and its CUDA libraries on a PC with an NVIDIA card. That is 1.6 GB on disk, or 3.9 GB with CuPy, and about 5 minutes on fast internet (longer on slow). Later updates only reinstall when the requirements change.
- **FEA (static stress)** works on any PC. **CFD** inside the app needs an NVIDIA graphics card (CUDA 12 driver); without one, the CFD study won't run.
- Without Python everything else in CAD Modeler works as normal.
- Keep the app folder path short (the default `Documents\CAD Modeler` is fine): PySide6 nests files about 150 characters deep, and Windows refuses paths over 260 characters unless long paths are enabled. The update warns you if the path is too long.

**Found a bug?** Use the **Bug report** (or Feature request) button inside the app, then double-click **`Send Bug Reports.bat`**. It uploads your reports (memo, recent clicks/keys, screenshot) to the `bugs` branch of your own fork, where the owner collects them. Your design file is not included. One-time setup: a free GitHub account and one click on **Fork** (the script opens the page and walks you through it); no collaborator access is needed. The repo is public, so the reports you send are public too.

## Run

CAD Modeler is a desktop app built with Electron. Double-click **`Start CAD Modeler.bat`**: it installs dependencies if they're missing, rebuilds when the source has changed, and opens the app window. No browser and no web server are involved.

```
npm start              # same as the .bat, with logs in the console
npm run desktop:dev    # hot-reloading dev mode (Vite + Electron)
npm run smoke          # headless start-up + IPC self-test
npm run package        # Windows installer + portable exe (see docs/desktop.md)
npm run dev            # browser-only dev server at http://localhost:5180
```

See `docs/desktop.md` for details. The desktop app keeps its own autosave, separate from the browser version; use File → Save/Open to move designs between them.

Tests: `node tests/<name>.test.mjs` for kernel, solver, io, cfdlink, materials, bugreport, fasteners, assembly, stock, fealink

## What works

- **Fusion-style UI:** app bar, DESIGN workspace, SOLID tab with CREATE / MODIFY / CONSTRUCT / INSPECT groups and dropdowns, Browser tree with visibility eyes, ViewCube, navigation bar, parametric timeline, right-click marking menu, and `S` command search.
- **Sketching:** create sketches on the XY/XZ/YZ planes, on planar faces (face edges are auto-projected), or on offset planes. Tools: Line (chained), 2-point and center Rectangle, Center Diameter / 2-Point / 3-Point Circle, 3-Point and Center Point Arc (the sweep follows the mouse round, past 180° too; type R / angle), Polygon, Sketch Dimension (edits a length, diameter, or radius), and the construction toggle. Snapping to endpoints, midpoints, centers, and the origin, with horizontal/vertical inference. Type values while drawing; Tab moves between fields and locks them, Enter commits. Drag points and lines with the select tool. Closed loops are split into Fusion-style regions (profiles).
- **Features:** Extrude (one side, symmetric, two sides; Join, Cut, Intersect, New Body, or auto-cut when dragged into the body; drag arrow plus in-canvas value box), Press Pull (like Fusion: body faces → Offset Face, edges → Fillet, else Extrude), **Offset Face** (MODIFY: push / pull any faces, flat or curved, by a distance; + adds material), Revolve (around an origin axis or a sketch line), Fillet, Chamfer, Shell (each with a drag arrow: on the first edge along the corner's bisector, its tip on the new surface, or on the first removed face pointing in), Box, Cylinder, Sphere, Offset Plane, Fastener, and Remove body.
- **Fasteners** (CREATE → Fastener, or INSERT → Fastener): ISO metric M2 to M24 hex bolts, socket head cap screws, button head screws, countersunk screws, pan head screws, set screws, threaded rod, hex nuts and flat washers.
  - Click a hole's rim, or its wall, and the part seats in the hole. Size "Auto" picks the largest standard size that fits, and the head goes on the side you clicked. A planar face places the part at the face centre; with nothing picked it stands on the XY plane.
  - Direction flips it and Offset moves it along its axis, so you can stack a washer, then a nut, under a plate.
  - Threads are **Modeled** (real right-hand ISO helical threads, about 1 s to build) or **Cosmetic** (a plain cylinder, instant). The live preview always shows plain shanks; OK builds the real threads. Each part is its own body, named like "M6 × 20 Socket Cap Screw".
  - Imperial UNC sizes #4-40, #6-32, #8-32, #10-24, 1/4-20, 5/16-18 and 3/8-16 are in the Size list too (pick them by hand; Auto only fits metric sizes).
- **Shop Stock** (INSERT → Shop Stock, CREATE → Shop Stock, shortcut K, or search "stock"): a library of about 440 things you buy rather than design, each with real nominal dimensions and a default material:
  - **T-slot extrusion:** metric 2020, 2040, 2060, 3030, 3060, 4040, 4080 (Misumi-style) and 80/20 inch 1010, 1020, 1030, 1515, 1530, 1545, 3030, with the slot opening, T-cavity, cored pockets and centre bore.
  - **Pipe & conduit:** NPS 1/8" to 4" Schedule 40 and 80 in steel and PVC, and EMT conduit 1/2" to 2".
  - **Tube:** round (inch, metric, carbon fibre) and square/rectangular tube with corner radii (1" × 1" × 1/16", 25 × 25 × 2, 40 × 20 × 2…).
  - **Structural shapes, bar and plate:** equal and unequal angle, C-channel, flat bar, round, square and hex bar, aluminium plate (inch and metric), steel sheet by gauge, polycarbonate and acrylic sheet.
  - **Hardware:** every fastener above, metric and inch (inserted as a Fastener feature).
  - **Robotics:** ball bearings (623 to 6205, including 608), precision shafts, D-shafts, 3/8" and 1/2" hex shaft, NEMA 17 and 23 steppers (body length option) and standard and micro (SG90) servos, as envelope models.

  Type in the search box ("m4 bolt", "1/2 pipe", "1530"), or browse by category, then pick a size, length and (optionally) a material. The part previews live. Like a fastener, it goes on a picked planar face (at its centre, along the normal), into a hole (pick the rim or the wall), or at the origin. **Direction** flips it or, with no position, lays it along X or Y on the ground. **Offset** moves it along its axis and **Rotation** spins it about its axis. OK adds a Stock feature to the timeline (double-click to edit). Each part becomes its own body named like "1530 T-slot × 500 mm" and gets its material (6061 aluminium for extrusions, steel for pipe…), so mass and appearance are right straight away. Change it later with Appearance; your choice then sticks.
- **Timeline:** double-click a feature to edit it with live preview; right-click to delete, suppress, or roll back; drag the marker to roll history back. Features that fail turn red with the reason.
- **Constraints and dimensions:** sketches are driven by a constraint solver. The **Sketch Dimension** tool (D) works out what you mean from what you click:
  - a line gives its length (horizontal, vertical or aligned, depending on where you place it)
  - two points give a distance
  - a point and a line give a perpendicular distance
  - two lines give an angle, or the distance between them if they're parallel
  - a circle gives its diameter, an arc its radius

  Place the dimension, type a value and the geometry follows. Double-click a dimension to change it. Dimensions that would over-constrain the sketch are added as driven (reference) dimensions.
- **Dimension names and expressions:** every sketch dimension has a name (d1, d2, …). An edit box takes math (`+ - * / ^`, brackets, `pi`, `sqrt`, `sin`/`cos`/`tan` in degrees, `asin`/`acos`/`atan`/`atan2`, `abs`, `round`, `floor`, `ceil`, `min`, `max`, `pow`, `hypot`, `exp`, `ln`, `log`), units (`13 in`, `1in + 3mm`) and other dimensions by name (`d1 / 2`). While the box is open the dimensions show their names and clicking one inserts its name. A dimension typed with names stays linked (`ƒx:` on its label, the expression on hover) and follows the ones it uses. Math works in every other value box too.
- **Offset** (sketch MODIFY > Offset, or O in a sketch): click a curve; everything joined end to end with it is offset together (a circle alone). Move to a side and click, or type a distance + Enter (negative flips the side). Lines stay parallel, arcs concentric, corners meet (or are rounded where they can't). One offset dimension drives the whole offset.
- **Constraint tools:** Coincident, Horizontal/Vertical, Parallel, Perpendicular, Collinear, Equal, Tangent, Concentric, Midpoint, Fix.
- **Auto-constraints while drawing:** snapping to a point makes it coincident, horizontal/vertical inference adds H/V constraints, rectangles get H/V on their sides, polygons get equal sides, and typing a size while drawing creates a driving dimension.
- **Snap to Model:** drawing tools snap to body vertices, edge midpoints and hole centres seen through the sketch plane (purple glyph; the point is fixed there). Toggle in the Sketch Palette.
- **Constraint feedback:** constraint glyphs are shown and are selectable/deletable. Fully constrained geometry turns black, and the Sketch Palette shows the remaining degrees of freedom.
- **Bug report** (top right): attaches the last 5 minutes of clicks and keys, a screenshot, the design, and app state to a memo. Reports are saved under `bug-reports/<time>_<memo>/` while running through the dev server (or downloaded as a `.json` file otherwise).
- **Import / Export:** File → Import (Ctrl+I), the INSERT group, or drag a file onto the window. Imports STEP, STL and OBJ as timeline features (a CAD Modeler design file is inserted as a hybrid, see the Parts panel; File → Open opens one). Mesh files are converted to solid bodies, so booleans and fillets work on them, and you pick their units. File → Export (Ctrl+E) writes STEP, STL (binary or ASCII, three refinement levels), OBJ, GLB (keeps materials and colours) or the design file.
- **Materials and appearance** (MODIFY → Appearance, shortcut A; or Physical Material): 21 engineering materials (aluminium, steels, titanium, brass, ABS, PLA, nylon, rubber, glass, carbon fibre, oak…), each with render settings and real physical properties (density, Young's modulus, yield strength, thermal properties) for future simulations. Any colour can go on any material ("Red Aluminum", "Orange ABS") along with a polished/satin/matte finish. Rendering uses procedural studio lighting, a soft ground shadow and ambient occlusion, all toggled under Display Settings.
- **Start page** (also the loading screen): a wing slides across three sections of the screen (a sketch, then a solid, then an aero study with streamlines) above a launcher: **Continue** the last design, start a new **Design** or **Assembly**, **Open** a design file, **Import CAD**, jump to the **Simulation** or **CAM** workspace (Drawing is under construction), or pick an open design under Recent. Esc continues. Untick *Show at startup* to skip it; **File → Start Page** brings it back.
- **Parts folder:** designs are saved to the `Parts` folder next to the app by default (`CAD Modeler\Parts` here; an installed copy that can't write beside its exe uses `Documents\CAD Modeler Parts`; `partsDir` in the app's config.json overrides). Save As and Open start there, and each save into it stores a thumbnail (`Parts\.thumbs`).
- **Parts panel** (rail on the left edge of the viewport): the **Parts** bin shows every design in the Parts folder with its thumbnail (double-click opens it, ⟳ refreshes, the folder button opens it in Explorer), then your other open designs, recent parts, Shop Stock favourites and McMaster-Carr, with search. **Drag a saved design (a Parts card or an open design) onto the viewport to insert it** into the current design; dragging a `.cadm.json` file from Explorer onto the window does the same. Dragging Shop Stock / McMaster cards is still under construction.
- **Hybrid designs:** a design that contains inserted designs is a **hybrid**, the third type next to part and assembly (the tab icon and the browser show the type). An inserted design is one timeline feature (undo, delete, suppress and roll back work as usual); its bodies keep their appearances and land at the origin. It's a copy taken when you insert it: later edits to the original don't flow in yet. You can't insert a design into itself, or a design that already contains the one you're in (that would be a loop); a message says why.
- **Copy / paste:** right-click a body or sketch in the Browser, a feature in the timeline, or a body in the viewport > Copy (or Ctrl+C). Paste (Ctrl+V or the same menus): a sketch lands on the selected plane / planar face (else on its own plane); bodies open Move/Copy with Create Copy on and the gizmo up. Right-clicking a body also offers **Move/Copy** (translate / rotate gizmo), Appearance and Hide.
- **Design tabs:** double-click a tab's name to rename the design in place (Enter or click away keeps it, Esc cancels).
- **ViewCube presets**: hovering the cube highlights the face, edge or corner under the mouse (its name shows as a tooltip); click it and the camera turns to that view: corners give the eight isometric views. Right-click → **Preset Views** lists all 26.
- **Workspaces** (cube dropdown at the top left; each remembers its last tab):
  - **DESIGN**: tabs **SOLID** (modelling, assembly, insert; the Fastener and Gear wizards live in INSERT, and CREATE has **Tap and Die**, under construction), **SURFACE**, **SHEET METAL**, **PLASTIC** (Snap Fit and Lip first, then Web and Rib), **RENDER** and **ANIMATE**. While sketching, the SKETCH tab is added; clicking another tab shows its tools, and running one finishes the sketch first.
  - **ASSEMBLY**: tabs ASSEMBLE (components, insert parts, joints, move, measure), MOTION (drive joints, motion links; motion study, contact sets and exploded view are under construction) and EXPORT (robot URDF / USD, files). As-built joint, joint origin, rigid group and interference are under construction.
  - **SIMULATION**: tabs STUDIES / STRUCTURAL / THERMAL / FLUIDS / MANUFACTURING / OPTIMIZE, every tool shown directly. **New Study** opens a gallery of every study type. Working today: Static Stress, CFD, 2D Flow, Shape Optimization. Under construction: Modal Frequencies, Structural Buckling, Nonlinear Static Stress, Fatigue, Quasi-Static Event, Dynamic Event, Thermal, Thermal Stress, Electronics Cooling, Aero Loads to Stress, Injection Molding and Design Check. Each of those still opens as a preview with its own setup tab (constraints, loads, contacts, mesh, solve, results, as fits the study) and a Study Settings panel; the tools do nothing, the settings aren't saved, nothing is solved, and FINISH STUDY closes it. STUDIES → Results lists the design's studies.
  - **CAM** (under construction): tabs MILLING / TURNING / ADDITIVE / CUTTING / PROBING.
- **Settings** (cog, top right): theme, visual style, grid, camera projection, home view, lighting, ground shadow, ambient occlusion, and the CFD Sim / FEA Sim folders. Saved on this computer and kept across restarts.
- **Insert McMaster-Carr Component** (SOLID → INSERT): opens mcmaster.com in its own window. Find the part, then **CAD → 3-D STEP → Save** and the part is inserted into the current design through the usual import dialog. In the browser preview it opens a tab instead, and you import the downloaded file yourself.
- **CFD inside the app** (SIMULATION workspace → CFD Study): pick bodies, flow direction, speed, fluid, ground and quality, then **Solve**. CFD Sim's GPU solver runs in the background as part of CAD Modeler, with no separate window. The results appear in the viewport while it runs:
  - surface pressure (Cp) on the body
  - vortex surfaces and streamlines coloured by velocity
  - side, top or wake slices of velocity or pressure
  - colour legends, and a frame timeline with play and LIVE follow
  - Cd, Cl, Cs and drag, lift and side force in newtons

  Stop ends a run early and still keeps its results. Each study is listed under **Simulations** in the browser (click to reopen it; right-click to open its folder or remove it), and Re-run solves the same case again. **Export Case** and **Open in CFD Sim** remain for the full CFD Sim viewer. The case folders go to `Documents\CAD-CFD Exchange\<design>_<time>\`; the spec is in `docs/cfd-exchange.md`.
- **Static stress (FEA) inside the app** (SIMULATION workspace → Static Stress): pick a body, click the faces to fix, then the faces to load, and set a force (newtons, along the face normal or an axis, with Flip), a pressure, and optionally gravity; the material's Young's modulus, Poisson's ratio, density and yield strength come from its physical material. **Solve** meshes the exact geometry into quadratic tetrahedra and runs FEA Sim (`Documents\FEA Sim`, validated against beam theory to within 0.6 %) in the background. The viewport then shows:
  - the deformed shape, **Adjusted** (exaggerated, with a slider), **Actual** or undeformed, optionally animated, over a wireframe of the original
  - colours for **safety factor** (yield ÷ von Mises; red below 1), von Mises stress, displacement or principal stresses, with a legend
  - markers at the maximum stress, maximum displacement and minimum safety factor
  - the results: minimum safety factor, maximum stress and displacement, reaction force, mesh size and any warnings

  Studies are listed under **Simulations** next to the CFD ones (right-click: Edit Study, Open Case Folder, Remove). The case folders go to `Documents\CAD-FEA Exchange\`; the spec is in `docs/fea-exchange.md`.
- **Gear Wizard** (CREATE → Gear Wizard, or G): real involute gears as a timeline feature with a live preview; double-click it to change anything.
  - **Makes** a gear pair, a gear train (type tooth counts like `20, 40, 16`), a single gear (spur, internal ring or rack), ring + pinion, rack + pinion, a planetary set (sun, N planets, ring), or **meshes a new gear onto any gear already in the design**: pick one of its faces, set the teeth and the direction, and it takes that gear's module, width and plane.
  - **Settings:** module, pressure angle (14.5 / 20 / 25°), helix angle (meshing gears get opposite hands automatically), face width, bore, hub, backlash, plane or picked face, centre and direction.
  - **Readout:** pitch and tip diameters, centre distances, contact ratios, the overall ratio and output rpm, and warnings for undercut tooth counts or planets that won't fit evenly.
  - Teeth are phased so meshing gears never overlap. Checked with B-rep interference: zero overlap at rest and after turning by the ratio.
  - **Make it move** (on by default): each gear becomes a component on a revolute axle (a slider for racks) on a grounded **Gear Frame** (or a component you pick). Meshing gears are tied by **motion links**, so **Drive Joints** turns the whole train. Planetary sets get a carrier with the planets riding on it and the ring held. Gears meshed onto existing ones join their train and share their frame.
- **Chains and belts** (Gear Wizard → Chain drive / Belt drive, or Single gear → sprocket / pulley):
  - **Roller chain:** ANSI #25, #35, #40, #50, #60, ISO 06B / 08B and 1/2" × 1/8" bicycle chain on ANSI-form sprockets (roller seats, flanks, topping on the OD). The chain is real rollers, pins and alternating inner / outer plates.
  - **Timing belts:** GT2 2 mm and 3 mm, HTD 3M and 5M on grooved pulleys (optional flanges), any belt width.
  - **Centre distance:** you give an approximate distance; it's adjusted until the chain is a whole number of links (the solver lays the chain out chordally: rollers in the seats, straight spans) or the belt a whole number of teeth. The readout gives links / belt teeth, loop length and the exact distance, and warns about odd link counts (offset link needed).
  - **Combining:** "Mesh / chain / belt to an existing one" on a sprocket or pulley adds a new wheel and its chain / belt. If the picked wheel already carries one, a twin wheel goes on the same shaft beside it (a double sprocket), so drives can be staged.
  - **Moving:** sprockets and pulleys get axles and motion links (both turn the same way, ratio = teeth ratio), and Drive Joints carries the chain and the belt teeth round with their wheels; the links stay in the seats at every angle (checked to 0.04 mm).
- **Motion Link** (ASSEMBLY workspace → MOTION → Motion Link): tie any two movable joints by gear teeth (e.g. 20:40, with Reverse for external gears) or a plain ratio; a rotation can drive a slider (rack and pinion). Links chain, show up under **Motion Links** in the browser, and export to URDF as `<mimic>` joints.
- **NACA airfoils** (CREATE → NACA Airfoil, also in the sketch CREATE menu): type a 4-digit (0012, 2412, 4415) or 5-digit (23012) section, the chord, an angle of attack and the leading-edge position. A preview and the thickness and camber are shown. In the model it makes a new sketch on the selected plane or face (or XZ / XY / YZ); inside a sketch it adds the section to that sketch. The outline is a closed polyline (cosine-spaced, 60 points per side by default) with a construction chord line. **Lock shape** fixes its points, so dimensions and constraints can reference it without dragging it out of shape.
- **2D Flow** (SIMULATION workspace → 2D Flow): a quick 2D CFD of any sketch with closed profiles, solved on the GPU (lattice Boltzmann with a Smagorinsky subgrid model, WebGL2) and shown live in a panel. Set the angle of attack, fluid (air or water), speed and resolution (64 / 110 / 170 cells per chord). Colour by speed, vorticity or pressure (Cp), with streamlines and a hover probe; wheel to zoom, drag to pan. Shows C<sub>L</sub>, C<sub>D</sub>, L/D, lift and drag in N per metre of span, and a history plot. It pauses itself after 40 chord passes.
  - **The Reynolds number is capped by the grid** (about 10–30 k); the panel says when your real Re is higher. Drag is validated (cylinder at Re 40: C<sub>D</sub> 1.67 against 1.5–1.6 unconfined, with ~10 % blockage). Low-Re lift reads well below high-Re lift: NACA 0012 at 5° gives C<sub>L</sub> ≈ 0.1 at Re 2000, resolution-converged. That is partly real low-Re physics but **hasn't been checked against published data yet**.
  - For a single closed section, the panel also shows the **inviscid C<sub>L</sub> from a panel method** (Hess–Smith, matches XFOIL's inviscid values: 0012 at 5° → 0.605, 2412 at 0° → 0.26). Use that number for attached flow at real wing Reynolds numbers.
- **Shape Optimization** (SIMULATION workspace → Shape Optimization): Fusion-style generative design, first version. Pick a body as the design space, click the faces that hold it, the faces each force acts on (newtons, along the face normal or an axis), and any faces that must stay. Then choose a goal:
  - **Lightest part meeting a safety factor** (from the body's material yield strength), or
  - **Stiffest part at a target mass** (%).

  **Optimize** voxelises the body (Coarse / Medium / Fine ≈ 4 k / 9 k / 20 k voxels) and runs SIMP topology optimisation in a background worker. You watch the material shave away over a ghost of the original, with the mass, the 99th-percentile von Mises stress and the safety factor updating. Fixed and loaded faces are always kept. **Create Body** turns the result into a smoothed mesh solid in the timeline, carries the material over and hides the original. Medium takes about 1–2 minutes. The stress check is voxel-level (hex elements, ~6 % stiff against beam theory), so run Static Stress on the final body before trusting it.
- **Assemblies** (the ASSEMBLE group), Fusion-style:
  - **New Component** groups the selected bodies into a component, or asks you to pick bodies. The first component is grounded. Bodies keep their timeline geometry; a component only places them, so moving or articulating it never rebuilds anything.
  - **Rigid Mate** (ASSEMBLE → MATE): locks two parts together with no motion; picked and adjusted like a joint, listed under **Mates** in the browser. Joints and mates also appear in the timeline after the feature they were made after (double-click to edit; they aren't rolled back by the marker).
  - **Joint** (J): click a joint origin on the part that moves, then one on the part it attaches to. Origins snap to circle centres (hole and boss rims), cylinder axes, planar face centres, edge midpoints and vertices; a preview glyph shows the snap under the cursor. The moving part jumps into place, face to face, as soon as both are picked. Choose **Revolute, Slider, Cylindrical or Ball**, then **Flip**, **Angle** and **Offset X / Y / Z** to adjust the alignment, the joint position, and **Joint Limits** (minimum / maximum). The play button animates the joint through its range. A body that isn't in a component yet gets one automatically.
  - **Drive Joints**: a slider per movable joint that moves the assembly live and stops at the limits, with a play button to animate each one. OK keeps the new positions; Cancel puts them back.
  - **Move/Copy** (M): move or rotate a free component (no joint, not grounded) by typed distances and angles; anything jointed to it follows.
  - **Ground**: fix a component in place (also the pin icon next to it in the browser).
  - The browser has **Components** (expand to see the bodies; eye to hide; pin to ground; right-click to rename, ground, move, drive or delete the component, keeping its bodies) and **Joints** (icon by type, current value; double-click to edit; right-click to drive, rename or delete). Joints with a problem, such as a loop or a part with two parent joints, turn red with the reason in the tooltip.
  - Joints and components belong to the document rather than the timeline, and every change can be undone. Rolling the timeline back past a body just leaves it out until you roll forward again.
- **Robot export for NVIDIA Isaac Sim / Isaac Lab** (File → Export Robot, or INSERT → Export Robot). Turns the assembly into a robot package folder:
  - `robot.usda`: a UsdPhysics articulation with the meshes embedded. Z up, metres, kilograms.
  - `robot.urdf` and `meshes/`
  - `README.txt` with load instructions and an Isaac Lab `ArticulationCfg` that uses your joint names

  Each component becomes a link. Rigid joints become fixed joints, revolute joints become revolute joints (continuous with no limits), and sliders become prismatic joints. Cylindrical and ball joints are split into single-axis joints. Each link's mass, centre of mass and full inertia come from the exact B-rep and each body's material density (aluminium when none is set). The dialog sets the format (USD, URDF or both), mesh type, collision approximation, fixed or floating base, and default drive stiffness and damping. With no assembly, all visible bodies export as one fixed link. The output is validated with Pixar's USD library (`tools/check_robot_usd.py`); Isaac Sim itself hasn't been tested yet. Details are in `docs/robot-export.md`.
- **Saving and closing:** File > Save writes back to the design's file once it has one (Save As… / Ctrl+Shift+S asks again). Closing the app asks to save every design with unsaved changes (Save and Close / Don't Save / Cancel), and the next start begins with one blank design. If the app crashed, the start page offers the last session's designs; New Design there closes them.
- **Bug reports and feature requests:** the Bug report and Feature request buttons open the same dialog (with screenshot, design and recent activity). Reports… lists them as Untouched / In work / Resolved (Done) with notes; History shows everything finished, newest first, with what changed. The badges count open items. Agents keep these up to date.
- **Navigation bar:** Orbit / Pan / Zoom modes (drag; in Orbit, click a point to orbit around it; Esc ends), Look At (pick a face or plane), Grid and Snaps menu (Layout Grid, Origin Axes).
- **Inspect:** Measure (face area, edge length, minimum distance between two items). **Section Analysis**: cut the model with an origin / construction plane or a planar face, drag the arrow or type a distance, flip the removed side, hatched / solid / hollow cut faces; the dialog shows the exact section area, perimeter, centroid and second moments (I<sub>u</sub>, I<sub>v</sub>, I<sub>uv</sub>). Saved analyses live in the browser's Analysis folder (eye = show, one at a time; right-click to edit, flip or delete).
- **Files:** autosaves to browser storage. File menu: New, Open/Save (`.cadm.json`), Export STL and STEP. Undo and redo for everything.

## Navigation

Middle-drag pans, Shift+middle-drag or right-drag orbits, and the wheel zooms to the cursor. Click the ViewCube's faces, edges, or corners. Z is up.

## Shortcuts

| Key | Action |
| --- | --- |
| E | Extrude |
| Q | Press Pull |
| F | Fillet |
| I | Measure |
| J | Joint |
| M | Move/Copy (component) |
| K | Shop Stock |
| L / R / C / A / P / D / O | Line, Rectangle, Circle, Arc, Polygon, Dimension, Offset (in a sketch) |
| Ctrl+C / Ctrl+V | Copy / paste the selected body or sketch |
| X | Construction toggle |
| S | Command search |
| F6 | Fit |
| Del | Delete |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Esc | Cancel |

## Layout

- `src/kernel.js`: OCCT wrapper, sketch to profile regions, feature replay, references, export (no three.js, so it runs in Node)
- `src/viewport.js`: camera, navigation, rendering, picking, highlights, grid, arrow manipulator
- `src/viewcube.js`: ViewCube
- `src/sketcher.js`: sketch-mode tools, smart dimension, constraint tools, annotations
- `src/sketchmodel.js`: point/entity/constraint sketch model, flattening for the kernel, migration of old sketches
- `src/solver.js`: constraint solver (damped Gauss-Newton with minimum-norm steps) and degrees-of-freedom analysis
- `src/platform.js`: OS access (native file dialogs, bug-report saving, the CFD bridge), with browser fallbacks; `electron/` holds the main process, preload and launcher
- `src/materials.js`, `src/appearance.js`: material library and appearance dialog
- `src/cfdlink.js`, `src/cfdstudy.js`, `src/cfdresults.js`: CFD case builder, the CFD Study dialog, and the in-viewport results (`electron/cfd-runner.cjs` runs the solver)
- `src/fealink.js`, `src/feastudy.js`, `src/fearesults.js`, `src/fea.css`: FEA (static stress) case builder, the Static Stress dialog, and the in-viewport results (`electron/fea-runner.cjs` runs FEA Sim; spec in `docs/fea-exchange.md`)
- `src/fasteners.js`: ISO fastener table and geometry (threads)
- `src/stock.js`: Shop Stock catalog, search and geometry; `src/stockui.js` + `src/stock.css`: the Shop Stock browser
- `src/chains.js` (sprockets, pulleys, chain / belt bodies, chordal chain and pitch-line belt layout), `src/drivemotion.js` (moves chain / belt display meshes with their wheels)
- `src/gears.js` (involute geometry, solids, meshing math), `src/gearplan.js` (wizard settings → gears + assembly plan), `src/gearui.js` + `src/gears.css` (the Gear Wizard dialog)
- `src/airfoil.js`: NACA 4- and 5-digit section geometry (the dialog is `startAirfoil` in main.js)
- `src/cfd2d.js` (CPU lattice Boltzmann, case setup, rasterising, panel method; runs in Node), `src/cfd2dgpu.js` (the same solver in WebGL2), `src/cfd2dui.js` + `src/cfd2d.css` (the 2D Flow panel)
- `src/topo.js` (voxelising, hex FE with matrix-free CG, SIMP optimiser, surface extraction, STL; runs in Node), `src/topo.worker.js`, `src/topoui.js` + `src/topo.css` (the Shape Optimization dialog)
- `src/assembly.js`, `src/assemblyui.js`: assembly kinematics (components, joints, limits; no DOM, so it runs in Node) and the assembly commands, dialogs and browser folders. Data model: `docs/assembly.md`
- `src/bugreport.js`: event log, report dialog, saving (`vite.config.js` serves `/api/bug-report`)
- `src/main.js`: document, undo, commands and dialogs, toolbar, browser, timeline, menus, files
- `src/icons.js`: inline SVG icons

## Not built yet

These carry a black-and-yellow **under construction** tape (toolbar icons, menu items, the Sheet Metal / Render / Animate tabs, the CAM workspace, and the notifications, comments and viewports buttons): symmetry constraints, trim, offset, sketch fillet, hole (the fastener command needs an existing hole to seat in), sweep, loft, mirror, pattern, moving bodies (Move works on components), every tool on the Surface and Plastic tabs, and everything on the Sheet Metal, Render and Animate tabs and in the CAM workspace. Face and edge references are re-found by nearest geometry after a rebuild, which is simpler than Fusion's topological naming. Large upstream edits can therefore re-target a fillet or shell.

## Working on the code

Developer and agent handoff notes (architecture, gotchas, open items, how to test) are in [CLAUDE.md](CLAUDE.md).
