/**
 * Multi-camp tenancy spine, owned by better-auth's organization plugin but
 * mapped onto our domain names:
 *   organization -> camp        member -> membership
 * Every tenant-scoped row carries a `camp_id` SQL column (the hard multi-camp
 * invariant). The better-auth field stays `organizationId` so the plugin works
 * unmodified; only the SQL column name is ours.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";

const now = sql`(unixepoch() * 1000)`;

export const camp = sqliteTable("camp", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

/**
 * A camp's per-year **edition** — the second tenancy axis alongside `camp_id`.
 * Per-year data (the map/placement, the "bringing" inventory, …) is scoped to an
 * edition, so editing this year never mutates last year's, and a past edition can
 * be locked read-only yet still copied from. One edition per (camp, year).
 */
export const campEdition = sqliteTable(
  "camp_edition",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    label: text("label"),
    // Locked editions are read-only (e.g. last year, or "planned" once on playa).
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    // Which edition this one was copied from (import = snapshot, not a live link).
    forkedFromId: text("forked_from_id").references(
      (): AnySQLiteColumn => campEdition.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("camp_edition_camp_year").on(t.campId, t.year)],
);

export const membership = sqliteTable("membership", {
  id: text("id").primaryKey(),
  organizationId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  // Our additional fields (registered via the plugin's additionalFields).
  playaName: text("playa_name"),
  status: text("status").notNull().default("active"),
  // Invite-tree edge: the membership that invited this one (null = joined via
  // public application or is a root, e.g. the founder). Self-referential.
  invitedByMembershipId: text("invited_by_membership_id").references(
    (): AnySQLiteColumn => membership.id,
    { onDelete: "set null" },
  ),
  // Onboarding-wizard progress (app-managed, not a better-auth field): the
  // furthest step entered (0 = never started) and when it was finished.
  wizardStep: integer("wizard_step").notNull().default(0),
  wizardCompletedAt: integer("wizard_completed_at", { mode: "timestamp_ms" }),
  joinedAt: integer("joined_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});
