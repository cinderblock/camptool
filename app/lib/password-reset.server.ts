/**
 * Officer-issued password reset links.
 *
 * CampTool has no mail transport, so better-auth's forget-password flow is
 * unreachable and `/login` has no "forgot password?" link on purpose — it would
 * be a dead end. Recovery is human-delivered instead: an officer generates a
 * link on the members page and sends it over whatever channel the camp already
 * uses.
 *
 * Two properties do the security work, and both matter:
 *
 *   1. Issuing changes NOTHING. The existing password keeps working until
 *      somebody completes a reset, so a link that leaks-but-is-never-used is
 *      not a lockout.
 *   2. The link alone is not enough — redeeming also requires typing the email
 *      address it was issued for. Something you have plus something you know.
 *      That is what makes an officer opening their own link by accident a
 *      no-op rather than an incident.
 *
 * Server-only. See `plans/password-recovery.md`.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { camp, passwordReset, user } from "../../db/schema";
import { auth } from "./auth.server";
import { PUBLIC_BASE_URL } from "./env.server";
import {
  MAX_RESET_ATTEMPTS,
  RESET_TTL_MS,
  type ResetLinkState,
  maskEmail,
  resetLinkState,
} from "./password-reset";

export { maskEmail, resetLinkState, type ResetLinkState };

/** 192 bits, same generator as invite tokens (`app/lib/invite.server.ts`). */
function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** What's stored. A database read must not be enough to *use* a link. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ResetLinkStatus =
  | { state: "unknown" }
  | {
      state: Exclude<ResetLinkState, "unknown">;
      /** Masked, so the recipient can recognise it without the link leaking a
       * full address to whoever else ends up holding it. */
      maskedEmail: string;
      /** Whose account, for the confirmation copy. */
      name: string;
      /** Which camp's officer issued it. */
      campName: string;
      /** ISO date (YYYY-MM-DD). Never locale-formatted. */
      expires: string;
      /** ISO date the reset was completed, when `state` is "used". */
      usedOn: string | null;
      attemptsLeft: number;
    };

/**
 * Mint a link for `userId`, revoking any earlier live link for the same
 * (camp, user) so there's never a pile of live links for one person.
 *
 * Authorization (officer+, strictly outranking the target) is the CALLER's
 * job — this function trusts what it's given. See the `issuePasswordReset`
 * intent in `app/routes/dashboard/members.tsx`.
 */
export async function issuePasswordReset(input: {
  campId: string;
  userId: string;
  issuedByMembershipId: string | null;
}): Promise<{ url: string; expires: string }> {
  const nowMs = Date.now();

  await db
    .update(passwordReset)
    .set({ revokedAt: new Date(nowMs) })
    .where(
      and(
        eq(passwordReset.campId, input.campId),
        eq(passwordReset.userId, input.userId),
        isNull(passwordReset.usedAt),
        isNull(passwordReset.revokedAt),
      ),
    );

  const token = newToken();
  const expiresAt = new Date(nowMs + RESET_TTL_MS);
  await db.insert(passwordReset).values({
    id: crypto.randomUUID(),
    campId: input.campId,
    userId: input.userId,
    issuedByMembershipId: input.issuedByMembershipId,
    tokenHash: hashResetToken(token),
    expiresAt,
  });

  return {
    url: `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/reset/${token}`,
    expires: expiresAt.toISOString().slice(0, 10),
  };
}

/** The row plus the people/camp names it points at, or null. */
async function findByToken(token: string) {
  if (!token) return null;
  const [row] = await db
    .select({
      link: passwordReset,
      email: user.email,
      name: user.name,
      campName: camp.name,
    })
    .from(passwordReset)
    .innerJoin(user, eq(user.id, passwordReset.userId))
    .innerJoin(camp, eq(camp.id, passwordReset.campId))
    .where(eq(passwordReset.tokenHash, hashResetToken(token)))
    .limit(1);
  return row ?? null;
}

/**
 * Read a link's status. **Strictly read-only** — this is what an officer who
 * clicked their own link lands on, and the whole point is that landing on it
 * consumes nothing and invalidates nothing.
 */
export async function inspectPasswordReset(
  token: string,
): Promise<ResetLinkStatus> {
  const row = await findByToken(token);
  if (!row) return { state: "unknown" };
  return {
    state: resetLinkState(row.link),
    maskedEmail: maskEmail(row.email),
    name: row.name,
    campName: row.campName,
    expires: row.link.expiresAt.toISOString().slice(0, 10),
    usedOn: row.link.usedAt ? row.link.usedAt.toISOString().slice(0, 10) : null,
    attemptsLeft: Math.max(0, MAX_RESET_ATTEMPTS - row.link.attempts),
  };
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; error: string; state?: ResetLinkState };

/**
 * Complete a reset: check the email matches, set the password, spend the link.
 *
 * The set-password half mirrors better-auth's own `/reset-password` handler
 * (`node_modules/better-auth/dist/api/routes/password.mjs:150-165`) —
 * create the `credential` account if there isn't one, otherwise update it —
 * rather than minting a fake `reset-password:` verification row purely to be
 * allowed to call that endpoint. Length bounds come from the auth context, so
 * they can't drift away from `emailAndPassword.minPasswordLength`.
 */
export async function redeemPasswordReset(input: {
  token: string;
  email: string;
  newPassword: string;
}): Promise<RedeemResult> {
  const row = await findByToken(input.token);
  if (!row) {
    return { ok: false, error: "That link isn't valid.", state: "unknown" };
  }

  const state = resetLinkState(row.link);
  if (state !== "valid") {
    return { ok: false, error: "That link can no longer be used.", state };
  }

  const given = input.email.trim().toLowerCase();
  if (given !== row.email.trim().toLowerCase()) {
    // Burn an attempt, not the link — a typo shouldn't cost someone their one
    // recovery path, but grinding through candidate addresses should.
    const attempts = row.link.attempts + 1;
    await db
      .update(passwordReset)
      .set({ attempts })
      .where(eq(passwordReset.id, row.link.id));
    const left = MAX_RESET_ATTEMPTS - attempts;
    return {
      ok: false,
      error:
        left > 0
          ? `That's not the email this link was issued for. ${left} ${left === 1 ? "try" : "tries"} left.`
          : "That's not the email this link was issued for, and you're out of tries. Ask an officer for a new link.",
      state: left > 0 ? "valid" : "locked",
    };
  }

  const ctx = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (input.newPassword.length < minPasswordLength) {
    return {
      ok: false,
      error: `Passwords need at least ${minPasswordLength} characters.`,
      state: "valid",
    };
  }
  if (input.newPassword.length > maxPasswordLength) {
    return {
      ok: false,
      error: `Passwords can be at most ${maxPasswordLength} characters.`,
      state: "valid",
    };
  }

  const hashed = await ctx.password.hash(input.newPassword);
  const accounts = await ctx.internalAdapter.findAccounts(row.link.userId);
  if (!accounts.some((a) => a.providerId === "credential")) {
    // No password yet — a passkey-first account whose passkey is gone. This is
    // the one path in the app that can CREATE a password (see decision 1 in
    // plans/password-recovery.md); it exists so nobody is permanently locked
    // out while officer-issued passkey re-enrolment is still unbuilt.
    await ctx.internalAdapter.createAccount({
      userId: row.link.userId,
      providerId: "credential",
      accountId: row.link.userId,
      password: hashed,
    });
  } else {
    await ctx.internalAdapter.updatePassword(row.link.userId, hashed);
  }

  // The realistic reasons to need this link are "I forgot it" and "I think
  // someone else has it". The second makes revocation mandatory; the first
  // makes it harmless, because they have no sessions to lose.
  await ctx.internalAdapter.deleteUserSessions(row.link.userId);

  await db
    .update(passwordReset)
    .set({ usedAt: new Date() })
    .where(eq(passwordReset.id, row.link.id));

  return { ok: true };
}
