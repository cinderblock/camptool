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
import { useDisclosure, useLocalStorage, useMediaQuery } from "@mantine/hooks";
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
import { ShellBanner } from "~/components/ShellBanner";
import { outstandingAsks } from "~/lib/asks";
import { loadAskSnapshots } from "~/lib/asks.server";
import { authClient, signOut } from "~/lib/auth-client";
import { discordEnabled } from "~/lib/auth.server";
import { getBinsMenu } from "~/lib/bins.server";
import { weeksUntilEvent } from "~/lib/brc";
import { countPendingEntries } from "~/lib/faq.server";
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
import { countProspectsNeedingAttention } from "~/lib/prospects.server";
import { hasScheduledDays } from "~/lib/schedule.server";
import { passkeyNagSnoozed, resolveActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership, passkey } from "../../../db/schema";
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

  // Guide brand-new campers through the wizard. The forced redirect fires at
  // most once (wizardStep flips to 1 the first time /start loads) and stays
  // non-officer, because a wizard is a poor first experience for someone who
  // already runs the camp.
  //
  // The count that follows is a different thing and applies to everyone: what
  // this camper still owes, derived from their data rather than from whether
  // they walked the wizard. Officers were previously exempt, which meant the
  // people most likely to be asked "what do I still need to do?" were the only
  // ones the app never told.
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
  }

  const superAdmin = await isSuperAdmin(user.id);

  // The passkey banner. Queried per USER rather than read off the ask snapshot
  // below, because a credential belongs to the human: someone who hasn't joined
  // a camp yet (so has no edition, and therefore no snapshot) still needs the
  // prompt. The quiet, permanent half of this lives in the ask registry.
  const [anyPasskey] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, user.id))
    .limit(1);
  const showPasskeyNag = !anyPasskey && !passkeyNagSnoozed(request);

  // Per-camp feature states (off / preview / on) drive which nav links exist
  // for this viewer; route loaders enforce the same via requireFeature.
  const features: Partial<Record<FeatureKey, FeatureState>> = active
    ? Object.fromEntries(await loadFeatureStates(active.camp.id))
    : {};

  // What this camper still owes, derived from their data rather than from
  // whether they walked the wizard — so bailing out of /start no longer hides
  // it. Reuses `features` above: an ask for a feature they can't see is dropped,
  // same rule the nav itself follows.
  let outstandingCount = 0;
  if (active && activeEdition) {
    const snapshot = (
      await loadAskSnapshots(
        active.camp.id,
        activeEdition.id,
        activeEdition.year,
      )
    ).get(active.membership.id);
    if (snapshot) {
      outstandingCount = outstandingAsks(snapshot, {
        weeksUntilEvent: weeksUntilEvent(activeEdition.year),
        featureStates: features,
        capabilities: { discord: discordEnabled },
      }).length;
    }
  }

  // A feature that's switched on but has nothing in it yet is worse than a
  // missing one — a camper clicked Schedule looking for the camp's programme
  // and found a blank page. Hide it from members until it has content; officers
  // keep it, since they're the ones who have to put something there.
  const scheduleEmpty =
    active && activeEdition && features.schedule && features.schedule !== "off"
      ? !(await hasScheduledDays(activeEdition.id))
      : false;

  // Questions the camp has asked that nobody has answered yet. Officers are the
  // only ones who can act on them, so only they pay for the query — and the
  // badge is the whole reason the queue doesn't rot (plans/camp-faq.md).
  const faqPending =
    active &&
    features.faq &&
    featureVisibleTo(features.faq, active.membership.role) &&
    hasAtLeast(active.membership.role, "officer")
      ? await countPendingEntries(active.camp.id)
      : 0;

  // Prospects nobody has claimed, or whose follow-up date has passed. Same
  // reasoning as the FAQ badge: the queue only stays alive if being behind on
  // it is visible. Officer-only, so only officers pay for the query.
  const prospectsPending =
    active &&
    features.prospects &&
    featureVisibleTo(features.prospects, active.membership.role) &&
    hasAtLeast(active.membership.role, "officer")
      ? await countProspectsNeedingAttention(active.camp.id)
      : 0;

  // The top-bar shortcut into the camp's bins app. Only the LABEL crosses the
  // wire — the access code stays server-side until /bins issues the redirect.
  const binsMenu =
    active &&
    features.bins &&
    featureVisibleTo(features.bins, active.membership.role) &&
    hasAtLeast(active.membership.role, "member")
      ? await getBinsMenu(active.camp.id)
      : null;

  return redact(privacy, {
    user,
    activeCampId: active?.camp.id ?? null,
    activeRole: active?.membership.role ?? null,
    features,
    binsMenu,
    superAdmin,
    scheduleEmpty,
    outstandingCount,
    faqPending,
    prospectsPending,
    showPasskeyNag,
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
    binsMenu,
    superAdmin,
    scheduleEmpty,
    outstandingCount,
    faqPending,
    prospectsPending,
    showPasskeyNag,
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
        // Account-level, not camp-level, so it's here even with no camp.
        { to: "/account", label: "Your account", end: false },
        ...(superAdmin
          ? [{ to: "/admin", label: "Site admin", end: false }]
          : []),
      ]
    : [
        // The count rides on Overview rather than becoming its own link: the
        // to-do card lives there, and a second entry pointing at "/" would
        // collide on the `key={item.to}` below.
        {
          to: "/",
          label: "Overview",
          end: true,
          badge: outstandingCount > 0 ? String(outstandingCount) : null,
        },
        { to: "/guide", label: "How it works", end: false },
        ...gated("announcements", "/announcements", "Announcements"),
        // An on-but-empty Schedule stays hidden from members (see the loader).
        ...(scheduleEmpty && !hasAtLeast(activeRole ?? "", "officer")
          ? []
          : gated("schedule", "/schedule", "Schedule")),
        ...gated("programming", "/programming", "Programming"),
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
        ...gated("fuel", "/fuel", "Fuel"),
        ...gated("documents", "/documents", "Documents"),
        ...gated("wiki", "/wiki", "Wiki"),
        // Badged for officers only — the count is the queue of unanswered
        // questions, which nobody else can clear.
        ...gated("faq", "/faq", "FAQ").map((item) => ({
          ...item,
          badge: faqPending > 0 ? String(faqPending) : null,
        })),
        ...gated("tickets", "/tickets", "Tickets"),
        ...gated("passes", "/passes", "Passes"),
        ...gated("swaps", "/swaps", "Spares board"),
        ...(activeRole && hasAtLeast(activeRole, "officer")
          ? [
              ...gated("recruiting", "/recruits", "Recruits"),
              ...gated("prospects", "/prospects", "Prospects").map((item) => ({
                ...item,
                badge: prospectsPending > 0 ? String(prospectsPending) : null,
              })),
              ...gated("bringing", "/inventory", "Inventory"),
              ...gated("finances", "/finances", "Finances"),
              ...gated("dues", "/dues", "Dues"),
            ]
          : []),
        ...gated("training", "/training", "Training"),
        ...gated("questions", "/questions", "Questions"),
        ...gated("onboarding", "/onboarding", "Onboarding"),
        { to: "/account", label: "Your account", end: false },
        ...(activeRole === "admin"
          ? [{ to: "/settings", label: "Camp settings", end: false }]
          : []),
        ...(superAdmin
          ? [{ to: "/admin", label: "Site admin", end: false }]
          : []),
      ];
  const [opened, { toggle }] = useDisclosure();
  // Desktop nav collapse. Mantine's AppShell only hides the navbar below the
  // breakpoint, which leaves a skinny-but-not-phone window (a half-screen browser,
  // a split-pane editor) paying 220px for navigation while the page it's showing
  // — the map especially — gets squeezed into nothing. So the burger is offered
  // at every width, and the desktop choice is remembered: someone who works in a
  // narrow window wants it collapsed every time, not once per page load.
  const [navOpen, setNavOpen] = useLocalStorage({
    key: "camptool:nav-open",
    defaultValue: true,
    getInitialValueInEffect: true,
  });
  // Whether the navbar should currently be off-canvas, from whichever burger
  // applies at this width. `48em` is Mantine's `sm` — keep it in step with the
  // AppShell's `breakpoint` below. Undefined during SSR, which reads as "not
  // narrow", i.e. the desktop preference — the same assumption the shell makes.
  const isNarrowViewport = useMediaQuery("(max-width: 47.99em)");
  const navHidden = isNarrowViewport ? !opened : !navOpen;
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
      // `collapsed` here governs only the FIRST render. Mantine turns the
      // AppShell's sizing into a `<style dangerouslySetInnerHTML>` block
      // recomputed each render, and React 19 treats `<style>` as a hoistable
      // resource whose contents it will not update once inserted — so the block
      // is frozen at whatever this evaluated to initially. Changing `collapsed`
      // afterwards re-renders everything else (the burger's own icon and label
      // included) while the navbar never moves, which reads as a dead click.
      // Live toggling is therefore done with the inline styles below, which
      // React does update and which outrank any stylesheet rule. Keeping the
      // prop as well is what makes a page LOAD in the stored state correct,
      // and it's what hides the navbar on a phone before JS has run.
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened, desktop: !navOpen },
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
            <Burger
              opened={navOpen}
              // Explicit value — see the same note on the map's rail toggle:
              // useLocalStorage's functional updater sees its own uninitialised
              // state, not the value the hook handed the component.
              onClick={() => setNavOpen(!navOpen)}
              visibleFrom="sm"
              size="sm"
              aria-label={navOpen ? "Hide navigation" : "Show navigation"}
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
            {binsMenu ? (
              // A hand-off to a separate app, so it opens in its own tab and
              // goes through /bins, which attaches the sign-in at click time.
              <Button
                size="xs"
                variant="subtle"
                component="a"
                href="/bins"
                target="_blank"
                rel="noopener noreferrer"
              >
                {binsMenu.label} ↗
              </Button>
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

      <AppShell.Navbar
        p="sm"
        // See the note on `navbar` above: this, not `collapsed`, is what
        // actually moves the navbar when you click a burger. −100% rather than
        // −220px because Mantine widens the navbar to the full viewport below
        // the breakpoint, and both cases have to slide fully out of view.
        style={navHidden ? { transform: "translateX(-100%)" } : undefined}
      >
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
              ) : "badge" in item && item.badge ? (
                <Badge size="xs" color="red" variant="filled" circle>
                  {item.badge}
                </Badge>
              ) : undefined
            }
            onClick={() => opened && toggle()}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main
        id="main-content"
        // Reclaim the navbar's gutter. Mantine's own rule is
        // `calc(navbar-offset + padding)`, and the offset half of that lives in
        // the same frozen style block, so it has to be overridden here too —
        // otherwise the content keeps a 220px indent beside a navbar that has
        // slid away, which is the whole thing a skinny window can't afford.
        style={
          navHidden
            ? { paddingInlineStart: "var(--mantine-spacing-md)" }
            : undefined
        }
      >
        {privacyMode.on ? (
          <ShellBanner
            color="orange"
            announce
            action={
              <Button
                size="xs"
                variant="filled"
                color="orange"
                onClick={() => setPrivacy({ on: false, keepSelf: false })}
              >
                Turn off
              </Button>
            }
          >
            <b>Privacy mode</b> — every name, email and phone number on screen
            is fake{privacyMode.keepSelf ? " except your own" : ""}. Editing is
            disabled so a fake name can't be saved over a real one.
          </ShellBanner>
        ) : null}
        {impersonatedByName ? (
          <ShellBanner
            color="grape"
            announce
            action={
              <Form method="post" action="/impersonate">
                <input type="hidden" name="intent" value="stop" />
                <Button type="submit" size="xs" variant="filled" color="grape">
                  Stop
                </Button>
              </Form>
            }
          >
            Working as <b>{user.name}</b> — impersonated by {impersonatedByName}
            .
          </ShellBanner>
        ) : null}
        {previewDef ? (
          <ShellBanner
            color="grape"
            action={
              activeRole === "admin" ? (
                <Button
                  component={NavLink}
                  to="/settings"
                  size="xs"
                  variant="light"
                  color="grape"
                >
                  Camp settings
                </Button>
              ) : null
            }
          >
            <b>Preview</b> — only officers can see {previewDef.label} right now.
            The rest of the camp won't see it until it's turned on.
          </ShellBanner>
        ) : null}
        {/* The loud half of the passkey reminder: dismissible, but back
            tomorrow. The quiet half is the `passkey` ask, which is `required`
            and so sits on the to-do list until a passkey actually exists. */}
        {showPasskeyNag ? (
          <ShellBanner
            color="blue"
            action={
              <Group gap="xs" wrap="nowrap">
                <Button
                  component={NavLink}
                  to="/account"
                  size="xs"
                  variant="filled"
                  color="blue"
                >
                  Set one up
                </Button>
                <Form method="post" action="/passkey-nag">
                  <input
                    type="hidden"
                    name="returnTo"
                    value={location.pathname}
                  />
                  <Button type="submit" size="xs" variant="subtle" color="blue">
                    Not now
                  </Button>
                </Form>
              </Group>
            }
          >
            <b>Set up a passkey</b> — sign in with your face, fingerprint or
            device PIN instead of a password. Takes a few seconds.
          </ShellBanner>
        ) : null}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
