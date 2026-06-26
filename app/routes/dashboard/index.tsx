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
import { Link, useNavigate, useRevalidator } from "react-router";
import { authClient } from "~/lib/auth-client";
import { discordEnabled } from "~/lib/auth.server";
import { getInstanceSettings, isSuperAdmin } from "~/lib/instance.server";
import { type Role, hasAtLeast } from "~/lib/permissions";
import { resolveActiveCamp } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import { db } from "../../../db/client.server";
import {
  account,
  announcement,
  contributionTier,
  financeEntry,
  mapObject,
  memberRequirement,
  membership,
} from "../../../db/schema";
import type { Route } from "./+types/index";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Dashboard · CampTool" }];
}

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
  if (!active) {
    canCreateCamp =
      (await isSuperAdmin(user.id)) ||
      (await getInstanceSettings()).allowCampCreation;
  }

  // Home dashboard: latest news + the viewer's to-dos for the active year.
  let overview: {
    year: number;
    isOfficer: boolean;
    announcements: { id: string; title: string; pinned: boolean }[];
    setupPending: number;
    bringingCount: number;
    pendingApprovals: number;
    dues: { expected: number; paid: number; owed: number } | null;
  } | null = null;
  if (active && activeEdition) {
    const editionId = activeEdition.id;
    const mid = active.membership.id;
    const role = active.membership.role;
    const isOfficer = hasAtLeast(role, "officer");

    const anns = (
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
      .map((a) => ({ id: a.id, title: a.title, pinned: a.pinned }));

    const [bring] = await db
      .select({ value: count() })
      .from(mapObject)
      .where(
        and(
          eq(mapObject.editionId, editionId),
          eq(mapObject.ownerMembershipId, mid),
        ),
      );
    const bringingCount = bring?.value ?? 0;

    let pendingApprovals = 0;
    if (isOfficer) {
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
        editionId,
        membershipId: mid,
        role,
        year: activeEdition.year,
      });
      setupPending = state.pending.length;
    }

    // The viewer's own dues status (only if the camp tracks dues).
    let dues: { expected: number; paid: number; owed: number } | null = null;
    if (active.camp.tracksDues) {
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

    overview = {
      year: activeEdition.year,
      isOfficer,
      announcements: anns,
      setupPending,
      bringingCount,
      pendingApprovals,
      dues,
    };
  }

  return {
    userName: user.name,
    discordEnabled,
    hasDiscord,
    memberCount,
    canCreateCamp,
    overview,
    active: active
      ? { campName: active.camp.name, role: active.membership.role }
      : null,
  };
}

export default function DashboardIndex({ loaderData }: Route.ComponentProps) {
  if (!loaderData.active)
    return <CreateCamp canCreateCamp={loaderData.canCreateCamp} />;
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
    if (overview.bringingCount === 0)
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
            <Title order={2}>{active.campName}</Title>
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

function CreateCamp({ canCreateCamp }: { canCreateCamp: boolean }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (!canCreateCamp) {
    return (
      <Container size="sm">
        <Stack gap="md">
          <Title order={2}>No camp yet</Title>
          <Text c="dimmed">
            New camp creation is currently turned off on this deployment. Ask a
            site administrator to create your camp or to re-enable camp
            creation.
          </Text>
        </Stack>
      </Container>
    );
  }

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
          <Title order={2}>Create your camp</Title>
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
