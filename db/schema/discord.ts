/**
 * Per-camp Discord linkage. The OAuth credential lives in better-auth's
 * `account` table (global identity); this table denormalizes the Discord
 * identity for display/DMs and records whether the user is verified in THIS
 * camp's Discord guild. Tenant-scoped, so it carries `camp_id`.
 */
import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const discordLink = sqliteTable(
  "discord_link",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    discordUsername: text("discord_username"),
    inGuild: integer("in_guild", { mode: "boolean" }).notNull().default(false),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("discord_link_camp_user").on(t.campId, t.userId)],
);
