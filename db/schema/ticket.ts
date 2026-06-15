/**
 * Ticketing — Directed Group Sale (DGS) tickets + Setup Access Passes. Both are
 * per-year allocations a camp distributes to its members, so every row carries
 * `camp_id` (the hard multi-camp invariant) AND `edition_id` (the operative
 * per-year scope, like the map tables). A locked edition is read-only.
 *
 *   ticket          one guaranteed DGS ticket slot — fungible in access but not
 *                   in value (tier + price); assignable to a member. The camp
 *                   only decides who gets each slot: Burning Man sets the price
 *                   and runs checkout, so the assignee buys their own ticket via
 *                   a unique vendor link (`purchase_url`) during the sale window.
 *   ticket_request  a member's ask for a ticket (unbound to a specific ticket
 *                   until an officer assigns one).
 *   setup_pass_date an early-arrival entry date + the per-date quota the camp got.
 *   setup_pass      an individual pass for a date; request + grant unified via
 *                   `status` (quota counts only `granted`).
 *
 * `price_cents` is the ticket's value as set by the vendor (integer cents,
 * nullable: null = TBD, 0 = free) — the camp never collects it.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const ticket = sqliteTable(
  "ticket",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    // Optional price tier label, e.g. "Standard" / "Low-income" / "Comp".
    tier: text("tier"),
    // Integer cents — the ticket's value as set by the vendor. Null = TBD; 0 = free.
    priceCents: integer("price_cents"),
    // Unique vendor link the assignee uses to buy this ticket during the sale
    // window (officer pastes the per-slot link BM hands out). Null = not set yet.
    purchaseUrl: text("purchase_url"),
    // The member this ticket is allocated to; null = still in the pool.
    assignedMembershipId: text("assigned_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    // available (in pool) -> assigned (allocated to a member) -> purchased
    // (the member confirms they bought it from the vendor; member-set).
    status: text("status").notNull().default("available"),
    notes: text("notes"),
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
  (t) => [index("ticket_edition").on(t.editionId)],
);

export const ticketRequest = sqliteTable(
  "ticket_request",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    note: text("note"),
    // pending -> approved (a ticket was assigned) | denied.
    status: text("status").notNull().default("pending"),
    // The ticket granted on approval (null until then / if denied).
    resolvedTicketId: text("resolved_ticket_id").references(() => ticket.id, {
      onDelete: "set null",
    }),
    resolvedByMembershipId: text("resolved_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("ticket_request_edition").on(t.editionId)],
);

export const setupPassDate = sqliteTable(
  "setup_pass_date",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    // ISO calendar date, YYYY-MM-DD.
    date: text("date").notNull(),
    // Optional friendly label, e.g. "Monday".
    label: text("label"),
    // Cap of granted passes allowed for this date.
    quota: integer("quota").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("setup_pass_date_unique").on(t.editionId, t.date)],
);

export const setupPass = sqliteTable(
  "setup_pass",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    passDateId: text("pass_date_id")
      .notNull()
      .references(() => setupPassDate.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // requested -> granted (counts against quota) | denied.
    status: text("status").notNull().default("requested"),
    note: text("note"),
    resolvedByMembershipId: text("resolved_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("setup_pass_edition").on(t.editionId),
    uniqueIndex("setup_pass_member_date").on(t.passDateId, t.membershipId),
  ],
);
