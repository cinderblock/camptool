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
  // Officer-authored blurb shown on the public application page (/c/:slug) —
  // what/where/when/vibe for strangers arriving cold. Plain text, newlines kept.
  description: text("description"),
  // Whether this camp tracks member dues / contribution tiers. Off by default —
  // camps with no dues never see the Dues feature (hidden from nav + route).
  tracksDues: integer("tracks_dues", { mode: "boolean" })
    .notNull()
    .default(false),
  // Placement/submission contact for the camp's map export (e.g. Burning Man
  // requires a name/email/phone on the layout). Camp-scoped — persists across
  // years — and officer-editable via the map export dialog. All nullable.
  placementContactName: text("placement_contact_name"),
  placementContactPlaya: text("placement_contact_playa"),
  placementContactEmail: text("placement_contact_email"),
  placementContactPhone: text("placement_contact_phone"),
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
    // Which event this edition is for (Burning Man, UnSCruz, …). Gates the
    // event-specific layer (BRC map provider, BM ticket/pass flows, the Burning
    // Man disclaimer). Defaults to Burning Man — see `app/lib/events.ts`.
    event: text("event").notNull().default("burning-man"),
    // Locked editions are read-only (e.g. last year, or "planned" once on playa).
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    // Free-text "doneness" label shown as a watermark over the map (e.g. "DRAFT",
    // "NOT FINAL", "FINAL v2"). NULL/"" = no overlay. Independent of `locked`
    // (locked = read-only; this is just a human label / the export's version tag).
    mapStatus: text("map_status"),
    // Undo/redo cursor for the official map: the `seq` of the current state in
    // `map_snapshot` (kind=auto). NULL = no history yet. See map_snapshot.
    mapUndoCursor: integer("map_undo_cursor"),
    // Structure kinds disallowed for THIS edition (a JSON array of kind `value`s),
    // e.g. Burning Man bans pop-up canopies but a smaller event allows them. The
    // palette hides these and add-actions reject them; existing placed objects of a
    // now-banned kind are flagged, not deleted. NULL/"" = nothing banned. Seeded
    // from the event default on create (see `defaultBannedKinds`), officer-editable.
    bannedKinds: text("banned_kinds"),
    // Which edition this one was copied from (import = snapshot, not a live link).
    forkedFromId: text("forked_from_id").references(
      (): AnySQLiteColumn => campEdition.id,
      { onDelete: "set null" },
    ),
    // DGS ticket sale window for this year (the vendor's checkout open/close).
    // Null = unbounded on that end. The per-ticket purchase link is only shown
    // to the assignee while now is within [start, end].
    ticketSaleStartsAt: integer("ticket_sale_starts_at", {
      mode: "timestamp_ms",
    }),
    ticketSaleEndsAt: integer("ticket_sale_ends_at", { mode: "timestamp_ms" }),
    // Ticket assignments are a DRAFT (visible only to officers) until published.
    // Null = draft/hidden from members; set = published + the timestamp.
    ticketsPublishedAt: integer("tickets_published_at", {
      mode: "timestamp_ms",
    }),
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
