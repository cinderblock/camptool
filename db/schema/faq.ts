/**
 * Camp FAQ — a curated, searchable Q&A list (see plans/camp-faq.md).
 *
 * CAMP-scoped, not edition-scoped: "how do I get to the playa" is not a 2026
 * fact. Gated by the `faq` camp feature (off by default).
 *
 * Not to be confused with `question.ts` — that is the per-year QUESTIONNAIRE
 * (officers ask, campers answer). This is the inverse: campers ask, officers
 * answer, and the answer is published for everyone.
 *
 * Two tables:
 *  - `faq_category` officer-defined buckets, ordered. Optional: an entry with
 *                   no category lands in a trailing "General" group, so nobody
 *                   has to invent taxonomy before writing an answer.
 *  - `faq_entry`    the question AND its lifecycle. A member-submitted question
 *                   awaiting an answer is simply an entry with status
 *                   'pending' and an empty answer — see the plan for why that
 *                   beats a separate submissions table.
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
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const faqCategory = sqliteTable(
  "faq_category",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** URL key — powers `/faq?category=money` and keeps names renameable. */
    slug: text("slug").notNull(),
    /** Manual order on the index page; ties break by name. */
    position: integer("position").notNull().default(0),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("faq_category_camp").on(t.campId, t.position),
    uniqueIndex("faq_category_slug_unique").on(t.campId, t.slug),
  ],
);

export const faqEntry = sqliteTable(
  "faq_entry",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /**
     * Stable deep-link address, unique within the camp. Derived from the
     * question at creation and then frozen: re-wording a question must not
     * break the `[[/faq/…]]` links other answers and wiki pages already made.
     */
    slug: text("slug").notNull(),
    question: text("question").notNull(),
    /** The wiki body format (app/lib/wiki.ts). Empty while pending. */
    answer: text("answer").notNull().default(""),
    /** 'pending' | 'published' | 'archived' — see app/lib/faq.ts. */
    status: text("status").notNull().default("published"),
    // Nullable = the "General" bucket. SET NULL rather than cascade: deleting a
    // category must never take the camp's answers with it.
    categoryId: text("category_id").references(() => faqCategory.id, {
      onDelete: "set null",
    }),
    /** Manual order within the category. */
    position: integer("position").notNull().default(0),
    /** Set when the question came from a member rather than an officer. */
    askedById: text("asked_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    askedAt: integer("asked_at", { mode: "timestamp_ms" }),
    /** The officer who published it. */
    answeredById: text("answered_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedById: text("updated_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    // The index page's read: everything published, in display order.
    index("faq_entry_camp_status").on(t.campId, t.status, t.position),
    // The officer queue and "your pending questions".
    index("faq_entry_asked_by").on(t.campId, t.askedById),
    uniqueIndex("faq_entry_slug_unique").on(t.campId, t.slug),
  ],
);
