/**
 * Private member flags — a member quietly raises a concern about another
 * camper for officers to handle. CAMP-scoped (not per-year): interpersonal
 * issues aren't tied to an edition. Flags are visible ONLY to officers+
 * (never to the flagged member — the officer queue also hides flags whose
 * subject is the viewer) and to the reporter (their own, so they can withdraw).
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const memberFlag = sqliteTable(
  "member_flag",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    // Who the concern is about. Goes away if they leave the camp.
    subjectMembershipId: text("subject_membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // Who raised it; kept (anonymized) if the reporter leaves the camp.
    reporterMembershipId: text("reporter_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    body: text("body").notNull(),
    // open -> resolved (an officer dealt with it).
    status: text("status").notNull().default("open"),
    resolvedByMembershipId: text("resolved_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("member_flag_camp").on(t.campId)],
);
