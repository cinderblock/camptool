/**
 * Camp questionnaire — a generic question bank. The *capability* to ask arbitrary
 * questions lives in the shared app; a camp's actual questions are DATA an officer
 * defines (not baked into the open-source code). This is what the season-aware
 * wizard's `questionnaire` ask renders.
 *
 *   camp_question    a question an officer defines. CAMP-scoped config (not
 *                    edition-scoped): the question set persists across years, like
 *                    onboarding_task. Audience-tagged so recruits can get more.
 *   question_answer  one camper's answer. EDITION-scoped: contributions / rideshare
 *                    / "I agree" are per-year, so answers carry edition_id (like the
 *                    map/ticket/season tables) and a locked year is read-only.
 *
 * Answer values are stored as text regardless of type: number → its digits,
 * boolean/consent → "true"/"false", date → "YYYY-MM-DD", single_select → the
 * chosen option, multi_select → a JSON array of options. The question's `type`
 * tells the UI how to interpret it.
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

/** Question input types. `consent` is a required-to-proceed acknowledgment
 * checkbox (the Airtable "Expectations" agreement); `boolean` is a plain yes/no. */
export type QuestionType =
  | "short_text"
  | "long_text"
  | "single_select"
  | "multi_select"
  | "number"
  | "boolean"
  | "date"
  | "consent";

export const campQuestion = sqliteTable(
  "camp_question",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    // Optional helper text shown under the prompt (the Airtable "Please use…" notes).
    helpText: text("help_text"),
    type: text("type").notNull().default("short_text"),
    // JSON array of option strings for single_select / multi_select; null otherwise.
    options: text("options"),
    // all | returning (member+) | recruit. Matches AskAudience in app/lib/wizard.ts.
    audience: text("audience").notNull().default("all"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    // Soft-retire: a question with archivedAt set is hidden from new answers but
    // its existing answers are preserved (vs a hard delete that cascades them away).
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("camp_question_camp").on(t.campId)],
);

export const questionAnswer = sqliteTable(
  "question_answer",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    questionId: text("question_id")
      .notNull()
      .references(() => campQuestion.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    // See file header for the per-type text encoding.
    value: text("value"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("question_answer_member").on(t.editionId, t.membershipId),
    uniqueIndex("question_answer_unique").on(
      t.editionId,
      t.membershipId,
      t.questionId,
    ),
  ],
);
