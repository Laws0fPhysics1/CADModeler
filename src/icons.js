// Inline SVG icons drawn in the shaded, outlined style of Fusion's toolbar.
const T = "#e4edf5", F = "#b9c9d8", S = "#8aa1b8", K = "#34495e", O = "#f39a1e", B = "#1c8ad1", G = "#3fa34d";
const svg = (body, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const cube = (x = 0, y = 0, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
  <path d="M4 8 L12 4 L20 8 L12 12Z" fill="${T}" stroke="${K}" stroke-width="1"/>
  <path d="M4 8 L12 12 L12 21 L4 17Z" fill="${F}" stroke="${K}" stroke-width="1"/>
  <path d="M20 8 L12 12 L12 21 L20 17Z" fill="${S}" stroke="${K}" stroke-width="1"/></g>`;

export const icons = {
  sketch: svg(`<path d="M3 15 L13 19 L21 11 L11 7Z" fill="${T}" stroke="${K}"/>
    <path d="M7 14 Q11 9 16 12" fill="none" stroke="${B}" stroke-width="1.6"/>
    <path d="M14 3 L19 8 L12 15 L9 16 L10 13Z" fill="${O}" stroke="${K}" stroke-width=".9"/>`),
  extrude: svg(`<path d="M5 13 L12 10 L19 13 L12 16Z" fill="${B}" fill-opacity=".35" stroke="${K}"/>
    <path d="M5 13 L5 18 L12 21 L19 18 L19 13 L12 16Z" fill="${F}" stroke="${K}"/>
    <path d="M12 16 L12 21" stroke="${K}"/>
    <path d="M12 12 V3 M9 6 L12 3 L15 6" fill="none" stroke="${O}" stroke-width="1.8"/>`),
  revolve: svg(`<ellipse cx="12" cy="15" rx="8" ry="4" fill="${F}" stroke="${K}"/>
    <path d="M4 15 V9 Q12 4 20 9 V15" fill="${T}" stroke="${K}"/>
    <path d="M6 5 A8 3 0 0 1 18 5" fill="none" stroke="${O}" stroke-width="1.8"/><path d="M16 3 L18 5 L15.5 6.5" fill="none" stroke="${O}" stroke-width="1.6"/>`),
  box: svg(cube()),
  cylinder: svg(`<path d="M5 7 V17 A7 3 0 0 0 19 17 V7" fill="${F}" stroke="${K}"/><ellipse cx="12" cy="7" rx="7" ry="3" fill="${T}" stroke="${K}"/>`),
  sphere: svg(`<defs><radialGradient id="sg" cx=".35" cy=".35"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${S}"/></radialGradient></defs><circle cx="12" cy="12" r="8.5" fill="url(#sg)" stroke="${K}"/><ellipse cx="12" cy="12" rx="8.5" ry="3" fill="none" stroke="${K}" stroke-opacity=".5"/>`),
  presspull: svg(`${cube(0, 1, 1)}<path d="M12 9 V1.5 M9.5 4 L12 1.5 L14.5 4" fill="none" stroke="${O}" stroke-width="1.7"/>`),
  fillet: svg(`<path d="M4 9 L10 5 L20 5 L20 18 L14 21 L4 21Z" fill="${F}" stroke="${K}"/>
    <path d="M4 9 L14 9 Q14 9 14 9 L20 5" fill="none" stroke="${K}"/>
    <path d="M10 9 Q14 9 14 13 V21" fill="none" stroke="${B}" stroke-width="2"/><path d="M14 13 Q14 9 18 6.5" fill="none" stroke="${B}" stroke-width="1.2"/>`),
  chamfer: svg(`<path d="M4 9 L10 5 L20 5 L20 18 L14 21 L4 21Z" fill="${F}" stroke="${K}"/>
    <path d="M4 9 H10 L14 13 V21 M10 9 L16 5 M14 13 L20 9" fill="none" stroke="${K}"/>
    <path d="M10 9 L14 13 L20 9 L16 5Z" fill="${B}" fill-opacity=".6" stroke="${B}"/>`),
  shell: svg(`<path d="M4 8 L12 4 L20 8 L20 17 L12 21 L4 17Z" fill="${F}" stroke="${K}"/>
    <path d="M7 8.5 L12 6 L17 8.5 L12 11Z" fill="#6f8aa3" stroke="${K}" stroke-width=".8"/>
    <path d="M12 12 V21" stroke="${K}"/>`),
  plane: svg(`<path d="M3 15 L10 19 L21 12 L14 8Z" fill="${O}" fill-opacity=".35" stroke="${O}"/>
    <path d="M3 10 L10 14 L21 7 L14 3Z" fill="${O}" fill-opacity=".55" stroke="#c97a10"/>`),
  measure: svg(`<path d="M2 15 L15 2 L22 9 L9 22Z" fill="#f6d44a" stroke="${K}"/>
    <path d="M6 13 l2 2 M9 10 l3 3 M12 7 l2 2 M15 4 l3 3" stroke="${K}"/>`),
  // a block cut on a diagonal: the hatched cut face, the removed half in outline
  section: svg(`<path d="M3 9 L11 5 L21 10 L13 14Z" fill="none" stroke="${S}" stroke-dasharray="2 1.5"/>
    <path d="M3 9 L13 14 L13 21 L3 16Z" fill="${F}" stroke="${K}"/>
    <path d="M13 14 L21 10 L21 17 L13 21Z" fill="#f6d44a" stroke="${K}"/>
    <path d="M14.5 19 L20 14.2 M14.5 16 L20 11.4 M17 19.5 L20 17" stroke="${K}" stroke-width=".8"/>
    <path d="M17 3 V8 M15 6 L17 8 L19 6" fill="none" stroke="${B}" stroke-width="1.4"/>`),
  flip: svg(`<path d="M5 9 H17 L14 6 M19 15 H7 L10 18" fill="none" stroke="${K}" stroke-width="1.6"/>`),
  select: svg(`<path d="M6 3 L6 19 L10 15 L13 21 L15.5 20 L12.5 14 L18 14Z" fill="#fff" stroke="${K}" stroke-width="1.3"/>`),
  remove: svg(`${cube(0, 0, 1)}<path d="M14 14 L21 21 M21 14 L14 21" stroke="#d6312b" stroke-width="2.2"/>`),
  line: svg(`<path d="M4 19 L20 5" stroke="${B}" stroke-width="2"/><rect x="2.5" y="17.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="18.5" y="3.5" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  rect: svg(`<rect x="4" y="6" width="16" height="12" fill="none" stroke="${B}" stroke-width="2"/><rect x="2.5" y="4.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="18.5" y="16.5" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  rectCenter: svg(`<rect x="4" y="6" width="16" height="12" fill="none" stroke="${B}" stroke-width="2"/><path d="M12 12 L20 18" stroke="${K}" stroke-dasharray="2 1.5"/><circle cx="12" cy="12" r="1.6" fill="#fff" stroke="${K}"/>`),
  circle: svg(`<circle cx="12" cy="12" r="8" fill="none" stroke="${B}" stroke-width="2"/><path d="M12 12 L19 8" stroke="${K}" stroke-dasharray="2 1.5"/><circle cx="12" cy="12" r="1.6" fill="#fff" stroke="${K}"/>`),
  arc: svg(`<path d="M4 18 A9 9 0 0 1 20 12" fill="none" stroke="${B}" stroke-width="2"/><rect x="2.5" y="16.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="18.5" y="10.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="9.5" y="5.8" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  arcCenter: svg(`<path d="M19 12 A7 7 0 0 0 7 17" fill="none" stroke="${B}" stroke-width="2"/><path d="M12 12 L19 12" stroke="${K}" stroke-dasharray="2 1.5"/><circle cx="12" cy="12" r="1.6" fill="#fff" stroke="${K}"/><rect x="17.5" y="10.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="5.5" y="15.5" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  circle2p: svg(`<circle cx="12" cy="12" r="8" fill="none" stroke="${B}" stroke-width="2"/><path d="M4 12 L20 12" stroke="${K}" stroke-dasharray="2 1.5"/><rect x="2.5" y="10.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="18.5" y="10.5" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  circle3p: svg(`<circle cx="12" cy="12" r="8" fill="none" stroke="${B}" stroke-width="2"/><rect x="2.5" y="10.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="16" y="4.5" width="3" height="3" fill="#fff" stroke="${K}"/><rect x="16" y="16.5" width="3" height="3" fill="#fff" stroke="${K}"/>`),
  polygon: svg(`<path d="M12 3.5 L19.5 8 L19.5 16 L12 20.5 L4.5 16 L4.5 8Z" fill="none" stroke="${B}" stroke-width="2"/>`),
  dimension: svg(`<path d="M4 6 V18 M20 6 V18" stroke="${K}"/><path d="M4 12 H20 M7 9.5 L4 12 L7 14.5 M17 9.5 L20 12 L17 14.5" fill="none" stroke="${B}" stroke-width="1.4"/><text x="12" y="9" font-size="6" text-anchor="middle" fill="${K}" font-family="Segoe UI">25</text>`),
  construction: svg(`<path d="M4 19 L20 5" stroke="${O}" stroke-width="2" stroke-dasharray="3 2"/>`),
  trash: svg(`<path d="M6 7 H18 L17 21 H7Z" fill="${F}" stroke="${K}"/><path d="M4 7 H20 M9 7 V4 H15 V7 M10 10 V18 M14 10 V18" fill="none" stroke="${K}"/>`),
  finish: svg(`<circle cx="12" cy="12" r="9.5" fill="${G}"/><path d="M7 12.5 L10.5 16 L17.5 8.5" fill="none" stroke="#fff" stroke-width="2.4"/>`),
  check: svg(`<path d="M5 12.5 L10 17 L19 7" fill="none" stroke="currentColor" stroke-width="2.2"/>`),
  close: svg(`<path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="1.8"/>`),
  undo: svg(`<path d="M9 7 L4 11 L9 15" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 11 H14 A5 5 0 0 1 14 21 H10" fill="none" stroke="currentColor" stroke-width="1.8"/>`),
  redo: svg(`<path d="M15 7 L20 11 L15 15" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M20 11 H10 A5 5 0 0 0 10 21 H14" fill="none" stroke="currentColor" stroke-width="1.8"/>`),
  save: svg(`<path d="M4 4 H17 L20 7 V20 H4Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4 V9 H15 V4 M7 20 V14 H17 V20" fill="none" stroke="currentColor" stroke-width="1.6"/>`),
  file: svg(`<path d="M6 3 H14 L19 8 V21 H6Z M14 3 V8 H19" fill="none" stroke="currentColor" stroke-width="1.6"/>`),
  apps: svg(`<g fill="currentColor"><rect x="4" y="4" width="4" height="4"/><rect x="10" y="4" width="4" height="4"/><rect x="16" y="4" width="4" height="4"/><rect x="4" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/><rect x="16" y="10" width="4" height="4"/><rect x="4" y="16" width="4" height="4"/><rect x="10" y="16" width="4" height="4"/><rect x="16" y="16" width="4" height="4"/></g>`),
  help: svg(`<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 9.5 A2.5 2.5 0 1 1 12 12 V14" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="17" r="1" fill="currentColor"/>`),
  bell: svg(`<path d="M6 17 V11 A6 6 0 0 1 18 11 V17 L20 19 H4Z M10 21 H14" fill="none" stroke="currentColor" stroke-width="1.6"/>`),
  plus: svg(`<path d="M12 5 V19 M5 12 H19" stroke="currentColor" stroke-width="1.8"/>`),
  orbit: svg(`<ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 3 A9 9 0 0 1 12 21" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>`),
  lookat: svg(`<rect x="6" y="6" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 12 H6 M18 12 H22 M12 2 V6 M12 18 V22" stroke="currentColor" stroke-width="1.5"/>`),
  pan: svg(`<path d="M8 12 V6.5 a1.3 1.3 0 0 1 2.6 0 V11 V4.8 a1.3 1.3 0 0 1 2.6 0 V11 V5.8 a1.3 1.3 0 0 1 2.6 0 V12 V8.5 a1.3 1.3 0 0 1 2.6 0 V15 a6 6 0 0 1 -6 6 h-1 a6 6 0 0 1 -5 -3 L4.5 13.5 a1.4 1.4 0 0 1 2.3 -1.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/>`),
  zoom: svg(`<circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14.5 14.5 L20 20 M7 10 H13 M10 7 V13" stroke="currentColor" stroke-width="1.6"/>`),
  fit: svg(`<path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="8.5" y="8.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.4"/>`),
  display: svg(`<rect x="3" y="5" width="18" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 20 H16 M12 17 V20" stroke="currentColor" stroke-width="1.5"/><path d="M7 13 L11 9 L14 12 L17 9" fill="none" stroke="currentColor" stroke-width="1.3"/>`),
  grid: svg(`<path d="M3 8 H21 M3 13 H21 M3 18 H21 M7 4 V21 M12 4 V21 M17 4 V21" stroke="currentColor" stroke-width="1.1"/>`),
  viewports: svg(`<rect x="3" y="4" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 4 V20 M3 12 H21" stroke="currentColor" stroke-width="1.5"/>`),
  home: svg(`<path d="M3 12 L12 4 L21 12 M6 10 V20 H18 V10" fill="none" stroke="currentColor" stroke-width="1.7"/>`),
  eye: svg(`<path d="M2 12 Q12 3 22 12 Q12 21 2 12Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="currentColor"/>`),
  eyeOff: svg(`<path d="M2 12 Q12 3 22 12 Q12 21 2 12Z" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/><path d="M4 20 L20 4" stroke="currentColor" stroke-width="1.6"/>`),
  folder: svg(`<path d="M3 6 H10 L12 8 H21 V19 H3Z" fill="#e8c46a" stroke="#a9852b"/>`),
  body: svg(cube(0, 0, 1)),
  sketchSmall: svg(`<path d="M3 15 L13 19 L21 11 L11 7Z" fill="${T}" stroke="${K}"/><path d="M7 14 Q11 9 16 12" fill="none" stroke="${B}" stroke-width="1.8"/>`),
  origin: svg(`<path d="M12 12 L21 16 M12 12 L3 16 M12 12 V3" stroke="${K}" stroke-width="1.6"/><circle cx="12" cy="12" r="2.2" fill="${O}"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9" stroke="currentColor" stroke-width="1.6"/>`),
  camera: svg(`<path d="M3 8 H7 L9 5 H15 L17 8 H21 V19 H3Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/>`),
  design: svg(`${cube(0, 0, 1)}`),
  first: svg(`<path d="M6 5 V19 M19 5 L9 12 L19 19Z" fill="currentColor" stroke="currentColor" stroke-width="1.2"/>`),
  prev: svg(`<path d="M17 5 L7 12 L17 19Z" fill="currentColor"/>`),
  play: svg(`<path d="M7 5 L17 12 L7 19Z" fill="currentColor"/>`),
  last: svg(`<path d="M18 5 V19 M5 5 L15 12 L5 19Z" fill="currentColor" stroke="currentColor" stroke-width="1.2"/>`),
  caret: svg(`<path d="M7 10 L12 15 L17 10" fill="none" stroke="currentColor" stroke-width="1.8"/>`),
  caretRight: svg(`<path d="M10 7 L15 12 L10 17" fill="none" stroke="currentColor" stroke-width="1.8"/>`),
  hole: svg(`${cube(0, 0, 1)}<ellipse cx="12" cy="8" rx="3" ry="1.5" fill="${K}"/>`),
  sweep: svg(`<path d="M4 18 Q8 6 20 6" fill="none" stroke="${F}" stroke-width="5"/><path d="M4 18 Q8 6 20 6" fill="none" stroke="${K}" stroke-width=".8"/>`),
  loft: svg(`<path d="M5 18 L9 6 H17 L20 18Z" fill="${F}" stroke="${K}"/><ellipse cx="13" cy="6" rx="4" ry="1.5" fill="${T}" stroke="${K}"/>`),
  mirror: svg(`<path d="M12 3 V21" stroke="${O}" stroke-dasharray="2 2" stroke-width="1.5"/><path d="M4 7 L10 9 V17 L4 15Z" fill="${F}" stroke="${K}"/><path d="M20 7 L14 9 V17 L20 15Z" fill="${T}" stroke="${K}" stroke-dasharray="2 1"/>`),
  pattern: svg(`${cube(-3, -3, .6)}${cube(7, -3, .6)}${cube(-3, 7, .6)}${cube(7, 7, .6)}`),
  copy: svg(`<rect x="8" y="8" width="12" height="13" rx="1.5" fill="none" stroke="${K}" stroke-width="1.5"/><path d="M5 16 V4.5 A1.5 1.5 0 0 1 6.5 3 H15" fill="none" stroke="${K}" stroke-width="1.5"/>`),
  paste: svg(`<rect x="5" y="5" width="14" height="16" rx="1.5" fill="none" stroke="${K}" stroke-width="1.5"/><rect x="9" y="3" width="6" height="4" rx="1" fill="none" stroke="${K}" stroke-width="1.5"/><path d="M9 12 H15 M9 16 H13" stroke="${K}" stroke-width="1.5"/>`),
  move: svg(`<path d="M12 3 V21 M3 12 H21 M9 6 L12 3 L15 6 M9 18 L12 21 L15 18 M6 9 L3 12 L6 15 M18 9 L21 12 L18 15" fill="none" stroke="${K}" stroke-width="1.5"/>`),
  search: svg(`<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 15 L20 20" stroke="currentColor" stroke-width="1.8"/>`),
  user: svg(`<circle cx="12" cy="9" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 21 A8 8 0 0 1 20 21" fill="none" stroke="currentColor" stroke-width="1.6"/>`),
  dot: svg(`<circle cx="12" cy="12" r="3" fill="currentColor"/>`),
};

// sketch constraint icons (Fusion draws these as small line glyphs)
const cg = (body) => svg(`<g fill="none" stroke="${B}" stroke-width="1.8">${body}</g>`);
Object.assign(icons, {
  c_coincident: cg(`<path d="M4 20 L12 12 M12 12 L20 6" stroke="${K}"/><circle cx="12" cy="12" r="3" fill="#fff"/>`),
  c_hv: cg(`<path d="M3 17 H14"/><path d="M19 3 V15" stroke="${K}"/>`),
  c_parallel: cg(`<path d="M5 19 L15 5 M10 19 L20 5"/>`),
  c_perpendicular: cg(`<path d="M5 19 H20 M12 19 V5"/>`),
  c_collinear: cg(`<path d="M3 17 L10 13 M13 11 L21 7"/>`),
  c_equal: cg(`<path d="M5 9 H19 M5 15 H19"/>`),
  c_tangent: cg(`<circle cx="12" cy="13" r="6"/><path d="M3 7 H21" stroke="${K}"/>`),
  c_concentric: cg(`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>`),
  c_midpoint: cg(`<path d="M3 16 H21"/><path d="M12 9 L16 16 H8Z" fill="#fff" stroke="${K}"/>`),
  c_fix: cg(`<rect x="6" y="11" width="12" height="9" fill="#fff" stroke="${K}"/><path d="M8.5 11 V8 a3.5 3.5 0 0 1 7 0 V11" stroke="${K}"/>`),
});

icons.wind = svg(`<path d="M3 8 H14 a3 3 0 1 0 -3 -3" fill="none" stroke="${B}" stroke-width="1.7"/><path d="M3 13 H18 a3 3 0 1 1 -3 3" fill="none" stroke="${B}" stroke-width="1.7"/><path d="M3 18 H9" fill="none" stroke="${B}" stroke-width="1.7"/><ellipse cx="17" cy="8.5" rx="2.6" ry="1.4" fill="${F}" stroke="${K}"/>`);
icons.cfd = icons.wind;
// Static stress (FEA): a cantilever bending under a load, with a stress-colour gradient
icons.stress = svg(`<defs><linearGradient id="feaGr" x1="0" x2="1"><stop offset="0" stop-color="#e5442f"/><stop offset=".5" stop-color="#f3c623"/><stop offset="1" stop-color="#3a8ee0"/></linearGradient></defs><path d="M3 4 V20" stroke="${K}" stroke-width="1.6"/><path d="M3 4.5 l1.5 1.5 M3 9 l1.5 1.5 M3 13.5 l1.5 1.5" stroke="${K}" stroke-width=".9"/><path d="M4 9 Q12 9 20 13 V17 Q12 13 4 13Z" fill="url(#feaGr)" stroke="${K}" stroke-width="1"/><path d="M19 3 V9.5 M16.8 7.4 L19 9.6 L21.2 7.4" fill="none" stroke="${O}" stroke-width="1.7"/>`);
icons.fea = icons.stress;
icons.insert = svg(`<path d="M5 3 H13 L18 8 V21 H5Z" fill="${T}" stroke="${K}"/><path d="M13 3 V8 H18" fill="none" stroke="${K}"/><path d="M11.5 10 V18 M8 14.5 L11.5 18 L15 14.5" fill="none" stroke="${B}" stroke-width="1.8"/>`);

// fastener: a socket head cap screw
icons.bolt = svg(`<path d="M8.5 3.5 H15.5 V9 H8.5Z" fill="${T}" stroke="${K}"/><path d="M10.5 5 H13.5 V7 H10.5Z" fill="${S}" stroke="${K}" stroke-width=".7"/>
  <path d="M10 9 V20 L12 21.5 L14 20 V9Z" fill="${F}" stroke="${K}"/>
  <path d="M10 11.5 L14 10.5 M10 13.5 L14 12.5 M10 15.5 L14 14.5 M10 17.5 L14 16.5 M10 19.5 L14 18.5" stroke="${K}" stroke-width=".8"/>`);
// ---- assemblies (components, joints, ground, drive) ----
const jointBase = (body) => svg(`<path d="M3 15 L9 12 L9 19 L3 22Z" fill="${F}" stroke="${K}" stroke-width=".9"/><path d="M15 3 L21 6 L21 12 L15 9Z" fill="${T}" stroke="${K}" stroke-width=".9"/>${body}`);
Object.assign(icons, {
  component: svg(`<g transform="translate(-1.5 1.5) scale(.62)">${cube()}</g><g transform="translate(9.5 -1) scale(.62)">${cube()}</g><g transform="translate(5 8) scale(.62)">${cube()}</g>`),
  newComponent: svg(`<g transform="translate(-1 1) scale(.75)">${cube()}</g><circle cx="18" cy="18" r="4.6" fill="${G}" stroke="#fff" stroke-width="1"/><path d="M18 15.6 V20.4 M15.6 18 H20.4" stroke="#fff" stroke-width="1.6"/>`),
  joint: jointBase(`<circle cx="12" cy="12" r="4.2" fill="#fff" stroke="${O}" stroke-width="1.8"/><circle cx="12" cy="12" r="1.4" fill="${O}"/><path d="M12 7.8 V2.5" stroke="${B}" stroke-width="1.6"/>`),
  jointRigid: jointBase(`<rect x="8" y="8" width="8" height="8" fill="#fff" stroke="${O}" stroke-width="1.8"/><path d="M8 8 L16 16 M16 8 L8 16" stroke="${O}" stroke-width="1.2"/>`),
  jointRevolute: jointBase(`<circle cx="12" cy="12" r="2" fill="${O}"/><path d="M6.5 13.5 A5.8 5.8 0 1 1 13.5 17.6" fill="none" stroke="${O}" stroke-width="1.8"/><path d="M11 15.8 L13.8 17.7 L11.6 20" fill="none" stroke="${O}" stroke-width="1.6"/>`),
  jointSlider: jointBase(`<path d="M5 17 L19 7" stroke="${O}" stroke-width="1.8"/><path d="M15 6.3 L19 7 L17.6 10.6 M8.9 17.7 L5 17 L6.4 13.4" fill="none" stroke="${O}" stroke-width="1.6"/><rect x="10" y="10" width="4" height="4" fill="#fff" stroke="${K}" stroke-width=".9" transform="rotate(-35 12 12)"/>`),
  jointCylindrical: jointBase(`<path d="M12 4 V20" stroke="${O}" stroke-width="1.6"/><ellipse cx="12" cy="12" rx="6" ry="2.6" fill="none" stroke="${O}" stroke-width="1.8"/><path d="M10 2.8 L12 1 L14 2.8" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  jointBall: jointBase(`<circle cx="12" cy="12" r="5" fill="#fff" stroke="${O}" stroke-width="1.8"/><ellipse cx="12" cy="12" rx="5" ry="1.8" fill="none" stroke="${O}" stroke-width="1"/>`),
  ground: svg(`<path d="M12 3 a3.2 3.2 0 1 1 -0.01 0Z" fill="${O}" stroke="${K}" stroke-width=".9"/><path d="M12 9.4 V17" stroke="${K}" stroke-width="1.7"/><path d="M4 18.5 H20" stroke="${K}" stroke-width="1.6"/><path d="M6 21 L8 18.5 M10 21 L12 18.5 M14 21 L16 18.5 M18 21 L20 18.5" stroke="${K}" stroke-width="1.1"/>`),
  pin: svg(`<path d="M9 3 H15 L14 9 L17 12 V13 H7 V12 L10 9Z" fill="currentColor"/><path d="M12 13 V21" stroke="currentColor" stroke-width="1.6"/>`),
  drive: svg(`<circle cx="12" cy="12" r="8.5" fill="${T}" stroke="${K}"/><path d="M10 8 L16 12 L10 16Z" fill="${G}" stroke="${K}" stroke-width=".8"/><path d="M3.5 8 A9 9 0 0 1 8 3.5" fill="none" stroke="${O}" stroke-width="1.6"/>`),
});
export const jointIcon = { rigid: "jointRigid", revolute: "jointRevolute", slider: "jointSlider", cylindrical: "jointCylindrical", ball: "jointBall" };

export const featureIcon = {
  import: "insert",
  sketch: "sketchSmall", extrude: "extrude", revolve: "revolve", fillet: "fillet", chamfer: "chamfer",
  shell: "shell", offsetFace: "offsetFace", box: "box", cylinder: "cylinder", sphere: "sphere", plane: "plane", remove: "remove", fastener: "bolt",
  stock: "stock", gear: "gear", insert: "hybrid", move: "move",
};

// shop stock (stockui.js): a rack of bar stock, a T-slot end, a pipe, a ball bearing, a stepper motor
Object.assign(icons, {
  stock: svg(`<path d="M3 15 L15 9 L21 12 L9 18Z" fill="${T}" stroke="${K}"/><path d="M3 15 V18 L9 21 V18Z" fill="${F}" stroke="${K}"/><path d="M9 18 V21 L21 15 V12Z" fill="${S}" stroke="${K}"/>
    <path d="M5 9 L14 4.5 L18 6.5 L9 11Z" fill="${B}" fill-opacity=".45" stroke="${K}"/><path d="M5 9 V11 L9 13 V11Z" fill="${F}" stroke="${K}"/><path d="M9 11 V13 L18 8.5 V6.5Z" fill="${S}" stroke="${K}"/>`),
  extrusion: svg(`<path d="M4 4 H20 V20 H4Z" fill="${F}" stroke="${K}"/><path d="M10 4 V7 H8 V10 H16 V7 H14 V4 M10 20 V17 H8 V14 H16 V17 H14 V20 M4 10 H7 V8 H10 V16 H7 V14 H4 M20 10 H17 V8 H14 V16 H17 V14 H20" fill="${T}" stroke="${K}" stroke-width=".9"/>
    <circle cx="12" cy="12" r="1.6" fill="#fff" stroke="${K}" stroke-width=".9"/>`),
  pipe: svg(`<path d="M7 6 H18 V18 H7" fill="${F}" stroke="${K}"/><path d="M7 6 V18" stroke="${K}"/><ellipse cx="7" cy="12" rx="3" ry="6" fill="${T}" stroke="${K}"/><ellipse cx="7" cy="12" rx="1.6" ry="4" fill="${S}" stroke="${K}" stroke-width=".8"/>
    <path d="M10 8 H17" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/>`),
  bearing: svg(`<circle cx="12" cy="12" r="9" fill="${F}" stroke="${K}"/><circle cx="12" cy="12" r="6.6" fill="${T}" stroke="${K}" stroke-width=".8"/><circle cx="12" cy="12" r="3.6" fill="${F}" stroke="${K}" stroke-width=".8"/><circle cx="12" cy="12" r="2" fill="#fff" stroke="${K}"/>
    <g fill="${S}" stroke="${K}" stroke-width=".6"><circle cx="12" cy="6.9" r="1.2"/><circle cx="17.1" cy="12" r="1.2"/><circle cx="12" cy="17.1" r="1.2"/><circle cx="6.9" cy="12" r="1.2"/><circle cx="15.6" cy="8.4" r="1.2"/><circle cx="8.4" cy="15.6" r="1.2"/><circle cx="15.6" cy="15.6" r="1.2"/><circle cx="8.4" cy="8.4" r="1.2"/></g>`),
  motor: svg(`<path d="M3 9 L5 7 H14 L16 9 V19 L14 21 H5 L3 19Z" fill="#4a4f57" stroke="${K}"/><path d="M3 11 H16 M3 17 H16" stroke="#8a919b" stroke-width=".8"/>
    <path d="M16 12 H18 V16 H16Z" fill="${F}" stroke="${K}" stroke-width=".8"/><path d="M18 13.2 H22 V14.8 H18Z" fill="${T}" stroke="${K}" stroke-width=".8"/><circle cx="9.5" cy="14" r="2" fill="${O}" stroke="${K}" stroke-width=".7"/>`),
});

// airfoil sketch, 2D flow, shape optimization (airfoil.js, cfd2d*.js, topo*.js)
Object.assign(icons, {
  airfoil: svg(`<path d="M3 13 C5 8 11 7.5 21 12.2 C13 14.5 6 15.5 3 13Z" fill="${T}" stroke="${K}"/>
    <path d="M3.4 13 L21 12.2" stroke="${B}" stroke-width=".9" stroke-dasharray="1.6 1.2"/>
    <text x="3" y="22" font-family="Arial" font-size="5.6" font-weight="700" fill="${O}">NACA</text>`),
  flow2d: svg(`<path d="M7 13 C8.5 9.5 12 9 18 12.4 C13 14 9.5 14.6 7 13Z" fill="${F}" stroke="${K}"/>
    <path d="M2 7 C7 6 12 6 22 8.5 M2 18 C8 18.5 14 17.5 22 15.5 M2 11 H5 M2 14.5 H5" fill="none" stroke="${B}" stroke-width="1.4"/>
    <path d="M19.5 6.6 L22 8.5 L19 9.4" fill="none" stroke="${B}" stroke-width="1.2"/>`),
  topo: svg(`<path d="M3 5 H21 V9 H3Z" fill="${F}" stroke="${K}" stroke-opacity=".35" stroke-dasharray="1.5 1.5"/>
    <path d="M3 5 H21 V8 C17 8 15.5 10 14.5 13 L13 19 H11 L9.5 13 C8.5 10 7 8 3 8Z" fill="${T}" stroke="${K}"/>
    <path d="M10 19 H14 V21 H10Z" fill="${S}" stroke="${K}"/>
    <path d="M2.5 4 L2.5 2 M21.5 4 L21.5 2" stroke="${K}" stroke-width=".9"/>
    <path d="M12 2.5 V7 M10.5 5.5 L12 7 L13.5 5.5" fill="none" stroke="${O}" stroke-width="1.6"/>`),
});

// gear wizard and motion links (gearui.js, assemblyui.js)
const gearPath = (cx, cy, r, z, ht, fill) => {
  const pts = [];
  for (let i = 0; i < z; i++) {
    const a = (i / z) * Math.PI * 2, w = Math.PI / z / 2;
    for (const [da, rr] of [[-w * 1.3, r], [-w * 0.6, r + ht], [w * 0.6, r + ht], [w * 1.3, r]]) pts.push(`${(cx + rr * Math.cos(a + da)).toFixed(2)} ${(cy + rr * Math.sin(a + da)).toFixed(2)}`);
  }
  return `<path d="M${pts.join(" L")}Z" fill="${fill}" stroke="${K}" stroke-width=".8"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.35).toFixed(2)}" fill="#fff" stroke="${K}" stroke-width=".8"/>`;
};
Object.assign(icons, {
  gear: svg(`${gearPath(9, 14, 5.6, 10, 1.8, F)}${gearPath(17.3, 7.2, 3.6, 7, 1.5, O)}`),
  gearLink: svg(`${gearPath(7.5, 12, 4.2, 8, 1.6, F)}${gearPath(17, 12, 4.2, 8, 1.6, F)}<path d="M5 3.5 A7 4 0 0 1 19 3.5" fill="none" stroke="${B}" stroke-width="1.4"/><path d="M17 1.8 L19.2 3.6 L16.6 4.6" fill="none" stroke="${B}" stroke-width="1.2"/>`),
});

// ribbon tabs: settings cog, McMaster-Carr, and the placeholder tools on the Surface / Sheet Metal /
// Plastic / CAM / Render / Animate tabs (most of those are under construction)
const sheet = (d) => `<path d="${d}" fill="${F}" stroke="${K}"/>`;
Object.assign(icons, {
  appearance: svg(`<defs><radialGradient id="apG" cx=".35" cy=".35"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9534f"/></radialGradient></defs><circle cx="10" cy="13" r="7.5" fill="url(#apG)" stroke="${K}"/><path d="M18 3 C18 3 21.5 7 21.5 9 A3.5 3.5 0 0 1 14.5 9 C14.5 7 18 3 18 3Z" fill="${B}" stroke="${K}" stroke-width=".9"/>`),
  physical: svg(`${cube(-1, 0, .9)}<path d="M14 15 H22 L20.5 22 H15.5Z" fill="#4a4f57" stroke="${K}" stroke-width=".9"/><circle cx="18" cy="14" r="1.6" fill="none" stroke="${K}" stroke-width="1.1"/><text x="18" y="20.6" font-size="4.6" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial">kg</text>`),
  settings: svg(`<path d="M10.3 2.5 H13.7 L14.2 5.2 L16.1 6.3 L18.7 5.3 L20.4 8.3 L18.3 10.1 V12.3 L20.4 14.1 L18.7 17.1 L16.1 16.1 L14.2 17.2 L13.7 19.9 H10.3 L9.8 17.2 L7.9 16.1 L5.3 17.1 L3.6 14.1 L5.7 12.3 V10.1 L3.6 8.3 L5.3 5.3 L7.9 6.3 L9.8 5.2Z" transform="translate(0 .8)" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/>`),
  mcmaster: svg(`<path d="M4 9 L12 5 L20 9 V17 L12 21 L4 17Z" fill="${T}" stroke="${K}"/><path d="M4 9 L12 13 L20 9 M12 13 V21" fill="none" stroke="${K}"/><path d="M15 2.5 H21.5 V9" fill="none" stroke="${G}" stroke-width="1.6"/><path d="M21.5 2.5 L15.5 8.5" stroke="${G}" stroke-width="1.6"/>`),
  studies: svg(`<path d="M4 4 H20 V20 H4Z" fill="${T}" stroke="${K}"/><path d="M7 9 H17 M7 13 H17 M7 17 H13" stroke="${K}"/><circle cx="18" cy="17.5" r="3.5" fill="${B}" stroke="#fff"/>`),
  // surface
  surfPatch: svg(`<path d="M4 15 Q8 6 13 9 T21 7 L20 17 Q15 20 11 17 T4 15Z" fill="${B}" fill-opacity=".3" stroke="${K}"/>`),
  sketchOffset: svg(`<rect x="7" y="8" width="10" height="8" rx="1" fill="none" stroke="${K}" stroke-width="1.4"/><rect x="3.5" y="4.5" width="17" height="15" rx="3" fill="none" stroke="${B}" stroke-width="1.8"/>`),
  offsetFace: svg(`<path d="M4 9 L12 5 L20 9 L20 17 L12 21 L4 17 Z" fill="none" stroke="${K}" stroke-width="1.3"/><path d="M4 9 L12 13 L20 9 M12 13 V21" fill="none" stroke="${K}" stroke-width="1.1"/><path d="M12 13 L20 9 L20 17 L12 21 Z" fill="${B}" opacity="0.45"/><path d="M16 15 L21.5 12.2 M19.6 11.6 L21.5 12.2 L20.6 14" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  surfOffset: svg(`<path d="M3 17 Q10 11 21 15" fill="none" stroke="${K}" stroke-width="1.4"/><path d="M3 11 Q10 5 21 9" fill="none" stroke="${B}" stroke-width="1.6" stroke-dasharray="2.5 1.5"/><path d="M12 13 V8 M10.5 9.5 L12 8 L13.5 9.5" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  thicken: svg(`<path d="M3 12 Q11 6 21 10 V14 Q11 10 3 16Z" fill="${F}" stroke="${K}"/><path d="M3 12 Q11 6 21 10" fill="none" stroke="${B}" stroke-width="1.6"/>`),
  stitch: svg(`<path d="M3 15 L11 11 V17 L3 21Z" fill="${B}" fill-opacity=".3" stroke="${K}"/><path d="M13 11 L21 7 V13 L13 17Z" fill="${B}" fill-opacity=".3" stroke="${K}"/><path d="M10 9 L14 13 M10 13 L14 9" stroke="${O}" stroke-width="1.5"/>`),
  trimSurf: svg(`<path d="M3 16 L12 10 L21 14 L12 20Z" fill="${B}" fill-opacity=".3" stroke="${K}"/><path d="M8 5 L16 22" stroke="#d6312b" stroke-width="1.6" stroke-dasharray="2 1.5"/>`),
  extendSurf: svg(`<path d="M3 16 L11 12 L15 15 L7 19Z" fill="${B}" fill-opacity=".3" stroke="${K}"/><path d="M11 12 L19 8 L22 10.5 L15 15" fill="none" stroke="${B}" stroke-dasharray="2 1.5"/><path d="M14 7 L19 8 L17 12" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  reverseNormal: svg(`<path d="M3 15 L12 11 L21 15 L12 19Z" fill="${B}" fill-opacity=".3" stroke="${K}"/><path d="M12 15 V4 M9.5 6.5 L12 4 L14.5 6.5" fill="none" stroke="${O}" stroke-width="1.5"/>`),
  // sheet metal
  flange: svg(`${sheet("M3 16 L13 11 L21 15 L11 20Z")}<path d="M13 11 V3 L21 7 V15" fill="${T}" stroke="${K}"/>`),
  bend: svg(`<path d="M3 18 L11 14 Q15 12 15 8 V3 L19 4 V8 Q19 15 13 18 L5 22Z" fill="${F}" stroke="${K}"/>`),
  unfold: svg(`${sheet("M2 17 L12 12 L22 17 L12 22Z")}<path d="M12 12 L19 3" stroke="${B}" stroke-dasharray="2 1.5" stroke-width="1.4"/><path d="M16 9 L19 3 L13 5" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  flatPattern: svg(`<path d="M3 9 H8 V4 H16 V9 H21 V15 H16 V20 H8 V15 H3Z" fill="${T}" stroke="${K}"/><path d="M8 9 H16 V15 H8Z" fill="none" stroke="${B}" stroke-dasharray="2 1.5"/>`),
  smRules: svg(`${sheet("M3 14 L12 10 L21 14 L12 18Z")}<path d="M5 8 H19 M5 5 H14" stroke="${K}" stroke-width="1.3"/>`),
  // plastic
  snapFit: svg(`<path d="M3 20 H21" stroke="${K}" stroke-width="1.6"/><path d="M8 20 V7 L12 5 L12 8 L10 9 V20Z" fill="${F}" stroke="${K}"/><path d="M13 20 V9 H17 L19 11 L16 12 V20Z" fill="${T}" stroke="${K}"/>`),
  lip: svg(`<path d="M3 16 H10 V12 H14 V16 H21 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M3 9 H9 V5 M15 5 V9 H21" fill="none" stroke="${B}" stroke-width="1.6"/>`),
  web: svg(`<path d="M3 20 H21 M3 20 V5 M21 20 V5" stroke="${K}" stroke-width="1.6"/><path d="M3 9 L21 17 M3 17 L21 9" stroke="${B}" stroke-width="1.8"/>`),
  rib: svg(`<path d="M3 20 H21 M5 20 V4" stroke="${K}" stroke-width="1.6"/><path d="M5 7 L18 20 H5Z" fill="${F}" stroke="${K}"/>`),
  boss: svg(`<path d="M3 17 L12 13 L21 17 L12 21Z" fill="${F}" stroke="${K}"/><path d="M9 9 V16 A3 1.4 0 0 0 15 16 V9" fill="${T}" stroke="${K}"/><ellipse cx="12" cy="9" rx="3" ry="1.4" fill="${S}" stroke="${K}"/><ellipse cx="12" cy="9" rx="1.2" ry=".6" fill="${K}"/>`),
  draft: svg(`<path d="M6 20 L9 5 H15 L18 20Z" fill="${F}" stroke="${K}"/><path d="M12 5 V20" stroke="${B}" stroke-dasharray="2 1.5"/><path d="M15 5 L18 20" stroke="${O}" stroke-width="1.6"/>`),
  ruleFillet: svg(`<path d="M4 20 V10 Q4 4 10 4 H20" fill="none" stroke="${K}" stroke-width="1.6"/><path d="M8 20 V11 Q8 8 11 8 H20" fill="none" stroke="${B}" stroke-width="1.4"/><path d="M12 14 H20 M12 17 H20" stroke="${K}" stroke-width="1.1"/>`),
  rest: svg(`<path d="M3 11 H21 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M7 11 V8 H17 V11" fill="${T}" stroke="${K}"/><path d="M9 14 H15" stroke="${K}"/>`),
  // CAM
  camSetup: svg(`<path d="M3 15 L12 11 L21 15 L12 19Z" fill="${S}" stroke="${K}"/><path d="M12 3 V11 M12 11 L5 8 M12 11 L19 8" stroke="${K}"/><path d="M12 3 V7" stroke="${G}" stroke-width="2"/><circle cx="12" cy="11" r="1.4" fill="${O}"/>`),
  camStock: svg(`${cube(0, 0, 1)}<path d="M4 8 L12 4 L20 8" fill="none" stroke="${O}" stroke-dasharray="2 1.5"/>`),
  facing: svg(`<path d="M3 15 L12 11 L21 15 L12 19Z" fill="${T}" stroke="${K}"/><path d="M6 15 L12 12.3 M9 16.4 L15 13.6 M12 17.7 L18 15" stroke="${B}" stroke-width="1.3"/><path d="M11 2 V9 H13 V2Z" fill="${S}" stroke="${K}"/>`),
  adaptive: svg(`<path d="M4 18 C4 6 20 6 20 18" fill="none" stroke="${B}" stroke-width="1.4"/><path d="M7 18 C7 9 17 9 17 18 M10 18 C10 12 14 12 14 18" fill="none" stroke="${B}" stroke-width="1.4"/><path d="M3 20 H21" stroke="${K}" stroke-width="1.4"/>`),
  pocket: svg(`<path d="M3 6 H21 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M7 10 H17 V16 H7Z" fill="${S}" stroke="${K}"/><path d="M9 12 H15 V14 H9Z" fill="none" stroke="${B}" stroke-width="1.2"/>`),
  contourPath: svg(`<path d="M5 19 V9 Q5 5 9 5 H19 V19Z" fill="${F}" stroke="${K}"/><path d="M3 21 V9 Q3 3 9 3 H21" fill="none" stroke="${B}" stroke-width="1.5"/>`),
  parallel: svg(`<path d="M3 17 Q12 5 21 17" fill="${F}" stroke="${K}"/><path d="M6 13 V20 M9 10 V20 M12 9 V20 M15 10 V20 M18 13 V20" stroke="${B}" stroke-width="1.1"/>`),
  scallop: svg(`<path d="M3 18 Q12 4 21 18" fill="${F}" stroke="${K}"/><path d="M7 18 Q12 9 17 18 M10 18 Q12 14 14 18" fill="none" stroke="${B}" stroke-width="1.3"/>`),
  drill: svg(`<path d="M3 12 H21 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M10 2 H14 V9 L12 13 L10 9Z" fill="${S}" stroke="${K}"/><path d="M10 4 L14 6 M10 6.5 L14 8.5" stroke="${K}" stroke-width=".9"/>`),
  boreCam: svg(`<path d="M3 8 H21 V20 H3Z" fill="${F}" stroke="${K}"/><ellipse cx="12" cy="8" rx="5" ry="1.8" fill="${K}"/><path d="M7 8 V18 M17 8 V18" stroke="${B}" stroke-dasharray="2 1.5"/>`),
  slotCam: svg(`<path d="M3 8 H21 V20 H3Z" fill="${F}" stroke="${K}"/><rect x="6" y="11" width="12" height="4" rx="2" fill="${S}" stroke="${K}"/>`),
  simToolpath: svg(`<path d="M3 20 H21" stroke="${K}" stroke-width="1.4"/><path d="M4 17 Q8 9 12 15 T20 11" fill="none" stroke="${B}" stroke-width="1.5"/><path d="M8 4 L16 8.5 L8 13Z" fill="${G}" stroke="${K}" stroke-width=".8"/>`),
  post: svg(`<path d="M5 3 H14 L19 8 V21 H5Z" fill="${T}" stroke="${K}"/><text x="12" y="17" font-size="6.5" font-weight="700" text-anchor="middle" fill="${B}" font-family="Consolas, monospace">G01</text>`),
  setupSheet: svg(`<path d="M5 3 H19 V21 H5Z" fill="${T}" stroke="${K}"/><path d="M8 7 H16 M8 10 H16 M8 13 H13" stroke="${K}"/><path d="M8 16 H16 V19 H8Z" fill="${F}" stroke="${K}" stroke-width=".8"/>`),
  toolLibrary: svg(`<path d="M5 3 H8 V14 L6.5 17 L5 14Z" fill="${S}" stroke="${K}"/><path d="M10.5 3 H13.5 V15 Q12 18 10.5 15Z" fill="${S}" stroke="${K}"/><path d="M16 3 H19 V12 L17.5 15 L16 12Z" fill="${S}" stroke="${K}"/><path d="M3 20 H21" stroke="${K}" stroke-width="1.6"/>`),
  // render / animate
  scene: svg(`<path d="M3 17 L12 13 L21 17 L12 21Z" fill="${F}" stroke="${K}"/><circle cx="17" cy="6" r="3" fill="#f6d44a" stroke="${K}"/><path d="M6 13 L9 8 L12 13" fill="${T}" stroke="${K}"/>`),
  decal: svg(`${cube(0, 0, 1)}<path d="M13 13 L18 10.5 V15 L13 17.5Z" fill="${O}" stroke="${K}" stroke-width=".8"/>`),
  textureMap: svg(`<path d="M4 8 L12 4 L20 8 L12 12Z" fill="${T}" stroke="${K}"/><path d="M4 8 L12 12 V21 L4 17Z" fill="${F}" stroke="${K}"/><path d="M20 8 L12 12 V21 L20 17Z" fill="${S}" stroke="${K}"/><path d="M6 10.5 L10 12.5 M6 13.5 L10 15.5 M14 12.5 L18 10.5 M14 15.5 L18 13.5" stroke="${B}" stroke-width=".9"/>`),
  inCanvasRender: svg(`<path d="M3 5 H21 V18 H3Z" fill="${T}" stroke="${K}"/><circle cx="12" cy="11.5" r="4.5" fill="${F}" stroke="${K}"/><path d="M3 21 H21" stroke="${O}" stroke-width="2"/><path d="M3 21 H12" stroke="${G}" stroke-width="2"/>`),
  renderImg: svg(`<path d="M3 7 H8 L10 4 H14 L16 7 H21 V19 H3Z" fill="${T}" stroke="${K}"/><circle cx="12" cy="12.5" r="4" fill="${F}" stroke="${K}"/><circle cx="10.8" cy="11.3" r="1.2" fill="#fff"/>`),
  gallery: svg(`<path d="M3 6 H17 V17 H3Z" fill="${T}" stroke="${K}"/><path d="M6 9 H20 V20 H6Z" fill="${F}" stroke="${K}"/><path d="M8 18 L11 14 L14 17 L16 15 L18 18" fill="none" stroke="${B}" stroke-width="1.2"/>`),
  storyboard: svg(`<path d="M3 6 H21 V18 H3Z" fill="${T}" stroke="${K}"/><path d="M3 9 H21 M3 15 H21 M6 6 V9 M10 6 V9 M14 6 V9 M18 6 V9 M6 15 V18 M10 15 V18 M14 15 V18 M18 15 V18" stroke="${K}"/><path d="M10 10.5 L14 12 L10 13.5Z" fill="${G}"/>`),
  explode: svg(`<g transform="translate(-4 3) scale(.6)">${cube()}</g><g transform="translate(9 -2) scale(.6)">${cube()}</g><g transform="translate(9 10) scale(.6)">${cube()}</g><path d="M9 11 L12 9 M9 14 L12 16" stroke="${O}" stroke-width="1.3"/>`),
  callout: svg(`<path d="M4 4 H20 V14 H11 L6 19 V14 H4Z" fill="${T}" stroke="${K}"/><path d="M7 8 H17 M7 11 H14" stroke="${K}"/>`),
  publish: svg(`<path d="M3 5 H17 V17 H3Z" fill="${T}" stroke="${K}"/><path d="M17 9 L21 7 V15 L17 13Z" fill="${F}" stroke="${K}"/><path d="M8 8 L13 11 L8 14Z" fill="${G}"/>`),
});

// simulation study types (studytypes.js): most are under construction
const beam = (extra = "") => `<path d="M2 20 H6 M4 20 V6" stroke="${K}" stroke-width="1.6"/><path d="M2 4 L6 2 M2 7 L6 5 M2 10 L6 8" stroke="${K}" stroke-width=".8"/>${extra}`;
const heat = (c1 = "#e5442f", c2 = "#f6d44a") => `<defs><linearGradient id="htG${c1.slice(1)}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>`;
Object.assign(icons, {
  newStudy: svg(`<path d="M4 4 H16 V20 H4Z" fill="${T}" stroke="${K}"/><path d="M7 8 H13 M7 11 H13 M7 14 H11" stroke="${K}"/><circle cx="17.5" cy="17.5" r="4.6" fill="${G}" stroke="#fff" stroke-width="1"/><path d="M17.5 15 V20 M15 17.5 H20" stroke="#fff" stroke-width="1.6"/>`),
  simInlet: svg(`<path d="M10 4 H21 V20 H10Z" fill="${F}" stroke="${K}"/><path d="M2 8 H9 M2 12 H11 M2 16 H9" stroke="${G}" stroke-width="1.6"/><path d="M8 6 L11 8 L8 10 M10 10 L13 12 L10 14 M8 14 L11 16 L8 18" fill="none" stroke="${G}" stroke-width="1.3"/>`),
  simOutlet: svg(`<path d="M3 4 H14 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M14 8 H21 M14 12 H22 M14 16 H21" stroke="${O}" stroke-width="1.6"/><path d="M19 6 L22 8 L19 10 M20 10 L23 12 L20 14 M19 14 L22 16 L19 18" fill="none" stroke="${O}" stroke-width="1.3"/>`),
  simSpring: svg(`<path d="M3 21 H21 M12 21 V18 L7 16.5 L17 14 L7 11.5 L17 9 L7 6.5 L12 5 V2" fill="none" stroke="${K}" stroke-width="1.4"/><path d="M8 2 H16" stroke="${K}" stroke-width="2"/>`),
  // internal flow: a bent duct with the flow through it
  internalFlow: svg(`<path d="M2 6 H11 Q19 6 19 14 V22 H13 V14 Q13 12 11 12 H2Z" fill="${F}" stroke="${K}"/><path d="M3 9 H10 Q16 9 16 15 V20" fill="none" stroke="${B}" stroke-width="1.6"/><path d="M14 18 L16 21 L18 18" fill="none" stroke="${B}" stroke-width="1.4"/>`),
  // pump / fan impeller in its volute
  turbomachinery: svg(`<path d="M12 2.5 A9.5 9.5 0 1 1 3.5 16 L3.5 21 H8" fill="${T}" stroke="${K}"/><circle cx="12" cy="12" r="2" fill="${S}" stroke="${K}"/><path d="M12 10 Q14 5 18 6 M14 12 Q19 14 18 18 M12 14 Q10 19 6 18 M10 12 Q5 10 6 6" fill="none" stroke="${B}" stroke-width="1.5"/>`),
  // linkage: crank, coupler, rocker
  multibody: svg(`<path d="M2 21 H22" stroke="${K}"/><path d="M5 19 L7 9 L17 6 L19 19" fill="none" stroke="${S}" stroke-width="2.6"/><path d="M5 19 L7 9 L17 6 L19 19" fill="none" stroke="${K}" stroke-width=".8"/><circle cx="5" cy="19" r="1.6" fill="#fff" stroke="${K}"/><circle cx="19" cy="19" r="1.6" fill="#fff" stroke="${K}"/><circle cx="7" cy="9" r="1.6" fill="${O}" stroke="${K}"/><circle cx="17" cy="6" r="1.6" fill="${O}" stroke="${K}"/><path d="M9 4 A4 4 0 0 0 4 6" fill="none" stroke="${B}" stroke-width="1.3"/><path d="M4 3.5 L4 6.3 L6.6 6" fill="none" stroke="${B}" stroke-width="1.2"/>`),
  // design points scattered over a grid
  designExploration: svg(`<path d="M3 3 V21 H21" fill="none" stroke="${K}"/><path d="M3 15 H21 M3 9 H21 M9 3 V21 M15 3 V21" stroke="${S}" stroke-width=".6" stroke-dasharray="1.5 1.5"/><circle cx="6" cy="17" r="1.5" fill="${B}"/><circle cx="11" cy="11" r="1.5" fill="${B}"/><circle cx="17" cy="14" r="1.5" fill="${B}"/><circle cx="13" cy="6" r="1.5" fill="${B}"/><circle cx="19" cy="8" r="1.5" fill="${G}" stroke="${K}" stroke-width=".6"/><circle cx="7" cy="7" r="1.5" fill="${B}"/>`),
  // search converging on the minimum of a curve
  parametricOptimization: svg(`<path d="M3 3 V21 H21" fill="none" stroke="${K}"/><path d="M4 6 Q11 24 20 7" fill="none" stroke="${B}" stroke-width="1.6"/><circle cx="6" cy="10" r="1.3" fill="${O}"/><circle cx="9" cy="15" r="1.3" fill="${O}"/><circle cx="12" cy="16.7" r="2" fill="${G}" stroke="${K}" stroke-width=".7"/><path d="M6.8 11.2 L8.3 13.8" stroke="${O}" stroke-width="1"/>`),
  // surface coloured by sensitivity with the push direction
  adjointShape: svg(`<defs><linearGradient id="adjG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f6fd6"/><stop offset=".5" stop-color="#f2f2f2"/><stop offset="1" stop-color="#e5442f"/></linearGradient></defs><path d="M2 18 Q8 8 13 12 T22 9 V21 H2Z" fill="url(#adjG)" stroke="${K}"/><path d="M6 8 V12.5 M4.5 11 L6 12.8 L7.5 11 M18 4 V9 M16.5 5.5 L18 3.8 L19.5 5.5" fill="none" stroke="${K}" stroke-width="1.2"/>`),
  designCheck: svg(`<path d="M12 2.5 L20 5.5 V11 C20 16 16.5 19.5 12 21.5 C7.5 19.5 4 16 4 11 V5.5Z" fill="${T}" stroke="${K}"/><path d="M8 11.5 L11 14.5 L16.5 8.5" fill="none" stroke="${G}" stroke-width="2"/>`),
  nonlinear: svg(`${beam(`<path d="M4 8 Q12 8 20 17" fill="none" stroke="${B}" stroke-width="3.2"/><path d="M4 8 H20" stroke="${K}" stroke-dasharray="2 1.5" stroke-width=".9"/>`)}<path d="M20 17 V22 M18.5 20.5 L20 22 L21.5 20.5" fill="none" stroke="${O}" stroke-width="1.3"/>`),
  modal: svg(`${beam(`<path d="M4 12 C9 4 14 20 20 12" fill="none" stroke="${B}" stroke-width="2.4"/><path d="M4 12 C9 20 14 4 20 12" fill="none" stroke="${S}" stroke-width="1.2" stroke-dasharray="2 1.5"/>`)}`),
  buckling: svg(`<path d="M3 21 H21 M3 3 H21" stroke="${K}" stroke-width="1.6"/><path d="M12 3 C6 9 6 15 12 21" fill="none" stroke="${B}" stroke-width="3"/><path d="M12 3 V21" stroke="${K}" stroke-dasharray="2 1.5" stroke-width=".9"/><path d="M17 1 V5 M15.5 3.5 L17 5 L18.5 3.5" fill="none" stroke="${O}" stroke-width="1.3"/>`),
  quasiStatic: svg(`<path d="M3 20 H21" stroke="${K}" stroke-width="1.6"/><path d="M5 20 V12 H13 V20" fill="${F}" stroke="${K}"/><path d="M13 14 H19 V20" fill="${T}" stroke="${K}"/><path d="M9 3 V10 M7 8 L9 10 L11 8" fill="none" stroke="${O}" stroke-width="1.4"/><path d="M15 6 H21" stroke="${B}" stroke-width="1.2"/><path d="M15 9 L21 6" stroke="${B}" stroke-width="1.2"/>`),
  dynamicEvent: svg(`<path d="M3 21 H21" stroke="${K}" stroke-width="1.6"/><path d="M8 13 L14 13 L14 19 L8 19Z" fill="${F}" stroke="${K}" transform="rotate(18 11 16)"/><path d="M3 4 L7 8 M6 2 L9 7 M11 2 L11 7" stroke="${O}" stroke-width="1.4"/><path d="M15 20 L17 17 M18 21 L21 18" stroke="#d6312b" stroke-width="1.3"/>`),
  thermal: svg(`${heat()}<path d="M10 3 A2 2 0 0 1 14 3 V14 A4 4 0 1 1 10 14Z" fill="#fff" stroke="${K}"/><path d="M11 9 H13 V15.5 A2.6 2.6 0 1 1 11 15.5Z" fill="url(#htGe5442f)"/>`),
  thermalStress: svg(`${heat("#e5442f", "#3c7fd1")}<path d="M3 15 H21 V20 H3Z" fill="url(#htGe5442f)" stroke="${K}"/><path d="M3 15 Q12 9 21 15" fill="none" stroke="${K}" stroke-dasharray="2 1.5"/><path d="M7 3 Q9 6 7 9 M12 2 Q14 5 12 8 M17 3 Q19 6 17 9" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  electronicsCooling: svg(`<path d="M3 13 H21 V20 H3Z" fill="#2f7d4a" stroke="${K}"/><path d="M8 10 H16 V13 H8Z" fill="#33363b" stroke="${K}"/><path d="M6 20 V22 M10 20 V22 M14 20 V22 M18 20 V22" stroke="${K}"/><path d="M5 9 Q7 6 5 3 M12 8 Q14 5 12 2 M19 9 Q21 6 19 3" fill="none" stroke="${B}" stroke-width="1.4"/>`),
  injectionMolding: svg(`<path d="M2 7 H9 V12 H2Z" fill="${S}" stroke="${K}"/><path d="M9 9 H12" stroke="${K}" stroke-width="1.6"/><path d="M12 4 H22 V20 H12Z" fill="${T}" stroke="${K}"/><path d="M12 9.5 C15 9.5 15 13 18 13 S22 16 22 16 V20 H12Z" fill="${O}" fill-opacity=".75" stroke="none"/><path d="M12 4 H22 V20 H12Z" fill="none" stroke="${K}"/>`),
  aeroLoads: svg(`<path d="M2 6 H10 M2 10 H8 M2 14 H10" stroke="${B}" stroke-width="1.5"/><path d="M8 4.5 L10 6 L8 7.5" fill="none" stroke="${B}" stroke-width="1.2"/><path d="M12 4 H16 V21 H12Z" fill="${F}" stroke="${K}"/><path d="M16 4 Q21 10 16 21" fill="none" stroke="#e5442f" stroke-width="2"/><path d="M10 20 H18" stroke="${K}" stroke-width="1.6"/>`),
  fatigue: svg(`<path d="M3 12 C5 5 7 5 9 12 S13 19 15 12 S19 5 21 12" fill="none" stroke="${B}" stroke-width="1.6"/><path d="M3 21 H21" stroke="${K}"/><path d="M14 2 L12 7 L15 8 L12.5 13" fill="none" stroke="#d6312b" stroke-width="1.4"/>`),
});

// simulation setup tools (studysetup.js): constraints, loads, contacts, thermal, mesh, solve, results
const part = `<path d="M5 9 L13 5 L21 9 L13 13Z" fill="${T}" stroke="${K}"/><path d="M5 9 L13 13 V20 L5 16Z" fill="${F}" stroke="${K}"/><path d="M21 9 L13 13 V20 L21 16Z" fill="${S}" stroke="${K}"/>`;
const arrow = (x1, y1, x2, y2, c = O) => { const a = Math.atan2(y2 - y1, x2 - x1), l = 2.6; const p = (d) => `${(x2 - l * Math.cos(a + d)).toFixed(1)} ${(y2 - l * Math.sin(a + d)).toFixed(1)}`; return `<path d="M${x1} ${y1} L${x2} ${y2} M${p(0.5)} L${x2} ${y2} L${p(-0.5)}" fill="none" stroke="${c}" stroke-width="1.6"/>`; };
const lock = (x, y, c = "#3c7fd1") => `<rect x="${x}" y="${y + 3}" width="6" height="5" fill="${c}" stroke="${K}" stroke-width=".7"/><path d="M${x + 1.2} ${y + 3} V${y + 1.5} a1.8 1.8 0 0 1 3.6 0 V${y + 3}" fill="none" stroke="${K}" stroke-width=".9"/>`;
Object.assign(icons, {
  simFixed: svg(`${part}${lock(1, 13)}`),
  simPin: svg(`${part}<circle cx="5" cy="17" r="3.4" fill="#fff" stroke="#3c7fd1" stroke-width="1.5"/><circle cx="5" cy="17" r="1" fill="#3c7fd1"/>`),
  simFrictionless: svg(`${part}<path d="M1 21 H11" stroke="#3c7fd1" stroke-width="1.6"/><circle cx="3.5" cy="19" r="1.4" fill="#fff" stroke="#3c7fd1"/><circle cx="8" cy="19" r="1.4" fill="#fff" stroke="#3c7fd1"/>`),
  simDisplacement: svg(`${part}${arrow(1, 20, 8, 20, "#3c7fd1")}<path d="M1 17 V22" stroke="#3c7fd1" stroke-width="1.2"/>`),
  simForce: svg(`${part}${arrow(13, 0.5, 13, 8)}`),
  simPressure: svg(`${part}${arrow(8, 0.5, 8, 6)}${arrow(13, 0.5, 13, 5)}${arrow(18, 0.5, 18, 6)}`),
  simMoment: svg(`${part}<path d="M8 4.5 A5.5 3 0 1 1 18.5 6" fill="none" stroke="${O}" stroke-width="1.6"/><path d="M16 6.2 L18.6 6.2 L18.3 3.6" fill="none" stroke="${O}" stroke-width="1.4"/>`),
  simBearing: svg(`<ellipse cx="12" cy="13" rx="8" ry="8" fill="${F}" stroke="${K}"/><circle cx="12" cy="13" r="4.5" fill="#fff" stroke="${K}"/><path d="M8.5 15 Q12 19 15.5 15" fill="none" stroke="${O}" stroke-width="2.2"/>${arrow(12, 1, 12, 8)}`),
  simRemote: svg(`${part}<circle cx="4" cy="4" r="2" fill="${O}"/><path d="M4 4 L9 9" stroke="${O}" stroke-dasharray="1.6 1.2"/>${arrow(4, 4, 1.5, 11)}`),
  simGravity: svg(`${part}<text x="3.5" y="7" font-size="7" font-weight="700" fill="${O}" font-family="Arial">g</text>${arrow(5, 8, 5, 14)}`),
  simMass: svg(`${part}<path d="M1 3 H9 L8 10 H2Z" fill="#4a4f57" stroke="${K}" stroke-width=".9"/><circle cx="5" cy="2.4" r="1.3" fill="none" stroke="${K}"/>`),
  simSteps: svg(`<path d="M3 20 H21 M3 20 V3" stroke="${K}" stroke-width="1.3"/><path d="M3 18 H7 V14 H11 V10 H15 V6 H20" fill="none" stroke="${B}" stroke-width="1.8"/>`),
  simContact: svg(`<path d="M2 14 L10 10 L10 17 L2 21Z" fill="${F}" stroke="${K}"/><path d="M14 10 L22 6 V13 L14 17Z" fill="${T}" stroke="${K}"/><path d="M10 10 L14 10 M10 17 L14 17" stroke="${O}" stroke-width="1.4"/><path d="M11 13.5 H13" stroke="${O}" stroke-width="2.2"/>`),
  simVelocity: svg(`${part}${arrow(1, 4, 9, 4, B)}<path d="M1 7 H6" stroke="${B}" stroke-width="1"/>`),
  simWall: svg(`<path d="M3 21 H21" stroke="${K}" stroke-width="2"/><path d="M4 23 L6 21 M8 23 L10 21 M12 23 L14 21 M16 23 L18 21" stroke="${K}" stroke-width=".9"/><g transform="translate(0 -6) scale(.9) translate(1 0)">${part}</g>${arrow(12, 13, 12, 18, B)}`),
  simHeat: svg(`${part}<path d="M7 1 Q9 3.5 7 6 M11 0.5 Q13 3 11 5.5 M15 1 Q17 3.5 15 6" fill="none" stroke="#e5442f" stroke-width="1.5"/>`),
  simConvection: svg(`${part}<path d="M1 12 C3 9 1 6 3 3 M5 11 C7 8 5 5 7 2" fill="none" stroke="${B}" stroke-width="1.4"/>`),
  simRadiation: svg(`${part}<path d="M3 3 L7 6 M2 8 L6 8 M7 1 L8 5" stroke="#e5442f" stroke-width="1.4"/><circle cx="2.5" cy="2.5" r="1.4" fill="#f6d44a"/>`),
  simChip: svg(`<path d="M2 15 H22 V19 H2Z" fill="#2f7d4a" stroke="${K}"/><path d="M7 8 H17 V15 H7Z" fill="#33363b" stroke="${K}"/><path d="M9 8 V6 M12 8 V6 M15 8 V6" stroke="${K}"/><path d="M5 4 Q6.5 2 5 0.5 M19 4 Q20.5 2 19 0.5" fill="none" stroke="#e5442f" stroke-width="1.3"/>`),
  simHeatSink: svg(`<path d="M3 16 H21 V20 H3Z" fill="${S}" stroke="${K}"/><path d="M4 16 V5 H6 V16 M8 16 V5 H10 V16 M12 16 V5 H14 V16 M16 16 V5 H18 V16" fill="${F}" stroke="${K}" stroke-width=".9"/>`),
  simFan: svg(`<rect x="3" y="3" width="18" height="18" rx="2" fill="${T}" stroke="${K}"/><circle cx="12" cy="12" r="2" fill="${K}"/><path d="M12 10 C10 6 13 4 15 6 Z M14 12 C18 10 20 13 18 15 Z M12 14 C14 18 11 20 9 18 Z M10 12 C6 14 4 11 6 9 Z" fill="${B}" stroke="${K}" stroke-width=".7"/>`),
  simVent: svg(`<rect x="3" y="4" width="18" height="16" fill="${F}" stroke="${K}"/><path d="M6 8 H18 M6 11 H18 M6 14 H18 M6 17 H18" stroke="${K}" stroke-width="1.3"/>${arrow(20, 12, 23.5, 12, B)}`),
  simGate: svg(`<path d="M8 2 H16 L13.5 9 H10.5Z" fill="${S}" stroke="${K}"/><path d="M3 11 H21 V20 H3Z" fill="${T}" stroke="${K}"/><circle cx="12" cy="11" r="1.6" fill="${O}"/><path d="M12 13 Q8 15 6 18 M12 13 Q16 15 18 18" fill="none" stroke="${O}" stroke-width="1.2"/>`),
  simMesh: svg(`<path d="M3 19 L12 4 L21 19Z" fill="${T}" stroke="${K}"/><path d="M7.5 11.5 H16.5 M12 19 L7.5 11.5 M12 19 L16.5 11.5 M5.2 15.2 H18.8 M9.7 15.2 L12 11.5 L14.3 15.2" fill="none" stroke="${B}" stroke-width=".9"/>`),
  simPrecheck: svg(`<circle cx="12" cy="12" r="9" fill="${T}" stroke="${K}"/><path d="M7.5 12.5 L10.5 15.5 L16.5 9" fill="none" stroke="${G}" stroke-width="2"/>`),
  simSolve: svg(`<circle cx="12" cy="12" r="9.5" fill="${G}"/><path d="M9.5 7 L17 12 L9.5 17Z" fill="#fff"/>`),
  simResults: svg(`<defs><linearGradient id="srG" x1="0" x2="1"><stop offset="0" stop-color="#3c7fd1"/><stop offset=".5" stop-color="#4fbf5a"/><stop offset="1" stop-color="#e5442f"/></linearGradient></defs><path d="M3 15 L12 10 L21 15 L12 20Z" fill="url(#srG)" stroke="${K}"/><path d="M3 4 H21 V7 H3Z" fill="url(#srG)" stroke="${K}" stroke-width=".8"/>`),
  simCompare: svg(`<path d="M3 5 H11 V19 H3Z" fill="${T}" stroke="${K}"/><path d="M13 5 H21 V19 H13Z" fill="${F}" stroke="${K}"/><path d="M5 15 L9 9 M15 15 L19 11" stroke="${B}" stroke-width="1.5"/>`),
});

// CAM workspace: lathe (turning), 3D printer (additive), laser (cutting)
Object.assign(icons, {
  lathe: svg(`<path d="M2 8 H7 V16 H2Z" fill="${S}" stroke="${K}"/><path d="M7 10 H19 V14 H7Z" fill="${F}" stroke="${K}"/><path d="M10 10 Q11 12 10 14 M14 10 Q15 12 14 14" fill="none" stroke="${K}" stroke-width=".8"/><path d="M15 21 L17 15 H20 L19 21Z" fill="${O}" stroke="${K}"/>`),
  printer: svg(`<path d="M3 3 H21 V21 H3Z" fill="none" stroke="${K}" stroke-width="1.3"/><path d="M3 7 H21" stroke="${K}"/><path d="M10 7 H14 V10 L12 12 L10 10Z" fill="${S}" stroke="${K}"/><path d="M7 18 H17 V15 H8Z" fill="${O}" stroke="${K}"/><path d="M5 18.5 H19" stroke="${K}" stroke-width="1.4"/>`),
  laser: svg(`<path d="M9 2 H15 V8 L12 10 L9 8Z" fill="${S}" stroke="${K}"/><path d="M12 10 V17" stroke="#e5442f" stroke-width="1.6"/><path d="M3 17 H21 V20 H3Z" fill="${F}" stroke="${K}"/><path d="M6 17 L10 17" stroke="#e5442f" stroke-width="1.4" stroke-dasharray="1.2 1"/><circle cx="12" cy="17" r="1.6" fill="#f6d44a"/>`),
});

// Tap and Die: a tap (fluted, threaded) beside a die (ring with a threaded bore)
icons.tapDie = svg(`<path d="M5 2 H9 V6 H5Z" fill="${S}" stroke="${K}"/><path d="M5.5 6 H8.5 V19 L7 22 L5.5 19Z" fill="${F}" stroke="${K}"/>
  <path d="M5.5 8.5 L8.5 7.5 M5.5 11 L8.5 10 M5.5 13.5 L8.5 12.5 M5.5 16 L8.5 15 M5.5 18.5 L8.5 17.5" stroke="${K}" stroke-width=".8"/>
  <circle cx="16.5" cy="14" r="6" fill="${T}" stroke="${K}"/><circle cx="16.5" cy="14" r="2.8" fill="#fff" stroke="${K}"/>
  <path d="M16.5 11.2 L17.4 12.4 M19.3 14 L18 14.8 M16.5 16.8 L15.6 15.6 M13.7 14 L15 13.2" stroke="${K}" stroke-width=".8"/>`);
// Hybrid design (a design with inserted designs): a part cube with a smaller design dropped in beside it
icons.hybrid = svg(`<g transform="translate(-1 3) scale(.8)">${cube()}</g><g transform="translate(10.5 -0.5) scale(.55)"><path d="M4 8 L12 4 L20 8 L12 12Z" fill="#fff" stroke="${B}" stroke-width="1.6"/><path d="M4 8 L12 12 L12 21 L4 17Z" fill="${B}" fill-opacity=".35" stroke="${B}" stroke-width="1.6"/><path d="M20 8 L12 12 L12 21 L20 17Z" fill="${B}" fill-opacity=".6" stroke="${B}" stroke-width="1.6"/></g>`);
