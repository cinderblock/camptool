/**
 * Math Camp's custom **hypar shade**: a 40′ × 40′ open shade canopy whose roof is
 * a hyperbolic paraboloid (a saddle) centered on the middle.
 *
 * Geometry (heights above ground):
 *   - the two ends of one diagonal sit at **10′**, the other diagonal at **6′**;
 *   - every edge midpoint — and the center — is **8′**;
 *   - the four edges are straight lines (the surface is doubly ruled), so the
 *     fabric runs as straight cable lines between the corner heights.
 *
 * Modeled as z(x,y) = MID + AMP·(2x/w)(2y/h) over the centered square, with
 * MID = 8′ and AMP = 2′ → corners (±w/2,±h/2) of matching sign = 10′, opposite
 * sign = 6′, the midlines + center = 8′.
 *
 * It's a `canopyShade` (cloth on legs): it blocks sun but not wind. The shade sim
 * casts the canopy's true warped silhouette to the ground (`shadowVolume`), and a
 * Lambert self-shade (`shadedFaces`) tints the lee side so the cloth shifts color
 * as the sun crosses the sky.
 */
import type {
  CampStructure,
  FootprintCtx,
  ShadowVertex,
  SunDir,
} from "@camptool/theme-contract";
import type { ReactNode } from "react";

const SIZE_FT = 40; // 40′ × 40′ footprint
const PEAK_FT = 10; // high diagonal corners
const LOW_FT = 6; // low diagonal corners
const MID_FT = (PEAK_FT + LOW_FT) / 2; // 8′ — midlines + center
const AMP_FT = (PEAK_FT - LOW_FT) / 2; // 2′ — saddle amplitude

/** Above-ground height (feet) of the canopy at centered local point (x,y) inside
 * the (w,h) box: a hyperbolic paraboloid. Corners of matching sign reach PEAK,
 * opposite sign reach LOW, the axes (x=0 or y=0) stay at MID. */
function zFtAt(x: number, y: number, w: number, h: number): number {
  return MID_FT + AMP_FT * ((2 * x) / w) * ((2 * y) / h);
}

/** Cloth color for a height fraction f ∈ [0,1] (0 = the 6′ valley, 1 = the 10′
 * ridge): a tan shade-cloth darkening into the low corners, brightening at the
 * high ones, so the saddle reads as a 3D height map from straight above. */
function clothColor(f: number): string {
  const LOW = [0x7a, 0x5c, 0x3e]; // shadowed valley brown
  const HIGH = [0xf0, 0xe2, 0xc8]; // sun-bright tan
  const c = LOW.map((lo, i) => Math.round(lo + ((HIGH[i] ?? lo) - lo) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// --- 3D helpers (footprint x,y + up = z), mirroring the Sierpinski structure. ---
type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Grid resolution for the rendered height map / self-shade facets. */
const GRID = 6;

/** Counter-rotated, upright two-line label centered at (x,y) feet (so it stays
 * map-upright as the canopy spins). */
function Label({
  x,
  y,
  lines,
  fs,
  rotation,
}: {
  x: number;
  y: number;
  lines: string[];
  fs: number;
  rotation: number;
}): ReactNode {
  return (
    <text
      x={x}
      y={y - (lines.length - 1) * fs * 0.5}
      transform={`rotate(${-rotation} ${x} ${y})`}
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
 * Top-down footprint: an N×N height map of the saddle (each cell tinted by its
 * own height so the high/low diagonals read as a 3D saddle from straight above),
 * the four straight cloth edges, corner height tags, and a center label. Drawn in
 * the 0,0→(w,h) feet box; geometry reflects under mirror while text stays upright.
 */
function renderFootprint({
  w,
  h,
  selected,
  rotation,
  mirror,
}: FootprintCtx): ReactNode {
  const cells: ReactNode[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const u0 = (i / GRID) * w;
      const u1 = ((i + 1) / GRID) * w;
      const v0 = (j / GRID) * h;
      const v1 = ((j + 1) / GRID) * h;
      // Height at the cell center → color (centered coords for the saddle math).
      const zc = zFtAt((u0 + u1) / 2 - w / 2, (v0 + v1) / 2 - h / 2, w, h);
      const f = (zc - LOW_FT) / (PEAK_FT - LOW_FT);
      cells.push(
        <polygon
          key={`c-${i}-${j}`}
          points={`${u0},${v0} ${u1},${v0} ${u1},${v1} ${u0},${v1}`}
          fill={clothColor(f)}
          stroke="#00000018"
          strokeWidth={0.1}
        />,
      );
    }
  }

  const fs = Math.max(1.4, Math.min(w, h) * 0.06);
  // Corner height tags (uncentered box corners): TL & BR are the high (10′)
  // diagonal, TR & BL the low (6′) diagonal — see zFtAt sign convention.
  const corners: { x: number; y: number; ft: number }[] = [
    { x: 0, y: 0, ft: PEAK_FT },
    { x: w, y: 0, ft: LOW_FT },
    { x: w, y: h, ft: PEAK_FT },
    { x: 0, y: h, ft: LOW_FT },
  ];

  return (
    <g>
      <g transform={mirror ? `translate(${w} 0) scale(-1 1)` : undefined}>
        {cells}
        {/* The four straight cloth edges (the ruled boundary). */}
        <polygon
          points={`0,0 ${w},0 ${w},${h} 0,${h}`}
          fill="none"
          stroke={selected ? "#1c1c1c" : "#5a4632"}
          strokeWidth={selected ? 0.8 : 0.5}
        />
        {/* The two diagonals: solid = high ridge (10′→10′), dashed = low (6′→6′). */}
        <line x1={0} y1={0} x2={w} y2={h} stroke="#5a4632" strokeWidth={0.3} />
        <line
          x1={w}
          y1={0}
          x2={0}
          y2={h}
          stroke="#5a4632"
          strokeWidth={0.3}
          strokeDasharray="1.4 1"
        />
      </g>
      {corners.map((c) => (
        <text
          key={`ht-${c.x}-${c.y}`}
          x={mirror ? w - c.x : c.x}
          y={c.y}
          dx={(mirror ? w - c.x : c.x) < w / 2 ? 1.4 : -1.4}
          dy={c.y < h / 2 ? 2.2 : -1.2}
          textAnchor={(mirror ? w - c.x : c.x) < w / 2 ? "start" : "end"}
          transform={`rotate(${-rotation} ${mirror ? w - c.x : c.x} ${c.y})`}
          fontSize={fs * 0.8}
          fontWeight={700}
          fill="#1c1c1c"
          stroke="#fff"
          strokeWidth={fs * 0.16}
          paintOrder="stroke"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {c.ft}′
        </text>
      ))}
      <Label
        x={w / 2}
        y={h / 2}
        lines={["Hypar", "Shade"]}
        fs={fs}
        rotation={rotation}
      />
    </g>
  );
}

/** Legend/tray icon: the saddle height map at a glance. */
function renderIcon(size: number): ReactNode {
  const pad = size * 0.12;
  const box = size - 2 * pad;
  const n = 4;
  const cells: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const zc = zFtAt(
        ((i + 0.5) / n) * box - box / 2,
        ((j + 0.5) / n) * box - box / 2,
        box,
        box,
      );
      const f = (zc - LOW_FT) / (PEAK_FT - LOW_FT);
      cells.push(
        <rect
          key={`i-${i}-${j}`}
          x={pad + (i / n) * box}
          y={pad + (j / n) * box}
          width={box / n + 0.5}
          height={box / n + 0.5}
          fill={clothColor(f)}
        />,
      );
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {cells}
      <rect
        x={pad}
        y={pad}
        width={box}
        height={box}
        fill="none"
        stroke="#5a4632"
        strokeWidth={size * 0.03}
      />
    </svg>
  );
}

/**
 * Cast-shadow silhouette: the canopy's four corners at their true saddle heights
 * (z as a fraction of `tallFt`). The core projects each away from the sun and
 * hulls them — because a hypar is a doubly-ruled bilinear surface with straight
 * edges, its shadow is exactly the quadrilateral of the four projected corners,
 * so four vertices give the geometrically correct ground shade (no extra
 * tessellation needed). One part: the floating canopy.
 */
function shadowVolume(w: number, h: number): ShadowVertex[][] {
  const corner = (sx: number, sy: number): ShadowVertex => ({
    x: (sx * w) / 2,
    y: (sy * h) / 2,
    z: zFtAt((sx * w) / 2, (sy * h) / 2, w, h) / PEAK_FT,
  });
  return [[corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]];
}

/** Max dark-overlay opacity for the most-shaded (fully lee) facet. */
const MAX_SHADE = 0.45;

/**
 * Self-shading: tessellate the saddle into an N×N grid of facets and tint each by
 * a Lambert term against the sun's local direction, so the lee side of the canopy
 * darkens and the gradient slides across the cloth as the sun moves. Points are in
 * the uncentered 0,0→(w,h) box; heights/normals use the saddle's real feet.
 */
function shadedFaces(
  w: number,
  h: number,
  sun: SunDir,
): ReadonlyArray<{
  points: ReadonlyArray<{ x: number; y: number }>;
  shade: number;
}> {
  const S: V3 = [sun.x, sun.y, sun.up]; // unit toward the sun
  const vert = (u: number, v: number): V3 => [
    u,
    v,
    zFtAt(u - w / 2, v - h / 2, w, h),
  ];
  const faces: { points: { x: number; y: number }[]; shade: number }[] = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const u0 = (i / GRID) * w;
      const u1 = ((i + 1) / GRID) * w;
      const v0 = (j / GRID) * h;
      const v1 = ((j + 1) / GRID) * h;
      const a = vert(u0, v0);
      const b = vert(u1, v0);
      const c = vert(u1, v1);
      const d = vert(u0, v1);
      // Upward normal of the cell (averaged via the two diagonals' cross product).
      let n = cross3(sub3(c, a), sub3(d, b));
      if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
      const nLen = Math.hypot(n[0], n[1], n[2]) || 1;
      const lambert = Math.max(0, dot3(n, S) / nLen); // |S| = 1
      faces.push({
        points: [
          { x: u0, y: v0 },
          { x: u1, y: v0 },
          { x: u1, y: v1 },
          { x: u0, y: v1 },
        ],
        shade: (1 - lambert) * MAX_SHADE,
      });
    }
  }
  return faces;
}

export const hyparShade: CampStructure = {
  value: "hypar-shade",
  label: "Hypar Shade",
  color: "#b08968",
  w: SIZE_FT,
  h: SIZE_FT,
  shape: "custom",
  vehicle: false,
  rigid: true, // a fixed 40′×40′ build — no free resize
  group: "Camp",
  tags: ["structure"],
  personal: false, // officer-placed communal shade
  canopyShade: true, // open cloth canopy: blocks sun, porous to wind
  tallFt: PEAK_FT, // the 10′ high corners drive the height
  fixedTall: true, // height set by the saddle geometry, not user-editable
  // No `footprint`: a square's true outline IS its bounding box (core default).
  renderFootprint,
  renderIcon,
  shadowVolume,
  shadedFaces,
};
