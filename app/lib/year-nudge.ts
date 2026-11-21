/**
 * The "start the new year" nudge (plans/season-2027.md).
 *
 * Nothing in the app makes a camp's years for it: an officer adds each one on
 * /editions. A new camp lands on a home page with no year and no hint that one
 * is needed, and an existing camp sails past exodus still showing last year.
 * This decides when the shell should say so, and what the one-click fix is.
 */
import { currentEventYear } from "./brc";
import { BURNING_MAN } from "./events";

type EditionLike = { id: string; year: number; event: string };

export type YearNudge =
  /** The camp has no years at all. */
  | { kind: "first"; year: number; event: string }
  /** The newest year is behind the current event year. Starting the new one
   * copies `from`'s lot setup and keeps its event. */
  | {
      kind: "next";
      year: number;
      event: string;
      from: { id: string; year: number };
    }
  | null;

/**
 * What to nudge about, given the camp's editions (any order). Only ever offers
 * the CURRENT event year, never a year the camp skipped past: a camp whose
 * newest year is 2024 is offered 2027, not 2025.
 */
export function yearNudge(
  editions: readonly EditionLike[],
  now: Date = new Date(),
): YearNudge {
  const year = currentEventYear(now);
  if (editions.length === 0) return { kind: "first", year, event: BURNING_MAN };
  const newest = editions.reduce((a, b) => (b.year > a.year ? b : a));
  if (newest.year >= year) return null;
  return {
    kind: "next",
    year,
    event: newest.event,
    from: { id: newest.id, year: newest.year },
  };
}
