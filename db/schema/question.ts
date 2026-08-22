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
  | "consent"
  // "Smart" types wired to real data (see app/lib/questions.ts):
  | "event_date" // a date bounded to the weeks around the event
  | "event_range" // arrival + departure picked on one event calendar
  | "invited_by"; // pre-fills who invited you from the invite tree

/** Where a question sits in the onboarding wizard relative to the "Bringing"
 * (tents/vehicles) step: `before` = the intro questionnaire; `after` = the
 * "a few more questions" step that follows the gear selection. */
export type QuestionPlacement = "before" | "after";

/** How long an answer lives. `per_edition` = answered fresh each year (the
 * default: rideshare, arrival, consent). `once` = a lifetime fact (previous
 * camps, "how did you find us"): its answer is stored edition-less
 * (question_answer.edition_id NULL) and pre-fills every later year. */
export type QuestionScope = "per_edition" | "once";

/** Where the question is asked: the onboarding wizard, the public application
 * form (pre-membership), or both. Application answers are held as JSON on
 * recruit_application until the applicant has a membership, then imported
 * into question_answer (see importApplicationAnswers). */
export type QuestionSurface = "wizard" | "application" | "both";

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
    // For multi_select: the one option that is mutually exclusive — picking it
    // clears the others (and picking any other clears it). e.g. ride-share's
    // "I don't have space". Null = no exclusive option. Must be one of `options`.
    exclusiveOption: text("exclusive_option"),
    // all | returning (member+) | recruit. Matches AskAudience in app/lib/wizard.ts.
    audience: text("audience").notNull().default("all"),
    // before | after — which side of the wizard's "Bringing" step this question
    // shows on (see QuestionPlacement). "what are you bringing"-type questions go
    // after; everything else stays in the early questionnaire.
    wizardPlacement: text("wizard_placement").notNull().default("before"),
    // per_edition | once — see QuestionScope.
    scope: text("scope").notNull().default("per_edition"),
    // wizard | application | both — see QuestionSurface.
    surface: text("surface").notNull().default("wizard"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    /**
     * Conditional display: ask this only when question `show_if_question_id`
     * currently answers `show_if_value`. Both null = always ask.
     *
     * Three rules travel with it, and skipping any of them breaks something
     * quietly (see `app/lib/conditions.ts`):
     *   - a hidden question is never *required*, or the wizard gains an
     *     unpassable gate with no visible cause;
     *   - a hidden question's stored answer is KEPT, so flipping the
     *     controlling answer back and forth doesn't destroy what was typed;
     *   - conditions are one level deep and may not cycle, enforced on save.
     *
     * Deliberately not a foreign key with cascade: deleting the controlling
     * question should orphan the condition (it then always shows), not delete
     * the dependent question along with it.
     */
    showIfQuestionId: text("show_if_question_id"),
    showIfValue: text("show_if_value"),
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
    // NULL = the lifetime answer to a `once`-scoped question (not tied to any
    // year); otherwise the year the answer belongs to.
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
    // NULLs are distinct in unique indexes, so once-scoped (edition-less)
    // answers need their own partial uniqueness (upserts target it via
    // targetWhere, like attendee_member).
    uniqueIndex("question_answer_once_unique")
      .on(t.membershipId, t.questionId)
      .where(sql`edition_id IS NULL`),
  ],
);
