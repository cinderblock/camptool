import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Modal,
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
import { useEffect, useRef, useState } from "react";
import { Form, Link, data, useFetcher } from "react-router";
import { auth } from "~/lib/auth.server";
import { syncDiscordLinksForCamp } from "~/lib/discord.server";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState } from "~/lib/features.server";
import {
  type MergePreview,
  mergeMemberships,
  previewMembershipMerge,
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

  return redact(privacy, {
    campId,
    campName: active.camp.name,
    actorUserId: actor.id,
    actorRole,
    canManage,
    canFlag,
    assignableRoles,
    members,
    officerFlags,
    myFlags,
    // "N of M enrolled", the cheap-to-delete adoption summary.
    passkeyEnrolled: canManage ? withPasskey.size : 0,
  });
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
    const survivorId = String(form.get("survivorId"));
    const staleId = String(form.get("staleId"));

    const rows = await db
      .select({
        id: membership.id,
        role: membership.role,
        userId: membership.userId,
      })
      .from(membership)
      .where(eq(membership.organizationId, campId));
    const survivor = rows.find((r) => r.id === survivorId);
    const stale = rows.find((r) => r.id === staleId);
    if (!survivor || !stale) {
      return data({ error: "Member not found." }, { status: 404 });
    }
    // Merging deletes the duplicate, so it needs the same authority as removal:
    // you must strictly outrank the record being absorbed.
    if (rankOf(actorRole) <= rankOf(stale.role)) {
      return data(
        { error: "You can only merge members ranked below you." },
        { status: 403 },
      );
    }
    if (stale.userId === actor.id) {
      return data(
        { error: "You can't merge your own account away." },
        { status: 400 },
      );
    }

    try {
      const result = await mergeMemberships(campId, survivorId, staleId);
      return data({
        ok:
          result.total === 0
            ? "Merged. The duplicate had no data attached."
            : `Merged — moved ${result.total} record${result.total === 1 ? "" : "s"} onto the surviving member.`,
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
    const survivorId = String(form.get("survivorId"));
    const staleId = String(form.get("staleId"));
    try {
      const preview = await previewMembershipMerge(campId, survivorId, staleId);
      return data({ preview });
    } catch (e) {
      return data(
        { error: e instanceof Error ? e.message : "Couldn't preview." },
        { status: 400 },
      );
    }
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

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
    preview?: MergePreview;
    error?: string;
  }>();
  const [mergeTarget, setMergeTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const mergePreview = previewFetcher.data?.preview ?? null;

  // The issued link comes back in the response body rather than being stored:
  // we keep only its SHA-256 hash server-side, so THIS is the one moment the
  // officer can copy it. Reissuing is cheap if they lose it.
  const resetFetcher = useFetcher<{
    resetLink?: { url: string; expires: string; name: string };
    error?: string;
  }>();
  const resetLink = resetFetcher.data?.resetLink ?? null;
  const [dismissedLink, setDismissedLink] = useState<string | null>(null);

  // Show what a merge would actually move before anyone commits to it — the
  // operation deletes a record, so "6 records will move" beats a blind confirm.
  // Driven from the Select's onChange rather than an effect: the survivor
  // choice is the only thing it depends on, so there's nothing to synchronise.
  const pickSurvivor = (survivorId: string | null) => {
    setMergeInto(survivorId);
    if (!mergeTarget || !survivorId) return;
    previewFetcher.submit(
      {
        intent: "previewMerge",
        survivorId,
        staleId: mergeTarget.memberId,
      },
      { method: "post" },
    );
  };

  useFetcherNotifications(roleFetcher.data, roleFetcher.state);
  useFetcherNotifications(mergeFetcher.data, mergeFetcher.state, () => {
    setMergeTarget(null);
    setMergeInto(null);
  });
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
              {members.map((m) => {
                const isSelf = m.userId === actorUserId;
                const editable =
                  canManage && !isSelf && rankOf(actorRole) > rankOf(m.role);
                return (
                  <Table.Tr key={m.memberId}>
                    <Table.Td>
                      {m.name}
                      {isSelf ? (
                        <Text span c="dimmed" size="xs">
                          {" "}
                          (you)
                        </Text>
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
          onClose={() => {
            setMergeTarget(null);
            setMergeInto(null);
          }}
          title={`Merge ${mergeTarget?.name ?? "member"} into another member`}
          centered
        >
          <Stack gap="md">
            <Text size="sm">
              Use this when the same person signed up twice. Everything attached
              to <strong>{mergeTarget?.name}</strong> — declared gear, map
              placements, tickets, passes, RSVP, answers, and any guests they're
              bringing — moves onto the member you pick, and this duplicate
              record is then deleted.
            </Text>
            <Select
              label="Keep this member"
              description="The account they can actually log into. This record survives."
              placeholder="Pick the surviving member"
              searchable
              data={members
                .filter((m) => m.memberId !== mergeTarget?.memberId)
                .map((m) => ({
                  value: m.memberId,
                  label: m.playaName ? `${m.name} "${m.playaName}"` : m.name,
                }))}
              value={mergeInto}
              onChange={pickSurvivor}
            />
            {mergePreview ? (
              <Card withBorder padding="sm" radius="sm">
                <Text size="sm" fw={500} mb={4}>
                  {mergePreview.total === 0
                    ? "This duplicate has no data attached."
                    : `${mergePreview.total} record${mergePreview.total === 1 ? "" : "s"} will move:`}
                </Text>
                {mergePreview.moves.map((mv) => (
                  <Text size="xs" c="dimmed" key={`${mv.table}.${mv.column}`}>
                    {mv.rows} × {mv.table.replace(/_/g, " ")}
                  </Text>
                ))}
              </Card>
            ) : null}
            <Text size="xs" c="dimmed">
              This can't be undone. Where both records hold the same thing (both
              answered a question, both signed up for a shift), the surviving
              member's version is kept.
            </Text>
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  setMergeTarget(null);
                  setMergeInto(null);
                }}
              >
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
                        survivorId: mergeInto,
                        staleId: mergeTarget.memberId,
                      },
                      { method: "post" },
                    );
                }}
              >
                Merge and delete duplicate
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
