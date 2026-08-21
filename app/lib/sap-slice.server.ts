/**
 * Cutting one Setup Access Pass out of the vendor's multi-page PDF, without
 * handing the recipient everybody else's pass.
 *
 * This module exists because of a real defect in how the camp did it by hand.
 * Every per-person file produced from the 2024 order draws a single page — and
 * still carries **all 26 QR codes from the whole order** inside it, because a
 * PDF page's `/Resources /XObject` dictionary lists every image in the source
 * document, and any copy that keeps the dictionary keeps the images. Decoding
 * them back out is a few lines of script. (Those codes are long expired; the
 * pattern is not.)
 *
 * So: **prune before copying.** Work out which images the page actually paints,
 * drop every other entry from the source page's resource dictionary, and only
 * then copy the page into a fresh document — so the copier never has a reason
 * to bring the others along.
 *
 * And then check. `sliceSapPage` re-opens its own output and refuses to return
 * a file containing an image the page doesn't draw. The invariant is deliberately
 * about *presence vs use* rather than about decoding QR codes, because it holds
 * whatever the vendor changes the artwork to: an image nobody draws has no
 * business being in a file we hand to a camper.
 *
 * See `plans/sap-import-and-distribution.md`.
 */
import { inflateRawSync, inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";

/** Thrown when the produced file would leak, or doesn't contain what it should.
 * Never caught to "carry on anyway" — a leaky pass must not reach a camper. */
export class SapSliceError extends Error {}

/**
 * Extract page `pageIndex` (0-based) as a standalone one-page PDF.
 *
 * `expectedScanCode`, when given, is verified against the QR actually present
 * in the output — cheap insurance that page N of the file really is the pass
 * the database thinks it is, before it goes to a person.
 */
export async function sliceSapPage(
  bytes: Uint8Array,
  pageIndex: number,
  expectedScanCode?: string,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  if (pageIndex < 0 || pageIndex >= src.getPageCount()) {
    throw new SapSliceError(
      `Page ${pageIndex + 1} is outside this ${src.getPageCount()}-page document.`,
    );
  }

  const page = src.getPage(pageIndex);
  const drawn = drawnXObjectNames(src, page.node);
  pruneXObjects(page.node, drawn);

  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageIndex]);
  out.addPage(copied);
  // The source's title/author would name the whole order; a single pass should
  // not carry the order's metadata around.
  out.setTitle("Setup Access Pass");
  out.setProducer("CampTool");
  const result = await out.save();

  await assertNoUndrawnImages(result);
  if (expectedScanCode) await assertScanCode(result, expectedScanCode);
  return result;
}

/**
 * The `/Name` of every image the page's content stream paints, found by
 * scanning for the `Do` operator.
 *
 * Deliberately conservative: anything that fails to decompress, or an inline
 * image, means we could not prove what is used — and this returns `null` for
 * "keep everything", which then trips the leak check downstream rather than
 * silently shipping a pruned file that's missing its own barcode.
 */
function drawnXObjectNames(
  doc: PDFDocument,
  node: { Contents: () => unknown },
): Set<string> | null {
  const streams: PDFRawStream[] = [];
  const contents = node.Contents();
  const push = (v: unknown) => {
    const resolved = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (resolved instanceof PDFRawStream) streams.push(resolved);
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) push(contents.get(i));
  } else {
    push(contents);
  }
  if (streams.length === 0) return null;

  const names = new Set<string>();
  for (const stream of streams) {
    const text = decodeStream(stream);
    if (text === null) return null;
    for (const m of text.matchAll(/\/([^\s/<>[\]()]+)\s+Do\b/g)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return names;
}

/** A content stream as text, or null if we can't read it. */
function decodeStream(stream: PDFRawStream): string | null {
  const filter = stream.dict.lookup(PDFName.of("Filter"));
  const raw = Buffer.from(stream.contents);
  const name = filter instanceof PDFName ? filter.asString() : null;

  try {
    if (name === null) return raw.toString("latin1");
    if (name === "/FlateDecode") {
      try {
        return inflateSync(raw).toString("latin1");
      } catch {
        return inflateRawSync(raw).toString("latin1");
      }
    }
  } catch {
    return null;
  }
  // Anything else (LZW, a filter chain in an array) — don't guess.
  return null;
}

/** Drop every `/XObject` entry the page doesn't paint. No-op when `keep` is
 * null, i.e. when we couldn't establish what's used. */
function pruneXObjects(
  node: { Resources: () => unknown },
  keep: Set<string> | null,
): void {
  if (!keep) return;
  const resources = node.Resources();
  if (!(resources instanceof PDFDict)) return;
  const xobjects = resources.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return;
  for (const key of xobjects.keys()) {
    // PDFName.asString() includes the leading slash; the content stream match
    // does not.
    if (!keep.has(key.asString().replace(/^\//, ""))) xobjects.delete(key);
  }
}

/**
 * The invariant: a file we hand out contains no image that isn't part of what
 * its page shows.
 *
 * "Part of" is reachability, not painting. An image can legitimately be in the
 * file without ever being painted — the SAP background is drawn through a
 * full-size `/SMask`, a second image nothing paints directly. Comparing against
 * pdf.js's painted list therefore rejects perfectly good output. So: walk from
 * the page's resources, following `/SMask` and `/Mask` on images and recursing
 * into Form XObjects, and require that the set reached accounts for **every**
 * image stream in the file.
 *
 * Format-agnostic on purpose. It doesn't care whether a stowaway is a QR code,
 * a barcode or a logo — only that nothing rides along unaccounted for.
 */
async function assertNoUndrawnImages(bytes: Uint8Array): Promise<void> {
  const doc = await PDFDocument.load(bytes);

  let present = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (isImage(obj)) present++;
  }

  const reached = new Set<PDFRawStream>();
  const seenDicts = new Set<PDFDict>();
  const visitResources = (resources: unknown): void => {
    const dict = doc.context.lookupMaybe(resources as never, PDFDict);
    if (!dict || seenDicts.has(dict)) return;
    seenDicts.add(dict);
    const xobjects = doc.context.lookupMaybe(
      dict.get(PDFName.of("XObject")) as never,
      PDFDict,
    );
    if (!xobjects) return;
    for (const key of xobjects.keys()) visitStream(xobjects.get(key));
  };
  /** `[/Indexed <base> <hival> <lookup>]` — the lookup may be a stream. */
  const visitColorSpace = (entry: unknown): void => {
    // Plain lookup, not lookupMaybe: most images name their space (`/DeviceRGB`)
    // and lookupMaybe throws on a type it wasn't asked for.
    const arr = doc.context.lookup(entry as never);
    if (!(arr instanceof PDFArray) || arr.size() < 4) return;
    const family = arr.get(0);
    const name = family instanceof PDFName ? family.asString() : "";
    if (name !== "/Indexed" && name !== "/I") return;
    const lookup = doc.context.lookup(arr.get(3) as never);
    if (lookup instanceof PDFRawStream) reached.add(lookup);
  };
  const visitStream = (entry: unknown): void => {
    const stream = doc.context.lookup(entry as never);
    if (!(stream instanceof PDFRawStream)) return;
    const subtype = stream.dict.lookup(PDFName.of("Subtype"));
    const kind = subtype instanceof PDFName ? subtype.asString() : "";
    if (kind === "/Image") {
      if (reached.has(stream)) return;
      reached.add(stream);
      // Transparency is carried by a companion image; it belongs to this one.
      visitStream(stream.dict.get(PDFName.of("SMask")));
      visitStream(stream.dict.get(PDFName.of("Mask")));
      // An /Indexed colour space keeps its palette in a stream — and the SAP
      // background's palette is itself tagged `/Subtype /Image` (with the
      // parent's width and height copied onto it, though it holds 13 colours in
      // 50 bytes). Without this it counts as a stowaway and the slicer refuses
      // to emit a perfectly good pass.
      visitColorSpace(stream.dict.get(PDFName.of("ColorSpace")));
    } else if (kind === "/Form") {
      visitResources(stream.dict.get(PDFName.of("Resources")));
    }
  };

  for (const page of doc.getPages()) visitResources(page.node.Resources());

  if (present > reached.size) {
    const extra = present - reached.size;
    throw new SapSliceError(
      `Refusing to produce this pass: it contains ${present} images but only ${reached.size} belong to the page. ${extra} image(s) would ride along unseen — this is how a sliced pass leaks other people's codes.`,
    );
  }
}

function isImage(obj: unknown): obj is PDFRawStream {
  if (!(obj instanceof PDFRawStream)) return false;
  const subtype = obj.dict.lookup(PDFName.of("Subtype"));
  return subtype instanceof PDFName && subtype.asString() === "/Image";
}

/** Confirm the QR in a produced file is the pass we meant to produce. */
async function assertScanCode(
  bytes: Uint8Array,
  expected: string,
): Promise<void> {
  const { scanCodesInPdf } = await import("./sap-qr.server");
  const found = await scanCodesInPdf(bytes);
  if (found.length !== 1 || found[0] !== expected) {
    throw new SapSliceError(
      `Refusing to produce this pass: expected exactly one QR code (${expected}), ` +
        `found ${found.length}${found.length ? ` (${found.join(", ")})` : ""}.`,
    );
  }
}
