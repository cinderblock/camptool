/**
 * Instance-wide (deployment-level) tables. These are the ONLY tables that are
 * deliberately NOT camp-scoped — they govern the whole CampTool deployment and
 * are controlled by super admins (deployment owners), not by any single camp.
 *
 * Same column/type conventions as the better-auth tables: snake_case SQL,
 * booleans as `integer({ mode: "boolean" })`, timestamps as epoch-ms integers.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

const now = sql`(unixepoch() * 1000)`;

/**
 * A single ("singleton") row of deployment toggles. Read/written only through
 * instance.server.ts, which keeps the one canonical row at id = "singleton".
 */
export const instanceSetting = sqliteTable("instance_setting", {
  id: text("id").primaryKey(),
  // When false, only super admins may create new camps.
  allowCampCreation: integer("allow_camp_creation", { mode: "boolean" })
    .notNull()
    .default(true),
  // When false, sign-ups are invite-only: a brand-new account can be created
  // only from a camp invite link or a camp's public apply page.
  allowOpenSignups: integer("allow_open_signups", { mode: "boolean" })
    .notNull()
    .default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

/**
 * Instance super admins (deployment owners). A side table rather than a column
 * on `user` so the user identity stays free of global roles (per the project's
 * multi-camp, per-camp-role invariant). The first account to ever register is
 * promoted automatically; existing super admins can grant others in-app.
 */
export const superAdmin = sqliteTable("super_admin", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});
