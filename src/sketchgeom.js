// 2D helpers shared by the sketcher and the renderer.
export const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// circle through three points; returns null if colinear
export function circleFrom3(a, m, b) {
  const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

// arc from a to b passing through m: center, radius, start angle and signed sweep
export function arcParams(a, m, b) {
  const circ = circleFrom3(a, m, b);
  if (!circ) return null;
  const { c, r } = circ;
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a), am = ang(m), a1 = ang(b);
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a1 - a0);
  if (norm(am - a0) > sweep) sweep = sweep - 2 * Math.PI; // go the other way round
  return { c, r, a0, sweep };
}

// polyline points for an entity (used for drawing and hit-testing)
export function entityPolyline(e, n = 64) {
  if (e.type === "line") return [e.a, e.b];
  if (e.type === "circle") {
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2; pts.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
    return pts;
  }
  if (e.type === "arc") {
    const p = arcParams(e.a, e.m, e.b);
    if (!p) return [e.a, e.b];
    const pts = [], k = Math.max(8, Math.ceil((Math.abs(p.sweep) / (Math.PI * 2)) * n));
    for (let i = 0; i <= k; i++) { const t = p.a0 + (p.sweep * i) / k; pts.push([p.c[0] + p.r * Math.cos(t), p.c[1] + p.r * Math.sin(t)]); }
    return pts;
  }
  return [];
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return d2(p, [a[0] + t * dx, a[1] + t * dy]);
}
export function distToEntity(p, e) {
  if (e.type === "circle") return Math.abs(d2(p, e.c) - e.r);
  const pts = entityPolyline(e, 48);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}
export function entityLength(e) {
  if (e.type === "line") return d2(e.a, e.b);
  if (e.type === "circle") return 2 * Math.PI * e.r;
  const p = arcParams(e.a, e.m, e.b);
  return p ? Math.abs(p.sweep) * p.r : d2(e.a, e.b);
}
