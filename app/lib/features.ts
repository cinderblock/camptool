/**
 * Camp-feature registry — the catalog of opt-in features a camp admin can turn
 * off / preview / on (see plans/camp-features.md). The catalog is CODE; each
 * camp's chosen state is DATA (`camp_feature` rows, resolved in
 * features.server.ts). Pure + client-safe: imported by the layout nav, the
 * settings page, and the server helpers.
 *
 * Core surfaces (Overview, guide, members, invite, years, /start, site admin)
 * are deliberately NOT in this catalog — they can't be turned off.
 */
import { type Role, hasAtLeast } from "./permissions";

export type FeatureState = "off" | "preview" | "on";

export type FeatureKey =
  | "announcements"
  | "documents"
  | "questions"
  | "onboarding"
  | "map"
  | "bringing"
  | "supplies"
  | "tickets"
  | "passes"
  | "finances"
  | "dues"
  | "recruiting"
  | "roster"
  // Reserved for the upcoming Schedule feature (plans/events-scheduling.md);
  // not in FEATURES yet, so they don't appear in settings until built.
  | "schedule"
  | "training";

export type CampFeatureDef = {
  key: FeatureKey;
  label: string;
  /** Shown on the settings page + the preview banner. */
  description: string;
  /** Pre-enabled for NEW camps (existing camps are grandfathered on). */
  starter?: boolean;
  /** Features this one builds on; the settings UI offers to enable them too. */
  requires?: FeatureKey[];
};

export const FEATURES: CampFeatureDef[] = [
  {
    key: "announcements",
    label: "Announcements",
    description: "Officer-posted camp news everyone reads, pinned to the top.",
    starter: true,
  },
  {
    key: "documents",
    label: "Documents",
    description:
      "A shared library of links — Google Docs, schedules, packing lists.",
    starter: true,
  },
  {
    key: "questions",
    label: "Questions",
    description:
      "A camp questionnaire: officers author questions, campers answer each year.",
    starter: true,
  },
  {
    key: "onboarding",
    label: "Onboarding checklist",
    description: "A camp-defined checklist new campers tick off.",
  },
  {
    key: "map",
    label: "Camp map",
    description:
      "The visual lot editor — place tents, vehicles, and structures on your plot.",
  },
  {
    key: "bringing",
    label: "Bringing & inventory",
    description:
      "Campers declare the gear they're bringing; officers account for every item.",
  },
  {
    key: "supplies",
    label: "Supplies",
    description:
      "Shared camp supplies organized into groups, with campers claiming items.",
  },
  {
    key: "tickets",
    label: "Tickets",
    description:
      "Distribute the camp's ticket allocation — requests, assignments, purchases.",
  },
  {
    key: "passes",
    label: "Setup passes",
    description:
      "Early-arrival passes — per-date quotas, member requests, officer grants.",
  },
  {
    key: "finances",
    label: "Finances",
    description: "An officer-only ledger of camp donations and spending.",
  },
  {
    key: "dues",
    label: "Dues",
    description: "Track member dues and contribution tiers.",
    requires: ["finances"],
  },
  {
    key: "recruiting",
    label: "Recruiting",
    description:
      "The public application page and the officer review queue for applicants.",
  },
  {
    key: "roster",
    label: "Who's coming",
    description:
      "The per-year attendee roster and headcount — members and their guests.",
  },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

export function featureDef(key: FeatureKey): CampFeatureDef | undefined {
  return BY_KEY.get(key);
}

/** Absence of a camp_feature row means this. */
export function defaultFeatureState(def: CampFeatureDef): FeatureState {
  return def.starter ? "on" : "off";
}

export function isFeatureState(value: string): value is FeatureState {
  return value === "off" || value === "preview" || value === "on";
}

/** Can someone with `role` see a feature in `state`? Preview = officers+. */
export function featureVisibleTo(state: FeatureState, role: string): boolean {
  if (state === "on") return true;
  if (state === "preview") return hasAtLeast(role, "officer");
  return false;
}

export type { Role };
