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
  | "wiki"
  | "bins"
  | "questions"
  | "onboarding"
  | "map"
  | "bringing"
  | "supplies"
  | "tickets"
  | "passes"
  | "swaps"
  | "fuel"
  | "finances"
  | "dues"
  | "recruiting"
  | "roster"
  | "schedule"
  | "training"
  | "programming";

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
    key: "wiki",
    label: "Wiki",
    description:
      "A camp-wide knowledge base — any member can create and edit pages.",
  },
  {
    key: "bins",
    label: "Bins",
    description:
      "A top-bar shortcut into the camp's bins inventory tracker — the QR-sticker app for what's in which box — opened already signed in. Set the address and access code below once it's on.",
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
    key: "swaps",
    label: "Spares board",
    description:
      "Campers post spare tickets and vehicle passes, or ask for one — with an asking price and a way to mark it taken. The camp isn't a party to the arrangement.",
  },
  {
    key: "fuel",
    label: "Fuel",
    description:
      "Who's bringing fuel, how much, and in what — with totals and container counts for the fire-safety review and the map's fuel-storage area.",
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
  {
    key: "schedule",
    label: "Schedule",
    description:
      "Work parties, camp meetings, and shifts — with sign-ups and a calendar.",
  },
  {
    key: "training",
    label: "Training",
    description:
      "Qualifications officers sign members off on — one-time, yearly, or per event.",
  },
  {
    key: "programming",
    label: "Programming",
    description:
      "What your camp offers the event — talks, workshops, classes. Campers propose, officers schedule, everyone can see the lineup.",
  },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Which feature gates a route path (first segment). The layout uses this to
 * show the preview banner; route loaders call requireFeature themselves. */
const ROUTE_FEATURES: Record<string, FeatureKey> = {
  announcements: "announcements",
  documents: "documents",
  wiki: "wiki",
  bins: "bins",
  questions: "questions",
  onboarding: "onboarding",
  map: "map",
  bringing: "bringing",
  inventory: "bringing",
  supplies: "supplies",
  tickets: "tickets",
  passes: "passes",
  swaps: "swaps",
  fuel: "fuel",
  finances: "finances",
  dues: "dues",
  recruits: "recruiting",
  roster: "roster",
  schedule: "schedule",
  training: "training",
  programming: "programming",
};

export function featureForPath(pathname: string): FeatureKey | null {
  const first = pathname.split("/").filter(Boolean)[0];
  return first ? (ROUTE_FEATURES[first] ?? null) : null;
}

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
