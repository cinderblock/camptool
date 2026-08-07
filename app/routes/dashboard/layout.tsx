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
import { FeedbackButton } from "~/components/FeedbackButton";
import { authClient, signOut } from "~/lib/auth-client";
import {
  type FeatureKey,
  type FeatureState,
  featureDef,
  featureForPath,
  featureVisibleTo,
} from "~/lib/features";
import { loadFeatureStates } from "~/lib/features.server";
import { isSuperAdmin } from "~/lib/instance.server";
import { hasAtLeast } from "~/lib/permissions";
import type { PrivacyMode } from "~/lib/privacy";
import { redact } from "~/lib/privacy.server";
import { hasScheduledDays } from "~/lib/schedule.server";
import { resolveActiveCamp } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import { db } from "../../../db/client.server";
import { membership } from "../../../db/schema";
import type { Route } from "./+types/layout";

export async function loader({ request }: Route.LoaderArgs) {
  const {
    user,
    camps,
    active,
    impersonatedBy,
    editions,
    activeEdition,
    privacy,
    privacyMode,
    canUsePrivacy,
  } = await resolveActiveCamp(request);

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
      campId: active.camp.id,
      editionId: activeEdition.id,
      membershipId: active.membership.id,
      role: active.membership.role,
      year: activeEdition.year,
    });
    showFinishSetup = state.pending.length > 0;
  }

  const superAdmin = await isSuperAdmin(user.id);

  // Per-camp feature states (off / preview / on) drive which nav links exist
  // for this viewer; route loaders enforce the same via requireFeature.
  const features: Partial<Record<FeatureKey, FeatureState>> = active
    ? Object.fromEntries(await loadFeatureStates(active.camp.id))
    : {};

  // A feature that's switched on but has nothing in it yet is worse than a
  // missing one — a camper clicked Schedule looking for the camp's programme
  // and found a blank page. Hide it from members until it has content; officers
  // keep it, since they're the ones who have to put something there.
  const scheduleEmpty =
    active && activeEdition && features.schedule && features.schedule !== "off"
      ? !(await hasScheduledDays(activeEdition.id))
      : false;

  return redact(privacy, {
    user,
    activeCampId: active?.camp.id ?? null,
    activeRole: active?.membership.role ?? null,
    features,
    superAdmin,
    scheduleEmpty,
    showFinishSetup,
    privacyMode,
    canUsePrivacy,
    // Flattened to `…Name` so the redaction registry classifies it as a person;
    // a bare `name` on a `{ id, name }` object has no personhood signal to go on
    // (that heuristic is what keeps camp and structure names intact).
    impersonatedByName: impersonatedBy?.name ?? null,
    activeEditionId: activeEdition?.id ?? null,
    activeEditionLocked: activeEdition?.locked ?? false,
    activeEditionYear: activeEdition?.year ?? null,
    editions: editions.map((e) => ({
      id: e.id,
      label: e.label ? `${e.year} · ${e.label}` : String(e.year),
    })),
    camps: camps.map((c) => ({
      id: c.camp.id,
      name: c.camp.name,
      role: c.membership.role,
    })),
  });
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const {
    user,
    camps,
    activeCampId,
    activeRole,
    features,
    superAdmin,
    scheduleEmpty,
    showFinishSetup,
    impersonatedByName,
    privacyMode,
    canUsePrivacy,
    editions,
    activeEditionId,
    activeEditionLocked,
    activeEditionYear,
  } = loaderData;
  const editionFetcher = useFetcher();
  const privacyFetcher = useFetcher();
  const setPrivacy = (mode: PrivacyMode) =>
    privacyFetcher.submit(
      { on: String(mode.on), keepSelf: String(mode.keepSelf) },
      { method: "post", action: "/privacy" },
    );
  // A feature-gated nav link exists only when this viewer can see the feature
  // (on = everyone; preview = officers+, badged so they know members can't).
  const featureState = (key: FeatureKey): FeatureState =>
    features[key] ?? "off";
  const canSee = (key: FeatureKey) =>
    !!activeRole && featureVisibleTo(featureState(key), activeRole);
  const gated = (key: FeatureKey, to: string, label: string) =>
    canSee(key)
      ? [{ to, label, end: false, preview: featureState(key) === "preview" }]
      : [];
  // Camp-scoped routes all bounce back to "/" for a camp-less user (e.g. an
  // applicant awaiting review), so only show them once there's an active camp.
  const nav = !activeCampId
    ? [
        { to: "/", label: "Overview", end: true },
        ...(superAdmin
          ? [{ to: "/admin", label: "Site admin", end: false }]
          : []),
      ]
    : [
        { to: "/", label: "Overview", end: true },
        { to: "/guide", label: "How it works", end: false },
        ...gated("announcements", "/announcements", "Announcements"),
        // An on-but-empty Schedule stays hidden from members (see the loader).
        ...(scheduleEmpty && !hasAtLeast(activeRole ?? "", "officer")
          ? []
          : gated("schedule", "/schedule", "Schedule")),
        ...gated("programming", "/programming", "Programming"),
        ...(showFinishSetup
          ? [{ to: "/start", label: "Finish setup", end: false }]
          : []),
        { to: "/members", label: "Members · all years", end: false },
        ...gated(
          "roster",
          "/roster",
          activeEditionYear
            ? `Who's coming · ${activeEditionYear}`
            : "Who's coming",
        ),
        ...(activeRole && hasAtLeast(activeRole, "member")
          ? [{ to: "/invite", label: "Invite friends", end: false }]
          : []),
        { to: "/editions", label: "Years", end: false },
        ...gated("map", "/map", "Map"),
        ...gated("bringing", "/bringing", "Bringing"),
        ...gated("supplies", "/supplies", "Supplies"),
        ...gated("documents", "/documents", "Documents"),
        ...gated("tickets", "/tickets", "Tickets"),
        ...gated("passes", "/passes", "Passes"),
        ...(activeRole && hasAtLeast(activeRole, "officer")
          ? [
              ...gated("recruiting", "/recruits", "Recruits"),
              ...gated("bringing", "/inventory", "Inventory"),
              ...gated("finances", "/finances", "Finances"),
              ...gated("dues", "/dues", "Dues"),
            ]
          : []),
        ...gated("training", "/training", "Training"),
        ...gated("questions", "/questions", "Questions"),
        ...gated("onboarding", "/onboarding", "Onboarding"),
        ...(activeRole === "admin"
          ? [{ to: "/settings", label: "Camp settings", end: false }]
          : []),
        ...(superAdmin
          ? [{ to: "/admin", label: "Site admin", end: false }]
          : []),
      ];
  const [opened, { toggle }] = useDisclosure();
  const navigate = useNavigate();
  const location = useLocation();
  // Officers+ viewing a previewed feature get a persistent reminder that the
  // rest of the camp can't see it yet.
  const previewKey = featureForPath(location.pathname);
  const previewDef =
    previewKey && featureState(previewKey) === "preview"
      ? featureDef(previewKey)
      : null;

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
      <AppShell.Header
        // Privacy mode recolours the whole chrome. A mode that makes fake data
        // look real is a mode you forget you're in and then act on, so the
        // signal has to be impossible to miss rather than a tidy little badge.
        style={
          privacyMode.on
            ? { background: "var(--mantine-color-orange-light)" }
            : undefined
        }
      >
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={opened ? "Close navigation" : "Open navigation"}
            />
            <Title order={4}>CampTool</Title>
          </Group>
          <Group
            gap="md"
            wrap="wrap"
            justify="flex-end"
            style={{ minWidth: 0 }}
          >
            {camps.length > 1 ? (
              <Select
                size="xs"
                aria-label="Camp"
                value={activeCampId}
                onChange={switchCamp}
                data={camps.map((c) => ({ value: c.id, label: c.name }))}
                allowDeselect={false}
                w={{ base: 120, sm: 180 }}
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
                  w={{ base: 104, sm: 130 }}
                />
                {activeEditionLocked ? (
                  <Badge size="sm" color="gray" variant="light">
                    locked
                  </Badge>
                ) : null}
              </Group>
            ) : null}
            {canUsePrivacy ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    size="xs"
                    variant={privacyMode.on ? "filled" : "subtle"}
                    color="orange"
                  >
                    {privacyMode.on ? "Privacy on" : "Privacy"}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Privacy mode</Menu.Label>
                  <Menu.Item
                    onClick={() => setPrivacy({ on: false, keepSelf: false })}
                  >
                    {!privacyMode.on ? "✓ " : ""}Off — show real people
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => setPrivacy({ on: true, keepSelf: false })}
                  >
                    {privacyMode.on && !privacyMode.keepSelf ? "✓ " : ""}
                    On — fake names for everyone
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => setPrivacy({ on: true, keepSelf: true })}
                  >
                    {privacyMode.on && privacyMode.keepSelf ? "✓ " : ""}
                    On — but keep my own name
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : null}
            <FeedbackButton />
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton aria-label={`Account menu — ${user.name}`}>
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
            rightSection={
              "preview" in item && item.preview ? (
                <Badge size="xs" color="grape" variant="light">
                  preview
                </Badge>
              ) : undefined
            }
            onClick={() => opened && toggle()}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main id="main-content">
        {privacyMode.on ? (
          <Group
            justify="space-between"
            wrap="nowrap"
            mb="md"
            px="md"
            py="xs"
            // biome-ignore lint/a11y/useSemanticElements: an <output> element is for form results; this is a session-status banner, and role="status" makes SRs announce it when privacy mode starts.
            role="status"
            style={{
              background: "var(--mantine-color-orange-light)",
              borderRadius: "var(--mantine-radius-sm)",
            }}
          >
            <Text size="sm">
              <b>Privacy mode</b> — every name, email and phone number on screen
              is fake{privacyMode.keepSelf ? " except your own" : ""}. Editing
              is disabled so a fake name can't be saved over a real one.
            </Text>
            <Button
              size="xs"
              variant="filled"
              color="orange"
              onClick={() => setPrivacy({ on: false, keepSelf: false })}
            >
              Turn off
            </Button>
          </Group>
        ) : null}
        {impersonatedByName ? (
          <Group
            justify="space-between"
            wrap="nowrap"
            mb="md"
            px="md"
            py="xs"
            // biome-ignore lint/a11y/useSemanticElements: an <output> element is for form results; this is a session-status banner, and role="status" makes SRs announce it when impersonation starts.
            role="status"
            style={{
              background: "var(--mantine-color-grape-light)",
              borderRadius: "var(--mantine-radius-sm)",
            }}
          >
            <Text size="sm">
              Working as <b>{user.name}</b> — impersonated by{" "}
              {impersonatedByName}.
            </Text>
            <Form method="post" action="/impersonate">
              <input type="hidden" name="intent" value="stop" />
              <Button type="submit" size="xs" variant="filled" color="grape">
                Stop
              </Button>
            </Form>
          </Group>
        ) : null}
        {previewDef ? (
          <Group
            wrap="nowrap"
            justify="space-between"
            mb="md"
            px="md"
            py="xs"
            style={{
              background: "var(--mantine-color-grape-light)",
              borderRadius: "var(--mantine-radius-sm)",
            }}
          >
            <Text size="sm">
              <b>Preview</b> — only officers can see {previewDef.label} right
              now. The rest of the camp won't see it until it's turned on.
            </Text>
            {activeRole === "admin" ? (
              <Button
                component={NavLink}
                to="/settings"
                size="xs"
                variant="light"
                color="grape"
              >
                Camp settings
              </Button>
            ) : null}
          </Group>
        ) : null}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
