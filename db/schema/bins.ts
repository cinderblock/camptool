/**
 * bins integration — a pointer to the camp's own `bins` instance (the
 * offline-first QR inventory tracker; Math Camp runs one at i.mathcamp.us).
 *
 * Deliberately just a LINK, not a data mirror: the top bar gets a menu item
 * that opens bins already signed in. bins logs a device in by visiting
 * `/join#<accessCode>` — the code rides in the URL fragment so it never reaches
 * bins' server logs. We keep the code here and hand it out only at click time
 * (see routes/bins.tsx), so it never sits in the HTML of every page.
 *
 * CAMP-scoped and one row per camp: each camp points at its OWN bins instance
 * (never assume a single camp). Pulling real stock counts into the Supplies
 * view is a separate, larger piece — bins exposes `/api/v1` for exactly that,
 * and this table is where its token would land when we build it.
 */
import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campBins = sqliteTable(
  "camp_bins",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /** Origin of the camp's bins deployment, e.g. https://i.mathcamp.us */
    baseUrl: text("base_url").notNull(),
    /**
     * bins' shared group access code. A secret: it grants anyone holding it a
     * device session on that bins instance. Never include it in a loader
     * payload — only in the redirect issued at click time.
     */
    accessCode: text("access_code"),
    /**
     * A READ-scoped integration token from the bins admin page
     * (`bins_<prefix>_<secret>`), used server-side to read stock over
     * `/api/v1`. Separate from `accessCode` on purpose: that one is a human
     * hand-off credential handed to members, this one is a machine credential
     * that never leaves the server and can be revoked in bins without
     * disturbing anybody's sign-in.
     */
    apiToken: text("api_token"),
    /** What to call it in the menu; defaults to "Bins" when unset. */
    label: text("label"),
    updatedByMembershipId: text("updated_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("camp_bins_camp").on(t.campId)],
);
