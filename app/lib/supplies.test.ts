import { describe, expect, test } from "bun:test";
import {
  duplicateGroups,
  findSimilarSupplies,
  normalizeSupplyName,
  resolveSupplyClaim,
  sameSupply,
} from "./supplies";

type Row = { id: string; name: string };
const rows = (...names: string[]): Row[] =>
  names.map((name, i) => ({ id: String(i), name }));
const nameOf = (r: Row) => r.name;

describe("normalizeSupplyName", () => {
  test("folds case, padding and repeated spaces", () => {
    expect(normalizeSupplyName("  Whiskey ")).toBe("whiskey");
    expect(normalizeSupplyName("Camp   Stove")).toBe("camp stove");
  });

  test("treats punctuation as a word break", () => {
    expect(normalizeSupplyName("soda (diet)")).toBe("soda diet");
    expect(normalizeSupplyName("rye/bourbon")).toBe("rye bourbon");
  });

  test("the plural rule applies per word, including split fragments", () => {
    // Documented, accepted imprecision: "whis-key" splits to "whis" + "key" and
    // the 4-letter "whis" loses its s. This only ever costs a near-miss in a
    // suggestion list; nothing merges on a fuzzy match.
    expect(normalizeSupplyName("whis-key")).toBe("whi key");
  });

  test("drops a plural s on words long enough to survive it", () => {
    expect(normalizeSupplyName("coolers")).toBe(normalizeSupplyName("cooler"));
    expect(normalizeSupplyName("Beverage Dispensers")).toBe(
      "beverage dispenser",
    );
  });

  test("leaves short words and double-s endings alone", () => {
    // "gas" must not become "ga", "glass" must not become "glas".
    expect(normalizeSupplyName("gas")).toBe("gas");
    expect(normalizeSupplyName("ice")).toBe("ice");
    expect(normalizeSupplyName("glass")).toBe("glass");
  });

  test("an empty or punctuation-only name normalizes to nothing", () => {
    expect(normalizeSupplyName("  ")).toBe("");
    expect(normalizeSupplyName("---")).toBe("");
  });
});

describe("sameSupply", () => {
  test("matches across the ways people actually type a thing", () => {
    expect(sameSupply("Whiskey", "whiskey ")).toBe(true);
    expect(sameSupply("Coolers", "cooler")).toBe(true);
  });

  test("does not match different things", () => {
    expect(sameSupply("whiskey", "whisky sour mix")).toBe(false);
    expect(sameSupply("mixers", "soda")).toBe(false);
  });

  test("an empty name matches nothing, including another empty one", () => {
    expect(sameSupply("", "")).toBe(false);
    expect(sameSupply("  ", "whiskey")).toBe(false);
  });
});

describe("findSimilarSupplies", () => {
  const list = rows(
    "Whiskey",
    "Cheap whiskey",
    "Bourbon",
    "Mixers",
    "Camp stove",
  );

  test("puts an exact normalized match first", () => {
    const found = findSimilarSupplies("whiskey", list, nameOf);
    expect(found[0]?.item.name).toBe("Whiskey");
    expect(found[0]?.kind).toBe("exact");
  });

  test("surfaces entries sharing a whole word", () => {
    const names = findSimilarSupplies("whiskey", list, nameOf).map(
      (m) => m.item.name,
    );
    expect(names).toContain("Cheap whiskey");
    expect(names).not.toContain("Bourbon");
  });

  test("ignores a query too short to be a signal", () => {
    expect(findSimilarSupplies("wh", list, nameOf)).toEqual([]);
    expect(findSimilarSupplies("", list, nameOf)).toEqual([]);
  });

  test("respects the result limit", () => {
    const many = rows(...Array.from({ length: 20 }, () => "whiskey"));
    expect(findSimilarSupplies("whiskey", many, nameOf, 3)).toHaveLength(3);
  });
});

describe("resolveSupplyClaim", () => {
  const line = (name: string, owner: string | null) => ({ name, owner });

  test("claims an unclaimed line that means the same thing", () => {
    const free = line("Whiskey", null);
    const got = resolveSupplyClaim("whiskey", [line("Bourbon", "a"), free]);
    expect(got.action).toBe("claim");
    expect(got.action === "claim" && got.target).toBe(free);
  });

  test("matches through case and plurals, like the rest of the module", () => {
    const free = line("Coolers", null);
    expect(resolveSupplyClaim("cooler", [free]).action).toBe("claim");
  });

  test("adds a row when someone else already claimed the same thing", () => {
    // Two people each bringing whiskey is two facts, not a collision.
    expect(resolveSupplyClaim("whiskey", [line("Whiskey", "someone")])).toEqual(
      {
        action: "add",
      },
    );
  });

  test("adds a row when nothing matches", () => {
    expect(resolveSupplyClaim("rye", [line("Whiskey", null)])).toEqual({
      action: "add",
    });
  });

  test("prefers the unclaimed line when both exist", () => {
    const free = line("Whiskey", null);
    const got = resolveSupplyClaim("Whiskey", [line("whiskey", "a"), free]);
    expect(got.action === "claim" && got.target).toBe(free);
  });

  test("an empty group always adds", () => {
    expect(resolveSupplyClaim("whiskey", [])).toEqual({ action: "add" });
  });
});

describe("duplicateGroups", () => {
  test("groups entries that normalize together", () => {
    const groups = duplicateGroups(
      rows("Whiskey", "whiskey", "Coolers", "cooler", "Bourbon"),
      nameOf,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((r) => r.name)).toEqual(["Whiskey", "whiskey"]);
    expect(groups[1]?.map((r) => r.name)).toEqual(["Coolers", "cooler"]);
  });

  test("a list with no collisions yields nothing", () => {
    expect(duplicateGroups(rows("Whiskey", "Bourbon"), nameOf)).toEqual([]);
  });

  test("blank names never form a group", () => {
    expect(duplicateGroups(rows("", "  ", "---"), nameOf)).toEqual([]);
  });
});
