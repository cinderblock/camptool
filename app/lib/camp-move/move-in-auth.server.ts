/**
 * Signing in on a camp's new install with what people had at the old one
 * (plans/camp-portability.md, "Logins after a move"), for the move's window.
 *
 * Server-only.
 */
import { and, eq, gt } from "drizzle-orm";
import { db } from "../../../db/client.server";
import { campMoveIn, campMoveUser } from "../../../db/schema";

export type MovedFrom = {
  moveId: string;
  rpId: string;
  sourceOrigin: string;
};

/** Live moves into this install, one per old site. */
export async function movedFrom(now = new Date()): Promise<MovedFrom[]> {
  const rows = await db
    .select({
      moveId: campMoveIn.id,
      rpId: campMoveIn.sourceRpId,
      sourceOrigin: campMoveIn.sourceOrigin,
    })
    .from(campMoveIn)
    .where(gt(campMoveIn.windowEndsAt, now));
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.rpId) && seen.add(r.rpId));
}

/** Whether `userId` arrived here with a moved camp, as a new account, still
 * inside that move's window: the people the old site may sign in. */
export async function arrivedWithMove(
  userId: string,
  rpId?: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: campMoveUser.id })
    .from(campMoveUser)
    .innerJoin(campMoveIn, eq(campMoveIn.id, campMoveUser.moveId))
    .where(
      and(
        eq(campMoveUser.userId, userId),
        eq(campMoveUser.outcome, "created"),
        gt(campMoveIn.windowEndsAt, now),
        ...(rpId ? [eq(campMoveIn.sourceRpId, rpId)] : []),
      ),
    )
    .limit(1);
  return !!row;
}
