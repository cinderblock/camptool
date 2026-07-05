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
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, desc, eq } from "drizzle-orm";
import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";
import { newInviteToken } from "~/lib/invite.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { campInvite } from "../../../db/schema";
import type { Route } from "./+types/invite";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Invite friends · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  if (!hasAtLeast(active.membership.role, "member")) {
    throw data("Not authorized", { status: 403 });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const rows = await db
    .select()
    .from(campInvite)
    .where(eq(campInvite.inviterMembershipId, active.membership.id))
    .orderBy(desc(campInvite.createdAt));

  const invites = rows.map((r) => ({
    id: r.id,
    url: `${baseUrl}/i/${r.token}`,
    role: r.role,
    useCount: r.useCount,
    maxUses: r.maxUses,
    expiresAt: r.expiresAt ? r.expiresAt.getTime() : null,
    revoked: Boolean(r.revokedAt),
  }));

  return {
    invites,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  if (!hasAtLeast(active.membership.role, "member")) {
    return data({ error: "You don't have permission." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "create") {
    // Reusable (multi-use) links are an officer tool and must not spread
    // further; everyone else gets strictly one-time links (server-enforced,
    // not just hidden in the UI).
    const reusable =
      form.get("reusable") === "1" &&
      hasAtLeast(active.membership.role, "officer");
    await db.insert(campInvite).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      inviterMembershipId: active.membership.id,
      token: newInviteToken(),
      role: "recruit",
      maxUses: reusable ? null : 1,
    });
    return data({
      ok: reusable
        ? "Reusable invite link created."
        : "One-time invite link created.",
    });
  }

  if (intent === "revoke") {
    const inviteId = String(form.get("inviteId"));
    // Owner-only: the where-clause scopes the revoke to the caller's own link.
    await db
      .update(campInvite)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(campInvite.id, inviteId),
          eq(campInvite.inviterMembershipId, active.membership.id),
        ),
      );
    return data({ ok: "Invite link revoked." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

function inviteStatus(i: {
  revoked: boolean;
  expiresAt: number | null;
  maxUses: number | null;
  useCount: number;
}): { label: string; color: string } {
  if (i.revoked) return { label: "revoked", color: "red" };
  if (i.expiresAt && i.expiresAt <= Date.now()) {
    return { label: "expired", color: "gray" };
  }
  if (i.maxUses != null && i.useCount >= i.maxUses) {
    return { label: "used up", color: "gray" };
  }
  return { label: "active", color: "green" };
}

export default function InviteFriends({ loaderData }: Route.ComponentProps) {
  const { invites, isOfficer } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);
  const busy = fetcher.state !== "idle";

  return (
    <Container>
      <Stack gap="lg">
        <Title order={2}>Invite friends</Title>
        <Text c="dimmed" size="sm">
          One-time signup links are how friends join the camp: create a link,
          send it to one friend, and it stops working once they use it. Whoever
          joins through your link is recorded as invited by you, and joins as a
          recruit — promote them later from Members.
        </Text>

        <Card withBorder padding="md" radius="md">
          <Group justify="space-between">
            <div>
              <Text fw={600} size="sm">
                Create a one-time signup link
              </Text>
              <Text c="dimmed" size="xs">
                Good for exactly one signup — make a fresh link for each friend.
              </Text>
            </div>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create" />
              <Button type="submit" size="xs" loading={busy}>
                Create link
              </Button>
            </fetcher.Form>
          </Group>
        </Card>

        {isOfficer ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between">
              <div>
                <Text fw={600} size="sm">
                  Create a reusable link (officers only)
                </Text>
                <Text c="dimmed" size="xs">
                  Admits anyone who has it until you revoke it. Keep it within
                  the officer team — for bringing in friends, use one-time links
                  instead.
                </Text>
              </div>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="reusable" value="1" />
                <Button type="submit" size="xs" variant="light" loading={busy}>
                  Create reusable link
                </Button>
              </fetcher.Form>
            </Group>
          </Card>
        ) : null}

        {invites.length === 0 ? (
          <Text c="dimmed">No invite links yet. Create one above.</Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Link</Table.Th>
                  <Table.Th>Uses</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invites.map((i) => {
                  const status = inviteStatus(i);
                  const active = status.label === "active";
                  return (
                    <Table.Tr key={i.id}>
                      <Table.Td maw={320}>
                        <Anchor href={i.url} target="_blank" size="sm">
                          {i.url}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        {i.useCount}
                        {i.maxUses != null ? ` / ${i.maxUses}` : " · reusable"}
                      </Table.Td>
                      <Table.Td>
                        <Badge color={status.color} variant="light">
                          {status.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <CopyButton value={i.url}>
                            {({ copied, copy }) => (
                              <Tooltip label={copied ? "Copied" : "Copy"}>
                                <Button
                                  size="xs"
                                  variant="light"
                                  color={copied ? "green" : "blue"}
                                  onClick={copy}
                                >
                                  {copied ? "Copied" : "Copy"}
                                </Button>
                              </Tooltip>
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
