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
 * Annotation margin (feet) drawn around the lot so officers can mark things
 * outside the border — and room for the surroundings swaths (the ~45ft street
 * in front, the ~20ft rear service road, and neighbor lots on each side).
 * Objects stay inside the lot; zones and power lines may extend into this area.
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

export type MapLayout = {
  /** Rear edge width, feet. */
  rear: number;
  /** Widest of frontage/rear — what the view has to fit. */
  maxWidthFt: number;
  /** Pixels per foot. */
  ppf: number;
  /** `PAD_FT` in pixels. */
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

/** Fit the lot plus a `PAD_FT` annotation margin on every side into the view. */
export function layoutFor(lot: MapLot): MapLayout {
  // Trapezoid taper: rear edge widens (Man-facing) or narrows (mountain-facing)
  // with depth, from the derived/overridden frontage radius.
  const rear = rearWidthOf(lot, frontageRadiusOf(lot));
  const maxWidthFt = Math.max(lot.frontageFt, rear);
  const ppf = (VIEW_W - 2 * MARGIN) / (maxWidthFt + 2 * PAD_FT);
  const padPx = PAD_FT * ppf;
  const viewH = Math.round(MARGIN * 2 + (lot.depthFt + 2 * PAD_FT) * ppf);
  // Plot-local (0,0) = front-left corner of the frontage edge, in screen px.
  const originX = MARGIN + padPx + ((maxWidthFt - lot.frontageFt) / 2) * ppf;
  const originY = MARGIN + padPx;
  const rearCenterX = MARGIN + padPx + (maxWidthFt / 2) * ppf;
  const yBot = originY + lot.depthFt * ppf;
  return {
    rear,
    maxWidthFt,
    ppf,
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
