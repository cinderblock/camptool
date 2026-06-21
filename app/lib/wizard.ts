/**
 * Season-aware onboarding wizard — the pure catalog + scheduler (client-safe, no
 * server imports, so both the loader and the React component share one source of
 * truth).
 *
 * The wizard doesn't ask everyone everything at once. Each "ask" declares WHO it's
 * for (audience), WHEN it's relevant (a window relative to the event date), and
 * how important it is (priority). `scheduleAsks` computes the ordered set that's in
 * season for a given camper today; the wizard walks only those. Season dates are
 * hardcoded offsets from the event (see eventStartFor/weeksUntilEvent in brc.ts) —
 * no per-camp date config yet.
 */
import { hasAtLeast } from "./permissions";

export type AskKey =
  | "profile"
  | "questionnaire"
  | "bringing"
  | "extras"
  | "sharing"
  | "checklist";

/** Who an ask is for. "returning" = a member+ (back for another year); "recruit"
 * = a prospective camper (role recruit), who gets the bigger questionnaire. */
export type AskAudience = "all" | "returning" | "recruit";

export type AskPriority = "required" | "optional";

export type AskDef = {
  key: AskKey;
  label: string;
  /** Short stepper sub-label. */
  hint: string;
  audience: AskAudience;
  /** Weeks before the event this ask becomes relevant; null = always open. An ask
   * with opensWeeksBefore 12 first appears ~12 weeks out. */
  opensWeeksBefore: number | null;
  /** Weeks before the event after which it stops being surfaced; null = stays open
   * through (and past) the event. closesWeeksBefore 0 closes at event start. */
  closesWeeksBefore?: number | null;
  priority: AskPriority;
};

/** Catalog order = the order the wizard presents asks. Roughly the season arc:
 * profile / questionnaire (which now includes the "coming back?" RSVP) early;
 * bringing / extras / sharing / checklist as the event nears. The `extras` step
 * holds the "after the gear" questions plus the free-text "anything to add?". */
export const ASKS: AskDef[] = [
  {
    key: "profile",
    label: "Your info",
    hint: "Name & playa name",
    audience: "all",
    opensWeeksBefore: null,
    priority: "optional",
  },
  {
    key: "questionnaire",
    label: "Questionnaire",
    hint: "Coming back & a few questions",
    audience: "all",
    opensWeeksBefore: null,
    priority: "required",
  },
  {
    key: "bringing",
    label: "Bringing",
    hint: "Tents, vehicles, …",
    audience: "all",
    opensWeeksBefore: 12,
    priority: "optional",
  },
  {
    key: "extras",
    label: "A few more questions",
    hint: "About your gear & anything else",
    audience: "all",
    opensWeeksBefore: null,
    priority: "optional",
  },
  {
    key: "sharing",
    label: "Sharing",
    hint: "Who's with you",
    audience: "all",
    opensWeeksBefore: 12,
    priority: "optional",
  },
  {
    key: "checklist",
    label: "Checklist",
    hint: "Camp tasks",
    audience: "all",
    opensWeeksBefore: 8,
    priority: "optional",
  },
];

/** A camper's wizard audience from their camp role: recruits get the recruit-only
 * asks; everyone member-and-up counts as "returning". */
export function audienceForRole(role: string): "returning" | "recruit" {
  return hasAtLeast(role, "member") ? "returning" : "recruit";
}

export function askMatchesAudience(ask: AskDef, role: string): boolean {
  return ask.audience === "all" || ask.audience === audienceForRole(role);
}

export function askInSeason(ask: AskDef, weeksUntilEvent: number): boolean {
  // Not yet open: still more weeks out than the open threshold.
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

/** The ordered set of asks relevant to this camper right now. */
export function scheduleAsks(opts: {
  role: string;
  weeksUntilEvent: number;
}): AskDef[] {
  return ASKS.filter(
    (a) =>
      askMatchesAudience(a, opts.role) && askInSeason(a, opts.weeksUntilEvent),
  );
}
