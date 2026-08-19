/**
 * Deciding what two duplicate records become — the pure half of a member merge.
 *
 * The whole point of this module is a single property:
 *
 *   planMerge(a, b)  ===  planMerge(b, a)
 *
 * An officer cleaning up a duplicate cannot know which of the two records is
 * "the real one" — that is the question the old merge UI asked and nobody could
 * answer (`plans/merge-symmetric.md`). So no field is resolved by which record
 * was clicked. Every field is resolved by a rule over both values, and where no
 * rule can honestly settle it, the disagreement is reported as a conflict for a
 * human to answer once, by value rather than by side.
 *
 * A surviving row id still has to be chosen — SQL needs somewhere to write —
 * but it is chosen here, deterministically, from the data.
 *
 * Kept free of any database import so the symmetry property can be tested
 * exhaustively (`merge-plan.test.ts`).
 */
import { rankOf } from "./permissions";

/** One of the two records being merged, flattened from `membership` + `user`. */
export type MergeSide = {
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  playaName: string | null;
  invitedByMembershipId: string | null;
  viaInviteId: string | null;
  wizardStep: number;
  /** epoch ms */
  wizardCompletedAt: number | null;
  joinedAt: number;
  createdAt: number;
  userName: string;
  userEmail: string;
  userImage: string | null;
  userEmailVerified: boolean;
  userCreatedAt: number;
  /** Sign-in credentials, used for the "what will still work" summary. */
  hasPassword: boolean;
  passkeyCount: number;
  /** Social provider ids on the account, e.g. ["discord"]. */
  socialProviders: string[];
};

/** A disagreement no rule can settle: both sides hold a different real value. */
export type MergeConflict = {
  field: "playaName" | "userName";
  /** Human label for the field, e.g. "Playa name". */
  label: string;
  /** Distinct candidate values, in a stable order. First is the default. */
  options: string[];
};

export type MergePlan = {
  /** The membership row that will be written to and kept. */
  survivorId: string;
  /** The membership row that will be deleted once everything has moved. */
  staleId: string;
  survivorUserId: string;
  staleUserId: string;
  /** True when both memberships already belong to one account — no user fold. */
  sameUser: boolean;
  /** Resolved `membership` columns. */
  membership: {
    role: string;
    status: string;
    playaName: string | null;
    invitedByMembershipId: string | null;
    viaInviteId: string | null;
    wizardStep: number;
    wizardCompletedAt: number | null;
    joinedAt: number;
    createdAt: number;
  };
  /** Resolved `user` columns. */
  user: {
    name: string;
    email: string;
    image: string | null;
    emailVerified: boolean;
  };
  /** The address that stops being primary and is recorded as an alias. */
  aliasEmail: string | null;
  /** Both sides had a password; one is being discarded. Must be surfaced. */
  droppedPassword: boolean;
  /** Plain-English list of what will still sign this person in afterwards. */
  signInMethods: string[];
  conflicts: MergeConflict[];
};

/** Picks a human made for conflicts, keyed by field, holding the chosen value. */
export type MergePicks = Partial<Record<MergeConflict["field"], string>>;

const blank = (v: string | null | undefined) => !v || !v.trim();

/**
 * Order the pair deterministically. Earliest join wins because that is when the
 * relationship actually started; the id tie-break exists so two records created
 * in the same millisecond still sort stably rather than by argument order.
 */
function order(a: MergeSide, b: MergeSide): [MergeSide, MergeSide] {
  if (a.joinedAt !== b.joinedAt)
    return a.joinedAt < b.joinedAt ? [a, b] : [b, a];
  return a.membershipId < b.membershipId ? [a, b] : [b, a];
}

/** Non-blank value, preferring `first`'s. Null when both are blank. */
function fill(first: string | null, second: string | null): string | null {
  if (!blank(first)) return first;
  if (!blank(second)) return second;
  return null;
}

/**
 * A conflict is only worth raising when both sides hold a real value and the
 * values genuinely differ — case and surrounding space are not disagreements.
 */
function conflictOf(
  field: MergeConflict["field"],
  label: string,
  first: string | null,
  second: string | null,
): MergeConflict | null {
  if (blank(first) || blank(second)) return null;
  const a = (first as string).trim();
  const b = (second as string).trim();
  if (a.toLowerCase() === b.toLowerCase()) return null;
  return { field, label, options: [a, b] };
}

/** Earliest of two nullable timestamps; null only when both are null. */
function earliest(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export function planMerge(
  x: MergeSide,
  y: MergeSide,
  picks: MergePicks = {},
): MergePlan {
  // Everything below reads `first`/`second`, never `x`/`y`, which is what makes
  // the result independent of the order they were passed in.
  const [first, second] = order(x, y);

  // The account that has existed longest keeps its address as the primary one;
  // same tie-break as the membership so the choice can't wobble.
  const [userFirst, userSecond] =
    first.userCreatedAt !== second.userCreatedAt
      ? first.userCreatedAt < second.userCreatedAt
        ? [first, second]
        : [second, first]
      : first.userId < second.userId
        ? [first, second]
        : [second, first];

  const sameUser = first.userId === second.userId;

  const playaConflict = conflictOf(
    "playaName",
    "Playa name",
    first.playaName,
    second.playaName,
  );
  // Built in *user* order, not membership order, so the default name belongs to
  // the same account as the default (primary) email.
  const nameConflict = sameUser
    ? null
    : conflictOf("userName", "Name", userFirst.userName, userSecond.userName);

  const conflicts = [playaConflict, nameConflict].filter(
    (c): c is MergeConflict => c !== null,
  );

  // A pick only counts if it is actually one of the offered values — a stale
  // form or a hand-crafted POST must not be able to write an arbitrary name.
  const pick = (
    c: MergeConflict | null,
    fallback: string | null,
  ): string | null => {
    if (!c) return fallback;
    const chosen = picks[c.field];
    if (chosen && c.options.includes(chosen)) return chosen;
    return c.options[0] ?? fallback;
  };

  const signInMethods: string[] = [];
  const passkeys = sameUser
    ? first.passkeyCount
    : first.passkeyCount + second.passkeyCount;
  if (passkeys > 0) {
    signInMethods.push(`${passkeys} passkey${passkeys === 1 ? "" : "s"}`);
  }
  if (first.hasPassword || second.hasPassword) signInMethods.push("password");
  for (const p of [
    ...new Set([...first.socialProviders, ...second.socialProviders]),
  ].sort()) {
    signInMethods.push(p === "discord" ? "Discord" : p);
  }

  return {
    survivorId: first.membershipId,
    staleId: second.membershipId,
    survivorUserId: userFirst.userId,
    staleUserId: userSecond.userId,
    sameUser,
    membership: {
      // Highest rank wins: a merge must never quietly demote someone.
      role:
        rankOf(first.role) >= rankOf(second.role) ? first.role : second.role,
      // Any active record makes the person active.
      status:
        first.status === "active" || second.status === "active"
          ? "active"
          : first.status,
      playaName: pick(playaConflict, fill(first.playaName, second.playaName)),
      // Provenance feeds the invite tree (plans/social-groups.md), so keep an
      // edge if either record has one.
      invitedByMembershipId:
        first.invitedByMembershipId ?? second.invitedByMembershipId,
      viaInviteId: first.viaInviteId ?? second.viaInviteId,
      wizardStep: Math.max(first.wizardStep, second.wizardStep),
      wizardCompletedAt: earliest(
        first.wizardCompletedAt,
        second.wizardCompletedAt,
      ),
      joinedAt: Math.min(first.joinedAt, second.joinedAt),
      createdAt: Math.min(first.createdAt, second.createdAt),
    },
    user: {
      name:
        pick(nameConflict, fill(userFirst.userName, userSecond.userName)) ??
        userFirst.userName,
      email: userFirst.userEmail,
      image: fill(userFirst.userImage, userSecond.userImage),
      emailVerified:
        userFirst.userEmailVerified || userSecond.userEmailVerified,
    },
    aliasEmail:
      sameUser ||
      userFirst.userEmail.toLowerCase() === userSecond.userEmail.toLowerCase()
        ? null
        : userSecond.userEmail.toLowerCase(),
    droppedPassword: !sameUser && first.hasPassword && second.hasPassword,
    signInMethods,
    conflicts,
  };
}
