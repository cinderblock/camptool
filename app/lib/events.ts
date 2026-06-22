/**
 * Events a camp can attend. An "event" is the per-edition layer (see the
 * four-layer architecture in `plans/camptool.md`): it selects the map/addressing
 * provider and gates event-specific UI (e.g. Burning Man's BRC map specifics, its
 * ticket/pass flows, and the Burning Man Project disclaimer). Client-safe.
 *
 * Only Burning Man has a built-in map provider today (decision #6 — no
 * speculative second scheme), but the seam exists so other events slot in later.
 */

/** The default event key (and the one with a built-in BRC map provider). */
export const BURNING_MAN = "burning-man";

export type EventOption = { value: string; label: string };

export const EVENTS: readonly EventOption[] = [
  { value: BURNING_MAN, label: "Burning Man" },
  { value: "unscruz", label: "UnSCruz" },
  { value: "other", label: "Other event" },
];

const EVENT_LABELS = new Map(EVENTS.map((e) => [e.value, e.label]));

/** True if `event` is a known event key. */
export function isEvent(value: string): boolean {
  return EVENT_LABELS.has(value);
}

/** Human label for an event key (falls back to the raw key). */
export function eventLabel(value: string): string {
  return EVENT_LABELS.get(value) ?? value;
}

/** Whether this edition's event is Burning Man — gates BM-specific UI. */
export function isBurningMan(event: string | null | undefined): boolean {
  return event === BURNING_MAN;
}
