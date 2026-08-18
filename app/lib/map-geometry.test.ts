/**
 * The lot-fitting family — the rules that keep an object either sited in the lot
 * or parked in the staging apron, never straddling the border.
 *
 * Two lot shapes are exercised throughout: a plain 100×100 rectangle (no
 * derivable street radius) and a Man-facing wedge whose rear edge is wider than
 * its frontage. The wedge is the one that matters — its side edges slant, so any
 * "push it outside" that assumes axis-aligned walls passes the rectangle and
 * quietly leaves things half in the lot on a real BRC plot.
 */
import { describe, expect, test } from "bun:test";
import {
  PAD_FT,
  fitCenterInsideLot,
  fitCenterOutsideLot,
  fitCenterToLot,
  layoutFor,
  pointInLot,
  polygonOutsideLot,
} from "./map-geometry";

/** A 10×10 box's corner offsets from its centre. */
const BOX = [
  { x: -5, y: -5 },
  { x: 5, y: -5 },
  { x: 5, y: 5 },
  { x: -5, y: 5 },
];

// Frontage 100, depth 100, rear 140 — a Man-facing lot that widens by 20ft a
// side over its depth, so each side edge leans out at ~11°.
const WEDGE = { frontageFt: 100, depthFt: 100, rear: 140 };
const RECT = { frontageFt: 100, depthFt: 100, rear: 100 };

const corners = (cx: number, cy: number) =>
  BOX.map((o) => ({ x: cx + o.x, y: cy + o.y }));

describe("pointInLot", () => {
  test("the taper is respected, not a bounding box", () => {
    // x = −15 at the rear is INSIDE a lot that has widened to 140ft (its left
    // edge is at −20 there), and outside the same lot at its frontage.
    expect(pointInLot(-15, 100, 100, 100, 140)).toBe(true);
    expect(pointInLot(-15, 0, 100, 100, 140)).toBe(false);
  });
});

describe("fitCenterOutsideLot", () => {
  test("pushes the whole footprint clear, by the smallest move", () => {
    // Centre just outside the frontage; the box still overlaps the lot.
    const c = fitCenterOutsideLot(50, -1, BOX, 100, 100, 140);
    expect(polygonOutsideLot(corners(c.x, c.y), 100, 100, 140)).toBe(true);
    // It went straight out the front — the nearest edge — and no further than
    // it had to: the box's bottom now rests on y = 0.
    expect(c.x).toBeCloseTo(50, 6);
    expect(c.y).toBeCloseTo(-5, 6);
  });

  test("clears a SLANTED side edge, which an axis-aligned push would not", () => {
    // Just left of the left edge at mid-depth (the edge is at x = −10 there).
    const c = fitCenterOutsideLot(-11, 50, BOX, 100, 100, 140);
    expect(polygonOutsideLot(corners(c.x, c.y), 100, 100, 140)).toBe(true);
    // The push follows the edge's own outward normal, so it moves in BOTH axes —
    // a pure −x nudge would leave the box's top-right corner inside.
    expect(c.x).toBeLessThan(-11);
    expect(c.y).toBeLessThan(50);
  });

  test("something already clear of the lot is left exactly where it is", () => {
    const c = fitCenterOutsideLot(50, -80, BOX, 100, 100, 140);
    expect(c.x).toBeCloseTo(50, 6);
    expect(c.y).toBeCloseTo(-80, 6);
  });

  test("a rotated footprint is cleared by its real extent", () => {
    // A 10×10 box turned 45° reaches 7.07ft from its centre, not 5.
    const diamond = [
      { x: 0, y: -7.0711 },
      { x: 7.0711, y: 0 },
      { x: 0, y: 7.0711 },
      { x: -7.0711, y: 0 },
    ];
    const c = fitCenterOutsideLot(50, -1, diamond, 100, 100, 140);
    expect(c.y).toBeCloseTo(-7.0711, 3);
  });
});

describe("fitCenterToLot — snap fully in or fully out", () => {
  test("centre inside ⇒ sited, and the footprint is pulled fully in", () => {
    const r = fitCenterToLot(
      2,
      2,
      BOX,
      RECT.frontageFt,
      RECT.depthFt,
      RECT.rear,
    );
    expect(r.staged).toBe(false);
    expect(r.x).toBeCloseTo(5, 6);
    expect(r.y).toBeCloseTo(5, 6);
  });

  test("centre outside ⇒ staged, and the footprint is pushed fully out", () => {
    const r = fitCenterToLot(
      -2,
      50,
      BOX,
      RECT.frontageFt,
      RECT.depthFt,
      RECT.rear,
    );
    expect(r.staged).toBe(true);
    expect(r.x).toBeCloseTo(-5, 6);
    expect(polygonOutsideLot(corners(r.x, r.y), 100, 100, 100)).toBe(true);
  });

  test("no input anywhere ever lands half in the lot", () => {
    // Sweep the border region of the wedge on a 2ft lattice. Every result must
    // be cleanly one or the other — this is the property the whole feature rests
    // on, so it's worth asserting exhaustively rather than at a few points.
    for (let cx = -30; cx <= 130; cx += 2) {
      for (let cy = -30; cy <= 130; cy += 2) {
        const r = fitCenterToLot(
          cx,
          cy,
          BOX,
          WEDGE.frontageFt,
          WEDGE.depthFt,
          WEDGE.rear,
        );
        const pts = corners(r.x, r.y);
        const allIn = pts.every((p) =>
          pointInLot(p.x, p.y, WEDGE.frontageFt, WEDGE.depthFt, WEDGE.rear),
        );
        const allOut = polygonOutsideLot(
          pts,
          WEDGE.frontageFt,
          WEDGE.depthFt,
          WEDGE.rear,
        );
        expect(allIn ? !r.staged : allOut && r.staged).toBe(true);
      }
    }
  });
});

describe("layoutFor padding", () => {
  const lot = {
    frontageFt: 100,
    depthFt: 100,
    innerRadiusFt: null,
    streetLetter: null,
    year: null,
    frontsToMan: true,
  };

  test("defaults to PAD_FT so read-only views are untouched", () => {
    expect(layoutFor(lot).padFt).toBe(PAD_FT);
    expect(layoutFor(lot)).toEqual(layoutFor(lot, PAD_FT));
  });

  test("a wider apron buys room by shrinking the scale, not the view", () => {
    const wide = layoutFor(lot, 150);
    expect(wide.padFt).toBe(150);
    expect(wide.ppf).toBeLessThan(layoutFor(lot).ppf);
    // Plot-local (0,0) still sits exactly one apron in from the margin, so an
    // object at the lot's front-left corner doesn't drift when the apron grows.
    expect(wide.originX - wide.padPx).toBeCloseTo(
      layoutFor(lot).originX - layoutFor(lot).padPx,
      6,
    );
  });

  test("never narrows below the default, whatever it's asked for", () => {
    expect(layoutFor(lot, 0).padFt).toBe(PAD_FT);
    expect(layoutFor(lot, -100).padFt).toBe(PAD_FT);
  });
});

describe("fitCenterInsideLot is unchanged by the move", () => {
  test("an oversized shape is centred rather than jammed to one edge", () => {
    const huge = [
      { x: -200, y: -200 },
      { x: 200, y: -200 },
      { x: 200, y: 200 },
      { x: -200, y: 200 },
    ];
    const c = fitCenterInsideLot(0, 0, huge, 100, 100, 100);
    expect(c.y).toBeCloseTo(50, 6);
  });
});
