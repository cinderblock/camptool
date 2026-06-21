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

/** Rotate a vector by `deg` (screen coords, +y down). */
function rot(v: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/**
 * Flying-buttress canopy at the **bar corner** (A). A hexagon of 6 equilateral
 * triangles shares its apex at A (edge = the 10′ small-tetra edge): one sits
 * INSIDE the pyramid, the other **5 fly OUTSIDE** the footprint — the flying
 * shade. The outer flying vertices get support sticks to the ground. The whole
 * canopy floats at ~8′2″. Returns the 5 flying triangles + the stick footings
 * (object-local feet, in the 0,0→(w,h) frame).
 */
function flyingButtress(
  w: number,
  h: number,
): {
  flying: [Pt, Pt, Pt][];
  sticks: Pt[];
  verts: Pt[]; // the 6 hexagon vertices (for the cast shadow)
} {
  const A: Pt = [w / 2, 0]; // bar corner
  const B: Pt = [0, h];
  const edge = w / 4; // 10′ for a 40′ pyramid
  // Hexagon center = the corner small-tetra's centroid (the point ~8′ up, the peak
  // of the 10′ tetra at the bar). It sits inset from the corner by h/6.
  const O: Pt = [w / 2, h / 6];
  const dl = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const u: Pt = [(B[0] - A[0]) / dl, (B[1] - A[1]) / dl]; // unit A→B
  // 6 hexagon vertices around O (V0,V1 = the inside green triangle, pointing into
  // the pyramid; the rest fan outward).
  const V: Pt[] = [];
  for (let k = 0; k < 6; k++) {
    const d = rot(u, -60 * k);
    V.push([O[0] + d[0] * edge, O[1] + d[1] * edge]);
  }
  // Triangle (O,V0,V1) is inside; the next 5 fly outside (apex shared at O).
  const flying: [Pt, Pt, Pt][] = [];
  for (let k = 1; k < 6; k++) {
    const vk = V[k];
    const vn = V[(k + 1) % 6];
    if (vk && vn) flying.push([O, vk, vn]);
  }
  // The outer (flying) vertices need legs to the ground.
  const sticks: Pt[] = [V[2], V[3], V[4], V[5]].filter(
    (p): p is Pt => p !== undefined,
  );
  const verts: Pt[] = [...V];

  // --- Front extension: a flying-shade strip continuing PARTWAY along the front
  // edge (A→C, a fixed side — the Mirror toggle swaps it). A row of equilateral
  // triangles just outside the edge, with support sticks at the outer vertices. ---
  const C: Pt = [w, h];
  const cl = Math.hypot(C[0] - A[0], C[1] - A[1]) || 1;
  const uAC: Pt = [(C[0] - A[0]) / cl, (C[1] - A[1]) / cl]; // unit A→C
  const nAC: Pt = [uAC[1], -uAC[0]]; // outward normal (away from interior)
  const triH = edge * SQRT3_2;
  const onEdge = (t: number): Pt => [A[0] + uAC[0] * t, A[1] + uAC[1] * t];
  const onOuter = (t: number): Pt => [
    A[0] + uAC[0] * t + nAC[0] * triH,
    A[1] + uAC[1] * t + nAC[1] * triH,
  ];
  const startT = edge; // begin just past the hexagon
  const bays = 2; // partway across the 4-edge front
  for (let i = 0; i < bays; i++) {
    const b0 = onEdge(startT + i * edge);
    const b1 = onEdge(startT + (i + 1) * edge);
    const t0 = onOuter(startT + (i + 0.5) * edge);
    flying.push([b0, b1, t0]); // upright
    sticks.push(t0);
    verts.push(b0, b1, t0);
    if (i < bays - 1) {
      const t1 = onOuter(startT + (i + 1.5) * edge);
      flying.push([b1, t0, t1]); // inverted, fills the bay
      verts.push(t1);
    }
  }

  return { flying, sticks, verts };
}

/** Two-line label centered at (x,y), in feet. `rotation` is the object's rotation
 * (deg); we counter-rotate the text by `-rotation` about its anchor so it stays
 * upright to the map even as the pyramid spins. */
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
}) {
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
 * The footprint = the 3 UPWARD faces of the tetra, flattened to a top-down view:
 * three Sierpinski wedges meeting at the apex (which projects onto the base
 * centroid). Drawn in plot-local FEET (0,0→w,h). Each face's solids are tan and
 * its negative space (holes) blue. The 3 outer corners are the 3 ground medium
 * tetras → the "Group W Bar" / "lecture hall" labels; the apex (center) carries
 * the Pi stick.
 */
function renderFootprint({
  w,
  h,
  selected,
  rotation,
  mirror,
}: FootprintCtx): ReactNode {
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

  const bt = flyingButtress(w, h);
  return (
    <g>
      {/* Geometry reflects under mirror (x→w−x); text stays upright (drawn after,
          outside this group). */}
      <g transform={mirror ? `translate(${w} 0) scale(-1 1)` : undefined}>
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
        {/* Flying buttress: the elevated (~8′) flying-shade canopy at the bar
            corner — 5 triangles flying outside the footprint, dashed to read as
            "above ground", with support-stick footings. */}
        {bt.flying.map((t) => (
          <polygon
            key={`fly-${tri(t[0], t[1], t[2])}`}
            points={tri(t[0], t[1], t[2])}
            fill={TAN}
            fillOpacity={0.5}
            stroke="#7a5c3e"
            strokeWidth={0.25}
            strokeDasharray="1 0.7"
          />
        ))}
        {bt.sticks.map((p) => (
          <circle
            key={`stick-${p[0].toFixed(1)},${p[1].toFixed(1)}`}
            cx={p[0]}
            cy={p[1]}
            r={0.7}
            fill="#7a5c3e"
          />
        ))}
      </g>
      {labels.map((l) => (
        <Label
          key={`${l.lines.join()}-${l.at[0].toFixed(1)}`}
          x={l.at[0]}
          y={l.at[1]}
          lines={l.lines}
          fs={fs}
          rotation={rotation}
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
        transform={`rotate(${-rotation} ${G[0]} ${G[1]})`}
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

/** The true footprint outline (object-local centered feet): the base triangle.
 * Used for accurate border-overlap checks instead of the bounding box. */
function footprint(w: number, h: number): Array<{ x: number; y: number }> {
  return [
    { x: 0, y: -h / 2 }, // top corner
    { x: -w / 2, y: h / 2 }, // bottom-left
    { x: w / 2, y: h / 2 }, // bottom-right
  ];
}

/** Feet the Pi-symbol stick rises above the tetra apex. */
const PI_STICK_FT = 6;

/**
 * Solid-tetrahedron silhouette for the shade sim (centered local feet; z = a
 * fraction of tallFt). It's covered in shade cloth → a SOLID, so the cast shadow
 * is the convex hull of the four tetra vertices: the three ground corners (the
 * 40′ footprint triangle, z=0) plus the apex directly over the base centroid at
 * full height (z=1). The fractal voids don't pass light, and the convex hull of a
 * Sierpinski tetrahedron is the full tetrahedron. Plus the **Pi-symbol stick**,
 * ~6′ above the apex (also over the centroid), as a higher vertex (z>1) so its
 * shadow projects to the ground and the cast-shadow spike reaches it.
 */
function shadowVolume(w: number, h: number): ShadowVertex[][] {
  const apexY = (2 * h) / 3 - h / 2; // base centroid, centered
  const tetraH = w * Math.sqrt(2 / 3); // apex height (ft), edge = w
  const piZ = (tetraH + PI_STICK_FT) / tetraH; // π height as a fraction of tallFt (≈1.18)
  // The flying-buttress canopy floats at the peak of a 10′ tetra (8′2″); as a
  // fraction of the full tetra height that's 10/w.
  const flyZ = 10 / w;
  const bt = flyingButtress(w, h);
  return [
    // Part 1 — the solid tetra (base corners + apex + Pi stick): one hull.
    [
      { x: 0, y: -h / 2, z: 0 }, // top corner, ground
      { x: -w / 2, y: h / 2, z: 0 }, // bottom-left, ground
      { x: w / 2, y: h / 2, z: 0 }, // bottom-right, ground
      { x: 0, y: apexY, z: 1 }, // tetra apex, full height
      { x: 0, y: apexY, z: piZ }, // Pi symbol, 6′ above the apex
    ],
    // Part 2 — the flying-buttress canopy (separate flat shade at 8′2″): its own
    // hull, so it casts a distinct shadow rather than merging with the tetra.
    bt.verts.map((p) => ({ x: p[0] - w / 2, y: p[1] - h / 2, z: flyZ })),
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

/** Max dark-overlay opacity for the most-shaded (fully lee) face. */
const MAX_SHADE = 0.5;

/**
 * Per-face self-shading. The tetra has 3 slant faces — one over each base edge —
 * each projecting to its corner→centroid wedge. Each face gets a continuous
 * `shade` (dark-overlay opacity) from a Lambert term: `shade = (1 − max(0, n̂·Ŝ))
 * · MAX_SHADE`, so a face darkens SMOOTHLY as it turns from the sun rather than
 * snapping on — a face pointing at the sun is near-clear, the lee face is darkest,
 * and a high sun lifts the shade off all faces.
 */
function shadedFaces(w: number, h: number, sun: SunDir) {
  const A: V3 = [w / 2, 0, 0];
  const B: V3 = [0, h, 0];
  const C: V3 = [w, h, 0];
  const G: V3 = [w / 2, (2 * h) / 3, 0]; // base centroid
  const D: V3 = [G[0], G[1], w * Math.sqrt(2 / 3)]; // apex: height = edge·√(2/3), edge = w
  const S: V3 = [sun.x, sun.y, sun.up]; // unit toward the sun
  const faces: { p: V3; q: V3; wedge: V3[] }[] = [
    { p: A, q: B, wedge: [A, B, G] },
    { p: B, q: C, wedge: [B, C, G] },
    { p: C, q: A, wedge: [C, A, G] },
  ];
  return faces.map((f) => {
    let n = cross3(sub3(f.q, f.p), sub3(D, f.p));
    // Orient the normal outward (away from the base centroid G).
    const m: V3 = [
      (f.p[0] + f.q[0] + D[0]) / 3,
      (f.p[1] + f.q[1] + D[1]) / 3,
      (f.p[2] + f.q[2] + D[2]) / 3,
    ];
    if (dot3(n, sub3(m, G)) < 0) n = [-n[0], -n[1], -n[2]];
    const nLen = Math.hypot(n[0], n[1], n[2]) || 1;
    const lambert = Math.max(0, dot3(n, S) / nLen); // |S| = 1
    const shade = (1 - lambert) * MAX_SHADE;
    return { points: f.wedge.map((v) => ({ x: v[0], y: v[1] })), shade };
  });
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
  fixedTall: true, // a regular tetra — height is geometric, not user-set
  mirrorable: true, // chiral once the flying buttress has a side
  footprint,
  renderFootprint,
  renderIcon,
  shadowVolume,
  shadedFaces,
};
