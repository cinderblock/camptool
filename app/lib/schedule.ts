/**
 * Schedule — pure catalogs + helpers (client-safe, no server imports). Pairs
 * with db/schema/schedule.ts and schedule.server.ts. Design:
 * plans/events-scheduling.md.
 *
 * All dates are ISO `YYYY-MM-DD` strings and times wall-clock `HH:MM` (24h) —
 * no Date-object timezone handling anywhere (see the schema header for why).
 */

export type GatheringKind =
  | "work_party"
  | "meeting"
  | "prep"
  | "shift"
  | "social"
  | "other";

export const GATHERING_KINDS: {
  value: GatheringKind;
  label: string;
  color: string;
}[] = [
  { value: "work_party", label: "Work party", color: "orange" },
  { value: "meeting", label: "Meeting", color: "blue" },
  { value: "prep", label: "Prep session", color: "teal" },
  { value: "shift", label: "Shift", color: "grape" },
  { value: "social", label: "Social", color: "pink" },
  { value: "other", label: "Other", color: "gray" },
];

export function kindLabel(kind: string): string {
  return GATHERING_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export function kindColor(kind: string): string {
  return GATHERING_KINDS.find((k) => k.value === kind)?.color ?? "gray";
}

export type Staffing = "all_hands" | "open" | "needed";

export const STAFFING_OPTIONS: {
  value: Staffing;
  label: string;
  hint: string;
}[] = [
  {
    value: "all_hands",
    label: "All hands",
    hint: "Everyone is expected — RSVP so we know who's coming.",
  },
  {
    value: "open",
    label: "All available",
    hint: "Come if you can — the more the better.",
  },
  {
    value: "needed",
    label: "Needs people",
    hint: "A set number of people are needed; sign-ups above the cap waitlist.",
  },
];

export function staffingLabel(staffing: string): string {
  return STAFFING_OPTIONS.find((s) => s.value === staffing)?.label ?? staffing;
}

/** Max roles in one shift template — a guard against a runaway form, not a real
 * limit; no camp runs more than a handful of roles on one gathering. Lives here
 * (not in schedule.server.ts) because the role builder renders it. */
export const MAX_TEMPLATE_ROLES = 12;

export type SignupStatus = "signed_up" | "maybe" | "waitlisted" | "cancelled";
export type Attendance = "unknown" | "attended" | "no_show";
export type SignupOrigin = "self" | "assigned" | "walk_in";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value);
}

export function isHhMm(value: string): boolean {
  return HHMM.test(value);
}

/**
 * Every `stepDays`-th date from `start` to `end` inclusive (ISO strings in, ISO
 * strings out) — the recurrence materializer behind "repeat daily" and the
 * meetings feature's weekly/fortnightly cadences. Pure string/UTC math, no
 * local-tz Date pitfalls. Caps at 100 dates so a typo can't spawn thousands of
 * rows.
 */
export function datesEvery(
  start: string,
  end: string,
  stepDays: number,
): string[] {
  if (!isIsoDate(start) || !isIsoDate(end)) return [];
  if (!Number.isInteger(stepDays) || stepDays < 1) return [];
  const toUtc = (iso: string) => {
    const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const startMs = toUtc(start);
  const endMs = toUtc(end);
  if (endMs < startMs) return [];
  const out: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  for (
    let ms = startMs;
    ms <= endMs && out.length < 100;
    ms += stepDays * DAY
  ) {
    out.push(fromUtc(ms));
  }
  return out;
}

/** Every date from `start` to `end` inclusive — `datesEvery(…, 1)`. */
export function dailyDatesBetween(start: string, end: string): string[] {
  return datesEvery(start, end, 1);
}

/** "2026-08-25" → "Tue, Aug 25". UTC-anchored so the label never shifts a day
 * across timezones. Falls back to the raw string for anything unparsable. */
export function dateLabel(iso: string): string {
  if (!isIsoDate(iso)) return iso;
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "14:30" → "2:30 pm"; "09:00" → "9 am". */
export function timeLabel(hhmm: string): string {
  if (!isHhMm(hhmm)) return hhmm;
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "am" : "pm";
  return m === 0
    ? `${h12} ${suffix}`
    : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "10:00"–"14:00" → "10 am – 2 pm"; open-ended and all-day handled. */
export function timeRangeLabel(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "All day";
  return end ? `${timeLabel(start)} – ${timeLabel(end)}` : timeLabel(start);
}

/** Local today as ISO YYYY-MM-DD (the one place local time enters: "what day
 * is it for the person looking at the calendar"). */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
