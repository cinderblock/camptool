/**
 * Passkey-first signup: creating an account with NO password.
 *
 * The problem this solves: a WebAuthn registration ceremony needs a user id up
 * front (it gets baked into the credential as the user handle), but we don't
 * want a `user` row to exist until a credential has actually been verified —
 * an aborted browser prompt would otherwise leave an orphan account with no way
 * to sign in, squatting the unique email and blocking the retry.
 *
 * So we split it: mint a *pending* signup (a pre-generated user id + the name
 * and email the visitor typed), hand the caller an opaque handle, and only
 * materialize the `user` row once `afterVerification` fires. The pre-generated
 * id is what both halves agree on, so the credential's user handle matches the
 * account it ends up attached to.
 *
 * Storage reuses better-auth's own `verification` table rather than adding one:
 * it already has (identifier, value, expiresAt) semantics and is swept by the
 * same expiry machinery.
 *
 * Server-only. See `plans/passkey-first-auth.md` (Layer 3) for the full flow.
 */
import { and, eq, like, lt } from "drizzle-orm";
import { db } from "../../db/client.server";
import { user, verification } from "../../db/schema";

/** Namespace prefix in `verification.identifier`, so these rows are trivially
 * distinguishable from magic-link / email-verification rows. */
const PREFIX = "passkey-signup:";

/** Deliberately short. The handle is only alive for one WebAuthn ceremony —
 * the visitor is looking at the browser's passkey prompt the whole time. */
const TTL_MS = 10 * 60 * 1000;

export type PendingSignup = {
  /** Pre-generated id the `user` row will be created with. */
  userId: string;
  name: string;
  email: string;
  /** Invite token, when the signup came in via `/i/:token`. Carried through so
   * the redemption can happen server-side once the account exists. */
  inviteToken?: string;
};

export type StartResult =
  | { ok: true; context: string }
  | { ok: false; reason: string };

/**
 * Begin a passkey-first signup. Returns the opaque `context` handle to pass to
 * `authClient.passkey.addPasskey({ context })`.
 *
 * Validates up front (email shape, address not already taken) so the visitor
 * gets a useful error BEFORE the browser throws a passkey prompt at them — a
 * failure after the ceremony is far more confusing.
 */
export async function startPasskeySignup(input: {
  name: string;
  email: string;
  inviteToken?: string;
}): Promise<StartResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();

  if (!name) return { ok: false, reason: "Enter your name." };
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, reason: "Enter a valid email address." };
  }

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (existing) {
    return {
      ok: false,
      reason: "An account with that email already exists. Sign in instead.",
    };
  }

  await sweepExpired();

  const handle = crypto.randomUUID();
  const pending: PendingSignup = {
    userId: crypto.randomUUID(),
    name,
    email,
    ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
  };

  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: PREFIX + handle,
    value: JSON.stringify(pending),
    expiresAt: new Date(Date.now() + TTL_MS),
  });

  return { ok: true, context: handle };
}

/**
 * Look up a pending signup WITHOUT consuming it.
 *
 * Read-only on purpose: this runs from the passkey plugin's `resolveUser`,
 * which fires at *generate-register-options* time — the ceremony can still be
 * abandoned after that, and the visitor deserves to be able to retry. The row
 * is consumed only on verified success (`consumePendingSignup`).
 */
export async function readPendingSignup(
  handle: string | null | undefined,
): Promise<PendingSignup | null> {
  if (!handle) return null;
  const [row] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, PREFIX + handle))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  try {
    return JSON.parse(row.value) as PendingSignup;
  } catch {
    return null;
  }
}

/** Read and delete in one step, for use once a credential is verified. */
export async function consumePendingSignup(
  handle: string | null | undefined,
): Promise<PendingSignup | null> {
  const pending = await readPendingSignup(handle);
  if (!pending) return null;
  await db
    .delete(verification)
    .where(eq(verification.identifier, PREFIX + handle));
  return pending;
}

/** Drop timed-out handles so abandoned ceremonies don't accumulate. Scoped to
 * our own prefix — better-auth owns the other rows in this table. */
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
