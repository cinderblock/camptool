/**
 * Training / permission sign-offs — camp-defined qualifications ("Fire
 * safety", "Generator operation") that officers grant to members, with a
 * validity level, and that gatherings can require before sign-up. Design:
 * plans/events-scheduling.md. Gated by the `training` camp feature.
 *
 *   training              CAMP-scoped definition (persists across years, like
 *                         camp_question). `validity` = how long a sign-off
 *                         holds: lifetime (one-time ever) | per_edition
 *                         (re-sign each year) | annual (~1yr from grant).
 *   training_signoff      one grant to one member. Whether it's currently
 *                         valid is COMPUTED (isValidSignoff in
 *                         app/lib/training.ts) from the training's validity +
 *                         this row's editionId/expiresAt/revokedAt — renewals
 *                         are new rows, so history is kept.
 *   gathering_requirement a gathering requires a training: `required` blocks
 *                         sign-up without a valid sign-off; `warn` allows but
 *                         flags. Officers assigning someone may override.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, campEdition, membership } from "./camp";
import { gathering } from "./schedule";

const now = sql`(unixepoch() * 1000)`;

export const training = sqliteTable(
  "training",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // lifetime | per_edition | annual (see header).
    validity: text("validity").notNull().default("per_edition"),
    // Soft-retire so existing sign-offs survive (like camp_question).
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("training_camp").on(t.campId)],
);

export const trainingSignoff = sqliteTable(
  "training_signoff",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    trainingId: text("training_id")
      .notNull()
      .references(() => training.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // Which year a per_edition sign-off covers; NULL for lifetime/annual.
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    grantedByMembershipId: text("granted_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    grantedAt: integer("granted_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    // For annual validity: grant time + ~1yr. NULL = no time expiry.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    note: text("note"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("training_signoff_member").on(t.trainingId, t.membershipId)],
);

export const gatheringRequirement = sqliteTable(
  "gathering_requirement",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    gatheringId: text("gathering_id")
      .notNull()
      .references(() => gathering.id, { onDelete: "cascade" }),
    trainingId: text("training_id")
      .notNull()
      .references(() => training.id, { onDelete: "cascade" }),
    // required (block sign-up) | warn (allow, flag).
    enforcement: text("enforcement").notNull().default("required"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("gathering_requirement_unique").on(t.gatheringId, t.trainingId),
  ],
);
