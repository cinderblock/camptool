import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Form, data, useFetcher } from "react-router";
import { auth } from "~/lib/auth.server";
import { syncDiscordLinksForCamp } from "~/lib/discord.server";
import {
  ROLES,
  type Role,
  hasAtLeast,
  isRole,
  rankOf,
} from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership, user } from "../../../db/schema";
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
  const { user: actor, active } = await requireActiveCamp(request);
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
      name: user.name,
      email: user.email,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));

  const discord = await syncDiscordLinksForCamp(campId);

  const members = rows
    .map((r) => ({
      ...r,
      joinedAt: r.joinedAt ? r.joinedAt.toISOString() : null,
      discord: discord.get(r.userId) ?? null,
    }))
    .sort(
      (a, b) => rankOf(b.role) - rankOf(a.role) || a.name.localeCompare(b.name),
    );

  const canManage = hasAtLeast(actorRole, "officer");
  const assignableRoles = ROLES.filter((r) => rankOf(r) <= rankOf(actorRole));

  return {
    campId,
    campName: active.camp.name,
    actorUserId: actor.id,
    actorRole,
    canManage,
    assignableRoles,
    members,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  const actorRole = active.membership.role;

  if (!hasAtLeast(actorRole, "officer")) {
    return data(
      { error: "You don't have permission to manage members." },
      {
        status: 403,
      },
    );
  }

  const form = await request.formData();
  const intent = form.get("intent");

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
    await db.delete(membership).where(eq(membership.id, memberId));
    return data({ ok: `Removed ${u?.name ?? "member"} from the camp.` });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

export default function Members({ loaderData }: Route.ComponentProps) {
  const {
    members,
    canManage,
    assignableRoles,
    actorUserId,
    actorRole,
    campId,
  } = loaderData;
  const roleFetcher = useFetcher<FetcherData>();
  const addFetcher = useFetcher<FetcherData>();
  const removeFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);
  const [removeTarget, setRemoveTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);

  useFetcherNotifications(roleFetcher.data, roleFetcher.state);
  useFetcherNotifications(addFetcher.data, addFetcher.state, () =>
    addFormRef.current?.reset(),
  );
  useFetcherNotifications(removeFetcher.data, removeFetcher.state, () =>
    setRemoveTarget(null),
  );

  const roleOptions = assignableRoles.map((r) => ({ value: r, label: r }));

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Title order={2}>Members</Title>

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

        <Table.ScrollContainer minWidth={720}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Playa name</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th>Discord</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Role</Table.Th>
                {canManage ? <Table.Th>Actions</Table.Th> : null}
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
                    {canManage ? (
                      <Table.Td>
                        {editable ? (
                          <Group gap="xs" wrap="nowrap">
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
                          </Group>
                        ) : null}
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
