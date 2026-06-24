/**
 * Camp announcements — officer-posted news that all members can read. Edition-
 * scoped (per year), like the rest of the per-year content; pinned ones float to
 * the top. A locked year is read-only.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, campEdition } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const announcement = sqliteTable(
  "announcement",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id")
      .notNull()
      .references(() => campEdition.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("announcement_edition").on(t.editionId)],
);
