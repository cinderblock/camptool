/**
 * Multi-camp tenancy spine, owned by better-auth's organization plugin but
 * mapped onto our domain names:
 *   organization -> camp        member -> membership
 * Every tenant-scoped row carries a `camp_id` SQL column (the hard multi-camp
 * invariant). The better-auth field stays `organizationId` so the plugin works
 * unmodified; only the SQL column name is ours.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
});
