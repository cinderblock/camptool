/**
 * Programming — what the camp offers to the wider event. Math Camp's lectures,
 * another camp's workshops, classes, performances, discussions. Design:
 * plans/programming-offerings.md. Named `offering` (NOT "event") for the same
 * reason `gathering` is: `event` means the event layer (Burning Man vs
 * UnSCruz) on `camp_edition`.
 *
 * Distinct from the `schedule` feature, which is INTERNAL — work parties and
 * shifts staffed by members (`gathering_signup.membership_id` is a hard FK to
 * membership). Programming is PUBLIC: strangers wander in, so there is an
 * unauthenticated page and no per-attendee signup.
 *
 * Per-year, so every row carries `camp_id` (the hard multi-camp invariant) AND
 * `edition_id` (the operative per-year scope). A locked edition is read-only.
 * Gated by the `programming` camp feature.
 *
 *   offering           the proposal, and later the accepted talk. Exists with
 *                      NO date — the whole point of an open call is to collect
 *                      offerings before the schedule is known.
 *   offering_session   one concrete dated instance. Separate table because a
 *                      popular talk gets repeated.
 *   offering_presenter presenter + co-presenters. Either an `attendee_id`
 *                      (someone in our camp party, member or guest) or a bare
 *                      `name` (an outside presenter who isn't camping with us
 *                      and must not land on the roster or the headcount).
 *
 * Times are WALL-CLOCK strings — `date` = ISO `YYYY-MM-DD`, times = `HH:MM`
 * (24h) — matching db/schema/schedule.ts. No timezone conversion anywhere.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { attendee } from "./attendee";
import { camp, campEdition, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const offering = sqliteTable(
  "offering",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    // The public blurb — this is what a stranger reads to decide to come.
    description: text("description"),
    // Soft enum — labels/colors live in app/lib/programming.ts:
    // lecture | workshop | class | performance | discussion | other.
    // This is where a camp's own vocabulary lives; the FEATURE stays generic.
    kind: text("kind").notNull().default("lecture"),
    // The proposer's estimate. Needed before an officer can place it in a slot.
    durationMin: integer("duration_min"),
    // proposed (default) -> accepted | declined, or withdrawn by the proposer.
    status: text("status").notNull().default("proposed"),
    // public (default) = listed on /c/:slug/schedule | camp_only = internal.
    audience: text("audience").notNull().default("public"),
    // Informational only ("room for ~20"). NOT a booking limit — the public has
    // no accounts, so there is nothing to reserve.
    capacity: integer("capacity"),
    // Officer sets this when scheduling; a session may override it.
    location: text("location"),
    // Who submitted it. A member (proposing requires an account), so this is a
    // membership rather than an attendee.
    proposedByMembershipId: text("proposed_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    // Officer curation provenance, matching the ticket_request house style.
    reviewedByMembershipId: text("reviewed_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    // Why it was declined, or a note back to the proposer on acceptance.
    reviewNote: text("review_note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("offering_edition").on(t.editionId, t.status)],
);

export const offeringSession = sqliteTable(
  "offering_session",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    offeringId: text("offering_id")
      .notNull()
      .references(() => offering.id, { onDelete: "cascade" }),
    // ISO YYYY-MM-DD, so it sorts lexically.
    date: text("date").notNull(),
    // HH:MM 24h. Both NULL = "sometime that day".
    startTime: text("start_time"),
    endTime: text("end_time"),
    // NULL inherits offering.location.
    location: text("location"),
    // scheduled (default) -> cancelled. Cancelled rows stay so the public page
    // can show "cancelled" rather than silently dropping a listed talk.
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
    index("offering_session_edition").on(t.editionId, t.date),
    index("offering_session_offering").on(t.offeringId),
  ],
);

export const offeringPresenter = sqliteTable(
  "offering_presenter",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    offeringId: text("offering_id")
      .notNull()
      .references(() => offering.id, { onDelete: "cascade" }),
    // Someone in our camp party (member or guest) — resolve their display name
    // through attendee. NULL when the presenter is an outsider.
    attendeeId: text("attendee_id").references(() => attendee.id, {
      onDelete: "cascade",
    }),
    // Authoritative for an outside presenter who isn't camping with us. Keeping
    // them OFF the attendee table matters: attendee drives the roster, the
    // headcount, tickets and passes, none of which a visiting speaker wants.
    name: text("name"),
    // Free label — "Presenter", "Co-presenter", "MC". NULL = presenter.
    role: text("role"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("offering_presenter_offering").on(t.offeringId)],
);
