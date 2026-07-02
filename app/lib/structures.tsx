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
  },
  {
    value: "van",
    label: "Van",
    color: "#4c6ef5",
    w: 7,
    h: 17,
    shape: "rect",
    vehicle: true,
    rigid: true,
    group: "Vehicles",
    tags: ["vehicle"],
    personal: true,
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
