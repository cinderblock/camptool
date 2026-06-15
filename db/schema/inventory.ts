/**
 * Camp supplies inventory — SHARED camp gear organized into groups, distinct from
 * the per-camper "bringing" inventory (`map_object`, personal tents/vehicles).
 * e.g. Bar (drinks, mixers, tools, signs), Lecture Hall (books, markers).
 *
 *   inventory_category   a grouping ("Bar", "Lecture Hall"). CAMP-scoped config —
 *                        the categories persist across years, like onboarding_task.
 *   inventory_item       one supply line within a category. EDITION-scoped (what we
 *                        need / who's bringing it changes per year), so it carries
 *                        both camp_id and edition_id; a locked year is read-only.
 *                        `owner_membership_id` = who's bringing it (null = unclaimed).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const inventoryCategory = sqliteTable(
  "inventory_category",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("inventory_category_camp").on(t.campId)],
);

export const inventoryItem = sqliteTable(
  "inventory_item",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    categoryId: text("category_id")
      .notNull()
      .references(() => inventoryCategory.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    // Who's bringing it; null = unclaimed (still needed). Cleared if they leave.
    ownerMembershipId: text("owner_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("inventory_item_edition").on(t.editionId),
    index("inventory_item_category").on(t.categoryId),
  ],
);
