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
  setupPassDate,
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
      // An assigned pass names one holder. Clearing this is what makes the two
      // columns mutually exclusive rather than merely conventionally so.
      externalHolder: null,
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

/**
 * Hand a pass to someone the app has never heard of.
 *
 * The escape hatch for a neighbour, a helper, a friend of the camp — a person
 * with no membership and no attendee row, so there is nothing to reference and
 * nothing to look up. The pass still leaves the pool the ordinary way
 * (`assigned`), because it is still one of the camp's N passes and must stop
 * counting as spare the moment it's promised.
 *
 * Only from `available`, on purpose: taking a pass off a camper and giving it
 * to an outsider should be two deliberate acts, so their request visibly
 * reopens instead of being reassigned out from under them.
 */
export async function allocateStockExternally(
  editionId: string,
  stockId: string,
  holder: string,
  note: string | null,
  actor: Actor,
): Promise<void> {
  const name = holder.trim();
  if (name.length < 2) {
    throw new SapStateError("Say who this pass is going to.");
  }
  const row = await loadStock(editionId, stockId);
  if (row.status !== "available") {
    if (row.status === "assigned") {
      throw new SapStateError(
        "That pass is already set aside for someone. Take it back first, so " +
          "their request reopens instead of quietly changing hands.",
      );
    }
    throw new SapStateError(
      row.status === "released"
        ? "That pass has already been released — its codes are out."
        : "That pass has been voided.",
    );
  }
  await db
    .update(setupPassStock)
    .set({
      status: "assigned",
      assignedAttendeeId: null,
      externalHolder: name,
      setupPassId: null,
      note: note?.trim() || null,
      assignedAt: new Date(),
      assignedByMembershipId: actor.membershipId,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
  await logStockEvent(stockId, "assigned", {
    attendeeName: name,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
    detail: note?.trim()
      ? `Allocated outside the camp — ${note.trim()}`
      : "Allocated outside the camp",
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
      externalHolder: null,
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
    attendeeName: row.externalHolder,
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
  // Either kind of holder counts — a pass allocated outside the camp is as
  // assigned as one set aside for a camper; only the delivery differs.
  if (!row.assignedAttendeeId && !row.externalHolder) {
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
    attendeeName: row.externalHolder,
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
    attendeeName: row.externalHolder,
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
 *
 * A pass allocated outside the camp joins to no attendee, so both membership
 * columns are NULL and only the officer branch can ever match it. That is the
 * intended reading: an outsider's pass is deliverable by officers and invisible
 * to every camper, including whoever the officer is forwarding it on behalf of.
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
      // NULL unless the pass went to someone outside the camp, in which case
      // it is the only name there is — the PDF filename and the group sheet
      // both fall back to it rather than printing "pass".
      externalHolder: setupPassStock.externalHolder,
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
      externalHolder: setupPassStock.externalHolder,
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

// --- one camper's own pass, for /trip and /start ---------------------------

/**
 * The "requesting a Setup Access Pass" control's whole state, for one camper.
 *
 * Two tables answer this question and neither can answer it alone: `setup_pass`
 * says what they asked for, `setup_pass_stock` says what they actually hold, and
 * the second only ever exists because an officer acted on the first. Resolving
 * them into one shape here — rather than in each of the two loaders that need it
 * — is what keeps `/trip` and `/start` from disagreeing about whether somebody
 * has a pass.
 *
 * See `plans/sap-request-and-external-allocation.md`.
 */
export type MySapState = {
  /** Is the box ticked? True while an ask is live, or a pass is in hand. */
  requesting: boolean;
  /**
   * Why the camper can't change it from here, if they can't — shown in place of
   * the switch. Set only once a real pass is involved: unticking then would
   * either be a lie or a silent hand-back of a scarce, possibly already-sent
   * secret, so it goes through an officer instead.
   */
  fixedReason: string | null;
  /** The day a pass in hand admits them, once one has been set aside. */
  onOrAfterDate: string | null;
  /** A pass really set aside for them, and how far along it is. */
  held: "assigned" | "released" | null;
  /** An officer turned an earlier ask down. Worth saying, since the box being
   * clear otherwise reads as "you never asked". */
  denied: boolean;
};

export async function loadMySapState(
  editionId: string,
  membershipId: string,
): Promise<MySapState> {
  const asks = await db
    .select({ status: setupPass.status, date: setupPassDate.date })
    .from(setupPass)
    .leftJoin(setupPassDate, eq(setupPass.passDateId, setupPassDate.id))
    .innerJoin(attendee, eq(setupPass.attendeeId, attendee.id))
    .where(
      and(
        eq(setupPass.editionId, editionId),
        eq(attendee.membershipId, membershipId),
      ),
    );
  const held = (
    await db
      .select({
        status: setupPassStock.status,
        onOrAfterDate: setupPassStock.onOrAfterDate,
      })
      .from(setupPassStock)
      .innerJoin(attendee, eq(setupPassStock.assignedAttendeeId, attendee.id))
      .where(
        and(
          eq(setupPassStock.editionId, editionId),
          eq(attendee.membershipId, membershipId),
          ne(setupPassStock.status, "void"),
        ),
      )
  )
    // Released beats assigned: if any pass of theirs is out, that's the state
    // that matters, and it's the one that can't be walked back.
    .sort((a, b) =>
      a.status === "released" ? -1 : b.status === "released" ? 1 : 0,
    )
    .at(0);

  const live = asks.find(
    (a) => a.status === "requested" || a.status === "granted",
  );
  const heldState =
    held?.status === "released" || held?.status === "assigned"
      ? held.status
      : null;

  return {
    requesting: Boolean(live) || heldState !== null,
    fixedReason:
      heldState === "released"
        ? "Your pass is ready — open Setup Access Passes for the codes."
        : heldState === "assigned"
          ? "A pass is already set aside for you. Tell an officer if your plans have changed."
          : live?.status === "granted"
            ? "An officer has granted you a pass."
            : null,
    onOrAfterDate: held?.onOrAfterDate ?? live?.date ?? null,
    held: heldState,
    denied:
      !live && heldState === null && asks.some((a) => a.status === "denied"),
  };
}

/**
 * Ask for a pass on the camper's behalf when they say they're arriving before
 * gates open.
 *
 * This is the "auto-fills if early arrival is selected" half, and it runs on the
 * **server, inside the same write that saves the date** rather than as a ticked
 * box the browser sends later. A control that only looks ticked is the failure
 * mode worth designing out: the camper believes they asked, the officer queue
 * has never heard of them, and the two only meet at the gate.
 *
 * Idempotent, and it never overrides an answer that already exists — a decline,
 * a denial, a live request and a pass in hand all mean the question has been
 * settled, so this only ever fills a genuine blank.
 */
export async function autoRequestSetupPass(opts: {
  campId: string;
  editionId: string;
  attendeeId: string;
  userId: string;
  /** Their stated arrival, and the day gates open. Both ISO `YYYY-MM-DD`. */
  arrivalDate: string | null;
  gateOpenIso: string;
  /** False when this camp doesn't run passes — then there's nothing to ask for. */
  passesVisible: boolean;
}): Promise<void> {
  const { arrivalDate, gateOpenIso } = opts;
  if (!opts.passesVisible) return;
  // ISO dates compare correctly as plain strings.
  if (!arrivalDate || arrivalDate >= gateOpenIso) return;

  const [person] = await db
    .select({ ageBand: attendee.ageBand })
    .from(attendee)
    .where(eq(attendee.id, opts.attendeeId))
    .limit(1);
  // Under-13s are admitted free however early they turn up.
  if (person && !needsSetupPass(person.ageBand)) return;

  const asks = await db
    .select({ id: setupPass.id })
    .from(setupPass)
    .where(
      and(
        eq(setupPass.editionId, opts.editionId),
        eq(setupPass.attendeeId, opts.attendeeId),
      ),
    );
  if (asks.length > 0) return;

  const stock = await db
    .select({ id: setupPassStock.id })
    .from(setupPassStock)
    .where(
      and(
        eq(setupPassStock.editionId, opts.editionId),
        eq(setupPassStock.assignedAttendeeId, opts.attendeeId),
        ne(setupPassStock.status, "void"),
      ),
    );
  if (stock.length > 0) return;

  await db.insert(setupPass).values({
    id: crypto.randomUUID(),
    campId: opts.campId,
    editionId: opts.editionId,
    attendeeId: opts.attendeeId,
    status: "requested",
    note: "Asked for automatically — arriving before gates open.",
    createdById: opts.userId,
  });
}

/** The audit trail for one pass, newest first. */
export async function stockHistory(stockId: string) {
  return db
    .select()
    .from(setupPassStockEvent)
    .where(eq(setupPassStockEvent.stockId, stockId))
    .orderBy(sql`${setupPassStockEvent.createdAt} DESC`);
}
