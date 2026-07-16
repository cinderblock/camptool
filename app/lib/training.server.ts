/**
 * Training sign-offs — server-side loading + the signup-gating check. Pairs
 * with the pure catalog/predicate in training.ts. Design:
 * plans/events-scheduling.md. Route loaders/actions own authorization.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  gatheringRequirement,
  membership,
  training,
  trainingSignoff,
  user,
} from "../../db/schema";
import { isValidSignoff } from "./training";

/** Active (non-archived) trainings for a camp, ordered. */
export async function loadTrainings(campId: string) {
  return (
    await db
      .select()
      .from(training)
      .where(and(eq(training.campId, campId), isNull(training.archivedAt)))
  ).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** All of a camp's sign-off rows, with member + training joined (officer
 * roster view). History rows (revoked/expired/other-year) included — the
 * caller labels validity via isValidSignoff. */
export async function loadSignoffs(campId: string) {
  return db
    .select({
      id: trainingSignoff.id,
      trainingId: trainingSignoff.trainingId,
      membershipId: trainingSignoff.membershipId,
      editionId: trainingSignoff.editionId,
      grantedAt: trainingSignoff.grantedAt,
      expiresAt: trainingSignoff.expiresAt,
      revokedAt: trainingSignoff.revokedAt,
      note: trainingSignoff.note,
      playaName: membership.playaName,
      name: user.name,
    })
    .from(trainingSignoff)
    .innerJoin(membership, eq(membership.id, trainingSignoff.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(trainingSignoff.campId, campId));
}

/** The set of training ids this member currently holds a VALID sign-off for. */
export async function validTrainingIds(opts: {
  campId: string;
  membershipId: string;
  editionId: string;
  now?: Date;
}): Promise<Set<string>> {
  const rows = await db
    .select({
      trainingId: trainingSignoff.trainingId,
      editionId: trainingSignoff.editionId,
      expiresAt: trainingSignoff.expiresAt,
      revokedAt: trainingSignoff.revokedAt,
      validity: training.validity,
    })
    .from(trainingSignoff)
    .innerJoin(training, eq(training.id, trainingSignoff.trainingId))
    .where(
      and(
        eq(trainingSignoff.campId, opts.campId),
        eq(trainingSignoff.membershipId, opts.membershipId),
      ),
    );
  const valid = new Set<string>();
  for (const r of rows) {
    if (
      isValidSignoff(r.validity, r, {
        editionId: opts.editionId,
        now: opts.now,
      })
    ) {
      valid.add(r.trainingId);
    }
  }
  return valid;
}

export type MissingRequirement = {
  trainingId: string;
  name: string;
  enforcement: string;
};

/** Requirements on a gathering this member does NOT currently satisfy. */
export async function missingRequirements(opts: {
  campId: string;
  gatheringId: string;
  membershipId: string;
  editionId: string;
}): Promise<MissingRequirement[]> {
  const reqs = await db
    .select({
      trainingId: gatheringRequirement.trainingId,
      enforcement: gatheringRequirement.enforcement,
      name: training.name,
    })
    .from(gatheringRequirement)
    .innerJoin(training, eq(training.id, gatheringRequirement.trainingId))
    .where(eq(gatheringRequirement.gatheringId, opts.gatheringId));
  if (reqs.length === 0) return [];
  const valid = await validTrainingIds(opts);
  return reqs.filter((r) => !valid.has(r.trainingId));
}

/** Requirements attached to a set of gatherings (for list/detail display). */
export async function loadRequirements(gatheringIds: string[]) {
  if (gatheringIds.length === 0) return [];
  return db
    .select({
      id: gatheringRequirement.id,
      gatheringId: gatheringRequirement.gatheringId,
      trainingId: gatheringRequirement.trainingId,
      enforcement: gatheringRequirement.enforcement,
      name: training.name,
    })
    .from(gatheringRequirement)
    .innerJoin(training, eq(training.id, gatheringRequirement.trainingId))
    .where(inArray(gatheringRequirement.gatheringId, gatheringIds));
}
