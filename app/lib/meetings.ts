/**
 * Camp meetings — pure catalogs + helpers (client-safe, no server imports).
 * Pairs with db/schema/meeting.ts and meetings.server.ts. Design:
 * plans/camp-meetings.md.
 *
 * A meeting is a `gathering` with `kind = "meeting"`, so dates/times follow the
 * schedule rules: ISO `YYYY-MM-DD` and wall-clock `HH:MM`, no timezone maths.
 */
import { datesEvery, isIsoDate } from "./schedule";

export const MEETING_KIND = "meeting";

/**
 * Which meeting system a room link belongs to, derived from its hostname.
 *
 * Deliberately derived rather than stored (see the schema header): the camp
 * pastes ONE link and the app works out what to call the button, so "whatever
 * meeting system is configured" needs no configuration beyond the link. A host
 * we don't recognize still gets a working button labelled generically — that
 * is the fallback, not a failure.
 */
export type MeetingProvider = {
  key: string;
  label: string;
  /** How to describe the destination: "voice channel", "room", "call". */
  place: string;
};

const GENERIC: MeetingProvider = {
  key: "link",
  label: "Meeting link",
  place: "room",
};

const PROVIDERS: {
  key: string;
  label: string;
  place: string;
  hosts: string[];
}[] = [
  {
    key: "discord",
    label: "Discord",
    place: "voice channel",
    hosts: [
      "discord.com",
      "discordapp.com",
      "ptb.discord.com",
      "canary.discord.com",
    ],
  },
  { key: "zoom", label: "Zoom", place: "meeting", hosts: ["zoom.us"] },
  {
    key: "meet",
    label: "Google Meet",
    place: "call",
    hosts: ["meet.google.com"],
  },
  {
    key: "teams",
    label: "Microsoft Teams",
    place: "meeting",
    hosts: ["teams.microsoft.com", "teams.live.com"],
  },
  { key: "jitsi", label: "Jitsi", place: "room", hosts: ["meet.jit.si"] },
  {
    key: "whereby",
    label: "Whereby",
    place: "room",
    hosts: ["whereby.com"],
  },
  { key: "signal", label: "Signal", place: "call", hosts: ["signal.group"] },
];

/** Match `host` or any subdomain of it, so `us02web.zoom.us` counts as Zoom. */
function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

export function meetingProvider(
  url: string | null | undefined,
): MeetingProvider {
  if (!url) return GENERIC;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return GENERIC;
  }
  for (const p of PROVIDERS) {
    if (p.hosts.some((h) => hostMatches(hostname, h))) {
      return { key: p.key, label: p.label, place: p.place };
    }
  }
  return GENERIC;
}

/**
 * Accept what a person actually pastes. Adds a missing scheme, rejects anything
 * that isn't http(s) — a `javascript:` or `data:` "room link" would otherwise
 * become a button every member is invited to click.
 */
export function normalizeRoomUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/** "Join the Discord voice channel" — the button's own words. */
export function joinLabel(url: string | null, label: string | null): string {
  if (label?.trim()) return `Join ${label.trim()}`;
  const p = meetingProvider(url);
  return p.key === "link"
    ? "Join the meeting"
    : `Join the ${p.label} ${p.place}`;
}

/**
 * How often a meeting repeats. Camp meetings run on a cadence in the run-up
 * (weekly, fortnightly) and then daily during the event — the schedule feature
 * only ever knew "once" and "daily".
 */
export type MeetingCadence = "once" | "weekly" | "fortnightly" | "daily";

export const MEETING_CADENCES: {
  value: MeetingCadence;
  label: string;
  stepDays: number;
}[] = [
  { value: "once", label: "Just once", stepDays: 0 },
  { value: "weekly", label: "Every week", stepDays: 7 },
  { value: "fortnightly", label: "Every 2 weeks", stepDays: 14 },
  { value: "daily", label: "Every day", stepDays: 1 },
];

export function isMeetingCadence(v: string): v is MeetingCadence {
  return MEETING_CADENCES.some((c) => c.value === v);
}

export function cadenceStep(cadence: string): number {
  return MEETING_CADENCES.find((c) => c.value === cadence)?.stepDays ?? 0;
}

/**
 * The dates a cadence produces. "once" ignores the end date entirely, so a
 * stale end date left in the form can't silently spawn a series.
 */
export function meetingDates(
  cadence: string,
  start: string,
  end: string,
): string[] {
  if (!isIsoDate(start)) return [];
  const step = cadenceStep(cadence);
  if (step === 0) return [start];
  if (!isIsoDate(end)) return [];
  return datesEvery(start, end, step);
}

/** The regeneration hint stored on `gathering.recurrence_rule`. */
export function cadenceRule(
  cadence: string,
  start: string,
  end: string,
): string | null {
  return cadenceStep(cadence) === 0 ? null : `${cadence}:${start}..${end}`;
}
