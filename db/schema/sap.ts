/**
 * Setup Access Pass **stock** — the actual passes, imported from the vendor's
 * PDF (see `plans/sap-import-and-distribution.md`).
 *
 * This is deliberately separate from `setup_pass` in `ticket.ts`, and the split
 * is the whole design:
 *
 *   setup_pass        the ENTITLEMENT. "This person asked for early access and
 *                     an officer granted it." Exists before any pass does —
 *                     camps grant against an allocation Burning Man has promised
 *                     but not yet delivered.
 *   setup_pass_stock  the PASS. One row per page of an imported PDF, carrying
 *                     the codes that actually open the gate.
 *
 * Assignment binds one to the other. Keeping them apart means neither has to
 * wait for the other, and revoking a grant doesn't destroy an imported pass.
 *
 * ## Codes are secrets
 *
 * `security_code` and `scan_code` are, together, the entire value of a pass:
 * anyone holding them can use it. They are stored **plain** (a deliberate
 * decision — see the plan), which makes two things true and worth stating where
 * they can't be missed:
 *
 *   1. A `/export-db` dump or an `uploads/` backup of this deployment contains
 *      usable passes. Treat those backups like the passes themselves.
 *   2. No loader may return these columns except to someone entitled to them,
 *      and only once the pass is `released`. Privacy/demo mode strips them
 *      unconditionally.
 *
 * ## Status
 *
 *   available → assigned → released
 *                  ↑           │
 *                  └─ unassign │  (silent, reversible, no codes revealed)
 *                              ↓
 *                            void   (admin only, reason required)
 *
 * `released` means the codes have been shown to a person. There is no path back
 * to `available` from it, because there is no way to un-send a secret — the only
 * backward move is `void`, which marks the pass unusable and does NOT return it
 * to the pool. A voided pass needs a replacement from the vendor.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { attendee } from "./attendee";
import { user } from "./auth";
import { camp, campEdition, membership } from "./camp";
import { setupPassDate } from "./ticket";

const now = sql`(unixepoch() * 1000)`;

/**
 * An uploaded vendor PDF. Metadata row only — the bytes live on disk in the
 * uploads dir, exactly like `camp_image` (`app/lib/images.server.ts`), because
 * a 50MB order of passes does not belong in a database file that gets
 * downloaded whole.
 *
 * Kept after import rather than discarded: it is the source of truth for
 * re-slicing a page, and re-importing it is the recovery path if stock rows are
 * ever lost.
 */
export const sapDocument = sqliteTable(
  "sap_document",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    /** What the uploader called it — metadata only. NEVER part of a path; the
     * file is stored under the camp id and this row's uuid, which is the
     * path-traversal defence. */
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull(),
    pageCount: integer("page_count").notNull().default(0),
    /** Pages that produced a usable pass. Less than `page_count` means some
     * page didn't parse and a human should look at it. */
    importedCount: integer("imported_count").notNull().default(0),
    /** Order-level, from the pages themselves. Repeated on every page of an
     * order, so it identifies the ORDER, not a pass. */
    confirmationId: text("confirmation_id"),
    uploadedById: text("uploaded_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("sap_document_edition").on(t.editionId)],
);

export const setupPassStock = sqliteTable(
  "setup_pass_stock",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    editionId: text("edition_id").references(() => campEdition.id, {
      onDelete: "cascade",
    }),
    /** The "on or after" date row this pass belongs to, matched (or created) at
     * import from the date printed on the page. */
    passDateId: text("pass_date_id").references(() => setupPassDate.id, {
      onDelete: "set null",
    }),
    /** As printed. Kept alongside `pass_date_id` so a pass still knows its own
     * date if the date row is ever reorganised. ISO `YYYY-MM-DD`. */
    onOrAfterDate: text("on_or_after_date").notNull(),

    /** The vendor's per-pass identifier, and our import idempotency key: unique
     * per edition, so re-uploading the same PDF updates rather than duplicates. */
    vendorTicketId: text("vendor_ticket_id").notNull(),
    confirmationId: text("confirmation_id"),
    /** SECRET — see the header. Printed on the pass. */
    securityCode: text("security_code").notNull(),
    /** SECRET — see the header. The 10 digits behind the QR and barcode; the
     * value the gate actually scans. */
    scanCode: text("scan_code").notNull(),

    /** Where this pass came from, so its page can be re-sliced on demand rather
     * than stored twice. */
    sourceDocumentId: text("source_document_id").references(
      () => sapDocument.id,
      { onDelete: "set null" },
    ),
    /** 0-based page within that document. */
    sourcePageIndex: integer("source_page_index"),

    /** available | assigned | released | void — see the header. */
    status: text("status").notNull().default("available"),

    /** The holder: a member OR a host-managed guest, like tickets and grants.
     * `set null` returns the pass to the pool if the person leaves the camp
     * rather than destroying an imported pass. */
    assignedAttendeeId: text("assigned_attendee_id").references(
      () => attendee.id,
      { onDelete: "set null" },
    ),
    /** The entitlement this pass satisfies, when it came from a request. */
    setupPassId: text("setup_pass_id"),

    assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
    assignedByMembershipId: text("assigned_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    /** Set once and never cleared: the moment the codes left our control. */
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    releasedByMembershipId: text("released_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidedByMembershipId: text("voided_by_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    /** Required when voiding — "why is this pass dead" is the whole point of
     * the record. */
    voidReason: text("void_reason"),

    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("setup_pass_stock_edition").on(t.editionId, t.status),
    index("setup_pass_stock_attendee").on(t.assignedAttendeeId),
    // Re-importing the same order must update, not duplicate.
    uniqueIndex("setup_pass_stock_vendor_ticket").on(
      t.editionId,
      t.vendorTicketId,
    ),
  ],
);

/**
 * What happened to a pass, and who did it.
 *
 * The status columns answer "who released this?"; they cannot answer "who had
 * it before?". For a scarce, transferable secret that second question gets
 * asked exactly once — after something has gone wrong — and it can't be
 * answered retroactively if nobody wrote it down. Cheap to keep, impossible to
 * reconstruct.
 */
export const setupPassStockEvent = sqliteTable(
  "setup_pass_stock_event",
  {
    id: text("id").primaryKey(),
    stockId: text("stock_id")
      .notNull()
      .references(() => setupPassStock.id, { onDelete: "cascade" }),
    /** imported | assigned | unassigned | released | voided */
    action: text("action").notNull(),
    /** The attendee involved, where the action had one. Not a foreign key on
     * purpose: this record must survive the person being removed from the camp,
     * which is exactly when it matters most. */
    attendeeId: text("attendee_id"),
    attendeeName: text("attendee_name"),
    actorMembershipId: text("actor_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    actorName: text("actor_name"),
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("setup_pass_stock_event_stock").on(t.stockId, t.createdAt)],
);
