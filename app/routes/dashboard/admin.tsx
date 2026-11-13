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
import { asc, count, desc, eq, ne } from "drizzle-orm";
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
import { redact } from "~/lib/privacy.server";
import {
  assertWritable,
  requireUser,
  resolveActiveCamp,
} from "~/lib/session.server";
import {
  parseStructurePacks,
  perCampPacks,
  serializeStructurePacks,
} from "~/theme";
import { db } from "../../../db/client.server";
import {
  camp,
  clientError,
  feedback,
  membership,
  user as userTable,
} from "../../../db/schema";
import type { Route } from "./+types/admin";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Site admin · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/");
  const { privacy } = await resolveActiveCamp(request);

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

  // Every camp on the deployment, for the hoster: who's here, and which
  // per-camp structure packs each one has.
  const camps = (
    await db
      .select({
        id: camp.id,
        name: camp.name,
        slug: camp.slug,
        structurePacks: camp.structurePacks,
        members: count(membership.id),
      })
      .from(camp)
      .leftJoin(membership, eq(membership.organizationId, camp.id))
      .groupBy(camp.id)
      .orderBy(asc(camp.name))
  ).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    members: c.members,
    packs: parseStructurePacks(c.structurePacks),
  }));

  // Site admin spans every camp, so the lens's free-text vocabulary (which is
  // camp-scoped) won't know other camps' people — but the field rules do the
  // heavy lifting here, and names/emails/telemetry are keyed, not prose.
  return redact(privacy, {
    settings,
    currentUserId: session.user.id,
    admins: admins.map((a) => ({
      userId: a.userId,
      name: a.name,
      email: a.email,
    })),
    recentErrors,
    recentFeedback,
    camps,
    perCampPacks,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) throw redirect("/");
  // This route authorizes via requireUser, so it misses the read-only guard
  // that resolveActiveCamp applies to every camp-scoped action.
  assertWritable(
    (await resolveActiveCamp(request, { allowWrite: true })).privacy,
  );

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

  // Switch a per-camp structure pack on or off for one camp.
  if (intent === "setCampPack") {
    const campId = String(form.get("campId") ?? "");
    const pack = String(form.get("pack") ?? "");
    const on = String(form.get("on") ?? "") === "true";
    if (!perCampPacks.some((p) => p.key === pack)) {
      return data({ error: "Unknown structure pack." }, { status: 400 });
    }
    const [row] = await db
      .select({ structurePacks: camp.structurePacks })
      .from(camp)
      .where(eq(camp.id, campId));
    if (!row) return data({ error: "No such camp." }, { status: 404 });
    const packs = new Set(parseStructurePacks(row.structurePacks));
    if (on) packs.add(pack);
    else packs.delete(pack);
    await db
      .update(camp)
      .set({ structurePacks: serializeStructurePacks(packs) })
      .where(eq(camp.id, campId));
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
  const {
    settings,
    admins,
    currentUserId,
    recentErrors,
    recentFeedback,
    camps,
    perCampPacks,
  } = loaderData;

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
            <Title order={4}>Camps</Title>
            <Text size="sm" c="dimmed">
              Every camp on this deployment. Each camp's admins run their own
              camp.
              {perCampPacks.length > 0
                ? " Structure packs bundled per camp only show up in the camps you switch them on for."
                : ""}
            </Text>
            <CampsTable camps={camps} packs={perCampPacks} />
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
            <Title order={4}>Backup</Title>
            <Text size="sm" c="dimmed">
              Download a complete backup — the whole database (every camp's
              data) <em>and</em> every uploaded picture at full resolution — as
              a <code>.tar.gz</code>. Safe to take while the app is running;
              keep backups somewhere private.
            </Text>
            <Text size="sm" c="dimmed">
              Restore with{" "}
              <code>tar -xzf &lt;file&gt; -C /srv/camptool/data</code> — the
              archive is laid out to land where it came from. A{" "}
              <code>MANIFEST.txt</code> inside lists what it holds, and flags
              anything already missing before the backup was taken.
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

function CampsTable({
  camps,
  packs,
}: {
  camps: {
    id: string;
    name: string;
    slug: string | null;
    members: number;
    packs: string[];
  }[];
  packs: readonly { key: string; name: string }[];
}) {
  if (camps.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No camps yet.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={360}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Camp</Table.Th>
            <Table.Th>Members</Table.Th>
            {packs.map((p) => (
              <Table.Th key={p.key}>{p.name}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {camps.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {c.name}
                </Text>
                {c.slug ? (
                  <Text size="xs" c="dimmed">
                    {c.slug}
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>{c.members}</Table.Td>
              {packs.map((p) => (
                <Table.Td key={p.key}>
                  <PackSwitch
                    campId={c.id}
                    pack={p.key}
                    on={c.packs.includes(p.key)}
                    label={`${p.name} for ${c.name}`}
                  />
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function PackSwitch({
  campId,
  pack,
  on,
  label,
}: {
  campId: string;
  pack: string;
  on: boolean;
  label: string;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  // Optimistic: show the switch where it's headed while the post is in flight.
  const pending = fetcher.formData?.get("on");
  const checked = pending != null ? pending === "true" : on;
  return (
    <Switch
      checked={checked}
      aria-label={label}
      onChange={(e) =>
        fetcher.submit(
          {
            intent: "setCampPack",
            campId,
            pack,
            on: String(e.currentTarget.checked),
          },
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
    <Table.ScrollContainer minWidth={560}>
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
    </Table.ScrollContainer>
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
