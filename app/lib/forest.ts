/**
 * Building a tree out of rows that point at their parent — cycle-guarded.
 *
 * Two things in this app are parent-pointer forests: the invite tree
 * (`membership.invited_by_membership_id`) and social groups
 * (`camp_group.parent_group_id`). Both are self-referential columns that the
 * database will happily let form a loop:
 *
 *  - a merge could point a membership at itself (see `plans/merge-symmetric.md`);
 *  - `ON DELETE SET NULL` leaves dangling-looking rows;
 *  - a hand-edited database, or a reparent that wasn't checked, makes a real
 *    cycle.
 *
 * A naive recursive walk over any of those never returns — it hangs the render,
 * not just the branch. So the guard lives here once, and both callers get it.
 *
 * Pure: no database import, so the awkward shapes are directly testable
 * (`forest.test.ts`).
 */

export type TreeNode<T> = {
  item: T;
  children: TreeNode<T>[];
  /** Everything below this node, at any depth. Excludes the node itself. */
  descendants: number;
  depth: number;
};

export type ForestOpts<T> = {
  idOf: (item: T) => string;
  parentOf: (item: T) => string | null;
  /** Sibling order. Applied at every level, including the roots. */
  compare?: (a: T, b: T) => number;
};

/**
 * Build the forest. Roots are items with no parent, a parent that is missing
 * from `items`, or a parent that is the item itself — each of which means "this
 * has nowhere above it", not "drop it".
 *
 * Anything left unreachable afterwards was in a cycle; those items are surfaced
 * as roots of their own rather than vanishing. A list that silently omits people
 * is worse than one whose nesting is slightly wrong.
 */
export function buildForest<T>(
  items: T[],
  { idOf, parentOf, compare }: ForestOpts<T>,
): TreeNode<T>[] {
  const known = new Set(items.map(idOf));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];

  for (const item of items) {
    const parent = parentOf(item);
    if (!parent || parent === idOf(item) || !known.has(parent)) {
      roots.push(item);
      continue;
    }
    const list = childrenOf.get(parent);
    if (list) list.push(item);
    else childrenOf.set(parent, [item]);
  }

  const sort = (list: T[]) => (compare ? [...list].sort(compare) : list);

  // `seen` spans the whole forest, so nothing can be rendered twice and a cycle
  // (a→b→a) simply never gets entered from a root.
  const seen = new Set<string>();
  const build = (item: T, depth: number): TreeNode<T> => {
    seen.add(idOf(item));
    const children = sort(childrenOf.get(idOf(item)) ?? [])
      .filter((c) => !seen.has(idOf(c)))
      .map((c) => build(c, depth + 1));
    return {
      item,
      children,
      descendants: children.reduce((n, c) => n + c.descendants + 1, 0),
      depth,
    };
  };

  const forest = sort(roots).map((r) => build(r, 0));
  for (const item of sort(items)) {
    if (!seen.has(idOf(item))) forest.push(build(item, 0));
  }
  return forest;
}

/** Depth-first flatten, so a table can render the forest as indented rows. */
export function flattenForest<T>(forest: TreeNode<T>[]): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const walk = (n: TreeNode<T>) => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const n of forest) walk(n);
  return out;
}

/** Ids at or below `rootId`, including it. Terminates on a cycle. */
export function subtreeOf<T>(
  items: T[],
  rootId: string,
  { idOf, parentOf }: Omit<ForestOpts<T>, "compare">,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const item of items) {
    const parent = parentOf(item);
    if (!parent || parent === idOf(item)) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(idOf(item));
    else childrenOf.set(parent, [idOf(item)]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) walk(c);
  };
  walk(rootId);
  return out;
}

/**
 * Would making `childId` a child of `parentId` create a loop?
 *
 * True when they are the same, or when `parentId` already sits somewhere below
 * `childId`. This is the check that keeps `buildForest`'s cycle guard from ever
 * having to do real work — the guard is the safety net, this is the door.
 */
export function wouldCycle<T>(
  items: T[],
  childId: string,
  parentId: string | null,
  opts: Omit<ForestOpts<T>, "compare">,
): boolean {
  if (!parentId) return false;
  if (childId === parentId) return true;
  return subtreeOf(items, childId, opts).includes(parentId);
}
