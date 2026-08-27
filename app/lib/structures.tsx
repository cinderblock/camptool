/**
 * Shared structure palette for the camp map + the "Bringing" inventory page.
 * Each kind carries a footprint `shape`, default size (feet), and vehicle rules:
 * `vehicle` = fixed width + length-only; `rigid` = no free resize.
 *
 * (Later: a self-hoster's camp package can extend this registry with custom
 * kinds — see Phase 2.5 / the custom-structures task.)
 */
import type {
  CampStructure,
  FootprintCtx,
  Kind,
  KindTag,
  ShadowVertex,
  ShapeKind,
  StructureConfig,
} from "@camptool/theme-contract";
import type { ReactNode } from "react";
import { campStructures } from "~/theme";

// Palette types now live in the camp-theme contract (so a camp-theme package and
// the core app share one definition). Re-exported here so existing imports of
// `Kind`/`ShapeKind`/`KindTag` from `~/lib/structures` keep working.
export type { CampStructure, Kind, KindTag, ShapeKind, StructureConfig };

/** RV footprint = the body rectangle plus optional slide-out "pop-outs" on the
 * left/right sides (config `popoutL`/`popoutR`, in feet, over the middle 60% of
 * the length). Returned as an ordered, object-local CENTERED outline so the core
 * uses it for keep-inside / overlap / shade / wind — the deployed slide-outs take
 * up real space. */
function rvFootprint(
  w: number,
  h: number,
  config: StructureConfig,
): Array<{ x: number; y: number }> {
  const pL = Math.max(0, Math.min(4, config.popoutL ?? 0));
  const pR = Math.max(0, Math.min(4, config.popoutR ?? 0));
  const yS = h * 0.3; // pop-outs span the middle 60% of the length
  const pts: Array<{ x: number; y: number }> = [{ x: w / 2, y: -h / 2 }];
  if (pR > 0)
    pts.push(
      { x: w / 2, y: -yS },
      { x: w / 2 + pR, y: -yS },
      { x: w / 2 + pR, y: yS },
      { x: w / 2, y: yS },
    );
  pts.push({ x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 });
  if (pL > 0)
    pts.push(
      { x: -w / 2, y: yS },
      { x: -w / 2 - pL, y: yS },
      { x: -w / 2 - pL, y: -yS },
      { x: -w / 2, y: -yS },
    );
  pts.push({ x: -w / 2, y: -h / 2 });
  return pts;
}

/** A round water-tank footprint: an object-local CENTERED circle (16-gon, like
 * the dome) so a vertical tank casts a real cylindrical shadow and is overlap-
 * tested as a circle, not a square. */
function tankFootprint(w: number, h: number): Array<{ x: number; y: number }> {
  const n = 16;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: (Math.cos(a) * w) / 2, y: (Math.sin(a) * h) / 2 };
  });
}

/** A round water tank drawn top-down (in the 0,0→w,h feet box): the tank wall, a
 * translucent lid ring, and a center fill cap — color-coded by `base` (blue =
 * fresh, grey = greywater). */
function tankRenderFootprint(base: string) {
  return function TankFootprint({ w, h, selected }: FootprintCtx): ReactNode {
    const cx = w / 2;
    const cy = h / 2;
    return (
      <g>
        <ellipse
          cx={cx}
          cy={cy}
          rx={w / 2}
          ry={h / 2}
          fill={base}
          fillOpacity={0.88}
          stroke={selected ? "#1c1c1c" : base}
          strokeWidth={selected ? 0.5 : 0.3}
        />
        <ellipse
          cx={cx}
          cy={cy}
          rx={w * 0.42}
          ry={h * 0.42}
          fill="#ffffff"
          fillOpacity={0.18}
          stroke="#1c1c1c"
          strokeOpacity={0.22}
          strokeWidth={0.18}
          pointerEvents="none"
        />
        <circle
          cx={cx}
          cy={cy}
          r={Math.min(w, h) * 0.13}
          fill="#1c1c1c"
          fillOpacity={0.3}
          pointerEvents="none"
        />
      </g>
    );
  };
}

/** Legend/tray icon for a round water tank (color-coded). */
function tankRenderIcon(base: string) {
  return function tankIcon(size: number): ReactNode {
    const c = size / 2;
    const r = size * 0.36;
    return (
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: "block", flex: "0 0 auto" }}
        aria-hidden="true"
      >
        <circle
          cx={c}
          cy={c}
          r={r}
          fill={base}
          fillOpacity={0.9}
          stroke="#1c1c1c"
          strokeOpacity={0.4}
          strokeWidth={size * 0.03}
        />
        <circle
          cx={c}
          cy={c}
          r={r * 0.5}
          fill="none"
          stroke="#1c1c1c"
          strokeOpacity={0.25}
          strokeWidth={size * 0.02}
        />
        <circle
          cx={c}
          cy={c}
          r={size * 0.06}
          fill="#1c1c1c"
          fillOpacity={0.35}
        />
      </svg>
    );
  };
}

/** A directional uplink radio seen from above (in the 0,0→w,h feet box): the
 * mast base with a dish on it. Drawn rotationally symmetric on purpose — the
 * radio's aim is computed from the camp's address, not from the object's
 * rotation, and the map draws the real aim path. */
function UplinkFootprint({ w, h, color, selected }: FootprintCtx): ReactNode {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  return (
    <g>
      {/* Guy-wire triangle = the mast's real ground footprint. */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={color}
        fillOpacity={0.16}
        stroke={color}
        strokeOpacity={0.5}
        strokeWidth={r * 0.08}
        strokeDasharray={`${r * 0.22} ${r * 0.16}`}
      />
      {/* The dish itself, looking down on it. */}
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.52}
        fill={color}
        fillOpacity={0.9}
        stroke={selected ? "#1c1c1c" : color}
        strokeWidth={r * (selected ? 0.14 : 0.08)}
      />
      <circle cx={cx} cy={cy} r={r * 0.16} fill="#ffffff" fillOpacity={0.75} />
    </g>
  );
}

/** A Wi-Fi access point seen from above: a dot radiating rings. Omnidirectional,
 * so concentric — the opposite of the uplink's one-sided dish. */
function WifiApFootprint({ w, h, color, selected }: FootprintCtx): ReactNode {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  return (
    <g>
      {[1, 0.68].map((f) => (
        <circle
          key={f}
          cx={cx}
          cy={cy}
          r={r * f}
          // Faintly filled rather than `fill="none"`: an unfilled shape is only
          // hit-testable on its stroke, which makes a 2ft marker almost
          // impossible to grab on the map.
          fill={color}
          fillOpacity={f === 1 ? 0.12 : 0}
          stroke={color}
          strokeOpacity={0.55}
          strokeWidth={r * 0.1}
          strokeDasharray={`${r * 0.2} ${r * 0.14}`}
        />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.36}
        fill={color}
        fillOpacity={0.9}
        stroke={selected ? "#1c1c1c" : color}
        strokeWidth={r * (selected ? 0.14 : 0.06)}
      />
    </g>
  );
}

/** Legend/tray icon for a Wi-Fi access point: the familiar rising fan. */
function wifiApIcon(size: number): ReactNode {
  const cx = size / 2;
  const cy = size * 0.76;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {[0.22, 0.36, 0.5].map((f) => {
        // Chord spans 2·size·f, so radius = size·f·√2 draws it as a 90° arc.
        const r = size * f * Math.SQRT2;
        return (
          <path
            key={f}
            d={`M ${cx - size * f} ${cy - size * f} A ${r} ${r} 0 0 1 ${
              cx + size * f
            } ${cy - size * f}`}
            fill="none"
            stroke="#15aabf"
            strokeOpacity={0.8}
            strokeWidth={size * 0.07}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx={cx} cy={cy} r={size * 0.08} fill="#15aabf" />
    </svg>
  );
}

/** Legend/tray icon for the uplink radio: a dish throwing a signal arc. */
function uplinkIcon(size: number): ReactNode {
  const c = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      <circle
        cx={c * 0.72}
        cy={c}
        r={size * 0.2}
        fill="#7048e8"
        fillOpacity={0.9}
      />
      {[0.3, 0.46, 0.62].map((f) => (
        <path
          key={f}
          d={`M ${c * 0.72} ${c - size * f} A ${size * f} ${size * f} 0 0 1 ${
            c * 0.72
          } ${c + size * f}`}
          fill="none"
          stroke="#7048e8"
          strokeOpacity={0.75}
          strokeWidth={size * 0.06}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/** Toy-hauler footprint: the trailer body plus, when the rear ramp is folded
 * DOWN (`config.ramp`), an apron extending past the rear (+y) edge — so the
 * deployed ramp takes real space for spacing / shade / overlap. Centered, like
 * the other footprints; the rear is the +y end (front = the towing/-y end). */
function toyHaulerFootprint(
  w: number,
  h: number,
  config: StructureConfig,
): Array<{ x: number; y: number }> {
  const ramp = (config.ramp ?? 0) > 0 ? Math.min(w, 8) : 0; // ~ trailer width, ≤ 8ft
  const pts: Array<{ x: number; y: number }> = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
  ];
  if (ramp > 0)
    pts.push({ x: w / 2, y: h / 2 + ramp }, { x: -w / 2, y: h / 2 + ramp });
  pts.push({ x: -w / 2, y: h / 2 });
  return pts;
}

/** Stretch-hexayurt outline (object-local CENTERED feet): the regular 8ft-panel
 * hexagon split in half with a `stretch`-ft rectangle inserted along the ridge
 * (+x), the way real stretch builds add 4×8 wall panels in the middle. At
 * stretch 0 this is exactly the regular hexayurt hexagon. */
function stretchHexOutline(
  w: number,
  h: number,
  config: StructureConfig,
): Array<{ x: number; y: number }> {
  const s = Math.max(0, Math.min(16, config.stretch ?? 8)) / 2;
  const flat = w / 2 - w / 4; // half the flat (top/bottom) edge
  return [
    { x: w / 2 + s, y: 0 },
    { x: flat + s, y: h / 2 },
    { x: -flat - s, y: h / 2 },
    { x: -w / 2 - s, y: 0 },
    { x: -flat - s, y: -h / 2 },
    { x: flat + s, y: -h / 2 },
  ];
}

/** Stretch hexayurt drawn top-down: the stretched hexagon plus the roof ridge
 * (along the stretch) and hip lines from each wall corner to the ridge ends. */
function StretchHexayurtFootprint({
  w,
  h,
  color,
  selected,
  config,
}: FootprintCtx): ReactNode {
  const cx = w / 2;
  const cy = h / 2;
  const s = Math.max(0, Math.min(16, config.stretch ?? 8)) / 2;
  const pts = stretchHexOutline(w, h, config).map((p) => ({
    x: p.x + cx,
    y: p.y + cy,
  }));
  const ridgeL = { x: cx - s, y: cy };
  const ridgeR = { x: cx + s, y: cy };
  // Each outline vertex hips to its own end of the ridge (left half → left end).
  const hips = pts.map((p) => ({ p, r: p.x < cx ? ridgeL : ridgeR }));
  return (
    <g>
      <polygon
        points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
        fill={color}
        fillOpacity={0.78}
        stroke={selected ? "#1c1c1c" : color}
        strokeWidth={selected ? 0.5 : 0.25}
      />
      <g stroke="#1c1c1c" strokeOpacity={0.35} strokeWidth={0.2}>
        <line x1={ridgeL.x} y1={ridgeL.y} x2={ridgeR.x} y2={ridgeR.y} />
        {hips.map(({ p, r }) => (
          <line key={`${p.x},${p.y}`} x1={p.x} y1={p.y} x2={r.x} y2={r.y} />
        ))}
      </g>
    </g>
  );
}

/** Legend/tray icon for the stretch hexayurt: the elongated hexagon + ridge. */
function stretchHexIcon(size: number): ReactNode {
  // Default proportions: 16ft hexagon + 8ft stretch → 24ft × 13.86ft.
  const w = size - 2;
  const h = w * (13.86 / 24);
  const y0 = (size - h) / 2;
  const xs = [0, w / 6, (5 * w) / 6, w].map((x) => x + 1);
  const pts = [
    `${xs[3]},${y0 + h / 2}`,
    `${xs[2]},${y0 + h}`,
    `${xs[1]},${y0 + h}`,
    `${xs[0]},${y0 + h / 2}`,
    `${xs[1]},${y0}`,
    `${xs[2]},${y0}`,
  ].join(" ");
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      <polygon points={pts} fill="#087f5b" />
      <line
        x1={xs[1]}
        y1={y0 + h / 2}
        x2={xs[2]}
        y2={y0 + h / 2}
        stroke="#1c1c1c"
        strokeOpacity={0.4}
      />
    </svg>
  );
}

/** Pop-up camper footprint: the trailer box plus, when popped up
 * (config `popped`), the fold-out bunks cantilevered ~3.5ft past BOTH ends —
 * slightly narrower than the box. Centered outline, like the RV's, so the
 * deployed bunks take real space for spacing / shade / overlap. */
function popupCamperFootprint(
  w: number,
  h: number,
  config: StructureConfig,
): Array<{ x: number; y: number }> {
  const out = (config.popped ?? 1) > 0 ? 3.5 : 0;
  const bw = (w * 0.85) / 2;
  const pts: Array<{ x: number; y: number }> = [{ x: -w / 2, y: -h / 2 }];
  if (out > 0)
    pts.push(
      { x: -bw, y: -h / 2 },
      { x: -bw, y: -h / 2 - out },
      { x: bw, y: -h / 2 - out },
      { x: bw, y: -h / 2 },
    );
  pts.push({ x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 });
  if (out > 0)
    pts.push(
      { x: bw, y: h / 2 },
      { x: bw, y: h / 2 + out },
      { x: -bw, y: h / 2 + out },
      { x: -bw, y: h / 2 },
    );
  pts.push({ x: -w / 2, y: h / 2 });
  return pts;
}

/** Vehicle shadow silhouette: the body box, plus — when the `rooftopTent`
 * toggle is on — the opened tent box (~4.5×7ft, ~3.5ft above the roof) as a
 * separate part, so the vehicle casts a real stepped shadow. `z` is a fraction
 * of the object's tallFt, so the tent's added height is calibrated against the
 * kind's default height (`baseTallFt`). */
function rooftopTentShadow(baseTallFt: number) {
  return (
    w: number,
    h: number,
    config: StructureConfig,
  ): Array<readonly ShadowVertex[]> => {
    const box = (
      hw: number,
      hh: number,
      z0: number,
      z1: number,
    ): readonly ShadowVertex[] =>
      [0, 1].flatMap((zi) =>
        [
          { x: -hw, y: -hh },
          { x: hw, y: -hh },
          { x: hw, y: hh },
          { x: -hw, y: hh },
        ].map((p) => ({ ...p, z: zi === 0 ? z0 : z1 })),
      );
    const parts = [box(w / 2, h / 2, 0, 1)];
    if ((config.rooftopTent ?? 0) > 0) {
      parts.push(
        box(Math.min(w, 4.5) / 2, Math.min(h, 7) / 2, 1, 1 + 3.5 / baseTallFt),
      );
    }
    return parts;
  };
}

/** The rooftop-tent toggle shared by the plain vehicles (car / truck / van). */
const ROOFTOP_TENT_CONTROL = {
  key: "rooftopTent",
  label: "Rooftop tent",
  min: 0,
  max: 1,
  default: 0,
  toggle: true,
} as const;

/** The built-in palette shipped with the open-source app. A self-hoster's
 * camp-theme package contributes additional structures (see `KINDS` below) —
 * bespoke per-camp kinds never bloat this shared list. */
const CORE_KINDS = [
  {
    value: "tent",
    label: "Tent",
    color: "#12b886",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // Regular hexagon, 8ft edges → 16ft point-to-point, 8√3 ≈ 13.86ft flat-to-flat.
  // Standard hexayurt: 4ft walls + a 2ft pyramidal roof → a fixed 6ft peak.
  {
    value: "hexayurt",
    label: "Hexayurt",
    color: "#0ca678",
    w: 16,
    h: 13.86,
    shape: "hexagon",
    vehicle: false,
    rigid: true,
    fixedTall: true,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
    // Slide the door along the front edge (fraction of the wall, 0 = centered).
    controls: [
      {
        key: "doorOffset",
        label: "Door position",
        min: -0.45,
        max: 0.45,
        step: 0.05,
        default: 0,
      },
    ],
  },
  // 8ft square base; the roof is a hypar with one high corner.
  {
    value: "hyparhut",
    label: "Hyparhut",
    color: "#15aabf",
    w: 8,
    h: 8,
    shape: "hypar",
    vehicle: false,
    rigid: true,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // Geodesic dome: circular footprint sized by a single diameter; optional height.
  {
    value: "dome",
    label: "Geodesic dome",
    color: "#3bc9db",
    w: 20,
    h: 20,
    shape: "dome",
    vehicle: false,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // SHIFTPOD (2/III): the insulated festival pod. Real footprint is 6-sided —
  // a hexagon filling a 12×12 ft bounding box (vendor: "12'x12' hexagonal",
  // ~106-144 sq ft) — with a ~6'6" peak (III: 6'11").
  {
    value: "shiftpod",
    label: "Shift Pod",
    color: "#9775fa",
    w: 12,
    h: 12,
    shape: "hexagon",
    vehicle: false,
    rigid: true,
    fixedTall: true,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // SHIFTPOD Mini: the compact pod is 4-sided, per vendor 72"×72"×56" set up —
  // a 6×6 ft square footprint with a ~4.7 ft peak.
  {
    value: "shiftpod-mini",
    label: "Shift Pod Mini",
    color: "#a78bfa",
    w: 6,
    h: 6,
    shape: "rect",
    vehicle: false,
    rigid: true,
    fixedTall: true,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // Canvas bell tent (Sibley/Fernweh style): round, sold by diameter — 13ft
  // (4m) and 16.4ft (5m) are the common sizes; ~10ft center pole on a 5m.
  {
    value: "bell-tent",
    label: "Bell tent",
    color: "#38d9a9",
    w: 16,
    h: 16,
    shape: "dome",
    vehicle: false,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // The 8ft-panel hexayurt elongated with extra 4×8 wall panels in the middle —
  // a common playa build. The stretch slider inserts feet between the hexagon
  // halves (4ft per pair of panels); 0 = the regular hexayurt footprint.
  {
    value: "stretch-hexayurt",
    label: "Stretch hexayurt",
    color: "#087f5b",
    w: 16,
    h: 13.86,
    shape: "custom",
    vehicle: false,
    rigid: true,
    fixedTall: true,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
    footprint: stretchHexOutline,
    renderFootprint: StretchHexayurtFootprint,
    renderIcon: stretchHexIcon,
    controls: [
      {
        key: "stretch",
        label: "Stretch (ft)",
        min: 0,
        max: 16,
        step: 4,
        default: 8,
      },
    ],
  },
  // Canvas cabin tent (Kodiak/Springbar flex-bow): 10×14 is the classic size
  // (10×10 and 12×12 also common — it resizes); ~6'6" ridge.
  {
    value: "cabin-tent",
    label: "Canvas cabin tent",
    color: "#2b8a3e",
    w: 10,
    h: 14,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  // Tipi: conical lodge on a pole crown — round footprint, commonly 12-18ft
  // diameter, and taller than wide (~12ft peak on a 15ft lodge).
  {
    value: "tipi",
    label: "Tipi",
    color: "#b08968",
    w: 15,
    h: 15,
    shape: "dome",
    vehicle: false,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile"],
    personal: true,
  },
  {
    value: "rv",
    label: "RV / trailer",
    color: "#228be6",
    w: 8,
    h: 24,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
    footprint: rvFootprint,
    controls: [
      // Slide the door along the side (length) edge (fraction of the wall).
      {
        key: "doorOffset",
        label: "Door position",
        min: -0.45,
        max: 0.45,
        step: 0.05,
        default: 0,
      },
      // Slide-out depth (ft) on each side; 0 = retracted.
      {
        key: "popoutL",
        label: "Pop-out (left)",
        min: 0,
        max: 4,
        step: 0.5,
        default: 0,
      },
      {
        key: "popoutR",
        label: "Pop-out (right)",
        min: 0,
        max: 4,
        step: 0.5,
        default: 0,
      },
      // Markers for placement planning: generator (noise/exhaust, front end) and
      // sewer cleanout (dump access, rear end). Rotate the RV to aim them.
      {
        key: "generator",
        label: "Generator",
        min: 0,
        max: 1,
        default: 0,
        toggle: true,
      },
      {
        key: "cleanout",
        label: "Cleanout",
        min: 0,
        max: 1,
        default: 0,
        toggle: true,
      },
    ],
  },
  // Box truck sleeper (U-Haul-style conversion): 8ft-wide box, ~22ft overall
  // with the common 15ft box; longer trucks stretch it (length-only resize).
  {
    value: "box-truck",
    label: "Box truck",
    color: "#1971c2",
    w: 8,
    h: 22,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
  },
  // School bus / skoolie: 8ft body width, 20-40ft long (35ft is the classic
  // full-size), ~10'6" tall.
  {
    value: "skoolie",
    label: "School bus / skoolie",
    color: "#fab005",
    w: 8,
    h: 35,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
  },
  // Teardrop trailer: ~5ft wide, ~10ft overall including the tongue, ~5ft tall.
  {
    value: "teardrop",
    label: "Teardrop trailer",
    color: "#74c0fc",
    w: 5,
    h: 10,
    shape: "rect",
    vehicle: true,
    rigid: true,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
  },
  // Pop-up / tent camper: ~7ft-wide trailer (10ft box typical; 8-16ft exist, so
  // length resizes). Popping up folds bunks out ~3.5ft past BOTH ends — the
  // deployed footprint is real space, like the RV pop-outs.
  {
    value: "popup-camper",
    label: "Pop-up camper",
    color: "#5c7cfa",
    w: 7,
    h: 12,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
    footprint: popupCamperFootprint,
    controls: [
      {
        key: "popped",
        label: "Popped up (beds out)",
        min: 0,
        max: 1,
        default: 1,
        toggle: true,
      },
    ],
  },
  {
    value: "car",
    label: "Car",
    color: "#4263eb",
    w: 6,
    h: 14,
    shape: "rect",
    vehicle: true,
    rigid: true,
    group: "Vehicles",
    tags: ["vehicle"],
    personal: true,
    controls: [ROOFTOP_TENT_CONTROL],
    shadowVolume: rooftopTentShadow(5),
  },
  {
    value: "truck",
    label: "Truck",
    color: "#3b5bdb",
    w: 7,
    h: 19,
    shape: "rect",
    vehicle: true,
    rigid: true,
    group: "Vehicles",
    tags: ["vehicle"],
    personal: true,
    controls: [ROOFTOP_TENT_CONTROL],
    shadowVolume: rooftopTentShadow(11),
  },
  // "Van" spans a wide range — a minivan or Transit Connect is ~15ft, a Sprinter
  // 144 ~19.5ft, a 170 EXT ~24ft. 17ft is only a default, so the length resizes.
  {
    value: "van",
    label: "Van",
    color: "#4c6ef5",
    w: 7,
    h: 17,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Vehicles",
    tags: ["vehicle"],
    personal: true,
    controls: [ROOFTOP_TENT_CONTROL],
    shadowVolume: rooftopTentShadow(8),
  },
  {
    value: "shade",
    label: "Shade",
    color: "#f59f00",
    w: 20,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Shade",
    tags: ["structure"],
    personal: true,
    // Open shade cloth: casts only its top layer; porous to wind.
    canopyShade: true,
  },
  // A peaked/gabled carport canopy — open shade sized to cover a vehicle.
  {
    value: "carport",
    label: "Carport",
    color: "#f08c00",
    w: 12,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Shade",
    tags: ["structure"],
    personal: true,
    canopyShade: true,
  },
  // A pop-up / EZ-up canopy (standard 10×10, also 10×20). Quick shade; note some
  // events (e.g. Burning Man) disallow them — see the per-edition ban list.
  {
    value: "popup",
    label: "Pop-up canopy",
    color: "#ffa94d",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Shade",
    tags: ["structure"],
    personal: true,
    canopyShade: true,
  },
  {
    value: "kitchen",
    label: "Kitchen",
    color: "#fd7e14",
    w: 16,
    h: 16,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Structures",
    tags: ["structure"],
    personal: false,
  },
  {
    value: "art",
    label: "Art",
    color: "#ae3ec9",
    w: 15,
    h: 15,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Structures",
    tags: ["structure"],
    personal: false,
  },
  {
    value: "power",
    label: "Generator",
    color: "#e03131",
    w: 6,
    h: 8,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Power",
    tags: ["structure"],
    personal: false,
  },
  // Shipping containers come in known sizes: fixed 8ft width, length is either
  // full (40ft) or half (20ft). See CONTAINER_* + the map's Full/Half toggle.
  {
    value: "container",
    label: "Container",
    color: "#868e96",
    w: 8,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: true,
    group: "Structures",
    tags: ["structure"],
    personal: false,
  },
  // Power distribution node — small fixed footprint; cables (map_cable) run
  // between these and the generator. See power-line drawing on the map.
  {
    value: "spiderbox",
    label: "Spider box",
    color: "#f59f00",
    w: 3,
    h: 3,
    shape: "rect",
    vehicle: false,
    rigid: true,
    group: "Power",
    tags: ["structure"],
    personal: false,
  },
  // Liquid-fuel or propane storage. The map auto-draws the Burning Man fuel
  // separation rings around it: 10′ (no ignition sources / combustibles), 20′
  // (between liquid fuel and propane), 50′ (to another fuel storage area).
  {
    value: "fuel-storage",
    label: "Fuel storage",
    color: "#e8590c",
    w: 5,
    h: 5,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Power",
    tags: ["structure"],
    personal: false,
  },
  // Battery / energy-storage bank. When capacity ≥ 100 kWh the map draws a
  // minimum safety-zone ring (BM electrical-safety requirement); small personal
  // batteries (leave capacity at 0) don't need one and draw nothing.
  {
    value: "battery",
    label: "Battery bank",
    color: "#2f9e44",
    w: 4,
    h: 4,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Power",
    tags: ["structure"],
    personal: false,
    controls: [
      {
        key: "kwh",
        label: "Capacity (kWh)",
        min: 0,
        max: 500,
        step: 5,
        default: 0,
      },
      {
        key: "safetyFt",
        label: "Safety zone (ft)",
        min: 0,
        max: 100,
        step: 5,
        default: 20,
      },
    ],
  },
  // Fire pit / burn barrel — an open flame. The map draws a keep-clear ring
  // (default 20′, the Burning Man open-fire clearance kept free of combustibles).
  {
    value: "fire-pit",
    label: "Fire pit / barrel",
    color: "#f03e3e",
    w: 4,
    h: 4,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Power",
    tags: ["structure"],
    personal: false,
    controls: [
      {
        key: "clearFt",
        label: "Clearance (ft)",
        min: 0,
        max: 100,
        step: 5,
        default: 20,
      },
    ],
  },
  // A solar/sun shower or shower stall.
  {
    value: "shower",
    label: "Shower",
    color: "#3bc9db",
    w: 4,
    h: 4,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Water",
    tags: ["structure"],
    personal: true,
  },
  // A black-lined greywater evaporation pond (shallow ground feature).
  {
    value: "evap-pond",
    label: "Evap pond",
    color: "#212529",
    w: 8,
    h: 8,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Water",
    tags: ["structure"],
    personal: true,
  },
  // OSS fresh-water tank — round vertical poly tank (250-gal ≈ 3′ dia × 5.5′).
  {
    value: "water-tank-fresh",
    label: "Fresh water tank",
    color: "#4dabf7",
    w: 3,
    h: 3,
    shape: "custom",
    vehicle: false,
    rigid: true,
    group: "Water",
    tags: ["structure"],
    personal: true,
    footprint: tankFootprint,
    renderFootprint: tankRenderFootprint("#4dabf7"),
    renderIcon: tankRenderIcon("#4dabf7"),
  },
  // OSS greywater tank — same round tank, grey-coded.
  {
    value: "water-tank-grey",
    label: "Grey water tank",
    color: "#868e96",
    w: 3,
    h: 3,
    shape: "custom",
    vehicle: false,
    rigid: true,
    group: "Water",
    tags: ["structure"],
    personal: true,
    footprint: tankFootprint,
    renderFootprint: tankRenderFootprint("#868e96"),
    renderIcon: tankRenderIcon("#868e96"),
  },
  // A camp trash & recycling area.
  {
    value: "trash",
    label: "Trash / recycling",
    color: "#2f9e44",
    w: 8,
    h: 6,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Services",
    tags: ["structure"],
    personal: false,
  },
  // A path light / luminaire marker — placed along walkways; glows after dark in
  // the night-lighting sim. Small fixed footprint.
  {
    value: "path-light",
    label: "Path light",
    color: "#ffd43b",
    w: 1,
    h: 1,
    shape: "rect",
    vehicle: false,
    rigid: true,
    group: "Services",
    tags: ["structure"],
    personal: false,
  },
  // Directional uplink radio — a dish/mast aimed at a distant tower for camp
  // internet. Tiny fixed footprint because WHERE it goes is the whole point:
  // park it on the corner of an RV, container or shade frame, set its Height to
  // the antenna's height above ground, and the map draws the aim path so you can
  // see what's in the way. Its rotation is ignored — the aim is computed.
  {
    value: "uplink",
    label: "Uplink radio",
    color: "#7048e8",
    w: 2,
    h: 2,
    shape: "custom",
    vehicle: false,
    rigid: true,
    // The dish's heading is computed from where it sits, not stored — so the
    // editor offers no rotation. Turning the glyph would only ever disagree
    // with the aim path drawn through it.
    fixedRotation: true,
    group: "Network",
    tags: ["structure"],
    personal: true,
    renderFootprint: UplinkFootprint,
    renderIcon: uplinkIcon,
    controls: [
      {
        key: "aim",
        label: "Show aim path",
        min: 0,
        max: 1,
        default: 1,
        toggle: true,
      },
    ],
  },
  // Wi-Fi access point — the local end of camp networking, wherever the internet
  // comes from. Omnidirectional, so what matters on the map is its COVERAGE: the
  // `rangeFt` ring shows how far it usefully reaches, making dead spots and
  // overlapping APs visible when you place them. Height matters for the same
  // reason (up high on a shade frame beats down at knee level in a tent).
  {
    value: "wifi-ap",
    label: "Wi-Fi access point",
    color: "#15aabf",
    w: 2,
    h: 2,
    shape: "custom",
    vehicle: false,
    rigid: true,
    // Omnidirectional: it has a coverage radius, not a facing.
    fixedRotation: true,
    group: "Network",
    tags: ["structure"],
    personal: true,
    renderFootprint: WifiApFootprint,
    renderIcon: wifiApIcon,
    controls: [
      {
        key: "rangeFt",
        // 100ft, not a spec-sheet line-of-sight number: on playa the signal is
        // fighting dust, bodies, and RV/container walls, and a ring that fits
        // inside the lot is the one that actually shows you your dead spots.
        label: "Usable range (ft)",
        min: 25,
        max: 400,
        step: 25,
        default: 100,
      },
    ],
  },
  // Toy hauler — a trailer with a fold-down rear ramp (config `ramp`). Fixed
  // width, length resizes; the deployed ramp extends the footprint (toyHaulerFootprint).
  {
    value: "toy-hauler",
    label: "Toy hauler",
    color: "#1c7ed6",
    w: 8,
    h: 30,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
    footprint: toyHaulerFootprint,
    controls: [
      {
        key: "ramp",
        label: "Rear ramp down",
        min: 0,
        max: 1,
        default: 0,
        toggle: true,
      },
    ],
  },
  // Airstream — iconic rounded travel trailer. Fixed 8′ width; length resizes
  // across the model range (~16′–34′; default ≈ 25′).
  {
    value: "airstream",
    label: "Airstream",
    color: "#adb5bd",
    w: 8,
    h: 25,
    shape: "rect",
    vehicle: true,
    rigid: false,
    group: "Domiciles",
    tags: ["domicile", "vehicle"],
    personal: true,
  },
  {
    value: "structure",
    label: "Other",
    color: "#7048e8",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Structures",
    tags: ["structure"],
    personal: true,
  },
] as const;

/**
 * The full palette the map + inventory read: built-in core kinds plus any custom
 * structures the active camp-theme package contributes (`CAMP_THEME`, default →
 * none). Every derived helper below (kindDef, KIND_GROUPS, CAMPER_KINDS, …) reads
 * from this, so a camp-theme kind slots into the legend, picker, and map for free.
 */
export const KINDS: readonly CampStructure[] = [
  ...CORE_KINDS,
  ...campStructures,
];

/** Default above-ground height (feet) per kind, used to seed a new object's
 * height and as the fallback for the 2D shade simulation when height is unset. */
const KIND_HEIGHTS: Record<string, number> = {
  tent: 7,
  // 4ft walls + 2ft roof = 6ft peak (the roof is the height of an 8ft equilateral
  // triangle's apex over its base... ≈ 2ft rise). Fixed (fixedTall).
  hexayurt: 6,
  // Hyparhut roof peaks at 6' (front-right corner, by the door) and dips to 4';
  // this is the peak. Per-corner heights for shade live in map.tsx cornerHeights.
  hyparhut: 6,
  dome: 12,
  // SHIFTPOD peaks ~6'6" (2) to 6'11" (III); the Mini sets up 56" tall.
  shiftpod: 6.5,
  "shiftpod-mini": 4.7,
  // NOTE: round (dome-shaped) kinds' shadows derive from the radius, not
  // tallFt — these heights still seed the object and the corner-height path.
  "bell-tent": 10,
  "stretch-hexayurt": 6, // same 6ft ridge as the regular hexayurt
  "cabin-tent": 6.5,
  tipi: 12,
  "box-truck": 11,
  skoolie: 10.5,
  teardrop: 5,
  "popup-camper": 8.5, // popped-up roof height; closed it tows at ~4.5ft
  rv: 10,
  car: 5,
  truck: 11,
  van: 8,
  shade: 10,
  carport: 10,
  popup: 8,
  shower: 7,
  "evap-pond": 0.5, // shallow ground feature — negligible shadow
  "water-tank-fresh": 5.5,
  "water-tank-grey": 5.5,
  trash: 4,
  // A point luminaire: no real volume, so it casts no shade (height 0).
  "path-light": 0,
  // Antenna height above ground — the number that decides what the uplink can
  // see over, so it's meant to be edited. A modest pole, or a mast on a roof;
  // BMorg warns that a tall pole that sways in the wind breaks the link.
  uplink: 12,
  // Mounted up on a shade frame or a container, where it covers the most ground.
  "wifi-ap": 10,
  "toy-hauler": 10,
  airstream: 9.5,
  kitchen: 8,
  art: 12,
  power: 4,
  container: 9.5,
  spiderbox: 3,
  structure: 8,
};
export function kindHeight(kind: string): number {
  // Core kinds use the table; a camp-theme structure carries its own `tallFt`.
  return KIND_HEIGHTS[kind] ?? kindDef(kind).tallFt ?? 8;
}

/** Industry-standard preset ratings a power line (map_cable) can carry. Both are
 * optional; the map UI renders them as clearable dropdowns. */
export const AMP_OPTIONS = ["15", "20", "30", "50", "100"] as const;
/** Copper wire gauge (AWG) with its NEC ampacity, biggest wire = highest amps. */
export const GAUGE_OPTIONS = [
  { value: "14 AWG", label: "14 AWG (15A)" },
  { value: "12 AWG", label: "12 AWG (20A)" },
  { value: "10 AWG", label: "10 AWG (30A)" },
  { value: "8 AWG", label: "8 AWG (40A)" },
  { value: "6 AWG", label: "6 AWG (55A)" },
  { value: "4 AWG", label: "4 AWG (70A)" },
  { value: "2 AWG", label: "2 AWG (95A)" },
  { value: "1/0 AWG", label: "1/0 AWG (125A)" },
] as const;

/** Shipping containers: fixed 8ft width; length is full (40ft) or half (20ft). */
export const CONTAINER_WIDTH = 8;
export const CONTAINER_FULL = 40;
export const CONTAINER_HALF = 20;

/** The kinds a camper may declare for themselves (Bringing page + wizard).
 * Excludes communal infrastructure (kitchen, generator, shipping container,
 * spider box, camp art) that only officers place. */
export const CAMPER_KINDS: readonly Kind[] = KINDS.filter((k) => k.personal);

/** `CAMPER_KINDS` split into camper-facing categories, in display order. Derived
 * from each kind's `group` — so a new kind (including a camp-theme one) files
 * itself — with one departure from the map legend: "Domiciles" is more than half
 * the palette, so it splits on the `vehicle` tag into what you pitch and what you
 * drive or tow. Someone adding their trailer shouldn't scan past a dozen tents. */
export const CAMPER_KIND_GROUPS: ReadonlyArray<{
  group: string;
  kinds: readonly Kind[];
}> = (() => {
  const order = [
    "Tents & shelters",
    "Campers & RVs",
    "Vehicles",
    "Shade",
    "Water",
    "Network",
    "Structures",
  ];
  const camperGroup = (k: Kind) => {
    if (k.group !== "Domiciles") return k.group;
    const towed = (k.tags as readonly string[]).includes("vehicle");
    return towed ? "Campers & RVs" : "Tents & shelters";
  };
  const groups: Array<{ group: string; kinds: Kind[] }> = order.map(
    (group) => ({ group, kinds: [] }),
  );
  for (const k of CAMPER_KINDS) {
    const g = camperGroup(k);
    let entry = groups.find((x) => x.group === g);
    if (!entry) {
      // A camp-theme kind in a group core doesn't know — append, don't drop.
      entry = { group: g, kinds: [] };
      groups.push(entry);
    }
    entry.kinds.push(k);
  }
  return groups.filter((g) => g.kinds.length > 0);
})();

/** Legend groups in display order, each with its kinds. Derived from KINDS so
 * adding a kind only requires setting its `group`. */
export const KIND_GROUPS: ReadonlyArray<{
  group: string;
  kinds: readonly Kind[];
}> = (() => {
  const order = [
    "Domiciles",
    "Vehicles",
    "Shade",
    "Structures",
    "Power",
    "Water",
    "Network",
    "Services",
  ];
  const seen = new Set<string>();
  const groups: Array<{ group: string; kinds: Kind[] }> = [];
  const ensure = (g: string) => {
    let entry = groups.find((x) => x.group === g);
    if (!entry) {
      entry = { group: g, kinds: [] };
      groups.push(entry);
    }
    return entry;
  };
  for (const g of order) {
    seen.add(g);
    ensure(g);
  }
  for (const k of KINDS) {
    if (!seen.has(k.group)) seen.add(k.group);
    ensure(k.group).kinds.push(k);
  }
  return groups.filter((g) => g.kinds.length > 0);
})();

const KIND_MAP: Record<string, CampStructure> = Object.fromEntries(
  KINDS.map((k) => [k.value, k]),
);
// Derived from CORE_KINDS (a const tuple) so it's always defined — a camp theme
// can't remove the built-in "structure" fallback.
const FALLBACK_KIND: CampStructure =
  CORE_KINDS.find((k) => k.value === "structure") ?? CORE_KINDS[0];

export function kindDef(kind: string): CampStructure {
  return KIND_MAP[kind] ?? FALLBACK_KIND;
}
export function isKind(value: string): boolean {
  return value in KIND_MAP;
}
export function kindColor(kind: string) {
  return kindDef(kind).color;
}
/** Does this kind carry the given highlight tag (domicile/vehicle/structure)? */
export function hasTag(kind: string, tag: KindTag): boolean {
  return (kindDef(kind).tags as readonly string[]).includes(tag);
}

/** Kinds the map draws a door for — the per-element "show door" toggle applies
 * only to these. */
const DOOR_KINDS = new Set(["rv", "hyparhut", "hexayurt", "container"]);
export function kindHasDoor(kind: string): boolean {
  return DOOR_KINDS.has(kind);
}

/** Flat-top hexagon vertices (corners inset horizontally by w/4). */
export function hexVertices(x: number, y: number, w: number, h: number) {
  const i = w / 4;
  return [
    { x: x + i, y },
    { x: x + w - i, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w - i, y: y + h },
    { x: x + i, y: y + h },
    { x, y: y + h / 2 },
  ];
}

/** Hexagon footprint points inside the box (x,y,w,h). */
export function hexPoints(x: number, y: number, w: number, h: number): string {
  return hexVertices(x, y, w, h)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}

/** Small swatch showing a kind's footprint shape (for legends/lists). */
export function ShapeSwatch({
  kind,
  size = 16,
}: { kind: Kind; size?: number }) {
  const s = size;
  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {kind.shape === "hexagon" ? (
        <polygon points={hexPoints(1, 1, s - 2, s - 2)} fill={kind.color} />
      ) : kind.shape === "hypar" ? (
        <>
          <rect
            x={2}
            y={2}
            width={s - 4}
            height={s - 4}
            rx={2}
            fill={kind.color}
          />
          <line
            x1={2}
            y1={2}
            x2={s - 2}
            y2={s - 2}
            stroke="#1c1c1c"
            strokeOpacity={0.4}
          />
        </>
      ) : (
        <rect
          x={2}
          y={2}
          width={s - 4}
          height={s - 4}
          rx={2}
          fill={kind.color}
        />
      )}
    </svg>
  );
}

/** Five-point star polygon points centered at (cx,cy). */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${cx + Math.cos(ang) * rr},${cy + Math.sin(ang) * rr}`);
  }
  return pts.join(" ");
}

/**
 * A recognizable top-down icon for a kind — the footprint at its true aspect
 * ratio plus a light schematic hint (wheels + windshield for vehicles, a ridge
 * for tents/hexayurts, burners for the kitchen, a bolt for the generator…).
 * Used in the legend and the unplaced tray, with the name shown as a tooltip.
 */
export function KindIcon({
  kind,
  size = 30,
}: { kind: CampStructure; size?: number }) {
  // A camp-theme structure can ship its own legend/tray icon.
  if (kind.renderIcon) return <>{kind.renderIcon(size)}</>;
  const S = size;
  const pad = S * 0.14;
  const scale = (S - 2 * pad) / Math.max(kind.w, kind.h);
  const w = kind.w * scale;
  const h = kind.h * scale;
  const px = (S - w) / 2;
  const py = (S - h) / 2;
  const cx = px + w / 2;
  const cy = py + h / 2;
  const c = kind.color;
  const dark = "#1c1c1c";
  const glass = "#cfe0ff";
  const X = (f: number) => px + w * f;
  const Y = (f: number) => py + h * f;
  const minWH = Math.min(w, h);
  const isCanopy = kind.canopyShade === true;

  const wheels = (fracs: number[]) => {
    const ww = Math.max(1.2, w * 0.16);
    const wl = Math.max(1.6, h * 0.11);
    return fracs.flatMap((f) =>
      [px, px + w - ww].map((wx) => (
        <rect
          key={`${f}-${wx}`}
          x={wx}
          y={py + h * f - wl / 2}
          width={ww}
          height={wl}
          rx={0.6}
          fill={dark}
          fillOpacity={0.7}
        />
      )),
    );
  };

  const body =
    kind.shape === "hexagon" ? (
      <polygon
        points={hexPoints(px, py, w, h)}
        fill={c}
        fillOpacity={0.85}
        stroke={dark}
        strokeOpacity={0.45}
        strokeWidth={0.75}
      />
    ) : kind.shape === "hypar" ? (
      <>
        <rect
          x={px}
          y={py}
          width={w}
          height={h}
          rx={2}
          fill={c}
          fillOpacity={0.85}
          stroke={dark}
          strokeOpacity={0.45}
          strokeWidth={0.75}
        />
        <line
          x1={px}
          y1={py}
          x2={px + w}
          y2={py + h}
          stroke={dark}
          strokeOpacity={0.5}
          strokeWidth={0.7}
        />
      </>
    ) : kind.shape === "dome" ? (
      <>
        <ellipse
          cx={cx}
          cy={cy}
          rx={w / 2}
          ry={h / 2}
          fill={c}
          fillOpacity={0.85}
          stroke={dark}
          strokeOpacity={0.45}
          strokeWidth={0.75}
        />
        {/* Geodesic hint: an inner ring + radial struts. */}
        <circle
          cx={cx}
          cy={cy}
          r={minWH * 0.27}
          fill="none"
          stroke={dark}
          strokeOpacity={0.4}
          strokeWidth={0.5}
        />
        {[0, 60, 120, 180, 240, 300].map((a) => {
          const rad = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={cx}
              y1={cy}
              x2={cx + Math.cos(rad) * (w / 2)}
              y2={cy + Math.sin(rad) * (h / 2)}
              stroke={dark}
              strokeOpacity={0.3}
              strokeWidth={0.4}
            />
          );
        })}
      </>
    ) : (
      <rect
        x={px}
        y={py}
        width={w}
        height={h}
        rx={2.5}
        fill={c}
        fillOpacity={isCanopy ? 0.25 : 0.85}
        stroke={c}
        strokeOpacity={isCanopy ? 1 : 0.55}
        strokeWidth={isCanopy ? 1.25 : 0.75}
        strokeDasharray={isCanopy ? "3 2" : undefined}
      />
    );

  let detail: ReactNode = null;
  if (kind.vehicle) {
    detail = (
      <g>
        {wheels([0.18, 0.82])}
        <polygon
          points={`${X(0.3)},${Y(0.08)} ${X(0.7)},${Y(0.08)} ${X(0.8)},${Y(0.22)} ${X(0.2)},${Y(0.22)}`}
          fill={glass}
          fillOpacity={0.75}
        />
        {kind.value === "rv" || kind.value === "truck" ? (
          <line
            x1={X(0.12)}
            y1={Y(0.3)}
            x2={X(0.88)}
            y2={Y(0.3)}
            stroke={dark}
            strokeOpacity={0.4}
            strokeWidth={0.6}
          />
        ) : null}
      </g>
    );
  } else if (kind.value === "tent") {
    detail = (
      <g stroke={dark} strokeOpacity={0.45} strokeWidth={0.7} fill="none">
        <line x1={px} y1={py} x2={px + w} y2={py + h} />
        <line x1={px + w} y1={py} x2={px} y2={py + h} />
      </g>
    );
  } else if (kind.shape === "hexagon") {
    detail = (
      <g stroke={dark} strokeOpacity={0.4} strokeWidth={0.6}>
        {hexVertices(px, py, w, h).map((v) => (
          <line key={`${v.x},${v.y}`} x1={cx} y1={cy} x2={v.x} y2={v.y} />
        ))}
      </g>
    );
  } else if (kind.value === "kitchen") {
    detail = (
      <g fill="none" stroke={dark} strokeOpacity={0.5} strokeWidth={0.7}>
        <circle cx={X(0.36)} cy={Y(0.38)} r={minWH * 0.09} />
        <circle cx={X(0.64)} cy={Y(0.38)} r={minWH * 0.09} />
        <circle cx={X(0.36)} cy={Y(0.64)} r={minWH * 0.09} />
        <circle cx={X(0.64)} cy={Y(0.64)} r={minWH * 0.09} />
      </g>
    );
  } else if (kind.value === "power") {
    detail = (
      <path
        d={`M ${X(0.56)} ${Y(0.2)} L ${X(0.4)} ${Y(0.54)} L ${X(0.52)} ${Y(0.54)} L ${X(0.44)} ${Y(0.8)} L ${X(0.66)} ${Y(0.44)} L ${X(0.52)} ${Y(0.44)} Z`}
        fill="#fff"
        fillOpacity={0.95}
        stroke={dark}
        strokeOpacity={0.4}
        strokeWidth={0.4}
      />
    );
  } else if (kind.value === "container") {
    // Match the map: double cargo doors on one end, swinging 270° back against
    // the side walls (radius = half-width, so they fit the icon box).
    const L = w / 2;
    const yb = py + h;
    detail = (
      <g fill="none" stroke={dark}>
        <line
          x1={px}
          y1={yb}
          x2={px}
          y2={yb - L}
          strokeOpacity={0.6}
          strokeWidth={1}
        />
        <line
          x1={px + w}
          y1={yb}
          x2={px + w}
          y2={yb - L}
          strokeOpacity={0.6}
          strokeWidth={1}
        />
        <path
          d={`M ${px + L} ${yb} A ${L} ${L} 0 1 1 ${px} ${yb - L}`}
          strokeOpacity={0.4}
          strokeWidth={0.6}
        />
        <path
          d={`M ${px + w - L} ${yb} A ${L} ${L} 0 1 0 ${px + w} ${yb - L}`}
          strokeOpacity={0.4}
          strokeWidth={0.6}
        />
      </g>
    );
  } else if (kind.value === "spiderbox") {
    // Distribution box: a few outlet ticks across the face.
    detail = (
      <g stroke={dark} strokeOpacity={0.55} strokeWidth={0.7}>
        {[0.32, 0.5, 0.68].map((f) => (
          <line key={f} x1={X(f)} y1={Y(0.34)} x2={X(f)} y2={Y(0.66)} />
        ))}
      </g>
    );
  } else if (kind.value === "art") {
    detail = (
      <polygon
        points={starPoints(cx, cy, minWH * 0.34)}
        fill="#fff"
        fillOpacity={0.9}
        stroke={dark}
        strokeOpacity={0.35}
        strokeWidth={0.4}
      />
    );
  } else if (kind.value === "carport") {
    // Peaked roof: a ridge down the length with slope lines to the eaves.
    detail = (
      <g stroke={dark} strokeOpacity={0.5} strokeWidth={0.7} fill="none">
        <line x1={cx} y1={py} x2={cx} y2={py + h} />
        <line x1={px} y1={py} x2={cx} y2={py + h * 0.12} />
        <line x1={px + w} y1={py} x2={cx} y2={py + h * 0.12} />
        <line x1={px} y1={py + h} x2={cx} y2={py + h * 0.88} />
        <line x1={px + w} y1={py + h} x2={cx} y2={py + h * 0.88} />
      </g>
    );
  } else if (kind.value === "popup") {
    // Canopy with a scalloped valance + center pole dot.
    detail = (
      <g stroke={dark} strokeOpacity={0.5} strokeWidth={0.6} fill="none">
        <path
          d={`M ${px} ${Y(0.78)} Q ${X(0.25)} ${Y(0.92)} ${X(0.5)} ${Y(0.78)} Q ${X(0.75)} ${Y(0.92)} ${px + w} ${Y(0.78)}`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={minWH * 0.06}
          fill={dark}
          fillOpacity={0.5}
          stroke="none"
        />
      </g>
    );
  } else if (kind.value === "shower") {
    // Shower head + droplets.
    detail = (
      <g stroke={dark} strokeOpacity={0.55} strokeWidth={0.6} fill="none">
        <line x1={cx} y1={py + h * 0.1} x2={cx} y2={Y(0.32)} />
        <ellipse
          cx={cx}
          cy={Y(0.36)}
          rx={w * 0.26}
          ry={h * 0.07}
          fill={dark}
          fillOpacity={0.45}
          stroke="none"
        />
        {[0.36, 0.5, 0.64].map((f) => (
          <line
            key={f}
            x1={X(f)}
            y1={Y(0.5)}
            x2={X(f)}
            y2={Y(0.74)}
            strokeDasharray="0.8 1.2"
          />
        ))}
      </g>
    );
  } else if (kind.value === "evap-pond") {
    // Wavy water lines on the dark pond.
    detail = (
      <g stroke="#74c0fc" strokeOpacity={0.7} strokeWidth={0.7} fill="none">
        {[0.38, 0.56, 0.74].map((f) => (
          <path
            key={f}
            d={`M ${px + w * 0.12} ${Y(f)} q ${w * 0.19} ${-h * 0.08} ${w * 0.38} 0 q ${w * 0.19} ${h * 0.08} ${w * 0.38} 0`}
          />
        ))}
      </g>
    );
  } else if (kind.value === "trash") {
    // Recycling triangle of arrows.
    detail = (
      <polygon
        points={`${X(0.5)},${Y(0.24)} ${X(0.74)},${Y(0.66)} ${X(0.26)},${Y(0.66)}`}
        fill="none"
        stroke="#fff"
        strokeOpacity={0.95}
        strokeWidth={1}
        strokeLinejoin="round"
      />
    );
  } else if (kind.value === "path-light") {
    // Glowing bulb with rays.
    detail = (
      <g>
        <circle
          cx={cx}
          cy={cy}
          r={minWH * 0.22}
          fill="#fff59d"
          stroke={dark}
          strokeOpacity={0.4}
          strokeWidth={0.4}
        />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
          const r = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={cx + Math.cos(r) * minWH * 0.3}
              y1={cy + Math.sin(r) * minWH * 0.3}
              x2={cx + Math.cos(r) * minWH * 0.42}
              y2={cy + Math.sin(r) * minWH * 0.42}
              stroke="#f59f00"
              strokeWidth={0.7}
            />
          );
        })}
      </g>
    );
  }

  return (
    <svg
      width={S}
      height={S}
      viewBox={`0 0 ${S} ${S}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {body}
      {detail}
    </svg>
  );
}
