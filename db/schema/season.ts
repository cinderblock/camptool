/**
 * Season-aware onboarding wizard state. Per-year, so it carries `camp_id` (the
 * hard multi-camp invariant) AND `edition_id` (the operative per-year scope, like
 * the map/ticket tables). A locked edition is read-only.
 *
 *   wizard_ask     per-ask completion for the season-aware wizard — replaces the
 *                  single `membership.wizard_step` integer, which can't model a
 *                  set of asks that grows as the season progresses. One row per
 *                  (edition, membership, ask_key); presence = the ask is resolved.
 *
 * The member's per-year RSVP ("coming back?", arrival/departure) used to live in
 * a `participation` table here; it now lives on the member's own `attendee` row
 * (see `db/schema/attendee.ts`), which unifies members and guests.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const wizardAsk = sqliteTable(
  "wizard_ask",
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
    // Catalog key from app/lib/wizard.ts (rsvp, profile, bringing, …).
    askKey: text("ask_key").notNull(),
    // done (acted on) | skipped (explicitly passed). Both mean "resolved".
    status: text("status").notNull().default("done"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("wizard_ask_member").on(t.editionId, t.membershipId),
    uniqueIndex("wizard_ask_unique").on(t.editionId, t.membershipId, t.askKey),
  ],
);
