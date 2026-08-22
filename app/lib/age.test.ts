import { describe, expect, test } from "bun:test";
import {
  ageLabel,
  bandOf,
  isMinor,
  minorSummary,
  needsSetupPass,
  needsTicket,
} from "./age";

describe("bandOf", () => {
  test("NULL is an adult", () => {
    // Every row that existed before the column did is an adult, and nothing
    // backfilled a claim the camp never made.
    expect(bandOf(null)).toBe("adult");
    expect(bandOf(undefined)).toBe("adult");
    expect(bandOf("")).toBe("adult");
  });

  test("an unrecognised value is an adult, not a crash", () => {
    expect(bandOf("toddler")).toBe("adult");
  });
});

describe("what an age exempts you from", () => {
  test("under 13 needs neither a ticket nor a pass", () => {
    expect(needsTicket("under_13")).toBe(false);
    expect(needsSetupPass("under_13")).toBe(false);
  });

  test("under 18 needs both, like an adult", () => {
    // The only threshold with ticketing consequences is 13. Teens exist as a
    // band for supervision questions, not for this.
    expect(needsTicket("under_18")).toBe(true);
    expect(needsSetupPass("under_18")).toBe(true);
  });

  test("adults need both", () => {
    expect(needsTicket(null)).toBe(true);
    expect(needsSetupPass(null)).toBe(true);
  });

  test("minor is a different question from ticketing", () => {
    expect(isMinor("under_18")).toBe(true);
    expect(isMinor("under_13")).toBe(true);
    expect(isMinor(null)).toBe(false);
  });
});

describe("ageLabel", () => {
  test("adults are not badged — the common case stays quiet", () => {
    expect(ageLabel(null)).toBeNull();
    expect(ageLabel("adult")).toBeNull();
  });

  test("minors are", () => {
    expect(ageLabel("under_13")).toBe("under 13");
    expect(ageLabel("under_18")).toBe("under 18");
  });
});

describe("minorSummary", () => {
  test("summarises a family the way a roster should read it", () => {
    expect(
      minorSummary([{ ageBand: "under_13" }, { ageBand: "under_13" }]),
    ).toBe("+2 (under 13)");
  });

  test("keeps the bands apart", () => {
    expect(
      minorSummary([
        { ageBand: "under_13" },
        { ageBand: "under_18" },
        { ageBand: "under_18" },
      ]),
    ).toBe("+1 (under 13) +2 (under 18)");
  });

  test("adults contribute nothing to it", () => {
    expect(minorSummary([{ ageBand: null }, { ageBand: "adult" }])).toBeNull();
    expect(minorSummary([])).toBeNull();
  });
});
