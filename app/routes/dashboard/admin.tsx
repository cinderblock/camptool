import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Container,
  CopyButton,
  Group,
  Menu,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, asc, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, redirect, useFetcher } from "react-router";
import { LocalTime } from "~/components/LocalTime";
import {
  createSetupLink,
  deleteCamp,
  renameCampSlug,
  SETUP_LINK_DAYS,
  setSetupLinkSlug,
  setupLinkState,
} from "~/lib/camp-admin.server";
import { campOrigin, isValidCampSlug } from "~/lib/camp-host";
import { listMovesOut } from "~/lib/camp-move/move-out.server";
import { APEX, CAMP_SUBDOMAINS } from "~/lib/env.server";
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
import { db } from "../../../db/client.server";
import {
  camp,
  campMoveIn,
  campSetupLink,
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

  // Every camp on the deployment, for the hoster: where it lives, how big it
  // is, and its admins (whom a super admin can work as without joining).
  const campRows = await db
    .select({
      id: camp.id,
      name: camp.name,
      slug: camp.slug,
      members: count(membership.id),
    })
    .from(camp)
    .leftJoin(membership, eq(membership.organizationId, camp.id))
    .groupBy(camp.id)
    .orderBy(asc(camp.name));
  const campAdmins = campRows.length
    ? await db
        .select({
          campId: membership.organizationId,
          userId: membership.userId,
          adminName: userTable.name,
        })
        .from(membership)
        .innerJoin(userTable, eq(membership.userId, userTable.id))
        .where(
          and(
            eq(membership.role, "admin"),
            inArray(
              membership.organizationId,
              campRows.map((c) => c.id),
            ),
          ),
        )
    : [];
  const camps = campRows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    members: c.members,
    // Where to post "work as": the camp's own address with subdomains on.
    origin:
      CAMP_SUBDOMAINS && c.slug && isValidCampSlug(c.slug)
        ? campOrigin(c.slug, APEX)
        : "",
    admins: campAdmins
      .filter((a) => a.campId === c.id)
      .map((a) => ({ userId: a.userId, adminName: a.adminName })),
  }));

  // Setup links still waiting to be used, newest first.
  const setupLinks = (
    await db
      .select()
      .from(campSetupLink)
      .where(and(isNull(campSetupLink.usedAt), isNull(campSetupLink.revokedAt)))
      .orderBy(desc(campSetupLink.createdAt))
  )
    .filter((l) => setupLinkState(l) === "ok")
    .map((l) => ({
      id: l.id,
      label: l.label,
      url: `${APEX.origin}/new-camp/${l.token}`,
      expires: l.expiresAt.toISOString(),
      slug: l.slug,
    }));

  // Camps moving between this site and others (plans/camp-portability.md).
  const movesOut = (await listMovesOut()).slice(0, 20).map((m) => ({
    id: m.id,
    campName: m.campName,
    state: m.state,
    target: m.targetCampUrl,
    created: m.createdAt.toISOString(),
    windowEnds: m.windowEndsAt?.toISOString() ?? null,
  }));
  const movesIn = (
    await db
      .select({
        id: campMoveIn.id,
        campName: camp.name,
        from: campMoveIn.sourceCampUrl,
        created: campMoveIn.createdAt,
        windowEnds: campMoveIn.windowEndsAt,
      })
      .from(campMoveIn)
      .innerJoin(camp, eq(camp.id, campMoveIn.campId))
      .orderBy(desc(campMoveIn.createdAt))
      .limit(20)
  ).map((m) => ({
    ...m,
    created: m.created.toISOString(),
    windowEnds: m.windowEnds.toISOString(),
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
    setupLinks,
    movesOut,
    movesIn,
    setupLinkDays: SETUP_LINK_DAYS,
    apexHost: CAMP_SUBDOMAINS ? APEX.host : null,
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

  if (intent === "createSetupLink") {
    const made = await createSetupLink({
      label: String(form.get("label") ?? ""),
      createdByUserId: session.user.id,
      slug: String(form.get("slug") ?? ""),
    });
    if (!made.ok) return data({ error: made.error }, { status: 400 });
    return data({ ok: true, url: `${APEX.origin}/new-camp/${made.token}` });
  }

  if (intent === "setSetupLinkSlug") {
    const problem = await setSetupLinkSlug(
      String(form.get("id") ?? ""),
      String(form.get("slug") ?? ""),
    );
    if (problem) return data({ error: problem }, { status: 400 });
    return data({ ok: true });
  }

  if (intent === "revokeSetupLink") {
    await db
      .update(campSetupLink)
      .set({ revokedAt: new Date() })
      .where(eq(campSetupLink.id, String(form.get("id") ?? "")));
    return data({ ok: true, message: "Link withdrawn." });
  }

  if (intent === "renameCamp") {
    const problem = await renameCampSlug(
      String(form.get("campId") ?? ""),
      String(form.get("slug") ?? "")
        .trim()
        .toLowerCase(),
    );
    if (problem) return data({ error: problem }, { status: 400 });
    return data({ ok: true, message: "Address changed." });
  }

  if (intent === "deleteCamp") {
    const campId = String(form.get("campId") ?? "");
    const [row] = await db
      .select({ slug: camp.slug, name: camp.name })
      .from(camp)
      .where(eq(camp.id, campId));
    if (!row) return data({ error: "No such camp." }, { status: 404 });
    // Typed back by hand, so a slip of the mouse can't take a whole camp.
    if (String(form.get("confirm") ?? "").trim() !== (row.slug ?? row.name)) {
      return data(
        { error: "That doesn't match the camp's address." },
        { status: 400 },
      );
    }
    await deleteCamp(campId);
    return data({ ok: true, message: `${row.name} deleted.` });
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
    setupLinks,
    movesOut,
    movesIn,
    setupLinkDays,
    apexHost,
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
              camp. You can work as any of them without joining it.
            </Text>
            <CampsTable camps={camps} apexHost={apexHost} />
            <SetupLinks
              links={setupLinks}
              days={setupLinkDays}
              apexHost={apexHost}
            />
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="lg">
          <Stack gap="md">
            <Title order={4}>Camp moves</Title>
            <Text size="sm" c="dimmed">
              Camps moving between this site and other CampTool sites. A camp
              admin starts a move under Camp settings; the other site brings it
              in at{" "}
              <Anchor href="/import-camp" size="sm">
                Bring a camp here
              </Anchor>
              . Old links and sign-ins follow a moved camp for a year.
            </Text>
            {movesOut.length + movesIn.length === 0 ? (
              <Text size="sm" c="dimmed">
                None yet.
              </Text>
            ) : (
              <Table striped withTableBorder fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Camp</Table.Th>
                    <Table.Th>Where</Table.Th>
                    <Table.Th>Until</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {movesOut.map((m) => (
                    <Table.Tr key={`out-${m.id}`}>
                      <Table.Td>{m.campName}</Table.Td>
                      <Table.Td>
                        {m.state === "open"
                          ? "Leaving (frozen, code issued)"
                          : m.state === "done"
                            ? `Moved to ${m.target ?? "?"}`
                            : m.state === "ended"
                              ? `Moved to ${m.target ?? "?"} (forwarding over)`
                              : "Move called off"}
                      </Table.Td>
                      <Table.Td>
                        {m.windowEnds && m.state === "done" ? (
                          <LocalTime iso={m.windowEnds} format="YYYY-MM-DD" />
                        ) : (
                          "—"
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {movesIn.map((m) => (
                    <Table.Tr key={`in-${m.id}`}>
                      <Table.Td>{m.campName}</Table.Td>
                      <Table.Td>Arrived from {m.from}</Table.Td>
                      <Table.Td>
                        <LocalTime iso={m.windowEnds} format="YYYY-MM-DD" />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
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

type CampRow = {
  id: string;
  name: string;
  slug: string | null;
  members: number;
  origin: string;
  admins: { userId: string; adminName: string }[];
};

function CampsTable({
  camps,
  apexHost,
}: {
  camps: CampRow[];
  apexHost: string | null;
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
            <Table.Th />
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
                    {c.origin ? (
                      <Anchor href={`${c.origin}/`} size="xs" c="dimmed">
                        {apexHost ? `${c.slug}.${apexHost}` : c.slug}
                      </Anchor>
                    ) : (
                      c.slug
                    )}
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>{c.members}</Table.Td>
              <Table.Td>
                <CampActions camp={c} apexHost={apexHost} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** "Work as" posts to the camp's own address, so the act-as cookie (set per
 * host) lands where the camp is; the sign-in cookie covers every subdomain. */
function workAs(origin: string, campId: string, userId: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = `${origin}/impersonate`;
  for (const [k, v] of Object.entries({
    intent: "start",
    campId,
    targetUserId: userId,
  })) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = k;
    input.value = v;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function CampActions({
  camp: c,
  apexHost,
}: {
  camp: CampRow;
  apexHost: string | null;
}) {
  const [open, setOpen] = useState<"rename" | "delete" | null>(null);
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="xs" variant="default">
            Manage
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {c.admins.length > 0 ? (
            <>
              <Menu.Label>Work as</Menu.Label>
              {c.admins.map((a) => (
                <Menu.Item
                  key={a.userId}
                  onClick={() => workAs(c.origin, c.id, a.userId)}
                >
                  {a.adminName}
                </Menu.Item>
              ))}
              <Menu.Divider />
            </>
          ) : null}
          <Menu.Item onClick={() => setOpen("rename")}>
            Change address…
          </Menu.Item>
          <Menu.Item color="red" onClick={() => setOpen("delete")}>
            Delete camp…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <RenameCampModal
        camp={c}
        apexHost={apexHost}
        opened={open === "rename"}
        onClose={() => setOpen(null)}
      />
      <DeleteCampModal
        camp={c}
        opened={open === "delete"}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function RenameCampModal({
  camp: c,
  apexHost,
  opened,
  onClose,
}: {
  camp: CampRow;
  apexHost: string | null;
  opened: boolean;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [slug, setSlug] = useState(c.slug ?? "");
  const done = fetcher.state === "idle" && fetcher.data?.ok;
  useEffect(() => {
    if (done) onClose();
  }, [done, onClose]);
  return (
    <Modal opened={opened} onClose={onClose} title={`Address of ${c.name}`}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="renameCamp" />
        <input type="hidden" name="campId" value={c.id} />
        <Stack gap="md">
          {fetcher.data?.error ? (
            <Alert color="red">{fetcher.data.error}</Alert>
          ) : null}
          <TextInput
            label="New address"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
            rightSection={
              apexHost ? (
                <Text size="sm" c="dimmed" pr="xs">
                  .{apexHost}
                </Text>
              ) : undefined
            }
            rightSectionWidth={apexHost ? apexHost.length * 8 + 24 : undefined}
          />
          <Text size="xs" c="dimmed">
            Old links to this camp stop working. Its members stay signed in.
          </Text>
          <Group justify="flex-end">
            <Button
              type="submit"
              loading={fetcher.state !== "idle"}
              disabled={!slug || slug === c.slug}
            >
              Change address
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
    </Modal>
  );
}

function DeleteCampModal({
  camp: c,
  opened,
  onClose,
}: {
  camp: CampRow;
  opened: boolean;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [typed, setTyped] = useState("");
  const want = c.slug ?? c.name;
  return (
    <Modal opened={opened} onClose={onClose} title={`Delete ${c.name}?`}>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="deleteCamp" />
        <input type="hidden" name="campId" value={c.id} />
        <Stack gap="md">
          <Text size="sm">
            This removes the camp and everything in it for good: its {c.members}{" "}
            member{c.members === 1 ? "" : "s"}' memberships, every year's map,
            pages, money records and uploaded files. People's accounts stay.
            There is no undo (short of restoring a backup).
          </Text>
          {fetcher.data?.error ? (
            <Alert color="red">{fetcher.data.error}</Alert>
          ) : null}
          <TextInput
            label={
              <>
                Type <Code>{want}</Code> to confirm
              </>
            }
            name="confirm"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            autoComplete="off"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              color="red"
              loading={fetcher.state !== "idle"}
              disabled={typed.trim() !== want}
            >
              Delete camp
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
    </Modal>
  );
}

type SetupLinkRow = {
  id: string;
  label: string;
  url: string;
  expires: string;
  slug: string | null;
};

/** The `.camptool.org` after an address field, when camps get subdomains. */
function addressSuffix(apexHost: string | null) {
  return apexHost
    ? {
        rightSection: (
          <Text size="sm" c="dimmed" pr="xs" style={{ whiteSpace: "nowrap" }}>
            .{apexHost}
          </Text>
        ),
        rightSectionWidth: apexHost.length * 8 + 24,
      }
    : {};
}

function SetupLinks({
  links,
  days,
  apexHost,
}: {
  links: SetupLinkRow[];
  days: number;
  apexHost: string | null;
}) {
  const fetcher = useFetcher<{ ok?: boolean; url?: string; error?: string }>();
  const formRef = useRef<HTMLFormElement>(null);
  const made = fetcher.data?.url;
  useEffect(() => {
    if (made) formRef.current?.reset();
  }, [made]);
  return (
    <Stack gap="xs">
      <Title order={5}>Start a new camp</Title>
      <Text size="sm" c="dimmed">
        Make a one-use link and send it to the camp's lead. They make their
        account, name the camp and become its first admin. Pick the camp's
        address here, or leave it blank to let them pick. You don't join it.
        Links last {days} days.
      </Text>
      <fetcher.Form method="post" ref={formRef}>
        <input type="hidden" name="intent" value="createSetupLink" />
        <Group align="flex-end" gap="xs">
          <TextInput
            name="label"
            label="Who it's for"
            placeholder="e.g. Alex, Entheos"
            required
            style={{ flex: 1, minWidth: 160 }}
          />
          <TextInput
            name="slug"
            label="Address (optional)"
            placeholder="they pick"
            onChange={(e) => {
              e.currentTarget.value = e.currentTarget.value.toLowerCase();
            }}
            style={{ flex: 1, minWidth: 200 }}
            {...addressSuffix(apexHost)}
          />
          <Button type="submit" loading={fetcher.state !== "idle"}>
            Make link
          </Button>
        </Group>
        {fetcher.data?.error ? (
          <Alert color="red" mt="xs">
            {fetcher.data.error}
          </Alert>
        ) : null}
      </fetcher.Form>
      {links.length > 0 ? (
        <Table verticalSpacing="xs">
          <Table.Tbody>
            {links.map((l) => (
              <Table.Tr key={l.id}>
                <Table.Td>
                  <Text size="sm">{l.label}</Text>
                  <Text size="xs" c="dimmed">
                    {l.slug
                      ? apexHost
                        ? `${l.slug}.${apexHost}`
                        : l.slug
                      : "they pick the address"}
                    {" · "}good until {l.expires.slice(0, 10)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <CopyButton value={l.url}>
                      {({ copied, copy }) => (
                        <Button
                          size="xs"
                          variant={
                            copied || made === l.url ? "filled" : "light"
                          }
                          onClick={copy}
                        >
                          {copied ? "Copied" : "Copy link"}
                        </Button>
                      )}
                    </CopyButton>
                    <LinkAddress link={l} apexHost={apexHost} />
                    <RevokeLink id={l.id} />
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : null}
    </Stack>
  );
}

/** Pick or change the address an open setup link's camp gets. */
function LinkAddress({
  link: l,
  apexHost,
}: {
  link: SetupLinkRow;
  apexHost: string | null;
}) {
  const [opened, setOpened] = useState(false);
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [slug, setSlug] = useState(l.slug ?? "");
  const done = fetcher.state === "idle" && fetcher.data?.ok;
  useEffect(() => {
    if (done) setOpened(false);
  }, [done]);
  return (
    <>
      <Button size="xs" variant="subtle" onClick={() => setOpened(true)}>
        Address…
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={`Address for ${l.label}'s camp`}
      >
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="setSetupLinkSlug" />
          <input type="hidden" name="id" value={l.id} />
          <Stack gap="md">
            {fetcher.data?.error ? (
              <Alert color="red">{fetcher.data.error}</Alert>
            ) : null}
            <TextInput
              label="Address"
              description="Leave blank to let them pick."
              name="slug"
              value={slug}
              onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
              {...addressSuffix(apexHost)}
            />
            <Group justify="flex-end">
              <Button
                type="submit"
                loading={fetcher.state !== "idle"}
                disabled={slug === (l.slug ?? "")}
              >
                Save
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Modal>
    </>
  );
}

function RevokeLink({ id }: { id: string }) {
  const fetcher = useFetcher();
  return (
    <Button
      size="xs"
      variant="subtle"
      color="red"
      loading={fetcher.state !== "idle"}
      onClick={() =>
        fetcher.submit({ intent: "revokeSetupLink", id }, { method: "post" })
      }
    >
      Withdraw
    </Button>
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
