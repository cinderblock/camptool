/**
 * Phase 2 — recruit funnel + onboarding. All tenant-scoped, so every row carries
 * a `camp_id` (the hard multi-camp invariant).
 *
 *   recruit_application   public application submitted from /c/:slug
 *   onboarding_task       a checklist item a camp defines for new members
 *   onboarding_completion one row per membership×task once ticked off
 */
import { sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const recruitApplication = sqliteTable("recruit_application", {
  id: text("id").primaryKey(),
  campId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  playaName: text("playa_name"),
  message: text("message"),
  status: text("status").notNull().default("pending"),
  // Set if the applicant's email matches an existing account.
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  reviewedById: text("reviewed_by_id").references(() => user.id, {
    onDelete: "set null",
  }),
  reviewNotes: text("review_notes"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
});

export const onboardingTask = sqliteTable("onboarding_task", {
  id: text("id").primaryKey(),
  campId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

export const onboardingCompletion = sqliteTable(
  "onboarding_completion",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => onboardingTask.id, { onDelete: "cascade" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("onboarding_completion_member_task").on(
      t.membershipId,
      t.taskId,
    ),
  ],
);
