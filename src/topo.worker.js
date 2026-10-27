// Runs a shape optimization (topo.js) off the UI thread. Messages in:
//   { cmd: "run", setup, opts }   setup = TopoProblem setup (vox, fixed, loads, preserve, E, nu, yield)
//   { cmd: "stop" }               finish after the current iteration
//   { cmd: "stl", iso, smooth }   binary STL of the latest design
// Messages out: { type: "ready", ne, ndof }, { type: "iter", info, positions, indices }, { type: "done", info },
//   { type: "stl", bytes }, { type: "error", message }
import { TopoProblem, optimizeSteps, densitySurface, meshToSTL } from "./topo.js";

let P = null, last = null, stop = false;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.cmd === "run") run(m.setup, m.opts);
    else if (m.cmd === "stop") stop = true;
    else if (m.cmd === "stl") {
      if (!P || !last) throw new Error("No design yet");
      const s = densitySurface(P.s.vox, P.elems, last.rho, m.iso ?? 0.5, m.smooth ?? 3);
      const bytes = meshToSTL(s.positions, s.indices);
      self.postMessage({ type: "stl", bytes, triangles: s.indices.length / 3 }, [bytes.buffer]);
    }
  } catch (err) { self.postMessage({ type: "error", message: String(err.message || err) }); }
};

function run(setup, opts) {
  stop = false; last = null;
  P = new TopoProblem(setup);
  self.postMessage({ type: "ready", ne: P.ne, ndof: P.ndof });
  const gen = optimizeSteps(P, opts);
  const tick = () => {
    let r;
    try { r = gen.next(); } catch (err) { self.postMessage({ type: "error", message: String(err.message || err) }); return; }
    if (r.done || stop) { self.postMessage({ type: "done", info: strip(last), stopped: stop && !r.done }); return; }
    last = r.value;
    const s = densitySurface(setup.vox, P.elems, last.rho, 0.5, 1);
    self.postMessage({ type: "iter", info: strip(last), positions: s.positions, indices: s.indices }, [s.positions.buffer, s.indices.buffer]);
    setTimeout(tick, 0); // let a "stop" message in between iterations
  };
  setTimeout(tick, 0);
}
const strip = (info) => { if (!info) return null; const { rho, ...rest } = info; return rest; };
