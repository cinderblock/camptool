/**
 * Arrival / departure day presentation for the roster (client-safe, no server
 * imports).
 *
 * A raw `2026-08-27` doesn't answer the question people actually ask — "who's
 * here Thursday?" — so dates render as a **weekday chip**: the day name, a
 * per-weekday color so two people on the same day match at a glance, and a
 * border style that separates **setup** (before gates open, needs a Setup
 * Access Pass) from **during the event**. The weekday name is always spelled
 * out and the border is a second, non-color channel, so nothing here depends on
 * distinguishing hues.
 *
 * "Before gates open" uses the BRC-approximate `eventStartFor`, which the
 * onboarding wizard and the SAP flow already use for every event type (see
 * plans/arrival-sap-and-removal.md). When a real per-edition event calendar
 * exists, `eventStartIso` is the single place to repoint.
 */
import { eventStartIso } from "./brc";
import { isIsoDate } from "./schedule";

/** Indexed by `getUTCDay()`: 0 = Sunday. Colors walk the spectrum around the
 * week so adjacent days never collide, and all read as Mantine `light` badges
 * in both color schemes. */
const WEEKDAYS = [
  { short: "Sun", long: "Sunday", color: "red" },
  { short: "Mon", long: "Monday", color: "orange" },
  { short: "Tue", long: "Tuesday", color: "yellow" },
  { short: "Wed", long: "Wednesday", color: "green" },
  { short: "Thu", long: "Thursday", color: "teal" },
  { short: "Fri", long: "Friday", color: "blue" },
  { short: "Sat", long: "Saturday", color: "grape" },
] as const;

export type DayChip = {
  /** ISO `YYYY-MM-DD`, as stored. */
  iso: string;
  /** "Thu" — the chip label. */
  short: string;
  /** "Thursday" — for accessible names / non-chip contexts. */
  long: string;
  /** Mantine color key for the weekday. */
  color: string;
  /** Before gates open: setup week, needs a Setup Access Pass. */
  setup: boolean;
};

/** Weekday chip for a stored date, or null if unset/unparsable. `year` is the
 * edition's year, which fixes where the setup/event boundary falls. */
export function dayChip(
  iso: string | null | undefined,
  year: number,
): DayChip | null {
  if (!iso || !isIsoDate(iso)) return null;
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  // UTC-anchored so the weekday never shifts a day across timezones (same
  // reasoning as `dateLabel` in schedule.ts).
  const day = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  if (!day) return null;
  return {
    iso,
    short: day.short,
    long: day.long,
    color: day.color,
    // ISO dates compare correctly as plain strings.
    setup: iso < eventStartIso(year),
  };
}

/** Border for a day chip: dashed = setup, solid = during the event. Uniform
 * width so a column of chips stays the same size either way. */
export function dayChipBorder(setup: boolean): string {
  return `2px ${setup ? "dashed" : "solid"} currentColor`;
}

/** Sort key for a nullable arrival date: undated people sort last, since "we
 * don't know when they show up" is the least useful thing to lead a list with.
 * ISO dates sort correctly as plain strings, so the sentinel just has to be a
 * date that can't occur. */
export function arrivalSortKey(iso: string | null | undefined): string {
  return iso && isIsoDate(iso) ? iso : "9999-12-31";
}

export type ArrivalDay = DayChip & {
  /** People whose arrival date is this day. */
  arriving: number;
  /** People here on this day: arrived on or before it, not yet departed. */
  onSite: number;
  /**
   * ESTIMATED extra people on this day from those who haven't given dates —
   * never added into `onSite`, so a guess can never be mistaken for a count.
   * Render it as a visually distinct band on top. 0 when everyone has answered.
   */
  projected: number;
};

export type ArrivalDistribution = {
  days: ArrivalDay[];
  /** Nobody's told us when they're coming — the number that qualifies the rest. */
  undated: number;
  /** People with an arrival date, i.e. everyone counted in `days`. */
  dated: number;
  /** The day the most people show up. Ties go to the earlier day. */
  busiest: ArrivalDay | null;
  /** The day the most people are on site at once. Ties go to the earlier day. */
  fullest: ArrivalDay | null;
};

/**
 * Estimate how many of the undated would be on site each day, by assuming they
 * turn up in the same pattern as the people who DID answer.
 *
 * The alternative — assuming they're present the whole time — puts everyone who
 * hasn't planned on site from the first setup day, which is backwards: the
 * people who haven't answered are the least likely to be there early.
 *
 * Known bias, stated because the number is shown to humans: answered people
 * probably skew earlier than unanswered ones (anyone arriving before gates open
 * needs a Setup Access Pass, so early arrivals have a reason to have answered).
 * So this most likely OVERSTATES the setup days. It's reported separately from
 * `onSite` and drawn as a distinct band precisely so it can't be read as fact.
 */
function projectUndated(
  onSite: number,
  dated: number,
  undated: number,
): number {
  if (undated <= 0 || dated <= 0) return 0;
  return Math.round((onSite / dated) * undated);
}

/** A span longer than this is a typo, not a camping trip; bail rather than
 * building thousands of day rows for one bad date. */
const MAX_SPAN_DAYS = 90;

/**
 * When is everyone showing up? Asked for so camp leadership can pick a date for
 * an early-week potluck without reading down a roster and counting by hand.
 *
 * Two different numbers, because they answer two different questions.
 * `arriving` is "how busy is the gate that day" — who needs greeting, parking,
 * a hand with their tent. `onSite` is "how many people would come to a thing on
 * that evening", which is the one the potluck question is actually about, and
 * it needs departures to be honest: somebody who leaves Wednesday shouldn't be
 * counted at a Friday dinner.
 *
 * Anyone without an arrival date is reported separately rather than guessed at.
 */
export function arrivalDistribution(
  people: {
    arrivalDate?: string | null;
    departureDate?: string | null;
  }[],
  year: number,
): ArrivalDistribution {
  const dated = people
    .map((p) => ({
      arrival: p.arrivalDate && isIsoDate(p.arrivalDate) ? p.arrivalDate : null,
      departure:
        p.departureDate && isIsoDate(p.departureDate) ? p.departureDate : null,
    }))
    .filter((p): p is { arrival: string; departure: string | null } =>
      Boolean(p.arrival),
    );
  const undated = people.length - dated.length;
  if (dated.length === 0) {
    return { days: [], undated, dated: 0, busiest: null, fullest: null };
  }

  // The span runs from the first arrival to the last date mentioned by anyone.
  // A departure BEFORE its own arrival is ignored for the end bound (it's a
  // data-entry slip) but still shortens that person's own stay below.
  let first = dated[0]?.arrival ?? "";
  let last = first;
  for (const p of dated) {
    if (p.arrival < first) first = p.arrival;
    if (p.arrival > last) last = p.arrival;
    if (p.departure && p.departure > last) last = p.departure;
  }

  const days: ArrivalDay[] = [];
  for (const iso of daysBetween(first, last)) {
    const chip = dayChip(iso, year);
    if (!chip) continue;
    let arriving = 0;
    let onSite = 0;
    for (const p of dated) {
      if (p.arrival === iso) arriving++;
      // ISO dates compare correctly as plain strings. No departure = still here.
      if (p.arrival <= iso && (!p.departure || p.departure >= iso)) onSite++;
    }
    days.push({
      ...chip,
      arriving,
      onSite,
      projected: projectUndated(onSite, dated.length, undated),
    });
  }

  // `>` not `>=` so a tie keeps the earlier day — an earlier potluck gives
  // people more warning, and it reads better than silently picking the last.
  let busiest: ArrivalDay | null = null;
  let fullest: ArrivalDay | null = null;
  for (const d of days) {
    if (!busiest || d.arriving > busiest.arriving) busiest = d;
    if (!fullest || d.onSite > fullest.onSite) fullest = d;
  }
  return {
    days,
    undated,
    dated: dated.length,
    busiest: busiest && busiest.arriving > 0 ? busiest : null,
    fullest: fullest && fullest.onSite > 0 ? fullest : null,
  };
}

/** Every ISO date from `start` to `end` inclusive, capped. Pure UTC string
 * math, like `dailyDatesBetween` in schedule.ts — same reasoning, different
 * cap, and kept local so arrival presentation doesn't depend on the scheduler. */
function daysBetween(start: string, end: string): string[] {
  const toUtc = (iso: string) => {
    const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const startMs = toUtc(start);
  const endMs = toUtc(end);
  if (endMs < startMs) return [];
  const out: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  for (let ms = startMs; ms <= endMs && out.length < MAX_SPAN_DAYS; ms += DAY) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}
