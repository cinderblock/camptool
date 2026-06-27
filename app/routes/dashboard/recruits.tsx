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
import { auth } from "~/lib/auth.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership, recruitApplication, user } from "../../../db/schema";
import type { Route } from "./+types/recruits";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Recruits · CampTool" }];
}

const STATUS_COLOR: Record<string, string> = {
  pending: "yellow",
  accepted: "green",
  rejected: "red",
  waitlisted: "blue",
};

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  waitlisted: 1,
  accepted: 2,
  rejected: 3,
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const campId = active.camp.id;

  const apps = await db
    .select()
    .from(recruitApplication)
    .where(eq(recruitApplication.campId, campId))
    .orderBy(desc(recruitApplication.createdAt));

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const applyUrl = active.camp.slug ? `${baseUrl}/c/${active.camp.slug}` : null;

  const applications = apps
    .map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))
    .sort(
      (a, b) =>
        (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
        b.createdAt.localeCompare(a.createdAt),
    );

  return { applications, applyUrl };
}

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "You don't have permission." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const applicationId = String(form.get("applicationId"));

  const [app] = await db
    .select()
    .from(recruitApplication)
    .where(
      and(
        eq(recruitApplication.id, applicationId),
        eq(recruitApplication.campId, campId),
      ),
    );
  if (!app) return data({ error: "Application not found." }, { status: 404 });

  const reviewed = {
    reviewedById: actor.id,
    reviewedAt: new Date(),
  };

  if (intent === "reject" || intent === "waitlist") {
    const status = intent === "reject" ? "rejected" : "waitlisted";
    await db
      .update(recruitApplication)
      .set({ status, ...reviewed })
      .where(eq(recruitApplication.id, applicationId));
    return data({ ok: `Marked ${app.name} as ${status}.` });
  }

  if (intent === "accept") {
    // Resolve the applicant to an account if one exists now (they may have
    // signed up after applying).
    const [u] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, app.email))
      .limit(1);

    let outcome: string;
    if (u) {
      const [already] = await db
        .select({ id: membership.id })
        .from(membership)
        .where(
          and(
            eq(membership.userId, u.id),
            eq(membership.organizationId, campId),
          ),
        )
        .limit(1);
      if (already) {
        outcome = `${app.name} is already a member.`;
      } else {
        try {
          await auth.api.addMember({
            body: { userId: u.id, organizationId: campId, role: "recruit" },
            headers: request.headers,
          });
          outcome = `${app.name} added as a recruit.`;
        } catch {
          return data({ error: "Could not add member." }, { status: 500 });
        }
      }
    } else {
      try {
        await auth.api.createInvitation({
          body: { email: app.email, role: "recruit", organizationId: campId },
          headers: request.headers,
        });
        outcome = `Invited ${app.email} to join as a recruit.`;
      } catch {
        return data({ error: "Could not send invitation." }, { status: 500 });
      }
    }

    await db
      .update(recruitApplication)
      .set({ status: "accepted", userId: u?.id ?? app.userId, ...reviewed })
      .where(eq(recruitApplication.id, applicationId));
    return data({ ok: outcome });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: string; error?: string };

export default function Recruits({ loaderData }: Route.ComponentProps) {
  const { applications, applyUrl } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);
  const busy = fetcher.state !== "idle";

  function act(intent: string, applicationId: string) {
    fetcher.submit({ intent, applicationId }, { method: "post" });
  }

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Title order={2}>Recruits</Title>

        {applyUrl ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" wrap="wrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm">
                  Public application link
                </Text>
                <Anchor
                  href={applyUrl}
                  target="_blank"
                  size="sm"
                  style={{ wordBreak: "break-all" }}
                >
                  {applyUrl}
                </Anchor>
              </div>
              <CopyButton value={applyUrl}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy"}>
                    <Button
                      size="xs"
                      variant="light"
                      color={copied ? "green" : "blue"}
                      onClick={copy}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </Card>
        ) : null}

        {applications.length === 0 ? (
          <Text c="dimmed">No applications yet. Share your link above.</Text>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Message</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {applications.map((a) => {
                  const open =
                    a.status === "pending" || a.status === "waitlisted";
                  return (
                    <Table.Tr key={a.id}>
                      <Table.Td>
                        {a.name}
                        {a.playaName ? (
                          <Text span c="dimmed" size="xs">
                            {" "}
                            ({a.playaName})
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td>{a.email}</Table.Td>
                      <Table.Td maw={280}>
                        <Text size="sm" c={a.message ? undefined : "dimmed"}>
                          {a.message ?? "—"}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={STATUS_COLOR[a.status] ?? "gray"}
                          variant="light"
                        >
                          {a.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {open ? (
                          <Group gap="xs" wrap="nowrap">
                            <Button
                              size="xs"
                              color="green"
                              disabled={busy}
                              onClick={() => act("accept", a.id)}
                            >
                              Accept
                            </Button>
                            {a.status === "pending" ? (
                              <Button
                                size="xs"
                                variant="default"
                                disabled={busy}
                                onClick={() => act("waitlist", a.id)}
                              >
                                Waitlist
                              </Button>
                            ) : null}
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              disabled={busy}
                              onClick={() => act("reject", a.id)}
                            >
                              Reject
                            </Button>
                          </Group>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
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
  data: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !data || data === seen.current) return;
    seen.current = data;
    if (data.error) {
      notifications.show({ color: "red", title: "Error", message: data.error });
    } else if (data.ok) {
      notifications.show({ title: "Done", message: data.ok });
    }
  }, [data, state]);
}
