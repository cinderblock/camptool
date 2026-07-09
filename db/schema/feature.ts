/**
 * Camp features — per-camp opt-in feature gating (see plans/camp-features.md).
 * The feature CATALOG is code (`app/lib/features.ts`); this table holds each
 * camp's chosen STATE per feature. CAMP-scoped (not per-year): features are how
 * the camp runs, not edition data.
 *
 * One row per (camp, feature) that has ever been explicitly set; **absence =
 * the registry default** (starter features on, the rest off), so new camps
 * need no seeding. States: off | preview (visible to officers+ only, so the
 * leadership can explore before launch) | on. Turning a feature off never
 * deletes its data — the feature's tables keep their rows.
 *
 * NOT the camp-theme package seam (build-time code plugins); this is runtime
 * per-camp data.
 */
import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campFeature = sqliteTable(
  "camp_feature",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    // Catalog key from app/lib/features.ts (map, tickets, schedule, …).
    featureKey: text("feature_key").notNull(),
    // off | preview (officers+ only) | on.
    state: text("state").notNull().default("off"),
    updatedByMembershipId: text("updated_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("camp_feature_unique").on(t.campId, t.featureKey)],
);
