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
} from "@camptool/theme-contract";
import type { ReactNode } from "react";

const SQRT3_2 = Math.sqrt(3) / 2; // equilateral triangle height / edge
const EDGE_FT = 40;

type Pt = [number, number];
const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const centroid = (a: Pt, b: Pt, c: Pt): Pt => [
  (a[0] + b[0] + c[0]) / 3,
  (a[1] + b[1] + c[1]) / 3,
];

/** Recurse to the smallest (10′) tetra footprints — `depth` subdivisions. The
 * 3 corner sub-triangles recurse; the central inverted triangle is a void. */
function subdivide(a: Pt, b: Pt, c: Pt, depth: number, out: [Pt, Pt, Pt][]) {
  if (depth === 0) {
    out.push([a, b, c]);
    return;
  }
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  subdivide(a, ab, ca, depth - 1, out);
  subdivide(ab, b, bc, depth - 1, out);
  subdivide(ca, bc, c, depth - 1, out);
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

/** The footprint, drawn in plot-local FEET (0,0→w,h). Up-pointing triangle:
 * apex top-center, base along the bottom. */
function renderFootprint({ w, h, color, selected }: FootprintCtx): ReactNode {
  const A: Pt = [w / 2, 0]; // apex (top)
  const B: Pt = [0, h]; // bottom-left
  const C: Pt = [w, h]; // bottom-right

  // 9 smallest (10′) tetra footprints = a depth-2 Sierpinski triangle.
  const smalls: [Pt, Pt, Pt][] = [];
  subdivide(A, B, C, 2, smalls);

  // The 3 ground medium tetras = the corner half-triangles (for outlines + labels).
  const ab = mid(A, B);
  const bc = mid(B, C);
  const ca = mid(C, A);
  const corners: { pts: [Pt, Pt, Pt]; label: string[] }[] = [
    { pts: [A, ab, ca], label: ["Group W", "Bar"] },
    { pts: [ab, B, bc], label: ["lecture", "hall"] },
    { pts: [ca, bc, C], label: ["lecture", "hall"] },
  ];

  const edge = Math.min(w, h / SQRT3_2); // current edge length (feet)
  const fs = Math.max(1.4, edge * 0.06); // label font ~2.4′ at 40′ edge
  const stroke = selected ? "#1c1c1c" : color;
  const piCenter = centroid(ab, bc, ca); // = whole-triangle centroid → apex/Pi stick

  return (
    <g>
      {/* Filled small tetra footprints (the Sierpinski solid). */}
      {smalls.map((t) => (
        <polygon
          key={tri(t[0], t[1], t[2])}
          points={tri(t[0], t[1], t[2])}
          fill={color}
          fillOpacity={0.82}
          stroke={color}
          strokeWidth={0.18}
        />
      ))}
      {/* Medium-tetra (ground) outlines — delineate the 3 labeled volumes. */}
      {corners.map((cnr) => (
        <polygon
          key={tri(cnr.pts[0], cnr.pts[1], cnr.pts[2])}
          points={tri(cnr.pts[0], cnr.pts[1], cnr.pts[2])}
          fill="none"
          stroke={stroke}
          strokeOpacity={0.7}
          strokeWidth={0.4}
        />
      ))}
      {/* Overall 40′ outline. */}
      <polygon
        points={tri(A, B, C)}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? 0.7 : 0.5}
      />
      {/* Labels in each ground-tetra's open center. */}
      {corners.map((cnr) => {
        const ctr = centroid(cnr.pts[0], cnr.pts[1], cnr.pts[2]);
        return (
          <Label
            key={`${cnr.label.join()}-${ctr[0].toFixed(1)},${ctr[1].toFixed(1)}`}
            x={ctr[0]}
            y={ctr[1]}
            lines={cnr.label}
            fs={fs}
          />
        );
      })}
      {/* Pi stick rising from the apex (above the centroid) — the shadow-caster. */}
      <circle
        cx={piCenter[0]}
        cy={piCenter[1]}
        r={edge * 0.06}
        fill="#fff"
        stroke="#1c1c1c"
        strokeWidth={0.25}
      />
      <text
        x={piCenter[0]}
        y={piCenter[1] + fs * 0.36}
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

/** Small legend/tray icon — a depth-2 Sierpinski triangle filling the box. */
function renderIcon(size: number): ReactNode {
  const pad = size * 0.1;
  const w = size - 2 * pad;
  const hgt = w * SQRT3_2;
  const oy = (size - hgt) / 2;
  const A: Pt = [pad + w / 2, oy];
  const B: Pt = [pad, oy + hgt];
  const C: Pt = [pad + w, oy + hgt];
  const smalls: [Pt, Pt, Pt][] = [];
  subdivide(A, B, C, 2, smalls);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {smalls.map((t) => (
        <polygon
          key={tri(t[0], t[1], t[2])}
          points={tri(t[0], t[1], t[2])}
          fill="#6741d9"
          fillOpacity={0.85}
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
};
