/**
 * Where things SIT on the camp map — the coordinate system, shared by the full
 * editor and any read-only view so the two can never disagree about where the
 * lot is or how many pixels a foot is.
 *
 * Two coordinate spaces. **Plot-local feet**: (0,0) is the front-left corner of
 * the frontage edge, +y into the lot. That's what every object stores, and it
 * doesn't move when the lot is resized. **View pixels**: the SVG's own units,
 * `VIEW_W` wide. `layoutFor` converts between them.
 *
 * BRC lots are wedges, not rectangles — the streets are arcs around the Man, so
 * a lot's rear edge is wider (Man-facing) or narrower (mountain-facing) than its
 * frontage, and its side edges are radial. `wedgeFor` gives the real curved
 * geometry when a frontage radius is derivable; `straightLotPoints` is the
 * fallback for an event with no such addressing.
 *
 * Pure functions only — no React, no state.
 */
import { radiusForStreet } from "~/lib/brc";
import { clamp } from "~/lib/num";

/** SVG user-space width the whole map is drawn into. */
export const VIEW_W = 920;
export const MARGIN = 28;
/**
 * Default annotation margin (feet) drawn around the lot so officers can mark
 * things outside the border — and room for the surroundings swaths (the ~45ft
 * street in front, the ~20ft rear service road, and neighbor lots on each side).
 *
 * It doubles as the **staging apron**: objects may be parked out here at true
 * scale before anyone commits to siting them (see `map_object.staged`). The
 * editor grows the margin past this default when things are staged far out —
 * `layoutFor`'s `padFt` argument — which is why nothing downstream should read
 * this constant directly. Use `layout.padFt`.
 */
export const PAD_FT = 50;

/** The lot fields the geometry needs. Structural, so the map route's loader
 * type satisfies it without this module knowing about routes. */
export type MapLot = {
  frontageFt: number;
  depthFt: number;
  innerRadiusFt: number | null;
  streetLetter: string | null;
  year: number | null;
  frontsToMan: boolean;
};

export function frontageRadiusOf(lot: {
  innerRadiusFt: number | null;
  streetLetter: string | null;
  year: number | null;
}): number | null {
  return lot.innerRadiusFt ?? radiusForStreet(lot.year, lot.streetLetter);
}

/** Rear (service-alley) edge width in feet. A Man-facing lot widens outward;
 * a mountain-facing lot narrows toward the Man. */
export function rearWidthOf(lot: MapLot, radius: number | null): number {
  if (!radius) return lot.frontageFt;
  const rearRadius = lot.frontsToMan
    ? radius + lot.depthFt
    : radius - lot.depthFt;
  if (rearRadius <= 0) return lot.frontageFt;
  return (lot.frontageFt * rearRadius) / radius;
}

/** Half-width (ft) of the lot trapezoid at depth `y` — interpolates the frontage
 * half-width to the rear half-width. */
export function lotHalfWidthAt(
  y: number,
  frontageFt: number,
  depthFt: number,
  rear: number,
): number {
  const t = depthFt > 0 ? clamp(y / depthFt, 0, 1) : 0;
  return (frontageFt / 2) * (1 - t) + (rear / 2) * t;
}

/** A footprint vertex as an offset (feet) from the object's centre. */
export type FootprintOffset = { x: number; y: number };

/** Is a point (plot-local feet) inside the lot trapezoid? */
export function pointInLot(
  px: number,
  py: number,
  frontageFt: number,
  depthFt: number,
  rear: number,
): boolean {
  if (py < -1e-6 || py > depthFt + 1e-6) return false;
  const half = lotHalfWidthAt(py, frontageFt, depthFt, rear);
  return Math.abs(px - frontageFt / 2) <= half + 1e-6;
}

/** Fit an object's CENTER so its whole ROTATED footprint polygon stays inside the
 * lot trapezoid (not a bounding circle/box). `offs` = the footprint vertices as
 * offsets from the center. Clamps the vertical span into [0, depthFt], then clamps
 * x using each vertex's own half-width at its depth (so the taper is respected).
 * If the shape is bigger than the lot in a dimension, it's centered there. */
export function fitCenterInsideLot(
  cx: number,
  cy: number,
  offs: FootprintOffset[],
  frontageFt: number,
  depthFt: number,
  rear: number,
): { x: number; y: number } {
  if (!offs.length) return { x: cx, y: clamp(cy, 0, depthFt) };
  let minVy = Number.POSITIVE_INFINITY;
  let maxVy = Number.NEGATIVE_INFINITY;
  for (const o of offs) {
    minVy = Math.min(minVy, o.y);
    maxVy = Math.max(maxVy, o.y);
  }
  const yLo = -minVy;
  const yHi = depthFt - maxVy;
  const y = yLo <= yHi ? clamp(cy, yLo, yHi) : (yLo + yHi) / 2;
  const mid = frontageFt / 2;
  let xLo = Number.NEGATIVE_INFINITY;
  let xHi = Number.POSITIVE_INFINITY;
  for (const o of offs) {
    const ay = clamp(y + o.y, 0, depthFt);
    const hw = lotHalfWidthAt(ay, frontageFt, depthFt, rear);
    xLo = Math.max(xLo, mid - hw - o.x);
    xHi = Math.min(xHi, mid + hw - o.x);
  }
  const x = xLo <= xHi ? clamp(cx, xLo, xHi) : (xLo + xHi) / 2;
  return { x, y };
}

/**
 * The lot's four edges as (point on the edge, unit OUTWARD normal) pairs, in
 * plot-local feet. The two side edges are radial, so they slant with the taper —
 * expressing them as half-planes is what lets the "push it out" math below treat
 * all four the same way instead of special-casing the trapezoid.
 */
function lotEdges(frontageFt: number, depthFt: number, rear: number) {
  const mid = frontageFt / 2;
  const side = (
    px: number,
    py: number,
    qx: number,
    qy: number,
    flip: boolean,
  ) => {
    const dx = qx - px;
    const dy = qy - py;
    const len = Math.hypot(dx, dy) || 1;
    // (−dy, dx)/|d| is the left-hand normal; the right edge wants the other one.
    const s = flip ? -1 : 1;
    return { px, py, nx: (s * -dy) / len, ny: (s * dx) / len };
  };
  return [
    { px: 0, py: 0, nx: 0, ny: -1 }, // frontage (street side)
    { px: 0, py: depthFt, nx: 0, ny: 1 }, // rear (service alley side)
    side(0, 0, mid - rear / 2, depthFt, false), // left
    side(frontageFt, 0, mid + rear / 2, depthFt, true), // right
  ];
}

/**
 * Fit an object's CENTER so its whole ROTATED footprint sits entirely OUTSIDE the
 * lot — the staging apron half of "snap fully in or fully out". Picks the lot edge
 * that needs the smallest push and translates along that edge's outward normal
 * until no vertex is on the inner side, so a thing dragged just past the border
 * settles flush against it rather than leaping somewhere else.
 *
 * The lot is convex, so "every vertex outside ONE edge's half-plane" is a sound
 * test for the footprint being clear of it — no polygon clipping needed, and it
 * works for the concave footprints (toy-hauler ramps, RV pop-outs) too.
 */
export function fitCenterOutsideLot(
  cx: number,
  cy: number,
  offs: FootprintOffset[],
  frontageFt: number,
  depthFt: number,
  rear: number,
): { x: number; y: number } {
  const verts = offs.length ? offs : [{ x: 0, y: 0 }];
  let best: { x: number; y: number } | null = null;
  let bestPush = Number.POSITIVE_INFINITY;
  for (const e of lotEdges(frontageFt, depthFt, rear)) {
    // Signed distance of the deepest-inside vertex from this edge; ≥0 = already
    // clear of it, so the push is 0 and this edge wins outright.
    let minD = Number.POSITIVE_INFINITY;
    for (const o of verts) {
      minD = Math.min(
        minD,
        (cx + o.x - e.px) * e.nx + (cy + o.y - e.py) * e.ny,
      );
    }
    const push = Math.max(0, -minD);
    if (push < bestPush) {
      bestPush = push;
      best = { x: cx + e.nx * push, y: cy + e.ny * push };
    }
  }
  return best ?? { x: cx, y: cy };
}

/**
 * Where a ray from a point inside the lot crosses the border (plot-local feet).
 * The lot is convex, so the exit is just the nearest edge the ray is heading
 * toward — and a ray aimed at a corner lands on that corner, which is the case
 * that matters for annotations meant to hang off the camp's edge rather than
 * cut across the middle of everyone's stuff.
 *
 * Falls back to the origin point if the ray heads at no edge at all (a zero
 * direction), so a caller can use the result unconditionally.
 */
export function lotExitPoint(
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  frontageFt: number,
  depthFt: number,
  rear: number,
): { x: number; y: number } {
  let t = Number.POSITIVE_INFINITY;
  for (const e of lotEdges(frontageFt, depthFt, rear)) {
    // Normals point OUT of the lot, so a positive denominator means the ray is
    // heading toward this edge rather than away from (or along) it.
    const denom = ux * e.nx + uy * e.ny;
    if (denom <= 1e-9) continue;
    const hit = ((e.px - cx) * e.nx + (e.py - cy) * e.ny) / denom;
    if (hit >= 0) t = Math.min(t, hit);
  }
  if (!Number.isFinite(t)) return { x: cx, y: cy };
  return { x: cx + ux * t, y: cy + uy * t };
}

/** Is a whole polygon (absolute plot-local feet) clear of the lot? Same convex
 * separating-edge argument as `fitCenterOutsideLot`: one lot edge with every
 * vertex on its outer side proves the polygon and the lot don't overlap. */
export function polygonOutsideLot(
  pts: FootprintOffset[],
  frontageFt: number,
  depthFt: number,
  rear: number,
): boolean {
  if (!pts.length) return false;
  return lotEdges(frontageFt, depthFt, rear).some((e) =>
    pts.every((p) => (p.x - e.px) * e.nx + (p.y - e.py) * e.ny >= -1e-6),
  );
}

/**
 * Snap an object's CENTER either fully inside the lot or fully outside it, never
 * straddling the border. The centre decides which: drag it past the line and the
 * whole footprint follows to that side. That bistable rule is the whole contract
 * of the staging apron — an object is either sited or it is scratch space, and
 * the map should never have to render a half-committed one.
 *
 * Returns the fitted centre plus which side it landed on, since the caller has to
 * persist that (`map_object.staged`) alongside the coordinates.
 */
export function fitCenterToLot(
  cx: number,
  cy: number,
  offs: FootprintOffset[],
  frontageFt: number,
  depthFt: number,
  rear: number,
): { x: number; y: number; staged: boolean } {
  if (pointInLot(cx, cy, frontageFt, depthFt, rear)) {
    return {
      ...fitCenterInsideLot(cx, cy, offs, frontageFt, depthFt, rear),
      staged: false,
    };
  }
  return {
    ...fitCenterOutsideLot(cx, cy, offs, frontageFt, depthFt, rear),
    staged: true,
  };
}

export type MapLayout = {
  /** Rear edge width, feet. */
  rear: number;
  /** Widest of frontage/rear — what the view has to fit. */
  maxWidthFt: number;
  /** Pixels per foot. */
  ppf: number;
  /** The margin this layout was built with, feet (≥ `PAD_FT`). */
  padFt: number;
  /** `padFt` in pixels. */
  padPx: number;
  /** SVG viewBox height for this lot. */
  viewH: number;
  /** Plot-local (0,0) in view pixels. */
  originX: number;
  originY: number;
  /** X of the rear edge's midpoint, view pixels. */
  rearCenterX: number;
  /** Y of the rear edge, view pixels. */
  yBot: number;
};

/**
 * Fit the lot plus an annotation/staging margin on every side into the view.
 *
 * `padFt` widens that margin — the editor passes a larger value when objects are
 * staged out beyond the default apron, so a thing parked outside the border is
 * still on screen. The view width is fixed (`VIEW_W`), so a bigger margin buys
 * room by shrinking `ppf`: the whole map, lot included, is drawn smaller. Read-
 * only callers (the roster mini-map) omit it and get the default.
 */
export function layoutFor(lot: MapLot, padFt: number = PAD_FT): MapLayout {
  // Trapezoid taper: rear edge widens (Man-facing) or narrows (mountain-facing)
  // with depth, from the derived/overridden frontage radius.
  const rear = rearWidthOf(lot, frontageRadiusOf(lot));
  const maxWidthFt = Math.max(lot.frontageFt, rear);
  const pad = Math.max(PAD_FT, padFt);
  const ppf = (VIEW_W - 2 * MARGIN) / (maxWidthFt + 2 * pad);
  const padPx = pad * ppf;
  const viewH = Math.round(MARGIN * 2 + (lot.depthFt + 2 * pad) * ppf);
  // Plot-local (0,0) = front-left corner of the frontage edge, in screen px.
  const originX = MARGIN + padPx + ((maxWidthFt - lot.frontageFt) / 2) * ppf;
  const originY = MARGIN + padPx;
  const rearCenterX = MARGIN + padPx + (maxWidthFt / 2) * ppf;
  const yBot = originY + lot.depthFt * ppf;
  return {
    rear,
    maxWidthFt,
    ppf,
    padFt: pad,
    padPx,
    viewH,
    originX,
    originY,
    rearCenterX,
    yBot,
  };
}

/** Segments per arc. Enough that a lot edge reads as a smooth curve. */
const SEG = 24;

export type MapWedge = {
  /** The lot outline as an SVG polygon `points` string. */
  lotPoints: string;
  /** Frontage radius, feet. */
  rFront: number;
  /** Rear-edge radius, feet. */
  rRear: number;
  /** Half-angle subtended by the frontage. */
  theta: number;
  /** X of the frontage centerline, view pixels. */
  frontCx: number;
  /** A point at feet-radius `r`, polar angle `phi` (0 = frontage centerline). */
  ptXY: (r: number, phi: number) => { x: number; y: number };
  /** Annular sector (rIn..rOut, phi0..phi1) as a closed polygon point list. */
  sector: (rIn: number, rOut: number, phi0: number, phi1: number) => string;
};

/**
 * The lot's true curved geometry, plus the helpers to draw anything concentric
 * with it (streets, the service road, neighbour lots) so they follow the SAME
 * arc as the lot edges rather than being flat bands.
 *
 * Null when no frontage radius is derivable (innerRadius unset and no street),
 * or when the radius is too small to subtend the frontage — callers fall back to
 * `straightLotPoints`.
 */
export function wedgeFor(lot: MapLot, layout: MapLayout): MapWedge | null {
  const { ppf, originX, originY } = layout;
  const rFront = frontageRadiusOf(lot);
  const halfFt = lot.frontageFt / 2;
  if (rFront == null || rFront <= halfFt) return null;

  const sDir = lot.frontsToMan ? 1 : -1; // +1: Man above (front at top); −1: below
  const h = ppf * Math.sqrt(rFront * rFront - halfFt * halfFt);
  const manY = originY - sDir * h; // Man on the frontage's perpendicular bisector
  const frontCx = originX + halfFt * ppf;
  const theta = Math.asin(halfFt / rFront);
  const rRear = lot.frontsToMan
    ? rFront + lot.depthFt
    : Math.max(1, rFront - lot.depthFt);

  const ptXY = (r: number, phi: number) => ({
    x: frontCx + r * ppf * Math.sin(phi),
    y: manY + sDir * r * ppf * Math.cos(phi),
  });
  const pt = (r: number, phi: number) => {
    const p = ptXY(r, phi);
    return `${p.x},${p.y}`;
  };
  const arcPts = (r: number, phi0: number, phi1: number) => {
    const out: string[] = [];
    for (let i = 0; i <= SEG; i++)
      out.push(pt(r, phi0 + ((phi1 - phi0) * i) / SEG));
    return out;
  };
  const sector = (rIn: number, rOut: number, phi0: number, phi1: number) =>
    [...arcPts(rOut, phi0, phi1), ...arcPts(rIn, phi1, phi0)].join(" ");

  const front: string[] = [];
  const back: string[] = [];
  for (let i = 0; i <= SEG; i++) {
    const phi = -theta + (2 * theta * i) / SEG;
    front.push(pt(rFront, phi));
    back.push(pt(rRear, phi));
  }

  return {
    lotPoints: [...front, ...back.reverse()].join(" "),
    rFront,
    rRear,
    theta,
    frontCx,
    ptXY,
    sector,
  };
}

/**
 * The wedge-space angle (`phi`, as `ptXY`/`sector` take it) of another clock
 * position in the city — letting you draw anything the city knows the address
 * of, however far outside the lot, in the lot's own frame.
 *
 * `phi` is measured from the lot's frontage centerline. The map is drawn
 * un-mirrored — clock numbers run clockwise around the Man on the real playa,
 * and `wedgeFor` puts the Man ABOVE a Man-facing lot, so from that lot a later
 * clock is to the LEFT (negative phi). A mountain-facing lot has the Man below
 * it, which flips the sense. (Cross-check: this agrees with `bearingToPlotDelta`
 * + `mapUpBearingFor`, which the compass and shadows use.)
 */
export function cityPhi(
  lotHours: number,
  frontsToMan: boolean,
  hours: number,
): number {
  const sDir = frontsToMan ? 1 : -1;
  return -sDir * (hours - lotHours) * (Math.PI / 6);
}

/** Straight-trapezoid lot outline — the fallback when `wedgeFor` returns null. */
export function straightLotPoints(lot: MapLot, layout: MapLayout): string {
  const { ppf, originX, originY, rearCenterX, yBot, rear } = layout;
  return `${originX},${originY} ${originX + lot.frontageFt * ppf},${originY} ${
    rearCenterX + (rear / 2) * ppf
  },${yBot} ${rearCenterX - (rear / 2) * ppf},${yBot}`;
}

/** The lot outline, curved when the geometry allows and straight otherwise. */
export function lotPointsFor(lot: MapLot, layout: MapLayout): string {
  return wedgeFor(lot, layout)?.lotPoints ?? straightLotPoints(lot, layout);
}
