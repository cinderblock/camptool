/**
 * Outstanding asks — "what does the camp still need from me?"
 *
 * One registry of everything the app ever wants from a camper, each entry
 * carrying where to go and do it, who it applies to, when in the season it
 * matters, which camp feature it belongs to, and — the part that makes this
 * work — a **pure predicate over a snapshot** saying whether it's already
 * satisfied.
 *
 * Pure and client-safe, no server imports, so the loader and the React
 * component share one source of truth. The queries live in `asks.server.ts`.
 *
 * ## Satisfaction, not resolution
 *
 * The wizard's `wizard_ask` table records that someone clicked Next or Skip. It
 * does NOT record that the data arrived, which is why bailing out of the wizard
 * is invisible today and why adding a required question never re-nags anyone.
 * Here an ask is satisfied when the underlying data says so, re-derived on every
 * load. Dismissal is a separate, weaker thing: it silences a `recommended` or
 * `optional` ask, and is ignored for a `required` one.
 *
 * A few asks have nothing to derive from — they're an acknowledgement, not a
 * datum. Those read `acknowledged` out of the same snapshot, so every ask still
 * answers the same question the same way.
 *
 * ## Adding an ask
 *
 * Add an entry here, add whatever it reads to `AskSnapshot`, and load that field
 * in `asks.server.ts`. Every surface — the dashboard card, the nav count, the
 * guide timeline, the officer roll-up — picks it up with no further edits. Give
 * it a `route` a camper can actually act on; an ask with nowhere to go is noise.
 */
import {
  type FeatureKey,
  type FeatureState,
  featureVisibleTo,
} from "./features";
import { hasAtLeast } from "./permissions";

/** Who an ask is for. "returning" = member+; "recruit" = a prospective camper. */
export type AskAudience = "all" | "returning" | "recruit";

/**
 * How hard to push, and whether dismissal is allowed.
 *
 * - `required` — the camp can't run without it. Cannot be dismissed, so a newly
 *   added required question re-surfaces for people who already "finished".
 * - `recommended` — the camp wants it; dismissible.
 * - `optional` — an offer rather than a debt (propose a talk, claim a supply).
 */
export type AskImportance = "required" | "recommended" | "optional";

export const IMPORTANCE_RANK: Record<AskImportance, number> = {
  required: 0,
  recommended: 1,
  optional: 2,
};

/** Everything the predicates read. One batch per camp — see `asks.server.ts`. */
export type AskSnapshot = {
  /** Camp role, for audience matching and feature visibility. */
  role: string;

  // — profile —
  hasName: boolean;
  hasPlayaName: boolean;

  // — attendance —
  rsvp: "unknown" | "coming" | "maybe" | "not_coming";
  hasArrivalDate: boolean;
  hasDepartureDate: boolean;
  /** Arriving before gates open, so a Setup Access Pass is needed. */
  needsSetupPass: boolean;

  // — questions —
  unansweredRequiredQuestions: number;

  // — gear and map —
  bringingCount: number;
  unplacedCount: number;
  /** Domiciles/vehicles they own that nobody has been listed in. */
  domicilesWithoutOccupants: number;

  // — camp checklist —
  checklistRemaining: number;

  // — tickets —
  hasTicket: boolean;
  ticketRequested: boolean;
  ticketsAwaitingPurchase: number;

  // — setup passes —
  hasSetupPassRow: boolean;

  // — declarations —
  fuelDeclared: boolean;

  // — money —
  duesOwedCents: number;

  // — account —
  discordLinked: boolean;
  /** At least one passkey enrolled. Keyed by user, not membership — a passkey
   * is an account credential, so it follows the human across every camp. */
  hasPasskey: boolean;

  /**
   * Asks the camper has explicitly waved off. Ignored for `required` asks.
   * Backed by `wizard_ask.status = 'skipped'`.
   */
  dismissed: Record<string, boolean>;
  /**
   * Asks with nothing derivable, marked done by passing through them. Backed by
   * `wizard_ask.status = 'done'`.
   */
  acknowledged: Record<string, boolean>;
};

export type AskDef = {
  key: string;
  /** Imperative and specific — this is the to-do row's text. */
  label: string;
  /** Sub-label for the wizard stepper and the to-do row's second line. */
  hint: string;
  /** Where the camper goes to satisfy it. Must not bounce them (see `feature`). */
  route: string;
  audience: AskAudience;
  importance: AskImportance;
  /** Weeks before the event this becomes relevant; null = always open. */
  opensWeeksBefore: number | null;
  /** Weeks before the event after which it stops being surfaced; null = never. */
  closesWeeksBefore?: number | null;
  /**
   * Camp feature this belongs to. The ask is dropped unless the feature is
   * visible to this camper — `requireFeature` redirects rather than 404ing, so
   * an ungated ask would link somewhere that bounces. Unset = core.
   */
  feature?: FeatureKey;
  /** Appears as a step in the `/start` wizard. */
  wizard?: boolean;
  isSatisfied: (s: AskSnapshot) => boolean;
};

/** Someone who told us they aren't coming is owed nothing else. */
const attending = (s: AskSnapshot) => s.rsvp !== "not_coming";

/**
 * Catalog order = presentation order within an importance band. Roughly the
 * season arc: who you are, whether you're coming, then gear, then logistics.
 */
export const ASKS: AskDef[] = [
  {
    key: "profile",
    label: "Tell us your name",
    hint: "Your name and playa name",
    route: "/start",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: null,
    wizard: true,
    isSatisfied: (s) => s.hasName,
  },
  {
    key: "questionnaire",
    label: "Answer the camp's questions",
    hint: "A few things the camp needs to know",
    route: "/questions",
    audience: "all",
    importance: "required",
    opensWeeksBefore: null,
    feature: "questions",
    wizard: true,
    // Re-derived every load, so an officer adding a required question re-nags
    // people who already walked past this step.
    isSatisfied: (s) => s.unansweredRequiredQuestions === 0,
  },
  {
    key: "rsvp",
    label: "Say whether you're coming",
    hint: "Yes, no, or maybe",
    route: "/start",
    audience: "all",
    importance: "required",
    opensWeeksBefore: null,
    wizard: true,
    isSatisfied: (s) => s.rsvp !== "unknown",
  },
  {
    key: "stay_dates",
    label: "Give your arrival and departure dates",
    hint: "So the camp can plan headcount and setup",
    route: "/start",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: null,
    isSatisfied: (s) =>
      !attending(s) || (s.hasArrivalDate && s.hasDepartureDate),
  },
  {
    key: "bringing",
    label: "Tell us what you're bringing",
    hint: "Tents, vehicles, shade",
    route: "/bringing",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: 12,
    feature: "bringing",
    wizard: true,
    isSatisfied: (s) => !attending(s) || s.bringingCount > 0,
  },
  {
    key: "place_on_map",
    label: "Put your stuff on the camp map",
    hint: "Everything you're bringing needs a spot",
    route: "/map",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: 8,
    feature: "map",
    isSatisfied: (s) => !attending(s) || s.unplacedCount === 0,
  },
  {
    key: "sharing",
    label: "Say who's sleeping in your structures",
    hint: "So the camp knows where everyone is",
    route: "/start",
    audience: "all",
    importance: "optional",
    opensWeeksBefore: 12,
    feature: "bringing",
    wizard: true,
    isSatisfied: (s) => !attending(s) || s.domicilesWithoutOccupants === 0,
  },
  {
    key: "ticket",
    label: "Sort out your ticket",
    hint: "Request one, or say you already have one",
    route: "/tickets",
    audience: "all",
    importance: "required",
    opensWeeksBefore: 20,
    feature: "tickets",
    isSatisfied: (s) => !attending(s) || s.hasTicket || s.ticketRequested,
  },
  {
    key: "ticket_purchased",
    label: "Confirm you bought your ticket",
    hint: "The camp can't tell until you say so",
    route: "/tickets",
    audience: "all",
    importance: "required",
    opensWeeksBefore: null,
    feature: "tickets",
    isSatisfied: (s) => s.ticketsAwaitingPurchase === 0,
  },
  {
    key: "setup_pass",
    label: "Request a Setup Access Pass",
    hint: "You're arriving before gates open",
    route: "/passes",
    audience: "all",
    importance: "required",
    opensWeeksBefore: null,
    feature: "passes",
    // Only ever asked of someone whose stated arrival is before gate-open.
    isSatisfied: (s) => !attending(s) || !s.needsSetupPass || s.hasSetupPassRow,
  },
  {
    key: "fuel",
    label: "Declare the fuel you're bringing",
    hint: "Gas, propane — the camp has to account for it",
    route: "/fuel",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: 8,
    feature: "fuel",
    isSatisfied: (s) => !attending(s) || s.fuelDeclared,
  },
  {
    key: "checklist",
    label: "Work through the camp checklist",
    hint: "The things everyone has to do",
    route: "/onboarding",
    audience: "all",
    importance: "recommended",
    opensWeeksBefore: 8,
    feature: "onboarding",
    wizard: true,
    isSatisfied: (s) => !attending(s) || s.checklistRemaining === 0,
  },
  {
    key: "dues",
    label: "Pay your camp dues",
    hint: "What's still outstanding",
    route: "/dues",
    audience: "all",
    importance: "required",
    opensWeeksBefore: null,
    feature: "dues",
    isSatisfied: (s) => !attending(s) || s.duesOwedCents <= 0,
  },
  {
    key: "passkey",
    label: "Set up a passkey",
    hint: "Sign in with your face, fingerprint or PIN — no password",
    route: "/account",
    audience: "all",
    // `required` so it cannot be waved off: this stays on the to-do list until
    // a passkey actually exists. Passkeys are where sign-in is heading (see
    // plans/passkey-first-auth.md), and an account with no passkey is the one
    // that gets locked out when legacy login is eventually switched off.
    importance: "required",
    // Nothing seasonal about it — an account needs a credential year-round.
    opensWeeksBefore: null,
    // Core, not a camp feature: every account wants one regardless of which
    // features the camp has turned on.
    isSatisfied: (s) => s.hasPasskey,
  },
  {
    key: "discord",
    label: "Link your Discord account",
    hint: "Where the camp actually talks",
    route: "/settings",
    audience: "all",
    importance: "optional",
    opensWeeksBefore: null,
    isSatisfied: (s) => s.discordLinked,
  },
  {
    key: "extras",
    label: "Anything else we should know?",
    hint: "Free-text, entirely optional",
    route: "/start",
    audience: "all",
    importance: "optional",
    opensWeeksBefore: null,
    wizard: true,
    // Nothing to derive — passing through it is the whole point.
    isSatisfied: (s) => s.acknowledged.extras === true,
  },
];

export const ASK_BY_KEY = new Map(ASKS.map((a) => [a.key, a]));

/** A camper's audience from their camp role. */
export function audienceForRole(role: string): "returning" | "recruit" {
  return hasAtLeast(role, "member") ? "returning" : "recruit";
}

type Schedulable = Pick<
  AskDef,
  "audience" | "opensWeeksBefore" | "closesWeeksBefore" | "feature"
>;

export function askMatchesAudience(ask: Schedulable, role: string): boolean {
  return ask.audience === "all" || ask.audience === audienceForRole(role);
}

export function askInSeason(
  ask: Schedulable,
  weeksUntilEvent: number,
): boolean {
  // Not yet open: still further out than the open threshold.
  if (ask.opensWeeksBefore != null && weeksUntilEvent > ask.opensWeeksBefore) {
    return false;
  }
  // Closed: fewer weeks remain than the close threshold (e.g. past the event).
  if (
    ask.closesWeeksBefore != null &&
    weeksUntilEvent < ask.closesWeeksBefore
  ) {
    return false;
  }
  return true;
}

export type AskContext = {
  weeksUntilEvent: number;
  featureStates?: Partial<Record<FeatureKey, FeatureState>>;
};

/** Is this ask relevant to this camper right now, satisfied or not? */
export function askIsScheduled(
  ask: AskDef,
  snapshot: AskSnapshot,
  ctx: AskContext,
): boolean {
  if (!askMatchesAudience(ask, snapshot.role)) return false;
  if (!askInSeason(ask, ctx.weeksUntilEvent)) return false;
  if (ask.feature && ctx.featureStates) {
    // Don't nudge toward a page the camper would be redirected off.
    if (
      !featureVisibleTo(ctx.featureStates[ask.feature] ?? "off", snapshot.role)
    )
      return false;
  }
  return true;
}

export type OutstandingAsk = {
  key: string;
  label: string;
  hint: string;
  route: string;
  importance: AskImportance;
  /** Whether the camper is allowed to wave this one off. */
  dismissible: boolean;
};

/**
 * Everything still owed, most pressing first.
 *
 * Outstanding = scheduled AND not satisfied AND not dismissed — where dismissal
 * only counts for non-required asks, so waving off something the camp actually
 * needs isn't possible.
 */
export function outstandingAsks(
  snapshot: AskSnapshot,
  ctx: AskContext,
): OutstandingAsk[] {
  return ASKS.filter((a) => {
    if (!askIsScheduled(a, snapshot, ctx)) return false;
    if (a.isSatisfied(snapshot)) return false;
    if (a.importance !== "required" && snapshot.dismissed[a.key]) return false;
    return true;
  })
    .map((a) => ({
      key: a.key,
      label: a.label,
      hint: a.hint,
      route: a.route,
      importance: a.importance,
      dismissible: a.importance !== "required",
    }))
    .sort(
      (x, y) => IMPORTANCE_RANK[x.importance] - IMPORTANCE_RANK[y.importance],
    );
}

/** Everything scheduled for this camper, with whether each is done — the guide's
 * progress read-out, as opposed to just what's left. */
export function askProgress(
  snapshot: AskSnapshot,
  ctx: AskContext,
): {
  key: string;
  label: string;
  hint: string;
  route: string;
  done: boolean;
}[] {
  return ASKS.filter((a) => askIsScheduled(a, snapshot, ctx)).map((a) => ({
    key: a.key,
    label: a.label,
    hint: a.hint,
    route: a.route,
    done: a.isSatisfied(snapshot),
  }));
}
