/**
 * Reading QR codes out of a PDF — shared by the SAP importer (which needs the
 * scan code, the one field that exists nowhere in the text layer) and by the
 * slicer's safety check (which needs to know what a file we're about to hand
 * out actually contains).
 *
 * Two different questions, two functions, and the difference matters:
 *
 *   `scanCodesInPdf`             what the pages DRAW. What a human sees.
 *   `scanCodesInEmbeddedImages`  what the file CONTAINS, drawn or not. What
 *                                someone with a script can get out of it.
 *
 * On the 2024 order those two answers differ by 25 — see
 * `plans/sap-import-and-distribution.md`.
 */
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "pdf-lib";

/** pdf.js image kinds. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/**
 * pdf.js takes **ownership** of the buffer it is handed and detaches it, so the
 * caller's `Uint8Array` comes back empty and every later reader of those same
 * bytes fails with "No PDF header found". Hand it a copy, always. Every entry
 * point in this feature that touches pdf.js goes through here — the bug is
 * invisible until something downstream re-reads the buffer, which is exactly
 * what the slicer's self-check does.
 */
export function copyForPdfJs(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export type PdfImage = {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
};

/** pdf.js pixel buffer → the RGBA jsQR expects, or null for a kind we don't
 * know how to read. */
export function toRgba(img: PdfImage): Uint8ClampedArray | null {
  const { width, height, kind, data } = img;
  const px = width * height;
  const out = new Uint8ClampedArray(px * 4);

  if (kind === RGBA_32BPP) {
    if (data.length < px * 4) return null;
    // Composite over white rather than passing RGBA straight through. A QR
    // drawn with a transparent background arrives as black pixels at alpha 0;
    // ignoring alpha turns the whole image black and it silently fails to
    // decode — which looks exactly like "this page has no QR".
    for (let i = 0, o = 0; i < px * 4; i += 4, o += 4) {
      const a = (data[i + 3] ?? 255) / 255;
      out[o] = Math.round((data[i] ?? 0) * a + 255 * (1 - a));
      out[o + 1] = Math.round((data[i + 1] ?? 0) * a + 255 * (1 - a));
      out[o + 2] = Math.round((data[i + 2] ?? 0) * a + 255 * (1 - a));
      out[o + 3] = 255;
    }
    return out;
  }
  if (kind === RGB_24BPP) {
    if (data.length < px * 3) return null;
    for (let i = 0, o = 0; i < px * 3; i += 3, o += 4) {
      out[o] = data[i] ?? 0;
      out[o + 1] = data[i + 1] ?? 0;
      out[o + 2] = data[i + 2] ?? 0;
      out[o + 3] = 255;
    }
    return out;
  }
  if (kind === GRAYSCALE_1BPP) {
    // Packed bits, each row padded to a whole byte. A set bit is black here,
    // so invert to get luminance.
    const rowBytes = (width + 7) >> 3;
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * rowBytes + (x >> 3)] ?? 0;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 0 : 255;
        const o = (y * width + x) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return out;
  }
  return null;
}

/** Decode a QR from an already-decoded pixel buffer. */
export function readQr(img: PdfImage): string | null {
  const rgba = toRgba(img);
  if (!rgba) return null;
  return jsQR(rgba, img.width, img.height)?.data?.trim() || null;
}

type PageLike = {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get: (name: string) => unknown };
};

/**
 * The QR painted on one page, or null.
 *
 * Square images only — the page also paints a tall Code128 strip and two large
 * logos. Smallest-first, because the QR is the smallest square thing on a SAP
 * page and the full-page background is both the largest and the most expensive
 * to hand to a decoder.
 */
export async function qrOnPage(
  page: PageLike,
  OPS: { paintImageXObject: number },
): Promise<string | null> {
  const ops = await page.getOperatorList();
  const names: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.paintImageXObject) {
      const name = ops.argsArray[i]?.[0];
      if (typeof name === "string") names.push(name);
    }
  }

  const candidates: PdfImage[] = [];
  for (const name of names) {
    let img: unknown;
    try {
      img = page.objs.get(name);
    } catch {
      continue; // referenced but unresolvable — not something we can read
    }
    const c = img as PdfImage;
    if (!c?.data || !c.width || !c.height) continue;
    if (Math.abs(c.width - c.height) > 1) continue; // a QR is square
    candidates.push(c);
  }
  candidates.sort((a, b) => a.width - b.width);

  for (const img of candidates) {
    const text = readQr(img);
    if (text) return text;
  }
  return null;
}

/** Every QR code the document's pages actually draw, in page order. */
export async function scanCodesInPdf(bytes: Uint8Array): Promise<string[]> {
  const { getDocumentProxy } = await import("unpdf");
  const { OPS } = await import("unpdf/pdfjs");
  const pdf = await getDocumentProxy(copyForPdfJs(bytes));
  const found: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    try {
      const code = await qrOnPage(page, OPS);
      if (code) found.push(code);
    } finally {
      page.cleanup();
    }
  }
  return found;
}

/**
 * Every QR code recoverable from the images **stored** in the file, whether any
 * page draws them or not.
 *
 * This is the recipient-with-a-script view, and the reason the slicer prunes:
 * run it on one of the camp's 2024 hand-made single-page files and it returns
 * 26 codes. Used by the tests and by `scripts/audit-sap-pdf.ts`.
 *
 * Covers `DCTDecode` (the vendor's QR format) and un-predicted `FlateDecode` in
 * DeviceGray/DeviceRGB. It does **not** decode JPX, JBIG2, CCITT, or Flate with
 * a PNG predictor — so a clean result here is strong evidence, not a proof of
 * absence. The structural prune in `sap-slice.server.ts` is the actual defence;
 * this verifies it.
 */
export async function scanCodesInEmbeddedImages(
  bytes: Uint8Array,
): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const found = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const subtype = obj.dict.lookup(PDFName.of("Subtype"));
    if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image")
      continue;
    try {
      const img = decodeEmbeddedImage(obj);
      const text = img && readQr(img);
      if (text) found.add(text);
    } catch {
      // Most embedded images are not QR codes; an unreadable one isn't a
      // finding, and one bad stream must not abort the audit.
    }
  }
  return [...found];
}

/** One stored image as pixels, or null if it isn't in a form we decode. */
function decodeEmbeddedImage(stream: PDFRawStream): PdfImage | null {
  const dict = stream.dict;
  const filter = dict.lookup(PDFName.of("Filter"));
  const name = filter instanceof PDFName ? filter.asString() : null;

  if (name === "/DCTDecode") {
    // A DCTDecode stream's bytes are a JPEG file as-is.
    const raw = jpeg.decode(Buffer.from(stream.contents), { useTArray: true });
    return {
      width: raw.width,
      height: raw.height,
      kind: RGBA_32BPP,
      data: raw.data,
    };
  }
  if (name !== "/FlateDecode") return null;

  // A PNG predictor means the samples are row-filtered; un-filtering them is a
  // job for a real decoder, so decline rather than decode garbage.
  const parms = dict.lookup(PDFName.of("DecodeParms"));
  if (parms instanceof PDFDict) {
    const predictor = parms.lookup(PDFName.of("Predictor"));
    if (predictor instanceof PDFNumber && predictor.asNumber() > 1) return null;
  }

  const width = numberEntry(dict, "Width");
  const height = numberEntry(dict, "Height");
  const bpc = numberEntry(dict, "BitsPerComponent") ?? 8;
  const space = dict.lookup(PDFName.of("ColorSpace"));
  const spaceName = space instanceof PDFName ? space.asString() : null;
  if (!width || !height) return null;

  const data = inflateSync(Buffer.from(stream.contents));
  if (spaceName === "/DeviceGray" && bpc === 1) {
    return { width, height, kind: GRAYSCALE_1BPP, data };
  }
  if (spaceName === "/DeviceGray" && bpc === 8) {
    // Widen to RGB so one code path handles the rest.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const v = data[i] ?? 0;
      rgb[i * 3] = v;
      rgb[i * 3 + 1] = v;
      rgb[i * 3 + 2] = v;
    }
    return { width, height, kind: RGB_24BPP, data: rgb };
  }
  if (spaceName === "/DeviceRGB" && bpc === 8) {
    return { width, height, kind: RGB_24BPP, data };
  }
  return null;
}

function numberEntry(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}
