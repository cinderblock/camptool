import { describe, expect, test } from "bun:test";
import { BURNING_MAN, featureName, isBurningMan } from "./events";

describe("featureName", () => {
  test("Burning Man names its own things", () => {
    // "Passes" and "Tickets" are vague; at BM they mean two precise things and
    // campers say the precise words to each other.
    expect(featureName("passes", BURNING_MAN, "Passes")).toBe(
      "Setup Access Passes",
    );
    expect(featureName("tickets", BURNING_MAN, "Tickets")).toBe("DGS Tickets");
  });

  test("another event gets the generic name, not BM's", () => {
    // The whole reason this lives in the event layer: a camp that isn't at
    // Burning Man must never be shown "DGS".
    expect(featureName("passes", "unscruz", "Passes")).toBe("Passes");
    expect(featureName("tickets", "other", "Tickets")).toBe("Tickets");
  });

  test("no event yet falls back", () => {
    expect(featureName("passes", null, "Passes")).toBe("Passes");
    expect(featureName("passes", undefined, "Passes")).toBe("Passes");
  });

  test("a feature the event has no word for keeps the generic one", () => {
    expect(featureName("roster", BURNING_MAN, "Who's coming")).toBe(
      "Who's coming",
    );
  });
});

describe("isBurningMan", () => {
  test("only the real key", () => {
    expect(isBurningMan(BURNING_MAN)).toBe(true);
    expect(isBurningMan("unscruz")).toBe(false);
    expect(isBurningMan(null)).toBe(false);
  });
});
