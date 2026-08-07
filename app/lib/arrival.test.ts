import { describe, expect, test } from "bun:test";
import { arrivalDistribution, arrivalSortKey, dayChip } from "./arrival";

// 2026 gates open Sunday 2026-08-30 by the BRC approximation, so anything in
// August before that is setup week. Anchoring the fixtures to real dates keeps
// the setup/event boundary honest rather than assumed.
const YEAR = 2026;
const p = (
  arrivalDate: string | null,
  departureDate: string | null = null,
) => ({
  arrivalDate,
  departureDate,
});

describe("dayChip", () => {
  test("names the weekday and marks setup week", () => {
    const gates = dayChip("2026-08-30", YEAR);
    expect(gates?.short).toBe("Sun");
    expect(gates?.setup).toBe(false);
    const before = dayChip("2026-08-27", YEAR);
    expect(before?.short).toBe("Thu");
    expect(before?.setup).toBe(true);
  });

  test("returns nothing for an unset or malformed date", () => {
    expect(dayChip(null, YEAR)).toBeNull();
    expect(dayChip("", YEAR)).toBeNull();
    expect(dayChip("next tuesday", YEAR)).toBeNull();
  });
});

describe("arrivalSortKey", () => {
  test("sorts undated people last", () => {
    expect(arrivalSortKey("2026-08-30") < arrivalSortKey(null)).toBe(true);
    expect(arrivalSortKey("2026-08-30") < arrivalSortKey("garbage")).toBe(true);
  });
});

describe("arrivalDistribution", () => {
  test("counts arrivals on the day they happen", () => {
    const d = arrivalDistribution(
      [p("2026-08-28"), p("2026-08-28"), p("2026-08-30")],
      YEAR,
    );
    expect(d.days.map((x) => x.arriving)).toEqual([2, 0, 1]);
    expect(d.days[0]?.iso).toBe("2026-08-28");
    expect(d.dated).toBe(3);
  });

  test("onSite accumulates and respects departures", () => {
    // One person for the whole span, one who leaves early.
    const d = arrivalDistribution(
      [p("2026-08-28", "2026-08-31"), p("2026-08-29", "2026-08-29")],
      YEAR,
    );
    expect(d.days.map((x) => x.onSite)).toEqual([1, 2, 1, 1]);
  });

  test("someone with no departure is counted to the end of the span", () => {
    const d = arrivalDistribution([p("2026-08-28"), p("2026-08-31")], YEAR);
    expect(d.days.at(-1)?.onSite).toBe(2);
  });

  test("undated people are reported, never guessed at", () => {
    const d = arrivalDistribution([p("2026-08-28"), p(null), p("")], YEAR);
    expect(d.undated).toBe(2);
    expect(d.dated).toBe(1);
    expect(d.days.every((x) => x.onSite <= 1)).toBe(true);
  });

  test("nobody dated means no days at all", () => {
    const d = arrivalDistribution([p(null), p(null)], YEAR);
    expect(d.days).toEqual([]);
    expect(d.busiest).toBeNull();
    expect(d.fullest).toBeNull();
    expect(d.undated).toBe(2);
  });

  test("an empty roster is handled", () => {
    const d = arrivalDistribution([], YEAR);
    expect(d.days).toEqual([]);
    expect(d.undated).toBe(0);
  });

  test("busiest is the biggest arrival day, ties going earlier", () => {
    const d = arrivalDistribution(
      [p("2026-08-28"), p("2026-08-28"), p("2026-08-30"), p("2026-08-30")],
      YEAR,
    );
    expect(d.busiest?.iso).toBe("2026-08-28");
    expect(d.busiest?.arriving).toBe(2);
  });

  test("fullest is the peak on-site day — the one a potluck wants", () => {
    const d = arrivalDistribution(
      [
        p("2026-08-28", "2026-08-30"),
        p("2026-08-29", "2026-09-01"),
        p("2026-08-29", "2026-09-01"),
      ],
      YEAR,
    );
    // Everyone overlaps on the 29th and 30th; the tie keeps the earlier.
    expect(d.fullest?.iso).toBe("2026-08-29");
    expect(d.fullest?.onSite).toBe(3);
  });

  test("the span covers departures past the last arrival", () => {
    const d = arrivalDistribution([p("2026-08-30", "2026-09-02")], YEAR);
    expect(d.days.at(-1)?.iso).toBe("2026-09-02");
  });

  test("marks setup days inside the span", () => {
    const d = arrivalDistribution([p("2026-08-28"), p("2026-08-31")], YEAR);
    expect(d.days[0]?.setup).toBe(true);
    expect(d.days.at(-1)?.setup).toBe(false);
  });

  test("a departure before its own arrival doesn't extend or crash", () => {
    const d = arrivalDistribution([p("2026-08-30", "2026-08-28")], YEAR);
    expect(d.days).toHaveLength(1);
    expect(d.days[0]?.iso).toBe("2026-08-30");
    // The person is nowhere: their stay ended before it began. Reported as
    // dated, but never on site — better than silently inventing a stay.
    expect(d.days[0]?.onSite).toBe(0);
    expect(d.days[0]?.arriving).toBe(1);
  });

  test("a wild date can't spawn an unbounded number of days", () => {
    const d = arrivalDistribution([p("2026-08-30", "2099-01-01")], YEAR);
    expect(d.days.length).toBeLessThanOrEqual(90);
  });
});
