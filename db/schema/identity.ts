/**
 * Identity bookkeeping that is ours, not better-auth's.
 *
 * `auth.ts` is deliberately limited to tables better-auth owns and writes; this
 * file holds what the app records *about* those identities.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

const now = sql`(unixepoch() * 1000)`;

/**
 * An email address a person used to have, kept after two accounts were merged.
 *
 * A merge folds two `user` rows into one, and `user.email` is unique — so one
 * of the two addresses has to stop being the primary. Dropping it silently
 * means an officer searching the address they were given finds nobody, which is
 * exactly the confusion the merge was supposed to end.
 *
 * This is **bookkeeping, not a credential**: nothing in the sign-in path
 * consults it (see `plans/merge-symmetric.md` decision 2). Signing in still
 * requires the primary address, or a passkey / Discord, both of which follow
 * the user id and are unaffected.
 */
export const userEmailAlias = sqliteTable("user_email_alias", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Stored lowercased; unique so the same address can't be claimed twice.
  email: text("email").notNull().unique(),
  // How it got here. Only "merge" today, but a rename would belong here too.
  reason: text("reason").notNull().default("merge"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});
