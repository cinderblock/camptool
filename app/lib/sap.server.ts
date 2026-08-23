/**
 * Setup Access Pass stock — storage, import, and the state machine
 * (`plans/sap-import-and-distribution.md`).
 *
 * The vendor PDF's bytes live on disk beside the database, under the camp id
 * and the document row's uuid — the same arrangement as `camp_image`, for the
 * same reason (a 50MB order of passes has no business inside a database file
 * that gets downloaded whole) and with the same path-traversal defence (nothing
 * a user typed ever becomes part of a path).
 *
 * Everything that changes a pass goes through this module, so that the rules
 * that make release meaningful live in exactly one place:
 *
 *   - Codes are never returned by the read helpers used to build officer lists.
 *     `visibleCodesFor` is the single gate, and it answers "no" unless the pass
 *     is released AND the viewer is entitled to it.
 *   - `release` is one-way. `unassign` refuses to touch a released pass;
 *     `voidPass` is the only way out, it demands a reason, and it does not
 *     return the pass to the pool.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../../db/client.server";
import {
  attendee,
  membership,
  sapDocument,
  setupPass,
  setupPassStock,
  setupPassStockEvent,
  user,
} from "../../db/schema";
import { needsSetupPass } from "./age";
import { uploadsRoot } from "./images.server";
import { type PartyViewer, canManageAttendee } from "./party";
import { hasAtLeast } from "./permissions";
import { parseSapPdf } from "./sap-pdf.server";
import { sliceSapPage } from "./sap-slice.server";

export type StockStatus = "available" | "assigned" | "released" | "void";

/** `<uploads>/<camp>/sap/<documentId>` — a camp's orders are one directory, so
 * they can be archived or dropped as a unit. */
function documentPath(campId: string, documentId: string): string {
  return join(uploadsRoot(), campId, "sap", documentId);
}

export type ImportOutcome = {
  documentId: string;
  /** Pages that produced a pass row. */
  imported: number;
  /** Pages already known (same vendor ticket id) — a re-upload, not a duplicate. */
  alreadyKnown: number;
  /** Pages we could not read, with the reason, for a human to look at. */
  skipped: { page: number; reason: string }[];
  /** `date → passes now held`, the shape of the allocation. */
  byDate: Record<string, number>;
};

export class SapImportError extends Error {}

/**
 * Read a vendor PDF, store it, and turn its pages into stock.
 *
 * Idempotent by `vendor_ticket_id`: uploading the same order twice imports
 * nothing the second time. That matters because "did that upload work?" is
 * answered by uploading again, and doubling a camp's apparent allocation would
 * be a genuinely dangerous way to answer it.
 */
export async function importSapPdf(opts: {
  campId: string;
  editionId: string;
  /** The edition's year — pages from another year are refused, not imported. */
  year: number;
  filename: string;
  bytes: Uint8Array;
  userId: string;
  actorMembershipId: string;
  actorName: string | null;
}): Promise<ImportOutcome> {
  const pages = await parseSapPdf(opts.bytes);
  const ok = pages.filter((p) => p.ok);
  if (ok.length === 0) {
    throw new SapImportError(
      "No Setup Access Passes found in that PDF. Is it the pass file from the " +
        "vendor, one pass per page?",
    );
  }

  // A 2024 order imported into the 2026 edition would silently mis-date every
  // pass, and the dates are the entire point. Refuse instead.
  const wrongYear = ok.find((p) => p.ok && p.eventYear !== opts.year);
  if (wrongYear?.ok) {
    throw new SapImportError(
      `That PDF is for ${wrongYear.eventYear}, but this year is ${opts.year}. Switch to the matching year, or check you uploaded the right file.`,
    );
  }

  const documentId = crypto.randomUUID();
  await mkdir(join(uploadsRoot(), opts.campId, "sap"), { recursive: true });
  // File first: a row pointing at bytes that failed to land would break every
  // later slice, whereas an orphaned file is merely wasted space.
  await Bun.write(documentPath(opts.campId, documentId), opts.bytes);

  await db.insert(sapDocument).values({
    id: documentId,
    campId: opts.campId,
    editionId: opts.editionId,
    filename: opts.filename,
    byteSize: opts.bytes.byteLength,
    pageCount: pages.length,
    importedCount: ok.length,
    confirmationId: (ok[0]?.ok && ok[0].confirmationId) || null,
    uploadedById: opts.userId,
  });

  const existing = new Set(
    (
      await db
        .select({ vendorTicketId: setupPassStock.vendorTicketId })
        .from(setupPassStock)
        .where(eq(setupPassStock.editionId, opts.editionId))
    ).map((r) => r.vendorTicketId),
  );

  let imported = 0;
  let alreadyKnown = 0;
  const dates = new Set<string>();
  for (const page of ok) {
    if (!page.ok) continue;
    dates.add(page.onOrAfterDate);
    if (existing.has(page.vendorTicketId)) {
      alreadyKnown++;
      continue;
    }
    const id = crypto.randomUUID();
    await db.insert(setupPassStock).values({
      id,
      campId: opts.campId,
      editionId: opts.editionId,
      onOrAfterDate: page.onOrAfterDate,
      vendorTicketId: page.vendorTicketId,
      confirmationId: page.confirmationId,
      securityCode: page.securityCode,
      scanCode: page.scanCode,
      sourceDocumentId: documentId,
      sourcePageIndex: page.pageIndex,
      status: "available",
    });
    await logStockEvent(id, "imported", {
      actorMembershipId: opts.actorMembershipId,
      actorName: opts.actorName,
      detail: `${opts.filename} page ${page.pageIndex + 1}`,
    });
    imported++;
  }

  const byDate: Record<string, number> = {};
  for (const d of [...dates].sort()) {
    byDate[d] = await countStockForDate(opts.editionId, d);
  }

  return {
    documentId,
    imported,
    alreadyKnown,
    skipped: pages
      .filter((p) => !p.ok)
      .map((p) => ({ page: p.pageIndex + 1, reason: p.ok ? "" : p.reason })),
    byDate,
  };
}

/** Passes held for a date — void ones excluded, because a dead pass isn't
 * capacity, it's a replacement request. */
export async function countStockForDate(
  editionId: string,
  date: string,
): Promise<number> {
  const rows = await db
    .select({ id: setupPassStock.id })
    .from(setupPassStock)
    .where(
      and(
        eq(setupPassStock.editionId, editionId),
        eq(setupPassStock.onOrAfterDate, date),
        ne(setupPassStock.status, "void"),
      ),
    );
  return rows.length;
}

// --- state machine ---------------------------------------------------------

export class SapStateError extends Error {}

type Actor = { membershipId: string; name: string | null };

/** Set a pass aside for someone. Reveals nothing — that's the point of the
 * state existing at all. */
export async function assignStock(
  editionId: string,
  stockId: string,
  attendeeId: string,
  actor: Actor,
): Promise<void> {
  const row = await loadStock(editionId, stockId);
  if (row.status === "released") {
    throw new SapStateError(
      "That pass has already been released — its codes are out. Void it if it " +
        "needs to be replaced.",
    );
  }
  if (row.status === "void") {
    throw new SapStateError("That pass has been voided.");
  }

  const [person] = await db
    .select({ id: attendee.id, name: attendee.name, memberName: user.name })
    .from(attendee)
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(and(eq(attendee.id, attendeeId), eq(attendee.editionId, editionId)))
    .limit(1);
  if (!person)
    throw new SapStateError("That person isn't in this year's roster.");

  // Assigning a real pass IS the grant. If this person had an open request,
  // it is now satisfied — mark it and record which pass satisfied it, so there
  // is one ledger rather than a promise sitting beside a pass, each unaware of
  // the other.
  const [request] = await db
    .select({ id: setupPass.id })
    .from(setupPass)
    .where(
      and(
        eq(setupPass.editionId, editionId),
        eq(setupPass.attendeeId, attendeeId),
        eq(setupPass.status, "requested"),
      ),
    )
    .limit(1);

  await db
    .update(setupPassStock)
    .set({
      status: "assigned",
      assignedAttendeeId: attendeeId,
      setupPassId: request?.id ?? null,
      assignedAt: new Date(),
      assignedByMembershipId: actor.membershipId,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
  if (request) {
    await db
      .update(setupPass)
      .set({
        status: "granted",
        resolvedByMembershipId: actor.membershipId,
        resolvedAt: new Date(),
      })
      .where(eq(setupPass.id, request.id));
  }
  await logStockEvent(stockId, "assigned", {
    attendeeId,
    attendeeName: person.name ?? person.memberName ?? null,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
  });
}

/** Take a pass back. Only before release — after it, the codes are already
 * somewhere else and pretending otherwise is the failure mode this whole design
 * exists to prevent. */
export async function unassignStock(
  editionId: string,
  stockId: string,
  actor: Actor,
): Promise<void> {
  const row = await loadStock(editionId, stockId);
  if (row.status === "released") {
    throw new SapStateError(
      "That pass has been released — the codes have already gone out, so it " +
        "can't quietly go back in the pool. Void it instead.",
    );
  }
  await db
    .update(setupPassStock)
    .set({
      status: "available",
      assignedAttendeeId: null,
      setupPassId: null,
      assignedAt: null,
      assignedByMembershipId: null,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
  // Their ask is open again. Leaving it "granted" while they hold no pass
  // would be the two-ledger drift this design exists to avoid.
  await reopenRequest(row.setupPassId);
  await logStockEvent(stockId, "unassigned", {
    attendeeId: row.assignedAttendeeId,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
  });
}

/**
 * Hand the codes over. The one-way door.
 *
 * Everything before this is bookkeeping; this is the moment a secret leaves the
 * camp's control, so it is recorded with who did it and cannot be undone.
 */
export async function releaseStock(
  editionId: string,
  stockId: string,
  actor: Actor,
): Promise<void> {
  const row = await loadStock(editionId, stockId);
  if (row.status === "released") return; // idempotent: already out
  if (row.status === "void") {
    throw new SapStateError("That pass has been voided and can't be released.");
  }
  if (!row.assignedAttendeeId) {
    throw new SapStateError("Assign the pass to someone before releasing it.");
  }
  await db
    .update(setupPassStock)
    .set({
      status: "released",
      releasedAt: new Date(),
      releasedByMembershipId: actor.membershipId,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
  await logStockEvent(stockId, "released", {
    attendeeId: row.assignedAttendeeId,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
  });
}

/** Mark a pass dead. Does NOT return it to the pool: a pass whose codes are
 * loose is not capacity, it's a replacement request. */
export async function voidStock(
  editionId: string,
  stockId: string,
  reason: string,
  actor: Actor,
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new SapStateError("Say why this pass is being voided.");
  }
  const row = await loadStock(editionId, stockId);
  await db
    .update(setupPassStock)
    .set({
      status: "void",
      voidedAt: new Date(),
      voidedByMembershipId: actor.membershipId,
      voidReason: trimmed,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
  // The holder is now short a pass, so their ask is open again — and they
  // reappear in the "needs a pass" list rather than looking served.
  await reopenRequest(row.setupPassId);
  await logStockEvent(stockId, "voided", {
    attendeeId: row.assignedAttendeeId,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
    detail: trimmed,
  });
}

/** A request whose pass went away is an open request again. */
async function reopenRequest(setupPassId: string | null): Promise<void> {
  if (!setupPassId) return;
  await db
    .update(setupPass)
    .set({
      status: "requested",
      resolvedByMembershipId: null,
      resolvedAt: null,
    })
    .where(and(eq(setupPass.id, setupPassId), eq(setupPass.status, "granted")));
}

async function loadStock(editionId: string, stockId: string) {
  const [row] = await db
    .select()
    .from(setupPassStock)
    .where(
      and(
        eq(setupPassStock.id, stockId),
        eq(setupPassStock.editionId, editionId),
      ),
    )
    .limit(1);
  if (!row) throw new SapStateError("That pass isn't in this year's stock.");
  return row;
}

async function logStockEvent(
  stockId: string,
  action: string,
  info: {
    attendeeId?: string | null;
    attendeeName?: string | null;
    actorMembershipId?: string | null;
    actorName?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  await db.insert(setupPassStockEvent).values({
    id: crypto.randomUUID(),
    stockId,
    action,
    attendeeId: info.attendeeId ?? null,
    attendeeName: info.attendeeName ?? null,
    actorMembershipId: info.actorMembershipId ?? null,
    actorName: info.actorName ?? null,
    detail: info.detail ?? null,
  });
}

// --- reading ---------------------------------------------------------------

/**
 * May this viewer see this pass's codes?
 *
 * The single gate, deliberately narrow: released, and the viewer is the holder,
 * the holder's party host, or an officer. Officers are included because they
 * hand passes out at the gate and get asked "what's my code again?" — but note
 * that even an officer sees nothing before release, which is what makes
 * "assigned" a real state rather than a label.
 */
export function visibleCodesFor(
  pass: {
    status: string;
    membershipId: string | null;
    hostMembershipId: string | null;
  },
  viewer: PartyViewer,
): boolean {
  if (pass.status !== "released") return false;
  if (hasAtLeast(viewer.role, "officer")) return true;
  return canManageAttendee(
    {
      membershipId: pass.membershipId,
      hostMembershipId: pass.hostMembershipId,
    },
    viewer,
  );
}

/** The stored vendor PDF for a document row. */
export async function documentBytes(
  campId: string,
  documentId: string,
): Promise<Uint8Array> {
  const file = Bun.file(documentPath(campId, documentId));
  if (!(await file.exists())) {
    throw new SapStateError(
      "The original PDF for this pass is missing from storage — re-import the " +
        "order to restore it.",
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * One pass as its own single-page PDF, cut from the order it arrived in.
 *
 * The slicer verifies its own output against this pass's scan code, so a
 * mis-recorded page index surfaces here as a refusal rather than as somebody
 * turning up at the gate with a stranger's pass.
 */
export async function slicedPassPdf(
  campId: string,
  stock: {
    sourceDocumentId: string | null;
    sourcePageIndex: number | null;
    scanCode: string;
  },
): Promise<Uint8Array> {
  if (!stock.sourceDocumentId || stock.sourcePageIndex === null) {
    throw new SapStateError(
      "This pass has no source page recorded, so its PDF can't be produced.",
    );
  }
  const bytes = await documentBytes(campId, stock.sourceDocumentId);
  return sliceSapPage(bytes, stock.sourcePageIndex, stock.scanCode);
}

/**
 * Passes **with their codes**, for the download routes — the only read here
 * that returns them.
 *
 * Returns whatever the ids match, still carrying the party columns; it does not
 * itself decide who may see them. Callers must run every row past
 * `visibleCodesFor` and drop the ones that fail. Split that way on purpose: a
 * function that both fetched secrets and judged access would be one refactor
 * away from being called for its rows and trusted for its judgement.
 */
export async function stockWithCodes(editionId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: setupPassStock.id,
      onOrAfterDate: setupPassStock.onOrAfterDate,
      vendorTicketId: setupPassStock.vendorTicketId,
      status: setupPassStock.status,
      securityCode: setupPassStock.securityCode,
      scanCode: setupPassStock.scanCode,
      sourceDocumentId: setupPassStock.sourceDocumentId,
      sourcePageIndex: setupPassStock.sourcePageIndex,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
    })
    .from(setupPassStock)
    .leftJoin(attendee, eq(setupPassStock.assignedAttendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(setupPassStock.editionId, editionId),
        inArray(setupPassStock.id, ids),
      ),
    );
}

/** Stock for an edition with holder details joined — the officer table. Codes
 * are NOT selected here; nothing that builds a list should carry them. */
export async function stockForEdition(editionId: string) {
  const hostMembership = alias(membership, "stock_host_membership");
  const hostUser = alias(user, "stock_host_user");
  return db
    .select({
      id: setupPassStock.id,
      onOrAfterDate: setupPassStock.onOrAfterDate,
      vendorTicketId: setupPassStock.vendorTicketId,
      status: setupPassStock.status,
      note: setupPassStock.note,
      voidReason: setupPassStock.voidReason,
      releasedAt: setupPassStock.releasedAt,
      assignedAttendeeId: setupPassStock.assignedAttendeeId,
      attendeeMembershipId: attendee.membershipId,
      attendeeHostId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      // Whose guest, so a pass set aside for "Sam" is identifiable in a camp
      // with several Sams and thirty guests.
      hostName: hostUser.name,
      // Their RSVP. A pass held by somebody who has since said "not this year"
      // is capacity the camp thinks it has spent — worth flagging, because
      // nothing else will ever mention it again.
      holderStatus: attendee.status,
      sourceDocumentId: setupPassStock.sourceDocumentId,
      sourcePageIndex: setupPassStock.sourcePageIndex,
    })
    .from(setupPassStock)
    .leftJoin(attendee, eq(setupPassStock.assignedAttendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .leftJoin(hostMembership, eq(attendee.hostMembershipId, hostMembership.id))
    .leftJoin(hostUser, eq(hostMembership.userId, hostUser.id))
    .where(eq(setupPassStock.editionId, editionId));
}

/**
 * Who is arriving before gates open and has no pass set aside?
 *
 * The inverse of the pending-request queue, and the list that actually matters
 * when allocating scarce stock: someone who set an early arrival date but never
 * clicked "request a pass" is invisible to a queue built from requests.
 */
export async function earlyArrivalsWithoutStock(
  editionId: string,
  gateOpenIso: string,
) {
  const held = await db
    .select({ attendeeId: setupPassStock.assignedAttendeeId })
    .from(setupPassStock)
    .where(
      and(
        eq(setupPassStock.editionId, editionId),
        ne(setupPassStock.status, "void"),
      ),
    );
  const covered = new Set(held.map((h) => h.attendeeId).filter(Boolean));

  // Aliased joins so one query can name BOTH the attendee (via their own
  // membership) and the person hosting them. A guest called "Sam" is unusable
  // in a list of thirty; "Sam — guest of Devon" is the whole point.
  const hostMembership = alias(membership, "host_membership");
  const hostUser = alias(user, "host_user");
  const rows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      hostName: hostUser.name,
      arrivalDate: attendee.arrivalDate,
      status: attendee.status,
      ageBand: attendee.ageBand,
    })
    .from(attendee)
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .leftJoin(hostMembership, eq(attendee.hostMembershipId, hostMembership.id))
    .leftJoin(hostUser, eq(hostMembership.userId, hostUser.id))
    .where(eq(attendee.editionId, editionId));

  return (
    rows
      .filter((r) => r.status !== "not_coming")
      // Under-13s are admitted free and need no pass of their own. Without
      // this they arrive early with their parents, land in the officers'
      // "needs a pass" list, and make the camp look short of passes it does
      // not need.
      .filter((r) => needsSetupPass(r.ageBand))
      .filter((r) => r.arrivalDate && r.arrivalDate < gateOpenIso)
      .filter((r) => !covered.has(r.id))
      .sort((a, b) => (a.arrivalDate ?? "").localeCompare(b.arrivalDate ?? ""))
  );
}

export type SapCoverage = {
  held: number;
  spare: number;
  assigned: number;
  released: number;
  voided: number;
  /** Passes held per "on or after" date, void excluded. */
  byDate: { date: string; held: number; spare: number }[];
  /** Arriving before gates open with no pass — the demand. */
  needing: number;
  /** Of those, how many the spare passes can actually cover. */
  coverable: number;
  /** Arriving so early that nothing spare is dated early enough for them. */
  uncoverable: { name: string; arrivalDate: string }[];
  /**
   * Coming (or maybe) with NO arrival date at all. Not counted as demand,
   * because we genuinely don't know — but they're who to chase, since an
   * early arrival nobody wrote down is the one way to be short on the day.
   */
  unknownArrival: number;
};

/**
 * How the camp's passes line up against who needs one.
 *
 * The matching is not just a count, because a pass admits **on or after** its
 * date: a pass dated the 28th is no use to someone arriving on the 25th, while
 * a 25th pass covers everybody. So the earliest arrivals are the hardest to
 * serve, and "we hold 26 and 26 people need one" can still leave someone
 * stranded.
 *
 * Greedy over arrivals earliest-first, giving each person the **latest** pass
 * that still covers them — which leaves the early-dated passes for the people
 * who can't use anything else. That's optimal here, and it means `uncoverable`
 * is a real shortfall rather than an artefact of assignment order.
 */
export async function sapCoverage(
  editionId: string,
  gateOpenIso: string,
): Promise<SapCoverage> {
  const stock = await db
    .select({
      id: setupPassStock.id,
      onOrAfterDate: setupPassStock.onOrAfterDate,
      status: setupPassStock.status,
    })
    .from(setupPassStock)
    .where(eq(setupPassStock.editionId, editionId));

  const live = stock.filter((s) => s.status !== "void");
  const spares = live
    .filter((s) => s.status === "available")
    .sort((a, b) => a.onOrAfterDate.localeCompare(b.onOrAfterDate));

  const byDateMap = new Map<string, { held: number; spare: number }>();
  for (const s of live) {
    const row = byDateMap.get(s.onOrAfterDate) ?? { held: 0, spare: 0 };
    row.held++;
    if (s.status === "available") row.spare++;
    byDateMap.set(s.onOrAfterDate, row);
  }

  const people = await earlyArrivalsWithoutStock(editionId, gateOpenIso);

  // Everyone attending whose arrival we don't know. They can't be counted as
  // demand and they can't be ruled out either.
  const noDate = await db
    .select({
      id: attendee.id,
      status: attendee.status,
      ageBand: attendee.ageBand,
    })
    .from(attendee)
    .where(
      and(eq(attendee.editionId, editionId), isNull(attendee.arrivalDate)),
    );
  const unknownArrival = noDate.filter(
    (a) =>
      (a.status === "coming" || a.status === "maybe") &&
      // A child who'd need no pass either way isn't an unknown worth chasing.
      needsSetupPass(a.ageBand),
  ).length;

  // Greedy match, earliest arrival first.
  const pool = [...spares];
  let coverable = 0;
  const uncoverable: { name: string; arrivalDate: string }[] = [];
  for (const p of people) {
    const arrival = p.arrivalDate;
    if (!arrival) continue;
    // The latest spare that still admits them; spares are date-ascending.
    let pick = -1;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      if (candidate && candidate.onOrAfterDate <= arrival) pick = i;
      else break;
    }
    if (pick >= 0) {
      pool.splice(pick, 1);
      coverable++;
    } else {
      uncoverable.push({
        name: p.guestName ?? p.memberName ?? "Unknown",
        arrivalDate: arrival,
      });
    }
  }

  return {
    held: live.length,
    spare: live.filter((s) => s.status === "available").length,
    assigned: live.filter((s) => s.status === "assigned").length,
    released: live.filter((s) => s.status === "released").length,
    voided: stock.length - live.length,
    byDate: [...byDateMap.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    needing: people.length,
    coverable,
    uncoverable,
    unknownArrival,
  };
}

/** The audit trail for one pass, newest first. */
export async function stockHistory(stockId: string) {
  return db
    .select()
    .from(setupPassStockEvent)
    .where(eq(setupPassStockEvent.stockId, stockId))
    .orderBy(sql`${setupPassStockEvent.createdAt} DESC`);
}
