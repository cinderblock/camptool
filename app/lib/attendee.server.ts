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
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import { attendee, membership, setupPass, ticket, user } from "../../db/schema";

export type AttendeeStatus = "unknown" | "coming" | "maybe" | "not_coming";

/**
 * A **guest** row: someone with no account of their own, managed by a host.
 *
 * Having a host is NOT the same as being a guest. `host_membership_id` means
 * "here as part of this member's party", which a member with their own account
 * can also be (Grace attending as part of Albert's household). Only the absence
 * of `membership_id` makes a row a guest. Every query that means "guests" must
 * use this predicate — conflating the two double-renders linked members on the
 * roster, subtracts them from the member headcount, and (via `getGuest`) lets
 * `removeGuest` delete a real member's RSVP.
 */
const isGuestRow = and(
  isNull(attendee.membershipId),
  isNotNull(attendee.hostMembershipId),
);

export type RosterGuest = {
  id: string;
  name: string;
  arrivalDate: string | null;
  departureDate: string | null;
  note: string | null;
  /** adult (null) | under_18 | under_13 — see `app/lib/age.ts`. */
  ageBand: string | null;
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
  /**
   * This member is attending as part of another member's party — NULL for
   * almost everyone. Set means their household anchor is someone else, so
   * "where are they camped?" resolves through that person.
   */
  partyHost: { membershipId: string; name: string } | null;
  /** Members (not guests) attending as part of THIS member's party. */
  partyMembers: { membershipId: string; name: string }[];
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
      ageBand: attendee.ageBand,
      partyHostMembershipId: attendee.hostMembershipId,
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
      ageBand: attendee.ageBand,
    })
    .from(attendee)
    .where(and(eq(attendee.editionId, editionId), isGuestRow));

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
      ageBand: g.ageBand,
    });
    guestsByHost.set(g.hostMembershipId, list);
  }

  // Party links point one way, so both directions are resolved from the same
  // pass: who each member is attending *with*, and who is attending with them.
  const nameOf = new Map(memberRows.map((r) => [r.membershipId, r.userName]));
  const partyMembersByHost = new Map<
    string,
    { membershipId: string; name: string }[]
  >();
  for (const r of memberRows) {
    const host = r.partyHostMembershipId;
    if (!host || host === r.membershipId) continue;
    const list = partyMembersByHost.get(host) ?? [];
    list.push({ membershipId: r.membershipId, name: r.userName });
    partyMembersByHost.set(host, list);
  }

  const members: RosterMember[] = memberRows.map((r) => {
    const host = r.partyHostMembershipId;
    // Guard against a self-link making someone their own household anchor,
    // which would deadlock "resolve my location through my host".
    const hostName = host && host !== r.membershipId ? nameOf.get(host) : null;
    return {
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
      partyHost:
        host && hostName ? { membershipId: host, name: hostName } : null,
      partyMembers: partyMembersByHost.get(r.membershipId) ?? [],
    };
  });

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
    .where(and(eq(attendee.editionId, editionId), isGuestRow));
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

/**
 * A host's own guests for the edition — accountless people only. Members
 * attending as part of this host's party are listed separately; they are not
 * anybody's guest.
 */
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
      ageBand: attendee.ageBand,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.hostMembershipId, hostMembershipId),
        isGuestRow,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? "Guest",
    arrivalDate: r.arrivalDate,
    departureDate: r.departureDate,
    note: r.note,
    ageBand: r.ageBand,
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
  /** adult (default) | under_18 | under_13 — see `app/lib/age.ts`. */
  ageBand?: string | null;
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
    ageBand: opts.ageBand ?? null,
    note: opts.note ?? null,
  });
}

/**
 * Fetch a guest row scoped to camp+edition, for authorization + editing.
 *
 * The `isGuestRow` filter is load-bearing, not tidiness: this is the gate in
 * front of `updateGuest` and `removeGuest`, and `removeGuest` *deletes* the
 * attendee row. Matching on "has a host" alone would let a member attending as
 * part of someone's party be silently deleted through the guest endpoints —
 * losing their RSVP, releasing their ticket and revoking their setup pass.
 */
export async function getGuest(
  campId: string,
  editionId: string,
  guestId: string,
): Promise<{
  id: string;
  membershipId: string | null;
  hostMembershipId: string | null;
  name: string | null;
} | null> {
  const [row] = await db
    .select({
      id: attendee.id,
      // Always NULL here (that's what makes it a guest), but selected so the row
      // satisfies `AttendeeParty` and can go straight into `canManageAttendee`.
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      name: attendee.name,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.id, guestId),
        eq(attendee.campId, campId),
        eq(attendee.editionId, editionId),
        isGuestRow,
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
    ageBand?: string | null;
  },
): Promise<void> {
  await db
    .update(attendee)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(attendee.id, guestId));
}

/**
 * Remove a guest from their host's party.
 *
 * Deleting the row alone isn't enough. `ticket.assigned_attendee_id` is ON
 * DELETE SET NULL, so a ticket held by this guest would keep `status =
 * 'assigned'` with nobody assigned — invisible to the officer's available
 * count and un-reassignable. And `setup_pass` cascades, so a *granted* pass
 * would vanish silently and free its quota with no record. Release the ticket
 * back to the pool explicitly and report what else went, so the caller can say
 * so instead of the camp discovering it on playa.
 */
export async function removeGuest(guestId: string): Promise<{
  ticketsReleased: number;
  passesRevoked: number;
}> {
  const [{ value: ticketsReleased } = { value: 0 }] = await db
    .select({ value: count() })
    .from(ticket)
    .where(eq(ticket.assignedAttendeeId, guestId));
  const [{ value: passesRevoked } = { value: 0 }] = await db
    .select({ value: count() })
    .from(setupPass)
    .where(
      and(eq(setupPass.attendeeId, guestId), eq(setupPass.status, "granted")),
    );

  await db
    .update(ticket)
    .set({
      status: "available",
      assignedAttendeeId: null,
      updatedAt: new Date(),
    })
    .where(eq(ticket.assignedAttendeeId, guestId));

  await db.delete(attendee).where(eq(attendee.id, guestId));
  return { ticketsReleased, passesRevoked };
}

type PartyResult = { ok: true } | { ok: false; error: string };

/**
 * Can `membershipId` sit under `hostMembershipId` at all?
 *
 * Shared by `setPartyHost` and `invitePartyMember` so an invitation that could
 * never be accepted is refused when it's sent, rather than at the moment the
 * other person tries to say yes. Re-run on acceptance too: an invitation can
 * sit unanswered for weeks, and either party's household may have moved on.
 *
 * Refuses rather than silently repairing, because every refusal here means the
 * caller believes something about the roster that isn't true:
 *
 *   - **Self-host.** Would make someone their own household anchor, and
 *     "resolve my location through my host" would never terminate.
 *   - **Host is itself hosted.** Parties are one level deep (see the schema
 *     comment). Chains would make the single-hop roll-up in `party-map.server`
 *     wrong and there'd be no single answer to "whose household is this?".
 *   - **Subject already hosts people.** Same reason from the other side: their
 *     guests would end up a level deeper than the roll-up looks.
 *
 * Returns a human-readable reason so the caller can pass it straight to the
 * person, who is usually the one who can fix it.
 */
async function checkPartyLink(
  campId: string,
  editionId: string,
  membershipId: string,
  hostMembershipId: string,
): Promise<PartyResult> {
  if (hostMembershipId === membershipId) {
    return { ok: false, error: "Someone can't be in their own party." };
  }

  const [host] = await db
    .select({ id: membership.id, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(membership.id, hostMembershipId),
        eq(membership.organizationId, campId),
      ),
    )
    .limit(1);
  if (!host) return { ok: false, error: "That person isn't in this camp." };

  const [hostRow] = await db
    .select({ hostMembershipId: attendee.hostMembershipId })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, hostMembershipId),
      ),
    )
    .limit(1);
  if (hostRow?.hostMembershipId) {
    return {
      ok: false,
      error: `${host.name} is already in someone else's party. Pick whoever anchors that household instead.`,
    };
  }

  const [{ n: hosting } = { n: 0 }] = await db
    .select({ n: count() })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.hostMembershipId, membershipId),
      ),
    );
  if (hosting > 0) {
    return {
      ok: false,
      error:
        "They have their own party. Move those people over first, then link them.",
    };
  }

  return { ok: true };
}

/**
 * Put a member into another member's party, or take them out of one (`host` =
 * NULL). The subject is identified by membership, not attendee id, because the
 * caller is picking a person off the roster; the row is created if they haven't
 * RSVP'd yet.
 *
 * **This is the write that grants authority** — a host is an officer scoped to
 * their party — so callers must have established that the actor is the subject
 * themselves, the subject's current host (removing someone), or a camp officer.
 * Anyone else wanting to host a member sends an invitation instead; see
 * `invitePartyMember`. This function does not check that, because the route
 * knows who is asking and this doesn't.
 *
 * Any pending invitation is cleared either way: the question has been answered
 * by other means, and leaving it would offer a "confirm" button for a link that
 * already exists.
 */
export async function setPartyHost(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  hostMembershipId: string | null;
}): Promise<PartyResult> {
  const { campId, editionId, membershipId, hostMembershipId } = opts;

  if (hostMembershipId) {
    const check = await checkPartyLink(
      campId,
      editionId,
      membershipId,
      hostMembershipId,
    );
    if (!check.ok) return check;
  }

  // Guests are accountless, so this only ever moves member rows.
  const attendeeId = await ensureMemberAttendee(
    campId,
    editionId,
    membershipId,
  );

  await db
    .update(attendee)
    .set({
      hostMembershipId,
      pendingHostMembershipId: null,
      updatedAt: new Date(),
    })
    .where(eq(attendee.id, attendeeId));
  return { ok: true };
}

/**
 * Offer to host a member: records the proposal on their row and grants nothing.
 *
 * This is the only route by which one member can involve *another* member's
 * account in a party, and it deliberately stops short of the link itself. The
 * invitation is inert — `party.ts` reads `host_membership_id` and never this —
 * so a griefer who invites the whole camp has published some noise and taken
 * nobody's tickets.
 *
 * Refuses if the subject already has a pending invitation from someone else,
 * rather than overwriting it: a silent overwrite would let a second inviter
 * displace the first, and the person answering would never know they'd been
 * asked twice. Both the subject (decline) and the inviter (withdraw) can clear
 * a stale one, so this cannot wedge.
 */
export async function invitePartyMember(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  hostMembershipId: string;
}): Promise<PartyResult> {
  const { campId, editionId, membershipId, hostMembershipId } = opts;

  const check = await checkPartyLink(
    campId,
    editionId,
    membershipId,
    hostMembershipId,
  );
  if (!check.ok) return check;

  const attendeeId = await ensureMemberAttendee(
    campId,
    editionId,
    membershipId,
  );
  const [row] = await db
    .select({
      hostMembershipId: attendee.hostMembershipId,
      pendingHostMembershipId: attendee.pendingHostMembershipId,
    })
    .from(attendee)
    .where(eq(attendee.id, attendeeId))
    .limit(1);

  if (row?.hostMembershipId) {
    return { ok: false, error: "They're already in someone's party." };
  }
  if (row?.pendingHostMembershipId === hostMembershipId) {
    return { ok: false, error: "You've already asked them." };
  }
  if (row?.pendingHostMembershipId) {
    return {
      ok: false,
      error:
        "Someone else has already asked them. They'll need to answer that first.",
    };
  }

  await db
    .update(attendee)
    .set({ pendingHostMembershipId: hostMembershipId, updatedAt: new Date() })
    .where(eq(attendee.id, attendeeId));
  return { ok: true };
}

/**
 * Say yes to an invitation — the moment the authority is actually granted.
 *
 * `expectedHostMembershipId` is what the person was shown when they clicked,
 * and it must still be what's on the row: an invitation that was withdrawn and
 * replaced between page load and click must not be accepted as if it were the
 * one they read. The link rules are re-checked here too, since the roster can
 * have changed underneath a days-old invitation.
 */
export async function acceptPartyInvite(opts: {
  campId: string;
  editionId: string;
  membershipId: string;
  expectedHostMembershipId: string;
}): Promise<PartyResult> {
  const { campId, editionId, membershipId, expectedHostMembershipId } = opts;

  const pending = await getPendingPartyHostOf(editionId, membershipId);
  if (!pending) {
    return { ok: false, error: "That invitation is no longer open." };
  }
  if (pending !== expectedHostMembershipId) {
    return {
      ok: false,
      error: "That invitation changed while you were looking at it. Reload.",
    };
  }

  return setPartyHost({
    campId,
    editionId,
    membershipId,
    hostMembershipId: pending,
  });
}

/**
 * Drop a pending invitation without linking anyone — the subject declining, the
 * inviter withdrawing, or an officer tidying up. All three are the same write;
 * who may perform it is the route's business.
 */
export async function clearPartyInvite(
  editionId: string,
  membershipId: string,
): Promise<void> {
  await db
    .update(attendee)
    .set({ pendingHostMembershipId: null, updatedAt: new Date() })
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    );
}

/** Who currently anchors this member's party, if anyone. */
export async function getPartyHostOf(
  editionId: string,
  membershipId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ hostMembershipId: attendee.hostMembershipId })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    )
    .limit(1);
  return row?.hostMembershipId ?? null;
}

/** Who has *asked* to anchor this member's party, if anyone. Grants nothing. */
export async function getPendingPartyHostOf(
  editionId: string,
  membershipId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ pendingHostMembershipId: attendee.pendingHostMembershipId })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    )
    .limit(1);
  return row?.pendingHostMembershipId ?? null;
}

export type PartyPerson = { membershipId: string; name: string };

/**
 * The viewer's open invitations, both directions.
 *
 * Scoped to one person on purpose rather than hung off `RosterMember`: an
 * unanswered "will you camp with me?" is between two people, and the roster
 * loader ships its member list to every browser in camp.
 */
export async function loadPartyInvites(
  editionId: string,
  membershipId: string,
): Promise<{ received: PartyPerson | null; sent: PartyPerson[] }> {
  const rows = await db
    .select({
      subjectMembershipId: attendee.membershipId,
      subjectName: user.name,
      pendingHostMembershipId: attendee.pendingHostMembershipId,
    })
    .from(attendee)
    .innerJoin(membership, eq(membership.id, attendee.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      and(
        eq(attendee.editionId, editionId),
        isNotNull(attendee.pendingHostMembershipId),
      ),
    );

  const sent: PartyPerson[] = [];
  let receivedFrom: string | null = null;
  for (const r of rows) {
    if (!r.subjectMembershipId) continue;
    if (r.pendingHostMembershipId === membershipId) {
      sent.push({ membershipId: r.subjectMembershipId, name: r.subjectName });
    }
    if (r.subjectMembershipId === membershipId) {
      receivedFrom = r.pendingHostMembershipId;
    }
  }
  sent.sort((a, b) => a.name.localeCompare(b.name));

  if (!receivedFrom) return { received: null, sent };
  const [inviter] = await db
    .select({ membershipId: membership.id, name: user.name })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.id, receivedFrom))
    .limit(1);
  return { received: inviter ?? null, sent };
}

/**
 * Members who could anchor a party, for a picker: everyone in the camp except
 * the subject and anyone already in someone else's party, since parties are one
 * level deep. Someone who already hosts guests IS a valid target — they're a
 * household root, which is exactly what's wanted.
 */
export async function listPartyHostCandidates(
  campId: string,
  editionId: string,
  membershipId: string,
): Promise<{ membershipId: string; name: string }[]> {
  const rows = await db
    .select({
      membershipId: membership.id,
      name: user.name,
      hostMembershipId: attendee.hostMembershipId,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .leftJoin(
      attendee,
      and(
        eq(attendee.membershipId, membership.id),
        eq(attendee.editionId, editionId),
      ),
    )
    .where(eq(membership.organizationId, campId));

  return rows
    .filter((r) => r.membershipId !== membershipId && !r.hostMembershipId)
    .map((r) => ({ membershipId: r.membershipId, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
