/**
 * Schedule — gatherings (work parties / camp meetings / prep sessions), their
 * dated occurrences, staffable shifts, and sign-ups. Design:
 * plans/events-scheduling.md. Named `gathering` (NOT "event") because `event`
 * already means the event layer (Burning Man vs UnSCruz) on `camp_edition`.
 *
 * Per-year, so every row carries `camp_id` (the hard multi-camp invariant) AND
 * `edition_id` (the operative per-year scope). A locked edition is read-only.
 * Gated by the `schedule` camp feature.
 *
 *   gathering            the recurring "thing" (title/kind/location); repeats
 *                        materialize as real occurrence rows (snapshot, not a
 *                        live RRULE) so each day is independently editable.
 *   gathering_occurrence one concrete dated instance.
 *   gathering_shift      a staffable slot within an occurrence (role +
 *                        staffing). Every occurrence has ≥1 shift (a default
 *                        "General" one is auto-created) so sign-ups always
 *                        attach to a shift — one code path for an all-hands
 *                        meeting and a multi-role work party.
 *   gathering_signup     a person on a shift. Three independent axes: `status`
 *                        (intent: signed_up/maybe/waitlisted/cancelled),
 *                        `attendance` (outcome: unknown/attended/no_show), and
 *                        `origin` (self/assigned/walk_in — walk_in records the
 *                        substitute who covered for a no-show).
 *
 * Times are WALL-CLOCK strings — `date` = ISO `YYYY-MM-DD`, times = `HH:MM`
 * (24h) — not epoch ms. "Work party at 10am" is a wall-clock concept wherever
 * the camp happens to be (home city before the event, playa during it), and
 * the repo already stores event dates this way (setup_pass_date, arrival
 * dates). No timezone conversion anywhere.
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

export const gathering = sqliteTable(
  "gathering",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    // Soft enum — labels/colors live in app/lib/schedule.ts:
    // work_party | meeting | prep | shift | social | other.
    kind: text("kind").notNull().default("work_party"),
    // Free text for now ("Bar", "HQ tent", "Zoom"); a map link is a later step.
    location: text("location"),
    // Human/regeneration hint for how the occurrences were made (e.g.
    // "daily:2026-08-25..2026-09-01"); occurrences are the real rows.
    recurrenceRule: text("recurrence_rule"),
    // active | archived (hidden from lists; occurrences kept).
    status: text("status").notNull().default("active"),
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
  (t) => [index("gathering_edition").on(t.editionId)],
);

export const gatheringOccurrence = sqliteTable(
  "gathering_occurrence",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    gatheringId: text("gathering_id")
      .notNull()
      .references(() => gathering.id, { onDelete: "cascade" }),
    // ISO YYYY-MM-DD (sorts lexically).
    date: text("date").notNull(),
    // Wall-clock HH:MM (24h); both NULL = all-day.
    startTime: text("start_time"),
    endTime: text("end_time"),
    // Per-day overrides; NULL = inherit the gathering's.
    titleOverride: text("title_override"),
    locationOverride: text("location_override"),
    // scheduled | cancelled (kept + shown struck-through, not deleted).
    status: text("status").notNull().default("scheduled"),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("gathering_occurrence_edition").on(t.editionId, t.date),
    index("gathering_occurrence_gathering").on(t.gatheringId, t.date),
  ],
);

export const gatheringShift = sqliteTable(
  "gathering_shift",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    occurrenceId: text("occurrence_id")
      .notNull()
      .references(() => gatheringOccurrence.id, { onDelete: "cascade" }),
    // "Bartender" / "Greeter" / NULL = the general/default shift.
    role: text("role"),
    // all_hands (everyone expected) | open (all available) | needed (target
    // headcount, capacity-capped → waitlist).
    staffing: text("staffing").notNull().default("open"),
    // Used when staffing = needed: the target and the hard cap (both nullable —
    // "needs about 2" without a cap is fine).
    minNeeded: integer("min_needed"),
    capacity: integer("capacity"),
    // Sub-window of the occurrence (e.g. bar 18:00–20:00); NULL = whole time.
    startTime: text("start_time"),
    endTime: text("end_time"),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("gathering_shift_occurrence").on(t.occurrenceId)],
);

export const gatheringSignup = sqliteTable(
  "gathering_signup",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    shiftId: text("shift_id")
      .notNull()
      .references(() => gatheringShift.id, { onDelete: "cascade" }),
    // Members only for now; extending to guests (attendee) is a later step —
    // see plans/events-scheduling.md gotchas.
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // Intent: signed_up | maybe | waitlisted | cancelled.
    status: text("status").notNull().default("signed_up"),
    // Outcome, marked after the shift: unknown | attended | no_show.
    attendance: text("attendance").notNull().default("unknown"),
    // How this row came to be: self (signed up) | assigned (officer put them
    // on) | walk_in (covered the shift without signing up — the substitute).
    origin: text("origin").notNull().default("self"),
    note: text("note"),
    // Who last marked attendance (officer, or self for self-report).
    recordedByMembershipId: text("recorded_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("gathering_signup_unique").on(t.shiftId, t.membershipId),
    index("gathering_signup_member").on(t.editionId, t.membershipId),
  ],
);
