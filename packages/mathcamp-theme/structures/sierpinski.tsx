/**
 * Math Camp's signature structure: a 3D **Sierpinski pyramid** (a regular
 * Sierpinski tetrahedron, 3 levels deep) captured as an honest 2D footprint.
 *
 * Physical structure:
 *   - small tetra  = 10′ edge
 *   - medium tetra = 4 smalls  → 20′ edge (3 on the ground + 1 held aloft)
 *   - large tetra  = 4 mediums → 40′ edge  ← the whole thing
 * It rests on one face, so its top-down shadow/footprint is an equilateral
 * **triangle, 40′ per edge** (bbox 40′ × 40·√3/2 ≈ 34.64′). The 3 corner
 * sub-triangles are the 3 ground medium tetras; the 4th medium hovers over the
 * center, so the middle is open, shaded gathering space. A regular 40′-edge
 * tetra stands ≈ 32.66′ tall (edge·√(2/3)); an 8′ Pi-symbol stick rides the apex
 * (directly above the centroid → the center marker below).
 *
 * Labels (camp-specific, baked in — this is a per-deployment package): the 3
 * ground medium tetras are one "Group W Bar" + two "lecture hall".
 */
import type {
  CampStructure,
  FootprintCtx,
  ShadowVertex,
  SunDir,
} from "@camptool/theme-contract";
import type { ReactNode } from "react";

const SQRT3_2 = Math.sqrt(3) / 2; // equilateral triangle height / edge
const EDGE_FT = 40;

type Pt = [number, number];
const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

// Sun-shade cloth colors: the solid (kept) triangles are tan; the Sierpinski
// negative space (the central "hole" at each level) is filled blue, not a void.
const TAN = "#d2b48c";
const BLUE = "#4dabf7";

type Cell = { pts: [Pt, Pt, Pt]; fill: string };

/** Fill-everything Sierpinski tessellation of triangle (a,b,c): the 3 corner
 * sub-triangles recurse (tan at the smallest level); the central/middle triangle
 * at each level is the negative space → blue. */
function sierpCells(a: Pt, b: Pt, c: Pt, depth: number, out: Cell[]) {
  if (depth === 0) {
    out.push({ pts: [a, b, c], fill: TAN });
    return;
  }
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  sierpCells(a, ab, ca, depth - 1, out);
  sierpCells(ab, b, bc, depth - 1, out);
  sierpCells(ca, bc, c, depth - 1, out);
  out.push({ pts: [ab, bc, ca], fill: BLUE });
}

const tri = (a: Pt, b: Pt, c: Pt) =>
  `${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]}`;

/** Two-line label centered at (x,y), in feet. */
function Label({
  x,
  y,
  lines,
  fs,
}: { x: number; y: number; lines: string[]; fs: number }) {
  return (
    <text
      x={x}
      y={y - (lines.length - 1) * fs * 0.5}
      textAnchor="middle"
      fontSize={fs}
      fontWeight={700}
      fill="#1c1c1c"
      stroke="#fff"
      strokeWidth={fs * 0.22}
      paintOrder="stroke"
      strokeLinejoin="round"
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      {lines.map((ln, i) => (
        <tspan key={ln} x={x} dy={i === 0 ? 0 : fs}>
          {ln}
        </tspan>
      ))}
    </text>
  );
}

/**
 * The footprint = the 3 UPWARD faces of the tetra, flattened to a top-down view:
 * three Sierpinski wedges meeting at the apex (which projects onto the base
 * centroid). Drawn in plot-local FEET (0,0→w,h). Each face's solids are tan and
 * its negative space (holes) blue. The 3 outer corners are the 3 ground medium
 * tetras → the "Group W Bar" / "lecture hall" labels; the apex (center) carries
 * the Pi stick.
 */
function renderFootprint({ w, h, selected }: FootprintCtx): ReactNode {
  const A: Pt = [w / 2, 0]; // base corner (footprint top)
  const B: Pt = [0, h]; // base corner (bottom-left)
  const C: Pt = [w, h]; // base corner (bottom-right)
  const G: Pt = [w / 2, (2 * h) / 3]; // apex, projected onto the base centroid

  // Each upward face projects to a wedge: the apex G + one base edge.
  const cells: Cell[] = [];
  sierpCells(G, A, B, 2, cells);
  sierpCells(G, B, C, 2, cells);
  sierpCells(G, C, A, 2, cells);

  const edge = Math.min(w, h / SQRT3_2); // current edge length (feet)
  const fs = Math.max(1.4, edge * 0.06); // label font ~2.4′ at 40′ edge

  // Labels sit in each outer corner (the 3 ground medium tetras), pulled in
  // toward the apex so they land inside the footprint.
  const lerp = (p: Pt, q: Pt, t: number): Pt => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
  ];
  const labels: { at: Pt; lines: string[] }[] = [
    { at: lerp(A, G, 0.42), lines: ["Group W", "Bar"] },
    { at: lerp(B, G, 0.42), lines: ["lecture", "hall"] },
    { at: lerp(C, G, 0.42), lines: ["lecture", "hall"] },
  ];

  return (
    <g>
      {cells.map((cell) => (
        <polygon
          key={tri(cell.pts[0], cell.pts[1], cell.pts[2])}
          points={tri(cell.pts[0], cell.pts[1], cell.pts[2])}
          fill={cell.fill}
          stroke="#00000022"
          strokeWidth={0.12}
        />
      ))}
      {/* Overall 40′ outline. */}
      <polygon
        points={tri(A, B, C)}
        fill="none"
        stroke={selected ? "#1c1c1c" : "#7a5c3e"}
        strokeWidth={selected ? 0.8 : 0.5}
      />
      {labels.map((l) => (
        <Label
          key={`${l.lines.join()}-${l.at[0].toFixed(1)}`}
          x={l.at[0]}
          y={l.at[1]}
          lines={l.lines}
          fs={fs}
        />
      ))}
      {/* Pi stick at the apex (over the centroid, where the 3 faces meet). */}
      <circle
        cx={G[0]}
        cy={G[1]}
        r={edge * 0.055}
        fill="#fff"
        stroke="#1c1c1c"
        strokeWidth={0.25}
      />
      <text
        x={G[0]}
        y={G[1] + fs * 0.36}
        textAnchor="middle"
        fontSize={fs}
        fontWeight={700}
        fill="#1c1c1c"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        π
      </text>
    </g>
  );
}

/** Small legend/tray icon — the 3-faces top-down look (tan/blue), shallow so it
 * stays legible at icon size. */
function renderIcon(size: number): ReactNode {
  const pad = size * 0.1;
  const w = size - 2 * pad;
  const hgt = w * SQRT3_2;
  const oy = (size - hgt) / 2;
  const A: Pt = [pad + w / 2, oy];
  const B: Pt = [pad, oy + hgt];
  const C: Pt = [pad + w, oy + hgt];
  const G: Pt = [pad + w / 2, oy + (2 * hgt) / 3];
  const cells: Cell[] = [];
  sierpCells(G, A, B, 1, cells);
  sierpCells(G, B, C, 1, cells);
  sierpCells(G, C, A, 1, cells);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {cells.map((cell) => (
        <polygon
          key={tri(cell.pts[0], cell.pts[1], cell.pts[2])}
          points={tri(cell.pts[0], cell.pts[1], cell.pts[2])}
          fill={cell.fill}
        />
      ))}
    </svg>
  );
}

/**
 * Solid-tetrahedron silhouette for the shade sim (centered local feet; z = a
 * fraction of tallFt). It's covered in shade cloth → a SOLID, so the cast shadow
 * is the convex hull of the four tetra vertices: the three ground corners (the
 * 40′ footprint triangle, z=0) plus the apex directly over the base centroid at
 * full height (z=1). The fractal voids don't pass light, and the convex hull of a
 * Sierpinski tetrahedron is the full tetrahedron — so this is the true shadow,
 * not the extruded bounding box the generic shade path would draw.
 */
function shadowVolume(w: number, h: number): ShadowVertex[] {
  return [
    { x: 0, y: -h / 2, z: 0 }, // footprint top corner (apex of the triangle), on ground
    { x: -w / 2, y: h / 2, z: 0 }, // bottom-left, ground
    { x: w / 2, y: h / 2, z: 0 }, // bottom-right, ground
    { x: 0, y: (2 * h) / 3 - h / 2, z: 1 }, // tetra apex over the base centroid, full height
  ];
}

// --- 3D helpers for slant-face lighting (footprint x,y + up = z). ---
type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Footprint polygons of the slant faces turned AWAY from the sun (the shady/lee
 * sides). The tetra has 3 slant faces — one over each base edge — and each
 * projects to its corner→centroid wedge. A face is in shade when its outward
 * normal points away from the sun (normal·sunDir ≤ 0); the sun's `up` component
 * means a high sun lights all faces, a low sun shades the lee ones.
 */
function shadedFaces(w: number, h: number, sun: SunDir) {
  const A: V3 = [w / 2, 0, 0];
  const B: V3 = [0, h, 0];
  const C: V3 = [w, h, 0];
  const G: V3 = [w / 2, (2 * h) / 3, 0]; // base centroid
  const D: V3 = [G[0], G[1], w * Math.sqrt(2 / 3)]; // apex: height = edge·√(2/3), edge = w
  const S: V3 = [sun.x, sun.y, sun.up];
  const faces: { p: V3; q: V3; wedge: V3[] }[] = [
    { p: A, q: B, wedge: [A, B, G] },
    { p: B, q: C, wedge: [B, C, G] },
    { p: C, q: A, wedge: [C, A, G] },
  ];
  const out: { x: number; y: number }[][] = [];
  for (const f of faces) {
    let n = cross3(sub3(f.q, f.p), sub3(D, f.p));
    // Orient the normal outward (away from the base centroid G).
    const m: V3 = [
      (f.p[0] + f.q[0] + D[0]) / 3,
      (f.p[1] + f.q[1] + D[1]) / 3,
      (f.p[2] + f.q[2] + D[2]) / 3,
    ];
    if (dot3(n, sub3(m, G)) < 0) n = [-n[0], -n[1], -n[2]];
    if (dot3(n, S) <= 0) out.push(f.wedge.map((v) => ({ x: v[0], y: v[1] })));
  }
  return out;
}

/** Regular 40′-edge tetra height = edge·√(2/3). */
const TETRA_TALL_FT = Math.round(EDGE_FT * Math.sqrt(2 / 3) * 10) / 10; // ≈ 32.7′

export const sierpinskiPyramid: CampStructure = {
  value: "sierpinski-pyramid",
  label: "Sierpinski Pyramid",
  color: "#6741d9",
  w: EDGE_FT,
  h: Math.round(EDGE_FT * SQRT3_2 * 100) / 100, // ≈ 34.64′
  shape: "custom",
  vehicle: false,
  rigid: true, // a fixed real structure — no free resize
  group: "Camp",
  tags: ["structure"],
  personal: false, // officer-placed communal landmark
  tallFt: TETRA_TALL_FT,
  renderFootprint,
  renderIcon,
  shadowVolume,
  shadedFaces,
};
