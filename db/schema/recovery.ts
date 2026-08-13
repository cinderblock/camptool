/**
 * Account recovery that doesn't need email.
 *
 * This deployment has no mail transport (`magicLink.sendMagicLink` only
 * console.logs — `app/lib/auth.server.ts`), so better-auth's built-in
 * forget-password flow is unreachable. Recovery is instead **officer-issued**:
 * an officer generates a link and hands it to the person over whatever channel
 * the camp already uses. See `plans/password-recovery.md`.
 *
 *   password_reset   a one-time, officer-issued password reset link
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

/**
 * A one-time password reset link issued by an officer.
 *
 * Camp-scoped even though a password is account-scoped: the *authority to
 * issue* comes from a camp membership (officer of this camp, strictly
 * outranking the target), while the credential it resets is account-wide. That
 * asymmetry is inherent to the multi-camp decision — see
 * `plans/passkey-first-auth.md` §"The constraint that shapes everything".
 *
 * Issuing one does NOT touch the existing password. Nothing changes until
 * somebody completes the reset, and completing it also requires typing the
 * email the link was issued for — the link is *something you have*, the email
 * is *something you know*. So an officer opening their own link by accident is
 * a no-op.
 *
 * Rows are kept after use: they are the audit trail of who reset whom.
 */
export const passwordReset = sqliteTable("password_reset", {
  id: text("id").primaryKey(),
  campId: text("camp_id")
    .notNull()
    .references(() => camp.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // set null, not cascade: the audit trail has to outlive the officer leaving
  // the camp. Who issued it matters most precisely when they're gone.
  issuedByMembershipId: text("issued_by_membership_id").references(
    () => membership.id,
    { onDelete: "set null" },
  ),
  // SHA-256 hex of the token that appears in the URL. Deliberately NOT the raw
  // token (which is how camp_invite stores its secret): a bearer credential
  // that can set a password is worth more, so a database read must not be
  // enough to use one.
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  // Set once a password is actually changed. The link is then spent.
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  // Set when an officer issues a NEWER link for the same person, so there's
  // never a pile of live links for one account.
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  // Wrong-email guesses. The link dies once this hits the cap, so a leaked URL
  // can't be brute-forced against guessed addresses.
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});
