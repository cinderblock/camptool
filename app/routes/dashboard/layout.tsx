import {
  AppShell,
  Badge,
  Burger,
  Button,
  Group,
  NavLink as MantineNavLink,
  Menu,
  Select,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  Form,
  NavLink,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
} from "react-router";
import { eq } from "drizzle-orm";
import { redirect } from "react-router";
import { authClient, signOut } from "~/lib/auth-client";
import { hasAtLeast } from "~/lib/permissions";
import { resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership } from "../../../db/schema";
import type { Route } from "./+types/layout";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, camps, active, impersonatedBy, editions, activeEdition } =
    await resolveActiveCamp(request);

  // Guide brand-new campers (non-officers) through the onboarding wizard once.
  // wizardStep stays 0 only until they take any step or skip, so this fires at
  // most once; officers/admins are never force-redirected.
  let wizardCompleted = true;
  if (active && !hasAtLeast(active.membership.role, "officer")) {
    const [me] = await db
      .select({
        wizardStep: membership.wizardStep,
        wizardCompletedAt: membership.wizardCompletedAt,
      })
      .from(membership)
      .where(eq(membership.id, active.membership.id))
      .limit(1);
    wizardCompleted = Boolean(me?.wizardCompletedAt);
    if (me && me.wizardStep === 0 && !me.wizardCompletedAt) {
      throw redirect("/start");
    }
  }

  return {
    user,
    activeCampId: active?.camp.id ?? null,
    activeRole: active?.membership.role ?? null,
    wizardCompleted,
    impersonatedBy,
    activeEditionId: activeEdition?.id ?? null,
    activeEditionLocked: activeEdition?.locked ?? false,
    editions: editions.map((e) => ({
      id: e.id,
      label: e.label ? `${e.year} · ${e.label}` : String(e.year),
    })),
    camps: camps.map((c) => ({
      id: c.camp.id,
      name: c.camp.name,
      role: c.membership.role,
    })),
  };
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const {
    user,
    camps,
    activeCampId,
    activeRole,
    wizardCompleted,
    impersonatedBy,
    editions,
    activeEditionId,
    activeEditionLocked,
  } = loaderData;
  const editionFetcher = useFetcher();
  const nav = [
    { to: "/dashboard", label: "Overview", end: true },
    ...(!wizardCompleted
      ? [{ to: "/start", label: "Finish setup", end: false }]
      : []),
    { to: "/dashboard/members", label: "Members", end: false },
    ...(activeRole && hasAtLeast(activeRole, "member")
      ? [{ to: "/dashboard/invite", label: "Invite friends", end: false }]
      : []),
    { to: "/dashboard/editions", label: "Years", end: false },
    { to: "/dashboard/map", label: "Map", end: false },
    { to: "/dashboard/bringing", label: "Bringing", end: false },
    ...(activeRole && hasAtLeast(activeRole, "officer")
      ? [
          { to: "/dashboard/recruits", label: "Recruits", end: false },
          { to: "/dashboard/inventory", label: "Inventory", end: false },
        ]
      : []),
    { to: "/dashboard/onboarding", label: "Onboarding", end: false },
  ];
  const [opened, { toggle }] = useDisclosure();
  const navigate = useNavigate();
  const location = useLocation();

  async function switchCamp(id: string | null) {
    if (!id || id === activeCampId) return;
    await authClient.organization.setActive({ organizationId: id });
    navigate(location.pathname, { replace: true });
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened },
      }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
            />
            <Title order={4}>CampTool</Title>
          </Group>
          <Group gap="md">
            {camps.length > 1 ? (
              <Select
                size="xs"
                value={activeCampId}
                onChange={switchCamp}
                data={camps.map((c) => ({ value: c.id, label: c.name }))}
                allowDeselect={false}
                w={180}
              />
            ) : null}
            {editions.length > 0 ? (
              <Group gap={6} wrap="nowrap">
                <Select
                  size="xs"
                  aria-label="Year"
                  value={activeEditionId}
                  onChange={(id) =>
                    id &&
                    id !== activeEditionId &&
                    editionFetcher.submit(
                      { intent: "setActive", editionId: id },
                      { method: "post", action: "/dashboard/editions" },
                    )
                  }
                  data={editions.map((e) => ({ value: e.id, label: e.label }))}
                  allowDeselect={false}
                  w={130}
                />
                {activeEditionLocked ? (
                  <Badge size="sm" color="gray" variant="light">
                    locked
                  </Badge>
                ) : null}
              </Group>
            ) : null}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton>
                  <Text size="sm" fw={500}>
                    {user.name}
                  </Text>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.email}</Menu.Label>
                <Menu.Item onClick={handleSignOut}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {nav.map((item) => (
          <MantineNavLink
            key={item.to}
            component={NavLink}
            to={item.to}
            end={item.end}
            label={item.label}
            onClick={() => opened && toggle()}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        {impersonatedBy ? (
          <Group
            justify="space-between"
            wrap="nowrap"
            mb="md"
            px="md"
            py="xs"
            style={{
              background: "var(--mantine-color-grape-light)",
              borderRadius: "var(--mantine-radius-sm)",
            }}
          >
            <Text size="sm">
              Working as <b>{user.name}</b> — impersonated by{" "}
              {impersonatedBy.name}.
            </Text>
            <Form method="post" action="/impersonate">
              <input type="hidden" name="intent" value="stop" />
              <Button type="submit" size="xs" variant="filled" color="grape">
                Stop
              </Button>
            </Form>
          </Group>
        ) : null}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
