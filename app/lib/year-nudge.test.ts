import { describe, expect, it } from "bun:test";
import { yearNudge } from "./year-nudge";

// BRC 2026 exodus is Mon Sep 7, so 2026-11-21 is already in the 2027 season.
const NOV_2026 = new Date(2026, 10, 21);
const JUL_2026 = new Date(2026, 6, 1);

const ed = (id: string, year: number, event = "burning-man") => ({
  id,
  year,
  event,
});

describe("yearNudge", () => {
  it("asks a camp with no years for its first, as Burning Man", () => {
    expect(yearNudge([], NOV_2026)).toEqual({
      kind: "first",
      year: 2027,
      event: "burning-man",
    });
  });

  it("offers the new year once the newest one's event is over", () => {
    expect(yearNudge([ed("a", 2026)], NOV_2026)).toEqual({
      kind: "next",
      year: 2027,
      event: "burning-man",
      from: { id: "a", year: 2026 },
    });
  });

  it("says nothing while the newest year is still the current one", () => {
    expect(yearNudge([ed("a", 2026)], JUL_2026)).toBeNull();
    expect(yearNudge([ed("a", 2026), ed("b", 2027)], NOV_2026)).toBeNull();
  });

  it("copies from the newest year whatever the order, keeping its event", () => {
    const nudge = yearNudge(
      [ed("old", 2024), ed("new", 2026, "unscruz"), ed("mid", 2025)],
      NOV_2026,
    );
    expect(nudge).toEqual({
      kind: "next",
      year: 2027,
      event: "unscruz",
      from: { id: "new", year: 2026 },
    });
  });

  it("offers the current year, not the one after a skipped gap", () => {
    expect(yearNudge([ed("a", 2023)], NOV_2026)?.year).toBe(2027);
  });
});
