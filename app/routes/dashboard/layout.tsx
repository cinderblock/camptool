import {
  AppShell,
  Avatar,
  Badge,
  Burger,
  Button,
  Divider,
  Group,
  NavLink as MantineNavLink,
  Menu,
  ScrollArea,
  Select,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useLocalStorage, useMediaQuery } from "@mantine/hooks";
import { eq } from "drizzle-orm";
import { type ReactNode, useEffect } from "react";
import {
  Form,
  NavLink,
  Outlet,
  redirect,
  type ShouldRevalidateFunctionArgs,
  useFetcher,
  useLocation,
  useNavigate,
} from "react-router";
import { FeedbackModal } from "~/components/FeedbackButton";
import { ShellBanner } from "~/components/ShellBanner";
import { outstandingAsks } from "~/lib/asks";
import { loadAskSnapshots } from "~/lib/asks.server";
import { discordEnabled } from "~/lib/auth.server";
import { authClient, signOut } from "~/lib/auth-client";
import { getBinsMenu } from "~/lib/bins.server";
import { weeksUntilEvent } from "~/lib/brc";
import { campOrigin, isValidCampSlug, pageUrl } from "~/lib/camp-host";
import { arrivedWithMove } from "~/lib/camp-move/move-in-auth.server";
import { openMoveFor } from "~/lib/camp-move/move-out.server";
import { loadCustomKinds } from "~/lib/custom-kinds.server";
import { APEX, CAMP_SUBDOMAINS } from "~/lib/env.server";
import { featureName } from "~/lib/events";
import { countPendingEntries } from "~/lib/faq.server";
import {
  type FeatureKey,
  type FeatureState,
  featureDef,
  featureForPath,
  featureVisibleTo,
} from "~/lib/features";
import { featureStatesFor } from "~/lib/features.server";
import { isSuperAdmin } from "~/lib/instance.server";
import { KindsProvider } from "~/lib/kinds-context";
import { countUnreadSummaries } from "~/lib/meetings.server";
import { useNavTiming } from "~/lib/nav-timing";
import { hasAtLeast } from "~/lib/permissions";
import type { PrivacyMode } from "~/lib/privacy";
import { redact } from "~/lib/privacy.server";
import { countProspectsNeedingAttention } from "~/lib/prospects.server";
import { hasScheduledDays } from "~/lib/schedule.server";
import {
  passkeyNagSnoozed,
  resolveActiveCamp,
  yearNudgeSnoozed,
} from "~/lib/session.server";
import { yearNudge } from "~/lib/year-nudge";
import { db } from "../../../db/client.server";
import { legacyPasskey, membership, passkey } from "../../../db/schema";
import type { Route } from "./+types/layout";

// When this shell's data last arrived in the browser (see shouldRevalidate).
let shellLoadedAt = 0;
const SHELL_MAX_AGE_MS = 60_000;

/**
 * Single fetch reruns every loader on every page switch unless a route opts
 * out, and this one is the heaviest: camps, nav badges and the ask counts are
 * ~45 queries and most of each response (plans/fast-navigation.md). It
 * changes when something is posted, so it reloads after any form post or an
 * explicit refresh, and otherwise once it's a minute old, which keeps badges
 * that other people's actions move (unread summaries, pending FAQs) roughly
 * current.
 */
export function shouldRevalidate({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") {
    return defaultShouldRevalidate;
  }
  if (currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return Date.now() - shellLoadedAt > SHELL_MAX_AGE_MS;
}

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

  const isOfficer = !!active && hasAtLeast(active.membership.role, "officer");
  // Everything this shell shows is independent, so the queries go out together
  // in two waves rather than one after another: on D1 each query is a network
  // round trip, and in series they were most of a page load
  // (plans/fast-navigation.md). The first wave also runs a few lookups that
  // only matter for a redirect; they're cheap, and waiting to find out whether
  // they're needed would cost a whole round trip.
  const [
    anyPasskey,
    oldPasskey,
    movedIn,
    me,
    superAdmin,
    campMoving,
    featureStates,
    snapshots,
    customKinds,
  ] = await Promise.all([
    // The passkey banner. Queried per USER rather than read off the ask
    // snapshot below, because a credential belongs to the human: someone who
    // hasn't joined a camp yet (so has no edition, and therefore no snapshot)
    // still needs the prompt. The quiet, permanent half of this lives in the
    // ask registry.
    db
      .select({ id: passkey.id })
      .from(passkey)
      .where(eq(passkey.userId, user.id))
      .limit(1)
      .then((rows) => rows[0]),
    impersonatedBy
      ? undefined
      : db
          .select({ id: legacyPasskey.id })
          .from(legacyPasskey)
          .where(eq(legacyPasskey.userId, user.id))
          .limit(1)
          .then((rows) => rows[0]),
    impersonatedBy ? false : arrivedWithMove(user.id),
    active && activeEdition && !isOfficer
      ? db
          .select({ wizardStep: membership.wizardStep })
          .from(membership)
          .where(eq(membership.id, active.membership.id))
          .limit(1)
          .then((rows) => rows[0])
      : undefined,
    isSuperAdmin(user.id),
    // A camp on its way to another CampTool site is read-only meanwhile
    // (plans/camp-portability.md); say so on every page.
    active ? openMoveFor(active.camp.id).then(Boolean) : false,
    active ? featureStatesFor(active) : undefined,
    active && activeEdition
      ? loadAskSnapshots(active.camp.id, activeEdition.id, activeEdition.year)
      : undefined,
    // The camp's own structure kinds, so every page's palette includes them
    // (`KindsProvider` below; plans/custom-structures.md).
    active ? loadCustomKinds(active.camp.id) : [],
  ]);

  // Someone whose passkeys were all made for the camp's old address can't sign
  // in here with any of them. Before anything else, they make one that works
  // (app/lib/legacy-host.server.ts). Not while an officer is working as them:
  // that's not their browser. Or they arrived with a camp from another
  // CampTool site (whose passwords never come along): passkeys from now on.
  if (!anyPasskey && !impersonatedBy && (oldPasskey || movedIn)) {
    const here = pageUrl(request.url);
    throw redirect(
      `/new-passkey?next=${encodeURIComponent(here.pathname + here.search)}`,
    );
  }

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
  if (me && me.wizardStep === 0) {
    throw redirect("/start");
  }

  const showPasskeyNag = !anyPasskey && !passkeyNagSnoozed(request);

  // Start-the-new-year banner. Officers get the one-click fix (snoozable);
  // members only hear about a camp with no year at all, since every year page
  // bounces them to /editions, where they can't do anything. Hidden in
  // privacy mode, which can't write and is for demos.
  const nudge = active && !privacyMode.on ? yearNudge(editions) : null;
  const yearBanner =
    nudge && isOfficer && !yearNudgeSnoozed(request, nudge.year)
      ? nudge
      : nudge?.kind === "first" && !isOfficer
        ? ({ kind: "waiting" } as const)
        : null;

  // Per-camp feature states (off / preview / on) drive which nav links exist
  // for this viewer; route loaders enforce the same via requireFeature.
  const features: Partial<Record<FeatureKey, FeatureState>> = featureStates
    ? Object.fromEntries(featureStates)
    : {};
  /** Can this viewer see the feature? Same rule as the nav links. */
  const visible = (key: FeatureKey) =>
    !!active &&
    !!features[key] &&
    featureVisibleTo(features[key], active.membership.role);

  // What this camper still owes, derived from their data rather than from
  // whether they walked the wizard — so bailing out of /start no longer hides
  // it. Reuses `features` above: an ask for a feature they can't see is dropped,
  // same rule the nav itself follows.
  let outstandingCount = 0;
  const snapshot = active ? snapshots?.get(active.membership.id) : undefined;
  if (snapshot && activeEdition) {
    outstandingCount = outstandingAsks(snapshot, {
      weeksUntilEvent: weeksUntilEvent(activeEdition.year),
      featureStates: features,
      capabilities: { discord: discordEnabled },
    }).length;
  }

  // The second wave: what the feature states decide whether to look up.
  const [
    scheduleEmpty,
    faqPending,
    prospectsPending,
    unreadSummaries,
    binsMenu,
  ] = await Promise.all([
    // A feature that's switched on but has nothing in it yet is worse than a
    // missing one — a camper clicked Schedule looking for the camp's
    // programme and found a blank page. Hide it from members until it has
    // content; officers keep it, since they're the ones who have to put
    // something there.
    activeEdition && features.schedule && features.schedule !== "off"
      ? hasScheduledDays(activeEdition.id).then((has) => !has)
      : false,
    // Questions the camp has asked that nobody has answered yet. Officers
    // are the only ones who can act on them, so only they pay for the query
    // — and the badge is the whole reason the queue doesn't rot
    // (plans/camp-faq.md).
    active && visible("faq") && isOfficer
      ? countPendingEntries(active.camp.id)
      : 0,
    // Prospects nobody has claimed, or whose follow-up date has passed. Same
    // reasoning as the FAQ badge: the queue only stays alive if being behind
    // on it is visible. Officer-only, so only officers pay for the query.
    active && visible("prospects") && isOfficer
      ? countProspectsNeedingAttention(active.camp.id)
      : 0,
    // Meeting write-ups this member hasn't read. Unlike the officer-only
    // badges above, everyone pays for this one — it IS the distribution
    // mechanism for a summary (plans/camp-meetings.md), so a member not
    // seeing it defeats it.
    active && activeEdition && visible("meetings")
      ? countUnreadSummaries({
          editionId: activeEdition.id,
          membershipId: active.membership.id,
        })
      : 0,
    // The top-bar shortcut into the camp's bins app. Only the LABEL crosses
    // the wire — the access code stays server-side until /bins issues the
    // redirect.
    active && visible("bins") && hasAtLeast(active.membership.role, "member")
      ? getBinsMenu(active.camp.id)
      : null,
  ]);

  return redact(privacy, {
    user,
    customKinds,
    activeCampId: active?.camp.id ?? null,
    activeRole: active?.membership.role ?? null,
    features,
    binsMenu,
    superAdmin,
    scheduleEmpty,
    outstandingCount,
    faqPending,
    prospectsPending,
    unreadSummaries,
    showPasskeyNag,
    yearBanner,
    campMoving,
    privacyMode,
    canUsePrivacy,
    // Flattened to `…Name` so the redaction registry classifies it as a person;
    // a bare `name` on a `{ id, name }` object has no personhood signal to go on
    // (that heuristic is what keeps camp and structure names intact).
    impersonatedByName: impersonatedBy?.name ?? null,
    activeEditionId: activeEdition?.id ?? null,
    activeEditionLocked: activeEdition?.locked ?? false,
    activeEditionYear: activeEdition?.year ?? null,
    // Which event this year is — the nav uses it to name features the way the
    // camp actually says them (`featureName`).
    activeEditionEvent: activeEdition?.event ?? null,
    editions: editions.map((e) => ({
      id: e.id,
      label: e.label ? `${e.year} · ${e.label}` : String(e.year),
    })),
    camps: camps.map((c) => ({
      id: c.camp.id,
      name: c.camp.name,
      role: c.membership.role,
      // With camp subdomains on, each camp's own address: switching camps
      // goes there instead of flipping the session's active camp in place.
      origin:
        CAMP_SUBDOMAINS && c.camp.slug && isValidCampSlug(c.camp.slug)
          ? campOrigin(c.camp.slug, APEX)
          : null,
    })),
  });
}

type NavItem = {
  to: string;
  label: string;
  end: boolean;
  /** Officers+ only: the feature is on in preview, so members can't see it. */
  preview?: boolean;
  /** A count worth interrupting for — unanswered FAQs, unclaimed prospects. */
  badge?: string | null;
};

type NavGroup = { id: string; label: string; items: NavItem[] };

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  // Real-browser timings of loads and page switches (plans/fast-navigation.md).
  useNavTiming();
  useEffect(() => {
    if (loaderData) shellLoadedAt = Date.now();
  }, [loaderData]);
  const {
    user,
    camps,
    customKinds,
    activeCampId,
    activeRole,
    features,
    binsMenu,
    superAdmin,
    scheduleEmpty,
    outstandingCount,
    faqPending,
    prospectsPending,
    unreadSummaries,
    showPasskeyNag,
    yearBanner,
    campMoving,
    impersonatedByName,
    privacyMode,
    canUsePrivacy,
    editions,
    activeEditionId,
    activeEditionLocked,
    activeEditionYear,
    activeEditionEvent,
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
  const gated = (key: FeatureKey, to: string, label: string): NavItem[] =>
    canSee(key)
      ? [{ to, label, end: false, preview: featureState(key) === "preview" }]
      : [];
  const officer = hasAtLeast(activeRole ?? "", "officer");

  // Camp-scoped routes all bounce back to "/" for a camp-less user (e.g. an
  // applicant awaiting review), so only show them once there's an active camp.
  //
  // The list is FILED, not flat. A camp with most features on was showing
  // twenty-five links in one column, which to someone who joined last week
  // reads as a wall rather than a map of the app. So: the three everybody wants
  // first stay pinned at the top, the rest sit under headings phrased as the
  // question a camper is actually asking ("Getting there", "What we're
  // bringing"), and account-level links stay pinned at the bottom. Each group
  // holds only the links this viewer can see, so an officer's Prospects and a
  // member's Tickets file themselves under the same heading without either of
  // them seeing an empty one.
  const topLinks: NavItem[] = !activeCampId
    ? [{ to: "/", label: "Overview", end: true }]
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
      ];

  const groups: NavGroup[] = !activeCampId
    ? []
    : [
        // Everything the camp asks of a camper personally. Officers see the
        // same three pages from the authoring side, which is where they'd go
        // looking for them anyway.
        {
          id: "setup",
          label: "Getting set up",
          items: [
            // The wizard's permanent door. It used to be reachable only by the
            // one-time forced redirect (which officers never get, and which
            // anyone who clicked "Skip for now" never sees again) — and now that
            // every to-do points at the datum's real page rather than back into
            // the wizard (plans/wizard-step-homes.md), nothing else led here.
            // Ungated core, but only once there's a year to walk: /start
            // requires an active edition and would bounce to /editions.
            ...(activeEditionId
              ? [{ to: "/start", label: "Guided setup", end: false }]
              : []),
            ...gated("onboarding", "/onboarding", "Onboarding"),
            ...gated("questions", "/questions", "Questions"),
            ...gated("training", "/training", "Training"),
          ],
        },
        {
          id: "people",
          label: "People",
          items: [
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
            ...(officer
              ? [
                  ...gated("recruiting", "/recruits", "Recruits"),
                  ...gated("prospects", "/prospects", "Prospects").map(
                    (item) => ({
                      ...item,
                      badge:
                        prospectsPending > 0 ? String(prospectsPending) : null,
                    }),
                  ),
                ]
              : []),
          ],
        },
        {
          id: "travel",
          label: "Getting there",
          items: [
            // Ungated: RSVP and stay dates are core, and this is where the
            // to-do list sends people (plans/wizard-step-homes.md).
            { to: "/trip", label: "Your trip", end: false },
            // The event names these, not the core app — see `featureName`.
            ...gated(
              "tickets",
              "/tickets",
              featureName("tickets", activeEditionEvent, "Tickets"),
            ),
            ...gated(
              "passes",
              "/passes",
              featureName("passes", activeEditionEvent, "Passes"),
            ),
            ...gated("swaps", "/swaps", "Spares board"),
          ],
        },
        {
          id: "gear",
          label: "What we're bringing",
          items: [
            ...gated("map", "/map", "Map"),
            ...gated("bringing", "/bringing", "Bringing"),
            ...gated("supplies", "/supplies", "Supplies"),
            ...gated("fuel", "/fuel", "Fuel"),
            ...(officer ? gated("bringing", "/inventory", "Inventory") : []),
          ],
        },
        {
          id: "whats-on",
          label: "What's on",
          items: [
            // An on-but-empty Schedule stays hidden from members (see loader).
            ...(scheduleEmpty && !officer
              ? []
              : gated("schedule", "/schedule", "Schedule")),
            // Badged with summaries this member hasn't read — the whole of how
            // a write-up gets "distributed" without a mailer.
            ...gated("meetings", "/meetings", "Meetings").map((item) => ({
              ...item,
              badge: unreadSummaries > 0 ? String(unreadSummaries) : null,
            })),
            ...gated("programming", "/programming", "Programming"),
          ],
        },
        {
          id: "info",
          label: "Camp info",
          items: [
            ...gated("wiki", "/wiki", "Wiki"),
            // Badged for officers only — the count is the queue of unanswered
            // questions, which nobody else can clear.
            ...gated("faq", "/faq", "FAQ").map((item) => ({
              ...item,
              badge: faqPending > 0 ? String(faqPending) : null,
            })),
            ...gated("documents", "/documents", "Documents"),
            { to: "/editions", label: "Years", end: false },
          ],
        },
        {
          id: "running",
          label: "Running the camp",
          items: [
            ...(officer
              ? [
                  ...gated("finances", "/finances", "Finances"),
                  ...gated("dues", "/dues", "Dues"),
                ]
              : []),
            ...(activeRole === "admin"
              ? [{ to: "/settings", label: "Camp settings", end: false }]
              : []),
          ],
        },
      ];

  // Account-level, not camp-level, so these are here even with no camp.
  const bottomLinks: NavItem[] = [
    { to: "/account", label: "Your account", end: false },
    ...(superAdmin ? [{ to: "/admin", label: "Site admin", end: false }] : []),
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

  // Which group holds the page you're on. Same matching rule NavLink itself
  // uses, so "the open group" and "the highlighted link" can never disagree.
  const isCurrent = (item: NavItem) =>
    item.end
      ? location.pathname === item.to
      : location.pathname === item.to ||
        location.pathname.startsWith(`${item.to}/`);
  const currentGroupId =
    groups.find((g) => g.items.some(isCurrent))?.id ?? null;

  // Collapsed by default, and remembered. A newcomer's first look is seven
  // headings rather than twenty-five links, and the one they're standing in is
  // already open — which is the whole point of filing them. Only groups the
  // viewer has explicitly toggled get an entry here, so turning a feature on
  // later doesn't land inside a group someone silently closed months ago.
  const [openGroups, setOpenGroups] = useLocalStorage<Record<string, boolean>>({
    key: "camptool:nav-groups",
    defaultValue: {},
    getInitialValueInEffect: true,
  });
  const groupOpen = (g: NavGroup) =>
    openGroups[g.id] ?? g.id === currentGroupId;
  // Navigating INTO a group you'd closed re-opens it — otherwise the link that
  // is currently highlighted would be the one link you can't see. Deliberately
  // keyed on the group changing, so your own click to close it still sticks.
  useEffect(() => {
    if (currentGroupId && openGroups[currentGroupId] === false) {
      // Explicit object, not a functional updater — Mantine's useLocalStorage
      // setter passes its own uninitialised state to the callback.
      setOpenGroups({ ...openGroups, [currentGroupId]: true });
    }
  }, [currentGroupId, openGroups, setOpenGroups]);

  async function switchCamp(id: string | null) {
    if (!id || id === activeCampId) return;
    const origin = camps.find((c) => c.id === id)?.origin;
    if (origin) {
      window.location.assign(`${origin}${location.pathname}`);
      return;
    }
    await authClient.organization.setActive({ organizationId: id });
    navigate(location.pathname, { replace: true });
  }

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  const [feedbackOpen, { open: openFeedback, close: closeFeedback }] =
    useDisclosure();

  // Shared by the wide header's Privacy button and the phone menu.
  const privacyItems = (
    <>
      <Menu.Label>Privacy mode</Menu.Label>
      <Menu.Item onClick={() => setPrivacy({ on: false, keepSelf: false })}>
        {!privacyMode.on ? "✓ " : ""}Off — show real people
      </Menu.Item>
      <Menu.Item onClick={() => setPrivacy({ on: true, keepSelf: false })}>
        {privacyMode.on && !privacyMode.keepSelf ? "✓ " : ""}
        On — fake names for everyone
      </Menu.Item>
      <Menu.Item onClick={() => setPrivacy({ on: true, keepSelf: true })}>
        {privacyMode.on && privacyMode.keepSelf ? "✓ " : ""}
        On — but keep my own name
      </Menu.Item>
    </>
  );

  const yearSelect = (width: number, leftSection?: ReactNode) => (
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
      leftSection={leftSection}
      w={width}
    />
  );

  const renderNavLink = (item: NavItem) => (
    <MantineNavLink
      key={item.to}
      component={NavLink}
      to={item.to}
      end={item.end}
      // Start loading the page (code and data) on hover, focus or the start
      // of a tap, so it's often there by the time the click lands
      // (plans/fast-navigation.md).
      prefetch="intent"
      label={item.label}
      rightSection={
        item.preview ? (
          <Badge size="xs" color="grape" variant="light">
            preview
          </Badge>
        ) : item.badge ? (
          <Badge size="xs" color="red" variant="filled" circle>
            {item.badge}
          </Badge>
        ) : undefined
      }
      onClick={() => opened && toggle()}
    />
  );

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
          {/* Wide screens: everything laid out in a row. */}
          <Group
            gap="md"
            wrap="nowrap"
            visibleFrom="md"
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
                w={180}
              />
            ) : null}
            {editions.length > 0 ? (
              <Group gap={6} wrap="nowrap">
                {yearSelect(130)}
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
                <Menu.Dropdown>{privacyItems}</Menu.Dropdown>
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
            <Button
              variant="subtle"
              size="xs"
              color="gray"
              onClick={openFeedback}
            >
              Feedback
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <UnstyledButton aria-label={`Account menu — ${user.name}`}>
                  <Text size="sm" fw={500} truncate maw={180}>
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
          {/* Narrow screens: the year stays in view, since it changes what
              every page shows, and everything else folds into one menu behind
              your initials. As a wrapping row it spilled out of the 56px
              header. */}
          <Group gap="xs" wrap="nowrap" hiddenFrom="md">
            {editions.length > 0
              ? yearSelect(
                  96,
                  activeEditionLocked ? (
                    <LockGlyph label="Year is locked" />
                  ) : undefined,
                )
              : null}
            <Menu position="bottom-end" withinPortal width={240}>
              <Menu.Target>
                <UnstyledButton aria-label={`Menu — ${user.name}`}>
                  <Avatar
                    name={user.name}
                    color={privacyMode.on ? "orange" : "initials"}
                    variant={privacyMode.on ? "filled" : "light"}
                    size={32}
                  />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {user.name}
                  <br />
                  {user.email}
                </Menu.Label>
                {camps.length > 1 ? (
                  <>
                    <Menu.Divider />
                    <Menu.Label>Camp</Menu.Label>
                    {camps.map((c) => (
                      <Menu.Item key={c.id} onClick={() => switchCamp(c.id)}>
                        {c.id === activeCampId ? "✓ " : ""}
                        {c.name}
                      </Menu.Item>
                    ))}
                  </>
                ) : null}
                {canUsePrivacy ? (
                  <>
                    <Menu.Divider />
                    {privacyItems}
                  </>
                ) : null}
                <Menu.Divider />
                {binsMenu ? (
                  <Menu.Item
                    component="a"
                    href="/bins"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {binsMenu.label} ↗
                  </Menu.Item>
                ) : null}
                <Menu.Item onClick={openFeedback}>Send feedback</Menu.Item>
                <Menu.Item onClick={handleSignOut}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <FeedbackModal opened={feedbackOpen} onClose={closeFeedback} />

      <AppShell.Navbar
        p="sm"
        // See the note on `navbar` above: this, not `collapsed`, is what
        // actually moves the navbar when you click a burger. −100% rather than
        // −220px because Mantine widens the navbar to the full viewport below
        // the breakpoint, and both cases have to slide fully out of view.
        style={navHidden ? { transform: "translateX(-100%)" } : undefined}
      >
        {/* The nav list scrolls on its own. Enough features are switched on now
            that the list is taller than a laptop viewport, and without this the
            navbar — which is `position: fixed` at exactly viewport height —
            simply clipped whatever didn't fit, with no way to reach it: the
            page's own scrollbar moves the main content and leaves the navbar
            where it is. `grow` inside the navbar's flex column plus
            ScrollArea's `overflow: hidden` root (which is what lets a flex item
            shrink below its content) is Mantine's own pattern for this. */}
        <AppShell.Section grow component={ScrollArea} type="auto">
          {topLinks.map(renderNavLink)}
          {groups.map((g) => {
            const [only] = g.items;
            if (!only) return null;
            // A category holding one thing is a worse link than the thing.
            if (g.items.length === 1) return renderNavLink(only);
            const buried = g.items.reduce(
              (n, i) => n + Number(i.badge ?? 0),
              0,
            );
            const isOpen = groupOpen(g);
            return (
              <MantineNavLink
                key={g.id}
                // A real <button>: an <a> with no href takes no keyboard focus,
                // and these only ever expand — they navigate nowhere.
                component="button"
                childrenOffset={16}
                opened={isOpen}
                // Mantine only sets `data-expanded`, which says nothing to a
                // screen reader; this is a disclosure and should announce as one.
                aria-expanded={isOpen}
                onChange={(o) => setOpenGroups({ ...openGroups, [g.id]: o })}
                label={
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600}>
                      {g.label}
                    </Text>
                    {/* A closed group must not swallow a count somebody needs
                        to act on. Shown only while closed — once it's open the
                        badge on the link itself says it better. */}
                    {!isOpen && buried > 0 ? (
                      <Badge size="xs" color="red" variant="filled" circle>
                        {buried}
                      </Badge>
                    ) : null}
                  </Group>
                }
              >
                {g.items.map(renderNavLink)}
              </MantineNavLink>
            );
          })}
          {/* Below the line is you, not the camp. */}
          <Divider my="xs" />
          {bottomLinks.map(renderNavLink)}
        </AppShell.Section>
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
        {campMoving ? (
          <ShellBanner
            color="orange"
            announce
            action={
              activeRole === "admin" ? (
                <Button
                  component={NavLink}
                  to="/move"
                  size="xs"
                  variant="light"
                  color="orange"
                >
                  The move
                </Button>
              ) : null
            }
          >
            <b>This camp is moving</b> to another CampTool site. It's read-only
            until the move is finished.
          </ShellBanner>
        ) : null}
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
        {/* Start the new year (app/lib/year-nudge.ts). Officers get it from
            exodus on until the year exists; "Not now" quiets it for two
            weeks. Creating it lands on /editions, where it's now the year
            being viewed. */}
        {yearBanner?.kind === "waiting" ? (
          <ShellBanner color="blue">
            <b>Your camp hasn't started a year yet.</b> The map, roster, and
            gear list open up once an officer adds one.
          </ShellBanner>
        ) : yearBanner ? (
          <ShellBanner
            color="blue"
            action={
              <Group gap="xs" wrap="nowrap">
                <Form method="post" action="/editions">
                  <input type="hidden" name="intent" value="create" />
                  <input type="hidden" name="year" value={yearBanner.year} />
                  <input type="hidden" name="event" value={yearBanner.event} />
                  {yearBanner.kind === "next" ? (
                    <input
                      type="hidden"
                      name="copyFromId"
                      value={yearBanner.from.id}
                    />
                  ) : null}
                  <Button type="submit" size="xs" variant="filled" color="blue">
                    {yearBanner.kind === "first" ? "Add" : "Start"}{" "}
                    {yearBanner.year}
                  </Button>
                </Form>
                <Form method="post" action="/editions">
                  <input type="hidden" name="intent" value="snoozeYearNudge" />
                  <input type="hidden" name="year" value={yearBanner.year} />
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
            {yearBanner.kind === "first" ? (
              <>
                <b>Add your camp's first year.</b> The map, roster, and gear
                list all belong to a year.
              </>
            ) : (
              <>
                <b>Time to start {yearBanner.year}.</b> It begins with{" "}
                {yearBanner.from.year}'s lot setup, and everyone sees{" "}
                {yearBanner.year} from then on. {yearBanner.from.year} stays in
                the year picker.
              </>
            )}
          </ShellBanner>
        ) : null}
        <KindsProvider kinds={customKinds}>
          <Outlet />
        </KindsProvider>
      </AppShell.Main>
    </AppShell>
  );
}

/** A small padlock for the phone header's year picker, which has no room for
 * the wide header's "locked" badge. */
function LockGlyph({ label }: { label: string }) {
  return (
    <svg
      role="img"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{label}</title>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
