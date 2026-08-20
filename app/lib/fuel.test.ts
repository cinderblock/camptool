import { describe, expect, test } from "bun:test";
import {
  type FuelRow,
  NO_FUEL,
  amountLabel,
  defaultUnitFor,
  fuelLabel,
  fuelPhase,
  fuelTotals,
  isFuelType,
  isFuelUnit,
  isNoFuel,
  needsPhaseSeparation,
  noFuelCount,
  totalLabel,
} from "./fuel";

const row = (over: Partial<FuelRow> = {}): FuelRow => ({
  fuelType: "gasoline",
  amount: 5,
  unit: "gal",
  containerCount: 1,
  ...over,
});

describe("catalog guards and lookups", () => {
  test("accept the real fuel types and units", () => {
    expect(isFuelType("gasoline")).toBe(true);
    expect(isFuelType("propane")).toBe(true);
    expect(isFuelType("diesel")).toBe(true);
    expect(isFuelUnit("gal")).toBe(true);
    expect(isFuelUnit("lb")).toBe(true);
  });

  test("reject anything else", () => {
    expect(isFuelType("kerosene")).toBe(false);
    expect(isFuelUnit("liters")).toBe(false);
  });

  test("propane is a gas, liquids are liquids", () => {
    expect(fuelPhase("propane")).toBe("gas");
    expect(fuelPhase("gasoline")).toBe("liquid");
    expect(fuelPhase("diesel")).toBe("liquid");
  });

  test("defaults to the unit each fuel is actually bought in", () => {
    expect(defaultUnitFor("propane")).toBe("lb");
    expect(defaultUnitFor("gasoline")).toBe("gal");
    expect(defaultUnitFor("nonsense")).toBe("gal");
  });
});

describe("declaring none", () => {
  test("'none' is not a fuel type, so it can't be picked or edited into", () => {
    expect(isFuelType(NO_FUEL)).toBe(false);
    expect(isNoFuel(NO_FUEL)).toBe(true);
    expect(isNoFuel("gasoline")).toBe(false);
  });

  test("reads as 'No fuel' rather than as the raw value", () => {
    expect(fuelLabel(NO_FUEL)).toBe("No fuel");
  });

  test("counts the people who answered 'none'", () => {
    expect(
      noFuelCount([
        row({ fuelType: NO_FUEL, amount: 0, containerCount: 0 }),
        row({ fuelType: NO_FUEL, amount: 0, containerCount: 0 }),
        row({ fuelType: "propane", unit: "lb" }),
      ]),
    ).toBe(2);
  });

  test("contributes nothing to the totals — not a type, not a container", () => {
    const totals = fuelTotals([
      row({ fuelType: NO_FUEL, amount: 0, containerCount: 0 }),
      row({ fuelType: "gasoline", amount: 5, containerCount: 1 }),
    ]);
    expect(totals.map((t) => t.fuelType)).toEqual(["gasoline"]);
    expect(totals[0]?.containers).toBe(1);
    expect(totals[0]?.lines).toBe(1);
    // And it must not land in the containment worry list either.
    expect(totals[0]?.containmentUnknown).toBe(1);
  });

  test("a camp where everyone declared none has no totals at all", () => {
    expect(
      fuelTotals([row({ fuelType: NO_FUEL, amount: 0, containerCount: 0 })]),
    ).toEqual([]);
  });

  test("never triggers a phase-separation warning", () => {
    expect(
      needsPhaseSeparation([
        row({ fuelType: "gasoline", amount: 5 }),
        row({ fuelType: NO_FUEL, amount: 0, containerCount: 0 }),
      ]),
    ).toBe(false);
  });
});

describe("amountLabel", () => {
  test("drops a pointless decimal but keeps a real one", () => {
    expect(amountLabel(12, "gal")).toBe("12 gal");
    expect(amountLabel(12.5, "gal")).toBe("12.5 gal");
  });
});

describe("fuelTotals", () => {
  test("sums amounts and containers per type", () => {
    const totals = fuelTotals([
      row({ amount: 5, containerCount: 1 }),
      row({ amount: 7.5, containerCount: 3 }),
    ]);
    expect(totals).toHaveLength(1);
    expect(totals[0]?.byUnit).toEqual([{ unit: "gal", amount: 12.5 }]);
    expect(totals[0]?.containers).toBe(4);
    expect(totals[0]?.lines).toBe(2);
  });

  test("keeps gallons and pounds apart rather than adding them", () => {
    const totals = fuelTotals([
      row({ fuelType: "propane", amount: 20, unit: "lb" }),
      row({ fuelType: "propane", amount: 2, unit: "gal" }),
    ]);
    expect(totals[0]?.byUnit).toEqual([
      { unit: "lb", amount: 20 },
      { unit: "gal", amount: 2 },
    ]);
    const first = totals[0];
    expect(first && totalLabel(first)).toBe("20 lb + 2 gal");
  });

  test("reports totals in catalog order, omitting empty types", () => {
    const totals = fuelTotals([
      row({ fuelType: "propane", unit: "lb" }),
      row({ fuelType: "gasoline" }),
    ]);
    // Catalog order is gasoline, diesel, propane, other — and diesel is absent.
    expect(totals.map((t) => t.fuelType)).toEqual(["gasoline", "propane"]);
  });

  test("separates 'not answered' containment from 'answered no'", () => {
    const totals = fuelTotals([
      row({ secondaryContainment: true }),
      row({ secondaryContainment: false }),
      row({ secondaryContainment: null }),
      row({}),
    ]);
    expect(totals[0]?.containmentMissing).toBe(1);
    expect(totals[0]?.containmentUnknown).toBe(2);
  });

  test("no declarations means no rows at all", () => {
    expect(fuelTotals([])).toEqual([]);
  });
});

describe("needsPhaseSeparation", () => {
  test("true when both liquid fuel and compressed gas are present", () => {
    expect(
      needsPhaseSeparation([
        row({ fuelType: "gasoline" }),
        row({ fuelType: "propane", unit: "lb" }),
      ]),
    ).toBe(true);
  });

  test("false when everything is one phase", () => {
    expect(
      needsPhaseSeparation([
        row({ fuelType: "gasoline" }),
        row({ fuelType: "diesel" }),
      ]),
    ).toBe(false);
  });

  test("a zero-amount line doesn't trigger a separation requirement", () => {
    expect(
      needsPhaseSeparation([
        row({ fuelType: "gasoline", amount: 5 }),
        row({ fuelType: "propane", amount: 0, unit: "lb" }),
      ]),
    ).toBe(false);
  });
});
