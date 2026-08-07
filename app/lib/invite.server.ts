import { Buffer } from "node:buffer";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campInvite } from "../../db/schema";

/** A URL-safe, hard-to-guess invite token (192 bits of entropy). */
export function newInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** The one-use personal invite link that promotes a guest attendee into a
 * recruit account (redeeming adopts their attendee row — see i.$token).
 * Idempotent: an unused, unrevoked promotion link for this guest is reused,
 * so re-clicking "Invite to join" hands back the same URL. */
export async function getOrCreatePromotionInvite(opts: {
  campId: string;
  guestAttendeeId: string;
  inviterMembershipId: string;
  guestName: string;
}): Promise<string> {
  const [existing] = await db
    .select({ token: campInvite.token })
    .from(campInvite)
    .where(
      and(
        eq(campInvite.campId, opts.campId),
        eq(campInvite.promoteAttendeeId, opts.guestAttendeeId),
        eq(campInvite.useCount, 0),
        isNull(campInvite.revokedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.token;

  const token = newInviteToken();
  await db.insert(campInvite).values({
    id: crypto.randomUUID(),
    campId: opts.campId,
    inviterMembershipId: opts.inviterMembershipId,
    token,
    kind: "personal",
    role: "recruit",
    note: `Promotion: ${opts.guestName}`,
    maxUses: 1,
    promoteAttendeeId: opts.guestAttendeeId,
  });
  return token;
}

export type PromotionInviteState = {
  token: string;
  /** Somebody has already signed up through it; the link is spent. */
  redeemed: boolean;
};

/**
 * Existing promotion links for a set of guests, so a host can SEE whether they
 * already made one instead of having to click the button again to find out.
 *
 * This is the whole of the "the invite mechanism is confusing" report: the link
 * existed, worked, and was idempotent — but it was only ever shown in transient
 * fetcher state, so it vanished on the next navigation and nothing on the guest
 * row recorded that it had been sent. Handing it back with the roster makes it
 * a durable fact about the guest rather than a thing you had to catch in flight.
 *
 * A revoked link is deliberately not returned: it should read as "no link yet"
 * so the next click mints a fresh one.
 */
export async function loadPromotionInvites(
  campId: string,
  attendeeIds: string[],
): Promise<Map<string, PromotionInviteState>> {
  if (attendeeIds.length === 0) return new Map();
  const rows = await db
    .select({
      token: campInvite.token,
      attendeeId: campInvite.promoteAttendeeId,
      useCount: campInvite.useCount,
    })
    .from(campInvite)
    .where(
      and(
        eq(campInvite.campId, campId),
        inArray(campInvite.promoteAttendeeId, attendeeIds),
        isNull(campInvite.revokedAt),
      ),
    );
  const out = new Map<string, PromotionInviteState>();
  for (const r of rows) {
    if (!r.attendeeId) continue;
    const redeemed = r.useCount > 0;
    const prior = out.get(r.attendeeId);
    // An unspent link wins: that's the one still worth sharing. Otherwise a
    // redeemed one is kept so the row can say "they've joined".
    if (!prior || (prior.redeemed && !redeemed)) {
      out.set(r.attendeeId, { token: r.token, redeemed });
    }
  }
  return out;
}
