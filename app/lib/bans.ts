/**
 * Per-edition "disallowed structures" helpers (client-safe).
 *
 * A `camp_edition` may ban certain structure kinds — e.g. Burning Man disallows
 * pop-up canopies, while a smaller event allows them. The list is stored on the
 * edition as a JSON array of kind `value`s (`camp_edition.banned_kinds`), so the
 * same camp can ban a kind one year/event and permit it another. The palette hides
 * banned kinds, add-actions reject them, and already-placed objects of a
 * now-banned kind are flagged (not deleted).
 */
import { BURNING_MAN } from "./events";

/** Parse the stored JSON array of banned kind values (NULL/garbage → none). */
export function parseBannedKinds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Serialize a banned-kinds list for storage (deduped, stable). */
export function serializeBannedKinds(kinds: Iterable<string>): string {
  return JSON.stringify([...new Set(kinds)].sort());
}

/** Is `kind` banned by this edition's stored list? */
export function isKindBanned(
  raw: string | null | undefined,
  kind: string,
): boolean {
  return parseBannedKinds(raw).includes(kind);
}

/**
 * Disallowed kinds seeded onto a NEW edition from its event (officer-overridable
 * afterward). Burning Man bans pop-up canopies; other events default to none.
 */
export function defaultBannedKinds(event: string): string[] {
  return event === BURNING_MAN ? ["popup"] : [];
}
