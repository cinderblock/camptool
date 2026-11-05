import { describe, expect, test } from "bun:test";
import {
  type AerialTransform,
  cleanCrop,
  fitTwoPoints,
  imageToPlot,
  initialTransform,
  normDeg,
  plotToImage,
  seedRotation,
} from "./aerial";
import { bearingFromMan, mapUpBearingFor } from "./brc";

const close = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("image ↔ plot", () => {
  const t: AerialTransform = {
    pxWidth: 2000,
    pxHeight: 1150,
    cx: 50,
    cy: 100,
    ftPerPx: 0.1,
    rotation: 83,
  };

  test("centre pixel lands on the centre", () => {
    const p = imageToPlot(t, { x: 1000, y: 575 });
    close(p.x, 50);
    close(p.y, 100);
  });

  test("a clockwise quarter turn sends image-right to plot-down", () => {
    const q = imageToPlot({ ...t, rotation: 90 }, { x: 1010, y: 575 });
    close(q.x, 50);
    close(q.y, 101);
  });

  test("round trip", () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 1999, y: 3 },
      { x: 333, y: 1100 },
    ]) {
      const back = plotToImage(t, imageToPlot(t, p));
      close(back.x, p.x);
      close(back.y, p.y);
    }
  });
});

describe("fitTwoPoints", () => {
  test("recovers a known transform exactly", () => {
    const truth: AerialTransform = {
      pxWidth: 2000,
      pxHeight: 1150,
      cx: 41,
      cy: 97,
      ftPerPx: 0.104,
      rotation: 83,
    };
    const a = { x: 460, y: 540 };
    const b = { x: 1140, y: 655 };
    const fit = fitTwoPoints(
      truth,
      [a, b],
      [imageToPlot(truth, a), imageToPlot(truth, b)],
    );
    expect(fit).not.toBeNull();
    if (!fit) return;
    close(fit.cx, truth.cx);
    close(fit.cy, truth.cy);
    close(fit.ftPerPx, truth.ftPerPx);
    close(fit.rotation, truth.rotation);
  });

  test("both photo points land on their map points", () => {
    const size = { pxWidth: 800, pxHeight: 600 };
    const fit = fitTwoPoints(
      size,
      [
        { x: 10, y: 20 },
        { x: 700, y: 500 },
      ],
      [
        { x: -3, y: 180 },
        { x: 90, y: 12 },
      ],
    );
    if (!fit) throw new Error("no fit");
    const p = imageToPlot(fit, { x: 10, y: 20 });
    const q = imageToPlot(fit, { x: 700, y: 500 });
    close(p.x, -3);
    close(p.y, 180);
    close(q.x, 90);
    close(q.y, 12);
  });

  test("degenerate input → null", () => {
    const size = { pxWidth: 10, pxHeight: 10 };
    const p = { x: 1, y: 1 };
    expect(
      fitTwoPoints(
        size,
        [p, p],
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
      ),
    ).toBeNull();
    expect(
      fitTwoPoints(
        size,
        [p, { x: 4, y: 4 }],
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      ),
    ).toBeNull();
  });
});

describe("seedRotation", () => {
  test("a 12:00-up photo of a Man-facing camp at 3:14 turns 83° clockwise", () => {
    const mapUp = mapUpBearingFor("3:14", true);
    if (mapUp == null) throw new Error("no bearing");
    close(seedRotation(bearingFromMan(12), mapUp), 83, 1e-9);
  });

  test("a 12:00-up photo of a camp at 6:00 facing the Man needs no turn", () => {
    // 6:00 camp facing the Man: map-up points at the Man, i.e. toward 12:00.
    const mapUp = mapUpBearingFor("6:00", true);
    if (mapUp == null) throw new Error("no bearing");
    close(seedRotation(bearingFromMan(12), mapUp), 0, 1e-9);
  });

  test("normDeg", () => {
    expect(normDeg(270)).toBe(-90);
    expect(normDeg(-277)).toBe(83);
    expect(normDeg(180)).toBe(180);
  });
});

test("initialTransform centres on the lot and overshoots it a little", () => {
  const t = initialTransform({
    pxWidth: 2000,
    pxHeight: 1150,
    frontageFt: 100,
    depthFt: 200,
    rotation: 83,
  });
  expect(t.cx).toBe(50);
  expect(t.cy).toBe(100);
  close(t.ftPerPx * 2000, 230);
});

test("cleanCrop orders, clamps and refuses a sliver", () => {
  expect(cleanCrop(0.8, -1, 0.2, 2)).toEqual({
    cropX0: 0.2,
    cropY0: 0,
    cropX1: 0.8,
    cropY1: 1,
  });
  expect(cleanCrop(0.5, 0.1, 0.505, 0.9).cropX1).toBe(1);
});
