/**
 * Loads the data the ask predicates in `asks.ts` read.
 *
 * **Batched by camp, never by member.** One query per underlying concern,
 * grouped by membership, assembled into a `Map<membershipId, AskSnapshot>`. The
 * single-member case is `.get(mid)`. Same reasoning as `party-map.server.ts`:
 * one code path means a camper's own to-do list and the officer roll-up can't
 * disagree about what's outstanding, and the per-member view can't quietly
 * become N×15 queries the first time someone adds an officer page.
 *
 * A camp is a few hundred people at most, and every query here is a count or a
 * narrow projection over one edition.
 */
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  account,
  attendee,
  campQuestion,
  contributionTier,
  financeEntry,
  fuelDeclaration,
  mapObject,
  mapObjectOccupant,
  memberRequirement,
  membership,
  onboardingCompletion,
  onboardingTask,
  questionAnswer,
  setupPass,
  ticket,
  ticketRequest,
  user,
  wizardAsk,
} from "../../db/schema";
import type { AskSnapshot } from "./asks";
import { audienceForRole } from "./asks";
import { setupPassWindowFor } from "./brc";
import { hasTag } from "./structures";

/** Zero-value snapshot for a member we have no rows for at all. */
function emptySnapshot(role: string): AskSnapshot {
  return {
    role,
    hasName: false,
    hasPlayaName: false,
    rsvp: "unknown",
    hasArrivalDate: false,
    hasDepartureDate: false,
    needsSetupPass: false,
    unansweredRequiredQuestions: 0,
    bringingCount: 0,
    unplacedCount: 0,
    domicilesWithoutOccupants: 0,
    checklistRemaining: 0,
    hasTicket: false,
    ticketRequested: false,
    ticketsAwaitingPurchase: 0,
    hasSetupPassRow: false,
    fuelDeclared: false,
    duesOwedCents: 0,
    discordLinked: false,
    dismissed: {},
    acknowledged: {},
  };
}

const bump = <K extends keyof AskSnapshot>(
  m: Map<string, AskSnapshot>,
  id: string | null,
  key: K,
  value: AskSnapshot[K],
) => {
  if (!id) return;
  const s = m.get(id);
  if (s) s[key] = value;
};

export async function loadAskSnapshots(
  campId: string,
  editionId: string,
  year: number,
): Promise<Map<string, AskSnapshot>> {
  // Seed from the roster so every member gets a row even with no data anywhere
  // — a brand-new camper who has done nothing is exactly who this is for.
  const members = await db
    .select({
      membershipId: membership.id,
      role: membership.role,
      playaName: membership.playaName,
      userId: membership.userId,
      userName: user.name,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));

  const snaps = new Map<string, AskSnapshot>();
  const userToMembership = new Map<string, string>();
  for (const m of members) {
    const s = emptySnapshot(m.role);
    s.hasName = (m.userName ?? "").trim().length > 0;
    s.hasPlayaName = (m.playaName ?? "").trim().length > 0;
    snaps.set(m.membershipId, s);
    userToMembership.set(m.userId, m.membershipId);
  }

  // — attendance —
  const gateOpen = setupPassWindowFor(year).max;
  const attendees = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      status: attendee.status,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
    })
    .from(attendee)
    .where(
      and(eq(attendee.editionId, editionId), isNotNull(attendee.membershipId)),
    );
  /** attendee.id → membershipId, for the tables that key off an attendee. */
  const attendeeToMembership = new Map<string, string>();
  for (const a of attendees) {
    if (!a.membershipId) continue;
    attendeeToMembership.set(a.id, a.membershipId);
    const s = snaps.get(a.membershipId);
    if (!s) continue;
    s.rsvp = (a.status as AskSnapshot["rsvp"]) ?? "unknown";
    s.hasArrivalDate = !!a.arrivalDate;
    s.hasDepartureDate = !!a.departureDate;
    // A Setup Access Pass is only needed by someone arriving before gates open;
    // asking anyone else would be noise.
    s.needsSetupPass = !!a.arrivalDate && a.arrivalDate < gateOpen;
  }

  // — required questions still unanswered —
  // Scope matters: a `once` question is answered for life (edition_id NULL), a
  // `per_edition` one has to be answered again each year.
  const questions = await db
    .select({
      id: campQuestion.id,
      audience: campQuestion.audience,
      scope: campQuestion.scope,
    })
    .from(campQuestion)
    .where(
      and(
        eq(campQuestion.campId, campId),
        eq(campQuestion.required, true),
        isNull(campQuestion.archivedAt),
      ),
    );
  if (questions.length > 0) {
    const answers = await db
      .select({
        questionId: questionAnswer.questionId,
        membershipId: questionAnswer.membershipId,
        editionId: questionAnswer.editionId,
      })
      .from(questionAnswer)
      .where(
        and(
          eq(questionAnswer.campId, campId),
          or(
            eq(questionAnswer.editionId, editionId),
            isNull(questionAnswer.editionId),
          ),
        ),
      );
    const answered = new Set(
      answers.map((a) => `${a.membershipId}:${a.questionId}`),
    );
    for (const [mid, s] of snaps) {
      const aud = audienceForRole(s.role);
      s.unansweredRequiredQuestions = questions.filter(
        (q) =>
          (q.audience === "all" || q.audience === aud) &&
          !answered.has(`${mid}:${q.id}`),
      ).length;
    }
  }

  // — gear on the map —
  const objects = await db
    .select({
      id: mapObject.id,
      kind: mapObject.kind,
      ownerMembershipId: mapObject.ownerMembershipId,
      placed: mapObject.placed,
    })
    .from(mapObject)
    .where(
      and(
        eq(mapObject.editionId, editionId),
        isNotNull(mapObject.ownerMembershipId),
      ),
    );
  const occupiedObjectIds = new Set(
    (
      await db
        .select({ objectId: mapObjectOccupant.objectId })
        .from(mapObjectOccupant)
        .where(eq(mapObjectOccupant.editionId, editionId))
    ).map((r) => r.objectId),
  );
  for (const o of objects) {
    const s = o.ownerMembershipId ? snaps.get(o.ownerMembershipId) : null;
    if (!s) continue;
    s.bringingCount += 1;
    if (!o.placed) s.unplacedCount += 1;
    // Only somewhere a person sleeps needs an occupant list; a shade structure
    // or a generator doesn't.
    const sleepable = hasTag(o.kind, "domicile") || hasTag(o.kind, "vehicle");
    if (sleepable && !occupiedObjectIds.has(o.id)) {
      s.domicilesWithoutOccupants += 1;
    }
  }

  // — camp checklist —
  const tasks = await db
    .select({ id: onboardingTask.id })
    .from(onboardingTask)
    .where(eq(onboardingTask.campId, campId));
  if (tasks.length > 0) {
    const done = await db
      .select({
        membershipId: onboardingCompletion.membershipId,
        taskId: onboardingCompletion.taskId,
      })
      .from(onboardingCompletion)
      .where(eq(onboardingCompletion.campId, campId));
    const doneBy = new Map<string, Set<string>>();
    for (const d of done) {
      const set = doneBy.get(d.membershipId) ?? new Set<string>();
      set.add(d.taskId);
      doneBy.set(d.membershipId, set);
    }
    for (const [mid, s] of snaps) {
      const mine = doneBy.get(mid);
      s.checklistRemaining = tasks.filter((t) => !mine?.has(t.id)).length;
    }
  }

  // — tickets —
  for (const t of await db
    .select({
      status: ticket.status,
      assignedAttendeeId: ticket.assignedAttendeeId,
    })
    .from(ticket)
    .where(
      and(
        eq(ticket.editionId, editionId),
        isNotNull(ticket.assignedAttendeeId),
      ),
    )) {
    const mid = t.assignedAttendeeId
      ? attendeeToMembership.get(t.assignedAttendeeId)
      : null;
    const s = mid ? snaps.get(mid) : null;
    if (!s) continue;
    s.hasTicket = true;
    if (t.status !== "purchased") s.ticketsAwaitingPurchase += 1;
  }
  for (const r of await db
    .select({ membershipId: ticketRequest.membershipId })
    .from(ticketRequest)
    .where(
      and(
        eq(ticketRequest.editionId, editionId),
        ne(ticketRequest.status, "denied"),
      ),
    )) {
    bump(snaps, r.membershipId, "ticketRequested", true);
  }

  // — setup passes — any non-denied row means they've asked.
  for (const p of await db
    .select({ attendeeId: setupPass.attendeeId })
    .from(setupPass)
    .where(
      and(eq(setupPass.editionId, editionId), ne(setupPass.status, "denied")),
    )) {
    const mid = p.attendeeId ? attendeeToMembership.get(p.attendeeId) : null;
    bump(snaps, mid ?? null, "hasSetupPassRow", true);
  }

  // — fuel —
  for (const f of await db
    .selectDistinct({ membershipId: fuelDeclaration.membershipId })
    .from(fuelDeclaration)
    .where(eq(fuelDeclaration.editionId, editionId))) {
    bump(snaps, f.membershipId, "fuelDeclared", true);
  }

  // — dues — expected comes from the assigned tier (waived = nothing owed);
  // paid is the sum of their donations this edition.
  const reqs = await db
    .select({
      membershipId: memberRequirement.membershipId,
      waived: memberRequirement.waived,
      expectedCents: contributionTier.expectedCents,
    })
    .from(memberRequirement)
    .leftJoin(
      contributionTier,
      eq(contributionTier.id, memberRequirement.tierId),
    )
    .where(eq(memberRequirement.editionId, editionId));
  if (reqs.length > 0) {
    const paidRows = await db
      .select({
        memberId: financeEntry.memberId,
        cents: sql<number>`sum(${financeEntry.amountCents})`,
      })
      .from(financeEntry)
      .where(
        and(
          eq(financeEntry.editionId, editionId),
          eq(financeEntry.kind, "donation"),
        ),
      )
      .groupBy(financeEntry.memberId);
    const paidBy = new Map(
      paidRows.map((p) => [p.memberId ?? "", Number(p.cents) || 0]),
    );
    for (const r of reqs) {
      const s = snaps.get(r.membershipId);
      if (!s) continue;
      const expected = r.waived ? 0 : (r.expectedCents ?? 0);
      s.duesOwedCents = Math.max(
        0,
        expected - (paidBy.get(r.membershipId) ?? 0),
      );
    }
  }

  // — Discord linked — keyed by user, not membership.
  for (const a of await db
    .selectDistinct({ userId: account.userId })
    .from(account)
    .where(eq(account.providerId, "discord"))) {
    bump(snaps, userToMembership.get(a.userId) ?? null, "discordLinked", true);
  }

  // — dismissals and acknowledgements —
  for (const w of await db
    .select({
      membershipId: wizardAsk.membershipId,
      askKey: wizardAsk.askKey,
      status: wizardAsk.status,
    })
    .from(wizardAsk)
    .where(eq(wizardAsk.editionId, editionId))) {
    const s = snaps.get(w.membershipId);
    if (!s) continue;
    if (w.status === "skipped") s.dismissed[w.askKey] = true;
    else s.acknowledged[w.askKey] = true;
  }

  return snaps;
}

/** One camper's snapshot. See the batching note above for why this isn't its
 * own query. */
export async function loadAskSnapshot(
  campId: string,
  editionId: string,
  year: number,
  membershipId: string,
): Promise<AskSnapshot | null> {
  return (
    (await loadAskSnapshots(campId, editionId, year)).get(membershipId) ?? null
  );
}
