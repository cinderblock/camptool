/**
 * Line-of-sight tests for the uplink radio (`app/lib/uplink-los.ts`).
 *
 * The scenario is Math Camp's real one, simplified: a radio at the origin
 * aiming straight down +y at a target 4,872′ away whose antennas are 40′ up,
 * covering a 100′-wide target circle. Distances are feet.
 *
 * Two kinds of tapering solid are covered: a core `dome`, and the camp theme's
 * Sierpinski pyramid (whose theme package has to be mocked in — see below).
 */
import { describe, expect, mock, test } from "bun:test";
import mathCampTheme from "@camptool/mathcamp-theme";
import type { LosObject, SightLine } from "~/lib/uplink-los";

// The camp theme is a Vite build-time alias, so under `bun test` `~/theme`
// resolves to the empty default and the palette has no pyramid. Swap it in
// first, then load the module under test, so the Sierpinski cases below run
// through the real `kindDef` → `crossSectionAt` path the app uses.
mock.module("~/theme", () => ({
  theme: mathCampTheme,
  campStructures: mathCampTheme.structures,
}));
const { blocksSightLine } = await import("~/lib/uplink-los");

const DIST = 4872;
const beam = (mastFt: number): SightLine => ({
  fx: 0,
  fy: 0,
  ux: 0,
  uy: 1,
  half: Math.asin(50 / DIST), // 100′ target circle ≈ ±0.6°
  mastFt,
  distFt: DIST,
  targetHeightFt: 40,
});

/** An object centred at (cx, cy) — the helper takes the box's top-left. */
const at = (
  kind: string,
  cx: number,
  cy: number,
  width: number,
  height: number,
  tallFt: number,
): LosObject => ({
  kind,
  x: cx - width / 2,
  y: cy - height / 2,
  width,
  height,
  rotation: 0,
  config: {},
  mirrored: false,
  tallFt,
});

describe("blocksSightLine", () => {
  // The regression from plans/noc-uplink-radio.md: the sight line climbs, so
  // the same container blocks a 6′ mast and clears a 12′ one.
  const container = at("container", 0, 40, 8, 20, 9.5);

  test("a 9.5′ container blocks a 6′ mast", () => {
    expect(blocksSightLine(container, beam(6))).toBe(true);
  });

  test("…and clears a 12′ mast — the line has climbed past it", () => {
    expect(blocksSightLine(container, beam(12))).toBe(false);
  });

  test("something off to the side isn't in the beam", () => {
    expect(blocksSightLine(at("container", 60, 40, 8, 20, 9.5), beam(6))).toBe(
      false,
    );
  });

  test("something behind the radio isn't in the beam", () => {
    expect(blocksSightLine(at("container", 0, -40, 8, 20, 9.5), beam(6))).toBe(
      false,
    );
  });

  test("shade cloth doesn't obscure the radio", () => {
    // Same footprint and height as a blocking solid — it's the canopy flag,
    // not the geometry, that lets the link through.
    expect(blocksSightLine(at("shade", 0, 40, 20, 20, 10), beam(6))).toBe(
      false,
    );
    expect(blocksSightLine(at("carport", 0, 40, 20, 20, 10), beam(6))).toBe(
      false,
    );
    expect(blocksSightLine(at("popup", 0, 40, 20, 20, 10), beam(6))).toBe(
      false,
    );
  });

  test("a zero-height thing never blocks", () => {
    expect(blocksSightLine(at("path-light", 0, 40, 1, 1, 0), beam(6))).toBe(
      false,
    );
  });

  // A tapering solid is compared level by level. The beam grazes the LEFT RIM
  // of a 30′-wide, 12′-tall dome centred 14′ to the right: as a box it blocks
  // (its top is 12′, the line is at ~6.2′ there), but the dome is only that
  // tall near its middle, and by the time the slice is high enough to matter
  // it has shrunk clear of the beam.
  test("a box that height blocks the beam grazing its edge", () => {
    expect(blocksSightLine(at("structure", 14, 40, 30, 30, 12), beam(6))).toBe(
      true,
    );
  });

  test("…but the dome of the same size and height does not — it tapers", () => {
    expect(blocksSightLine(at("dome", 14, 40, 30, 30, 12), beam(6))).toBe(
      false,
    );
  });

  test("the dome still blocks when the beam goes through its middle", () => {
    expect(blocksSightLine(at("dome", 0, 40, 30, 30, 12), beam(6))).toBe(true);
  });

  // The pyramid is the case that motivated all this: a 40′ tetrahedron whose
  // face slopes away from 32.7′ at the middle to nothing at the edge. Here the
  // beam clips its left side, ~4′ inside the base — over a part of the solid
  // that's only a few feet tall.
  const pyramid = (mastFt: number) =>
    blocksSightLine(
      {
        kind: "sierpinski-pyramid",
        x: 14 - 20,
        y: 60 - 34.64 / 2,
        width: 40,
        height: 34.64,
        rotation: 0,
        config: {},
        mirrored: false,
        tallFt: 40 * Math.sqrt(2 / 3),
      },
      beam(mastFt),
    );

  test("a 12′ mast sees over the pyramid's sloping edge", () => {
    // Treated as a 32.7′ box (or as its ground triangle), this is "blocked".
    expect(pyramid(12)).toBe(false);
  });

  test("…and a 6′ mast doesn't", () => {
    expect(pyramid(6)).toBe(true);
  });

  test("the pyramid still blocks through its middle at any sane mast height", () => {
    expect(
      blocksSightLine(
        {
          kind: "sierpinski-pyramid",
          x: -20,
          y: 60 - 34.64 / 2,
          width: 40,
          height: 34.64,
          rotation: 0,
          config: {},
          mirrored: false,
          tallFt: 40 * Math.sqrt(2 / 3),
        },
        beam(12),
      ),
    ).toBe(true);
  });
});

describe("Sierpinski pyramid cross-section", () => {
  const EDGE = 40;
  const H = EDGE * (Math.sqrt(3) / 2);
  const TALL = EDGE * Math.sqrt(2 / 3); // ≈ 32.66′
  const sierpinskiPyramid = mathCampTheme.structures.find(
    (s) => s.value === "sierpinski-pyramid",
  );
  if (!sierpinskiPyramid) throw new Error("the camp theme lost the pyramid");
  const section = (z: number) =>
    sierpinskiPyramid.crossSectionAt?.(z, EDGE, H, {}) ?? null;
  const area = (pts: ReadonlyArray<{ x: number; y: number }>) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as { x: number; y: number };
      const q = pts[(i + 1) % pts.length] as { x: number; y: number };
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };

  test("at the ground it's the full 40′ base triangle", () => {
    const s = section(0);
    expect(s).not.toBeNull();
    expect(area(s as { x: number; y: number }[])).toBeCloseTo(
      (EDGE * H) / 2,
      3,
    );
  });

  test("halfway up it's half the edge — a quarter of the area", () => {
    const s = section(TALL / 2) as { x: number; y: number }[];
    expect(area(s)).toBeCloseTo((EDGE * H) / 2 / 4, 3);
  });

  test("it shrinks about the centroid, not a corner", () => {
    const c = (pts: { x: number; y: number }[]) => ({
      x: pts.reduce((t, p) => t + p.x, 0) / pts.length,
      y: pts.reduce((t, p) => t + p.y, 0) / pts.length,
    });
    const g0 = c(section(0) as { x: number; y: number }[]);
    const g1 = c(section(TALL * 0.8) as { x: number; y: number }[]);
    expect(g1.x).toBeCloseTo(g0.x, 6);
    expect(g1.y).toBeCloseTo(g0.y, 6);
  });

  test("above the apex there's nothing left", () => {
    expect(section(TALL)).toBeNull();
    expect(section(TALL + 1)).toBeNull();
  });
});
