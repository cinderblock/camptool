import {
  AppShell,
  Burger,
  Group,
  NavLink as MantineNavLink,
  Menu,
  Select,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { authClient, signOut } from "~/lib/auth-client";
import { resolveActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/layout";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, camps, active } = await resolveActiveCamp(request);
  return {
    user,
    activeCampId: active?.camp.id ?? null,
    camps: camps.map((c) => ({
      id: c.camp.id,
      name: c.camp.name,
      role: c.membership.role,
    })),
  };
}

const NAV = [
  { to: "/dashboard", label: "Overview", end: true },
  { to: "/dashboard/members", label: "Members", end: false },
];

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { user, camps, activeCampId } = loaderData;
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
        {NAV.map((item) => (
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
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
