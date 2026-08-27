/**
 * Reading Setup Access Passes out of the vendor's PDF (see
 * `plans/sap-import-and-distribution.md`).
 *
 * Burning Man delivers a camp's SAP allocation as one PDF with **one pass per
 * page**. Each page carries five things we need, and they come from two
 * different places in the file:
 *
 *   text layer   ticket ID, confirmation ID, the "on or after" date, and the
 *                48-ish-character security code. Extracts cleanly — there is no
 *                OCR anywhere in this module and there must never need to be.
 *   image        the 10-digit **scan code**, which appears ONLY inside the QR
 *                code (a 174×174 JPEG). It is not in the text layer and is not
 *                derived from the ticket ID — verified against the 2024 order:
 *                ticket 385315582 scans as 4666883273, …583 as 1162579105.
 *
 * The page also draws a ~30×79 Code128 strip encoding the same digits, but at
 * that resolution (~79px across ten digits) it is not decodable. Don't try; the
 * QR carries the same value with pixels to spare.
 *
 * Every page is parsed independently and failures are DATA, not exceptions: a
 * page that yields no QR comes back as a row with `ok: false` and a reason, so
 * the import screen can show "page 7 needs a look" while importing the other
 * 25. A vendor tweak to one page must not cost the camp the whole order.
 */
import { getDocumentProxy } from "unpdf";
import { copyForPdfJs, qrOnPage } from "./sap-qr.server";

/** A page we understood completely — every field an imported pass needs. */
export type ParsedSapPass = {
  ok: true;
  /** 0-based, so it can address the page for slicing later. */
  pageIndex: number;
  /** Unique per pass. The idempotency key for re-importing the same PDF. */
  vendorTicketId: string;
  /** Order-level and repeated on every page — NOT a per-pass identifier. */
  confirmationId: string | null;
  /** ISO `YYYY-MM-DD`. The pass admits entry on or after this date. */
  onOrAfterDate: string;
  /** From the event line, e.g. "Black Rock City: Access 2024". */
  eventYear: number;
  securityCode: string;
  /** The 10-digit value the gate scans, decoded from the QR. */
  scanCode: string;
};

/** A page we could not fully read, with enough detail to act on. */
export type UnparsedSapPass = {
  ok: false;
  pageIndex: number;
  reason: string;
  /** Whatever we did manage to read, to help a human identify the page. */
  partial: Partial<Omit<ParsedSapPass, "ok" | "pageIndex">>;
};

export type SapPageResult = ParsedSapPass | UnparsedSapPass;

/** Parse a whole SAP PDF. One result per page, in page order. */
export async function parseSapPdf(bytes: Uint8Array): Promise<SapPageResult[]> {
  const pdf = await getDocumentProxy(copyForPdfJs(bytes));
  const { OPS } = await import("unpdf/pdfjs");
  const out: SapPageResult[] = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    const pageIndex = n - 1;
    const page = await pdf.getPage(n);
    try {
      const items = await textItems(page);
      const fields = parseTextFields(items);
      const scanCode = await qrOnPage(page, OPS);

      const missing: string[] = [];
      if (!fields.vendorTicketId) missing.push("ticket ID");
      if (!fields.onOrAfterDate) missing.push("on-or-after date");
      if (!fields.securityCode) missing.push("security code");
      if (!scanCode) missing.push("scan code (QR)");

      if (
        missing.length > 0 ||
        !fields.vendorTicketId ||
        !fields.onOrAfterDate
      ) {
        out.push({
          ok: false,
          pageIndex,
          reason: `Could not read ${missing.join(", ")} on this page.`,
          partial: { ...fields, ...(scanCode ? { scanCode } : {}) },
        });
      } else {
        out.push({
          ok: true,
          pageIndex,
          vendorTicketId: fields.vendorTicketId,
          confirmationId: fields.confirmationId ?? null,
          onOrAfterDate: fields.onOrAfterDate,
          eventYear: fields.eventYear as number,
          securityCode: fields.securityCode as string,
          scanCode: scanCode as string,
        });
      }
    } catch (e) {
      out.push({
        ok: false,
        pageIndex,
        reason: `Page failed to parse: ${(e as Error).message}`,
        partial: {},
      });
    } finally {
      // The full-page background decodes to ~21MB of pixels. Without this a
      // 26-page order holds half a gigabyte of images it will never look at
      // again.
      page.cleanup();
    }
  }
  return out;
}

/**
 * One page's text, read back the way any other tool would read it.
 *
 * Text only — no QR decode, so it costs milliseconds rather than the seconds a
 * full parse spends decompressing the page's full-size background. Used to
 * check a produced pass still says what it should after the holder's name has
 * been rewritten into it (`sap-rename.server.ts`).
 */
export async function pageTextItems(
  bytes: Uint8Array,
  pageIndex: number,
): Promise<string[]> {
  const pdf = await getDocumentProxy(copyForPdfJs(bytes));
  const page = await pdf.getPage(pageIndex + 1);
  try {
    return await textItems(page);
  } finally {
    page.cleanup();
  }
}

/** Text strings on a page, in content-stream order — which is what lets the
 * value directly after a "Confirmation Id" label be read as that label's
 * value. */
async function textItems(page: {
  getTextContent: () => Promise<{ items: unknown[] }>;
}): Promise<string[]> {
  const tc = await page.getTextContent();
  return (tc.items as { str?: string }[])
    .map((i) => (typeof i.str === "string" ? i.str : ""))
    .filter((s) => s.trim().length > 0);
}

type TextFields = Partial<Omit<ParsedSapPass, "ok" | "pageIndex" | "scanCode">>;

/**
 * Pull the text-layer fields. Exported for tests, which run it against captured
 * strings instead of needing a PDF (and, deliberately, against strings that
 * contain no real security code).
 */
export function parseTextFields(items: string[]): TextFields {
  const text = items.join("\n");
  const fields: TextFields = {};

  const ticket = text.match(/Ticket ID\s+(\d+)/);
  if (ticket?.[1]) fields.vendorTicketId = ticket[1];

  // The year lives on the event line ("Black Rock City: Access 2024"); the
  // date itself ("8/21 & Later") carries no year at all.
  const year = text.match(/Access\s+(\d{4})/);
  // Anchor on "M/D & Later", NOT on the label in front of it. The vendor has
  // now used at least three labels for the same field:
  //
  //   2024   "Placement Setup Pass (SAP) 8/23 & Later"
  //   2026   "Placement Setup Pass 8/25 & Later"        (the camp allocation)
  //   2026   "Setup Access Pass 8/27 & Later"           (a single pass)
  //
  // Matching the label cost a whole import the first time it changed, and the
  // date format itself has never moved. Prefer a line that also says "Pass" so
  // a stray "8/27 & Later" elsewhere on the page can't win; fall back to the
  // page if the wording drifts again.
  const dateRe = /(\d{1,2})\/(\d{1,2})\s*&\s*Later/;
  const passLine = items.find((s) => /pass/i.test(s) && dateRe.test(s));
  const md = (passLine ?? text).match(dateRe);
  if (year?.[1] && md?.[1] && md?.[2]) {
    const y = Number(year[1]);
    const m = Number(md[1]);
    const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      fields.eventYear = y;
      fields.onOrAfterDate = `${y}-${String(m).padStart(2, "0")}-${String(
        d,
      ).padStart(2, "0")}`;
    }
  }

  // Runs to end of line: the code contains "/" and "+", so anything cleverer
  // than "the rest of the line" risks truncating it.
  const sec = text.match(/Security code:\s*(\S+)/);
  if (sec?.[1]) fields.securityCode = sec[1];

  // The label and its value are separate text items in the right-hand column.
  // Prefer "the next non-empty item after the label" over pattern-matching the
  // value, because the confirmation format is the vendor's to change.
  const labelAt = items.findIndex((s) => /Confirmation Id/i.test(s));
  if (labelAt >= 0) {
    const inline = (items[labelAt] ?? "").match(
      /Confirmation Id[:\s]+([A-Z0-9-]{6,})/i,
    );
    const next = items[labelAt + 1]?.trim();
    if (inline?.[1]) fields.confirmationId = inline[1];
    else if (next && /^[A-Z0-9-]{6,}$/i.test(next))
      fields.confirmationId = next;
  }

  return fields;
}
