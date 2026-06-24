/**
 * Camp finances ledger — **donations** to the camp (money in) and camp **spends**
 * (money out). Officer-only (not shared with all campers). Edition-scoped (per
 * year), like inventory items; a locked year is read-only. Amounts are integer
 * CENTS to avoid float drift.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const financeEntry = sqliteTable(
  "finance_entry",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    // "donation" = money in, "expense" = money out.
    kind: text("kind").notNull(),
    // Positive integer cents; `kind` gives the sign.
    amountCents: integer("amount_cents").notNull(),
    description: text("description"),
    category: text("category"),
    // The associated member — the donor (donation) or who incurred the spend
    // (expense); null = external/anonymous. `counterparty` is a free-text donor
    // or vendor name when there's no member to link.
    memberId: text("member_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    counterparty: text("counterparty"),
    // When the donation/expense happened (may differ from when it was recorded).
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
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
  (t) => [index("finance_entry_edition").on(t.editionId)],
);

/**
 * A camp's named contribution **tiers** for a year (e.g. "Full share · $300",
 * "Sliding scale · suggested", "Work trade · $0"). Per-camp, **versioned per
 * edition** so each year is independent (copy forward to seed a new year); a camp
 * with no dues simply has none. `requirement` is the level of obligation. Money
 * amounts are integer cents (null = not a fixed dollar amount).
 */
export const contributionTier = sqliteTable(
  "contribution_tier",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id")
      .notNull()
      .references(() => campEdition.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    expectedCents: integer("expected_cents"),
    // "required" | "suggested" | "optional".
    requirement: text("requirement").notNull().default("suggested"),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("contribution_tier_edition").on(t.editionId)],
);
