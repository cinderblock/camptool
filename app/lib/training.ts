/**
 * Training sign-offs — pure catalog + validity predicate (client-safe). Pairs
 * with db/schema/training.ts and training.server.ts. Design:
 * plans/events-scheduling.md.
 */

export type TrainingValidity = "lifetime" | "per_edition" | "annual";

export const VALIDITY_OPTIONS: {
  value: TrainingValidity;
  label: string;
  hint: string;
}[] = [
  {
    value: "lifetime",
    label: "One-time",
    hint: "Signed off once, good forever (e.g. a first-time orientation).",
  },
  {
    value: "per_edition",
    label: "Each year",
    hint: "Must be re-signed for every event year (e.g. a waiver).",
  },
  {
    value: "annual",
    label: "Expires after a year",
    hint: "Valid for ~12 months from when it was granted (e.g. a certification).",
  },
];

export function validityLabel(validity: string): string {
  return VALIDITY_OPTIONS.find((v) => v.value === validity)?.label ?? validity;
}

export type Enforcement = "required" | "warn";

/** ~12 months, for computing an annual sign-off's expiry at grant time. */
export const ANNUAL_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Is this sign-off currently valid? Validity is COMPUTED, never stored:
 *  - revoked → no, regardless of anything else
 *  - lifetime → yes
 *  - per_edition → only for the edition it was granted for
 *  - annual → until its expiry timestamp
 */
export function isValidSignoff(
  validity: string,
  signoff: {
    editionId: string | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  },
  ctx: { editionId: string; now?: Date },
): boolean {
  if (signoff.revokedAt) return false;
  switch (validity) {
    case "lifetime":
      return true;
    case "per_edition":
      return signoff.editionId === ctx.editionId;
    case "annual":
      return (
        signoff.expiresAt != null &&
        signoff.expiresAt.getTime() > (ctx.now ?? new Date()).getTime()
      );
    default:
      return false;
  }
}
