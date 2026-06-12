/**
 * Shared structure palette for the camp map + the "Bringing" inventory page.
 * Each kind carries a footprint `shape`, default size (feet), and vehicle rules:
 * `vehicle` = fixed width + length-only; `rigid` = no free resize.
 *
 * (Later: a self-hoster's camp package can extend this registry with custom
 * kinds — see Phase 2.5 / the custom-structures task.)
 */
import type { ReactNode } from "react";

export type ShapeKind = "rect" | "hexagon" | "hypar";

/** Highlight categories an object can belong to (a kind can carry several —
 * an RV is both a domicile and a vehicle). Drives the map's highlight filter. */
export type KindTag = "domicile" | "vehicle" | "structure";

export type Kind = {
  value: string;
  label: string;
  color: string;
  w: number;
  h: number;
  shape: ShapeKind;
  vehicle: boolean;
  rigid: boolean;
  /** Legend grouping heading. */
  group: string;
  /** Highlight categories this kind belongs to. */
  tags: readonly KindTag[];
};

export const KINDS = [
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
  },
  // Regular hexagon, 8ft edges → 16ft point-to-point, 8√3 ≈ 13.86ft flat-to-flat.
  {
    value: "hexayurt",
    label: "Hexayurt",
    color: "#0ca678",
    w: 16,
    h: 13.86,
    shape: "hexagon",
    vehicle: false,
    rigid: true,
    group: "Domiciles",
    tags: ["domicile"],
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
  },
  // Shipping containers come in known sizes: fixed 8ft width, length is either
  // full (40ft) or half (20ft). See CONTAINER_* + the map's Full/Half toggle.
  {
    value: "container",
    label: "Container",
    color: "#868e96",
    w: 8,
    h: 40,
    shape: "rect",
    vehicle: false,
    rigid: true,
    group: "Structures",
    tags: ["structure"],
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
  },
] as const;

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

const KIND_MAP: Record<string, (typeof KINDS)[number]> = Object.fromEntries(
  KINDS.map((k) => [k.value, k]),
);
const FALLBACK_KIND = KINDS.find((k) => k.value === "structure") ?? KINDS[0];

export function kindDef(kind: string): (typeof KINDS)[number] {
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
export function KindIcon({ kind, size = 30 }: { kind: Kind; size?: number }) {
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
    detail = (
      <line
        x1={cx}
        y1={py + 1.5}
        x2={cx}
        y2={py + h - 1.5}
        stroke={dark}
        strokeOpacity={0.4}
        strokeWidth={0.7}
      />
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
