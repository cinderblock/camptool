/**
 * The spares board — campers offering or looking for a spare ticket or vehicle
 * pass. Requested in consecutive camp meetings because it currently happens
 * across Discord, email and DMs, where an offer scrolls away and the person who
 * needed it never sees it.
 *
 * Deliberately NOT part of `ticket`. That table is the camp's own allocation:
 * slots the camp was granted and hands out, with a price the vendor set and a
 * purchase the camp doesn't run. This is a classifieds board between campers
 * for things the camp never owned. Folding the two together would make "how
 * many tickets does the camp have" unanswerable.
 *
 *   swap_listing  one post. `kind` keeps ticket and vehicle pass separate —
 *                 people routinely have one and need the other, so a single
 *                 "spare" type would lose the whole point. `direction` is
 *                 have/need; a "need" post is how someone gets found.
 *
 * Per-year, so every row carries `camp_id` (the hard multi-camp invariant) AND
 * `edition_id`; a locked edition is read-only. `price_cents` is what the poster
 * is asking (null = unstated / make an offer, 0 = free), in integer cents like
 * every other money column here. The camp does not handle the money — this is a
 * noticeboard, and says so on the page.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const swapListing = sqliteTable(
  "swap_listing",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id")
      .notNull()
      .references(() => campEdition.id, { onDelete: "cascade" }),
    // Who posted it. Their listings go with them if they leave the camp.
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // Soft enum — labels live in app/lib/swaps.ts: ticket | vehicle_pass.
    kind: text("kind").notNull(),
    // have | need.
    direction: text("direction").notNull(),
    quantity: integer("quantity").notNull().default(1),
    // Asking price in cents; null = unstated, 0 = free/gifted.
    priceCents: integer("price_cents"),
    note: text("note"),
    // open | claimed | withdrawn. Withdrawn rows are kept, not deleted, so a
    // conversation that started around a listing still has something to point
    // at.
    status: text("status").notNull().default("open"),
    // Who took it, when known — null on a listing the poster marked settled
    // themselves (sold to a friend, found one elsewhere).
    claimedByMembershipId: text("claimed_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("swap_listing_edition").on(t.editionId, t.status),
    index("swap_listing_member").on(t.membershipId),
  ],
);
