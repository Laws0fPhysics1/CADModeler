// NACA airfoil geometry (DOM-free, Node-testable).
// 4-digit (e.g. 0012, 2412, 4415) and 5-digit standard-camber (e.g. 23012, 23015) sections,
// sampled with cosine spacing so the leading edge gets the most points. The result is a
// closed polyline in sketch (u, v) coordinates, ready for sketchmodel.addFlat.

// 5-digit mean line, non-reflex (third digit 0): p -> [m, k1], k1 for a design Cl of 0.3
const FIVE = { 1: [0.0580, 361.4], 2: [0.1260, 51.64], 3: [0.2025, 15.957], 4: [0.2900, 6.643], 5: [0.3910, 3.230] };

/** Parse a designation ("NACA 2412", "23012", "0012") into its section parameters. */
export function parseNaca(code) {
  const s = String(code || "").toUpperCase().replace(/NACA|[\s-]/g, "");
  if (/^\d{4}$/.test(s)) {
    const m = +s[0] / 100, p = +s[1] / 10, t = +s.slice(2) / 100;
    if (!(t > 0)) throw new Error("Thickness (last two digits) must be more than 0");
    if (m > 0 && !(p > 0)) throw new Error("A cambered 4-digit section needs a camber position (second digit) of 1-9");
    return { series: 4, code: s, m, p, t };
  }
  if (/^\d{5}$/.test(s)) {
    const L = +s[0], P = +s[1], Q = +s[2], t = +s.slice(3) / 100;
    if (Q !== 0) throw new Error("Reflexed 5-digit sections (third digit 1) aren't supported yet");
    if (!FIVE[P]) throw new Error("5-digit camber position (second digit) must be 1-5");
    if (!(t > 0)) throw new Error("Thickness (last two digits) must be more than 0");
    const [m, k1] = FIVE[P];
    return { series: 5, code: s, cl: 0.15 * L, m, k1, t };
  }
  throw new Error("Enter a 4- or 5-digit NACA number, e.g. 2412 or 23012");
}

function camber(sec, x) {
  if (sec.series === 4) {
    const { m, p } = sec;
    if (!m) return [0, 0];
    if (x < p) return [(m / (p * p)) * (2 * p * x - x * x), ((2 * m) / (p * p)) * (p - x)];
    return [(m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x), ((2 * m) / ((1 - p) ** 2)) * (p - x)];
  }
  const { m, k1, cl } = sec, s = cl / 0.3;
  if (x < m) return [s * (k1 / 6) * (x ** 3 - 3 * m * x * x + m * m * (3 - m) * x), s * (k1 / 6) * (3 * x * x - 6 * m * x + m * m * (3 - m))];
  return [s * (k1 / 6) * m ** 3 * (1 - x), -s * (k1 / 6) * m ** 3];
}
const thickness = (t, x, closed) => 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - (closed ? 0.1036 : 0.1015) * x ** 4);

/**
 * Sample the section. Returns { upper, lower } for a unit chord (x from 0 at the leading edge
 * to 1 at the trailing edge), both starting at the leading edge.
 */
export function nacaUnit(code, { n = 60, closedTE = true } = {}) {
  const sec = parseNaca(code);
  n = Math.max(8, Math.min(400, Math.round(n)));
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((Math.PI * i) / n)) / 2;
    const yt = thickness(sec.t, x, closedTE);
    const [yc, dy] = camber(sec, x);
    const th = Math.atan(dy);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  // the leading edge is one shared point; a closed trailing edge too
  lower[0] = upper[0];
  if (closedTE) lower[n] = upper[n] = [1, 0];
  return { sec, upper, lower };
}

/**
 * The section as sketch entities in (u, v): a closed polyline plus a construction chord line.
 * opts: chord (mm), alpha (deg, nose-up pitch about the leading edge for flow along +u),
 *       origin [u, v] of the leading edge, n points per surface, closedTE.
 */
export function nacaEntities(code, { chord = 100, alpha = 0, origin = [0, 0], n = 60, closedTE = true } = {}) {
  if (!(chord > 0)) throw new Error("Chord must be more than 0");
  const { sec, upper, lower } = nacaUnit(code, { n, closedTE });
  const a = (-alpha * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const tx = ([x, y]) => [origin[0] + chord * (x * ca - y * sa), origin[1] + chord * (x * sa + y * ca)];
  // trailing edge -> upper surface -> leading edge -> lower surface -> trailing edge
  const ring = [...upper.slice().reverse(), ...lower.slice(1)].map(tx);
  const ents = [];
  for (let i = 0; i + 1 < ring.length; i++) ents.push({ type: "line", a: ring[i], b: ring[i + 1] });
  if (!closedTE) ents.push({ type: "line", a: ring[ring.length - 1], b: ring[0] }); // blunt trailing edge
  ents.push({ type: "line", a: tx([0, 0]), b: tx([1, 0]), construction: true });
  return { sec, entities: ents, outline: ring, name: `NACA ${sec.code}` };
}

/** Area of the unit-chord section (shoelace), handy for tests and the dialog's readout. */
export function unitArea(code, opts) {
  const { upper, lower } = nacaUnit(code, opts);
  const ring = [...upper.slice().reverse(), ...lower.slice(1)];
  let A = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; A += p[0] * q[1] - q[0] * p[1]; }
  return Math.abs(A) / 2;
}
