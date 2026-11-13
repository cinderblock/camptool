/**
 * Merging duplicate people.
 *
 * Two shapes of duplicate happen in practice:
 *
 *  1. **Two memberships, one human.** Someone signs up, can't log in, and
 *     registers again from scratch. Either record may carry real data — gear,
 *     tickets, an RSVP, map placements — so deleting one loses work. Merge
 *     re-points everything onto the surviving membership, then deletes the
 *     stale one.
 *  2. **A guest who made their own account.** They were listed as a host's
 *     plus-one (a guest `attendee` row) and then registered independently, so
 *     they're counted twice on the roster. Merging their guest row into their
 *     own member `attendee` row keeps the tent spot / ticket / pass that was
 *     attached to the guest entry.
 *
 * Both reduce to the same primitive: re-point every row that references the
 * stale id at the survivor, then delete the stale row.
 *
 * The reference list is derived from the Drizzle schema's foreign keys rather
 * than hardcoded, so a table added later is covered without anyone remembering
 * to update this file. (It used to read `PRAGMA foreign_key_list`; the schema
 * says the same thing without a database round trip, on every host.
 * `merge-refs.test.ts` holds the two to agreement.)
 *
 * Every merge reads first, then writes everything in one `atomic` batch, so it
 * lands whole or not at all on Bun and on D1 alike.
 *
 * Ordering note: the sweep uses `UPDATE OR IGNORE`. Where a unique constraint
 * means both people already have the equivalent row (both signed up for the
 * same shift, both answered the same question), the stale row simply can't
 * move; it is left behind and cleaned up by the FK rules when the stale record
 * is deleted at the end. That deliberately leans on the ON DELETE rules
 * repaired in migration 0065 — before that migration this function could not
 * have worked either.
 */
import {
  and,
  eq,
  inArray,
  is,
  isNotNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { atomic, db } from "../../db/client.server";
import * as schema from "../../db/schema";
import {
  account,
  attendee,
  membership,
  passkey,
  prospect,
  user,
} from "../../db/schema";
import {
  type MergePicks,
  type MergePlan,
  type MergeSide,
  planMerge,
} from "./merge-plan";
import { statusProgress } from "./prospects";

type Ref = { table: string; column: string };

let refCache: Map<string, Ref[]> | null = null;

/** Every (table, column) in the schema with a foreign key pointing at `target`. */
export function referencesTo(target: string): Ref[] {
  if (!refCache) refCache = new Map();
  const hit = refCache.get(target);
  if (hit) return hit;

  const refs: Ref[] = [];
  for (const t of Object.values(schema)) {
    if (!is(t, SQLiteTable)) continue;
    const cfg = getTableConfig(t);
    for (const fk of cfg.foreignKeys) {
      const r = fk.reference();
      if (getTableConfig(r.foreignTable).name !== target) continue;
      for (const col of r.columns) {
        refs.push({ table: cfg.name, column: col.name });
      }
    }
  }
  refCache.set(target, refs);
  return refs;
}

const ident = (name: string) => sql.identifier(name);

/** How many rows each reference would move — drives the confirmation screen. */
async function countRefs(
  target: string,
  id: string,
  skip: Ref[] = [],
): Promise<{ table: string; column: string; rows: number }[]> {
  const refs = referencesTo(target).filter(
    (r) => !skip.some((s) => s.table === r.table && s.column === r.column),
  );
  const counted = await Promise.all(
    refs.map(async (r) => {
      const [row] = await db.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM ${ident(r.table)} WHERE ${ident(r.column)} = ${id}`,
      );
      return { ...r, rows: row?.n ?? 0 };
    }),
  );
  return counted.filter((r) => r.rows > 0);
}

export type MergePreview = {
  /** Per-table row counts that will be re-pointed onto the survivor. */
  moves: { table: string; column: string; rows: number }[];
  /** Total rows affected — 0 means the stale record carries nothing. */
  total: number;
};

/**
 * The writes that re-point every reference from `staleId` to `survivorId` for
 * one target table, without deleting anything. Rows blocked by a unique
 * constraint stay put.
 */
function repoint(
  target: string,
  survivorId: string,
  staleId: string,
  skip: Ref[] = [],
): SQL[] {
  return referencesTo(target)
    .filter(
      (r) => !skip.some((s) => s.table === r.table && s.column === r.column),
    )
    .map(
      (r) =>
        sql`UPDATE OR IGNORE ${ident(r.table)} SET ${ident(r.column)} = ${survivorId} WHERE ${ident(r.column)} = ${staleId}`,
    );
}

// `attendee` is reconciled per-edition before the generic sweep, so the sweep
// must not touch these two columns.
const ATTENDEE_MEMBERSHIP_COLS: Ref[] = [
  { table: "attendee", column: "membership_id" },
  { table: "attendee", column: "host_membership_id" },
];

/**
 * The writes that fold one attendee row into another: everything attached to
 * the stale body (tent spot, ticket, setup pass, speaking slot) moves to the
 * survivor, then the stale row is deleted.
 *
 * Used both when merging two memberships that each RSVP'd for the same year,
 * and when a guest turns out to already have their own account.
 */
export function mergeAttendeeRows(
  survivorAttendeeId: string,
  staleAttendeeId: string,
): SQL[] {
  if (survivorAttendeeId === staleAttendeeId) return [];
  return [
    ...repoint("attendee", survivorAttendeeId, staleAttendeeId),
    sql`DELETE FROM attendee WHERE id = ${staleAttendeeId}`,
  ];
}

/** Everything a merge decision needs about one member, in one round trip. */
async function loadMergeSide(
  campId: string,
  membershipId: string,
): Promise<MergeSide> {
  const [row] = await db
    .select({ m: membership, u: user })
    .from(membership)
    .innerJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(membership.id, membershipId),
        eq(membership.organizationId, campId),
      ),
    )
    .limit(1);
  // Scoped to the camp, so an id belonging to another camp reads as missing
  // rather than as something this camp's officers may act on.
  if (!row) throw new Error("That member is not in this camp.");

  const accounts = await db
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, row.u.id));
  const passkeys = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, row.u.id));

  return {
    membershipId: row.m.id,
    userId: row.u.id,
    role: row.m.role,
    status: row.m.status,
    playaName: row.m.playaName,
    invitedByMembershipId: row.m.invitedByMembershipId,
    viaInviteId: row.m.viaInviteId,
    wizardStep: row.m.wizardStep,
    wizardCompletedAt: row.m.wizardCompletedAt?.getTime() ?? null,
    joinedAt: row.m.joinedAt.getTime(),
    createdAt: row.m.createdAt.getTime(),
    userName: row.u.name,
    userEmail: row.u.email,
    userImage: row.u.image,
    userEmailVerified: row.u.emailVerified,
    userCreatedAt: row.u.createdAt.getTime(),
    hasPassword: accounts.some((a) => a.providerId === "credential"),
    passkeyCount: passkeys.length,
    socialProviders: accounts
      .map((a) => a.providerId)
      .filter((p) => p !== "credential"),
  };
}

export type MergeOutcome = MergePreview & { plan: MergePlan };

/**
 * What merging these two would produce. Read-only, and — like the merge itself
 * — independent of which one was passed first.
 */
export async function planMemberMerge(
  campId: string,
  idA: string,
  idB: string,
  picks: MergePicks = {},
): Promise<MergeOutcome> {
  if (idA === idB) throw new Error("Pick two different members to merge.");
  const [a, b] = await Promise.all([
    loadMergeSide(campId, idA),
    loadMergeSide(campId, idB),
  ]);
  const plan = planMerge(a, b, picks);

  // Both halves of the person are being absorbed: the membership row and, when
  // the two accounts differ, the account behind it.
  //
  // Sessions are excluded because they are *deleted*, not moved — counting them
  // as "records that will be brought together" reads as a promise to keep them,
  // which is the opposite of what happens (see `foldUser`).
  const moves = [
    ...(await countRefs("membership", plan.staleId)),
    ...(plan.sameUser
      ? []
      : await countRefs("user", plan.staleUserId, [
          { table: "session", column: "user_id" },
        ])),
  ];
  return { plan, moves, total: moves.reduce((n, m) => n + m.rows, 0) };
}

/**
 * Merge two duplicate members into one. Atomic: either the whole thing lands or
 * nothing does.
 *
 * **Order-independent.** `mergeMembers(camp, a, b)` and `mergeMembers(camp, b,
 * a)` produce the same camp, the same person and the same working logins — see
 * `merge-plan.ts` for how each field is settled, and `plans/merge-symmetric.md`
 * for why that matters (an officer cannot know which duplicate is "the real
 * one", and the old UI made them guess).
 *
 * Both accounts' credentials end up on the surviving user, so whichever passkey
 * / password / Discord login the person actually holds keeps working. Sessions
 * are dropped on both sides: a merge is an identity event, and they sign in
 * once more with whatever they have.
 */
export async function mergeMembers(
  campId: string,
  idA: string,
  idB: string,
  picks: MergePicks = {},
): Promise<MergeOutcome> {
  const outcome = await planMemberMerge(campId, idA, idB, picks);
  const { plan } = outcome;
  const { survivorId, staleId } = plan;

  // Both attendee rows for the same year must become one body, or the roster
  // would still double-count after the merge.
  const staleAttendees = await db
    .select({ id: attendee.id, editionId: attendee.editionId })
    .from(attendee)
    .where(eq(attendee.membershipId, staleId));
  const survivorAttendees = await db
    .select({ id: attendee.id, editionId: attendee.editionId })
    .from(attendee)
    .where(eq(attendee.membershipId, survivorId));

  const writes: SQL[] = [];
  for (const sa of staleAttendees) {
    const twin = survivorAttendees.find((a) => a.editionId === sa.editionId);
    if (twin) {
      writes.push(...mergeAttendeeRows(twin.id, sa.id));
    } else {
      // Survivor wasn't on the roster that year — adopt the duplicate's row.
      writes.push(
        sql`UPDATE attendee SET membership_id = ${survivorId}, host_membership_id = NULL WHERE id = ${sa.id}`,
      );
    }
  }
  // Guests the duplicate was hosting become the survivor's guests.
  writes.push(
    sql`UPDATE attendee SET host_membership_id = ${survivorId} WHERE host_membership_id = ${staleId}`,
  );

  writes.push(
    ...repoint("membership", survivorId, staleId, ATTENDEE_MEMBERSHIP_COLS),
  );

  // The resolved person, written as one row.
  const m = plan.membership;
  writes.push(
    sql`UPDATE membership SET role = ${m.role}, status = ${m.status},
         playa_name = ${m.playaName},
         invited_by_membership_id = ${m.invitedByMembershipId},
         via_invite_id = ${m.viaInviteId}, wizard_step = ${m.wizardStep},
         wizard_completed_at = ${m.wizardCompletedAt},
         joined_at = ${m.joinedAt}, created_at = ${m.createdAt}
       WHERE id = ${survivorId}`,
  );

  // A membership can't point at itself as its own inviter, which the fill
  // rule above can produce when one duplicate invited the other.
  writes.push(
    sql`UPDATE membership SET invited_by_membership_id = NULL WHERE id = ${survivorId} AND invited_by_membership_id = ${survivorId}`,
  );

  // Anything that couldn't move was a true duplicate of a row the survivor
  // already had; the ON DELETE rules clear it as the stale record goes.
  writes.push(sql`DELETE FROM membership WHERE id = ${staleId}`);

  if (!plan.sameUser) writes.push(...foldUser(plan));
  await atomic(writes);

  return outcome;
}

/**
 * The writes that fold the duplicate's account into the survivor's, as part
 * of the merge's batch.
 *
 * Deliberately NOT scoped to the merging camp: the two accounts are one human,
 * so memberships they hold in *other* camps move too. Half-moving a person
 * between camps would be worse than not moving them — and if that leaves some
 * other camp holding two memberships for one account, that camp has an ordinary
 * duplicate to merge, which is not this camp's business.
 */
function foldUser(plan: MergePlan): SQL[] {
  const { survivorUserId, staleUserId } = plan;
  const writes: SQL[] = [];

  // Every session on both sides dies. `revokeOtherSessions` reasoning from
  // plans/password-recovery.md applies: a credential change is an identity
  // event, and the tokens predate the person this account now represents.
  writes.push(
    sql`DELETE FROM session WHERE user_id IN (${survivorUserId}, ${staleUserId})`,
  );

  // better-auth's password paths assume at most one `credential` account per
  // user, so a second one can't simply be moved across. The survivor's wins and
  // the other is dropped — the preview says so out loud, because "my other
  // password stopped working" is precisely the surprise this feature exists to
  // prevent.
  if (plan.droppedPassword) {
    writes.push(
      sql`DELETE FROM account WHERE user_id = ${staleUserId} AND provider_id = 'credential'`,
    );
  }

  // Passkeys, social logins, authored rows, and memberships in other camps all
  // follow the same sweep that moves everything else in this file.
  writes.push(...repoint("user", survivorUserId, staleUserId));

  const u = plan.user;
  writes.push(
    sql`UPDATE user SET name = ${u.name}, email = ${u.email}, image = ${u.image},
         email_verified = ${u.emailVerified ? 1 : 0}, updated_at = ${Date.now()}
       WHERE id = ${survivorUserId}`,
  );

  // Keep the address that stopped being primary findable. Bookkeeping only —
  // nothing in the sign-in path reads it (plans/merge-symmetric.md decision 2).
  if (plan.aliasEmail) {
    writes.push(
      sql`INSERT OR IGNORE INTO user_email_alias (id, user_id, email, reason, created_at)
       VALUES (${crypto.randomUUID()}, ${survivorUserId}, ${plan.aliasEmail}, 'merge', ${Date.now()})`,
    );
  }

  writes.push(sql`DELETE FROM user WHERE id = ${staleUserId}`);
  return writes;
}

/**
 * "That plus-one is me." Fold a guest `attendee` row into the member's own
 * attendee row for the same edition, so the roster stops counting them twice
 * while their tent spot / ticket / pass follow into their account.
 */
export async function claimGuestAsMember(
  campId: string,
  editionId: string,
  guestAttendeeId: string,
  membershipId: string,
): Promise<void> {
  const [guest] = await db
    .select({ id: attendee.id })
    .from(attendee)
    .where(
      and(
        eq(attendee.id, guestAttendeeId),
        eq(attendee.campId, campId),
        eq(attendee.editionId, editionId),
        isNotNull(attendee.hostMembershipId),
      ),
    )
    .limit(1);
  if (!guest) throw new Error("Guest not found.");

  const [own] = await db
    .select({ id: attendee.id })
    .from(attendee)
    .where(
      and(
        eq(attendee.membershipId, membershipId),
        eq(attendee.editionId, editionId),
        ne(attendee.id, guestAttendeeId),
      ),
    )
    .limit(1);

  await atomic(
    own
      ? mergeAttendeeRows(own.id, guestAttendeeId)
      : // No member row for this year yet — promote the guest row in place,
        // which keeps every reference pointing at it.
        [
          sql`UPDATE attendee SET membership_id = ${membershipId}, host_membership_id = NULL, name = NULL, email = NULL WHERE id = ${guestAttendeeId}`,
        ],
  );
}

/** What a prospect merge would move. Read-only. */
export async function previewProspectMerge(
  campId: string,
  survivorId: string,
  staleId: string,
): Promise<MergePreview> {
  await assertProspectsMergeable(campId, survivorId, staleId);
  const moves = await countRefs("prospect", staleId);
  return { moves, total: moves.reduce((n, m) => n + m.rows, 0) };
}

async function assertProspectsMergeable(
  campId: string,
  survivorId: string,
  staleId: string,
) {
  if (survivorId === staleId) {
    throw new Error("Pick two different prospects to merge.");
  }
  const rows = await db
    .select()
    .from(prospect)
    .where(
      and(
        eq(prospect.campId, campId),
        inArray(prospect.id, [survivorId, staleId]),
      ),
    );
  if (rows.length !== 2) throw new Error("Prospect not found.");
  return {
    survivor: rows.find((r) => r.id === survivorId) as (typeof rows)[number],
    stale: rows.find((r) => r.id === staleId) as (typeof rows)[number],
  };
}

/**
 * Fold one prospect into another — the "three officers each started a thread
 * with the same person" case, which is the normal outcome of a camp with more
 * than one recruiter and no shared record.
 *
 * The conversation log is the point, so nothing is dropped: both sides'
 * interactions and handles move onto the survivor and the whole history sorts
 * back together by when it actually happened. Scalar fields fill only where
 * the survivor is blank — never overwrite a live value — and the further-along
 * status wins, so merging a `lead` into a `talking` doesn't lose the fact that
 * someone is mid-conversation.
 */
export async function mergeProspects(
  campId: string,
  survivorId: string,
  staleId: string,
): Promise<MergePreview> {
  const { survivor, stale } = await assertProspectsMergeable(
    campId,
    survivorId,
    staleId,
  );
  const preview = await previewProspectMerge(campId, survivorId, staleId);

  // Only where the survivor has nothing.
  const fill: Record<string, unknown> = {};
  const fillIfBlank = (col: string, mine: unknown, theirs: unknown) => {
    if (!mine && theirs) fill[col] = theirs;
  };
  fillIfBlank("playa_name", survivor.playaName, stale.playaName);
  fillIfBlank("email", survivor.email, stale.email);
  fillIfBlank("phone", survivor.phone, stale.phone);
  fillIfBlank("membership_id", survivor.membershipId, stale.membershipId);
  fillIfBlank(
    "recruit_application_id",
    survivor.recruitApplicationId,
    stale.recruitApplicationId,
  );
  fillIfBlank(
    "owner_membership_id",
    survivor.ownerMembershipId,
    stale.ownerMembershipId,
  );
  // The sooner reminder wins: a merge must not push a follow-up further out.
  const survivorDue = survivor.nextFollowUpAt?.getTime();
  const staleDue = stale.nextFollowUpAt?.getTime();
  if (staleDue != null && (survivorDue == null || staleDue < survivorDue)) {
    fill.next_follow_up_at = staleDue;
  }
  // Notes are two people's writing about one person; keep both, attributed to
  // nothing in particular, rather than silently picking a winner.
  if (stale.notes?.trim()) {
    fill.notes = survivor.notes?.trim()
      ? `${survivor.notes.trim()}\n\n---\n\n${stale.notes.trim()}`
      : stale.notes;
  }
  if (statusProgress(stale.status) > statusProgress(survivor.status)) {
    fill.status = stale.status;
  }
  // The relationship started when the earlier of the two records started.
  if (stale.createdAt.getTime() < survivor.createdAt.getTime()) {
    fill.created_at = stale.createdAt.getTime();
  }

  // Handles carry a unique (prospect, kind, value), so UPDATE OR IGNORE
  // collapses ones both records held instead of failing the merge; the
  // leftovers cascade away with the stale row below.
  const writes = repoint("prospect", survivorId, staleId);

  const cols = Object.keys(fill);
  if (cols.length) {
    const sets = sql.join(
      cols.map((c) => sql`${ident(c)} = ${fill[c] as string | number}`),
      sql`, `,
    );
    writes.push(
      sql`UPDATE prospect SET ${sets}, updated_at = ${Date.now()} WHERE id = ${survivorId}`,
    );
  }

  writes.push(sql`DELETE FROM prospect WHERE id = ${staleId}`);
  await atomic(writes);

  return preview;
}
