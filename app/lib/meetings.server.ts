/**
 * Camp meetings — server-side loading + mutations. Design:
 * plans/camp-meetings.md.
 *
 * A meeting is a `gathering` with `kind = "meeting"` plus its dated
 * `gathering_occurrence` rows, so most of what a meeting is already lives in
 * schedule.server.ts. This file owns only the parts a meeting has that a work
 * party doesn't: the camp's standing room link, the open agenda, and the
 * summary + who has read it.
 *
 * Everything here is camp/edition scoped; route loaders and actions own
 * authorization (role, lock, feature), these own data shape.
 */
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  campMeetingRoom,
  gathering,
  gatheringOccurrence,
  gatheringShift,
  gatheringSignup,
  meetingAgendaItem,
  meetingSummary,
  meetingSummaryRead,
  membership,
  user,
} from "../../db/schema";
import { MEETING_KIND } from "./meetings";

/* ------------------------------------------------------------------- room */

export type MeetingRoom = typeof campMeetingRoom.$inferSelect;

export async function getMeetingRoom(
  campId: string,
): Promise<MeetingRoom | null> {
  const [row] = await db
    .select()
    .from(campMeetingRoom)
    .where(eq(campMeetingRoom.campId, campId))
    .limit(1);
  return row ?? null;
}

export async function setMeetingRoom(opts: {
  campId: string;
  url: string;
  label: string | null;
  note: string | null;
  updatedByMembershipId: string;
}): Promise<void> {
  await db
    .insert(campMeetingRoom)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      url: opts.url,
      label: opts.label,
      note: opts.note,
      updatedByMembershipId: opts.updatedByMembershipId,
    })
    .onConflictDoUpdate({
      target: [campMeetingRoom.campId],
      set: {
        url: opts.url,
        label: opts.label,
        note: opts.note,
        updatedByMembershipId: opts.updatedByMembershipId,
        updatedAt: new Date(),
      },
    });
}

export async function clearMeetingRoom(campId: string): Promise<void> {
  await db.delete(campMeetingRoom).where(eq(campMeetingRoom.campId, campId));
}

/* --------------------------------------------------------------- meetings */

/** One meeting in the list: an occurrence of a `kind="meeting"` gathering. */
export type MeetingRow = {
  occurrenceId: string;
  gatheringId: string;
  title: string;
  description: string | null;
  location: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  cancelled: boolean;
  agendaCount: number;
  /** The viewer's RSVP: signed_up | maybe | waitlisted, or null. */
  mine: string | null;
  comingCount: number;
  /** Present only once a summary exists AND the viewer may see it. */
  summary: { id: string; published: boolean; readByMe: boolean } | null;
};

/**
 * Every meeting in the year, newest schedule order, with agenda counts, the
 * viewer's RSVP, and summary state. Drafts are folded in for officers only —
 * for everyone else an unpublished summary does not exist.
 */
export async function loadMeetings(opts: {
  editionId: string;
  membershipId: string;
  isOfficer: boolean;
}): Promise<MeetingRow[]> {
  const rows = await db
    .select({
      occurrenceId: gatheringOccurrence.id,
      gatheringId: gathering.id,
      title: gathering.title,
      titleOverride: gatheringOccurrence.titleOverride,
      description: gathering.description,
      location: gathering.location,
      locationOverride: gatheringOccurrence.locationOverride,
      date: gatheringOccurrence.date,
      startTime: gatheringOccurrence.startTime,
      endTime: gatheringOccurrence.endTime,
      status: gatheringOccurrence.status,
    })
    .from(gatheringOccurrence)
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(gatheringOccurrence.editionId, opts.editionId),
        eq(gathering.kind, MEETING_KIND),
        eq(gathering.status, "active"),
      ),
    )
    .orderBy(asc(gatheringOccurrence.date), asc(gatheringOccurrence.startTime));

  const ids = rows.map((r) => r.occurrenceId);
  if (ids.length === 0) return [];

  const [agenda, summaries, attendance] = await Promise.all([
    db
      .select({ occurrenceId: meetingAgendaItem.occurrenceId })
      .from(meetingAgendaItem)
      .where(inArray(meetingAgendaItem.occurrenceId, ids)),
    db
      .select({
        id: meetingSummary.id,
        occurrenceId: meetingSummary.occurrenceId,
        publishedAt: meetingSummary.publishedAt,
      })
      .from(meetingSummary)
      .where(inArray(meetingSummary.occurrenceId, ids)),
    signupsForOccurrences(ids),
  ]);

  const summaryIds = summaries.map((s) => s.id);
  const readMine = summaryIds.length
    ? new Set(
        (
          await db
            .select({ summaryId: meetingSummaryRead.summaryId })
            .from(meetingSummaryRead)
            .where(
              and(
                inArray(meetingSummaryRead.summaryId, summaryIds),
                eq(meetingSummaryRead.membershipId, opts.membershipId),
              ),
            )
        ).map((r) => r.summaryId),
      )
    : new Set<string>();

  const agendaCounts = new Map<string, number>();
  for (const a of agenda) {
    agendaCounts.set(
      a.occurrenceId,
      (agendaCounts.get(a.occurrenceId) ?? 0) + 1,
    );
  }
  const summaryByOccurrence = new Map(
    summaries.map((s) => [s.occurrenceId, s]),
  );

  return rows.map((r) => {
    const s = summaryByOccurrence.get(r.occurrenceId);
    const visible = s && (s.publishedAt != null || opts.isOfficer);
    const rsvp = attendance.get(r.occurrenceId);
    return {
      occurrenceId: r.occurrenceId,
      gatheringId: r.gatheringId,
      title: r.titleOverride ?? r.title,
      description: r.description,
      location: r.locationOverride ?? r.location,
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      cancelled: r.status === "cancelled",
      agendaCount: agendaCounts.get(r.occurrenceId) ?? 0,
      mine: rsvp?.mine.get(opts.membershipId) ?? null,
      comingCount: rsvp?.coming ?? 0,
      summary:
        visible && s
          ? {
              id: s.id,
              published: s.publishedAt != null,
              readByMe: readMine.has(s.id),
            }
          : null,
    };
  });
}

/** Per-occurrence RSVP rollup: how many are coming, and each member's status. */
async function signupsForOccurrences(
  occurrenceIds: string[],
): Promise<Map<string, { coming: number; mine: Map<string, string> }>> {
  const out = new Map<string, { coming: number; mine: Map<string, string> }>();
  if (occurrenceIds.length === 0) return out;
  const rows = await db
    .select({
      occurrenceId: gatheringShift.occurrenceId,
      membershipId: gatheringSignup.membershipId,
      status: gatheringSignup.status,
    })
    .from(gatheringSignup)
    .innerJoin(gatheringShift, eq(gatheringShift.id, gatheringSignup.shiftId))
    .where(inArray(gatheringShift.occurrenceId, occurrenceIds));
  for (const r of rows) {
    if (r.status === "cancelled") continue;
    const entry = out.get(r.occurrenceId) ?? { coming: 0, mine: new Map() };
    if (r.status === "signed_up") entry.coming++;
    // A member could in principle be on two shifts of one meeting; "I'll be
    // there" outranks "maybe".
    const held = entry.mine.get(r.membershipId);
    if (!held || (held !== "signed_up" && r.status === "signed_up")) {
      entry.mine.set(r.membershipId, r.status);
    }
    out.set(r.occurrenceId, entry);
  }
  return out;
}

/**
 * Everything one meeting page needs. Returns null when the occurrence isn't a
 * meeting in this edition — which is also the cross-camp/cross-year guard.
 */
export async function loadMeetingDetail(opts: {
  occurrenceId: string;
  editionId: string;
  membershipId: string;
  isOfficer: boolean;
}) {
  const [row] = await db
    .select({
      occurrenceId: gatheringOccurrence.id,
      gatheringId: gathering.id,
      campId: gathering.campId,
      title: gathering.title,
      titleOverride: gatheringOccurrence.titleOverride,
      description: gathering.description,
      location: gathering.location,
      locationOverride: gatheringOccurrence.locationOverride,
      date: gatheringOccurrence.date,
      startTime: gatheringOccurrence.startTime,
      endTime: gatheringOccurrence.endTime,
      status: gatheringOccurrence.status,
      note: gatheringOccurrence.note,
      recurrenceRule: gathering.recurrenceRule,
    })
    .from(gatheringOccurrence)
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(gatheringOccurrence.id, opts.occurrenceId),
        eq(gatheringOccurrence.editionId, opts.editionId),
        eq(gathering.kind, MEETING_KIND),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [agenda, summary, attendees] = await Promise.all([
    loadAgenda(opts.occurrenceId),
    loadSummary(opts.occurrenceId, opts.membershipId),
    loadAttendees(opts.occurrenceId),
  ]);

  return {
    meeting: {
      occurrenceId: row.occurrenceId,
      gatheringId: row.gatheringId,
      title: row.titleOverride ?? row.title,
      description: row.description,
      location: row.locationOverride ?? row.location,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      cancelled: row.status === "cancelled",
      note: row.note,
      repeats: row.recurrenceRule != null,
    },
    agenda,
    // A draft is officer-only; hide it entirely rather than showing an empty
    // shell that hints something is being written about them.
    summary:
      summary && (summary.publishedAt != null || opts.isOfficer)
        ? summary
        : null,
    attendees,
  };
}

/* --------------------------------------------------------------- agenda */

export type AgendaItemRow = {
  id: string;
  title: string;
  body: string | null;
  addedByMembershipId: string | null;
  addedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Submission order — the agenda is a flat list by design (see the plan). */
export async function loadAgenda(
  occurrenceId: string,
): Promise<AgendaItemRow[]> {
  const rows = await db
    .select({
      id: meetingAgendaItem.id,
      title: meetingAgendaItem.title,
      body: meetingAgendaItem.body,
      addedByMembershipId: meetingAgendaItem.addedByMembershipId,
      playaName: membership.playaName,
      name: user.name,
      createdAt: meetingAgendaItem.createdAt,
      updatedAt: meetingAgendaItem.updatedAt,
    })
    .from(meetingAgendaItem)
    .leftJoin(
      membership,
      eq(membership.id, meetingAgendaItem.addedByMembershipId),
    )
    .leftJoin(user, eq(user.id, membership.userId))
    .where(eq(meetingAgendaItem.occurrenceId, occurrenceId))
    .orderBy(asc(meetingAgendaItem.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    addedByMembershipId: r.addedByMembershipId,
    addedBy: r.playaName || r.name || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function addAgendaItem(opts: {
  campId: string;
  editionId: string;
  occurrenceId: string;
  membershipId: string;
  title: string;
  body: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(meetingAgendaItem).values({
    id,
    campId: opts.campId,
    editionId: opts.editionId,
    occurrenceId: opts.occurrenceId,
    title: opts.title,
    body: opts.body,
    addedByMembershipId: opts.membershipId,
  });
  return id;
}

/** Load an item, scoped to the camp — the ownership check's input. */
export async function getAgendaItem(campId: string, id: string) {
  const [row] = await db
    .select()
    .from(meetingAgendaItem)
    .where(
      and(eq(meetingAgendaItem.id, id), eq(meetingAgendaItem.campId, campId)),
    )
    .limit(1);
  return row ?? null;
}

export async function updateAgendaItem(opts: {
  id: string;
  title: string;
  body: string | null;
}): Promise<void> {
  await db
    .update(meetingAgendaItem)
    .set({ title: opts.title, body: opts.body, updatedAt: new Date() })
    .where(eq(meetingAgendaItem.id, opts.id));
}

export async function deleteAgendaItem(id: string): Promise<void> {
  await db.delete(meetingAgendaItem).where(eq(meetingAgendaItem.id, id));
}

/* -------------------------------------------------------------- summary */

export type SummaryRow = {
  id: string;
  body: string;
  publishedAt: Date | null;
  author: string | null;
  updatedAt: Date;
  readByMe: boolean;
  readCount: number;
};

export async function loadSummary(
  occurrenceId: string,
  membershipId: string,
): Promise<SummaryRow | null> {
  const [row] = await db
    .select({
      id: meetingSummary.id,
      body: meetingSummary.body,
      publishedAt: meetingSummary.publishedAt,
      updatedAt: meetingSummary.updatedAt,
      playaName: membership.playaName,
      name: user.name,
    })
    .from(meetingSummary)
    .leftJoin(membership, eq(membership.id, meetingSummary.authorMembershipId))
    .leftJoin(user, eq(user.id, membership.userId))
    .where(eq(meetingSummary.occurrenceId, occurrenceId))
    .limit(1);
  if (!row) return null;
  const reads = await db
    .select({ membershipId: meetingSummaryRead.membershipId })
    .from(meetingSummaryRead)
    .where(eq(meetingSummaryRead.summaryId, row.id));
  return {
    id: row.id,
    body: row.body,
    publishedAt: row.publishedAt,
    author: row.playaName || row.name || null,
    updatedAt: row.updatedAt,
    readByMe: reads.some((r) => r.membershipId === membershipId),
    readCount: reads.length,
  };
}

/**
 * Write or rewrite the summary. `publish` null leaves the published state
 * alone, so editing a published summary doesn't silently unpublish it and
 * saving a draft doesn't accidentally distribute it.
 */
export async function saveSummary(opts: {
  campId: string;
  editionId: string;
  occurrenceId: string;
  authorMembershipId: string;
  body: string;
  publish: boolean | null;
}): Promise<void> {
  const existing = await db
    .select({ id: meetingSummary.id, publishedAt: meetingSummary.publishedAt })
    .from(meetingSummary)
    .where(eq(meetingSummary.occurrenceId, opts.occurrenceId))
    .limit(1);
  const current = existing[0];
  const publishedAt =
    opts.publish === null
      ? (current?.publishedAt ?? null)
      : opts.publish
        ? (current?.publishedAt ?? new Date())
        : null;
  if (current) {
    await db
      .update(meetingSummary)
      .set({
        body: opts.body,
        publishedAt,
        authorMembershipId: opts.authorMembershipId,
        updatedAt: new Date(),
      })
      .where(eq(meetingSummary.id, current.id));
    return;
  }
  await db.insert(meetingSummary).values({
    id: crypto.randomUUID(),
    campId: opts.campId,
    editionId: opts.editionId,
    occurrenceId: opts.occurrenceId,
    body: opts.body,
    authorMembershipId: opts.authorMembershipId,
    publishedAt,
  });
}

export async function setSummaryPublished(opts: {
  campId: string;
  occurrenceId: string;
  published: boolean;
}): Promise<void> {
  await db
    .update(meetingSummary)
    .set({
      publishedAt: opts.published ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(meetingSummary.occurrenceId, opts.occurrenceId),
        eq(meetingSummary.campId, opts.campId),
      ),
    );
}

export async function deleteSummary(
  campId: string,
  occurrenceId: string,
): Promise<void> {
  await db
    .delete(meetingSummary)
    .where(
      and(
        eq(meetingSummary.occurrenceId, occurrenceId),
        eq(meetingSummary.campId, campId),
      ),
    );
}

/** Idempotent — "mark read" twice is not an error. */
export async function markSummaryRead(opts: {
  campId: string;
  summaryId: string;
  membershipId: string;
}): Promise<void> {
  await db
    .insert(meetingSummaryRead)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      summaryId: opts.summaryId,
      membershipId: opts.membershipId,
    })
    .onConflictDoNothing();
}

/* ------------------------------------------------------------ RSVP + home */

export type AttendeeRow = {
  membershipId: string;
  name: string;
  status: string;
  attendance: string;
};

async function loadAttendees(occurrenceId: string): Promise<AttendeeRow[]> {
  const rows = await db
    .select({
      membershipId: gatheringSignup.membershipId,
      status: gatheringSignup.status,
      attendance: gatheringSignup.attendance,
      playaName: membership.playaName,
      name: user.name,
    })
    .from(gatheringSignup)
    .innerJoin(gatheringShift, eq(gatheringShift.id, gatheringSignup.shiftId))
    .innerJoin(membership, eq(membership.id, gatheringSignup.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(gatheringShift.occurrenceId, occurrenceId))
    .orderBy(asc(gatheringSignup.createdAt));
  return rows
    .filter((r) => r.status !== "cancelled")
    .map((r) => ({
      membershipId: r.membershipId,
      name: r.playaName || r.name,
      status: r.status,
      attendance: r.attendance,
    }));
}

/**
 * The shift an RSVP attaches to. Every occurrence is created with at least one
 * (schedule.server.ts guarantees it), but a meeting whose only shift was
 * deleted would otherwise have nowhere to put an RSVP — so make one.
 */
export async function rsvpShiftFor(opts: {
  campId: string;
  editionId: string;
  occurrenceId: string;
}): Promise<string> {
  const [existing] = await db
    .select({ id: gatheringShift.id })
    .from(gatheringShift)
    .where(eq(gatheringShift.occurrenceId, opts.occurrenceId))
    .orderBy(asc(gatheringShift.sortOrder), asc(gatheringShift.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.insert(gatheringShift).values({
    id,
    campId: opts.campId,
    editionId: opts.editionId,
    occurrenceId: opts.occurrenceId,
    role: null,
    staffing: "all_hands",
  });
  return id;
}

/** Set (or clear) the viewer's RSVP on a meeting. Meetings never waitlist. */
export async function setRsvp(opts: {
  campId: string;
  editionId: string;
  occurrenceId: string;
  membershipId: string;
  status: "signed_up" | "maybe" | "cancelled";
}): Promise<void> {
  const shiftId = await rsvpShiftFor({
    campId: opts.campId,
    editionId: opts.editionId,
    occurrenceId: opts.occurrenceId,
  });
  await db
    .insert(gatheringSignup)
    .values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      shiftId,
      membershipId: opts.membershipId,
      status: opts.status,
      origin: "self",
    })
    .onConflictDoUpdate({
      target: [gatheringSignup.shiftId, gatheringSignup.membershipId],
      set: { status: opts.status, updatedAt: new Date() },
    });
}

/**
 * How many published summaries this member hasn't opened — the nav badge. One
 * query, and it's the only thing standing between a write-up and being missed,
 * so everyone pays for it (unlike the officer-only FAQ/prospect badges).
 */
export async function countUnreadSummaries(opts: {
  editionId: string;
  membershipId: string;
}): Promise<number> {
  const published = await db
    .select({ id: meetingSummary.id })
    .from(meetingSummary)
    .where(
      and(
        eq(meetingSummary.editionId, opts.editionId),
        isNotNull(meetingSummary.publishedAt),
      ),
    );
  if (published.length === 0) return 0;
  const read = await db
    .select({ summaryId: meetingSummaryRead.summaryId })
    .from(meetingSummaryRead)
    .where(
      and(
        inArray(
          meetingSummaryRead.summaryId,
          published.map((p) => p.id),
        ),
        eq(meetingSummaryRead.membershipId, opts.membershipId),
      ),
    );
  return published.length - read.length;
}

/**
 * The Overview card's data: the next meeting (or today's), and any published
 * summaries the viewer hasn't read yet. Cheap enough to run on every home load.
 */
export async function meetingsHomeCard(opts: {
  editionId: string;
  membershipId: string;
  todayIso: string;
}): Promise<{
  next: {
    occurrenceId: string;
    title: string;
    date: string;
    startTime: string | null;
    endTime: string | null;
    location: string | null;
    mine: string | null;
    agendaCount: number;
  } | null;
  unread: { occurrenceId: string; title: string; date: string }[];
}> {
  const upcoming = await db
    .select({
      occurrenceId: gatheringOccurrence.id,
      title: gathering.title,
      titleOverride: gatheringOccurrence.titleOverride,
      location: gathering.location,
      locationOverride: gatheringOccurrence.locationOverride,
      date: gatheringOccurrence.date,
      startTime: gatheringOccurrence.startTime,
      endTime: gatheringOccurrence.endTime,
    })
    .from(gatheringOccurrence)
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(gatheringOccurrence.editionId, opts.editionId),
        eq(gathering.kind, MEETING_KIND),
        eq(gathering.status, "active"),
        eq(gatheringOccurrence.status, "scheduled"),
      ),
    )
    .orderBy(asc(gatheringOccurrence.date), asc(gatheringOccurrence.startTime));

  const nextRow = upcoming.find((r) => r.date >= opts.todayIso) ?? null;
  let next: Awaited<ReturnType<typeof meetingsHomeCard>>["next"] = null;
  if (nextRow) {
    const [rsvp, agenda] = await Promise.all([
      signupsForOccurrences([nextRow.occurrenceId]),
      db
        .select({ id: meetingAgendaItem.id })
        .from(meetingAgendaItem)
        .where(eq(meetingAgendaItem.occurrenceId, nextRow.occurrenceId)),
    ]);
    next = {
      occurrenceId: nextRow.occurrenceId,
      title: nextRow.titleOverride ?? nextRow.title,
      date: nextRow.date,
      startTime: nextRow.startTime,
      endTime: nextRow.endTime,
      location: nextRow.locationOverride ?? nextRow.location,
      mine: rsvp.get(nextRow.occurrenceId)?.mine.get(opts.membershipId) ?? null,
      agendaCount: agenda.length,
    };
  }

  // Published summaries this member hasn't opened — the whole point of
  // "distributing" without a mailer.
  const published = await db
    .select({
      summaryId: meetingSummary.id,
      occurrenceId: meetingSummary.occurrenceId,
      date: gatheringOccurrence.date,
      title: gathering.title,
      titleOverride: gatheringOccurrence.titleOverride,
    })
    .from(meetingSummary)
    .innerJoin(
      gatheringOccurrence,
      eq(gatheringOccurrence.id, meetingSummary.occurrenceId),
    )
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(meetingSummary.editionId, opts.editionId),
        isNotNull(meetingSummary.publishedAt),
      ),
    )
    .orderBy(desc(meetingSummary.publishedAt));

  if (published.length === 0) return { next, unread: [] };
  const read = new Set(
    (
      await db
        .select({ summaryId: meetingSummaryRead.summaryId })
        .from(meetingSummaryRead)
        .where(
          and(
            inArray(
              meetingSummaryRead.summaryId,
              published.map((p) => p.summaryId),
            ),
            eq(meetingSummaryRead.membershipId, opts.membershipId),
          ),
        )
    ).map((r) => r.summaryId),
  );
  return {
    next,
    unread: published
      .filter((p) => !read.has(p.summaryId))
      .slice(0, 3)
      .map((p) => ({
        occurrenceId: p.occurrenceId,
        title: p.titleOverride ?? p.title,
        date: p.date,
      })),
  };
}
