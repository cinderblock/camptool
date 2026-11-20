import { describe, expect, test } from "bun:test";
import {
  type CustomKindData,
  compileCustomKind,
  customKindRegistry,
  outlineProblem,
  toCustomKindData,
  triangulate,
  type UnitPt,
} from "./custom-kinds";
import { builtinKinds } from "./structures";

const kind = (over: Partial<CustomKindData> = {}): CustomKindData => ({
  id: "k1",
  value: "x-k1",
  label: "Kitchen",
  groupName: "Camp",
  color: "#ff0000",
  shape: "rect",
  width: 20,
  height: 10,
  outline: null,
  tallFt: 9,
  canopyShade: false,
  tags: ["structure"],
  personal: false,
  rigid: false,
  fixedRotation: false,
  description: null,
  sort: 0,
  archived: false,
  ...over,
});

/** An L: the 0..1 box minus its top-right quarter. */
const L: UnitPt[] = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0 },
  { x: 0.5, y: 0.5 },
  { x: 1, y: 0.5 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const area = (pts: readonly UnitPt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as UnitPt;
    const q = pts[(i + 1) % pts.length] as UnitPt;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

describe("outlines", () => {
  test("triangulating an L keeps its area and is all triangles", () => {
    const tris = triangulate(L);
    expect(tris.length).toBe(4);
    expect(tris.every((t) => t.length === 3)).toBe(true);
    const total = tris.reduce((s, t) => s + area(t), 0);
    expect(total).toBeCloseTo(0.75, 6);
  });

  test("either winding triangulates the same", () => {
    const total = triangulate([...L].reverse()).reduce(
      (s, t) => s + area(t),
      0,
    );
    expect(total).toBeCloseTo(0.75, 6);
  });

  test("problems: too few points, no area, crossing edges", () => {
    expect(outlineProblem(L)).toBeNull();
    expect(outlineProblem(L.slice(0, 2))).toMatch(/3 points/);
    expect(
      outlineProblem([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toMatch(/no area/);
    // A bow tie.
    expect(
      outlineProblem([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    ).toMatch(/cross/);
  });
});

describe("compileCustomKind", () => {
  test("a rectangle draws through the core rect branch", () => {
    const k = compileCustomKind(kind());
    expect(k.shape).toBe("rect");
    expect(k.footprint).toBeUndefined();
    expect(k.tallFt).toBe(9);
  });

  test("an outline scales with the object and casts each piece", () => {
    const k = compileCustomKind(kind({ shape: "outline", outline: L }));
    expect(k.shape).toBe("custom");
    const fp = k.footprint?.(40, 20, {}) ?? [];
    expect(fp[0]).toEqual({ x: -20, y: -10 });
    expect(fp[4]).toEqual({ x: 20, y: 10 });
    const parts = k.shadowVolume?.(40, 20, {}) ?? [];
    expect(parts.length).toBe(4);
    // Solid: base and top of every triangle.
    expect(parts.every((p) => p.length === 6)).toBe(true);
  });

  test("a shade canopy casts only its top", () => {
    const k = compileCustomKind(kind({ shape: "hexagon", canopyShade: true }));
    const parts = k.shadowVolume?.(10, 10, {}) ?? [];
    expect(parts.every((p) => p.every((v) => v.z === 1))).toBe(true);
    expect(k.canopyShade).toBe(true);
  });

  test("a stored outline that doesn't parse falls back to its box", () => {
    const data = toCustomKindData({
      ...kind(),
      shape: "outline",
      outline: "not json",
      tags: '["domicile","bogus"]',
      archivedAt: null,
    });
    expect(data.shape).toBe("rect");
    expect(data.tags).toEqual(["domicile"]);
  });
});

describe("customKindRegistry", () => {
  test("a camp's kinds join the palette in their own legend group", () => {
    const reg = customKindRegistry([kind()]);
    expect(reg.isKind("x-k1")).toBe(true);
    expect(reg.def("x-k1").label).toBe("Kitchen");
    expect(reg.height("x-k1")).toBe(9);
    expect(reg.groups.find((g) => g.group === "Camp")?.kinds).toHaveLength(1);
    // Built-ins are all still there.
    expect(reg.isKind("tent")).toBe(true);
    expect(reg.palette.length).toBe(builtinKinds.palette.length + 1);
  });

  test("another camp's registry doesn't know the kind", () => {
    const other = customKindRegistry([]);
    expect(other.isKind("x-k1")).toBe(false);
    // Unknown kinds still draw, as the generic structure.
    expect(other.def("x-k1").value).toBe("structure");
  });

  test("archived kinds draw but can't be placed", () => {
    const reg = customKindRegistry([kind({ archived: true })]);
    expect(reg.isKind("x-k1")).toBe(false);
    expect(reg.def("x-k1").label).toBe("Kitchen");
    expect(reg.palette.some((k) => k.value === "x-k1")).toBe(false);
  });

  test("personal kinds reach the camper palette", () => {
    const reg = customKindRegistry([
      kind({ personal: true, tags: ["domicile"], groupName: "Domiciles" }),
    ]);
    const tents = reg.camperGroups.find((g) => g.group === "Tents & shelters");
    expect(tents?.kinds.some((k) => k.value === "x-k1")).toBe(true);
  });

  test("a camp kind can't shadow a built-in", () => {
    const reg = customKindRegistry([kind({ value: "tent", label: "Mine" })]);
    expect(reg.def("tent").label).toBe("Tent");
  });
});
