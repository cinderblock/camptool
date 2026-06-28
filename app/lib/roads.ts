/**
 * In-camp road geometry (client-safe): fire lanes, service roads, access
 * walkways. A road is an open **centerline** polyline with a real width, drawn as
 * a band. At ~90° corners the band is chamfered at 45° by a `cutback` length —
 * Burning Man's published "turn allowance" (a triangle with 20-ft legs) that lets
 * fire/service trucks swing the corner without clipping it.
 */

export type RoadPt = { x: number; y: number };

/** Road presets: default width (ft) + color + label per kind. */
export const ROAD_KINDS = [
  { value: "fire-lane", label: "Fire lane", color: "#fa5252", width: 20 },
  { value: "service-road", label: "Service road", color: "#868e96", width: 20 },
  { value: "walkway", label: "Access walkway", color: "#fab005", width: 6 },
] as const;

/** Burning Man's published turn-allowance cutback (a triangle with 20-ft legs). */
export const DEFAULT_ROAD_CUTBACK = 20;

export function roadKindDef(kind: string): (typeof ROAD_KINDS)[number] {
  return ROAD_KINDS.find((k) => k.value === kind) ?? ROAD_KINDS[0];
}
export function roadKindLabel(kind: string): string {
  return roadKindDef(kind).label;
}

const cross = (a: RoadPt, b: RoadPt) => a.x * b.y - a.y * b.x;

/** One side (sign +1 = left, −1 = right) of a corner: the two offset-edge points
 * for the chamfer, measured as `cut` feet back from the TRUE band corner (the
 * miter intersection of the two offset edges) along each edge — so the cutback's
 * legs are exactly `cut` feet on the actual road edge, matching BM's rule. With
 * `cut` = 0 this collapses to the sharp miter corner (a plain bend). */
function cornerPts(
  p: RoadPt,
  a: { d: RoadPt; nrm: RoadPt },
  b: { d: RoadPt; nrm: RoadPt },
  half: number,
  sign: number,
  cut: number,
): RoadPt[] {
  const a0 = { x: p.x + sign * a.nrm.x * half, y: p.y + sign * a.nrm.y * half };
  const b0 = { x: p.x + sign * b.nrm.x * half, y: p.y + sign * b.nrm.y * half };
  const cr = cross(a.d, b.d);
  if (Math.abs(cr) < 1e-4) return [a0]; // ~straight: no real corner
  const t = cross({ x: b0.x - a0.x, y: b0.y - a0.y }, b.d) / cr;
  const corner = { x: a0.x + a.d.x * t, y: a0.y + a.d.y * t };
  if (cut <= 0) return [corner];
  return [
    { x: corner.x - a.d.x * cut, y: corner.y - a.d.y * cut },
    { x: corner.x + b.d.x * cut, y: corner.y + b.d.y * cut },
  ];
}

/**
 * The filled road band outline (plot-local feet) for a centerline, width, and
 * corner cutback. Walks the left edge forward then the right edge back, so the
 * result is one closed polygon. At interior corners that are roughly right angles
 * the corner is chamfered at 45° with legs of `cutback` feet on each road edge
 * (BM's 20-ft turn allowance); gentler bends just miter. Fewer than two points →
 * no band.
 */
export function roadOutline(
  pts: RoadPt[],
  width: number,
  cutback: number,
): RoadPt[] {
  const n = pts.length;
  if (n < 2) return [];
  const half = Math.max(0.5, width / 2);
  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as RoadPt;
    const b = pts[i + 1] as RoadPt;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = { x: dx / len, y: dy / len };
    // Left normal (90° CCW): points to the road's left edge.
    seg.push({ d, nrm: { x: -d.y, y: d.x }, len });
  }
  const left: RoadPt[] = [];
  const right: RoadPt[] = [];
  const p0 = pts[0] as RoadPt;
  const s0 = seg[0] as (typeof seg)[number];
  left.push({ x: p0.x + s0.nrm.x * half, y: p0.y + s0.nrm.y * half });
  right.push({ x: p0.x - s0.nrm.x * half, y: p0.y - s0.nrm.y * half });
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i] as RoadPt;
    const a = seg[i - 1] as (typeof seg)[number];
    const b = seg[i] as (typeof seg)[number];
    const dot = a.d.x * b.d.x + a.d.y * b.d.y; // cos(turn angle)
    // Cut back only near right angles (|turn − 90°| ≲ 35° ⇒ |dot| < 0.57); gentler
    // bends miter (cut = 0). Clamp so the legs can't overrun a short segment.
    const cut =
      Math.abs(dot) < 0.57 ? Math.min(cutback, a.len * 0.45, b.len * 0.45) : 0;
    left.push(...cornerPts(p, a, b, half, 1, cut));
    right.push(...cornerPts(p, a, b, half, -1, cut));
  }
  const pn = pts[n - 1] as RoadPt;
  const sl = seg[n - 2] as (typeof seg)[number];
  left.push({ x: pn.x + sl.nrm.x * half, y: pn.y + sl.nrm.y * half });
  right.push({ x: pn.x - sl.nrm.x * half, y: pn.y - sl.nrm.y * half });
  return [...left, ...right.reverse()];
}
