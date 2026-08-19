/**
 * Turning `membership.invited_by_membership_id` into something you can read.
 *
 * The edges have been recorded since the invite links shipped, and nothing has
 * ever rendered them as anything but a flat "Invited by <name>" cell. This
 * builds the actual tree — who brought whom, however many hops deep.
 *
 * Pure, so the awkward shapes can be tested directly (`invite-tree.test.ts`).
 * The awkward shapes are not hypothetical: the column is self-referential with
 * `ON DELETE SET NULL`, a merge can point a membership at itself (see
 * `plans/merge-symmetric.md`, progress log), and a hand-edited database can
 * produce a genuine cycle. A naive recursive walk over any of those never
 * returns, so **every traversal here is cycle-guarded**.
 */

export type InviteNode<T> = {
  member: T;
  /** People this member brought in, sorted by the caller's comparator. */
  children: InviteNode<T>[];
  /** How many people are below this node in total, not counting the node. */
  descendants: number;
  depth: number;
};

type Idish = { membershipId: string; invitedByMembershipId: string | null };

/**
 * Build the forest. Roots are members with no inviter — the founder, public
 * applicants, anyone added by an officer — plus anyone whose inviter is missing
 * or unreachable, so nobody can be lost by a broken edge.
 */
export function buildInviteTree<T extends Idish>(
  members: T[],
  compare: (a: T, b: T) => number = () => 0,
): InviteNode<T>[] {
  const byId = new Map(members.map((m) => [m.membershipId, m]));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];

  for (const m of members) {
    const parentId = m.invitedByMembershipId;
    // A self-edge is not a parent, and an inviter who has left the camp (or was
    // never in it) can't anchor a subtree — both make the member a root.
    if (!parentId || parentId === m.membershipId || !byId.has(parentId)) {
      roots.push(m);
      continue;
    }
    const list = childrenOf.get(parentId);
    if (list) list.push(m);
    else childrenOf.set(parentId, [m]);
  }

  // `seen` spans the whole forest, so a member can only ever appear once: a
  // cycle (a→b→a) leaves every node in it unreachable from any root, which is
  // then repaired by the sweep below rather than looping forever.
  const seen = new Set<string>();

  const build = (m: T, depth: number): InviteNode<T> => {
    seen.add(m.membershipId);
    const kids = (childrenOf.get(m.membershipId) ?? [])
      .filter((c) => !seen.has(c.membershipId))
      .sort(compare)
      .map((c) => build(c, depth + 1));
    return {
      member: m,
      children: kids,
      descendants: kids.reduce((n, k) => n + k.descendants + 1, 0),
      depth,
    };
  };

  const forest = roots.sort(compare).map((r) => build(r, 0));

  // Anyone stranded in a cycle is surfaced as a root of their own. Losing them
  // silently would be worse than showing a tree that is slightly wrong, and the
  // page is a directory first — everyone has to be on it.
  for (const m of members.sort(compare)) {
    if (!seen.has(m.membershipId)) forest.push(build(m, 0));
  }
  return forest;
}

/** Every member at or below `membershipId`, including that member. */
export function subtreeIds<T extends Idish>(
  members: T[],
  membershipId: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const m of members) {
    const p = m.invitedByMembershipId;
    if (!p || p === m.membershipId) continue;
    const list = childrenOf.get(p);
    if (list) list.push(m.membershipId);
    else childrenOf.set(p, [m.membershipId]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) walk(c);
  };
  walk(membershipId);
  return out;
}

/** Flatten a forest depth-first, so a table can render it as indented rows. */
export function flattenTree<T>(forest: InviteNode<T>[]): InviteNode<T>[] {
  const out: InviteNode<T>[] = [];
  const walk = (n: InviteNode<T>) => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const n of forest) walk(n);
  return out;
}
