/**
 * Camp FAQ — pure helpers (see plans/camp-faq.md). Client-safe: imported by the
 * FAQ routes, the answer editor, and the wiki editor's link picker.
 *
 * The answer BODY format is deliberately not defined here — answers are written
 * in the wiki format (`~/lib/wiki`), the same markdown subset with the same
 * `[[…]]` link syntax. That is what lets an answer point deep into CampTool and
 * straight at a wiki page without inventing a second markup.
 */
import { wikiSlug } from "./wiki";

/* --------------------------------------------------------------- lifecycle */

/**
 * An entry's whole lifecycle. A member-submitted question waiting on an officer
 * is just a `pending` entry with an empty answer — answering it IS editing that
 * row, so there is no submissions table to keep in sync.
 */
export type FaqStatus = "pending" | "published" | "archived";

export function isFaqStatus(v: string): v is FaqStatus {
  return v === "pending" || v === "published" || v === "archived";
}

/* -------------------------------------------------------------------- slugs */

/** Question -> stable URL key. Frozen at creation: re-wording a question must
 * not break the `[[/faq/…]]` links other answers already made. */
export function faqSlug(question: string): string {
  return wikiSlug(question);
}

/** Entries with no category land here rather than forcing a camp to invent
 * taxonomy before it can write its first answer. */
export const GENERAL_CATEGORY = "General";

/* ------------------------------------------------------------------ search */

export type FaqSearchable = { question: string; answer: string };

/**
 * Does this entry match a search box query? Every whitespace-separated term
 * must appear somewhere in the question or the answer — so "ticket refund"
 * finds the entry that asks about tickets and mentions refunds in the answer,
 * without requiring the two words to be adjacent.
 */
export function faqMatches(entry: FaqSearchable, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = `${entry.question}\n${entry.answer}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/* ---------------------------------------------------------------- grouping */

export type FaqGroupable = {
  id: string;
  categoryId: string | null;
  position: number;
  question: string;
};

export type FaqCategoryLike = {
  id: string;
  name: string;
  slug: string;
  position: number;
};

export type FaqGroup<E> = {
  /** null = the General bucket. */
  id: string | null;
  name: string;
  slug: string;
  entries: E[];
};

/**
 * Bucket entries under their category in display order, dropping categories
 * that would render empty. General always comes last: it is the leftovers, not
 * a headline. Entries a camp filed under a since-deleted category fall into it
 * (the FK is ON DELETE SET NULL), which is exactly where they belong.
 */
export function groupFaqEntries<E extends FaqGroupable>(
  entries: E[],
  categories: FaqCategoryLike[],
): FaqGroup<E>[] {
  const byCategory = new Map<string | null, E[]>();
  for (const e of entries) {
    const key = e.categoryId ?? null;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(e);
    else byCategory.set(key, [e]);
  }
  for (const bucket of byCategory.values()) bucket.sort(compareEntries);

  const ordered = [...categories].sort(
    (a, b) => a.position - b.position || a.name.localeCompare(b.name),
  );
  const groups: FaqGroup<E>[] = [];
  for (const c of ordered) {
    const found = byCategory.get(c.id);
    // A category the camp made but hasn't filled yet is noise on a read page;
    // the officer editor lists every category regardless.
    if (!found || found.length === 0) continue;
    groups.push({ id: c.id, name: c.name, slug: c.slug, entries: found });
  }
  // Anything whose category id doesn't resolve is General too — a stale id can
  // only mean the category is gone.
  const known = new Set(ordered.map((c) => c.id));
  const general = entries.filter(
    (e) => !e.categoryId || !known.has(e.categoryId),
  );
  if (general.length > 0) {
    groups.push({
      id: null,
      name: GENERAL_CATEGORY,
      slug: "general",
      entries: [...general].sort(compareEntries),
    });
  }
  return groups;
}

function compareEntries(a: FaqGroupable, b: FaqGroupable): number {
  return a.position - b.position || a.question.localeCompare(b.question);
}
