/**
 * Privacy mode — pure half.
 *
 * Privacy mode replaces personally-identifying data with deterministic
 * pseudonyms so the live instance can be demoed/screen-shared without exposing
 * real campers. See `plans/privacy-and-demo-mode.md`.
 *
 * This file is free of server-only imports (no crypto, no DB) so the cookie
 * shape and the field-classification rules can be unit-tested and shared. The
 * actual substitution lives in `privacy.server.ts`.
 *
 * IMPORTANT: privacy mode is a screen-share convenience, NOT an access control.
 * It hides PII from someone looking at the screen; it does not make a lower
 * privilege tier. If you ever want "this person may use the app but must not
 * see names", that is role-based access control and belongs elsewhere.
 */

/** Per-browser privacy state. `keepSelf` leaves the viewer's own identity alone
 * so they stay oriented while everyone else is pseudonymized. */
export type PrivacyMode = { on: boolean; keepSelf: boolean };

export const PRIVACY_OFF: PrivacyMode = { on: false, keepSelf: false };

/** Cookie values: absent/`off` = off, `on` = everyone, `on+self` = keep me. */
export function parsePrivacyMode(raw: string | null | undefined): PrivacyMode {
  if (raw === "on") return { on: true, keepSelf: false };
  if (raw === "on+self") return { on: true, keepSelf: true };
  return PRIVACY_OFF;
}

export function serializePrivacyMode(mode: PrivacyMode): string {
  if (!mode.on) return "off";
  return mode.keepSelf ? "on+self" : "on";
}

// --- Field classification -------------------------------------------------
//
// There is no shared display layer in this app (~189 direct PII field accesses
// across 36 files), so redaction happens on loader DATA keyed by field name.
// The rules below are deliberately biased toward UNDER-redacting by accident:
// a miss is caught by the dev-mode leak audit and the manual sweep, whereas
// over-redaction silently mangles talk titles and structure names and makes
// the demo worse than useless.

/** What a value should be replaced with. `text` means "substitute any real
 * names found INSIDE the prose", not "replace the whole string". */
export type PiiKind =
  | "person"
  | "playa"
  | "email"
  | "handle"
  | "phone"
  | "text"
  | "drop";

/** Keys that are unambiguously PII wherever they appear. */
const EXACT: Record<string, PiiKind> = {
  email: "email",
  playaName: "playa",
  discordUsername: "handle",
  discordUserId: "handle",
  discordHandle: "handle",
  phone: "phone",
  ipAddress: "drop",
  userAgent: "drop",
  image: "drop",
  avatarUrl: "drop",
  stack: "drop",
  breadcrumbs: "drop",
};

/** Suffix rules for the many `placementContactEmail` / `hostPhone` shapes. */
const SUFFIX: [RegExp, PiiKind][] = [
  [/Email$/, "email"],
  [/PlayaName$/, "playa"],
  [/Playa$/, "playa"],
  [/Phone$/, "phone"],
  [/Username$/, "handle"],
];

/**
 * `*Name` keys that are NOT people. Everything else ending in `Name` is treated
 * as a person, because the person-name keys are open-ended (`subjectName`,
 * `reporterName`, `presenterName`, `guestName`, `hostName`, …) while the
 * non-person ones are a short, enumerable list.
 */
const SAFE_NAME_KEYS = new Set([
  "campName",
  "editionName",
  "eventName",
  "featureName",
  "fileName",
  "itemName",
  "kindName",
  "offeringName",
  "roleName",
  "structureName",
  "tableName",
  "zoneName",
]);

/**
 * Free-text keys. These get name substitution rather than wholesale
 * replacement — a note reading "ask Sarah about the shade" becomes "ask Dana
 * about the shade", which keeps the demo legible while closing what is
 * otherwise the biggest leak vector in the app (`question_answer.value` in
 * particular is an unbounded sink: camps define arbitrary prompts as data, so
 * dietary/medical/emergency-contact answers all land there).
 */
const FREE_TEXT = new Set([
  "answers",
  "body",
  "counterparty",
  "description",
  "details",
  "helpText",
  // The label of the invite link someone came through — an officer-typed note
  // like "For Alex", so it leaks names as readily as any other free text.
  "invitedVia",
  "message",
  "metadata",
  "note",
  "notes",
  "previousCamp",
  "previousCampNotes",
  "reviewNote",
  "reviewNotes",
  // An email subject / "gist" line on a logged prospect conversation — as
  // full of real names as the body under it.
  "subject",
  "summary",
  "title",
  "value",
]);

/**
 * Signals that an object IS a person (so its bare `name` is a person's name),
 * as opposed to merely BELONGING to one. `ownerMembershipId` is deliberately
 * absent: a shade structure or an inventory item has an owner but its `name`
 * is "Big Shade" or "Propane tank", and mangling those ruins the demo.
 */
const PERSONHOOD_KEYS = ["email", "playaName", "userId", "attendeeId"];

function isPersonRecord(record: Record<string, unknown>): boolean {
  return PERSONHOOD_KEYS.some((k) => k in record);
}

/**
 * Classify one key. `record` is the object the key lives on, used only to
 * disambiguate a bare `name` (a user row vs. a talk title vs. a structure).
 * Returns null when the value should pass through untouched.
 */
export function classifyKey(
  key: string,
  record: Record<string, unknown> = {},
): PiiKind | null {
  const exact = EXACT[key];
  if (exact) return exact;
  for (const [re, kind] of SUFFIX) if (re.test(key)) return kind;
  if (key === "name") return isPersonRecord(record) ? "person" : null;
  if (key.endsWith("Name")) return SAFE_NAME_KEYS.has(key) ? null : "person";
  if (FREE_TEXT.has(key)) return "text";
  return null;
}

/** Per-call overrides for the cases the heuristics get wrong. */
export type RedactOverrides = {
  /** Force these keys to be treated as the given kind. */
  as?: Record<string, PiiKind>;
  /** Never touch these keys in this payload. */
  keep?: string[];
};

export function classifyWith(
  key: string,
  record: Record<string, unknown>,
  overrides?: RedactOverrides,
): PiiKind | null {
  if (overrides?.keep?.includes(key)) return null;
  const forced = overrides?.as?.[key];
  if (forced) return forced;
  return classifyKey(key, record);
}
