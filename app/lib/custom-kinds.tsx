/**
 * Camp-defined structure kinds (client-safe). A camp's officers define these in
 * the app (`/map/structures`); they're stored in `structure_kind` and compiled
 * here into ordinary `CampStructure`s, so the map draws, shades, overlap-checks
 * and bans them through exactly the paths built-in and pack kinds use.
 * See plans/custom-structures.md.
 */
import type {
  CampStructure,
  FootprintCtx,
  KindTag,
} from "@camptool/theme-contract";
import { hexVertices, type KindRegistry, makeKindRegistry } from "./structures";

/** The footprint shapes a camp can pick. */
export const CUSTOM_SHAPES = ["rect", "hexagon", "round", "outline"] as const;
export type CustomShape = (typeof CUSTOM_SHAPES)[number];

export const CUSTOM_SHAPE_LABELS: Record<CustomShape, string> = {
  rect: "Rectangle",
  hexagon: "Hexagon",
  round: "Round",
  outline: "Custom outline",
};

const KIND_TAGS: readonly KindTag[] = ["domicile", "vehicle", "structure"];

/** A point of an outline, each coordinate 0..1 of the width/height box. */
export type UnitPt = { x: number; y: number };

/** A camp's kind as the app passes it around (server → browser). */
export type CustomKindData = {
  id: string;
  value: string;
  label: string;
  groupName: string;
  color: string;
  shape: CustomShape;
  width: number;
  height: number;
  /** For `outline` only; 0..1 of the box. */
  outline: UnitPt[] | null;
  tallFt: number;
  canopyShade: boolean;
  tags: KindTag[];
  personal: boolean;
  rigid: boolean;
  fixedRotation: boolean;
  description: string | null;
  sort: number;
  archived: boolean;
};

/** The `structure_kind` columns `toCustomKindData` reads. */
export type CustomKindRow = Omit<
  CustomKindData,
  "shape" | "outline" | "tags" | "archived"
> & {
  shape: string;
  outline: string | null;
  tags: string;
  archivedAt: Date | null;
};

/** Every camp kind value starts with this; built-in and pack kinds never do. */
export const CUSTOM_KIND_PREFIX = "x-";

export function isCustomKindValue(kind: string): boolean {
  return kind.startsWith(CUSTOM_KIND_PREFIX);
}

/** Parse a stored outline: at least 3 points, each clamped to 0..1. */
export function parseOutline(raw: string | null | undefined): UnitPt[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const pts = v
      .filter(
        (p): p is UnitPt =>
          typeof p?.x === "number" &&
          typeof p?.y === "number" &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y),
      )
      .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
    return pts.length >= 3 ? pts : null;
  } catch {
    return null;
  }
}

export function parseTags(raw: string | null | undefined): KindTag[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? KIND_TAGS.filter((t) => (v as unknown[]).includes(t))
      : [];
  } catch {
    return [];
  }
}

export function toCustomKindData(row: CustomKindRow): CustomKindData {
  const shape = (CUSTOM_SHAPES as readonly string[]).includes(row.shape)
    ? (row.shape as CustomShape)
    : "rect";
  const outline = shape === "outline" ? parseOutline(row.outline) : null;
  return {
    id: row.id,
    value: row.value,
    label: row.label,
    groupName: row.groupName,
    color: row.color,
    // An outline that no longer parses draws as its box rather than vanishing.
    shape: shape === "outline" && !outline ? "rect" : shape,
    width: row.width,
    height: row.height,
    outline,
    tallFt: row.tallFt,
    canopyShade: row.canopyShade,
    tags: parseTags(row.tags),
    personal: row.personal,
    rigid: row.rigid,
    fixedRotation: row.fixedRotation,
    description: row.description,
    sort: row.sort,
    archived: row.archivedAt != null,
  };
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/** The unit outline (0..1 box) a shape draws. `rect` has none: it draws through
 * the core rectangle branch. */
export function unitOutline(k: {
  shape: CustomShape;
  outline: UnitPt[] | null;
}): UnitPt[] | null {
  switch (k.shape) {
    case "rect":
      return null;
    case "hexagon":
      return hexVertices(0, 0, 1, 1);
    case "round":
      return Array.from({ length: 32 }, (_, i) => {
        const a = (i / 32) * 2 * Math.PI;
        return { x: 0.5 + Math.cos(a) / 2, y: 0.5 + Math.sin(a) / 2 };
      });
    case "outline":
      return k.outline;
  }
}

/** Twice the signed area (positive = clockwise in screen coordinates). */
function area2(pts: readonly UnitPt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as UnitPt;
    const q = pts[(i + 1) % pts.length] as UnitPt;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

function cross(o: UnitPt, a: UnitPt, b: UnitPt) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsCross(a: UnitPt, b: UnitPt, c: UnitPt, d: UnitPt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Why an outline can't be used, or null if it's fine: at least 3 points, some
 * area, and no edges crossing each other. */
export function outlineProblem(pts: readonly UnitPt[]): string | null {
  if (pts.length < 3) return "An outline needs at least 3 points.";
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip edges that share a corner.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segmentsCross(
          pts[i] as UnitPt,
          pts[(i + 1) % n] as UnitPt,
          pts[j] as UnitPt,
          pts[(j + 1) % n] as UnitPt,
        )
      ) {
        return "The outline's edges cross each other.";
      }
    }
  }
  if (Math.abs(area2(pts)) < 1e-4) return "The outline has no area.";
  return null;
}

/**
 * Split a simple polygon into triangles (ear clipping). The shade sim casts
 * each part's convex hull, so a concave outline (an L-shaped kitchen) has to
 * go in as convex pieces to throw its true shadow.
 */
export function triangulate(pts: readonly UnitPt[]): UnitPt[][] {
  if (pts.length < 3) return [];
  // Work counter-clockwise in the math sense (area2 < 0 here, since y is down).
  const ring = area2(pts) > 0 ? [...pts].reverse() : [...pts];
  const out: UnitPt[][] = [];
  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length] as UnitPt;
      const b = ring[i] as UnitPt;
      const c = ring[(i + 1) % ring.length] as UnitPt;
      if (cross(a, b, c) >= 0) continue; // reflex (or flat) corner
      // Any other corner inside the ear, or on its edge, blocks it (a corner
      // on the cut would leave a notch filled in).
      const same = (p: UnitPt, q: UnitPt) => p.x === q.x && p.y === q.y;
      const inside = ring.some(
        (p) =>
          !same(p, a) &&
          !same(p, b) &&
          !same(p, c) &&
          cross(a, b, p) <= 0 &&
          cross(b, c, p) <= 0 &&
          cross(c, a, p) <= 0,
      );
      if (inside) continue;
      out.push([a, b, c]);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate input: fall back to the whole ring as one part.
    if (!clipped) break;
  }
  out.push(ring);
  return out;
}

const fmt = (n: number) => Math.round(n * 100) / 100;

/** Compile a camp's kind into a `CampStructure` the map handles like any other. */
export function compileCustomKind(k: CustomKindData): CampStructure {
  const base: CampStructure = {
    value: k.value,
    label: k.label,
    color: k.color,
    w: k.width,
    h: k.height,
    shape: "rect",
    vehicle: false,
    rigid: k.rigid,
    group: k.groupName,
    tags: k.tags,
    personal: k.personal,
    canopyShade: k.canopyShade || undefined,
    fixedRotation: k.fixedRotation || undefined,
    tallFt: k.tallFt,
    description: k.description ?? undefined,
  };
  const unit = unitOutline(k);
  if (!unit) return base;
  const parts = triangulate(unit);
  return {
    ...base,
    shape: "custom",
    // Object-local centered feet, the frame overlap checks and shadows use.
    footprint: (w, h) =>
      unit.map((p) => ({ x: (p.x - 0.5) * w, y: (p.y - 0.5) * h })),
    // Each convex piece extruded to the object's height; a shade canopy casts
    // only its top.
    shadowVolume: (w, h) =>
      parts.map((tri) =>
        (k.canopyShade ? [1] : [0, 1]).flatMap((z) =>
          tri.map((p) => ({ x: (p.x - 0.5) * w, y: (p.y - 0.5) * h, z })),
        ),
      ),
    renderFootprint: (ctx: FootprintCtx) => {
      const points = unit
        .map((p) => `${fmt(p.x * ctx.w)},${fmt(p.y * ctx.h)}`)
        .join(" ");
      return (
        <polygon
          points={points}
          fill={ctx.color}
          fillOpacity={k.canopyShade ? 0.18 : 0.78}
          stroke={ctx.selected ? "#1c1c1c" : ctx.color}
          strokeWidth={ctx.selected ? 2 : k.canopyShade ? 2 : 1}
          strokeDasharray={k.canopyShade ? "6 4" : undefined}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          pointerEvents={k.canopyShade ? "none" : undefined}
        />
      );
    },
    renderIcon: (size: number) => {
      const pad = size * 0.14;
      const scale = (size - 2 * pad) / Math.max(k.width, k.height, 0.01);
      const w = k.width * scale;
      const h = k.height * scale;
      const x0 = (size - w) / 2;
      const y0 = (size - h) / 2;
      return (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ display: "block", flex: "0 0 auto" }}
          aria-hidden="true"
        >
          <polygon
            points={unit
              .map((p) => `${fmt(x0 + p.x * w)},${fmt(y0 + p.y * h)}`)
              .join(" ")}
            fill={k.color}
            fillOpacity={k.canopyShade ? 0.35 : 0.85}
            stroke={k.color}
            strokeWidth={1}
            strokeLinejoin="round"
          />
        </svg>
      );
    },
  };
}

/** A camp's registry: built-ins, packs, and the camp's own kinds (archived
 * ones still draw but can't be placed). */
export function customKindRegistry(
  kinds: readonly CustomKindData[],
): KindRegistry {
  const sorted = [...kinds].sort(
    (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
  );
  return makeKindRegistry(
    sorted.map(compileCustomKind),
    new Set(sorted.filter((k) => k.archived).map((k) => k.value)),
  );
}
