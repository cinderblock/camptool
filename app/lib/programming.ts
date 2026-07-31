/**
 * Programming — pure catalogs + helpers (client-safe, no server imports). Pairs
 * with db/schema/programming.ts and programming.server.ts. Design:
 * plans/programming-offerings.md.
 *
 * All dates are ISO `YYYY-MM-DD` strings and times wall-clock `HH:MM` (24h) —
 * no Date-object timezone handling anywhere (see the schema header for why).
 */

/** The camp's own vocabulary lives here; the FEATURE stays generic. Math Camp
 * picks `lecture`, a sound camp picks `performance`. */
export type OfferingKind =
  | "lecture"
  | "workshop"
  | "class"
  | "performance"
  | "discussion"
  | "other";

export const OFFERING_KINDS: {
  value: OfferingKind;
  label: string;
  color: string;
  hint: string;
}[] = [
  {
    value: "lecture",
    label: "Lecture",
    color: "indigo",
    hint: "A talk — someone presents, the audience listens.",
  },
  {
    value: "workshop",
    label: "Workshop",
    color: "orange",
    hint: "Hands-on — people make or do something.",
  },
  {
    value: "class",
    label: "Class",
    color: "teal",
    hint: "Teaching a skill, usually with practice.",
  },
  {
    value: "performance",
    label: "Performance",
    color: "grape",
    hint: "Music, theater, fire, spectacle.",
  },
  {
    value: "discussion",
    label: "Discussion",
    color: "cyan",
    hint: "A conversation with no single presenter.",
  },
  { value: "other", label: "Other", color: "gray", hint: "Anything else." },
];

export function offeringKindLabel(kind: string): string {
  return OFFERING_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export function offeringKindColor(kind: string): string {
  return OFFERING_KINDS.find((k) => k.value === kind)?.color ?? "gray";
}

export function isOfferingKind(value: string): value is OfferingKind {
  return OFFERING_KINDS.some((k) => k.value === value);
}

/** proposed -> accepted | declined, or withdrawn by the proposer. */
export type OfferingStatus = "proposed" | "accepted" | "declined" | "withdrawn";

export const OFFERING_STATUS_COLOR: Record<OfferingStatus, string> = {
  proposed: "yellow",
  accepted: "green",
  declined: "red",
  withdrawn: "gray",
};

export const OFFERING_STATUS_LABEL: Record<OfferingStatus, string> = {
  proposed: "Awaiting review",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export function isOfferingStatus(value: string): value is OfferingStatus {
  return (
    value === "proposed" ||
    value === "accepted" ||
    value === "declined" ||
    value === "withdrawn"
  );
}

/** `public` is listed on the camp's public page; `camp_only` stays internal. */
export type OfferingAudience = "public" | "camp_only";

export const AUDIENCE_OPTIONS: {
  value: OfferingAudience;
  label: string;
  hint: string;
}[] = [
  {
    value: "public",
    label: "Open to the event",
    hint: "Listed on the camp's public page — anyone can come.",
  },
  {
    value: "camp_only",
    label: "Camp only",
    hint: "Just for our campers; never listed publicly.",
  },
];

export function audienceLabel(audience: string): string {
  return AUDIENCE_OPTIONS.find((a) => a.value === audience)?.label ?? audience;
}

export function isOfferingAudience(value: string): value is OfferingAudience {
  return value === "public" || value === "camp_only";
}

export type SessionStatus = "scheduled" | "cancelled";

/** Common talk lengths, offered as a picker so proposals are comparable. */
export const DURATION_OPTIONS = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "45", label: "45 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1½ hours" },
  { value: "120", label: "2 hours" },
];

export function durationLabel(min: number | null): string | null {
  if (min == null) return null;
  return (
    DURATION_OPTIONS.find((d) => d.value === String(min))?.label ?? `${min} min`
  );
}

/**
 * A presenter's display name. Camp people resolve through `attendee` (a member
 * uses their account name, a guest their `attendee.name`); an outside speaker
 * has only the bare `name` on the presenter row.
 */
export function presenterName(p: {
  name: string | null;
  attendeeName: string | null;
}): string {
  return p.attendeeName ?? p.name ?? "Unnamed presenter";
}
