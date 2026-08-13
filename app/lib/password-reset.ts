/**
 * Pure helpers for officer-issued password reset links — no DB, no auth, so
 * they're safe to import from a component or a unit test. The stateful half
 * lives in `password-reset.server.ts`. Same split as `invite.ts` /
 * `invite.server.ts`.
 *
 * See `plans/password-recovery.md`.
 */

/** Wrong-email guesses before the link is dead. Generous enough for a typo,
 * far too few to grind through plausible addresses. */
export const MAX_RESET_ATTEMPTS = 5;

/** Decision 3 in the plan: long enough to survive "I'll do it this weekend",
 * short enough that a link left in a chat log dies. */
export const RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ResetLinkState =
  /** Usable right now. */
  | "valid"
  /** Past its 7-day window. */
  | "expired"
  /** Already reset a password. */
  | "used"
  /** Superseded by a newer link for the same person. */
  | "revoked"
  /** Too many wrong-email attempts. */
  | "locked"
  /** No such link — mistyped, or truncated by whatever app it was sent through. */
  | "unknown";

/** The state machine over a link row, split out so it can be tested without a
 * database and reasoned about in one place. */
export function resetLinkState(
  link: {
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
    attempts: number;
  },
  now: number = Date.now(),
): Exclude<ResetLinkState, "unknown"> {
  // Order matters: "used" is the most informative outcome and should win over
  // a link that has also since expired, otherwise someone whose link was
  // already spent gets told to ask for a new one when the real answer is
  // "that reset already happened — was it you?".
  if (link.usedAt) return "used";
  if (link.revokedAt) return "revoked";
  if (link.attempts >= MAX_RESET_ATTEMPTS) return "locked";
  if (link.expiresAt.getTime() <= now) return "expired";
  return "valid";
}

/**
 * `cinderblock63@gmail.com` → `ci•••••••••••@g••••.com`.
 *
 * Enough for the recipient to recognise their own address, not enough for
 * whoever else ends up holding the link to learn it. Short locals still get at
 * least one bullet so the exact length isn't given away.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";

  return `${blur(local, 2)}@${blur(host, 1)}${tld}`;
}

function blur(s: string, keep: number): string {
  const head = s.slice(0, keep);
  return head + "•".repeat(Math.max(1, s.length - head.length));
}
