import { Buffer } from "node:buffer";
import { and, eq, isNull } from "drizzle-orm";
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
