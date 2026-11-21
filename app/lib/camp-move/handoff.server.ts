/**
 * Sign-ins that follow a camp to its new install (plans/camp-portability.md,
 * "Logins after a move").
 *
 * The two installs share no secret, so the old one vouches for a person with
 * a token signed by the move's Ed25519 key, and the new one checks it against
 * the public key that came with the camp:
 *
 *   <payload base64url>.<signature base64url>
 *   payload = { iss: old origin, aud: new origin, sub: old user id,
 *               mv: move id, exp: epoch ms, jti: random }
 *
 * Good for two minutes, once. The new install honours it only during the
 * move's window, and only for people the move created there (or is holding a
 * claim for): never for an account that already existed there, which the old
 * install has no business signing into.
 *
 * Server-only.
 */
import { Buffer } from "node:buffer";
import { and, eq, gt, like, lt, sql } from "drizzle-orm";
import { atomic, db } from "../../../db/client.server";
import {
  campMoveIn,
  campMoveUser,
  membership,
  verification,
} from "../../../db/schema";
import { APEX } from "../env.server";
import { referencesTo } from "../merge.server";
import { sign, verify } from "./bundle";
import { type MoveOut, peopleOf, unseal } from "./move-out.server";

const TTL_MS = 2 * 60 * 1000;
const JTI = "move-jti:";
const CLAIM = "move-claim:";
const CLAIM_TTL_MS = 30 * 60 * 1000;

type Payload = {
  iss: string;
  aud: string;
  sub: string;
  mv: string;
  exp: number;
  jti: string;
};

/** Old install: the URL that signs `userId` in at the camp's new home and
 * lands them on `next` (a URL there). Null if they aren't one of the camp's
 * people or the move isn't live. */
export async function handoffUrl(
  move: MoveOut,
  userId: string,
  next: string,
  now = Date.now(),
): Promise<string | null> {
  if (move.state !== "done" || !move.targetOrigin) return null;
  if ((move.windowEndsAt?.getTime() ?? 0) <= now) return null;
  if (!peopleOf(move).includes(userId)) return null;
  const payload: Payload = {
    iss: APEX.origin,
    aud: move.targetOrigin,
    sub: userId,
    mv: move.id,
    exp: now + TTL_MS,
    jti: crypto.randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = await sign(await unseal(move.privateKey), body);
  const url = new URL("/move-handoff", move.targetOrigin);
  url.searchParams.set("t", `${body}.${sig}`);
  url.searchParams.set("next", next);
  return url.href;
}

export type HandoffResult =
  | { ok: true; userId: string; outcome: "created" }
  | { ok: true; userId: string; outcome: "claim"; claim: string }
  | { ok: false; why: string };

/** New install: check a token; spend it. */
export async function acceptHandoff(
  token: string,
  ourOrigin: string,
  now = Date.now(),
): Promise<HandoffResult> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, why: "malformed" };
  let p: Payload;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return { ok: false, why: "malformed" };
  }
  if (p.aud !== ourOrigin) return { ok: false, why: "audience" };
  if (typeof p.exp !== "number" || p.exp < now) {
    return { ok: false, why: "expired" };
  }
  const [move] = await db
    .select()
    .from(campMoveIn)
    .where(
      and(
        eq(campMoveIn.id, String(p.mv)),
        gt(campMoveIn.windowEndsAt, new Date(now)),
      ),
    )
    .limit(1);
  if (!move || move.sourceOrigin !== p.iss) return { ok: false, why: "move" };
  if (!(await verify(move.publicKey, body, sig))) {
    return { ok: false, why: "signature" };
  }
  // Once only.
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, `${JTI}%`),
        lt(verification.expiresAt, new Date(now)),
      ),
    );
  // Record first, then count: of two racing uses, at least one sees two.
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: JTI + p.jti,
    value: p.mv,
    expiresAt: new Date(p.exp + 60_000),
  });
  const uses = await db
    .select({ id: verification.id })
    .from(verification)
    .where(eq(verification.identifier, JTI + p.jti));
  if (uses.length > 1) return { ok: false, why: "replay" };

  const [person] = await db
    .select()
    .from(campMoveUser)
    .where(
      and(
        eq(campMoveUser.moveId, move.id),
        eq(campMoveUser.sourceUserId, String(p.sub)),
      ),
    )
    .limit(1);
  if (!person) return { ok: false, why: "person" };
  if (person.outcome === "created") {
    return { ok: true, userId: person.userId, outcome: "created" };
  }
  if (person.outcome === "claim" && !person.claimedAt) {
    const claim = Buffer.from(
      crypto.getRandomValues(new Uint8Array(24)),
    ).toString("base64url");
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: CLAIM + claim,
      value: person.id,
      expiresAt: new Date(now + CLAIM_TTL_MS),
    });
    return { ok: true, userId: person.userId, outcome: "claim", claim };
  }
  return { ok: false, why: "linked" };
}

/** The pending claim a claim code is for (not spent), or null. */
export async function findClaim(code: string, now = Date.now()) {
  if (!code) return null;
  const [row] = await db
    .select()
    .from(verification)
    .where(eq(verification.identifier, CLAIM + code))
    .limit(1);
  if (!row || row.expiresAt.getTime() < now) return null;
  const [person] = await db
    .select()
    .from(campMoveUser)
    .where(eq(campMoveUser.id, row.value))
    .limit(1);
  if (!person || person.claimedAt || person.outcome !== "claim") return null;
  return person;
}

export async function spendClaim(code: string) {
  await db
    .delete(verification)
    .where(eq(verification.identifier, CLAIM + code));
}

/**
 * Settle a claim: the person proved who they were at the old install (the
 * hand-off) and is signed in here as `userId`. Everything the placeholder
 * held moves to that account and the placeholder goes.
 */
export async function claimInto(
  person: typeof campMoveUser.$inferSelect,
  userId: string,
): Promise<string | null> {
  if (person.userId === userId) return null;
  const [moveIn] = await db
    .select({ campId: campMoveIn.campId })
    .from(campMoveIn)
    .where(eq(campMoveIn.id, person.moveId))
    .limit(1);
  if (!moveIn) return "That camp isn't here any more.";
  const [already] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(
        eq(membership.organizationId, moveIn.campId),
        eq(membership.userId, userId),
      ),
    )
    .limit(1);
  if (already) {
    return "That account is already in this camp. Sign in with a different one, or ask an officer to merge the two.";
  }
  const placeholder = person.userId;
  await atomic([
    ...referencesTo("user")
      .filter((r) => r.table !== "camp_move_user")
      .map(
        (r) =>
          sql`UPDATE ${sql.identifier(r.table)} SET ${sql.identifier(r.column)} = ${userId} WHERE ${sql.identifier(r.column)} = ${placeholder}`,
      ),
    sql`UPDATE camp_move_user SET user_id = ${userId}, claimed_at = ${Date.now()} WHERE id = ${person.id}`,
    sql`DELETE FROM user WHERE id = ${placeholder}`,
  ]);
  return null;
}
