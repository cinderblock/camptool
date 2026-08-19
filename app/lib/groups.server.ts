/**
 * Social groups — reads and writes (see `plans/social-groups.md`).
 *
 * Authorization here is deliberately loose: any member may create a group and
 * put people in it, officers may rename/merge/delete. Same reasoning as the
 * party link — a small, high-trust camp, and a group grants no authority over
 * anyone, so the cost of a wrong one is that somebody edits it.
 *
 * Nothing in this file may ever be consulted to decide whether someone MAY do
 * something. If that changes, it stopped being a social group.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campGroup, campGroupMember, membership, user } from "../../db/schema";

export type GroupSummary = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  memberIds: string[];
};

/** Every group in the camp with its roster of membership ids. */
export async function listGroups(campId: string): Promise<GroupSummary[]> {
  const groups = await db
    .select()
    .from(campGroup)
    .where(eq(campGroup.campId, campId))
    .orderBy(asc(campGroup.name));
  if (groups.length === 0) return [];

  const links = await db
    .select({
      groupId: campGroupMember.groupId,
      membershipId: campGroupMember.membershipId,
    })
    .from(campGroupMember)
    .where(eq(campGroupMember.campId, campId));

  const byGroup = new Map<string, string[]>();
  for (const l of links) {
    const list = byGroup.get(l.groupId);
    if (list) list.push(l.membershipId);
    else byGroup.set(l.groupId, [l.membershipId]);
  }

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    color: g.color,
    memberIds: byGroup.get(g.id) ?? [],
  }));
}

/** The invite-tree edges for a camp, in the shape `buildInviteTree` wants. */
export async function loadInviteEdges(campId: string) {
  return db
    .select({
      membershipId: membership.id,
      invitedByMembershipId: membership.invitedByMembershipId,
      name: user.name,
      playaName: membership.playaName,
      role: membership.role,
    })
    .from(membership)
    .innerJoin(user, eq(membership.userId, user.id))
    .where(eq(membership.organizationId, campId));
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A group needs a name.");
  if (name.length > 60) throw new Error("That name is too long (60 max).");
  return name;
}

export async function createGroup(opts: {
  campId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  createdByMembershipId: string;
  /** Seed the group with these memberships (ignored if not in the camp). */
  memberIds?: string[];
}): Promise<string> {
  const name = cleanName(opts.name);
  const id = crypto.randomUUID();
  try {
    await db.insert(campGroup).values({
      id,
      campId: opts.campId,
      name,
      description: opts.description?.trim() || null,
      color: opts.color || null,
      createdByMembershipId: opts.createdByMembershipId,
    });
  } catch (e) {
    // The unique index is on lower(name) — say what actually happened rather
    // than surfacing a constraint error.
    if (String(e).includes("UNIQUE")) {
      throw new Error(`This camp already has a group called "${name}".`);
    }
    throw e;
  }
  if (opts.memberIds?.length) {
    await addToGroup({
      campId: opts.campId,
      groupId: id,
      membershipIds: opts.memberIds,
      addedByMembershipId: opts.createdByMembershipId,
    });
  }
  return id;
}

export async function renameGroup(opts: {
  campId: string;
  groupId: string;
  name: string;
  description?: string | null;
  color?: string | null;
}): Promise<void> {
  const name = cleanName(opts.name);
  await db
    .update(campGroup)
    .set({
      name,
      description: opts.description?.trim() || null,
      color: opts.color || null,
    })
    .where(
      and(eq(campGroup.id, opts.groupId), eq(campGroup.campId, opts.campId)),
    );
}

export async function deleteGroup(campId: string, groupId: string) {
  await db
    .delete(campGroup)
    .where(and(eq(campGroup.id, groupId), eq(campGroup.campId, campId)));
}

/**
 * Add people to a group. Ids that aren't memberships of this camp are dropped
 * rather than rejected — the caller is usually handing over a subtree or a
 * multi-select, and one stale id shouldn't fail the whole action.
 */
export async function addToGroup(opts: {
  campId: string;
  groupId: string;
  membershipIds: string[];
  addedByMembershipId: string | null;
}): Promise<number> {
  if (opts.membershipIds.length === 0) return 0;

  const [group] = await db
    .select({ id: campGroup.id })
    .from(campGroup)
    .where(
      and(eq(campGroup.id, opts.groupId), eq(campGroup.campId, opts.campId)),
    )
    .limit(1);
  if (!group) throw new Error("Group not found.");

  const valid = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.organizationId, opts.campId),
        inArray(membership.id, opts.membershipIds),
      ),
    );
  if (valid.length === 0) return 0;

  const existing = await db
    .select({ membershipId: campGroupMember.membershipId })
    .from(campGroupMember)
    .where(eq(campGroupMember.groupId, opts.groupId));
  const already = new Set(existing.map((e) => e.membershipId));

  const rows = valid
    .filter((v) => !already.has(v.id))
    .map((v) => ({
      id: crypto.randomUUID(),
      campId: opts.campId,
      groupId: opts.groupId,
      membershipId: v.id,
      addedByMembershipId: opts.addedByMembershipId,
    }));
  if (rows.length === 0) return 0;
  await db.insert(campGroupMember).values(rows);
  return rows.length;
}

export async function removeFromGroup(opts: {
  campId: string;
  groupId: string;
  membershipId: string;
}): Promise<void> {
  await db
    .delete(campGroupMember)
    .where(
      and(
        eq(campGroupMember.campId, opts.campId),
        eq(campGroupMember.groupId, opts.groupId),
        eq(campGroupMember.membershipId, opts.membershipId),
      ),
    );
}

/**
 * Fold one group into another: everyone in `staleId` joins `survivorId`, then
 * the empty group goes. Officer tidy-up for the inevitable "Fire Crew" and
 * "fire crew 2026".
 */
export async function mergeGroups(opts: {
  campId: string;
  survivorId: string;
  staleId: string;
}): Promise<void> {
  if (opts.survivorId === opts.staleId) {
    throw new Error("Pick two different groups.");
  }
  const members = await db
    .select({ membershipId: campGroupMember.membershipId })
    .from(campGroupMember)
    .where(
      and(
        eq(campGroupMember.campId, opts.campId),
        eq(campGroupMember.groupId, opts.staleId),
      ),
    );
  await addToGroup({
    campId: opts.campId,
    groupId: opts.survivorId,
    membershipIds: members.map((m) => m.membershipId),
    addedByMembershipId: null,
  });
  await deleteGroup(opts.campId, opts.staleId);
}
