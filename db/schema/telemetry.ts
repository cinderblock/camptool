/**
 * Telemetry the app collects to trace problems users hit:
 *   client_error  — JS errors forwarded from the browser (uncaught, unhandled
 *                   rejections, console.error), with metadata + breadcrumbs.
 *   feedback      — user-submitted bug/issue/suggestion/etc. (see feedback form).
 * Both are reviewable by super admins. Not tenant-critical, so `camp_id`/user are
 * nullable (an error can happen before/without a camp context). Cascades are
 * "set null" so deleting a user/camp keeps the historical record.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const clientError = sqliteTable(
  "client_error",
  {
    id: text("id").primaryKey(),
    // "error" (window.onerror) | "unhandledrejection" | "console".
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    source: text("source"),
    line: integer("line"),
    col: integer("col"),
    // The app URL (pathname + search) where it happened.
    url: text("url"),
    userAgent: text("user_agent"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    campId: text("camp_id").references(() => camp.id, { onDelete: "set null" }),
    // JSON: recent navigation/error breadcrumbs leading up to it.
    breadcrumbs: text("breadcrumbs"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("client_error_created").on(t.createdAt)],
);

export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    // "bug" | "issue" | "improvement" | "suggestion" | "compliment" | "other".
    kind: text("kind").notNull(),
    title: text("title"),
    body: text("body").notNull().default(""),
    // JSON: structured bug template (doing/trying/expected/actual) when kind=bug.
    details: text("details"),
    url: text("url"),
    userAgent: text("user_agent"),
    // JSON: breadcrumbs + viewport + timestamps captured at submit time.
    metadata: text("metadata"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    campId: text("camp_id").references(() => camp.id, { onDelete: "set null" }),
    editionId: text("edition_id"),
    // Triage status: "new" | "seen" | "closed".
    status: text("status").notNull().default("new"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("feedback_created").on(t.createdAt)],
);
