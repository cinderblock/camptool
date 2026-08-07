/**
 * Supplies — pure name-matching helpers (client-safe, no server imports) used
 * by both the dedupe hint on the supplies page and the server-side "claim the
 * existing line instead of adding a second one" rule.
 *
 * Why this exists: a camper said in a meeting that they'd bring liquor, and had
 * no way to see what anyone else had already claimed. The fix is to show
 * matches *at the point of signup*, which needs a match that survives the ways
 * people actually type — "Whiskey", "whiskey ", "Whiskeys", "whis-key" are all
 * the same thing to a human and should be to us.
 *
 * Deliberately conservative. This surfaces candidates to a person who then
 * decides; it never silently merges two people's entries. The only automatic
 * action it drives is claiming an *unclaimed* line whose name matches exactly
 * after normalization — which is what the camper meant anyway.
 */

/**
 * Fold a supply name to its comparison key: case, surrounding and repeated
 * whitespace, punctuation and a plural "s" all stop mattering.
 *
 * The plural rule only fires on words longer than three characters, so "gas"
 * and "ice" survive intact; and only on a trailing "s" that isn't "ss", so
 * "glass" doesn't become "glas".
 */
export function normalizeSupplyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) =>
      w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w,
    )
    .join(" ");
}

/** Two names mean the same thing for claiming purposes. */
export function sameSupply(a: string, b: string): boolean {
  const na = normalizeSupplyName(a);
  return na.length > 0 && na === normalizeSupplyName(b);
}

export type SupplyMatch<T> = {
  item: T;
  /** "exact" after normalization, or a looser word-level overlap. */
  kind: "exact" | "related";
};

/**
 * Candidates to show someone typing a supply name. Exact normalized matches
 * come first, then entries sharing a whole word ("whiskey" ↔ "cheap whiskey",
 * "bourbon whiskey"), which is where the useful "someone's already on this"
 * signal usually lives. Substrings shorter than three characters are ignored so
 * a single letter doesn't light up the whole list.
 */
export function findSimilarSupplies<T>(
  query: string,
  items: T[],
  nameOf: (item: T) => string,
  limit = 6,
): SupplyMatch<T>[] {
  const q = normalizeSupplyName(query);
  if (q.length < 3) return [];
  const qWords = new Set(q.split(" ").filter((w) => w.length >= 3));
  const out: SupplyMatch<T>[] = [];
  for (const item of items) {
    const n = normalizeSupplyName(nameOf(item));
    if (!n) continue;
    if (n === q) {
      out.push({ item, kind: "exact" });
      continue;
    }
    const words = n.split(" ");
    const overlaps =
      words.some((w) => qWords.has(w)) || n.includes(q) || q.includes(n);
    if (overlaps) out.push({ item, kind: "related" });
  }
  return out
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "exact" ? -1 : 1))
    .slice(0, limit);
}

/**
 * What should happen when someone says "I'm bringing X" in a group that already
 * has some lines? Decided here rather than inline in the route so the rule is
 * directly testable, since it's the one place this feature acts on its own.
 *
 * Exactly one case is automatic: a line with the same name sitting UNCLAIMED is
 * what the person meant, so claim it instead of creating a near-identical
 * second row. Everything else adds a row — including when someone else already
 * claimed the same thing, because two people each bringing whiskey is two
 * facts, not a conflict.
 */
export function resolveSupplyClaim<T extends { name: string; owner: unknown }>(
  name: string,
  siblings: T[],
): { action: "claim"; target: T } | { action: "add" } {
  const target = siblings.find((s) => !s.owner && sameSupply(s.name, name));
  return target ? { action: "claim", target } : { action: "add" };
}

/**
 * Groups of entries that normalize to the same name — what an officer wants to
 * see to tidy up. Only groups of two or more come back, and the group keeps
 * source order so the oldest entry reads first.
 */
export function duplicateGroups<T>(
  items: T[],
  nameOf: (item: T) => string,
): T[][] {
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = normalizeSupplyName(nameOf(item));
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}
