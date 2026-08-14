/**
 * Enrolling a passkey for an EXISTING account that can't sign in.
 *
 * The officer-issued recovery link (`plans/password-recovery.md`) originally
 * only led to a password. That's backwards for a project whose whole direction
 * is passkeys — the one moment a locked-out person is guaranteed to be paying
 * attention is the moment you should be handing them the better credential, not
 * the legacy one.
 *
 * The mechanism is the same trick that makes password-free signup work: the
 * passkey plugin's `registration.resolveUser` fires only when there is NO
 * session, and may point the ceremony at any user id. So we mint a short-lived
 * handle bound to (user, reset link), hand it to `addPasskey({ context })`, and
 * the credential lands on the existing account. No session has to be forged
 * first, and no password is involved at any point — after the ceremony the
 * client calls `signIn.passkey()` like any other passkey sign-in.
 *
 * Compare `passkey-signup.server.ts`, which does the same for accounts that
 * don't exist yet. Deliberately kept separate: that one is gated by the
 * invite-only lockdown (it creates accounts), and this one must NOT be — the
 * account already exists, and an invite-only deployment still has to let its
 * own members back in.
 *
 * Server-only.
 */
import { and, eq, like, lt } from "drizzle-orm";
import { db } from "../../db/client.server";
import { passwordReset, session, verification } from "../../db/schema";

/** Namespace in `verification.identifier`, distinct from `passkey-signup:`. */
const PREFIX = "passkey-recovery:";

/** One WebAuthn ceremony's worth of time — they're staring at the browser
 * prompt for all of it. Same reasoning as the signup handle. */
const TTL_MS = 10 * 60 * 1000;

export type PendingRecovery = {
  /** The EXISTING account the credential will be attached to. */
  userId: string;
  /** For the WebAuthn account identifier shown in the passkey manager. */
  email: string;
  name: string;
  /** The reset link being spent, so completing enrolment consumes it. */
  resetId: string;
};

/**
 * Mint a recovery handle. The CALLER must already have verified that the link
 * is valid and that the visitor typed the matching email — see
 * `verifyResetEmail` in `password-reset.server.ts`.
 */
export async function startPasskeyRecovery(
  pending: PendingRecovery,
): Promise<string> {
  await sweepExpired();
  const handle = crypto.randomUUID();
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: PREFIX + handle,
    value: JSON.stringify(pending),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return handle;
}

/**
 * Read without consuming — this runs from `resolveUser`, at
 * generate-register-options time, and the visitor can still abandon the browser
 * prompt and deserve a retry.
 */
export async function readPendingRecovery(
  handle: string | null | undefined,
): Promise<PendingRecovery | null> {
  if (!handle) return null;
  const [row] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, PREFIX + handle))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  try {
    return JSON.parse(row.value) as PendingRecovery;
  } catch {
    return null;
  }
}

/**
 * Consume the handle and finish the recovery: spend the reset link and drop
 * every existing session for the account.
 *
 * Sessions go because the realistic reasons for needing this link are "I lost
 * the device" and "I think someone else is in my account"; the second makes it
 * mandatory and the first makes it free. **Existing passkey rows are left
 * alone** — deviating from `plans/passkey-first-auth.md` Layer 5, which assumed
 * a reset implies the old authenticator is compromised. Neither we nor the
 * officer can know that, and someone recovering onto a second device would be
 * unpleasantly surprised to find their first one wiped. They can remove old
 * credentials themselves on /account, where they can see what they're removing.
 */
export async function completePasskeyRecovery(
  handle: string,
): Promise<PendingRecovery | null> {
  const pending = await readPendingRecovery(handle);
  if (!pending) return null;

  await db
    .delete(verification)
    .where(eq(verification.identifier, PREFIX + handle));

  await db
    .update(passwordReset)
    .set({ usedAt: new Date() })
    .where(eq(passwordReset.id, pending.resetId));

  await db.delete(session).where(eq(session.userId, pending.userId));

  return pending;
}

/** Drop abandoned handles. Scoped to our own prefix. */
async function sweepExpired(): Promise<void> {
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, `${PREFIX}%`),
        lt(verification.expiresAt, new Date()),
      ),
    );
}
