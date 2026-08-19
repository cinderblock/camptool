/**
 * The invite tree: who brought whom.
 *
 * `membership.invited_by_membership_id` has been recorded on every invite
 * redemption since invite links shipped; this turns those edges into something
 * you can read. The traversal itself — and the cycle guard it needs — lives in
 * `forest.ts`, shared with the social-group tree.
 */
import { type TreeNode, buildForest, flattenForest, subtreeOf } from "./forest";

type Idish = { membershipId: string; invitedByMembershipId: string | null };

const OPTS = {
  idOf: (m: Idish) => m.membershipId,
  parentOf: (m: Idish) => m.invitedByMembershipId,
};

export type InviteNode<T> = TreeNode<T>;

export function buildInviteTree<T extends Idish>(
  members: T[],
  compare?: (a: T, b: T) => number,
): TreeNode<T>[] {
  return buildForest(members, { ...OPTS, compare });
}

/** Every member at or below `membershipId`, including that member. */
export function subtreeIds<T extends Idish>(
  members: T[],
  membershipId: string,
): string[] {
  return subtreeOf(members, membershipId, OPTS);
}

export { flattenForest as flattenTree };
