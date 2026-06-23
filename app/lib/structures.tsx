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
    // Slide the door along the side (length) edge (fraction of the wall).
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
    group: "Structures",
    tags: ["structure"],
    personal: true,
    // Open shade cloth: casts only its top layer; porous to wind.
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
  const order = ["Domiciles", "Vehicles", "Structures", "Power"];
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
  const isShade = kind.value === "shade";

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
        fillOpacity={isShade ? 0.25 : 0.85}
        stroke={c}
        strokeOpacity={isShade ? 1 : 0.55}
        strokeWidth={isShade ? 1.25 : 0.75}
        strokeDasharray={isShade ? "3 2" : undefined}
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
