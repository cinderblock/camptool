import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, desc, eq, inArray } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { PUBLIC_BASE_URL } from "~/lib/env.server";
import { newInviteToken } from "~/lib/invite.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { campInvite, membership, user } from "../../../db/schema";
import type { Route } from "./+types/invite";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Invites · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, privacy } = await requireActiveCamp(request);
  if (!hasAtLeast(active.membership.role, "member")) {
    throw data("Not authorized", { status: 403 });
  }

  const baseUrl = PUBLIC_BASE_URL;
  // Officers oversee the camp's whole link inventory (with who created each);
  // everyone else manages just their own links.
  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const rows = await db
    .select({
      inv: campInvite,
      inviterUserName: user.name,
      inviterPlayaName: membership.playaName,
    })
    .from(campInvite)
    .innerJoin(membership, eq(campInvite.inviterMembershipId, membership.id))
    .innerJoin(user, eq(membership.userId, user.id))
    .where(
      isOfficer
        ? eq(campInvite.campId, active.camp.id)
        : eq(campInvite.inviterMembershipId, active.membership.id),
    )
    .orderBy(desc(campInvite.createdAt));

  // Who actually joined through each link (membership.via_invite_id, recorded
  // at redemption — links redeemed before tracking landed show nobody).
  const ids = rows.map((r) => r.inv.id);
  const redeemerRows = ids.length
    ? await db
        .select({
          viaInviteId: membership.viaInviteId,
          userName: user.name,
          playaName: membership.playaName,
        })
        .from(membership)
        .innerJoin(user, eq(membership.userId, user.id))
        .where(inArray(membership.viaInviteId, ids))
    : [];
  const joinedBy = new Map<string, string[]>();
  for (const r of redeemerRows) {
    if (!r.viaInviteId) continue;
    const list = joinedBy.get(r.viaInviteId) ?? [];
    list.push(r.playaName || r.userName);
    joinedBy.set(r.viaInviteId, list);
  }

  const invites = rows.map(({ inv: r, inviterUserName, inviterPlayaName }) => ({
    id: r.id,
    url: `${baseUrl}/i/${r.token}`,
    role: r.role,
    kind: r.kind,
    note: r.note,
    createdBy: inviterPlayaName || inviterUserName,
    mine: r.inviterMembershipId === active.membership.id,
    joined: joinedBy.get(r.id) ?? [],
    useCount: r.useCount,
    maxUses: r.maxUses,
    createdAt: r.createdAt.getTime(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
    revoked: Boolean(r.revokedAt),
  }));

  return redact(privacy, { invites, isOfficer });
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  if (!hasAtLeast(active.membership.role, "member")) {
    return data({ error: "Members only." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "create") {
    // The kind is locked at creation and drives everything else. 'open'
    // (reusable) links are an officer tool and must not spread further;
    // everyone else gets 'personal' links — tied to them as the inviter and
    // therefore strictly one-time (server-enforced, not just hidden in the UI).
    const open =
      form.get("reusable") === "1" &&
      hasAtLeast(active.membership.role, "officer");
    // Who/what the link is for — internal bookkeeping shown in the table.
    const note =
      String(form.get("note") ?? "")
        .trim()
        .slice(0, 200) || null;
    // Optional expiry from a date-only input: the link dies at the END of the
    // chosen day (UTC — hour-level slop is immaterial for a signup link).
    const expiresRaw = String(form.get("expires") ?? "").trim();
    const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(expiresRaw)
      ? new Date(`${expiresRaw}T23:59:59.999Z`)
      : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return data({ error: "Expiry must be in the future." }, { status: 400 });
    }
    await db.insert(campInvite).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      inviterMembershipId: active.membership.id,
      token: newInviteToken(),
      role: "recruit",
      kind: open ? "open" : "personal",
      note,
      maxUses: open ? null : 1,
      expiresAt,
    });
    return data({
      ok: open
        ? "Reusable invite link created."
        : "One-time invite link created.",
    });
  }

  if (intent === "revoke") {
    const inviteId = String(form.get("inviteId"));
    // Own links only — except officers, who can revoke any of the camp's links.
    await db
      .update(campInvite)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(campInvite.id, inviteId),
          eq(campInvite.campId, active.camp.id),
          hasAtLeast(active.membership.role, "officer")
            ? undefined
            : eq(campInvite.inviterMembershipId, active.membership.id),
        ),
      );
    return data({ ok: "Invite link revoked." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

/** Table date format: ISO (YYYY-MM-DD). */
function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function inviteStatus(i: {
  revoked: boolean;
  expiresAt: number | null;
  maxUses: number | null;
  useCount: number;
}): { label: string; color: string } {
  if (i.revoked) return { label: "Revoked", color: "red" };
  if (i.expiresAt && i.expiresAt <= Date.now()) {
    return { label: "Expired", color: "gray" };
  }
  if (i.maxUses != null && i.useCount >= i.maxUses) {
    return { label: "Used", color: "gray" };
  }
  return { label: "Active", color: "green" };
}

export default function InviteFriends({ loaderData }: Route.ComponentProps) {
  const { invites, isOfficer } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);
  const busy = fetcher.state !== "idle";
  // Remount the create forms after a successful action so the uncontrolled
  // note inputs clear — a stale note must not silently attach to the next link.
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setResetKey((k) => k + 1);
  }, [fetcher.state, fetcher.data]);

  return (
    <Container>
      <Stack gap="lg">
        <Stack gap={2}>
          <Title order={2}>Invites</Title>
          <Text c="dimmed" size="sm">
            {isOfficer
              ? "Create invite links to add recruits. Each redemption records who invited them; promote recruits later on Members."
              : "Create one-time invite links for friends. Anyone who signs up joins as a recruit under your name."}
          </Text>
        </Stack>

        <Card withBorder padding="md" radius="md">
          <Text fw={600} size="sm">
            One-time invite link
          </Text>
          <Text c="dimmed" size="xs">
            Works once — create a separate link for each person.
          </Text>
          <fetcher.Form method="post" key={`one-${resetKey}`}>
            <input type="hidden" name="intent" value="create" />
            <Group gap="xs" mt="xs" align="flex-end" wrap="wrap">
              <TextInput
                label="Label"
                name="note"
                size="xs"
                style={{ flex: 1, minWidth: 200 }}
                maxLength={200}
                placeholder="e.g. Alex from work"
              />
              <TextInput
                label="Expires (optional)"
                type="date"
                name="expires"
                size="xs"
                w={150}
              />
              <Button type="submit" size="xs" loading={busy}>
                Create link
              </Button>
            </Group>
          </fetcher.Form>
        </Card>

        {isOfficer ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} size="sm">
              Reusable invite link (officers only)
            </Text>
            <Text c="dimmed" size="xs">
              Admits anyone with the link until revoked or expired.
            </Text>
            <fetcher.Form method="post" key={`multi-${resetKey}`}>
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="reusable" value="1" />
              <Group gap="xs" mt="xs" align="flex-end" wrap="wrap">
                <TextInput
                  label="Label"
                  name="note"
                  size="xs"
                  style={{ flex: 1, minWidth: 200 }}
                  maxLength={200}
                  placeholder="e.g. 2026 build crew"
                />
                <TextInput
                  label="Expires (optional)"
                  type="date"
                  name="expires"
                  size="xs"
                  w={150}
                />
                <Button type="submit" size="xs" variant="light" loading={busy}>
                  Create reusable link
                </Button>
              </Group>
            </fetcher.Form>
          </Card>
        ) : null}

        {invites.length === 0 ? (
          <Text c="dimmed">No invite links yet. Create one above.</Text>
        ) : (
          <Table.ScrollContainer minWidth={isOfficer ? 1180 : 1080}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Link</Table.Th>
                  <Table.Th>Label</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Uses</Table.Th>
                  <Table.Th>Joined</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Last used</Table.Th>
                  <Table.Th>Expires</Table.Th>
                  <Table.Th>Status</Table.Th>
                  {isOfficer ? <Table.Th>Created by</Table.Th> : null}
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invites.map((i) => {
                  const status = inviteStatus(i);
                  const active = status.label === "Active";
                  return (
                    <Table.Tr key={i.id}>
                      <Table.Td maw={280}>
                        <Anchor href={i.url} target="_blank" size="sm">
                          {i.url}
                        </Anchor>
                      </Table.Td>
                      <Table.Td maw={180}>
                        {i.note ? (
                          <Tooltip label={i.note} openDelay={300} withArrow>
                            <Text size="sm" truncate>
                              {i.note}
                            </Text>
                          </Tooltip>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={i.kind === "open" ? "orange" : "blue"}
                        >
                          {i.kind === "open" ? "Reusable" : "One-time"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {i.useCount}
                        {i.maxUses != null ? ` / ${i.maxUses}` : ""}
                      </Table.Td>
                      <Table.Td maw={180}>
                        {i.joined.length ? (
                          <Tooltip
                            label={i.joined.join(", ")}
                            openDelay={300}
                            withArrow
                          >
                            <Text size="sm" truncate>
                              {i.joined.slice(0, 2).join(", ")}
                              {i.joined.length > 2
                                ? ` +${i.joined.length - 2}`
                                : ""}
                            </Text>
                          </Tooltip>
                        ) : (
                          <Text size="sm" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {isoDate(i.createdAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {i.lastUsedAt ? isoDate(i.lastUsedAt) : "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {i.expiresAt ? isoDate(i.expiresAt) : "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={status.color} variant="light">
                          {status.label}
                        </Badge>
                      </Table.Td>
                      {isOfficer ? (
                        <Table.Td>
                          <Text size="sm" c={i.mine ? undefined : "dimmed"}>
                            {i.mine ? "You" : i.createdBy}
                          </Text>
                        </Table.Td>
                      ) : null}
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <CopyButton value={i.url}>
                            {({ copied, copy }) => (
                              <Button
                                size="xs"
                                variant="light"
                                color={copied ? "green" : "blue"}
                                onClick={copy}
                              >
                                {copied ? "Copied" : "Copy"}
                              </Button>
                            )}
                          </CopyButton>
                          {active ? (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              disabled={busy}
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "revoke", inviteId: i.id },
                                  { method: "post" },
                                )
                              }
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Container>
  );
}

function useFetcherNotifications(
  fetcherData: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !fetcherData || fetcherData === seen.current)
      return;
    seen.current = fetcherData;
    if (fetcherData.error) {
      notifications.show({
        color: "red",
        title: "Error",
        message: fetcherData.error,
      });
    } else if (fetcherData.ok) {
      notifications.show({ title: "Done", message: fetcherData.ok });
    }
  }, [fetcherData, state]);
}
