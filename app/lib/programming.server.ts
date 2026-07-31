/**
 * Programming — server-side loading + mutations (see
 * plans/programming-offerings.md). All helpers are camp+edition scoped;
 * callers gate role/lock/feature (route loaders/actions own authorization,
 * these own data shape).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  attendee,
  membership,
  offering,
  offeringPresenter,
  offeringSession,
  user,
} from "../../db/schema";
import { isHhMm, isIsoDate } from "./schedule";

/** Sanitize an HH:MM input ("" and garbage → null). */
export function cleanTime(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return isHhMm(s) ? s : null;
}

export type PresenterRow = {
  id: string;
  offeringId: string;
  attendeeId: string | null;
  /** Set only for an outside presenter who isn't camping with us. */
  name: string | null;
  role: string | null;
  /** Resolved through attendee: a member's account name, or a guest's name. */
  attendeeName: string | null;
};

/**
 * Presenters for a set of offerings, with camp-party names resolved.
 *
 * A presenter row is either an `attendeeId` (someone in our camp party) or a
 * bare `name` (an outside speaker). For the attendee case the display name
 * lives in one of two places — `user.name` when that attendee IS a member, or
 * `attendee.name` when they're a guest — so we coalesce in JS after two left
 * joins rather than trying to express it in SQL.
 */
async function loadPresenters(offeringIds: string[]): Promise<PresenterRow[]> {
  if (offeringIds.length === 0) return [];
  const rows = await db
    .select({
      id: offeringPresenter.id,
      offeringId: offeringPresenter.offeringId,
      attendeeId: offeringPresenter.attendeeId,
      name: offeringPresenter.name,
      role: offeringPresenter.role,
      guestName: attendee.name,
      memberName: user.name,
    })
    .from(offeringPresenter)
    .leftJoin(attendee, eq(attendee.id, offeringPresenter.attendeeId))
    .leftJoin(membership, eq(membership.id, attendee.membershipId))
    .leftJoin(user, eq(user.id, membership.userId))
    .where(inArray(offeringPresenter.offeringId, offeringIds))
    .orderBy(
      asc(offeringPresenter.sortOrder),
      asc(offeringPresenter.createdAt),
    );
  return rows.map((r) => ({
    id: r.id,
    offeringId: r.offeringId,
    attendeeId: r.attendeeId,
    name: r.name,
    role: r.role,
    attendeeName: r.memberName ?? r.guestName ?? null,
  }));
}

function groupBy<T extends { offeringId: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const list = map.get(r.offeringId) ?? [];
    list.push(r);
    map.set(r.offeringId, list);
  }
  return map;
}

/**
 * Every offering in the edition with its sessions and presenters. The caller
 * filters by status/audience for the surface it's rendering — this returns the
 * lot so the page can show the review queue and the lineup from one query set.
 */
export async function loadOfferings(editionId: string) {
  const offerings = await db
    .select()
    .from(offering)
    .where(eq(offering.editionId, editionId))
    .orderBy(asc(offering.createdAt));
  const ids = offerings.map((o) => o.id);

  const sessions = ids.length
    ? await db
        .select()
        .from(offeringSession)
        .where(inArray(offeringSession.offeringId, ids))
        .orderBy(asc(offeringSession.date), asc(offeringSession.startTime))
    : [];
  const presenters = await loadPresenters(ids);

  const sessionsBy = groupBy(sessions);
  const presentersBy = groupBy(presenters);

  return offerings.map((o) => {
    const mySessions = sessionsBy.get(o.id) ?? [];
    const scheduled = mySessions.filter((s) => s.status === "scheduled");
    return {
      ...o,
      sessions: mySessions,
      presenters: presentersBy.get(o.id) ?? [],
      /** Scheduling IS publishing — see the plan's Lifecycle section. */
      isPublished:
        o.status === "accepted" &&
        o.audience === "public" &&
        scheduled.length > 0,
      nextDate: scheduled[0]?.date ?? null,
    };
  });
}

/** One offering with its sessions + presenters, scoped to the edition. */
export async function loadOffering(offeringId: string, editionId: string) {
  const [o] = await db
    .select()
    .from(offering)
    .where(and(eq(offering.id, offeringId), eq(offering.editionId, editionId)))
    .limit(1);
  if (!o) return null;
  const sessions = await db
    .select()
    .from(offeringSession)
    .where(eq(offeringSession.offeringId, offeringId))
    .orderBy(asc(offeringSession.date), asc(offeringSession.startTime));
  return { offering: o, sessions, presenters: await loadPresenters([o.id]) };
}

export async function createOffering(opts: {
  campId: string;
  editionId: string;
  proposedByMembershipId: string;
  title: string;
  description: string | null;
  kind: string;
  durationMin: number | null;
  audience: string;
  capacity: number | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(offering).values({ id, ...opts });
  return id;
}

/**
 * The public lineup: accepted + public offerings that have at least one
 * session, flattened to one row per session and sorted by when it happens.
 * Cancelled sessions are kept (the page marks them) so a listed talk that got
 * pulled doesn't silently vanish on someone already planning around it.
 */
export async function loadPublicLineup(campId: string, editionId: string) {
  const rows = await db
    .select({
      sessionId: offeringSession.id,
      date: offeringSession.date,
      startTime: offeringSession.startTime,
      endTime: offeringSession.endTime,
      sessionLocation: offeringSession.location,
      sessionStatus: offeringSession.status,
      offeringId: offering.id,
      title: offering.title,
      description: offering.description,
      kind: offering.kind,
      durationMin: offering.durationMin,
      capacity: offering.capacity,
      location: offering.location,
    })
    .from(offeringSession)
    .innerJoin(offering, eq(offering.id, offeringSession.offeringId))
    .where(
      and(
        eq(offeringSession.campId, campId),
        eq(offeringSession.editionId, editionId),
        eq(offering.status, "accepted"),
        eq(offering.audience, "public"),
      ),
    )
    .orderBy(asc(offeringSession.date), asc(offeringSession.startTime));

  const presenters = await loadPresenters([
    ...new Set(rows.map((r) => r.offeringId)),
  ]);
  const presentersBy = groupBy(presenters);

  return rows.map((r) => ({
    ...r,
    location: r.sessionLocation ?? r.location,
    presenters: presentersBy.get(r.offeringId) ?? [],
  }));
}

/**
 * Every scheduled session for the year, for the camp's OWN day sheets — unlike
 * `loadPublicLineup` this does not filter on `audience`, because a camp-only
 * session still occupies the lecture hall and still belongs on the list posted
 * inside it. Each row carries `isPublic` so the board can mark the ones that
 * shouldn't go on the sign out front.
 */
export async function loadDaySheet(campId: string, editionId: string) {
  const rows = await db
    .select({
      sessionId: offeringSession.id,
      date: offeringSession.date,
      startTime: offeringSession.startTime,
      endTime: offeringSession.endTime,
      sessionLocation: offeringSession.location,
      sessionStatus: offeringSession.status,
      offeringId: offering.id,
      title: offering.title,
      description: offering.description,
      kind: offering.kind,
      durationMin: offering.durationMin,
      audience: offering.audience,
      location: offering.location,
    })
    .from(offeringSession)
    .innerJoin(offering, eq(offering.id, offeringSession.offeringId))
    .where(
      and(
        eq(offeringSession.campId, campId),
        eq(offeringSession.editionId, editionId),
        eq(offering.status, "accepted"),
      ),
    )
    .orderBy(asc(offeringSession.date), asc(offeringSession.startTime));

  const presenters = await loadPresenters([
    ...new Set(rows.map((r) => r.offeringId)),
  ]);
  const presentersBy = groupBy(presenters);

  return rows.map((r) => ({
    ...r,
    location: r.sessionLocation ?? r.location,
    isPublic: r.audience === "public",
    presenters: presentersBy.get(r.offeringId) ?? [],
  }));
}

/** Add a dated session to an offering. Returns null when the date is invalid. */
export async function addSession(opts: {
  campId: string;
  editionId: string;
  offeringId: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
}): Promise<string | null> {
  if (!isIsoDate(opts.date)) return null;
  const id = crypto.randomUUID();
  await db.insert(offeringSession).values({ id, ...opts });
  return id;
}

/**
 * Add a presenter. Either an attendee (someone in our camp party) or an
 * outside speaker's bare name — never both, and never neither.
 */
export async function addPresenter(opts: {
  campId: string;
  offeringId: string;
  attendeeId: string | null;
  name: string | null;
  role: string | null;
  sortOrder: number;
}): Promise<string | null> {
  if (!opts.attendeeId && !opts.name) return null;
  const id = crypto.randomUUID();
  await db.insert(offeringPresenter).values({
    id,
    campId: opts.campId,
    offeringId: opts.offeringId,
    // Belt-and-braces: an attendee presenter must not also carry a loose name,
    // or presenterName() would have two competing sources of truth.
    attendeeId: opts.attendeeId,
    name: opts.attendeeId ? null : opts.name,
    role: opts.role,
    sortOrder: opts.sortOrder,
  });
  return id;
}
