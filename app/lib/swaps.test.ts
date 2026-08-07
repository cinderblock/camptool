import { describe, expect, test } from "bun:test";
import {
  compareListings,
  isSwapDirection,
  isSwapKind,
  kindLabel,
  listingSummary,
  parsePrice,
  priceLabel,
} from "./swaps";

describe("kind and direction guards", () => {
  test("accept the real values", () => {
    expect(isSwapKind("ticket")).toBe(true);
    expect(isSwapKind("vehicle_pass")).toBe(true);
    expect(isSwapDirection("have")).toBe(true);
    expect(isSwapDirection("need")).toBe(true);
  });

  test("reject anything else, including a merged 'spare'", () => {
    expect(isSwapKind("spare")).toBe(false);
    expect(isSwapKind("")).toBe(false);
    expect(isSwapDirection("maybe")).toBe(false);
  });
});

describe("kindLabel", () => {
  test("pluralizes vehicle pass correctly", () => {
    expect(kindLabel("vehicle_pass", 1)).toBe("vehicle pass");
    expect(kindLabel("vehicle_pass", 2)).toBe("vehicle passes");
  });

  test("pluralizes tickets", () => {
    expect(kindLabel("ticket", 1)).toBe("ticket");
    expect(kindLabel("ticket", 3)).toBe("tickets");
  });

  test("falls back to the raw value for an unknown kind", () => {
    expect(kindLabel("wristband")).toBe("wristband");
  });
});

describe("priceLabel", () => {
  test("distinguishes unstated from free", () => {
    expect(priceLabel(null)).toBe("price not stated");
    expect(priceLabel(0)).toBe("free");
  });

  test("drops needless cents but keeps real ones", () => {
    expect(priceLabel(57500)).toBe("$575");
    expect(priceLabel(57550)).toBe("$575.50");
  });
});

describe("parsePrice", () => {
  test("accepts the ways people type money", () => {
    expect(parsePrice("575")).toBe(57500);
    expect(parsePrice("$575")).toBe(57500);
    expect(parsePrice("575.00")).toBe(57500);
    expect(parsePrice(" 1,200 ")).toBe(120000);
    expect(parsePrice("575.5")).toBe(57550);
  });

  test("blank means not stated, not zero", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("   ")).toBeNull();
  });

  test("zero is a real answer — free", () => {
    expect(parsePrice("0")).toBe(0);
  });

  test("garbage and negatives fall back to not stated", () => {
    expect(parsePrice("whatever")).toBeNull();
    expect(parsePrice("-20")).toBeNull();
  });

  test("rounds sub-cent input rather than storing a float", () => {
    expect(parsePrice("10.005")).toBe(1001);
  });
});

describe("listingSummary", () => {
  test("says 'each' only when it could be ambiguous", () => {
    expect(
      listingSummary({ kind: "ticket", quantity: 2, priceCents: 57500 }),
    ).toBe("2 tickets · $575 each");
    expect(
      listingSummary({ kind: "ticket", quantity: 1, priceCents: 57500 }),
    ).toBe("1 ticket · $575");
  });

  test("never says 'free each'", () => {
    expect(
      listingSummary({ kind: "vehicle_pass", quantity: 2, priceCents: 0 }),
    ).toBe("2 vehicle passes · free");
  });

  test("handles an unstated price on a multi-item listing", () => {
    expect(
      listingSummary({ kind: "ticket", quantity: 3, priceCents: null }),
    ).toBe("3 tickets · price not stated");
  });
});

describe("compareListings", () => {
  test("open first, then claimed, then withdrawn", () => {
    const rows = [
      { id: "w", status: "withdrawn", createdAt: 300 },
      { id: "c", status: "claimed", createdAt: 200 },
      { id: "o", status: "open", createdAt: 100 },
    ];
    expect([...rows].sort(compareListings).map((r) => r.id)).toEqual([
      "o",
      "c",
      "w",
    ]);
  });

  test("newest first within a status", () => {
    const rows = [
      { id: "old", status: "open", createdAt: 1 },
      { id: "new", status: "open", createdAt: 2 },
    ];
    expect([...rows].sort(compareListings).map((r) => r.id)).toEqual([
      "new",
      "old",
    ]);
  });
});
