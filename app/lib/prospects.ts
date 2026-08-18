/**
 * Prospect vocabulary — statuses, channels, and how they're labelled. Pure and
 * client-safe (imported by the route component as well as the server helpers).
 *
 * The status list is duplicated from `db/schema/prospect.ts` deliberately: the
 * schema owns the storage contract, this owns presentation, and a route
 * importing the schema drags the server-only Drizzle graph into the client
 * bundle.
 */

export type ProspectStatus =
  | "lead"
  | "talking"
  | "invited"
  | "applied"
  | "joined"
  | "passed"
  | "declined"
  | "stale";

export type ProspectStatusDef = {
  value: ProspectStatus;
  label: string;
  color: string;
  /** One line the officer reads when picking; keeps the funnel honest. */
  hint: string;
  /**
   * How far along the funnel this is. Merging two records for one human keeps
   * the further-along status, so this ordering is load-bearing, not cosmetic.
   * Closed states share rank 0 with `lead` — being told "no" last year should
   * not outrank an active conversation happening now.
   */
  progress: number;
  /** Conversation is over for now: hidden from the default list view. */
  closed?: boolean;
};

export const PROSPECT_STATUS_DEFS: ProspectStatusDef[] = [
  {
    value: "lead",
    label: "Lead",
    color: "gray",
    hint: "Someone we've heard of. Nobody has actually talked to them yet.",
    progress: 1,
  },
  {
    value: "talking",
    label: "Talking",
    color: "blue",
    hint: "A real conversation is happening.",
    progress: 2,
  },
  {
    value: "invited",
    label: "Invited",
    color: "grape",
    hint: "We've sent them an invite link and are waiting on them.",
    progress: 3,
  },
  {
    value: "applied",
    label: "Applied",
    color: "cyan",
    hint: "They submitted the public application; it's in the recruits queue.",
    progress: 4,
  },
  {
    value: "joined",
    label: "Joined",
    color: "green",
    hint: "They're in the camp. The history stays attached to them.",
    progress: 5,
  },
  {
    value: "passed",
    label: "We passed",
    color: "orange",
    hint: "We decided no. Worth recording so it isn't re-litigated from scratch.",
    progress: 0,
    closed: true,
  },
  {
    value: "declined",
    label: "They declined",
    color: "orange",
    hint: "They decided no.",
    progress: 0,
    closed: true,
  },
  {
    value: "stale",
    label: "Went quiet",
    color: "dark",
    hint: "No reply for a long time. Not a no, just not moving.",
    progress: 0,
    closed: true,
  },
];

const STATUS_BY_VALUE = new Map(PROSPECT_STATUS_DEFS.map((s) => [s.value, s]));

export function isProspectStatus(v: string): v is ProspectStatus {
  return STATUS_BY_VALUE.has(v as ProspectStatus);
}

const LEAD = PROSPECT_STATUS_DEFS[0] as ProspectStatusDef;

/** Unknown values fall back to `lead` rather than throwing — a status read out
 * of the database is text, and a bad one must not blank the page. */
export function statusDef(v: string): ProspectStatusDef {
  return STATUS_BY_VALUE.get(v as ProspectStatus) ?? LEAD;
}

export function statusProgress(v: string): number {
  return statusDef(v).progress;
}

export type ProspectChannel =
  | "facebook"
  | "instagram"
  | "discord"
  | "email"
  | "sms"
  | "phone"
  | "signal"
  | "telegram"
  | "in_person"
  | "website"
  | "other";

export const PROSPECT_CHANNEL_DEFS: {
  value: ProspectChannel;
  label: string;
  /** Whether a handle of this kind is a link that can be opened. */
  linkable?: boolean;
}[] = [
  { value: "facebook", label: "Facebook", linkable: true },
  { value: "instagram", label: "Instagram", linkable: true },
  { value: "discord", label: "Discord" },
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
  { value: "phone", label: "Phone" },
  { value: "signal", label: "Signal" },
  { value: "telegram", label: "Telegram", linkable: true },
  { value: "in_person", label: "In person" },
  { value: "website", label: "Website", linkable: true },
  { value: "other", label: "Other" },
];

const CHANNEL_BY_VALUE = new Map(
  PROSPECT_CHANNEL_DEFS.map((c) => [c.value, c]),
);

export function isProspectChannel(v: string): v is ProspectChannel {
  return CHANNEL_BY_VALUE.has(v as ProspectChannel);
}

export function channelLabel(v: string): string {
  return CHANNEL_BY_VALUE.get(v as ProspectChannel)?.label ?? "Other";
}

export type InteractionDirection = "inbound" | "outbound" | "note";

export const DIRECTION_DEFS: {
  value: InteractionDirection;
  label: string;
  /** How it reads in the log line: "They wrote", "We wrote", "Note". */
  lead: string;
}[] = [
  { value: "inbound", label: "They contacted us", lead: "In" },
  { value: "outbound", label: "We contacted them", lead: "Out" },
  { value: "note", label: "Just a note", lead: "Note" },
];

export function isDirection(v: string): v is InteractionDirection {
  return v === "inbound" || v === "outbound" || v === "note";
}

export function directionLead(v: string): string {
  return DIRECTION_DEFS.find((d) => d.value === v)?.lead ?? "Note";
}

/** Select options, ready for Mantine. */
export const STATUS_OPTIONS = PROSPECT_STATUS_DEFS.map((s) => ({
  value: s.value,
  label: s.label,
}));
export const CHANNEL_OPTIONS = PROSPECT_CHANNEL_DEFS.map((c) => ({
  value: c.value,
  label: c.label,
}));
export const DIRECTION_OPTIONS = DIRECTION_DEFS.map((d) => ({
  value: d.value,
  label: d.label,
}));

/**
 * A follow-up is "due" through the end of its day, not from its exact
 * timestamp — an officer setting "follow up Friday" means Friday, and a badge
 * that lights up at 00:00 Friday morning is the useful reading.
 */
export function followUpDue(
  nextFollowUpAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!nextFollowUpAt) return false;
  const due = new Date(nextFollowUpAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() <= now.getTime();
}
