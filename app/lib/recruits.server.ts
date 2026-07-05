/**
 * Server helpers for the public joining funnel (/c/:slug applications,
 * /i/:token invites, and the applicant's dashboard): membership checks and the
 * "does this person have a pending application?" condition, which must match by
 * account OR email because people sometimes apply before they have an account
 * (or with a different one).
 */
import { and, eq, or } from "drizzle-orm";
import { db } from "../../db/client.server";
import { membership, recruitApplication } from "../../db/schema";

/** Whether the user already belongs to the camp. */
export async function isMemberOf(
  userId: string,
  campId: string,
): Promise<boolean> {
  const [m] = await db
    .select({ id: membership.id })
    .from(membership)
    .where(
      and(eq(membership.userId, userId), eq(membership.organizationId, campId)),
    )
    .limit(1);
  return Boolean(m);
}

/** WHERE condition matching the viewer's pending applications (by userId or
 * email), optionally scoped to one camp. */
export function pendingApplicationWhere(
  viewer: { id: string; email: string },
  campId?: string,
) {
  const mine = and(
    eq(recruitApplication.status, "pending"),
    or(
      eq(recruitApplication.userId, viewer.id),
      eq(recruitApplication.email, viewer.email),
    ),
  );
  return campId ? and(eq(recruitApplication.campId, campId), mine) : mine;
}
