/**
 * Shared camp documents — titled links (Google Docs/Drive, sheets, PDFs, …) the
 * camp shares: packing lists, MOOP plan, schedules, the camp handbook. CAMP-scoped
 * (not per-year) so the library persists across editions, like onboarding tasks.
 * Officers manage; everyone in camp can read. Links only for now (no file upload).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campDocument = sqliteTable(
  "camp_document",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    category: text("category"),
    sortOrder: integer("sort_order").notNull().default(0),
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
  (t) => [index("camp_document_camp").on(t.campId)],
);
