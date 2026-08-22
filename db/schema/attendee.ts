/**
 * `attendee` — one **body at the event, for one edition**: the unified "who's
 * coming this year" record. Replaces the old `participation` table (a member's
 * own RSVP) and extends it to cover **guests** — people a member brings who have
 * no account of their own (e.g. Albert registers and adds his wife).
 *
 * Per-year, so every row carries `camp_id` (the hard multi-camp invariant) AND
 * `edition_id` (the operative per-year scope). A locked edition is read-only.
 *
 * The two nullable membership columns are **orthogonal**, not a two-way split:
 *
 *   - `membership_id` — set means this attendee has an account of their own.
 *     Unique per edition (partial index). Its `status`/`arrival_date`/
 *     `departure_date`/`note` ARE that member's RSVP — this is where the former
 *     `participation` fields now live. NULL means a **guest**, and then `name`
 *     is authoritative (a member row leaves `name` NULL and resolves its display
 *     name from the joined `user`).
 *   - `host_membership_id` — "here as part of this member's **party**". Set on a
 *     guest row, it's the member who manages them. Set on a *member* row, it
 *     records that two account-holders are attending as one household (Grace
 *     coming as part of Albert's party) — a fact in its own right, independent
 *     of whether they end up sharing a domicile.
 *
 * So "has a host" ≠ "is a guest": only `membership_id IS NULL` makes a guest.
 * Server code must go through `isGuestRow` in `app/lib/attendee.server.ts`
 * rather than testing `host_membership_id IS NOT NULL` — see the comment there
 * for what breaks otherwise. Party links are one level deep: a hosted member
 * hosts nobody, and nobody hosts themselves.
 *
 * Headcount = attendees with `status` = 'coming' for the edition (members + their
 * guests). Because map occupancy, tickets, and Setup Access Passes reference the
 * attendee (in later phases), a guest can be **promoted** to a real membership by
 * simply setting `membership_id` on their existing row — every reference follows
 * for free, nothing is re-pointed. `email` (optional) enables sending that
 * promotion invitation.
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

export const attendee = sqliteTable(
  "attendee",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    // Set = this attendee IS a camp member (their own account); NULL = a guest.
    // Cascade: removing the membership removes their own attendee row.
    membershipId: text("membership_id").references(() => membership.id, {
      onDelete: "cascade",
    }),
    // The member who manages this guest; NULL for a member's own row. Cascade:
    // removing the host removes the guests they were managing.
    hostMembershipId: text("host_membership_id").references(
      () => membership.id,
      {
        onDelete: "cascade",
      },
    ),
    // Authoritative for a guest; NULL for a member row (resolve from `user.name`).
    name: text("name"),
    // Optional — lets an officer/host send a better-auth invitation to promote
    // this guest into a recruit/member account (which links back onto this row).
    email: text("email"),
    // unknown (default) -> coming | maybe | not_coming.
    status: text("status").notNull().default("unknown"),
    // Planned stay, ISO YYYY-MM-DD. Arriving before gate-open needs a Setup
    // Access Pass (see setup_pass).
    arrivalDate: text("arrival_date"),
    departureDate: text("departure_date"),
    /**
     * Do they want to be placed under the camp's communal shade?
     *
     * A column rather than a questionnaire answer because the **map and roster
     * consume it** — you want to filter and group placements by it — and that
     * is the line this project draws between structured data and questions
     * (see `plans/questions-and-profile.md`). Named for the general thing, not
     * "the main shade": plenty of camps have communal shade, and the core
     * schema shouldn't learn one camp's vocabulary.
     *
     * NULL = never asked, which is different from "no". Placement needs to see
     * that difference.
     */
    wantsCommunalShade: integer("wants_communal_shade", { mode: "boolean" }),
    /**
     * `adult` (default) | `under_18` | `under_13`.
     *
     * A child who never leaves their parents' side is still a **person**, not a
     * "+2" on the adult's row: headcount counts them, map occupancy points at
     * an attendee id, and a number has nowhere to record that one of them turns
     * 13, or has a medical note. So they get a row like everybody else, and
     * this band suppresses the asks that don't apply to them — the same shape
     * as the RSVP gate and conditional questions.
     *
     * `under_13` is the band with teeth at Burning Man: no ticket and no Setup
     * Access Pass. `under_18` still needs both, and exists so "who is a minor"
     * is answerable without storing anyone's date of birth.
     *
     * NULL = adult. Deliberately not NOT NULL: every existing row is an adult
     * and backfilling a default would claim the camp had answered a question
     * nobody asked.
     */
    ageBand: text("age_band"),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("attendee_edition").on(t.editionId),
    index("attendee_host").on(t.hostMembershipId),
    // One attendee row per member per edition (guests excluded — NULL membership).
    uniqueIndex("attendee_member")
      .on(t.editionId, t.membershipId)
      .where(sql`${t.membershipId} is not null`),
  ],
);
