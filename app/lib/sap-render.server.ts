/**
 * Our own rendering of Setup Access Passes — a whole travel group on one sheet
 * (`plans/sap-import-and-distribution.md`).
 *
 * The vendor gives one full page per pass. A household arriving in one vehicle
 * then carries six sheets to hand over one at a time, in the dark, in dust. This
 * puts the group on a single page: one row per pass, each with the name it's
 * for, the date it admits, a QR, a Code128 and the security code in text.
 *
 * The codes are **regenerated from the values we hold**, not cropped out of the
 * vendor's artwork — which is why this is possible at all, and why the result
 * is sharper than the original (the vendor's QR is a 174px JPEG; ours is vector-
 * clean at any size). The scan code behind both symbologies is the same value
 * the vendor encoded, recovered at import.
 *
 * The vendor's conditions of use travel with it. A camp-made sheet that quietly
 * dropped "NOT A TICKET" and the no-redistribution warning would be a worse
 * document than the one it replaces, so that text is not optional here.
 */
import bwipjs from "bwip-js/node";
import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";

/** One pass on the sheet. Codes required — this renderer is only ever called
 * for released passes. */
export type SheetPass = {
  holderName: string;
  onOrAfterDate: string;
  scanCode: string;
  securityCode: string;
  vendorTicketId: string;
};

/**
 * Draw text the built-in fonts can actually encode.
 *
 * pdf-lib's `StandardFonts` are WinAnsi, and `drawText` **throws** on anything
 * outside it — so one camper named 李明 would take down the whole group's
 * sheet, at the point of use, days before the event. Accented Latin (é, ü, ñ,
 * þ) is in WinAnsi and passes through untouched; anything else is stripped to
 * its base letter if that helps, and otherwise becomes "?".
 *
 * The right long-term fix is an embedded Unicode font (fontkit + a TTF). Until
 * then a name that renders imperfectly beats a sheet that doesn't render.
 */
const encodable = new Map<string, boolean>();
function safeText(font: PDFFont, text: string): string {
  const canEncode = (ch: string): boolean => {
    const key = `${font.name}:${ch}`;
    const cached = encodable.get(key);
    if (cached !== undefined) return cached;
    let ok = true;
    try {
      font.widthOfTextAtSize(ch, 10);
    } catch {
      ok = false;
    }
    encodable.set(key, ok);
    return ok;
  };

  let out = "";
  for (const ch of text) {
    if (canEncode(ch)) {
      out += ch;
      continue;
    }
    // "ā" → "a" is a better answer than "?"; 李 has no such fallback.
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    out += base && base !== ch && canEncode(base) ? base : "?";
  }
  return out;
}

/** `drawText`, but it can't throw on a person's name. */
function put(
  page: PDFPage,
  text: string,
  o: {
    x: number;
    y: number;
    size: number;
    font: PDFFont;
    color?: ReturnType<typeof rgb>;
  },
): void {
  page.drawText(safeText(o.font, text), o);
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
/** Tall enough for a 96pt QR plus the two text lines beside it. */
const ROW_H = 118;
const PER_PAGE = 5;

/** The vendor's conditions, carried over verbatim in substance. */
const CONDITIONS =
  "This Setup Access Pass (SAP) is NOT A TICKET and on its own does not grant access to " +
  "Black Rock City before the event officially starts — it is only valid when used in " +
  "conjunction with a ticket or credential. Anyone discovered to have copied SAPs or " +
  "distributed them beyond their project or approved purpose is subject to having all of " +
  "their group's SAPs cancelled.";

/**
 * A printable sheet for one travel group.
 *
 * `groupLabel` names the party it belongs to ("Albert's party", "Grace Crew"),
 * because the sheet's whole job is to be the one piece of paper a group carries
 * — and a stack of anonymous sheets is the problem it set out to solve.
 */
export async function renderGroupSheet(opts: {
  groupLabel: string;
  year: number;
  passes: SheetPass[];
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  // Generate every symbol up front: embedding is per-document, and a group of
  // six otherwise re-runs the encoder inside the layout loop.
  const symbols = await Promise.all(
    opts.passes.map(async (p) => ({
      qr: await doc.embedPng(await barcodePng("qrcode", p.scanCode)),
      bars: await doc.embedPng(await barcodePng("code128", p.scanCode)),
    })),
  );

  const pageCount = Math.max(1, Math.ceil(opts.passes.length / PER_PAGE));
  for (let pageNo = 0; pageNo < pageCount; pageNo++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    y = drawHeader(page, { font, bold }, opts, pageNo, pageCount, y);

    const slice = opts.passes.slice(
      pageNo * PER_PAGE,
      pageNo * PER_PAGE + PER_PAGE,
    );
    for (const [i, pass] of slice.entries()) {
      const sym = symbols[pageNo * PER_PAGE + i];
      if (sym) drawPass(page, { font, bold, mono }, pass, sym, y);
      y -= ROW_H;
    }

    drawConditions(page, font, MARGIN);
  }

  return doc.save();
}

function drawHeader(
  page: PDFPage,
  fonts: { font: PDFFont; bold: PDFFont },
  opts: { groupLabel: string; year: number; passes: SheetPass[] },
  pageNo: number,
  pageCount: number,
  top: number,
): number {
  let y = top;
  put(page, `Setup Access Passes — ${opts.groupLabel}`, {
    x: MARGIN,
    y: y - 14,
    size: 15,
    font: fonts.bold,
  });
  y -= 32;

  const count = opts.passes.length;
  const pageOf = pageCount > 1 ? ` · page ${pageNo + 1} of ${pageCount}` : "";
  const summary = `${opts.year} · ${count} pass${count === 1 ? "" : "es"}${pageOf}`;
  put(page, summary, { x: MARGIN, y: y - 10, size: 9.5, font: fonts.font });
  y -= 20;

  // Each row is scanned separately at the gate, so say whose is whose.
  put(
    page,
    "Each pass below admits ONE person, on or after its date. Present with a valid ticket.",
    {
      x: MARGIN,
      y: y - 10,
      size: 9,
      font: fonts.font,
      color: rgb(0.3, 0.3, 0.3),
    },
  );
  y -= 24;

  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 0.75,
    color: rgb(0.7, 0.7, 0.7),
  });
  return y - 8;
}

function drawPass(
  page: PDFPage,
  fonts: { font: PDFFont; bold: PDFFont; mono: PDFFont },
  pass: SheetPass,
  sym: {
    qr: Awaited<ReturnType<PDFDocument["embedPng"]>>;
    bars: Awaited<ReturnType<PDFDocument["embedPng"]>>;
  },
  top: number,
): void {
  const qrSize = 92;
  const qrX = MARGIN;
  const qrY = top - qrSize - 4;
  page.drawImage(sym.qr, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const textX = qrX + qrSize + 16;
  let y = top - 14;

  put(page, pass.holderName, {
    x: textX,
    y,
    size: 13,
    font: fonts.bold,
  });
  y -= 17;

  put(page, `Admits on or after ${humanDate(pass.onOrAfterDate)}`, {
    x: textX,
    y,
    size: 10.5,
    font: fonts.font,
  });
  y -= 16;

  // The barcode is what most gate scanners take; the QR is the backup, and the
  // digits under it are the fallback when neither reads in the dust.
  page.drawImage(sym.bars, { x: textX, y: y - 30, width: 190, height: 30 });
  put(page, pass.scanCode, {
    x: textX + 200,
    y: y - 20,
    size: 12,
    font: fonts.mono,
  });
  y -= 44;

  put(page, `Security code: ${pass.securityCode}`, {
    x: textX,
    y,
    size: 7.5,
    font: fonts.mono,
    color: rgb(0.25, 0.25, 0.25),
  });
  y -= 11;
  put(page, `Ticket ID ${pass.vendorTicketId}`, {
    x: textX,
    y,
    size: 7.5,
    font: fonts.font,
    color: rgb(0.45, 0.45, 0.45),
  });

  page.drawLine({
    start: { x: MARGIN, y: top - ROW_H + 8 },
    end: { x: PAGE_W - MARGIN, y: top - ROW_H + 8 },
    thickness: 0.5,
    color: rgb(0.85, 0.85, 0.85),
  });
}

/** The vendor's conditions, wrapped to the page width and pinned to the foot. */
function drawConditions(page: PDFPage, font: PDFFont, x: number): void {
  const size = 7;
  const width = PAGE_W - MARGIN * 2;
  const lines = wrap(CONDITIONS, font, size, width);
  let y = MARGIN + lines.length * (size + 2);
  for (const line of lines) {
    put(page, line, { x, y, size, font, color: rgb(0.4, 0.4, 0.4) });
    y -= size + 2;
  }
}

function wrap(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** "2026-08-24" → "Mon, Aug 24". Spelled-out weekday because "is my pass good
 * for Monday?" is the only question anyone asks of this date. */
function humanDate(iso: string): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  // UTC-anchored so the weekday can't shift a day across timezones — same
  // reasoning as `dayChip` in arrival.ts.
  const date = new Date(Date.UTC(y, m - 1, d));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** A barcode as a PNG. Scale 3 keeps it crisp when printed at the sizes above. */
async function barcodePng(
  bcid: "qrcode" | "code128",
  text: string,
): Promise<Uint8Array> {
  const png = await bwipjs.toBuffer({
    bcid,
    text,
    scale: 3,
    // White, not transparent: a transparent barcode over a dark background is
    // unscannable, and printers do surprising things with alpha.
    backgroundcolor: "FFFFFF",
    ...(bcid === "code128" ? { height: 10, includetext: false } : {}),
  });
  return new Uint8Array(png);
}
