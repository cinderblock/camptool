/**
 * "Where is this party camped?" — the bridge between the roster and the map.
 *
 * A person attaches to a map object two different ways, with two different key
 * types: as the **owner** (`map_object.owner_membership_id` → a membership) or
 * as an **occupant** (`map_object_occupant.attendee_id` → an attendee). Guests
 * have no membership, so they can only ever appear on the occupant side. A
 * party's objects are the union of both, over the host member *and* every guest
 * they bring — which is what the roster groups by, and what answers "where is
 * this household?" rather than "where is this one body?".
 *
 * Everything is keyed by the **host membership id**, so a guest's tent shows up
 * under the member who brought them. Unplaced objects are excluded: they're the
 * officer's staging queue, not a location.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { attendee, mapObject, mapObjectOccupant } from "../../db/schema";

/**
 * Every party's placed map objects for an edition, keyed by host membership id.
 *
 * Deliberately computes the whole edition in two queries rather than taking a
 * membership filter: the roster needs all of them at once, the map needs one,
 * and one code path means the two surfaces can't disagree about what "their
 * stuff" means. An edition's map is a few hundred rows at most.
 */
export async function partyMapObjects(
  editionId: string,
): Promise<Map<string, string[]>> {
  const ownerRows = await db
    .select({
      objectId: mapObject.id,
      membershipId: mapObject.ownerMembershipId,
    })
    .from(mapObject)
    .where(
      and(
        eq(mapObject.editionId, editionId),
        eq(mapObject.placed, true),
        isNotNull(mapObject.ownerMembershipId),
      ),
    );

  const occupantRows = await db
    .select({
      objectId: mapObjectOccupant.objectId,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
    })
    .from(mapObjectOccupant)
    .innerJoin(attendee, eq(attendee.id, mapObjectOccupant.attendeeId))
    .innerJoin(mapObject, eq(mapObject.id, mapObjectOccupant.objectId))
    .where(
      and(
        eq(mapObjectOccupant.editionId, editionId),
        eq(mapObject.placed, true),
      ),
    );

  // Sets, not arrays: a member who both owns a tent and is listed as its
  // occupant must not have it counted twice.
  const byMember = new Map<string, Set<string>>();
  const add = (membershipId: string | null, objectId: string) => {
    if (!membershipId) return;
    const set = byMember.get(membershipId) ?? new Set<string>();
    set.add(objectId);
    byMember.set(membershipId, set);
  };

  for (const r of ownerRows) add(r.membershipId, r.objectId);
  // A guest's occupancy rolls up to their host; a member's to themselves.
  for (const r of occupantRows)
    add(r.membershipId ?? r.hostMembershipId, r.objectId);

  return new Map([...byMember].map(([k, v]) => [k, [...v]]));
}

/** One party's placed map objects. See `partyMapObjects` for the shape. */
export async function partyMapObjectsFor(
  editionId: string,
  membershipId: string,
): Promise<string[]> {
  return (await partyMapObjects(editionId)).get(membershipId) ?? [];
}
