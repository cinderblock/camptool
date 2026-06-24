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
import { eq } from "drizzle-orm";
import {
  Form,
  NavLink,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
} from "react-router";
import { redirect } from "react-router";
import { authClient, signOut } from "~/lib/auth-client";
import { isSuperAdmin } from "~/lib/instance.server";
import { hasAtLeast } from "~/lib/permissions";
import { resolveActiveCamp } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import { db } from "../../../db/client.server";
import { membership } from "../../../db/schema";
import type { Route } from "./+types/layout";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, camps, active, impersonatedBy, editions, activeEdition } =
    await resolveActiveCamp(request);

  // Guide brand-new campers (non-officers) through the onboarding wizard. The
  // forced redirect fires at most once (wizardStep flips to 1 the first time
  // /start loads); after that, the "Finish setup" nav shows whenever the active
  // edition still has season-relevant asks left to resolve. Officers are exempt.
  let showFinishSetup = false;
  if (
    active &&
    activeEdition &&
    !hasAtLeast(active.membership.role, "officer")
  ) {
    const [me] = await db
      .select({ wizardStep: membership.wizardStep })
      .from(membership)
      .where(eq(membership.id, active.membership.id))
      .limit(1);
    if (me && me.wizardStep === 0) {
      throw redirect("/start");
    }
    const state = await loadWizardState({
      editionId: activeEdition.id,
      membershipId: active.membership.id,
      role: active.membership.role,
      year: activeEdition.year,
    });
    showFinishSetup = state.pending.length > 0;
  }

  const superAdmin = await isSuperAdmin(user.id);

  return {
    user,
    activeCampId: active?.camp.id ?? null,
    activeRole: active?.membership.role ?? null,
    tracksDues: active?.camp.tracksDues ?? false,
    superAdmin,
    showFinishSetup,
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
    tracksDues,
    superAdmin,
    showFinishSetup,
    impersonatedBy,
    editions,
    activeEditionId,
    activeEditionLocked,
  } = loaderData;
  const editionFetcher = useFetcher();
  const nav = [
    { to: "/", label: "Overview", end: true },
    { to: "/guide", label: "How it works", end: false },
    { to: "/announcements", label: "Announcements", end: false },
    ...(showFinishSetup
      ? [{ to: "/start", label: "Finish setup", end: false }]
      : []),
    { to: "/members", label: "Members", end: false },
    ...(activeRole && hasAtLeast(activeRole, "member")
      ? [{ to: "/invite", label: "Invite friends", end: false }]
      : []),
    { to: "/editions", label: "Years", end: false },
    { to: "/map", label: "Map", end: false },
    { to: "/bringing", label: "Bringing", end: false },
    { to: "/supplies", label: "Supplies", end: false },
    { to: "/tickets", label: "Tickets", end: false },
    { to: "/passes", label: "Passes", end: false },
    ...(activeRole && hasAtLeast(activeRole, "officer")
      ? [
          { to: "/recruits", label: "Recruits", end: false },
          { to: "/inventory", label: "Inventory", end: false },
          { to: "/finances", label: "Finances", end: false },
          ...(tracksDues ? [{ to: "/dues", label: "Dues", end: false }] : []),
        ]
      : []),
    { to: "/questions", label: "Questions", end: false },
    { to: "/onboarding", label: "Onboarding", end: false },
    ...(superAdmin ? [{ to: "/admin", label: "Site admin", end: false }] : []),
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
                      { method: "post", action: "/editions" },
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
