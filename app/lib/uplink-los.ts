/**
 * Line of sight from a camp uplink radio to a distant tower — the one question
 * the map answers that you can't answer by eye: *does this corner of this
 * structure actually see the NOC?*
 *
 * Pure geometry, deliberately outside the map route so it can be unit-tested
 * (`uplink-los.test.ts`) without a browser. Everything is **plot-local feet**;
 * the map's view differs only by a uniform scale, so the caller can hand over a
 * unit vector computed in pixels and it stays valid here.
 *
 * See `plans/noc-uplink-radio.md` for where the numbers come from.
 */
import type { StructureConfig } from "@camptool/theme-contract";
import { crossSectionLevels, crossSectionOutline } from "~/lib/map-shapes";
import { kindDef, kindHeight } from "~/lib/structures";

/** The parts of a placed map object this test needs. */
export type LosObject = {
  kind: string;
  /** Top-left corner of the object's box, plot-local feet (the `map_object`
   * convention), so the centre is `x + width / 2`. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  config: StructureConfig;
  mirrored: boolean;
  /** Height above ground, feet. Falls back to the kind's default. */
  tallFt?: number | null;
};

/** The beam, as the map has already worked it out. */
export type SightLine = {
  /** The radio, plot-local feet. */
  fx: number;
  fy: number;
  /** Unit vector from the radio toward the target. */
  ux: number;
  uy: number;
  /** Half-angle of the beam (radians) = the target's angular radius. The link
   * has to cover the whole target circle, so anything inside this wedge is in
   * the way, not just what's dead centre. */
  half: number;
  /** Antenna height above ground, feet. */
  mastFt: number;
  /** Distance to the target, feet. */
  distFt: number;
  /** The far antenna's height above ground, feet. */
  targetHeightFt: number;
};

/**
 * How high the sight line is `d` feet along the path. It CLIMBS — from our mast
 * to the tower's antennas — which is why something low well down the path
 * clears even when it out-tops the mast at its own base.
 */
export function sightHeightAt(s: SightLine, d: number): number {
  return s.mastFt + (s.targetHeightFt - s.mastFt) * (d / (s.distFt || 1));
}

function rotate(vx: number, vy: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: vx * cos - vy * sin, y: vx * sin + vy * cos };
}

/**
 * Where the beam's centre line first meets this slice, as a distance along the
 * path — `null` if it misses. Beam-relative coordinates: `along` down the path,
 * `off` across it.
 *
 * This is the distance the height comparison wants, because the line climbs:
 * the nearest CORNER of a shape can be well off to the side and much closer
 * than the point the line actually crosses, which reads the line lower than it
 * really is there and over-reports blockage.
 */
function rayEntry(pts: Array<{ along: number; off: number }>): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as { along: number; off: number };
    const q = pts[(i + 1) % pts.length] as { along: number; off: number };
    if (p.off === q.off) continue;
    const t = p.off / (p.off - q.off); // crossing of off = 0
    if (t < 0 || t > 1) continue;
    const along = p.along + (q.along - p.along) * t;
    if (along > 0) best = Math.min(best, along);
  }
  return best === Number.POSITIVE_INFINITY ? null : best;
}

/**
 * Is this object in the way?
 *
 * The solid and the sight line are BOTH moving, so they're compared level by
 * level:
 *
 * - the line climbs toward the far antenna (`sightHeightAt`);
 * - a solid can taper — the Sierpinski pyramid is a tetrahedron, 40′ across at
 *   the ground and a point at 32.7′ — so its slice shrinks as you look higher.
 *   A prism's ladder is one rung (its top), which is the plain "is it taller
 *   than the line where it stands" test.
 *
 * A level blocks when its slice falls inside the beam wedge AND sits above the
 * line where the slice first meets the path. Shade cloth never blocks: a canopy
 * is fabric on legs, and a microwave link goes straight through it.
 */
export function blocksSightLine(other: LosObject, s: SightLine): boolean {
  const def = kindDef(other.kind);
  if (def.canopyShade) return false;
  const tall = other.tallFt || kindHeight(other.kind);
  if (tall <= 0) return false;
  const cx = other.x + other.width / 2;
  const cy = other.y + other.height / 2;
  for (const z of crossSectionLevels(other.kind, tall)) {
    const slice = crossSectionOutline(
      other.kind,
      other.width,
      other.height,
      other.config,
      other.mirrored,
      z,
      tall,
    );
    if (!slice || slice.length < 3) continue;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let near = Number.POSITIVE_INFINITY;
    const beamLocal: Array<{ along: number; off: number }> = [];
    for (const [lx, ly] of slice) {
      const v = rotate(lx, ly, other.rotation);
      const vx = cx + v.x - s.fx;
      const vy = cy + v.y - s.fy;
      const along = vx * s.ux + vy * s.uy;
      const off = vx * s.uy - vy * s.ux;
      beamLocal.push({ along, off });
      // Only vertices in FRONT of the radio: behind-vertices sit near ±π and
      // would wrap the angular interval. A structure the radio is mounted ON
      // keeps its front vertices, which is exactly what we want to test.
      if (along <= 0) continue;
      lo = Math.min(lo, Math.atan2(off, along));
      hi = Math.max(hi, Math.atan2(off, along));
      near = Math.min(near, along);
    }
    if (near === Number.POSITIVE_INFINITY) continue;
    if (hi < -s.half || lo > s.half) continue;
    // Prefer where the line actually crosses this slice; fall back to the
    // nearest corner for a slice the centre line misses but the beam's width
    // still clips.
    if (z > sightHeightAt(s, rayEntry(beamLocal) ?? near)) return true;
  }
  return false;
}
