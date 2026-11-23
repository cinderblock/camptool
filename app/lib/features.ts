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
import { hasAtLeast, type Role } from "./permissions";

export type FeatureState = "off" | "preview" | "on";

export type FeatureKey =
  | "announcements"
  | "documents"
  | "wiki"
  | "faq"
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
  | "prospects"
  | "roster"
  | "schedule"
  | "meetings"
  | "training"
  | "programming"
  | "groups";

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
    description: "Camp news posted by officers, with optional pinning.",
    starter: true,
  },
  {
    key: "documents",
    label: "Documents",
    description: "Shared links to external docs, spreadsheets, and folders.",
    starter: true,
  },
  {
    key: "wiki",
    label: "Wiki",
    description: "Camp knowledge base that any member can edit.",
  },
  {
    key: "faq",
    label: "FAQ",
    description:
      "Searchable Q&A maintained by officers, with a question queue.",
  },
  {
    key: "bins",
    label: "Bins",
    description: "Top-bar shortcut and storage lookup for your bins tracker.",
  },
  {
    key: "questions",
    label: "Questions",
    description: "Custom camp questions for campers to answer each year.",
    starter: true,
  },
  {
    key: "onboarding",
    label: "Checklist",
    description: "Camp-defined tasks for campers to check off.",
  },
  {
    key: "map",
    label: "Camp map",
    description:
      "Visual lot editor for tents, vehicles, and shared structures.",
  },
  {
    key: "bringing",
    label: "Gear & structures",
    description:
      "Campers list tents and vehicles; officers view the full roll-up.",
  },
  {
    key: "supplies",
    label: "Supplies",
    description:
      "Shared camp supplies grouped by category for members to claim.",
  },
  {
    key: "tickets",
    label: "Tickets",
    description: "Track camp ticket allocations, requests, and purchases.",
  },
  {
    key: "passes",
    label: "Setup passes",
    description: "Manage early-arrival pass requests, stock, and distribution.",
  },
  {
    key: "swaps",
    label: "Spares board",
    description: "Peer-to-peer board for spare tickets and vehicle passes.",
  },
  {
    key: "fuel",
    label: "Fuel",
    description:
      "Track fuel types, quantities, and containers for safety review.",
  },
  {
    key: "finances",
    label: "Finances",
    description: "Officer-only ledger of camp donations and expenses.",
  },
  {
    key: "dues",
    label: "Dues",
    description: "Contribution tiers and per-member dues tracking.",
    requires: ["finances"],
  },
  {
    key: "recruiting",
    label: "Applications",
    description: "Public application page and officer review queue.",
  },
  {
    key: "prospects",
    label: "Prospects",
    description:
      "Officer-only tracker for conversations with prospective campers.",
    // Deliberately no `requires`: a camp can track the people it's courting
    // without ever opening a public application page. When Recruiting is also
    // on, incoming applications match onto their prospect automatically.
  },
  {
    key: "roster",
    label: "Who's coming",
    description: "Per-year attendee roster, headcount, and guest list.",
  },
  {
    key: "groups",
    label: "Social groups",
    description:
      "Optional groups (families, couples, friends) for organizing the directory and roster.",
    starter: true,
  },
  {
    key: "schedule",
    label: "Schedule",
    description: "Work parties and shifts with sign-ups and a calendar.",
  },
  {
    key: "meetings",
    label: "Meetings",
    description:
      "Camp meetings with shared agendas, a join link, and summaries.",
    // A meeting IS a scheduled gathering — this feature is a purpose-built view
    // over the same rows, so Schedule has to be on for it to work.
    requires: ["schedule"],
  },
  {
    key: "training",
    label: "Training",
    description: "Track officer sign-offs on camp qualifications.",
  },
  {
    key: "programming",
    label: "Programming",
    description: "Proposals, scheduling, and public lineup for camp offerings.",
  },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Which feature gates a route path (first segment). The layout uses this to
 * show the preview banner; route loaders call requireFeature themselves. */
const ROUTE_FEATURES: Record<string, FeatureKey> = {
  announcements: "announcements",
  documents: "documents",
  wiki: "wiki",
  faq: "faq",
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
  prospects: "prospects",
  roster: "roster",
  schedule: "schedule",
  meetings: "meetings",
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
