import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Modal,
  MultiSelect,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, data, useFetcher } from "react-router";
import { auth } from "~/lib/auth.server";
import { syncDiscordLinksForCamp } from "~/lib/discord.server";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState } from "~/lib/features.server";
import {
  type TreeNode,
  buildForest,
  flattenForest,
  subtreeOf,
} from "~/lib/forest";
import {
  addToGroup,
  createGroup,
  deleteGroup,
  listGroups,
  loadInviteEdges,
  mergeGroups,
  removeFromGroup,
  renameGroup,
  setGroupParent,
} from "~/lib/groups.server";
import { buildInviteTree, subtreeIds } from "~/lib/invite-tree";
import type { MergePicks } from "~/lib/merge-plan";
import {
  type MergeOutcome,
  mergeMembers,
  planMemberMerge,
} from "~/lib/merge.server";
import { issuePasswordReset } from "~/lib/password-reset.server";
import {
  ROLES,
  type Role,
  hasAtLeast,
  isRole,
  rankOf,
} from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  account,
  campInvite,
  memberFlag,
  membership,
  passkey,
  prospect,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/members";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Members · CampTool" }];
}

const ROLE_COLOR: Record<Role, string> = {
  admin: "red",
  officer: "orange",
  member: "blue",
  recruit: "gray",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { user: actor, active, privacy } = await requireActiveCamp(request);
  const campId = active.camp.id;
  const actorRole = active.membership.role;

  const rows = await db
    .select({
      memberId: membership.id,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
      playaName: membership.playaName,
      joinedAt: membership.joinedAt,
      invitedByMembershipId: membership.invitedByMembershipId,
      viaInviteId: membership.viaInviteId,
      name: user.name,
      email: user.email,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));

  const discord = await syncDiscordLinksForCamp(campId);

  const canManage = hasAtLeast(actorRole, "officer");

  // Which credentials each member actually holds. Officers only — it's the
  // thing you need in order to answer "why can't they sign in", and it doubles
  // as the passkey adoption column (plans/passkey-first-auth.md step 8).
  const userIds = rows.map((r) => r.userId);
  const withPasskey = new Set<string>();
  const withPassword = new Set<string>();
  if (canManage && userIds.length) {
    for (const r of await db
      .select({ userId: passkey.userId })
      .from(passkey)
      .where(inArray(passkey.userId, userIds))) {
      withPasskey.add(r.userId);
    }
    for (const r of await db
      .select({ userId: account.userId })
      .from(account)
      .where(
        and(
          inArray(account.userId, userIds),
          eq(account.providerId, "credential"),
        ),
      )) {
      withPassword.add(r.userId);
    }
  }

  // Who invited whom. The edge has been recorded on every redemption since
  // invites shipped but was never shown anywhere. A member with no *named*
  // inviter may still have come through an open camp link, which records the
  // door but no person — so fall back to naming the door rather than "—".
  const nameOf = new Map(rows.map((r) => [r.memberId, r.name]));
  const inviteIds = [
    ...new Set(rows.flatMap((r) => (r.viaInviteId ? [r.viaInviteId] : []))),
  ];
  const inviteLabel = new Map<string, string>();
  if (inviteIds.length) {
    for (const inv of await db
      .select({
        id: campInvite.id,
        kind: campInvite.kind,
        note: campInvite.note,
      })
      .from(campInvite)
      .where(
        and(eq(campInvite.campId, campId), inArray(campInvite.id, inviteIds)),
      )) {
      inviteLabel.set(
        inv.id,
        inv.note?.trim() ||
          (inv.kind === "open" ? "an open camp link" : "an invite link"),
      );
    }
  }

  // Whose Prospects thread points at them. The locked decision is that the
  // conversation log FOLLOWS the person past joining (plans/prospects-crm.md),
  // which is only true if there's a way back to it once they're a member —
  // this is that way. Officers only, and only when the feature is on for them.
  const prospectOf = new Map<string, string>();
  if (canManage) {
    const state = await getFeatureState(campId, "prospects");
    if (featureVisibleTo(state, actorRole)) {
      for (const p of await db
        .select({ id: prospect.id, membershipId: prospect.membershipId })
        .from(prospect)
        .where(
          and(eq(prospect.campId, campId), isNotNull(prospect.membershipId)),
        )) {
        if (p.membershipId) prospectOf.set(p.membershipId, p.id);
      }
    }
  }

  const members = rows
    .map(({ invitedByMembershipId, viaInviteId, ...r }) => ({
      ...r,
      // Kept, not just resolved to a name: the invite TREE needs the edge, and
      // a name can't be walked (plans/social-groups.md).
      invitedByMembershipId,
      prospectId: prospectOf.get(r.memberId) ?? null,
      joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
      discord: discord.get(r.userId) ?? null,
      hasPasskey: withPasskey.has(r.userId),
      hasPassword: withPassword.has(r.userId),
      // The inviter's name when there is one; otherwise the link they came
      // through. Both null = founder, officer-added, or a public application.
      invitedByName: invitedByMembershipId
        ? (nameOf.get(invitedByMembershipId) ?? "Former member")
        : null,
      invitedVia:
        !invitedByMembershipId && viaInviteId
          ? (inviteLabel.get(viaInviteId) ?? null)
          : null,
    }))
    .sort(
      (a, b) => rankOf(b.role) - rankOf(a.role) || a.name.localeCompare(b.name),
    );

  // Recruits can't flag; members and up can quietly raise a concern.
  const canFlag = hasAtLeast(actorRole, "member");
  const assignableRoles = ROLES.filter((r) => rankOf(r) <= rankOf(actorRole));

  // Open flags. Names resolve via the roster already loaded above; a null
  // reporter means they've since left the camp.
  const myMid = active.membership.id;
  const flagRows = await db
    .select()
    .from(memberFlag)
    .where(and(eq(memberFlag.campId, campId), eq(memberFlag.status, "open")));
  const toView = (f: (typeof flagRows)[number]) => ({
    id: f.id,
    subjectMembershipId: f.subjectMembershipId,
    subjectName: nameOf.get(f.subjectMembershipId) ?? "Former member",
    reporterName: f.reporterMembershipId
      ? (nameOf.get(f.reporterMembershipId) ?? "Former member")
      : "Former member",
    body: f.body,
    createdAt: f.createdAt.toISOString().slice(0, 10),
  });
  // Officers see every open flag EXCEPT ones about themselves — a flagged
  // officer must not see (or resolve) the concern raised about them.
  const officerFlags = canManage
    ? flagRows.filter((f) => f.subjectMembershipId !== myMid).map(toView)
    : [];
  const myFlags = canFlag
    ? flagRows.filter((f) => f.reporterMembershipId === myMid).map(toView)
    : [];

  // Social groups. Descriptive only — nothing on this page consults them to
  // decide what anyone may do (plans/social-groups.md).
  const groupsVisible = featureVisibleTo(
    await getFeatureState(campId, "groups"),
    actorRole,
  );

  return redact(privacy, {
    campId,
    campName: active.camp.name,
    actorUserId: actor.id,
    actorRole,
    myMembershipId: myMid,
    canManage,
    canFlag,
    assignableRoles,
    members,
    officerFlags,
    myFlags,
    groupsVisible,
    groups: groupsVisible ? await listGroups(campId) : [],
    // "N of M enrolled", the cheap-to-delete adoption summary.
    passkeyEnrolled: canManage ? withPasskey.size : 0,
  });
}

/** Conflict answers come back as `pick.<field>`, holding the chosen value. */
function readMergePicks(form: FormData): MergePicks {
  const picks: MergePicks = {};
  for (const field of ["playaName", "userName"] as const) {
    const v = form.get(`pick.${field}`);
    if (typeof v === "string" && v) picks[field] = v;
  }
  return picks;
}

/**
 * Who may merge two members.
 *
 * Stricter than the old rule, and deliberately so. A merge now folds the two
 * accounts' credentials together, so "merge my record with an admin's" would
 * hand the actor an admin membership their own passkey opens. The actor must
 * therefore strictly outrank BOTH records and be neither of them — see
 * `plans/merge-symmetric.md`. A consequence worth knowing: two `admin`
 * duplicates can't be merged from here, because nobody outranks admin.
 *
 * Returns a response to send back, or null when the merge may proceed.
 */
async function assertCanMerge(
  campId: string,
  actorRole: string,
  actorUserId: string,
  idA: string,
  idB: string,
) {
  if (idA === idB) {
    return data(
      { error: "Pick two different members to merge." },
      { status: 400 },
    );
  }
  const rows = await db
    .select({
      id: membership.id,
      role: membership.role,
      userId: membership.userId,
    })
    .from(membership)
    .where(
      and(
        eq(membership.organizationId, campId),
        inArray(membership.id, [idA, idB]),
      ),
    );
  if (rows.length !== 2) {
    return data({ error: "Member not found." }, { status: 404 });
  }
  if (rows.some((r) => r.userId === actorUserId)) {
    return data(
      {
        error:
          "You can't merge your own account. Ask another officer who outranks both records.",
      },
      { status: 400 },
    );
  }
  if (rows.some((r) => rankOf(actorRole) <= rankOf(r.role))) {
    return data(
      { error: "You can only merge members ranked below you." },
      { status: 403 },
    );
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  const actorRole = active.membership.role;
  const myMid = active.membership.id;

  const form = await request.formData();
  const intent = form.get("intent");

  // --- Flagging (member+; everything below the officer wall) ---------------
  if (intent === "flagMember") {
    if (!hasAtLeast(actorRole, "member")) {
      return data({ error: "Members only." }, { status: 403 });
    }
    const memberId = String(form.get("memberId"));
    const body = String(form.get("body") ?? "")
      .trim()
      .slice(0, 2000);
    if (!body) {
      return data({ error: "Describe the issue." }, { status: 400 });
    }
    const [subject] = await db
      .select({ id: membership.id, userId: membership.userId })
      .from(membership)
      .where(
        and(eq(membership.id, memberId), eq(membership.organizationId, campId)),
      );
    if (!subject) return data({ error: "Member not found." }, { status: 404 });
    if (subject.id === myMid) {
      return data({ error: "You can't flag yourself." }, { status: 400 });
    }
    await db.insert(memberFlag).values({
      id: crypto.randomUUID(),
      campId,
      subjectMembershipId: subject.id,
      reporterMembershipId: myMid,
      body,
    });
    return data({ ok: "Flag sent — officers will handle it privately." });
  }

  if (intent === "withdrawFlag") {
    await db
      .delete(memberFlag)
      .where(
        and(
          eq(memberFlag.id, String(form.get("id"))),
          eq(memberFlag.campId, campId),
          eq(memberFlag.reporterMembershipId, myMid),
          eq(memberFlag.status, "open"),
        ),
      );
    return data({ ok: "Flag withdrawn." });
  }

  // --- Officer-only ---------------------------------------------------------
  if (!hasAtLeast(actorRole, "officer")) {
    return data(
      { error: "You don't have permission to manage members." },
      {
        status: 403,
      },
    );
  }

  if (intent === "resolveFlag") {
    const id = String(form.get("id"));
    const [flag] = await db
      .select()
      .from(memberFlag)
      .where(and(eq(memberFlag.id, id), eq(memberFlag.campId, campId)));
    if (!flag) return data({ error: "Flag not found." }, { status: 404 });
    // A flagged officer never sees the flag about them; they can't resolve
    // it either.
    if (flag.subjectMembershipId === myMid) {
      return data({ error: "Flag not found." }, { status: 404 });
    }
    await db
      .update(memberFlag)
      .set({
        status: "resolved",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(eq(memberFlag.id, id));
    return data({ ok: "Flag resolved." });
  }

  if (intent === "updateRole") {
    const memberId = String(form.get("memberId"));
    const role = String(form.get("role"));
    if (!isRole(role)) return data({ error: "Invalid role." }, { status: 400 });

    const [target] = await db
      .select()
      .from(membership)
      .where(
        and(eq(membership.id, memberId), eq(membership.organizationId, campId)),
      );
    if (!target) return data({ error: "Member not found." }, { status: 404 });
    if (target.userId === actor.id) {
      return data(
        { error: "You can't change your own role." },
        { status: 400 },
      );
    }
    if (rankOf(actorRole) <= rankOf(target.role)) {
      return data(
        { error: "You can only manage members ranked below you." },
        { status: 403 },
      );
    }
    if (rankOf(role) > rankOf(actorRole)) {
      return data(
        { error: "You can't grant a role above your own." },
        { status: 403 },
      );
    }

    try {
      await auth.api.updateMemberRole({
        body: { memberId, role, organizationId: campId },
        headers: request.headers,
      });
    } catch {
      return data({ error: "Role update failed." }, { status: 500 });
    }
    return data({ ok: `Updated to ${role}.` });
  }

  if (intent === "addRecruit") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email) return data({ error: "Email is required." }, { status: 400 });

    const [u] = await db.select().from(user).where(eq(user.email, email));
    if (!u) {
      return data(
        { error: "No account with that email — ask them to sign up first." },
        { status: 404 },
      );
    }
    const [existing] = await db
      .select()
      .from(membership)
      .where(
        and(eq(membership.userId, u.id), eq(membership.organizationId, campId)),
      );
    if (existing) {
      return data({ error: "Already a member of this camp." }, { status: 409 });
    }

    try {
      await auth.api.addMember({
        body: { userId: u.id, organizationId: campId, role: "recruit" },
        headers: request.headers,
      });
    } catch {
      return data({ error: "Could not add recruit." }, { status: 500 });
    }
    return data({ ok: `Added ${u.name} as a recruit.` });
  }

  if (intent === "removeMember") {
    const memberId = String(form.get("memberId"));
    const [target] = await db
      .select()
      .from(membership)
      .where(
        and(eq(membership.id, memberId), eq(membership.organizationId, campId)),
      );
    if (!target) return data({ error: "Member not found." }, { status: 404 });
    if (target.userId === actor.id) {
      return data({ error: "You can't remove yourself." }, { status: 400 });
    }
    if (rankOf(actorRole) <= rankOf(target.role)) {
      return data(
        { error: "You can only remove members ranked below you." },
        { status: 403 },
      );
    }

    const [u] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, target.userId));
    // Direct delete rather than auth.api.removeMember: the better-auth ACL
    // grants member:delete only to admin, and the rank check above is the real
    // authorization (same pattern as invite redemption). FK cascades clear
    // their per-year rows; items they owned become communal (owner set null).
    try {
      await db.delete(membership).where(eq(membership.id, memberId));
    } catch (e) {
      // A rejected foreign key used to escape as an unhandled 500 with no clue
      // what was holding the row (see migration 0065). Never let that happen
      // silently again — and point at merge, which is usually what was wanted.
      console.error("removeMember failed", e);
      return data(
        {
          error:
            "Couldn't remove them — something in the camp still references this member. If this is a duplicate account, use Merge instead so their gear and tickets are kept.",
        },
        { status: 409 },
      );
    }
    return data({ ok: `Removed ${u?.name ?? "member"} from the camp.` });
  }

  if (intent === "mergeMembers") {
    const idA = String(form.get("idA"));
    const idB = String(form.get("idB"));
    const picks = readMergePicks(form);

    const guard = await assertCanMerge(campId, actorRole, actor.id, idA, idB);
    if (guard) return guard;

    try {
      const result = await mergeMembers(campId, idA, idB, picks);
      const moved =
        result.total === 0
          ? "The duplicate had nothing attached"
          : `Moved ${result.total} record${result.total === 1 ? "" : "s"}`;
      return data({
        ok: `Merged into one member. ${moved}; they can sign in with ${
          result.plan.signInMethods.join(", ") || "no stored credential"
        }.`,
      });
    } catch (e) {
      console.error("mergeMembers failed", e);
      return data(
        { error: e instanceof Error ? e.message : "Merge failed." },
        { status: 400 },
      );
    }
  }

  if (intent === "issuePasswordReset") {
    const memberId = String(form.get("memberId"));
    const [target] = await db
      .select()
      .from(membership)
      .where(
        and(eq(membership.id, memberId), eq(membership.organizationId, campId)),
      );
    if (!target) return data({ error: "Member not found." }, { status: 404 });
    // Same rank rule as removal and impersonation. An officer who could mint a
    // reset link for an admin could take the camp over — see
    // plans/password-recovery.md "Things not to do".
    if (rankOf(actorRole) <= rankOf(target.role)) {
      return data(
        { error: "You can only issue reset links for members below you." },
        { status: 403 },
      );
    }

    const [u] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, target.userId));
    const { url, expires } = await issuePasswordReset({
      campId,
      userId: target.userId,
      issuedByMembershipId: myMid,
    });
    return data({
      resetLink: { url, expires, name: u?.name ?? "this member" },
    });
  }

  if (intent === "previewMerge") {
    const idA = String(form.get("idA"));
    const idB = String(form.get("idB"));
    const guard = await assertCanMerge(campId, actorRole, actor.id, idA, idB);
    if (guard) return guard;
    try {
      const preview = await planMemberMerge(
        campId,
        idA,
        idB,
        readMergePicks(form),
      );
      return data({ preview });
    } catch (e) {
      return data(
        { error: e instanceof Error ? e.message : "Couldn't preview." },
        { status: 400 },
      );
    }
  }

  // — Social groups ----------------------------------------------------------
  // Any member may create a group and put people in it; officers tidy up
  // (rename, merge, delete). A group grants nobody anything, so the cost of a
  // wrong one is that somebody edits it — see plans/social-groups.md.
  if (typeof intent === "string" && intent.startsWith("group")) {
    const groupsOn = featureVisibleTo(
      await getFeatureState(campId, "groups"),
      actorRole,
    );
    if (!groupsOn) {
      return data(
        { error: "Social groups are off for this camp." },
        { status: 403 },
      );
    }
    const isOfficer = hasAtLeast(actorRole, "officer");
    const ids = form.getAll("membershipId").map(String).filter(Boolean);
    const groupId = String(form.get("groupId") ?? "");

    try {
      switch (intent) {
        case "groupCreate": {
          await createGroup({
            campId,
            name: String(form.get("name") ?? ""),
            description: String(form.get("description") ?? ""),
            color: String(form.get("color") ?? "") || null,
            parentGroupId: String(form.get("parentGroupId") ?? "") || null,
            createdByMembershipId: myMid,
            memberIds: ids,
          });
          return data({ ok: "Group created." });
        }
        case "groupReparent": {
          if (!isOfficer) {
            return data(
              { error: "Only officers can move a group." },
              { status: 403 },
            );
          }
          await setGroupParent({
            campId,
            groupId,
            parentGroupId: String(form.get("parentGroupId") ?? "") || null,
          });
          return data({ ok: "Moved." });
        }
        case "groupRename": {
          if (!isOfficer) {
            return data(
              { error: "Only officers can rename a group." },
              { status: 403 },
            );
          }
          await renameGroup({
            campId,
            groupId,
            name: String(form.get("name") ?? ""),
            description: String(form.get("description") ?? ""),
            color: String(form.get("color") ?? "") || null,
          });
          return data({ ok: "Group updated." });
        }
        case "groupDelete": {
          if (!isOfficer) {
            return data(
              { error: "Only officers can delete a group." },
              { status: 403 },
            );
          }
          await deleteGroup(campId, groupId);
          return data({ ok: "Group deleted. Nobody left the camp." });
        }
        case "groupMerge": {
          if (!isOfficer) {
            return data(
              { error: "Only officers can merge groups." },
              { status: 403 },
            );
          }
          await mergeGroups({
            campId,
            survivorId: groupId,
            staleId: String(form.get("staleGroupId") ?? ""),
          });
          return data({ ok: "Groups merged." });
        }
        case "groupAdd": {
          const n = await addToGroup({
            campId,
            groupId,
            membershipIds: ids,
            addedByMembershipId: myMid,
          });
          return data({
            ok:
              n === 0
                ? "Everyone picked was already in that group."
                : `Added ${n} ${n === 1 ? "person" : "people"}.`,
          });
        }
        case "groupRemove": {
          const [only] = ids;
          if (!only) return data({ error: "Nobody picked." }, { status: 400 });
          await removeFromGroup({ campId, groupId, membershipId: only });
          return data({ ok: "Removed from the group." });
        }
        case "groupFromSubtree": {
          // Provenance is a fact; a group is a judgement. This is the one place
          // the two meet, and a human presses the button.
          const rootId = String(form.get("rootId") ?? "");
          const edges = await loadInviteEdges(campId);
          await createGroup({
            campId,
            name: String(form.get("name") ?? ""),
            createdByMembershipId: myMid,
            memberIds: subtreeIds(edges, rootId),
          });
          return data({ ok: "Group created from the invite tree." });
        }
      }
    } catch (e) {
      return data(
        { error: e instanceof Error ? e.message : "Group action failed." },
        { status: 400 },
      );
    }
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

type LoadedMember = Awaited<ReturnType<typeof loader>>["members"][number];

type LoadedGroup = Awaited<ReturnType<typeof loader>>["groups"][number];

/**
 * Distinct people in a group and everything nested under it.
 *
 * Distinct matters: the same person can be in a parent and a child, or in two
 * sibling subgroups, and summing per-group counts would report more people than
 * the camp has. Only members still present in the list are counted, so a group
 * holding someone who has since left doesn't inflate the branch.
 */
function countUnder(
  node: TreeNode<LoadedGroup>,
  members: LoadedMember[],
): { total: number } {
  const present = new Set(members.map((m) => m.memberId));
  const seen = new Set<string>();
  const walk = (n: TreeNode<LoadedGroup>) => {
    for (const id of n.item.memberIds) if (present.has(id)) seen.add(id);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return { total: seen.size };
}

/** How the directory is nested: flat, by social group, or by who invited whom. */
type GroupBy = "none" | "group" | "inviter";

/**
 * One rendered line. Sections and people share a list so the table body stays a
 * single map — interleaving two arrays inside JSX is where this kind of view
 * usually goes wrong.
 */
type MemberRow =
  | {
      kind: "section";
      key: string;
      title: string;
      /** People filed directly in this group. */
      count: number;
      note: string | null;
      /** Depth in the group hierarchy. */
      depth: number;
      /** Distinct people in this group and everything under it. */
      subCount?: number;
      /** How many groups sit below this one. */
      subGroups?: number;
    }
  | {
      kind: "member";
      key: string;
      member: LoadedMember;
      depth: number;
      /** Show the "invited by the row above" marker. Tree view only. */
      arrow?: boolean;
      /** For the invite tree: how many people this person brought in, total. */
      subtreeCount?: number;
    };

export default function Members({ loaderData }: Route.ComponentProps) {
  const {
    members,
    canManage,
    canFlag,
    assignableRoles,
    actorUserId,
    actorRole,
    campId,
    officerFlags,
    myFlags,
    groups,
    groupsVisible,
    myMembershipId,
  } = loaderData;
  const roleFetcher = useFetcher<FetcherData>();
  const addFetcher = useFetcher<FetcherData>();
  const removeFetcher = useFetcher<FetcherData>();
  const flagFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [flagTarget, setFlagTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [flagBody, setFlagBody] = useState("");
  const mergeFetcher = useFetcher<FetcherData>();
  const previewFetcher = useFetcher<{
    preview?: MergeOutcome;
    error?: string;
  }>();
  const [mergeTarget, setMergeTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  // Conflict answers, keyed by field and holding the chosen VALUE — not a side.
  // Which record a value came from is exactly what the officer can't reason
  // about, so it never appears in this state.
  const [mergePicks, setMergePicks] = useState<MergePicks>({});
  const mergePreview = previewFetcher.data?.preview ?? null;
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [groupPanel, setGroupPanel] = useState(false);
  const groupFetcher = useFetcher<FetcherData>();

  // The issued link comes back in the response body rather than being stored:
  // we keep only its SHA-256 hash server-side, so THIS is the one moment the
  // officer can copy it. Reissuing is cheap if they lose it.
  const resetFetcher = useFetcher<{
    resetLink?: { url: string; expires: string; name: string };
    error?: string;
  }>();
  const resetLink = resetFetcher.data?.resetLink ?? null;
  const [dismissedLink, setDismissedLink] = useState<string | null>(null);

  // Show the person the two records become — what moves, which email stays
  // primary, what will still sign them in — before anyone commits. The server
  // resolves this, so the modal can't drift from what the merge will do.
  const requestPreview = (otherId: string | null, picks: MergePicks) => {
    if (!mergeTarget || !otherId) return;
    previewFetcher.submit(
      {
        intent: "previewMerge",
        idA: mergeTarget.memberId,
        idB: otherId,
        ...Object.fromEntries(
          Object.entries(picks).map(([k, v]) => [`pick.${k}`, v]),
        ),
      },
      { method: "post" },
    );
  };

  const pickOther = (otherId: string | null) => {
    setMergeInto(otherId);
    setMergePicks({});
    requestPreview(otherId, {});
  };

  const answerConflict = (field: keyof MergePicks, value: string) => {
    const next = { ...mergePicks, [field]: value };
    setMergePicks(next);
    requestPreview(mergeInto, next);
  };

  const closeMerge = () => {
    setMergeTarget(null);
    setMergeInto(null);
    setMergePicks({});
  };

  useFetcherNotifications(roleFetcher.data, roleFetcher.state);
  useFetcherNotifications(mergeFetcher.data, mergeFetcher.state, closeMerge);
  useFetcherNotifications(addFetcher.data, addFetcher.state, () =>
    addFormRef.current?.reset(),
  );
  useFetcherNotifications(removeFetcher.data, removeFetcher.state, () =>
    setRemoveTarget(null),
  );
  useFetcherNotifications(flagFetcher.data, flagFetcher.state, () => {
    setFlagTarget(null);
    setFlagBody("");
  });
  // Only surfaces failures (rank refusals); success opens the link modal.
  useFetcherNotifications(
    resetFetcher.data?.error ? { error: resetFetcher.data.error } : undefined,
    resetFetcher.state,
  );

  const roleOptions = assignableRoles.map((r) => ({ value: r, label: r }));
  const showActions = canManage || canFlag;
  const columnCount = 7 + (canManage ? 1 : 0) + (showActions ? 1 : 0);

  // How the list is nested. "None" is the flat directory this page has always
  // been; the other two are the ask (plans/social-groups.md).
  const displayRows = useMemo((): MemberRow[] => {
    if (groupBy === "group") {
      const rows: MemberRow[] = [];
      const grouped = new Set<string>();
      // Groups nest, so walk them as a tree: a section's depth is its depth in
      // the group hierarchy, and its people sit one level below it.
      const forest = buildForest(groups, {
        idOf: (g) => g.id,
        parentOf: (g) => g.parentGroupId,
        compare: (a, b) => a.name.localeCompare(b.name),
      });
      for (const node of flattenForest(forest)) {
        const g = node.item;
        // Filter the already-sorted member list rather than mapping the group's
        // ids, so every section is in the same rank-then-name order as the flat
        // view instead of in whatever order people were added.
        const ids = new Set(g.memberIds);
        const people = members.filter((m) => ids.has(m.memberId));
        for (const p of people) grouped.add(p.memberId);
        rows.push({
          kind: "section",
          key: `g:${g.id}`,
          title: g.name,
          count: people.length,
          note: g.description,
          depth: node.depth,
          // Nesting is structural, not membership: being in a subgroup does not
          // put you in its parent. So a parent shows its own count and, only
          // when it has children, what the whole branch adds up to.
          subCount: node.descendants
            ? countUnder(node, members).total
            : undefined,
          subGroups: node.descendants,
        });
        // Someone in two groups appears under both — that IS the shape of the
        // camp. The headcount above the table stays the honest total.
        for (const p of people) {
          rows.push({
            kind: "member",
            key: `g:${g.id}:${p.memberId}`,
            member: p,
            depth: node.depth + 1,
          });
        }
      }
      const rest = members.filter((m) => !grouped.has(m.memberId));
      if (rest.length) {
        rows.push({
          kind: "section",
          key: "g:none",
          title: "Not in a group",
          count: rest.length,
          note: null,
          depth: 0,
        });
        for (const p of rest) {
          rows.push({
            kind: "member",
            key: `g:none:${p.memberId}`,
            member: p,
            depth: 1,
          });
        }
      }
      return rows;
    }

    if (groupBy === "inviter") {
      const forest = buildInviteTree(
        members.map((m) => ({ ...m, membershipId: m.memberId })),
        (a, b) => a.name.localeCompare(b.name),
      );
      return flattenForest(forest).map(
        (n: TreeNode<(typeof members)[number] & { membershipId: string }>) => ({
          kind: "member" as const,
          key: `t:${n.item.memberId}`,
          member: n.item,
          depth: n.depth,
          // Only the tree earns the arrow: there it means "invited by the row
          // above". In a group section it would read the same way and be wrong,
          // so group rows indent without one.
          arrow: n.depth > 0,
          subtreeCount: n.descendants || undefined,
        }),
      );
    }

    return members.map((m) => ({
      kind: "member" as const,
      key: m.memberId,
      member: m,
      depth: 0,
    }));
  }, [members, groups, groupBy]);

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Stack gap={2}>
          <Title order={2}>Members</Title>
          {/* People clicked the wrong one of these two pages during a camp
              meeting, so each says what it is and points at the other. */}
          <Text size="sm" c="dimmed">
            Everyone associated with the camp, carried over year to year. Use
            this to change roles or remove someone.{" "}
            <Anchor component={Link} to="/roster" size="sm">
              Looking for who's actually coming this year?
            </Anchor>
          </Text>
        </Stack>

        {canManage ? (
          <Card withBorder padding="md" radius="md">
            <addFetcher.Form method="post" ref={addFormRef}>
              <input type="hidden" name="intent" value="addRecruit" />
              <Group align="flex-end">
                <TextInput
                  name="email"
                  type="email"
                  label="Add a recruit by email"
                  placeholder="person@example.com"
                  w={{ base: "100%", xs: 320 }}
                  required
                />
                <Button type="submit" loading={addFetcher.state !== "idle"}>
                  Add recruit
                </Button>
              </Group>
            </addFetcher.Form>
          </Card>
        ) : null}

        {canManage && officerFlags.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} mb="xs">
              Flagged concerns · {officerFlags.length}
            </Text>
            <Text size="sm" c="dimmed" mb="sm">
              Raised privately by campers — visible to officers only. Handle
              them discreetly.
            </Text>
            <Stack gap="sm">
              {officerFlags.map((f) => (
                <Group
                  key={f.id}
                  justify="space-between"
                  wrap="nowrap"
                  align="flex-start"
                >
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500}>
                      {f.subjectName}
                      <Text span size="xs" c="dimmed">
                        {" "}
                        — flagged by {f.reporterName} · {f.createdAt}
                      </Text>
                    </Text>
                    <Text size="sm">“{f.body}”</Text>
                  </div>
                  <Button
                    size="compact-xs"
                    variant="light"
                    onClick={() =>
                      flagFetcher.submit(
                        { intent: "resolveFlag", id: f.id },
                        { method: "post" },
                      )
                    }
                  >
                    Resolve
                  </Button>
                </Group>
              ))}
            </Stack>
          </Card>
        ) : null}

        {myFlags.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} mb="xs">
              Your open flags
            </Text>
            <Stack gap="xs">
              {myFlags.map((f) => (
                <Group key={f.id} justify="space-between" wrap="nowrap">
                  <Text size="sm">
                    {f.subjectName}: “{f.body}”
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() =>
                      flagFetcher.submit(
                        { intent: "withdrawFlag", id: f.id },
                        { method: "post" },
                      )
                    }
                  >
                    Withdraw
                  </Button>
                </Group>
              ))}
            </Stack>
          </Card>
        ) : null}

        {groupsVisible ? (
          <>
            <GroupsBar
              groups={groups}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              canManage={canManage}
              onManage={() => setGroupPanel(true)}
            />
            <GroupsPanel
              opened={groupPanel}
              onClose={() => setGroupPanel(false)}
              groups={groups}
              members={members}
              canManage={canManage}
              myMembershipId={myMembershipId}
              fetcher={groupFetcher}
            />
          </>
        ) : null}

        <Table.ScrollContainer minWidth={820}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Playa name</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th>Discord</Table.Th>
                <Table.Th>Invited by</Table.Th>
                {canManage ? <Table.Th>Sign-in</Table.Th> : null}
                <Table.Th>Status</Table.Th>
                <Table.Th>Role</Table.Th>
                {showActions ? <Table.Th>Actions</Table.Th> : null}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {displayRows.map((row) => {
                if (row.kind === "section") {
                  return (
                    <Table.Tr
                      key={row.key}
                      bg="var(--mantine-color-default-hover)"
                    >
                      <Table.Td
                        colSpan={columnCount}
                        style={{ paddingLeft: 12 + row.depth * 22 }}
                      >
                        <Group gap="xs">
                          {row.depth > 0 ? (
                            <Text span c="dimmed" size="xs">
                              └
                            </Text>
                          ) : null}
                          <Text fw={600} size="sm">
                            {row.title}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {row.count} {row.count === 1 ? "person" : "people"}
                          </Text>
                          {/* Only when it has subgroups, and only when the
                              branch total differs — otherwise it's noise that
                              restates the number beside it. */}
                          {row.subGroups && row.subCount !== row.count ? (
                            <Text size="xs" c="dimmed">
                              · {row.subCount} with subgroups
                            </Text>
                          ) : null}
                          {row.note ? (
                            <Text size="xs" c="dimmed">
                              · {row.note}
                            </Text>
                          ) : null}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                }
                const m = row.member;
                const isSelf = m.userId === actorUserId;
                const editable =
                  canManage && !isSelf && rankOf(actorRole) > rankOf(m.role);
                return (
                  <Table.Tr key={row.key}>
                    <Table.Td style={{ paddingLeft: 12 + row.depth * 22 }}>
                      {row.arrow ? (
                        <Text span c="dimmed" size="xs" mr={4}>
                          ↳
                        </Text>
                      ) : null}
                      {m.name}
                      {isSelf ? (
                        <Text span c="dimmed" size="xs">
                          {" "}
                          (you)
                        </Text>
                      ) : null}
                      {row.subtreeCount ? (
                        <>
                          <Text span c="dimmed" size="xs">
                            {" "}
                            · brought {row.subtreeCount}
                          </Text>
                          {groupsVisible ? (
                            // Provenance is a fact, a group is a judgement —
                            // this is the one place they meet, and a human
                            // presses the button.
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              ml={6}
                              onClick={() =>
                                groupFetcher.submit(
                                  {
                                    intent: "groupFromSubtree",
                                    rootId: m.memberId,
                                    // "People", not "crew": these are the
                                    // friends and family somebody brought in,
                                    // not a work detail.
                                    name: `${m.name}'s people`,
                                  },
                                  { method: "post" },
                                )
                              }
                            >
                              Make a group
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </Table.Td>
                    <Table.Td>{m.playaName ?? "—"}</Table.Td>
                    <Table.Td>{m.email}</Table.Td>
                    <Table.Td>
                      {m.discord ? (
                        <Text size="sm">
                          {m.discord.discordUsername ?? m.discord.discordUserId}
                          {m.discord.inGuild ? (
                            <Badge
                              ml={6}
                              size="xs"
                              color="green"
                              variant="light"
                            >
                              in server
                            </Badge>
                          ) : null}
                        </Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          Not linked
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {m.invitedByName ? (
                        <Text size="sm">{m.invitedByName}</Text>
                      ) : m.invitedVia ? (
                        // An open camp link records the door but nobody's name.
                        <Text size="sm" c="dimmed">
                          via {m.invitedVia}
                        </Text>
                      ) : m.prospectId ? null : (
                        <Text size="sm" c="dimmed">
                          —
                        </Text>
                      )}
                      {/* The conversation that produced them, when the camp was
                          tracking it before they joined. This is what makes the
                          "log follows the person" decision actually true. */}
                      {m.prospectId ? (
                        <Anchor
                          component={Link}
                          to={`/prospects/${m.prospectId}`}
                          size="xs"
                          display="block"
                        >
                          Recruiting history
                        </Anchor>
                      ) : null}
                    </Table.Td>
                    {/* Plain Text, not Badge: Mantine's Badge label is
                        overflow:hidden + ellipsis, so in a column this narrow
                        both badges collapse to unreadable slivers ("N…", "PA…")
                        no matter what nowrap you put on the cell. */}
                    {canManage ? (
                      <Table.Td style={{ whiteSpace: "nowrap" }}>
                        <Text size="xs" c={m.hasPasskey ? "green" : "dimmed"}>
                          {m.hasPasskey ? "passkey" : "no passkey"}
                        </Text>
                        {m.hasPassword ? (
                          <Text size="xs" c="dimmed">
                            password
                          </Text>
                        ) : null}
                      </Table.Td>
                    ) : null}
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {m.status}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {editable ? (
                        <Select
                          size="xs"
                          w={130}
                          value={m.role}
                          data={roleOptions}
                          allowDeselect={false}
                          disabled={roleFetcher.state !== "idle"}
                          onChange={(value) => {
                            if (!value || value === m.role) return;
                            roleFetcher.submit(
                              {
                                intent: "updateRole",
                                memberId: m.memberId,
                                role: value,
                              },
                              { method: "post" },
                            );
                          }}
                        />
                      ) : (
                        <Badge
                          color={ROLE_COLOR[m.role as Role] ?? "gray"}
                          variant="light"
                        >
                          {m.role}
                        </Badge>
                      )}
                    </Table.Td>
                    {showActions ? (
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          {editable ? (
                            <>
                              <Form method="post" action="/impersonate">
                                <input
                                  type="hidden"
                                  name="intent"
                                  value="start"
                                />
                                <input
                                  type="hidden"
                                  name="targetUserId"
                                  value={m.userId}
                                />
                                <input
                                  type="hidden"
                                  name="campId"
                                  value={campId}
                                />
                                <Button
                                  type="submit"
                                  size="xs"
                                  variant="light"
                                  color="grape"
                                >
                                  Work as
                                </Button>
                              </Form>
                              <Button
                                size="xs"
                                variant="light"
                                color="blue"
                                loading={
                                  resetFetcher.state !== "idle" &&
                                  resetFetcher.formData?.get("memberId") ===
                                    m.memberId
                                }
                                onClick={() =>
                                  resetFetcher.submit(
                                    {
                                      intent: "issuePasswordReset",
                                      memberId: m.memberId,
                                    },
                                    { method: "post" },
                                  )
                                }
                              >
                                Recovery link
                              </Button>
                              <Button
                                size="xs"
                                variant="subtle"
                                color="red"
                                onClick={() =>
                                  setRemoveTarget({
                                    memberId: m.memberId,
                                    name: m.name,
                                  })
                                }
                              >
                                Remove
                              </Button>
                              <Button
                                size="xs"
                                variant="subtle"
                                color="orange"
                                onClick={() =>
                                  setMergeTarget({
                                    memberId: m.memberId,
                                    name: m.name,
                                  })
                                }
                              >
                                Merge
                              </Button>
                            </>
                          ) : null}
                          {canFlag && !isSelf ? (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="gray"
                              onClick={() =>
                                setFlagTarget({
                                  memberId: m.memberId,
                                  name: m.name,
                                })
                              }
                            >
                              Flag
                            </Button>
                          ) : null}
                        </Group>
                      </Table.Td>
                    ) : null}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>

        <Modal
          opened={removeTarget !== null}
          onClose={() => setRemoveTarget(null)}
          title={`Remove ${removeTarget?.name ?? "member"} from the camp?`}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              This removes them from the camp and deletes their camp data for
              all years — RSVPs, questionnaire answers, passes, and ticket
              requests. Items they declared stay on the map as camp items. Their
              account itself is not deleted, and they can be re-added or
              re-invited later.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setRemoveTarget(null)}>
                Cancel
              </Button>
              <Button
                color="red"
                loading={removeFetcher.state !== "idle"}
                onClick={() => {
                  if (removeTarget)
                    removeFetcher.submit(
                      {
                        intent: "removeMember",
                        memberId: removeTarget.memberId,
                      },
                      { method: "post" },
                    );
                }}
              >
                Remove
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={resetLink !== null && dismissedLink !== resetLink?.url}
          onClose={() => setDismissedLink(resetLink?.url ?? null)}
          title={`Recovery link for ${resetLink?.name ?? "member"}`}
          centered
          size="lg"
        >
          <Stack gap="md">
            <Text size="sm">
              Send this to them yourself — over text, Signal, or a Discord DM.
              CampTool can't email it. It walks them through setting up a
              passkey; if their device can't do that, they can set a password
              instead. Nothing about their account changes until they finish.
            </Text>
            <TextInput
              readOnly
              value={resetLink?.url ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Recovery link"
            />
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                Valid until {resetLink?.expires}. Opening it yourself is safe —
                it only shows the link's status. Finishing the reset also needs
                their email address.
              </Text>
              <CopyButton value={resetLink?.url ?? ""}>
                {({ copied, copy }) => (
                  <Button
                    onClick={copy}
                    color={copied ? "green" : undefined}
                    style={{ flexShrink: 0 }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Text size="xs" c="dimmed">
              This is the only time the link is shown — only its fingerprint is
              stored. Issuing a new one retires this one.
            </Text>
          </Stack>
        </Modal>

        <Modal
          opened={mergeTarget !== null}
          onClose={closeMerge}
          title={`Merge ${mergeTarget?.name ?? "member"} with their duplicate`}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              Use this when the same person signed up twice. The two records
              become one: gear, map placements, tickets, passes, RSVP, answers
              and guests all end up on the same member, and both accounts'
              sign-ins keep working.
            </Text>
            <Text size="sm" c="dimmed">
              It doesn't matter which one you call the duplicate — merging{" "}
              <strong>{mergeTarget?.name}</strong> with someone gives the same
              result as merging them the other way round.
            </Text>
            <Select
              label="Their other record"
              description="The second sign-up for this same person."
              placeholder="Pick the duplicate"
              searchable
              data={members
                .filter((m) => m.memberId !== mergeTarget?.memberId)
                .map((m) => ({
                  value: m.memberId,
                  label: m.playaName ? `${m.name} "${m.playaName}"` : m.name,
                }))}
              value={mergeInto}
              onChange={pickOther}
            />

            {previewFetcher.data?.error ? (
              <Text size="sm" c="red">
                {previewFetcher.data.error}
              </Text>
            ) : null}

            {mergePreview ? (
              <>
                {mergePreview.plan.conflicts.map((c) => (
                  <Radio.Group
                    key={c.field}
                    label={`Which ${c.label.toLowerCase()} is right?`}
                    description="The two records disagree, so this one needs you."
                    value={
                      mergePicks[c.field] ??
                      (c.field === "playaName"
                        ? (mergePreview.plan.membership.playaName ??
                          c.options[0])
                        : mergePreview.plan.user.name)
                    }
                    onChange={(v) => answerConflict(c.field, v)}
                  >
                    <Stack gap={4} mt={4}>
                      {c.options.map((o) => (
                        <Radio key={o} value={o} label={o} />
                      ))}
                    </Stack>
                  </Radio.Group>
                ))}

                <Card withBorder padding="sm" radius="sm">
                  <Text size="sm" fw={500} mb={6}>
                    They become one member:
                  </Text>
                  <Text size="xs">
                    <strong>{mergePreview.plan.user.name}</strong>
                    {mergePreview.plan.membership.playaName
                      ? ` "${mergePreview.plan.membership.playaName}"`
                      : ""}{" "}
                    · {mergePreview.plan.membership.role}
                  </Text>
                  <Text size="xs" c="dimmed">
                    Member since{" "}
                    {new Date(mergePreview.plan.membership.joinedAt)
                      .toISOString()
                      .slice(0, 10)}
                  </Text>
                  <Text size="xs" mt={6}>
                    Email: {mergePreview.plan.user.email}
                  </Text>
                  {mergePreview.plan.aliasEmail ? (
                    <Text size="xs" c="dimmed">
                      {mergePreview.plan.aliasEmail} is kept on file as a former
                      address — it will no longer sign them in.
                    </Text>
                  ) : null}
                  <Text size="xs" mt={6}>
                    They can still sign in with:{" "}
                    {mergePreview.plan.signInMethods.join(", ") ||
                      "nothing — they will need a recovery link"}
                  </Text>
                  {mergePreview.plan.droppedPassword ? (
                    <Text size="xs" c="orange">
                      Both accounts have a password; only one is kept. If the
                      wrong one survives, issue a recovery link.
                    </Text>
                  ) : null}
                  <Text size="xs" fw={500} mt={8}>
                    {mergePreview.total === 0
                      ? "Nothing else is attached to either record."
                      : `${mergePreview.total} record${mergePreview.total === 1 ? "" : "s"} will be brought together:`}
                  </Text>
                  {mergePreview.moves.map((mv) => (
                    <Text size="xs" c="dimmed" key={`${mv.table}.${mv.column}`}>
                      {mv.rows} × {mv.table.replace(/_/g, " ")}
                    </Text>
                  ))}
                </Card>
              </>
            ) : null}

            <Text size="xs" c="dimmed">
              This can't be undone. Where both records hold the same thing (both
              answered a question, both signed up for a shift), one copy is
              kept. Everyone is signed out and will need to sign in again once.
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={closeMerge}>
                Cancel
              </Button>
              <Button
                color="orange"
                disabled={!mergeInto}
                loading={mergeFetcher.state !== "idle"}
                onClick={() => {
                  if (mergeTarget && mergeInto)
                    mergeFetcher.submit(
                      {
                        intent: "mergeMembers",
                        idA: mergeTarget.memberId,
                        idB: mergeInto,
                        ...Object.fromEntries(
                          Object.entries(mergePicks).map(([k, v]) => [
                            `pick.${k}`,
                            v,
                          ]),
                        ),
                      },
                      { method: "post" },
                    );
                }}
              >
                Merge into one member
              </Button>
            </Group>
          </Stack>
        </Modal>

        <Modal
          opened={flagTarget !== null}
          onClose={() => setFlagTarget(null)}
          title={`Flag an issue with ${flagTarget?.name ?? "a member"}`}
          centered
        >
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              This goes privately to the camp's officers — {flagTarget?.name}{" "}
              won't see it. Use it for anything you'd rather not raise directly.
            </Text>
            <Textarea
              placeholder="What's going on?"
              autosize
              minRows={3}
              value={flagBody}
              onChange={(e) => setFlagBody(e.currentTarget.value)}
              maxLength={2000}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setFlagTarget(null)}>
                Cancel
              </Button>
              <Button
                color="orange"
                disabled={!flagBody.trim()}
                loading={flagFetcher.state !== "idle"}
                onClick={() => {
                  if (flagTarget)
                    flagFetcher.submit(
                      {
                        intent: "flagMember",
                        memberId: flagTarget.memberId,
                        body: flagBody,
                      },
                      { method: "post" },
                    );
                }}
              >
                Send to officers
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Container>
  );
}

/**
 * The nesting control, plus the camp's groups as chips.
 *
 * Sits above the table rather than inside it because it changes what the whole
 * list *is*, and because "Invited by" needs to be reachable even when the camp
 * has no named groups at all — that view costs nothing to offer, the edges have
 * been recorded since invite links shipped.
 */
function GroupsBar({
  groups,
  groupBy,
  onGroupBy,
  canManage,
  onManage,
}: {
  groups: LoadedGroup[];
  groupBy: GroupBy;
  onGroupBy: (v: GroupBy) => void;
  canManage: boolean;
  onManage: () => void;
}) {
  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Show as
          </Text>
          <SegmentedControl
            size="xs"
            value={groupBy}
            onChange={(v) => onGroupBy(v as GroupBy)}
            data={[
              { value: "none", label: "Flat list" },
              { value: "group", label: "Social groups" },
              { value: "inviter", label: "Who invited whom" },
            ]}
          />
        </Stack>
        <Stack gap={6} style={{ flex: 1, minWidth: 220 }}>
          <Group gap={6}>
            <Text size="sm" fw={600}>
              Groups
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={onManage}>
              {canManage ? "Manage" : "Create or join"}
            </Button>
          </Group>
          {groups.length === 0 ? (
            <Text size="xs" c="dimmed">
              No groups yet — a family, a couple, housemates, the friends
              somebody brought along. Being in one grants nobody anything; it
              just says who belongs with who.
            </Text>
          ) : (
            <Group gap={6}>
              {/* Tree order, not alphabetical, and children carry a marker —
                  the chip row is a summary of the same hierarchy the table
                  shows, so it shouldn't contradict it. */}
              {flattenForest(
                buildForest(groups, {
                  idOf: (g) => g.id,
                  parentOf: (g) => g.parentGroupId,
                  compare: (a, b) => a.name.localeCompare(b.name),
                }),
              ).map(({ item: g, depth }) => (
                // Links to the map with the whole group lit up — the same
                // highlight the roster's "N on map" link uses, widened from one
                // household to a set of them.
                <Anchor
                  key={g.id}
                  component={Link}
                  to={`/map?group=${g.id}`}
                  underline="never"
                >
                  <Badge
                    variant={depth === 0 ? "light" : "outline"}
                    color={g.color ?? "gray"}
                    size="sm"
                  >
                    {depth > 0 ? "└ " : ""}
                    {g.name} · {g.memberIds.length}
                  </Badge>
                </Anchor>
              ))}
            </Group>
          )}
        </Stack>
      </Group>
    </Card>
  );
}

/**
 * Create groups, put people in them, and (for officers) tidy them up.
 *
 * Everything here is deliberately available to ordinary members except rename /
 * delete / merge. The camp knows its own social shape far better than its
 * officers do, and a wrong group costs nothing — see plans/social-groups.md.
 */
function GroupsPanel({
  opened,
  onClose,
  groups,
  members,
  canManage,
  myMembershipId,
  fetcher,
}: {
  opened: boolean;
  onClose: () => void;
  groups: LoadedGroup[];
  members: { memberId: string; name: string; playaName: string | null }[];
  canManage: boolean;
  myMembershipId: string;
  fetcher: ReturnType<typeof useFetcher<FetcherData>>;
}) {
  const [newName, setNewName] = useState("");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [newParent, setNewParent] = useState<string | null>(null);
  const [addTo, setAddTo] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [mergeInto, setMergeInto] = useState<Record<string, string | null>>({});
  const busy = fetcher.state !== "idle";

  const options = members.map((m) => ({
    value: m.memberId,
    label: m.playaName ? `${m.name} "${m.playaName}"` : m.name,
  }));
  const nameOf = new Map(options.map((o) => [o.value, o.label]));

  // Shown as the tree it is, so "inside what?" is answerable at a glance.
  const tree = flattenForest(
    buildForest(groups, {
      idOf: (g) => g.id,
      parentOf: (g) => g.parentGroupId,
      compare: (a, b) => a.name.localeCompare(b.name),
    }),
  );
  const groupOptions = tree.map((n) => ({
    value: n.item.id,
    label: `${"— ".repeat(n.depth)}${n.item.name}`,
  }));

  const submit = (fields: Record<string, string | string[]>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) for (const one of v) body.append(k, one);
      else body.set(k, v);
    }
    fetcher.submit(body, { method: "post" });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Social groups"
      size="lg"
      centered
    >
      <Stack gap="lg">
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            A group is a name for people who belong together — a family, a
            couple, housemates, friends who've been coming together for years.
            Anyone can make one and add people, and groups can sit inside each
            other, so a household can live inside the wider family.
          </Text>
          {/* People will otherwise use this for "who I'm camping with", which
              is a different thing that already exists and carries real
              authority. Say so once, here, where the group is being made. */}
          <Text size="sm" c="dimmed">
            This is about relationships, not logistics: it changes nothing about
            what anyone is allowed to do. For who you're actually sharing a tent
            or an arrival with, use{" "}
            <Anchor component={Link} to="/roster" size="sm">
              who you're camping with
            </Anchor>{" "}
            on the roster instead.
          </Text>
        </Stack>

        <Card withBorder padding="sm" radius="sm">
          <Stack gap="xs">
            <TextInput
              label="New group"
              placeholder="The Riveras"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
            />
            <MultiSelect
              label="Who's in it"
              description="You can add people later too."
              placeholder="Pick people"
              searchable
              data={options}
              value={newMembers}
              onChange={setNewMembers}
            />
            <Select
              label="Inside another group"
              description="Optional — e.g. a household inside the wider family."
              placeholder="Top level"
              clearable
              searchable
              data={groupOptions}
              value={newParent}
              onChange={setNewParent}
            />
            <Group justify="flex-end">
              <Button
                size="xs"
                disabled={!newName.trim()}
                loading={busy}
                onClick={() => {
                  submit({
                    intent: "groupCreate",
                    name: newName,
                    membershipId: newMembers,
                    parentGroupId: newParent ?? "",
                  });
                  setNewName("");
                  setNewMembers([]);
                  setNewParent(null);
                }}
              >
                Create group
              </Button>
            </Group>
          </Stack>
        </Card>

        {tree.map(({ item: g, depth }) => (
          <Card key={g.id} withBorder padding="sm" radius="sm" ml={depth * 20}>
            <Stack gap="xs">
              <Group justify="space-between">
                <Group gap={6}>
                  {depth > 0 ? (
                    <Text span c="dimmed" size="xs">
                      └
                    </Text>
                  ) : null}
                  <Text fw={600}>{g.name}</Text>
                </Group>
                <Group gap={4}>
                  {canManage ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => {
                        setEditing(editing === g.id ? null : g.id);
                        setEditName(g.name);
                      }}
                    >
                      {editing === g.id ? "Close" : "Edit"}
                    </Button>
                  ) : null}
                  {g.memberIds.includes(myMembershipId) ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      onClick={() =>
                        submit({
                          intent: "groupRemove",
                          groupId: g.id,
                          membershipId: myMembershipId,
                        })
                      }
                    >
                      Leave
                    </Button>
                  ) : (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() =>
                        submit({
                          intent: "groupAdd",
                          groupId: g.id,
                          membershipId: [myMembershipId],
                        })
                      }
                    >
                      Join
                    </Button>
                  )}
                  {canManage ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        submit({ intent: "groupDelete", groupId: g.id })
                      }
                    >
                      Delete
                    </Button>
                  ) : null}
                </Group>
              </Group>

              {canManage && editing === g.id ? (
                <Card
                  withBorder
                  padding="xs"
                  radius="sm"
                  bg="var(--mantine-color-default-hover)"
                >
                  <Stack gap="xs">
                    <Group align="flex-end" gap="xs">
                      <TextInput
                        size="xs"
                        label="Name"
                        style={{ flex: 1 }}
                        value={editName}
                        onChange={(e) => setEditName(e.currentTarget.value)}
                      />
                      <Button
                        size="xs"
                        disabled={!editName.trim() || editName === g.name}
                        loading={busy}
                        onClick={() =>
                          submit({
                            intent: "groupRename",
                            groupId: g.id,
                            name: editName,
                            description: g.description ?? "",
                            color: g.color ?? "",
                          })
                        }
                      >
                        Rename
                      </Button>
                    </Group>
                    <Select
                      size="xs"
                      label="Inside"
                      placeholder="Top level"
                      clearable
                      searchable
                      // A group can't go inside itself or anything below it;
                      // the server refuses too, this just doesn't offer it.
                      data={groupOptions.filter(
                        (o) =>
                          !subtreeOf(groups, g.id, {
                            idOf: (x) => x.id,
                            parentOf: (x) => x.parentGroupId,
                          }).includes(o.value),
                      )}
                      value={g.parentGroupId}
                      onChange={(v) =>
                        submit({
                          intent: "groupReparent",
                          groupId: g.id,
                          parentGroupId: v ?? "",
                        })
                      }
                    />
                    <Group align="flex-end" gap="xs">
                      <Select
                        size="xs"
                        label="Fold another group into this one"
                        description="Its people and subgroups move here, then it's gone."
                        placeholder="Pick a group"
                        clearable
                        searchable
                        style={{ flex: 1 }}
                        data={groupOptions.filter((o) => o.value !== g.id)}
                        value={mergeInto[g.id] ?? null}
                        onChange={(v) =>
                          setMergeInto({ ...mergeInto, [g.id]: v })
                        }
                      />
                      <Button
                        size="xs"
                        color="orange"
                        disabled={!mergeInto[g.id]}
                        loading={busy}
                        onClick={() => {
                          submit({
                            intent: "groupMerge",
                            groupId: g.id,
                            staleGroupId: mergeInto[g.id] ?? "",
                          });
                          setMergeInto({ ...mergeInto, [g.id]: null });
                        }}
                      >
                        Fold in
                      </Button>
                    </Group>
                  </Stack>
                </Card>
              ) : null}

              {g.memberIds.length === 0 ? (
                <Text size="xs" c="dimmed">
                  Nobody in this group yet.
                </Text>
              ) : (
                <Group gap={6}>
                  {g.memberIds.map((id) => (
                    <Badge
                      key={id}
                      variant="light"
                      color={g.color ?? "gray"}
                      size="sm"
                      rightSection={
                        <Text
                          span
                          size="xs"
                          style={{ cursor: "pointer" }}
                          onClick={() =>
                            submit({
                              intent: "groupRemove",
                              groupId: g.id,
                              membershipId: id,
                            })
                          }
                        >
                          ×
                        </Text>
                      }
                    >
                      {nameOf.get(id) ?? "Former member"}
                    </Badge>
                  ))}
                </Group>
              )}

              <Group align="flex-end" gap="xs">
                <MultiSelect
                  size="xs"
                  placeholder="Add people"
                  searchable
                  style={{ flex: 1 }}
                  data={options.filter((o) => !g.memberIds.includes(o.value))}
                  value={addTo[g.id] ?? []}
                  onChange={(v) => setAddTo({ ...addTo, [g.id]: v })}
                />
                <Button
                  size="xs"
                  disabled={!(addTo[g.id] ?? []).length}
                  loading={busy}
                  onClick={() => {
                    submit({
                      intent: "groupAdd",
                      groupId: g.id,
                      membershipId: addTo[g.id] ?? [],
                    });
                    setAddTo({ ...addTo, [g.id]: [] });
                  }}
                >
                  Add
                </Button>
              </Group>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Modal>
  );
}

function useFetcherNotifications(
  data: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !data || data === seen.current) return;
    seen.current = data;
    if (data.error) {
      notifications.show({ color: "red", title: "Error", message: data.error });
    } else if (data.ok) {
      notifications.show({ title: "Done", message: data.ok });
      onOk?.();
    }
  }, [data, state, onOk]);
}
