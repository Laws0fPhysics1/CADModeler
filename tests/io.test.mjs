// Import/export round trip: node tests/io.test.mjs
import * as K from "../src/kernel.js";
await K.initKernel();
const L = (a, b) => ({ id: Math.random() + "", type: "line", a, b });
const sk = { id: "s", type: "sketch", plane: K.ORIGIN_PLANES.XY, entities: [L([0, 0], [40, 0]), L([40, 0], [40, 25]), L([40, 25], [0, 25]), L([0, 25], [0, 0])] };
const p = K.evaluate([sk]).sketches.s.profiles[0];
const st = K.evaluate([sk, { id: "e", type: "extrude", profiles: [{ kind: "profile", sketch: "s", pt: p.center2d, area: p.area }], distance: 10, direction: "one", operation: "auto" }]);
for (const [fmt, blob] of [["obj", K.exportOBJ(st.bodies)], ["step", K.exportSTEP(st.bodies)], ["stl", K.exportSTL(st.bodies, { quality: "fine" })]]) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const f = { id: `i${fmt}`, type: "import", format: fmt, data: K.bytesToBase64(bytes), translate: [100, 0, 0], bodyNames: "Imported" };
  const s2 = K.evaluate([f]);
  const bb = s2.bodies[0] && s2.bodies[0].shape.boundingBox.bounds.map((b) => b.map((v) => +v.toFixed(1)));
  console.log(fmt, bytes.length, "bytes ->", JSON.stringify(s2.errors), s2.bodies.length, "body, volume", s2.bodies[0] && K.bodyInfo(s2.bodies[0].shape).volume.toFixed(1), JSON.stringify(bb));
}
console.log("ascii stl:", new TextDecoder().decode(await K.exportSTL(st.bodies, { binary: false }).arrayBuffer()).slice(0, 12));
