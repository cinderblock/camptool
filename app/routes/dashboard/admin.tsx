import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { desc, eq, ne } from "drizzle-orm";
import { useEffect, useRef } from "react";
import { data, redirect, useFetcher } from "react-router";
import {
  getInstanceSettings,
  grantSuperAdminByEmail,
  isSuperAdmin,
  listSuperAdmins,
  revokeSuperAdmin,
  setInstanceSettings,
} from "~/lib/instance.server";
import { requireUser } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { clientError, feedback, user as userTable } from "../../../db/schema";
import type { Route } from "./+types/admin";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Site admin · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/");

  const [settings, admins] = await Promise.all([
    getInstanceSettings(),
    listSuperAdmins(),
  ]);

  const recentErrors = (
    await db
      .select({
        id: clientError.id,
        kind: clientError.kind,
        message: clientError.message,
        url: clientError.url,
        userName: userTable.name,
        createdAt: clientError.createdAt,
      })
      .from(clientError)
      .leftJoin(userTable, eq(clientError.userId, userTable.id))
      .orderBy(desc(clientError.createdAt))
      .limit(25)
  ).map((e) => ({
    id: e.id,
    kind: e.kind,
    message: e.message,
    url: e.url,
    userName: e.userName,
    at: e.createdAt.toISOString(),
  }));

  // Open feedback only — items marked done are hidden so the list stays a live
  // triage queue.
  const recentFeedback = (
    await db
      .select({
        id: feedback.id,
        kind: feedback.kind,
        title: feedback.title,
        body: feedback.body,
        details: feedback.details,
        url: feedback.url,
        userName: userTable.name,
        createdAt: feedback.createdAt,
      })
      .from(feedback)
      .leftJoin(userTable, eq(feedback.userId, userTable.id))
      .where(ne(feedback.status, "done"))
      .orderBy(desc(feedback.createdAt))
      .limit(25)
  ).map((f) => ({
    id: f.id,
    kind: f.kind,
    summary:
      f.title ||
      [f.body, f.details].filter(Boolean).join(" — ").slice(0, 200) ||
      "(no text)",
    url: f.url,
    userName: f.userName,
    at: f.createdAt.toISOString(),
  }));

  return {
    settings,
    currentUserId: session.user.id,
    admins: admins.map((a) => ({
      userId: a.userId,
      name: a.name,
      email: a.email,
    })),
    recentErrors,
    recentFeedback,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "toggle") {
    const field = String(form.get("field") ?? "");
    const value = String(form.get("value") ?? "") === "true";
    if (field !== "allowCampCreation" && field !== "allowOpenSignups") {
      return data({ error: "Unknown setting." }, { status: 400 });
    }
    await setInstanceSettings({ [field]: value });
    return data({ ok: true });
  }

  if (intent === "addAdmin") {
    const email = String(form.get("email") ?? "");
    const res = await grantSuperAdminByEmail(email);
    if (!res.ok) return data({ error: res.reason }, { status: 400 });
    return data({ ok: true, message: "Super admin added." });
  }

  if (intent === "removeAdmin") {
    const userId = String(form.get("userId") ?? "");
    const res = await revokeSuperAdmin(userId);
    if (!res.ok) return data({ error: res.reason }, { status: 400 });
    return data({ ok: true, message: "Super admin removed." });
  }

  // Mark a feedback item done (hidden from the triage list; reversible by
  // re-opening in the DB) or delete it outright.
  if (intent === "feedbackDone") {
    await db
      .update(feedback)
      .set({ status: "done" })
      .where(eq(feedback.id, String(form.get("id") ?? "")));
    return data({ ok: true, message: "Marked done." });
  }

  if (intent === "deleteFeedback") {
    await db
      .delete(feedback)
      .where(eq(feedback.id, String(form.get("id") ?? "")));
    return data({ ok: true, message: "Feedback deleted." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function SiteAdmin({ loaderData }: Route.ComponentProps) {
  const { settings, admins, currentUserId, recentErrors, recentFeedback } =
    loaderData;

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Title order={2}>Site administration</Title>
          <Text c="dimmed">
            Deployment-wide controls. These apply to the whole CampTool
            instance, not a single camp.
          </Text>
        </div>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Lockdowns</Title>
            <ToggleRow
              field="allowCampCreation"
              checked={settings.allowCampCreation}
              label="Allow new camp creation"
              description="When off, only super admins can create new camps."
            />
            <ToggleRow
              field="allowOpenSignups"
              checked={settings.allowOpenSignups}
              label="Allow open sign-ups"
              description="When off, new accounts are invite-only — only people who follow a camp invite link or a camp's public apply page can register."
            />
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Super admins</Title>
            <Text size="sm" c="dimmed">
              Super admins can change these settings and always bypass the
              lockdowns. To add one, the person must have signed in here at
              least once.
            </Text>
            <AdminTable admins={admins} currentUserId={currentUserId} />
            <AddAdminForm />
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Database backup</Title>
            <Text size="sm" c="dimmed">
              Download a complete snapshot of the database (every camp's data)
              as a SQLite <code>.db</code> file. Safe to take while the app is
              running; keep backups somewhere private.
            </Text>
            <div>
              <Button component="a" href="/export-db" variant="light">
                Download backup
              </Button>
            </div>
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>User feedback</Title>
            <Text size="sm" c="dimmed">
              Bug reports and suggestions sent via the Feedback button. Mark an
              item <b>Done</b> to clear it from this queue (latest 25 open).
            </Text>
            {recentFeedback.length === 0 ? (
              <Text size="sm" c="dimmed">
                No open feedback. 🎉
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={620}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>When</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Summary</Table.Th>
                      <Table.Th>Who</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {recentFeedback.map((f) => (
                      <Table.Tr key={f.id}>
                        <Table.Td style={{ whiteSpace: "nowrap" }}>
                          {new Date(f.at).toLocaleDateString()}
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            size="xs"
                            variant="light"
                            color={
                              f.kind === "bug"
                                ? "red"
                                : f.kind === "compliment"
                                  ? "teal"
                                  : "blue"
                            }
                          >
                            {f.kind}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" lineClamp={2}>
                            {f.summary}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {f.userName ?? "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <FeedbackActions id={f.id} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Recent client errors</Title>
            <Text size="sm" c="dimmed">
              JavaScript errors forwarded from users' browsers (latest 25).
            </Text>
            {recentErrors.length === 0 ? (
              <Text size="sm" c="dimmed">
                No errors logged. 🎉
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={560}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>When</Table.Th>
                      <Table.Th>Kind</Table.Th>
                      <Table.Th>Message</Table.Th>
                      <Table.Th>Where</Table.Th>
                      <Table.Th>Who</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {recentErrors.map((e) => (
                      <Table.Tr key={e.id}>
                        <Table.Td style={{ whiteSpace: "nowrap" }}>
                          {new Date(e.at).toLocaleString()}
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" variant="light" color="red">
                            {e.kind}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" lineClamp={2}>
                            {e.message}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {e.url ?? ""}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {e.userName ?? "—"}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}

function ToggleRow({
  field,
  checked,
  label,
  description,
}: {
  field: string;
  checked: boolean;
  label: string;
  description: string;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  // Reflect the in-flight value optimistically so the switch feels responsive.
  const pending = fetcher.formData?.get("value");
  const value = pending != null ? pending === "true" : checked;

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't save",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]);

  return (
    <Switch
      checked={value}
      label={label}
      description={description}
      onChange={(e) =>
        fetcher.submit(
          { intent: "toggle", field, value: String(e.currentTarget.checked) },
          { method: "post" },
        )
      }
    />
  );
}

function AdminTable({
  admins,
  currentUserId,
}: {
  admins: { userId: string; name: string; email: string }[];
  currentUserId: string;
}) {
  const fetcher = useFetcher<{ error?: string; message?: string }>();

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't remove",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]);

  return (
    <Table>
      <Table.Tbody>
        {admins.map((a) => (
          <Table.Tr key={a.userId}>
            <Table.Td>
              <Text fw={500}>{a.name}</Text>
              <Text size="xs" c="dimmed">
                {a.email}
              </Text>
            </Table.Td>
            <Table.Td ta="right">
              {a.userId === currentUserId ? (
                <Badge variant="light" color="gray">
                  you
                </Badge>
              ) : (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  loading={
                    fetcher.state !== "idle" &&
                    fetcher.formData?.get("userId") === a.userId
                  }
                  onClick={() =>
                    fetcher.submit(
                      { intent: "removeAdmin", userId: a.userId },
                      { method: "post" },
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function FeedbackActions({ id }: { id: string }) {
  const fetcher = useFetcher<{ error?: string; message?: string }>();
  const busy = fetcher.state !== "idle";
  return (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      <Button
        size="compact-xs"
        variant="light"
        loading={busy && fetcher.formData?.get("intent") === "feedbackDone"}
        onClick={() =>
          fetcher.submit({ intent: "feedbackDone", id }, { method: "post" })
        }
      >
        Done
      </Button>
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        loading={busy && fetcher.formData?.get("intent") === "deleteFeedback"}
        onClick={() =>
          fetcher.submit({ intent: "deleteFeedback", id }, { method: "post" })
        }
      >
        Delete
      </Button>
    </Group>
  );
}

function AddAdminForm() {
  const fetcher = useFetcher<{ error?: string; message?: string }>();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({
        color: "red",
        title: "Couldn't add",
        message: fetcher.data.error,
      });
    } else if (fetcher.data?.message) {
      notifications.show({
        title: "Super admins",
        message: fetcher.data.message,
      });
      ref.current?.reset();
    }
  }, [fetcher.data]);

  return (
    <fetcher.Form method="post" ref={ref}>
      <input type="hidden" name="intent" value="addAdmin" />
      <Group align="flex-end" gap="sm">
        <TextInput
          name="email"
          type="email"
          label="Add a super admin by email"
          placeholder="person@example.com"
          style={{ flex: 1 }}
          required
        />
        <Button type="submit" loading={fetcher.state !== "idle"}>
          Add
        </Button>
      </Group>
    </fetcher.Form>
  );
}
