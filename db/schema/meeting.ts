/**
 * Camp meetings — the agenda, the standing meeting room, and the write-up
 * afterwards. Design: plans/camp-meetings.md.
 *
 * A meeting is NOT its own scheduling entity: it is a `gathering` with
 * `kind = "meeting"` and its dated `gathering_occurrence` rows (db/schema/
 * schedule.ts), so dates, recurrence, RSVP, attendance and the calendar are
 * already solved and a meeting lives in exactly one place. These tables add
 * only what a meeting has that a work party doesn't.
 *
 *   camp_meeting_room     where the camp meets when it isn't in person. ONE per
 *                         camp, CAMP-scoped — a voice channel outlives a year.
 *   meeting_agenda_item   a line anyone who can see the meeting may add.
 *   meeting_summary       the write-up; null publishedAt = officers-only draft.
 *   meeting_summary_read  who has read a published summary — what makes
 *                         "distributing" mean something without a mailer.
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
import { gatheringOccurrence } from "./schedule";

const now = sql`(unixepoch() * 1000)`;

export const campMeetingRoom = sqliteTable(
  "camp_meeting_room",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /**
     * The join link, pasted whole. Discord's right-click → Copy Link on a voice
     * channel yields `https://discord.com/channels/<guild>/<channel>`, which is
     * all anyone needs; a Zoom / Meet / Jitsi / Teams link works the same way.
     *
     * The PROVIDER is deliberately not a column — `meetingProvider()` in
     * app/lib/meetings.ts derives it from the hostname, so the label can never
     * drift out of sync with the URL it describes, and a camp on some meeting
     * system we've never heard of still gets a working button.
     */
    url: text("url").notNull(),
    /** What to call it; falls back to the detected provider's name. */
    label: text("label"),
    /** Shown under the button — "we start with a mic check", a dial-in, etc. */
    note: text("note"),
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
  (t) => [uniqueIndex("camp_meeting_room_camp").on(t.campId)],
);

export const meetingAgendaItem = sqliteTable(
  "meeting_agenda_item",
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
    title: text("title").notNull(),
    /** Optional detail, in the wiki/FAQ markup — so an item can link deep into
     * CampTool and carry a screenshot. */
    body: text("body"),
    /** Anyone who can see the meeting may add one — recruits included. Kept as
     * `set null` so removing someone doesn't erase the agenda they built. */
    addedByMembershipId: text("added_by_membership_id").references(
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
  (t) => [index("meeting_agenda_occurrence").on(t.occurrenceId, t.createdAt)],
);

export const meetingSummary = sqliteTable(
  "meeting_summary",
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
    /** Wiki/FAQ markup. */
    body: text("body").notNull(),
    authorMembershipId: text("author_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    /** NULL = draft, visible to officers only. Publishing is the act of
     * distributing it — nothing else sends. */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("meeting_summary_occurrence").on(t.occurrenceId)],
);

export const meetingSummaryRead = sqliteTable(
  "meeting_summary_read",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    summaryId: text("summary_id")
      .notNull()
      .references(() => meetingSummary.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    uniqueIndex("meeting_summary_read_unique").on(t.summaryId, t.membershipId),
  ],
);
