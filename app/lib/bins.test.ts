import { describe, expect, test } from "bun:test";
import { type BinSummary, binHref, binTitle, searchBins } from "./bins";

const bin = (over: Partial<BinSummary> & { id: number }): BinSummary => ({
  name: null,
  status: "active",
  locationName: null,
  externalLabel: null,
  labelIds: [],
  ...over,
});

const STOCK: BinSummary[] = [
  bin({ id: 12, name: "Gaff tape and zip ties", locationName: "Storage unit" }),
  bin({ id: 34, name: "Kitchen — pots", locationName: "Garage" }),
  bin({
    id: 56,
    name: "Shade hardware",
    externalLabel: "SH-2",
    labelIds: ["build"],
  }),
  bin({ id: 78, locationName: "Garage" }),
];

describe("searchBins", () => {
  test("an empty query matches nothing, rather than everything", () => {
    // The panel shows results only once someone types; returning the whole
    // warehouse for "" would dump every box on the page.
    expect(searchBins(STOCK, "")).toEqual([]);
    expect(searchBins(STOCK, "   ")).toEqual([]);
  });

  test("finds a box by name, case-insensitively", () => {
    expect(searchBins(STOCK, "GAFF").map((b) => b.id)).toEqual([12]);
  });

  test("every word must match — not any", () => {
    // "kitchen tape" is a nonsense query; matching either word would wrongly
    // return both boxes and bury the real answer.
    expect(searchBins(STOCK, "kitchen tape")).toEqual([]);
    expect(searchBins(STOCK, "gaff ties").map((b) => b.id)).toEqual([12]);
  });

  test("matches on location, external label and labels too", () => {
    expect(searchBins(STOCK, "garage").map((b) => b.id)).toEqual([34, 78]);
    expect(searchBins(STOCK, "sh-2").map((b) => b.id)).toEqual([56]);
    expect(searchBins(STOCK, "build").map((b) => b.id)).toEqual([56]);
  });

  test("a box with no name is still findable by where it is", () => {
    expect(searchBins(STOCK, "garage").map((b) => b.id)).toContain(78);
  });
});

describe("binTitle", () => {
  test("falls back to the box number when unnamed", () => {
    expect(binTitle(bin({ id: 78 }))).toBe("Bin 78");
    expect(binTitle(bin({ id: 78, name: "  " }))).toBe("Bin 78");
    expect(binTitle(bin({ id: 12, name: "Gaff tape" }))).toBe("Gaff tape");
  });
});

describe("binHref", () => {
  test("builds a bin URL without doubling the slash", () => {
    expect(binHref("https://i.example.com", 12)).toBe(
      "https://i.example.com/12",
    );
    expect(binHref("https://i.example.com/", 12)).toBe(
      "https://i.example.com/12",
    );
  });
});
