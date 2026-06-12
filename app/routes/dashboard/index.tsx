import {
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
import { and, count, eq } from "drizzle-orm";
import { useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { authClient } from "~/lib/auth-client";
import { discordEnabled } from "~/lib/auth.server";
import { getInstanceSettings, isSuperAdmin } from "~/lib/instance.server";
import type { Role } from "~/lib/permissions";
import { resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { account, membership } from "../../../db/schema";
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
  const { user, active } = await resolveActiveCamp(request);

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

  return {
    userName: user.name,
    discordEnabled,
    hasDiscord,
    memberCount,
    canCreateCamp,
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
  const { memberCount, discordEnabled, hasDiscord } = loaderData;
  const active = loaderData.active as NonNullable<typeof loaderData.active>;
  const role = active.role as Role;
  const [busy, setBusy] = useState(false);

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
      callbackURL: "/dashboard",
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
    navigate("/dashboard");
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
