import { describe, expect, it } from "bun:test";
import { currentEventYear, eventYearOptions } from "./brc";

// BRC 2026: gates open Sun Aug 30, exodus Labor Day Mon Sep 7.
describe("currentEventYear", () => {
  it("is this year before and during the event", () => {
    expect(currentEventYear(new Date(2026, 0, 1))).toBe(2026);
    expect(currentEventYear(new Date(2026, 7, 30))).toBe(2026);
    expect(currentEventYear(new Date(2026, 8, 7, 23, 59))).toBe(2026);
  });

  it("rolls to next year the day after exodus", () => {
    expect(currentEventYear(new Date(2026, 8, 8))).toBe(2027);
    expect(currentEventYear(new Date(2026, 10, 13))).toBe(2027);
    expect(currentEventYear(new Date(2026, 11, 31))).toBe(2027);
  });
});

describe("eventYearOptions", () => {
  it("offers the year after the current one down to 2023", () => {
    const opts = eventYearOptions(new Date(2026, 10, 13));
    expect(opts[0]).toBe("2028");
    expect(opts.at(-1)).toBe("2023");
  });
});
