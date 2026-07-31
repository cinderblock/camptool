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
 * The reference list is derived at runtime from `PRAGMA foreign_key_list` over
 * every table rather than hardcoded, so a table added later is covered without
 * anyone remembering to update this file.
 *
 * Ordering note: the sweep uses `UPDATE OR IGNORE`. Where a unique constraint
 * means both people already have the equivalent row (both signed up for the
 * same shift, both answered the same question), the stale row simply can't
 * move; it is left behind and cleaned up by the FK rules when the stale record
 * is deleted at the end. That deliberately leans on the ON DELETE rules
 * repaired in migration 0065 — before that migration this function could not
 * have worked either.
 */
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db, sqlite } from "../../db/client.server";
import { attendee, membership } from "../../db/schema";

type Ref = { table: string; column: string };

let refCache: Map<string, Ref[]> | null = null;

/** Every (table, column) in the database with a foreign key pointing at `target`. */
function referencesTo(target: string): Ref[] {
  if (!refCache) refCache = new Map();
  const hit = refCache.get(target);
  if (hit) return hit;

  const tables = sqlite
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all();

  const refs: Ref[] = [];
  for (const { name } of tables) {
    const fks = sqlite
      .query<{ table: string; from: string }, []>(
        `PRAGMA foreign_key_list("${name}")`,
      )
      .all();
    for (const fk of fks) {
      if (fk.table === target) refs.push({ table: name, column: fk.from });
    }
  }
  refCache.set(target, refs);
  return refs;
}

/** How many rows each reference would move — drives the confirmation screen. */
function countRefs(
  target: string,
  id: string,
  skip: Ref[] = [],
): { table: string; column: string; rows: number }[] {
  return referencesTo(target)
    .filter(
      (r) => !skip.some((s) => s.table === r.table && s.column === r.column),
    )
    .map((r) => ({
      ...r,
      rows: (
        sqlite
          .query<{ n: number }, [string]>(
            `SELECT count(*) AS n FROM "${r.table}" WHERE "${r.column}" = ?`,
          )
          .get(id) ?? { n: 0 }
      ).n,
    }))
    .filter((r) => r.rows > 0);
}

export type MergePreview = {
  /** Per-table row counts that will be re-pointed onto the survivor. */
  moves: { table: string; column: string; rows: number }[];
  /** Total rows affected — 0 means the stale record carries nothing. */
  total: number;
};

/**
 * Re-point every reference from `staleId` to `survivorId` for one target table,
 * without deleting anything. Rows blocked by a unique constraint stay put.
 */
function repoint(
  target: string,
  survivorId: string,
  staleId: string,
  skip: Ref[] = [],
): void {
  for (const r of referencesTo(target)) {
    if (skip.some((s) => s.table === r.table && s.column === r.column))
      continue;
    sqlite.run(
      `UPDATE OR IGNORE "${r.table}" SET "${r.column}" = ? WHERE "${r.column}" = ?`,
      [survivorId, staleId],
    );
  }
}

// `attendee` is reconciled per-edition before the generic sweep, so the sweep
// must not touch these two columns.
const ATTENDEE_MEMBERSHIP_COLS: Ref[] = [
  { table: "attendee", column: "membership_id" },
  { table: "attendee", column: "host_membership_id" },
];

/**
 * Fold one attendee row into another: everything attached to the stale body
 * (tent spot, ticket, setup pass, speaking slot) moves to the survivor, then
 * the stale row is deleted.
 *
 * Used both when merging two memberships that each RSVP'd for the same year,
 * and when a guest turns out to already have their own account.
 */
export function mergeAttendeeRows(
  survivorAttendeeId: string,
  staleAttendeeId: string,
): void {
  if (survivorAttendeeId === staleAttendeeId) return;
  repoint("attendee", survivorAttendeeId, staleAttendeeId);
  sqlite.run("DELETE FROM attendee WHERE id = ?", [staleAttendeeId]);
}

/** What a membership merge would move. Read-only. */
export async function previewMembershipMerge(
  campId: string,
  survivorId: string,
  staleId: string,
): Promise<MergePreview> {
  await assertMergeable(campId, survivorId, staleId);
  const moves = countRefs("membership", staleId);
  return { moves, total: moves.reduce((n, m) => n + m.rows, 0) };
}

async function assertMergeable(
  campId: string,
  survivorId: string,
  staleId: string,
) {
  if (survivorId === staleId) {
    throw new Error("Pick two different members to merge.");
  }
  // Scoped to the camp so an id from another camp can never be reached.
  const rows = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.organizationId, campId),
        inArray(membership.id, [survivorId, staleId]),
      ),
    );
  const ids = new Set(rows.map((r) => r.id));
  if (!ids.has(survivorId)) {
    throw new Error("The surviving member is not in this camp.");
  }
  if (!ids.has(staleId)) {
    throw new Error("The duplicate member is not in this camp.");
  }
}

/**
 * Merge `staleId` into `survivorId`. Atomic: either the whole merge lands or
 * nothing does.
 *
 * The survivor keeps its own role and identity; only blank fields are filled in
 * from the duplicate, so merging never silently downgrades or renames anyone.
 */
export async function mergeMemberships(
  campId: string,
  survivorId: string,
  staleId: string,
): Promise<MergePreview> {
  const preview = await previewMembershipMerge(campId, survivorId, staleId);

  const [survivor] = await db
    .select()
    .from(membership)
    .where(eq(membership.id, survivorId))
    .limit(1);
  const [stale] = await db
    .select()
    .from(membership)
    .where(eq(membership.id, staleId))
    .limit(1);
  if (!survivor || !stale) throw new Error("Member not found.");

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

  const run = sqlite.transaction(() => {
    for (const sa of staleAttendees) {
      const twin = survivorAttendees.find((a) => a.editionId === sa.editionId);
      if (twin) {
        mergeAttendeeRows(twin.id, sa.id);
      } else {
        // Survivor wasn't on the roster that year — adopt the duplicate's row.
        sqlite.run(
          "UPDATE attendee SET membership_id = ?, host_membership_id = NULL WHERE id = ?",
          [survivorId, sa.id],
        );
      }
    }
    // Guests the duplicate was hosting become the survivor's guests.
    sqlite.run(
      "UPDATE attendee SET host_membership_id = ? WHERE host_membership_id = ?",
      [survivorId, staleId],
    );

    repoint("membership", survivorId, staleId, ATTENDEE_MEMBERSHIP_COLS);

    // Fill only what the survivor is missing; never overwrite live values.
    if (!survivor.playaName && stale.playaName) {
      sqlite.run("UPDATE membership SET playa_name = ? WHERE id = ?", [
        stale.playaName,
        survivorId,
      ]);
    }

    // Anything that couldn't move was a true duplicate of a row the survivor
    // already had; the ON DELETE rules clear it as the stale record goes.
    sqlite.run("DELETE FROM membership WHERE id = ?", [staleId]);
  });
  run();

  return preview;
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

  const run = sqlite.transaction(() => {
    if (own) {
      mergeAttendeeRows(own.id, guestAttendeeId);
    } else {
      // No member row for this year yet — promote the guest row in place, which
      // keeps every reference pointing at it.
      sqlite.run(
        "UPDATE attendee SET membership_id = ?, host_membership_id = NULL, name = NULL, email = NULL WHERE id = ?",
        [membershipId, guestAttendeeId],
      );
    }
  });
  run();
}
