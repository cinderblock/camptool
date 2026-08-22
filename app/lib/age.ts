/**
 * Age bands, and what they exempt someone from.
 *
 * A camper brought two young children who never leave their parents' side, and
 * the obvious shortcut was to record them as "+2" on an adult's row. That would
 * have been wrong: headcount counts them, map occupancy points at an attendee
 * id, and a number has nowhere to record that one of them turns 13 next spring.
 * They are people; what they are not is people who need a ticket.
 *
 * So the row stays and the *asks* are gated — the same shape as the RSVP gate
 * (`wizard.ts`) and conditional questions (`conditions.ts`). This module is the
 * one place that knows which asks an age exempts you from, so the answer can't
 * drift between the pass matcher, the ticket screen and the roster.
 *
 * Pure, so loaders and components share it.
 */

export type AgeBand = "adult" | "under_18" | "under_13";

/** Stored as text, NULL meaning adult — see `db/schema/attendee.ts`. */
export function bandOf(raw: string | null | undefined): AgeBand {
  return raw === "under_13" || raw === "under_18" ? raw : "adult";
}

export const AGE_BANDS: { value: AgeBand; label: string }[] = [
  { value: "adult", label: "Adult (18+)" },
  { value: "under_18", label: "Under 18" },
  { value: "under_13", label: "Under 13" },
];

/** Short label for a chip next to a name. Adults get nothing — the common case
 * shouldn't be badged. */
export function ageLabel(raw: string | null | undefined): string | null {
  switch (bandOf(raw)) {
    case "under_13":
      return "under 13";
    case "under_18":
      return "under 18";
    default:
      return null;
  }
}

/**
 * Does this person need a ticket of their own?
 *
 * Burning Man admits under-13s free. Under-18s need a ticket like anyone else,
 * so the *only* band with ticketing consequences is `under_13` — which is why
 * the third band exists for safety questions rather than for this.
 */
export function needsTicket(raw: string | null | undefined): boolean {
  return bandOf(raw) !== "under_13";
}

/**
 * Does this person need their own Setup Access Pass to arrive early?
 *
 * Same rule and the same threshold. This is the one that was actively wrong
 * before the band existed: a five-year-old with an early arrival date turned up
 * in the officers' "Needs a pass" list and made the camp look short of passes
 * it did not need.
 */
export function needsSetupPass(raw: string | null | undefined): boolean {
  return bandOf(raw) !== "under_13";
}

/** Are they a minor? Not used for ticketing — for the questions a camp asks
 * about supervision and safety. */
export function isMinor(raw: string | null | undefined): boolean {
  return bandOf(raw) !== "adult";
}

/**
 * "Devon & Eric +2 (under 13)" — the compact way a tightly-attached family
 * should read on a roster, without the children stopping being rows underneath.
 *
 * Returns null when there's nothing to summarise, so a caller can fall back to
 * listing people normally.
 */
export function minorSummary(
  people: { ageBand?: string | null }[],
): string | null {
  let under13 = 0;
  let under18 = 0;
  for (const p of people) {
    const band = bandOf(p.ageBand);
    if (band === "under_13") under13++;
    else if (band === "under_18") under18++;
  }
  const parts: string[] = [];
  if (under13 > 0) parts.push(`+${under13} (under 13)`);
  if (under18 > 0) parts.push(`+${under18} (under 18)`);
  return parts.length > 0 ? parts.join(" ") : null;
}
