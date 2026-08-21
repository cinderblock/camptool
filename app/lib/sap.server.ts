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
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/client.server";
import {
  attendee,
  membership,
  sapDocument,
  setupPassDate,
  setupPassStock,
  setupPassStockEvent,
  user,
} from "../../db/schema";
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
    const passDateId = await ensurePassDate(
      opts.campId,
      opts.editionId,
      page.onOrAfterDate,
    );
    const id = crypto.randomUUID();
    await db.insert(setupPassStock).values({
      id,
      campId: opts.campId,
      editionId: opts.editionId,
      passDateId,
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

  await syncQuotas(opts.editionId, [...dates]);

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

/** The `setup_pass_date` row for a printed date, created if the camp hasn't
 * got one yet — an imported pass always knows its own date, even when nobody
 * typed it in first. */
async function ensurePassDate(
  campId: string,
  editionId: string,
  date: string,
): Promise<string> {
  const [found] = await db
    .select({ id: setupPassDate.id })
    .from(setupPassDate)
    .where(
      and(eq(setupPassDate.editionId, editionId), eq(setupPassDate.date, date)),
    )
    .limit(1);
  if (found) return found.id;

  const id = crypto.randomUUID();
  await db
    .insert(setupPassDate)
    .values({ id, campId, editionId, date, quota: 0 });
  return id;
}

/** Passes held for a date — void ones excluded, because a dead pass isn't
 * capacity. */
async function countStockForDate(
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

/**
 * Point each date's quota at the stock actually held.
 *
 * Before import existed, `quota` was a number an officer typed from an email.
 * Once real passes are in the system it should be what the camp has — otherwise
 * the grant screen enforces a cap that no longer means anything. Dates with no
 * imported stock are left alone, so a camp can still grant against passes the
 * vendor has promised but not yet sent.
 */
export async function syncQuotas(
  editionId: string,
  dates?: string[],
): Promise<void> {
  const targets =
    dates ??
    (
      await db
        .selectDistinct({ date: setupPassStock.onOrAfterDate })
        .from(setupPassStock)
        .where(eq(setupPassStock.editionId, editionId))
    ).map((r) => r.date);

  for (const date of targets) {
    const held = await countStockForDate(editionId, date);
    if (held === 0) continue;
    await db
      .update(setupPassDate)
      .set({ quota: held, updatedAt: new Date() })
      .where(
        and(
          eq(setupPassDate.editionId, editionId),
          eq(setupPassDate.date, date),
        ),
      );
  }
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

  await db
    .update(setupPassStock)
    .set({
      status: "assigned",
      assignedAttendeeId: attendeeId,
      assignedAt: new Date(),
      assignedByMembershipId: actor.membershipId,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
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
      assignedAt: null,
      assignedByMembershipId: null,
      updatedAt: new Date(),
    })
    .where(eq(setupPassStock.id, stockId));
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
  await logStockEvent(stockId, "voided", {
    attendeeId: row.assignedAttendeeId,
    actorMembershipId: actor.membershipId,
    actorName: actor.name,
    detail: trimmed,
  });
  if (row.editionId) await syncQuotas(row.editionId, [row.onOrAfterDate]);
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

/** Stock for an edition with holder details joined — the officer table. Codes
 * are NOT selected here; nothing that builds a list should carry them. */
export async function stockForEdition(editionId: string) {
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
      sourceDocumentId: setupPassStock.sourceDocumentId,
      sourcePageIndex: setupPassStock.sourcePageIndex,
    })
    .from(setupPassStock)
    .leftJoin(attendee, eq(setupPassStock.assignedAttendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
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

  const rows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      arrivalDate: attendee.arrivalDate,
      status: attendee.status,
    })
    .from(attendee)
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(attendee.editionId, editionId));

  return rows
    .filter((r) => r.status !== "not_coming")
    .filter((r) => r.arrivalDate && r.arrivalDate < gateOpenIso)
    .filter((r) => !covered.has(r.id))
    .sort((a, b) => (a.arrivalDate ?? "").localeCompare(b.arrivalDate ?? ""));
}

/** The audit trail for one pass, newest first. */
export async function stockHistory(stockId: string) {
  return db
    .select()
    .from(setupPassStockEvent)
    .where(eq(setupPassStockEvent.stockId, stockId))
    .orderBy(sql`${setupPassStockEvent.createdAt} DESC`);
}
