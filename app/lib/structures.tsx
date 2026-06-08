/**
 * Shared structure palette for the camp map + the "Bringing" inventory page.
 * Each kind carries a footprint `shape`, default size (feet), and vehicle rules:
 * `vehicle` = fixed width + length-only; `rigid` = no free resize.
 *
 * (Later: a self-hoster's camp package can extend this registry with custom
 * kinds — see Phase 2.5 / the custom-structures task.)
 */
export type ShapeKind = "rect" | "hexagon" | "hypar";

export type Kind = {
  value: string;
  label: string;
  color: string;
  w: number;
  h: number;
  shape: ShapeKind;
  vehicle: boolean;
  rigid: boolean;
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
  },
  {
    value: "container",
    label: "Container",
    color: "#868e96",
    w: 8,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: false,
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
  },
] as const;

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
