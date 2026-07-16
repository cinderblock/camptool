import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { useState } from "react";
import {
  Link,
  data,
  useFetcher,
  useNavigate,
  useRevalidator,
} from "react-router";
import { type Headcount, headcountFor } from "~/lib/attendee.server";
import { authClient } from "~/lib/auth-client";
import { discordEnabled } from "~/lib/auth.server";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates } from "~/lib/features.server";
import { getInstanceSettings, isSuperAdmin } from "~/lib/instance.server";
import { type Role, hasAtLeast } from "~/lib/permissions";
import { pendingApplicationWhere } from "~/lib/recruits.server";
import { dateLabel, timeRangeLabel, todayIso } from "~/lib/schedule";
import { loadAgenda } from "~/lib/schedule.server";
import { resolveActiveCamp } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import { db } from "../../../db/client.server";
import {
  account,
  announcement,
  camp,
  contributionTier,
  financeEntry,
  mapObject,
  memberRequirement,
  membership,
  recruitApplication,
  user as userTable,
} from "../../../db/schema";
import type { Route } from "./+types/index";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Dashboard · CampTool" }];
}

type ScheduleCard = {
  myShifts: {
    gatheringId: string;
    title: string;
    date: string;
    startTime: string | null;
    endTime: string | null;
    waitlisted: boolean;
  }[];
  understaffedDays: number;
};

const ROLE_COLOR: Record<Role, string> = {
  admin: "red",
  officer: "orange",
  member: "blue",
  recruit: "gray",
};

export async function loader({ request }: Route.LoaderArgs) {
  const { user, active, activeEdition } = await resolveActiveCamp(request);

  const hasDiscord = active
    ? (
        await db
          .select({ id: account.id })
          .from(account)
          .where(
            and(eq(account.userId, user.id), eq(account.providerId, "discord")),
          )
          .limit(1)
      ).length > 0
    : false;

  let memberCount = 0;
  if (active) {
    const [row] = await db
      .select({ value: count() })
      .from(membership)
      .where(eq(membership.organizationId, active.camp.id));
    memberCount = row?.value ?? 0;
  }

  // Only compute the camp-creation gate when the user has no camp yet (the only
  // time the create form shows).
  let canCreateCamp = true;
  // A camp-less user may be an applicant waiting on review — surface those
  // applications instead of the bare "no camp" screen.
  let pendingApplications: { campName: string; slug: string | null }[] = [];
  if (!active) {
    canCreateCamp =
      (await isSuperAdmin(user.id)) ||
      (await getInstanceSettings()).allowCampCreation;
    pendingApplications = await db
      .select({ campName: camp.name, slug: camp.slug })
      .from(recruitApplication)
      .innerJoin(camp, eq(recruitApplication.campId, camp.id))
      .where(pendingApplicationWhere(user));
  }

  // Home dashboard: latest news + the viewer's to-dos for the active year.
  let overview: {
    year: number;
    isOfficer: boolean;
    features: {
      announcements: boolean;
      bringing: boolean;
      roster: boolean;
    };
    announcements: { id: string; title: string; pinned: boolean }[];
    setupPending: number;
    bringingCount: number;
    pendingApprovals: number;
    dues: { expected: number; paid: number; owed: number } | null;
    headcount: Headcount | null;
    schedule: ScheduleCard | null;
  } | null = null;
  if (active && activeEdition) {
    const editionId = activeEdition.id;
    const mid = active.membership.id;
    const role = active.membership.role;
    const isOfficer = hasAtLeast(role, "officer");
    // Cards and to-dos for features this viewer can't see are omitted — no
    // nudging toward pages that would bounce (see plans/camp-features.md).
    const featureStates = await loadFeatureStates(active.camp.id);
    const seeFeature = (key: Parameters<typeof featureStates.get>[0]) =>
      featureVisibleTo(featureStates.get(key) ?? "off", role);

    const anns = seeFeature("announcements")
      ? (
          await db
            .select({
              id: announcement.id,
              title: announcement.title,
              pinned: announcement.pinned,
              createdAt: announcement.createdAt,
            })
            .from(announcement)
            .where(eq(announcement.editionId, editionId))
        )
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return b.createdAt.getTime() - a.createdAt.getTime();
          })
          .slice(0, 3)
          .map((a) => ({ id: a.id, title: a.title, pinned: a.pinned }))
      : [];

    let bringingCount = 0;
    if (seeFeature("bringing")) {
      const [bring] = await db
        .select({ value: count() })
        .from(mapObject)
        .where(
          and(
            eq(mapObject.editionId, editionId),
            eq(mapObject.ownerMembershipId, mid),
          ),
        );
      bringingCount = bring?.value ?? 0;
    }

    let pendingApprovals = 0;
    if (isOfficer && seeFeature("map")) {
      const [p] = await db
        .select({ value: count() })
        .from(mapObject)
        .where(
          and(
            eq(mapObject.editionId, editionId),
            isNotNull(mapObject.pendingAt),
          ),
        );
      pendingApprovals = p?.value ?? 0;
    }

    let setupPending = 0;
    if (!isOfficer) {
      const state = await loadWizardState({
        campId: active.camp.id,
        editionId,
        membershipId: mid,
        role,
        year: activeEdition.year,
      });
      setupPending = state.pending.length;
    }

    // The viewer's own dues status (only if the camp uses the Dues feature).
    let dues: { expected: number; paid: number; owed: number } | null = null;
    if (seeFeature("dues")) {
      const [mr] = await db
        .select({
          tierId: memberRequirement.tierId,
          waived: memberRequirement.waived,
        })
        .from(memberRequirement)
        .where(
          and(
            eq(memberRequirement.editionId, editionId),
            eq(memberRequirement.membershipId, mid),
          ),
        )
        .limit(1);
      let expected: number | null = null;
      if (mr?.waived) {
        expected = 0;
      } else if (mr?.tierId) {
        const [tier] = await db
          .select({ expectedCents: contributionTier.expectedCents })
          .from(contributionTier)
          .where(eq(contributionTier.id, mr.tierId))
          .limit(1);
        expected = tier?.expectedCents ?? null;
      }
      if (expected != null) {
        const [paidRow] = await db
          .select({ cents: sql<number>`sum(${financeEntry.amountCents})` })
          .from(financeEntry)
          .where(
            and(
              eq(financeEntry.editionId, editionId),
              eq(financeEntry.kind, "donation"),
              eq(financeEntry.memberId, mid),
            ),
          );
        const paid = Number(paidRow?.cents) || 0;
        dues = { expected, paid, owed: Math.max(0, expected - paid) };
      }
    }

    // Upcoming schedule: the viewer's next shifts + (officers) days that
    // still need people.
    let schedule: ScheduleCard | null = null;
    if (seeFeature("schedule")) {
      const agenda = await loadAgenda(editionId, mid);
      const upcoming = agenda.filter(
        (r) => !r.cancelled && r.date >= todayIso(),
      );
      schedule = {
        myShifts: upcoming
          .filter((r) => r.mine === "signed_up" || r.mine === "waitlisted")
          .slice(0, 3)
          .map((r) => ({
            gatheringId: r.gatheringId,
            title: r.title,
            date: r.date,
            startTime: r.startTime,
            endTime: r.endTime,
            waitlisted: r.mine === "waitlisted",
          })),
        understaffedDays: isOfficer
          ? upcoming.filter((r) => r.needed > 0 && r.committed < r.needed)
              .length
          : 0,
      };
    }

    overview = {
      year: activeEdition.year,
      isOfficer,
      features: {
        announcements: seeFeature("announcements"),
        bringing: seeFeature("bringing"),
        roster: seeFeature("roster"),
      },
      announcements: anns,
      setupPending,
      bringingCount,
      pendingApprovals,
      dues,
      headcount: seeFeature("roster") ? await headcountFor(editionId) : null,
      schedule,
    };
  }

  return {
    userName: user.name,
    userEmail: user.email,
    discordEnabled,
    hasDiscord,
    memberCount,
    canCreateCamp,
    pendingApplications,
    overview,
    active: active
      ? { campName: active.camp.name, role: active.membership.role }
      : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active } = await resolveActiveCamp(request);
  const form = await request.formData();
  if (String(form.get("intent")) !== "updateContact") {
    return data({ error: "Unknown action." }, { status: 400 });
  }
  // Self-serve typo fix for camp-less applicants only — members edit their
  // profile through the wizard/members flows, and their email is load-bearing
  // for more than an application row.
  if (active) {
    return data(
      { error: "Edit your profile from Finish setup." },
      {
        status: 403,
      },
    );
  }

  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  if (!name || name.length > 200) {
    return data({ error: "Please enter your name." }, { status: 400 });
  }
  if (!/^\S+@\S+$/.test(email) || email.length > 254) {
    return data({ error: "That email doesn't look right." }, { status: 400 });
  }

  const oldEmail = user.email;
  if (email !== oldEmail) {
    const [taken] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);
    if (taken && taken.id !== user.id) {
      return data(
        { error: "That email is already in use by another account." },
        { status: 400 },
      );
    }
  }

  await db
    .update(userTable)
    .set({
      name,
      email,
      // A changed address was never verified; reset so nothing trusts it.
      ...(email !== oldEmail ? { emailVerified: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(userTable.id, user.id));

  // Keep what the reviewing officers see in sync with the fix.
  await db
    .update(recruitApplication)
    .set({ name, email })
    .where(pendingApplicationWhere({ id: user.id, email: oldEmail }));

  return data({ ok: "Saved — the camp will use your updated details." });
}

export default function DashboardIndex({ loaderData }: Route.ComponentProps) {
  if (!loaderData.active)
    return (
      <NoCampYet
        canCreateCamp={loaderData.canCreateCamp}
        pendingApplications={loaderData.pendingApplications}
        userName={loaderData.userName}
        userEmail={loaderData.userEmail}
      />
    );
  return <CampOverview loaderData={loaderData} />;
}

function CampOverview({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { memberCount, discordEnabled, hasDiscord, overview } = loaderData;
  const active = loaderData.active as NonNullable<typeof loaderData.active>;
  const role = active.role as Role;
  const [busy, setBusy] = useState(false);

  // The viewer's to-dos for the active year (action items first).
  const todos: { key: string; label: string; to?: string }[] = [];
  if (overview) {
    if (overview.setupPending > 0)
      todos.push({
        key: "setup",
        label: `Finish setup — ${overview.setupPending} ${overview.setupPending === 1 ? "item" : "items"} left`,
        to: "/start",
      });
    if (overview.features.bringing && overview.bringingCount === 0)
      todos.push({
        key: "bringing",
        label: "Tell us what you're bringing",
        to: "/bringing",
      });
    if (overview.dues && overview.dues.owed > 0)
      todos.push({
        key: "dues",
        label: `Dues: $${(overview.dues.owed / 100).toFixed(2)} of $${(overview.dues.expected / 100).toFixed(2)} still due`,
      });
    if (overview.pendingApprovals > 0)
      todos.push({
        key: "approvals",
        label: `${overview.pendingApprovals} map change${overview.pendingApprovals === 1 ? "" : "s"} need your approval`,
        to: "/map",
      });
  }

  async function addPasskey() {
    setBusy(true);
    const res = await authClient.passkey.addPasskey({ name: "My device" });
    setBusy(false);
    if (res?.error) {
      notifications.show({
        color: "red",
        title: "Passkey",
        message: res.error.message ?? "Could not register passkey",
      });
      return;
    }
    notifications.show({ title: "Passkey", message: "Passkey registered." });
  }

  async function linkDiscord() {
    await authClient.linkSocial({
      provider: "discord",
      callbackURL: "/",
    });
  }

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={1} size="h2">
              {active.campName}
            </Title>
            <Text c="dimmed">Welcome back, {loaderData.userName}.</Text>
          </div>
          <Badge color={ROLE_COLOR[role]} size="lg" variant="light">
            {role}
          </Badge>
        </Group>

        {overview ? (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Card withBorder padding="lg" radius="md">
              <Group justify="space-between" mb="xs">
                <Text fw={600}>Your to-do</Text>
                <Badge size="sm" variant="light" color="gray">
                  {overview.year}
                </Badge>
              </Group>
              {todos.length === 0 ? (
                <Text size="sm" c="dimmed">
                  You're all caught up. 🎉
                </Text>
              ) : (
                <Stack gap="xs">
                  {todos.map((t) => (
                    <Group key={t.key} justify="space-between" wrap="nowrap">
                      <Text size="sm">{t.label}</Text>
                      {t.to ? (
                        <Button
                          component={Link}
                          to={t.to}
                          size="compact-xs"
                          variant="light"
                        >
                          Go
                        </Button>
                      ) : null}
                    </Group>
                  ))}
                </Stack>
              )}
            </Card>

            {overview.features.announcements ? (
              <Card withBorder padding="lg" radius="md">
                <Group justify="space-between" mb="xs">
                  <Text fw={600}>Announcements</Text>
                  <Anchor component={Link} to="/announcements" size="xs">
                    View all
                  </Anchor>
                </Group>
                {overview.announcements.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No announcements yet.
                  </Text>
                ) : (
                  <Stack gap={6}>
                    {overview.announcements.map((a) => (
                      <Group key={a.id} gap={6} wrap="nowrap">
                        {a.pinned ? (
                          <Badge size="xs" variant="light" color="yellow">
                            pinned
                          </Badge>
                        ) : null}
                        <Anchor
                          component={Link}
                          to="/announcements"
                          size="sm"
                          lineClamp={1}
                        >
                          {a.title}
                        </Anchor>
                      </Group>
                    ))}
                  </Stack>
                )}
              </Card>
            ) : null}

            {overview.schedule ? (
              <Card withBorder padding="lg" radius="md">
                <Group justify="space-between" mb="xs">
                  <Text fw={600}>Your shifts</Text>
                  <Anchor component={Link} to="/schedule" size="xs">
                    Schedule
                  </Anchor>
                </Group>
                {overview.schedule.myShifts.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    Nothing signed up yet — see what's coming on the schedule.
                  </Text>
                ) : (
                  <Stack gap={6}>
                    {overview.schedule.myShifts.map((s) => (
                      <Group
                        key={`${s.gatheringId}-${s.date}`}
                        gap={6}
                        wrap="nowrap"
                      >
                        {s.waitlisted ? (
                          <Badge size="xs" variant="light" color="yellow">
                            waitlist
                          </Badge>
                        ) : null}
                        <Anchor
                          component={Link}
                          to={`/schedule/${s.gatheringId}`}
                          size="sm"
                          lineClamp={1}
                        >
                          {dateLabel(s.date)} · {s.title}
                          {s.startTime
                            ? ` · ${timeRangeLabel(s.startTime, s.endTime)}`
                            : ""}
                        </Anchor>
                      </Group>
                    ))}
                  </Stack>
                )}
                {overview.schedule.understaffedDays > 0 ? (
                  <Text size="xs" c="orange" mt="xs">
                    {overview.schedule.understaffedDays}{" "}
                    {overview.schedule.understaffedDays === 1 ? "day" : "days"}{" "}
                    still need people.
                  </Text>
                ) : null}
              </Card>
            ) : null}
          </SimpleGrid>
        ) : null}

        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          <Card withBorder padding="lg" radius="md">
            <Text size="xl" fw={700}>
              {memberCount}
            </Text>
            <Text size="sm" c="dimmed">
              {memberCount === 1 ? "member" : "members"}
            </Text>
          </Card>

          {overview?.headcount ? (
            <Card withBorder padding="lg" radius="md">
              <Group justify="space-between" mb={2}>
                <Text size="xl" fw={700}>
                  {overview.headcount.total}
                </Text>
                <Anchor component={Link} to="/roster" size="xs">
                  Roster
                </Anchor>
              </Group>
              <Text size="sm" c="dimmed">
                coming to {overview.year}
                {overview.headcount.guests > 0
                  ? ` · ${overview.headcount.membersComing} member${overview.headcount.membersComing === 1 ? "" : "s"} + ${overview.headcount.guests} guest${overview.headcount.guests === 1 ? "" : "s"}`
                  : ""}
              </Text>
            </Card>
          ) : null}

          <Card withBorder padding="lg" radius="md">
            <Text fw={600}>Passkey</Text>
            <Text size="sm" c="dimmed" mb="sm">
              Add a passkey for fast, passwordless sign-in.
            </Text>
            <Button
              size="xs"
              variant="light"
              onClick={addPasskey}
              loading={busy}
            >
              Register a passkey
            </Button>
          </Card>

          <Card withBorder padding="lg" radius="md">
            <Text fw={600}>Discord</Text>
            {hasDiscord ? (
              <Text size="sm" c="green">
                Linked
              </Text>
            ) : discordEnabled ? (
              <>
                <Text size="sm" c="dimmed" mb="sm">
                  Link your Discord to verify camp membership.
                </Text>
                <Button
                  size="xs"
                  variant="light"
                  color="indigo"
                  onClick={linkDiscord}
                >
                  Link Discord
                </Button>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                Discord not configured on this deployment.
              </Text>
            )}
          </Card>
        </SimpleGrid>
      </Stack>
    </Container>
  );
}

function NoCampYet({
  canCreateCamp,
  pendingApplications,
  userName,
  userEmail,
}: {
  canCreateCamp: boolean;
  pendingApplications: { campName: string; slug: string | null }[];
  userName: string;
  userEmail: string;
}) {
  // An applicant waiting on review shouldn't see camp-creation messaging — show
  // their application status instead.
  if (pendingApplications.length > 0) {
    return (
      <Container size="sm">
        <Stack gap="md">
          <Title order={1} size="h2">
            Application pending
          </Title>
          {pendingApplications.map((a) => (
            <Card withBorder padding="lg" radius="md" key={a.campName}>
              <Text fw={600}>{a.campName}</Text>
              <Text size="sm" c="dimmed" mt={4}>
                Your application is in — the camp will reach out at{" "}
                <b>{userEmail}</b>. There's nothing else you need to do right
                now.
              </Text>
              {a.slug ? (
                <Anchor component={Link} to={`/c/${a.slug}`} size="sm" mt="sm">
                  View your application page
                </Anchor>
              ) : null}
            </Card>
          ))}
          <ContactFix userName={userName} userEmail={userEmail} />
        </Stack>
      </Container>
    );
  }

  if (!canCreateCamp) {
    return (
      <Container size="sm">
        <Stack gap="md">
          <Title order={1} size="h2">
            No camp yet
          </Title>
          <Text c="dimmed">
            New camp creation is currently turned off on this deployment. Ask a
            site administrator to create your camp or to re-enable camp
            creation.
          </Text>
        </Stack>
      </Container>
    );
  }

  return <CreateCampForm />;
}

/** Inline typo fix for the name/email an applicant signed up with — the only
 * contact info the camp has for them. Shown only on the pending-application
 * dashboard; the action rejects users who already have a camp. */
function ContactFix({
  userName,
  userEmail,
}: {
  userName: string;
  userEmail: string;
}) {
  const fetcher = useFetcher<{ ok?: string; error?: string }>();
  const [name, setName] = useState(userName);
  const [email, setEmail] = useState(userEmail);
  const dirty = name !== userName || email !== userEmail;
  const busy = fetcher.state !== "idle";

  return (
    <Card withBorder padding="lg" radius="md">
      <Text fw={600}>Your contact details</Text>
      <Text size="sm" c="dimmed" mt={4} mb="sm">
        Typo in your name or email? Fix it here — the camp sees these on your
        application, and your email is how you sign in.
      </Text>
      {fetcher.data?.error ? (
        <Text size="sm" c="red" mb="xs" role="alert">
          {fetcher.data.error}
        </Text>
      ) : null}
      {fetcher.data?.ok && !dirty ? (
        <Text component="output" display="block" size="sm" c="green" mb="xs">
          {fetcher.data.ok}
        </Text>
      ) : null}
      <Stack gap="xs">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        {dirty ? (
          <Group justify="flex-end">
            <Button
              size="xs"
              loading={busy}
              onClick={() =>
                fetcher.submit(
                  { intent: "updateContact", name, email },
                  { method: "post" },
                )
              }
            >
              Save
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

function CreateCampForm() {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  function slugify(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await authClient.organization.create({
      name: name.trim(),
      slug,
    });
    if (error || !data) {
      setBusy(false);
      notifications.show({
        color: "red",
        title: "Could not create camp",
        message: error?.message ?? "Unknown error",
      });
      return;
    }
    await authClient.organization.setActive({ organizationId: data.id });
    setBusy(false);
    revalidator.revalidate();
    navigate("/");
  }

  return (
    <Container size="sm">
      <Stack gap="md">
        <div>
          <Title order={1} size="h2">
            Create your camp
          </Title>
          <Text c="dimmed">
            You're not part of a camp yet. Create one to get started — you'll be
            its first admin.
          </Text>
        </div>
        <TextInput
          label="Camp name"
          placeholder="e.g. Math Camp"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Group>
          <Button onClick={create} loading={busy} disabled={!name.trim()}>
            Create camp
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
