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
import { wouldCycle } from "./forest";

export type GroupSummary = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  parentGroupId: string | null;
  memberIds: string[];
};

/** Read a group tree with `buildForest`/`wouldCycle` without restating this. */
export const GROUP_TREE = {
  idOf: (g: { id: string }) => g.id,
  parentOf: (g: { parentGroupId: string | null }) => g.parentGroupId,
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
    parentGroupId: g.parentGroupId,
    memberIds: byGroup.get(g.id) ?? [],
  }));
}

/**
 * Re-parent a group, or make it a root with `parentGroupId: null`.
 *
 * Refuses to build a loop. `wouldCycle` is the door; `buildForest`'s own guard
 * is the safety net for loops that already exist in the data — both are needed,
 * because a row can become its own ancestor without ever going through here.
 */
export async function setGroupParent(opts: {
  campId: string;
  groupId: string;
  parentGroupId: string | null;
}): Promise<void> {
  const groups = await db
    .select({ id: campGroup.id, parentGroupId: campGroup.parentGroupId })
    .from(campGroup)
    .where(eq(campGroup.campId, opts.campId));
  if (!groups.some((g) => g.id === opts.groupId)) {
    throw new Error("Group not found.");
  }
  if (opts.parentGroupId && !groups.some((g) => g.id === opts.parentGroupId)) {
    throw new Error("That parent group is not in this camp.");
  }
  if (wouldCycle(groups, opts.groupId, opts.parentGroupId, GROUP_TREE)) {
    throw new Error(
      "That would put a group inside itself. Pick a group that isn't already below this one.",
    );
  }
  await db
    .update(campGroup)
    .set({ parentGroupId: opts.parentGroupId })
    .where(
      and(eq(campGroup.id, opts.groupId), eq(campGroup.campId, opts.campId)),
    );
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
  parentGroupId?: string | null;
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
      // A brand-new group can't be its own ancestor, so no cycle check is
      // needed here — only `setGroupParent` can create that risk.
      parentGroupId: opts.parentGroupId || null,
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

  // Anything nested under the group being folded away moves under the survivor.
  // Without this the FK's SET NULL would quietly promote those subgroups to
  // roots — the members would survive but the shape of the tree would not.
  // Guarded so folding a parent INTO its own child can't make the child its own
  // parent.
  await db
    .update(campGroup)
    .set({
      parentGroupId: opts.survivorId,
    })
    .where(
      and(
        eq(campGroup.campId, opts.campId),
        eq(campGroup.parentGroupId, opts.staleId),
      ),
    );
  await db
    .update(campGroup)
    .set({ parentGroupId: null })
    .where(
      and(
        eq(campGroup.campId, opts.campId),
        eq(campGroup.id, opts.survivorId),
        eq(campGroup.parentGroupId, opts.survivorId),
      ),
    );

  await deleteGroup(opts.campId, opts.staleId);
}
