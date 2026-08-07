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
