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
import {
  MAX_TEMPLATE_ROLES,
  STAFFING_OPTIONS,
  isHhMm,
  isIsoDate,
} from "./schedule";

export type ShiftInput = {
  role: string | null;
  staffing: string;
  minNeeded: number | null;
  capacity: number | null;
  startTime: string | null;
  endTime: string | null;
  note?: string | null;
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

/**
 * Read a repeated-field role template out of a form. The role builder posts
 * parallel arrays (`shiftRole`, `shiftStaffing`, …), one entry per row, so the
 * same parser serves the create form and the "apply to every day" tool.
 * Rows with a blank role are dropped — an unnamed role in a multi-role template
 * is a half-filled row, not a meaningful "General" shift.
 */
export function parseShiftTemplate(form: FormData): ShiftInput[] {
  const roles = form.getAll("shiftRole").map((v) => String(v).trim());
  const staffings = form.getAll("shiftStaffing").map((v) => String(v));
  const counts = form.getAll("shiftCount").map((v) => String(v));
  const starts = form.getAll("shiftStart");
  const ends = form.getAll("shiftEnd");
  const notes = form.getAll("shiftNote").map((v) => String(v).trim());
  const out: ShiftInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < roles.length && out.length < MAX_TEMPLATE_ROLES; i++) {
    const role = roles[i] ?? "";
    if (!role || role.length > 80) continue;
    // Two rows with the same role would fight over the idempotency key.
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const staffing = STAFFING_OPTIONS.some((s) => s.value === staffings[i])
      ? String(staffings[i])
      : "open";
    const n = Number(counts[i]);
    const wanted =
      staffing === "needed" && Number.isInteger(n) && n > 0 ? n : null;
    out.push({
      role,
      staffing,
      minNeeded: wanted,
      capacity: wanted,
      startTime: cleanTime(starts[i]),
      endTime: cleanTime(ends[i]),
      note: notes[i] || null,
    });
  }
  return out;
}

/**
 * Does this year have anything scheduled at all? Feeds the "don't show members
 * an empty section" rule: the Schedule nav entry appeared the moment the
 * feature was switched on, so a camper went looking for a programme that didn't
 * exist yet. Officers still see it — they're the ones who have to fill it.
 */
export async function hasScheduledDays(editionId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: count() })
    .from(gatheringOccurrence)
    .innerJoin(gathering, eq(gathering.id, gatheringOccurrence.gatheringId))
    .where(
      and(
        eq(gatheringOccurrence.editionId, editionId),
        eq(gatheringOccurrence.status, "scheduled"),
        eq(gathering.status, "active"),
      ),
    );
  return (row?.value ?? 0) > 0;
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
  /** One shift on every occurrence (the simple case). */
  shift?: Partial<ShiftInput>;
  /** A role template stamped onto every occurrence; wins over `shift`. */
  shifts?: ShiftInput[];
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
  // `shifts` (a role template) wins over the legacy single `shift`; either way
  // every occurrence ends up with at least one shift so sign-ups have a target.
  const template: ShiftInput[] =
    opts.shifts && opts.shifts.length > 0
      ? opts.shifts
      : [{ ...DEFAULT_SHIFT, ...(opts.shift ?? {}) }];
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
    await insertShifts({
      campId: opts.campId,
      editionId: opts.editionId,
      occurrenceId,
      shifts: template,
      startIndex: 0,
    });
  }
  return gatheringId;
}

/** Insert a run of shifts onto one occurrence, numbering `sortOrder` from
 * `startIndex` so a template keeps its authored order (freezer pull, slicers,
 * servers, cleanup) instead of sorting by creation timestamp. */
async function insertShifts(opts: {
  campId: string;
  editionId: string;
  occurrenceId: string;
  shifts: ShiftInput[];
  startIndex: number;
}): Promise<number> {
  let i = opts.startIndex;
  for (const s of opts.shifts) {
    await db.insert(gatheringShift).values({
      id: crypto.randomUUID(),
      campId: opts.campId,
      editionId: opts.editionId,
      occurrenceId: opts.occurrenceId,
      role: s.role,
      staffing: s.staffing,
      minNeeded: s.minNeeded,
      capacity: s.capacity,
      startTime: s.startTime,
      endTime: s.endTime,
      note: s.note ?? null,
      sortOrder: i,
    });
    i++;
  }
  return i;
}

/** Roles compare case- and whitespace-insensitively; the unnamed default shift
 * is its own key so a template never collides with it by accident. */
function roleKey(role: string | null): string {
  return (role ?? "").trim().toLowerCase();
}

/**
 * Stamp a set of roles across every day of a gathering at once — the thing that
 * made a nine-day, four-role pie service impossible to set up by hand (36
 * separate form submits). Idempotent per role: a day that already has a shift
 * with that role is left alone, so re-applying a template after adding a day
 * only fills the gap.
 *
 * The blank auto-created "General" shift is swept away on days where the
 * template lands, but ONLY when nobody signed up for it — a sign-up is somebody
 * saying they'll be there, and this is a convenience, not a reason to lose it.
 */
export async function applyShiftTemplate(opts: {
  campId: string;
  editionId: string;
  gatheringId: string;
  shifts: ShiftInput[];
  /** Limit to a date range (inclusive); omit for every scheduled day. */
  fromDate?: string | null;
  toDate?: string | null;
}): Promise<{ days: number; created: number; skipped: number }> {
  if (opts.shifts.length === 0) return { days: 0, created: 0, skipped: 0 };
  const occurrences = await db
    .select({
      id: gatheringOccurrence.id,
      date: gatheringOccurrence.date,
      status: gatheringOccurrence.status,
    })
    .from(gatheringOccurrence)
    .where(eq(gatheringOccurrence.gatheringId, opts.gatheringId))
    .orderBy(asc(gatheringOccurrence.date));

  const targets = occurrences.filter(
    (o) =>
      o.status === "scheduled" &&
      (!opts.fromDate || o.date >= opts.fromDate) &&
      (!opts.toDate || o.date <= opts.toDate),
  );
  if (targets.length === 0) return { days: 0, created: 0, skipped: 0 };

  const existing = await db
    .select({
      id: gatheringShift.id,
      occurrenceId: gatheringShift.occurrenceId,
      role: gatheringShift.role,
      sortOrder: gatheringShift.sortOrder,
    })
    .from(gatheringShift)
    .where(
      inArray(
        gatheringShift.occurrenceId,
        targets.map((o) => o.id),
      ),
    );
  const signedUp = new Set(
    existing.length
      ? (
          await db
            .select({ shiftId: gatheringSignup.shiftId })
            .from(gatheringSignup)
            .where(
              inArray(
                gatheringSignup.shiftId,
                existing.map((s) => s.id),
              ),
            )
        ).map((r) => r.shiftId)
      : [],
  );

  let created = 0;
  let skipped = 0;
  for (const occ of targets) {
    const here = existing.filter((s) => s.occurrenceId === occ.id);
    const taken = new Set(here.map((s) => roleKey(s.role)));
    const fresh = opts.shifts.filter((s) => !taken.has(roleKey(s.role)));
    skipped += opts.shifts.length - fresh.length;
    if (fresh.length === 0) continue;
    const next = here.reduce((max, s) => Math.max(max, s.sortOrder + 1), 0);
    await insertShifts({
      campId: opts.campId,
      editionId: opts.editionId,
      occurrenceId: occ.id,
      shifts: fresh,
      startIndex: next,
    });
    created += fresh.length;
    // Retire the empty placeholder now that real roles exist on this day.
    const placeholders = here.filter(
      (s) => roleKey(s.role) === "" && !signedUp.has(s.id),
    );
    for (const p of placeholders) {
      await db.delete(gatheringShift).where(eq(gatheringShift.id, p.id));
    }
  }
  return { days: targets.length, created, skipped };
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
