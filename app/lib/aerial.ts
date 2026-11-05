/**
 * Geometry for an aerial photo laid under the camp map (see
 * plans/map-aerial-photo.md). Pure, so it's testable and shared by the editor
 * and the server's input clamping.
 *
 * Frames:
 *   image  pixels of the original picture, origin top-left, +y down.
 *   plot   plot-local feet (db/schema/map.ts header): origin = the lot's
 *          front-left corner, +x along the frontage, +y away from the street.
 *          Also +y down on screen, so a clockwise screen rotation is a
 *          positive angle in the usual (x, y) rotation formula.
 *
 * A placement maps an image pixel p to plot feet:
 *   plot = c + s · R(θ) · (p − size/2)
 * where c = (cx, cy), s = ftPerPx, θ = rotation (deg, clockwise on screen).
 */

export type Pt = { x: number; y: number };

/** One aerial photo as the map page gets it (a `map_aerial` row, flattened). */
export type AerialRow = {
  id: string;
  imageId: string;
  label: string | null;
  pxWidth: number;
  pxHeight: number;
  cx: number;
  cy: number;
  ftPerPx: number;
  rotation: number;
  opacity: number;
  cropX0: number;
  cropY0: number;
  cropX1: number;
  cropY1: number;
  visible: boolean;
  /** A smaller display copy exists, so the map can draw that at low zoom. */
  hasDisplay: boolean;
};

export type AerialTransform = {
  pxWidth: number;
  pxHeight: number;
  cx: number;
  cy: number;
  ftPerPx: number;
  rotation: number;
};

/** Normalize an angle to (−180, 180]. */
export function normDeg(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

export function imageToPlot(t: AerialTransform, p: Pt): Pt {
  const r = (t.rotation * Math.PI) / 180;
  const u = p.x - t.pxWidth / 2;
  const v = p.y - t.pxHeight / 2;
  return {
    x: t.cx + t.ftPerPx * (u * Math.cos(r) - v * Math.sin(r)),
    y: t.cy + t.ftPerPx * (u * Math.sin(r) + v * Math.cos(r)),
  };
}

export function plotToImage(t: AerialTransform, p: Pt): Pt {
  const r = (t.rotation * Math.PI) / 180;
  const dx = (p.x - t.cx) / t.ftPerPx;
  const dy = (p.y - t.cy) / t.ftPerPx;
  return {
    x: t.pxWidth / 2 + dx * Math.cos(r) + dy * Math.sin(r),
    y: t.pxHeight / 2 - dx * Math.sin(r) + dy * Math.cos(r),
  };
}

/**
 * Two-point alignment. Given two features as seen in the photo (`img`, image
 * pixels) and where they are on the map (`plot`, feet), return the one
 * similarity transform (move + turn + uniform scale) that lands both exactly.
 * A photo has no reason to be mirrored, so reflections aren't considered.
 *
 * Null when the two photo points coincide or the two map points do — there's
 * no scale or direction to read from a single point.
 */
export function fitTwoPoints(
  size: { pxWidth: number; pxHeight: number },
  img: [Pt, Pt],
  plot: [Pt, Pt],
): AerialTransform | null {
  // Complex ratio z = (P2 − P1) / (Q2 − Q1) = s·e^{iθ}, with Q centred.
  const qx = img[1].x - img[0].x;
  const qy = img[1].y - img[0].y;
  const px = plot[1].x - plot[0].x;
  const py = plot[1].y - plot[0].y;
  const qq = qx * qx + qy * qy;
  if (qq < 1e-9 || px * px + py * py < 1e-9) return null;
  const zr = (px * qx + py * qy) / qq;
  const zi = (py * qx - px * qy) / qq;
  const s = Math.hypot(zr, zi);
  const rotation = normDeg((Math.atan2(zi, zr) * 180) / Math.PI);
  // c = P1 − z·(Q1 − size/2)
  const u = img[0].x - size.pxWidth / 2;
  const v = img[0].y - size.pxHeight / 2;
  return {
    pxWidth: size.pxWidth,
    pxHeight: size.pxHeight,
    cx: plot[0].x - (zr * u - zi * v),
    cy: plot[0].y - (zi * u + zr * v),
    ftPerPx: s,
    rotation,
  };
}

/**
 * Seed rotation (deg, clockwise on screen) for a photo whose "up" points at
 * compass bearing `imageUpBearing`, on a map whose "up" points at
 * `mapUpBearing`. A feature at bearing β sits (β − imageUp) clockwise of up in
 * the photo and must end up (β − mapUp) clockwise of up on the map.
 */
export function seedRotation(
  imageUpBearing: number,
  mapUpBearing: number,
): number {
  return normDeg(imageUpBearing - mapUpBearing);
}

/**
 * A first placement for a freshly uploaded photo, before anyone has aligned
 * it: centred on the lot, turned by the orientation seed, and sized so its
 * longer side spans a bit more than the lot's longer side (an aerial of a
 * camp usually shows some street and neighbours around it).
 */
export function initialTransform(opts: {
  pxWidth: number;
  pxHeight: number;
  frontageFt: number;
  depthFt: number;
  rotation: number;
}): AerialTransform {
  const longestPx = Math.max(opts.pxWidth, opts.pxHeight, 1);
  const longestFt = Math.max(opts.frontageFt, opts.depthFt, 1);
  return {
    pxWidth: opts.pxWidth,
    pxHeight: opts.pxHeight,
    cx: opts.frontageFt / 2,
    cy: opts.depthFt / 2,
    ftPerPx: (longestFt * 1.15) / longestPx,
    rotation: normDeg(opts.rotation),
  };
}

/** Clamp a crop window to [0,1] with a minimum size, ordered low→high. */
export function cleanCrop(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { cropX0: number; cropY0: number; cropX1: number; cropY1: number } {
  const c = (v: number) =>
    Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  let a = Math.min(c(x0), c(x1));
  let b = Math.max(c(x0), c(x1));
  let d = Math.min(c(y0), c(y1));
  let e = Math.max(c(y0), c(y1));
  const MIN = 0.02;
  if (b - a < MIN) [a, b] = [0, 1];
  if (e - d < MIN) [d, e] = [0, 1];
  return { cropX0: a, cropY0: d, cropX1: b, cropY1: e };
}
