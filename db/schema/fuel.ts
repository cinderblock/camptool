/**
 * Fuel declarations — who is bringing what fuel, how much, and in what.
 *
 * This exists for a safety review, not for tidiness. Burning Man requires fuel
 * to have secondary containment and to be separated from living areas and
 * ignition sources, so the numbers that matter are the TOTAL per fuel type and
 * the CONTAINER COUNT — how much liquid could escape, and how many things could
 * leak. Both fall straight out of a per-camper row set.
 *
 * It FEEDS the map rather than duplicating it: `map_object` already has a
 * `fuel-storage` kind that auto-draws the separation rings (10′ ignition, 20′
 * liquid↔propane, 50′ fuel↔fuel). This says how much is going in that area.
 *
 *   fuel_declaration  one line: a person, a fuel type, an amount, and the
 *                     containers it arrives in. Several lines per person is
 *                     normal — a generator's gasoline and the kitchen's propane
 *                     are different answers to the separation question.
 *
 * Per-year, so every row carries `camp_id` (the hard multi-camp invariant) AND
 * `edition_id`; a locked edition is read-only. Amounts are stored as a real in
 * the unit given (`gal` or `lb`) rather than normalized: propane is bought and
 * talked about in pounds and gasoline in gallons, and converting between them
 * would invent a precision nobody supplied.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const fuelDeclaration = sqliteTable(
  "fuel_declaration",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id")
      .notNull()
      .references(() => campEdition.id, { onDelete: "cascade" }),
    // Whose fuel it is. Goes with them if they leave — an unowned drum of
    // gasoline in the safety total would be worse than no row at all.
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // Soft enum — labels + the liquid/gas split live in app/lib/fuel.ts:
    // gasoline | diesel | propane | other.
    fuelType: text("fuel_type").notNull(),
    // How much, in `unit`. Real because "2.5 gal" is a thing people bring.
    amount: real("amount").notNull().default(0),
    // gal | lb. Which one is meaningful depends on the fuel; see fuel.ts.
    unit: text("unit").notNull().default("gal"),
    // Free text — "5 gal jerry cans", "20 lb BBQ tanks", "built-in RV tank".
    containerType: text("container_type"),
    // How many separate vessels. The count matters independently of the total:
    // six cans is six things that can leak.
    containerCount: integer("container_count").notNull().default(1),
    // Has secondary containment (a tray/tub that catches a leak). Nullable
    // because "not answered yet" is different from "no", and the safety review
    // needs to tell those apart.
    secondaryContainment: integer("secondary_containment", { mode: "boolean" }),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("fuel_declaration_edition").on(t.editionId),
    index("fuel_declaration_member").on(t.membershipId),
  ],
);
