/**
 * Server helpers for the per-year attendee roster — "who's coming this year".
 * An attendee is one body at the event for an edition: a camp member (their own
 * `attendee` row, membership_id set) or a guest a member brings (host_membership_id
 * set, no account). See `db/schema/attendee.ts`.
 *
 * Guests are always inserted `status = 'coming'` (a host adds them because
 * they're coming; if plans change the host removes them), so the headcount is a
 * uniform count of `status = 'coming'` across members + guests.
 */
import { and, count, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { attendee, membership, user } from "../../db/schema";

export type AttendeeStatus = "unknown" | "coming" | "maybe" | "not_coming";

export type RosterGuest = {
  id: string;
  name: string;
  arrivalDate: string | null;
  departureDate: string | null;
  note: string | null;
};

export type RosterMember = {
  membershipId: string;
  userId: string;
  name: string;
  playaName: string | null;
  role: string;
  status: AttendeeStatus;
  arrivalDate: string | null;
  departureDate: string | null;
  note: string | null;
  guests: RosterGuest[];
};

export type Headcount = {
  /** Members who RSVP'd "coming". */
  membersComing: number;
  /** Members "maybe". */
  membersMaybe: number;
  /** Guests brought (all counted as coming). */
  guests: number;
  /** Confirmed bodies on site = membersComing + guests. */
  total: number;
};

/** Full roster for a year: every member with their RSVP + brought guests. */
export async function loadRoster(
  campId: string,
  editionId: string,
): Promise<{ members: RosterMember[]; headcount: Headcount }> {
  const memberRows = await db
    .select({
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
      playaName: membership.playaName,
      userName: user.name,
      status: attendee.status,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      note: attendee.note,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    // A member has at most one attendee row per edition, so no fan-out.
    .leftJoin(
      attendee,
      and(
        eq(attendee.membershipId, membership.id),
        eq(attendee.editionId, editionId),
      ),
    )
    .where(eq(membership.organizationId, campId));

  const guestRows = await db
    .select({
      id: attendee.id,
      hostMembershipId: attendee.hostMembershipId,
      name: attendee.name,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      note: attendee.note,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        isNotNull(attendee.hostMembershipId),
      ),
    );

  const guestsByHost = new Map<string, RosterGuest[]>();
  for (const g of guestRows) {
    if (!g.hostMembershipId) continue;
    const list = guestsByHost.get(g.hostMembershipId) ?? [];
    list.push({
      id: g.id,
      name: g.name ?? "Guest",
      arrivalDate: g.arrivalDate,
      departureDate: g.departureDate,
      note: g.note,
    });
    guestsByHost.set(g.hostMembershipId, list);
  }

  const members: RosterMember[] = memberRows.map((r) => ({
    membershipId: r.membershipId,
    userId: r.userId,
    name: r.userName,
    playaName: r.playaName,
    role: r.role,
    status: (r.status as AttendeeStatus | null) ?? "unknown",
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    note: r.note,
    guests: guestsByHost.get(r.membershipId) ?? [],
  }));

  let membersComing = 0;
  let membersMaybe = 0;
  let guests = 0;
  for (const m of members) {
    if (m.status === "coming") membersComing++;
    else if (m.status === "maybe") membersMaybe++;
    guests += m.guests.length;
  }

  return {
    members,
    headcount: {
      membersComing,
      membersMaybe,
      guests,
      total: membersComing + guests,
    },
  };
}

/** Lean headcount for the overview card (no per-member detail). */
export async function headcountFor(editionId: string): Promise<Headcount> {
  const [comingRow] = await db
    .select({ n: count() })
    .from(attendee)
    .where(
      and(eq(attendee.editionId, editionId), eq(attendee.status, "coming")),
    );
  const [maybeRow] = await db
    .select({ n: count() })
    .from(attendee)
    .where(
      and(eq(attendee.editionId, editionId), eq(attendee.status, "maybe")),
    );
  const [guestRow] = await db
    .select({ n: count() })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        isNotNull(attendee.hostMembershipId),
      ),
    );
  // All guests are status 'coming', so members-coming = total coming − guests.
  const totalComing = comingRow?.n ?? 0;
  const guests = guestRow?.n ?? 0;
  return {
    membersComing: Math.max(0, totalComing - guests),
    membersMaybe: maybeRow?.n ?? 0,
    guests,
    total: totalComing,
  };
}

/** A host's own guests for the edition (their "party"). */
export async function listGuests(
  editionId: string,
  hostMembershipId: string,
): Promise<RosterGuest[]> {
  const rows = await db
    .select({
      id: attendee.id,
      name: attendee.name,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      note: attendee.note,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.hostMembershipId, hostMembershipId),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "Guest",
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    note: r.note,
  }));
}

export async function addGuest(opts: {
  campId: string;
  editionId: string;
  hostMembershipId: string;
  name: string;
  email?: string | null;
  arrivalDate?: string | null;
  departureDate?: string | null;
  note?: string | null;
}): Promise<void> {
  await db.insert(attendee).values({
    id: crypto.randomUUID(),
    campId: opts.campId,
    editionId: opts.editionId,
    hostMembershipId: opts.hostMembershipId,
    name: opts.name,
    email: opts.email ?? null,
    // A brought guest is coming by definition; the host removes them otherwise.
    status: "coming",
    arrivalDate: opts.arrivalDate ?? null,
    departureDate: opts.departureDate ?? null,
    note: opts.note ?? null,
  });
}

/** Fetch a guest row scoped to camp+edition, for authorization + editing. */
export async function getGuest(
  campId: string,
  editionId: string,
  guestId: string,
): Promise<{
  id: string;
  hostMembershipId: string | null;
  name: string | null;
} | null> {
  const [row] = await db
    .select({
      id: attendee.id,
      hostMembershipId: attendee.hostMembershipId,
      name: attendee.name,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.id, guestId),
        eq(attendee.campId, campId),
        eq(attendee.editionId, editionId),
        isNotNull(attendee.hostMembershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateGuest(
  guestId: string,
  fields: {
    name?: string;
    arrivalDate?: string | null;
    departureDate?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await db
    .update(attendee)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(attendee.id, guestId));
}

export async function removeGuest(guestId: string): Promise<void> {
  await db.delete(attendee).where(eq(attendee.id, guestId));
}

/**
 * Return the attendee id for a member in an edition, creating an `unknown`-status
 * row if they don't have one yet. Used when a member is added as a map occupant
 * before they've RSVP'd — occupancy references an attendee, not a membership.
 */
export async function ensureMemberAttendee(
  campId: string,
  editionId: string,
  membershipId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: attendee.id })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db
    .insert(attendee)
    .values({ id, campId, editionId, membershipId, status: "unknown" })
    .onConflictDoNothing();
  // Re-select in case a concurrent insert won the partial-unique race.
  const [row] = await db
    .select({ id: attendee.id })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    )
    .limit(1);
  return row?.id ?? id;
}
