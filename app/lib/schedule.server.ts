/**
 * Schedule — server-side loading + mutations (see plans/events-scheduling.md).
 * All helpers are camp+edition scoped; callers gate role/lock/feature (route
 * loaders/actions own authorization, these own data shape).
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  gathering,
  gatheringOccurrence,
  gatheringShift,
  gatheringSignup,
  membership,
  user,
} from "../../db/schema";
import { isHhMm, isIsoDate } from "./schedule";

export type ShiftInput = {
  role: string | null;
  staffing: string;
  minNeeded: number | null;
  capacity: number | null;
  startTime: string | null;
  endTime: string | null;
};

const DEFAULT_SHIFT: ShiftInput = {
  role: null,
  staffing: "open",
  minNeeded: null,
  capacity: null,
  startTime: null,
  endTime: null,
};

/** Sanitize an HH:MM input ("" and garbage → null). */
export function cleanTime(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return isHhMm(s) ? s : null;
}

/** The edition's gatherings with occurrence counts + next upcoming date. */
export async function loadGatherings(editionId: string, todayIso: string) {
  const gatherings = await db
    .select()
    .from(gathering)
    .where(
      and(eq(gathering.editionId, editionId), eq(gathering.status, "active")),
    );
  const occ = await db
    .select({
      id: gatheringOccurrence.id,
      gatheringId: gatheringOccurrence.gatheringId,
      date: gatheringOccurrence.date,
      startTime: gatheringOccurrence.startTime,
      endTime: gatheringOccurrence.endTime,
      status: gatheringOccurrence.status,
    })
    .from(gatheringOccurrence)
    .where(eq(gatheringOccurrence.editionId, editionId))
    .orderBy(asc(gatheringOccurrence.date));
  const byGathering = new Map<string, typeof occ>();
  for (const o of occ) {
    const list = byGathering.get(o.gatheringId) ?? [];
    list.push(o);
    byGathering.set(o.gatheringId, list);
  }
  return gatherings
    .map((g) => {
      const all = byGathering.get(g.id) ?? [];
      const scheduled = all.filter((o) => o.status === "scheduled");
      const next =
        scheduled.find((o) => o.date >= todayIso) ??
        scheduled[scheduled.length - 1] ??
        null;
      return {
        id: g.id,
        title: g.title,
        kind: g.kind,
        location: g.location,
        description: g.description,
        occurrenceCount: scheduled.length,
        nextDate: next?.date ?? null,
        nextStartTime: next?.startTime ?? null,
        nextEndTime: next?.endTime ?? null,
      };
    })
    .sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999"));
}

/**
 * Create a gathering plus one occurrence per date, each with one starting
 * shift (the officer's staffing config — a plain camp meeting gets a default
 * open shift so sign-ups always have a shift to attach to).
 */
export async function createGathering(opts: {
  campId: string;
  editionId: string;
  createdById: string;
  title: string;
  description: string | null;
  kind: string;
  location: string | null;
  dates: string[];
  startTime: string | null;
  endTime: string | null;
  shift?: Partial<ShiftInput>;
  recurrenceRule?: string | null;
}): Promise<string> {
  const dates = [...new Set(opts.dates.filter(isIsoDate))].sort();
  if (dates.length === 0) throw new Error("No valid dates");
  const gatheringId = crypto.randomUUID();
  await db.insert(gathering).values({
    id: gatheringId,
    campId: opts.campId,
    editionId: opts.editionId,
    title: opts.title,
    description: opts.description,
    kind: opts.kind,
    location: opts.location,
    recurrenceRule: opts.recurrenceRule ?? null,
    createdById: opts.createdById,
  });
  const shift = { ...DEFAULT_SHIFT, ...(opts.shift ?? {}) };
  for (const date of dates) {
    const occurrenceId = crypto.randomUUID();
    await db.insert(gatheringOccurrence).values({
      id: occurrenceId,
      campId: opts.campId,
      editionId: opts.editionId,
      gatheringId,
      date,
      startTime: opts.startTime,
      endTime: opts.endTime,
    });
    await db.insert(gatheringShift).values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      occurrenceId,
      ...shift,
    });
  }
  return gatheringId;
}

/** Full detail: gathering + ordered occurrences, each with shifts and their
 * signups (names resolved). */
export async function loadGatheringDetail(
  gatheringId: string,
  editionId: string,
) {
  const [g] = await db
    .select()
    .from(gathering)
    .where(
      and(eq(gathering.id, gatheringId), eq(gathering.editionId, editionId)),
    )
    .limit(1);
  if (!g) return null;

  const occurrences = await db
    .select()
    .from(gatheringOccurrence)
    .where(eq(gatheringOccurrence.gatheringId, gatheringId))
    .orderBy(asc(gatheringOccurrence.date), asc(gatheringOccurrence.startTime));

  const occurrenceIds = occurrences.map((o) => o.id);
  const shifts = occurrenceIds.length
    ? await db
        .select()
        .from(gatheringShift)
        .where(inArray(gatheringShift.occurrenceId, occurrenceIds))
        .orderBy(asc(gatheringShift.sortOrder), asc(gatheringShift.createdAt))
    : [];

  const shiftIds = shifts.map((s) => s.id);
  const signups = shiftIds.length
    ? await db
        .select({
          id: gatheringSignup.id,
          shiftId: gatheringSignup.shiftId,
          membershipId: gatheringSignup.membershipId,
          status: gatheringSignup.status,
          attendance: gatheringSignup.attendance,
          origin: gatheringSignup.origin,
          note: gatheringSignup.note,
          playaName: membership.playaName,
          name: user.name,
        })
        .from(gatheringSignup)
        .innerJoin(membership, eq(membership.id, gatheringSignup.membershipId))
        .innerJoin(user, eq(user.id, membership.userId))
        .where(inArray(gatheringSignup.shiftId, shiftIds))
        .orderBy(asc(gatheringSignup.createdAt))
    : [];

  return { gathering: g, occurrences, shifts, signups };
}

/**
 * Occurrence-level agenda for the edition: every scheduled day with its
 * gathering info, shift staffing summary, and the viewer's own signup state.
 * Feeds the Agenda/Calendar/Mine views and the Overview card.
 */
export async function loadAgenda(editionId: string, membershipId: string) {
  const rows = await db
    .select({
      occurrenceId: gatheringOccurrence.id,
      date: gatheringOccurrence.date,
      startTime: gatheringOccurrence.startTime,
      endTime: gatheringOccurrence.endTime,
      occurrenceStatus: gatheringOccurrence.status,
      titleOverride: gatheringOccurrence.titleOverride,
      locationOverride: gatheringOccurrence.locationOverride,
      gatheringId: gathering.id,
      title: gathering.title,
      kind: gathering.kind,
      location: gathering.location,
    })
    .from(gatheringOccurrence)
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(gatheringOccurrence.editionId, editionId),
        eq(gathering.status, "active"),
      ),
    )
    .orderBy(asc(gatheringOccurrence.date), asc(gatheringOccurrence.startTime));

  const occurrenceIds = rows.map((r) => r.occurrenceId);
  const shifts = occurrenceIds.length
    ? await db
        .select({
          id: gatheringShift.id,
          occurrenceId: gatheringShift.occurrenceId,
          role: gatheringShift.role,
          staffing: gatheringShift.staffing,
          minNeeded: gatheringShift.minNeeded,
          capacity: gatheringShift.capacity,
        })
        .from(gatheringShift)
        .where(inArray(gatheringShift.occurrenceId, occurrenceIds))
    : [];
  const shiftIds = shifts.map((s) => s.id);
  const signups = shiftIds.length
    ? await db
        .select({
          shiftId: gatheringSignup.shiftId,
          membershipId: gatheringSignup.membershipId,
          status: gatheringSignup.status,
        })
        .from(gatheringSignup)
        .where(inArray(gatheringSignup.shiftId, shiftIds))
    : [];

  return rows.map((r) => {
    const myStatuses: string[] = [];
    let committed = 0;
    let needed = 0;
    for (const s of shifts) {
      if (s.occurrenceId !== r.occurrenceId) continue;
      for (const su of signups) {
        if (su.shiftId !== s.id) continue;
        if (su.status === "signed_up") committed++;
        if (su.membershipId === membershipId && su.status !== "cancelled") {
          myStatuses.push(su.status);
        }
      }
      if (s.staffing === "needed" && s.minNeeded != null) needed += s.minNeeded;
    }
    return {
      occurrenceId: r.occurrenceId,
      gatheringId: r.gatheringId,
      date: r.date,
      startTime: r.startTime,
      endTime: r.endTime,
      cancelled: r.occurrenceStatus === "cancelled",
      title: r.titleOverride ?? r.title,
      kind: r.kind,
      location: r.locationOverride ?? r.location,
      committed,
      needed,
      // The viewer's strongest involvement on this day.
      mine: myStatuses.includes("signed_up")
        ? "signed_up"
        : myStatuses.includes("waitlisted")
          ? "waitlisted"
          : myStatuses.includes("maybe")
            ? "maybe"
            : null,
    };
  });
}

/** Count of non-cancelled signups per shift (for capacity checks/labels). */
export async function signupCounts(
  shiftIds: string[],
): Promise<Map<string, number>> {
  if (shiftIds.length === 0) return new Map();
  const rows = await db
    .select({ shiftId: gatheringSignup.shiftId, value: count() })
    .from(gatheringSignup)
    .where(
      and(
        inArray(gatheringSignup.shiftId, shiftIds),
        inArray(gatheringSignup.status, ["signed_up", "maybe", "waitlisted"]),
      ),
    )
    .groupBy(gatheringSignup.shiftId);
  return new Map(rows.map((r) => [r.shiftId, r.value]));
}
