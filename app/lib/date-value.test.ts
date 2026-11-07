import { describe, expect, test } from "bun:test";
import { pickerValueToDate, pickerValueToIso } from "./date-value";

describe("picker values are local wall-clock time", () => {
  test("a date is local midnight, not UTC midnight", () => {
    expect(pickerValueToDate("2026-11-07")).toEqual(new Date(2026, 10, 7));
  });

  test("a date-time is read in the local zone", () => {
    expect(pickerValueToDate("2026-11-07 13:05:00")).toEqual(
      new Date(2026, 10, 7, 13, 5),
    );
    expect(pickerValueToIso("2026-11-07 13:05:00")).toBe(
      new Date(2026, 10, 7, 13, 5).toISOString(),
    );
  });

  test("empty stays empty", () => {
    expect(pickerValueToDate(null)).toBeNull();
    expect(pickerValueToIso(null)).toBe("");
    expect(pickerValueToIso("")).toBe("");
  });
});
