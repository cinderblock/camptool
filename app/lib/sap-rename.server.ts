import { inflateSync } from "node:zlib";
/**
 * Putting the **assignee's** name on a Setup Access Pass, in place of the
 * purchaser's.
 *
 * Every page of a camp's SAP order carries the name of whoever bought the
 * allocation — one person, repeated on all 26 pages. A camper handed that file
 * sees a stranger's name on their own pass and cannot tell which one is theirs.
 * This module rewrites that one field.
 *
 * ## What it actually does
 *
 * The name is a single isolated text block in the page's content stream:
 *
 *     BT 75.000 672.000 Td /F1 11.0 Tf 0.000 Tw ( C a m e r o n   T a c k l i n d) Tj ET
 *
 * (The spacing is an artefact of looking at UTF-16BE bytes as latin1 — every
 * character is two bytes with a NUL in front.) The string operand is replaced.
 * The old name is **gone from the file**, not painted over: a white rectangle
 * would leave it in the text layer for anyone running `pdftotext`, which is a
 * worse outcome than not doing this at all.
 *
 * ## Three things are verified before the file is returned
 *
 * The vendor's layout is not ours and has already moved once (see the label
 * change between 2024 and 2026 in `sap-pdf.server.ts`), so nothing here trusts
 * a coordinate or a magic string:
 *
 *   1. **Which block is the name** — the leftmost upright text block on the
 *      topmost text line, cross-checked against being first in stream order.
 *      Anything recognisable as one of the other fields disqualifies it.
 *   2. **The font can draw it** — the embedded OpenSans subset is addressed by
 *      Unicode codepoint through a `CIDToGIDMap`, so a character with no glyph
 *      renders as nothing at all. Every character is looked up first, and the
 *      name is measured so a long one is shrunk rather than run into the
 *      "Face Value" column beside it.
 *   3. **Nothing else changed** — the caller re-reads the produced page and
 *      confirms the ticket ID, date and security code are still exactly what
 *      they were, and that the old name is really absent.
 *
 * Any of those failing throws. A pass that got edited in a way we can't verify
 * must not reach a person; the caller falls back to the untouched vendor page.
 *
 * See `plans/sap-holder-name-on-pass.md`.
 */
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from "pdf-lib";
import { readPageContent, writePageContent } from "./pdf-content.server";

export class SapRenameError extends Error {}

/** What the page said before, and what it says now. */
export type RenameOutcome = { from: string; to: string };

/** One BT…ET text block, located and decoded. */
export type TextBlock = {
  /** Offsets into the content text, so the block can be spliced back. */
  start: number;
  end: number;
  body: string;
  x: number;
  y: number;
  /** Drawn with a rotated text matrix — the vendor's sideways ticket ID. */
  rotated: boolean;
  fontKey: string;
  fontSize: number;
  text: string;
};

/**
 * Rewrite the purchaser's name on `page` to `newName`, in place.
 *
 * Mutates the page's content stream on the document it was loaded from. Returns
 * what was replaced so the caller can verify the old value is gone.
 */
export function renameHolderOnPage(
  doc: PDFDocument,
  pageIndex: number,
  newName: string,
): RenameOutcome {
  const name = newName.trim().replace(/\s+/g, " ");
  if (name.length === 0)
    throw new SapRenameError("No name to put on the pass.");

  const page = doc.getPage(pageIndex);
  const content = readPageContent(doc.context, page.node);
  if (content === null) {
    throw new SapRenameError(
      "This pass's page content could not be read, so its name can't be changed.",
    );
  }

  const blocks = textBlocks(content);
  const target = purchaserNameBlock(blocks);

  // The person who bought the allocation is a camper too. When a pass is
  // assigned to them the page is already right, and rewriting it would be work
  // that could only introduce a difference.
  if (target.text === name) return { from: target.text, to: name };

  const font = loadCidFont(doc, page.node, target.fontKey);

  const missing = [...name].filter((ch) => !font.hasGlyph(ch));
  if (missing.length > 0) {
    throw new SapRenameError(
      `The pass's font has no glyph for ${JSON.stringify(missing.join(""))}, so that name would print blank.`,
    );
  }

  // The vendor's own string starts with a space; keeping it holds the text in
  // the same place rather than shifting it a space-width left.
  const drawn = ` ${name}`;
  const size = fittedSize(drawn, target, blocks, font);
  const replacement = target.body
    .replace(/\((?:[^()\\]|\\.)*\)\s*Tj/, `${hexString(drawn)} Tj`)
    // Drop any further Tj in this block: the name is one string, and leaving a
    // second would print the tail of the old one after the new name.
    .replace(/(\bTj\b[\s\S]*?)\((?:[^()\\]|\\.)*\)\s*Tj/g, "$1")
    .replace(/\/(\S+)\s+([\d.]+)\s+Tf/, `/$1 ${size.toFixed(1)} Tf`);

  writePageContent(
    doc.context,
    page.node,
    content.slice(0, target.start) + replacement + content.slice(target.end),
  );
  return { from: target.text, to: name };
}

/**
 * Every `BT…ET` block, with where it sits and what it says.
 *
 * Exported for tests, which run it against captured content-stream snippets
 * rather than needing a PDF — the same arrangement `parseTextFields` uses in
 * `sap-pdf.server.ts`, and for the same reason: a real vendor file can't live
 * in the repo.
 */
export function textBlocks(content: string): TextBlock[] {
  const out: TextBlock[] = [];
  for (const m of content.matchAll(/BT[\s\S]*?ET/g)) {
    const body = m[0];
    const at = m.index ?? 0;
    const td = body.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+Td/);
    const tm = body.match(
      /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/,
    );
    const tf = body.match(/\/(\S+)\s+([\d.]+)\s+Tf/);
    const strings = [...body.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map(
      (s) => s[1] ?? "",
    );
    if (strings.length === 0) continue;
    out.push({
      start: at,
      end: at + body.length,
      body,
      x: Number(td?.[1] ?? tm?.[5] ?? Number.NaN),
      y: Number(td?.[2] ?? tm?.[6] ?? Number.NaN),
      // A plain `Td` is upright; a `Tm` here is the vendor's rotated column.
      rotated: !td && !!tm,
      fontKey: tf?.[1] ?? "",
      fontSize: Number(tf?.[2] ?? 0),
      text: decodeUtf16Operand(strings.join("")),
    });
  }
  return out;
}

/** `( C a m e r o n)` as latin1 → `Cameron`. */
function decodeUtf16Operand(operand: string): string {
  const unescaped = operand.replace(/\\([()\\])/g, "$1");
  let out = "";
  for (let i = 0; i + 1 < unescaped.length; i += 2) {
    out += String.fromCharCode(
      (unescaped.charCodeAt(i) << 8) | unescaped.charCodeAt(i + 1),
    );
  }
  return out.trim();
}

/** A name as a PDF hex string of UTF-16BE code units — `<00200043…>`.
 * Hex rather than a literal `(…)`, so no byte ever needs escaping — a name
 * containing `(` or `\` would otherwise corrupt the content stream. */
export function hexString(text: string): string {
  let hex = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    hex += cp.toString(16).padStart(4, "0");
  }
  return `<${hex}>`;
}

/** Text that means the block is one of the vendor's own fields, not a person. */
const NOT_A_NAME =
  /ticket|confirmation|security|face value|black rock|burning man|copyright|instruction|later|access|pass|valid|print|desert|powered/i;

/**
 * The block carrying the purchaser's name.
 *
 * Structural, not positional: the topmost line of upright text, and the
 * leftmost block on it. Verified against the real 2024 and 2026 orders, where
 * that block is also the first in stream order — both signals must agree, since
 * either one alone could survive a layout change while pointing at the wrong
 * thing.
 */
export function purchaserNameBlock(blocks: TextBlock[]): TextBlock {
  const upright = blocks.filter(
    (b) => !b.rotated && Number.isFinite(b.y) && b.text.length > 0,
  );
  if (upright.length === 0) {
    throw new SapRenameError("No text found on this pass to change.");
  }
  const topY = Math.max(...upright.map((b) => b.y));
  const onTopLine = upright
    .filter((b) => Math.abs(b.y - topY) < 1)
    .sort((a, b) => a.x - b.x);
  const candidate = onTopLine[0];
  if (!candidate) throw new SapRenameError("No name field found on this pass.");

  const firstInStream = blocks.find((b) => b.text.length > 0);
  if (firstInStream && firstInStream.start !== candidate.start) {
    throw new SapRenameError(
      "This pass's layout doesn't match the one we know how to edit — the top-left text isn't the name field.",
    );
  }
  if (NOT_A_NAME.test(candidate.text) || /\d/.test(candidate.text)) {
    throw new SapRenameError(
      `Refusing to overwrite ${JSON.stringify(candidate.text)} — that doesn't look like the purchaser's name.`,
    );
  }
  if (candidate.text.length > 60) {
    throw new SapRenameError(
      "The name field on this pass is unexpectedly long.",
    );
  }
  return candidate;
}

/**
 * Shrink the type if the new name would run into whatever sits to its right —
 * on the real orders that's the "Face Value $0.00" column, about 168pt away.
 * Most names need no shrinking at all; a very long one gets smaller rather than
 * overlapping, because an unreadable pass is worse than a small one.
 */
function fittedSize(
  drawn: string,
  target: TextBlock,
  blocks: TextBlock[],
  font: CidFont,
): number {
  const rightNeighbour = blocks
    .filter((b) => !b.rotated && Math.abs(b.y - target.y) < 1 && b.x > target.x)
    .sort((a, b) => a.x - b.x)[0];
  // Nothing to its right: the page edge, less a generous margin.
  const available = (rightNeighbour?.x ?? 560) - target.x - 8;
  const widthAt = (size: number) => (font.widthOf(drawn) / 1000) * size;

  let size = target.fontSize || 11;
  while (size > 6 && widthAt(size) > available) size -= 0.5;
  return size;
}

/** The embedded CID font behind a `/Fn` resource name. */
type CidFont = {
  hasGlyph: (ch: string) => boolean;
  /** Width of a string in 1/1000 em. */
  widthOf: (text: string) => number;
};

/**
 * Read the page's font well enough to answer "can it draw this, and how wide?"
 *
 * The SAP font is a Type0/Identity-H CIDFontType2 whose CIDs are Unicode
 * codepoints, mapped to glyphs by a `CIDToGIDMap` stream — two big-endian bytes
 * per codepoint, where **0 means no glyph**. That table is the whole reason this
 * module can promise a name will actually appear.
 */
function loadCidFont(
  doc: PDFDocument,
  node: { Resources: () => unknown },
  fontKey: string,
): CidFont {
  const fail = (why: string): never => {
    throw new SapRenameError(`Can't read the pass's font (${why}).`);
  };
  const resources = doc.context.lookupMaybe(node.Resources() as never, PDFDict);
  const fonts = resources
    ? doc.context.lookupMaybe(
        resources.get(PDFName.of("Font")) as never,
        PDFDict,
      )
    : null;
  const font = fonts
    ? doc.context.lookupMaybe(fonts.get(PDFName.of(fontKey)) as never, PDFDict)
    : null;
  if (!font) return fail(`no /${fontKey} on the page`);

  const descendants = doc.context.lookup(
    font.get(PDFName.of("DescendantFonts")) as never,
  );
  if (!(descendants instanceof PDFArray) || descendants.size() === 0) {
    return fail("not a composite font");
  }
  const cidFont = doc.context.lookupMaybe(descendants.get(0) as never, PDFDict);
  if (!cidFont) return fail("no descendant font");

  // CIDToGIDMap: 2 bytes per CID, big-endian GID, 0 = .notdef.
  const mapEntry = doc.context.lookup(
    cidFont.get(PDFName.of("CIDToGIDMap")) as never,
  );
  let gidFor: (cp: number) => number;
  if (mapEntry instanceof PDFRawStream) {
    let table: Buffer;
    try {
      table = inflateSync(Buffer.from(mapEntry.contents));
    } catch {
      table = Buffer.from(mapEntry.contents);
    }
    gidFor = (cp) =>
      cp * 2 + 1 < table.length ? table.readUInt16BE(cp * 2) : 0;
  } else {
    // `/Identity` means CID == GID, so every codepoint is nominally drawable.
    // Nothing to check against; trust it rather than refuse.
    gidFor = () => 1;
  }

  const widths = parseWidths(doc, cidFont);
  const defaultWidth =
    doc.context.lookup(cidFont.get(PDFName.of("DW")) as never) instanceof
    PDFNumber
      ? (
          doc.context.lookup(
            cidFont.get(PDFName.of("DW")) as never,
          ) as PDFNumber
        ).asNumber()
      : 1000;

  return {
    hasGlyph: (ch) => gidFor(ch.codePointAt(0) ?? 0) !== 0,
    widthOf: (text) => {
      let total = 0;
      for (const ch of text) {
        total += widths.get(ch.codePointAt(0) ?? 0) ?? defaultWidth;
      }
      return total;
    },
  };
}

/**
 * The `/W` array → `codepoint → width`. Two forms, both in the spec and both
 * seen in the wild: `c [w1 w2 …]` for a run starting at `c`, and
 * `cFirst cLast w` for a range sharing one width.
 */
function parseWidths(doc: PDFDocument, cidFont: PDFDict): Map<number, number> {
  const out = new Map<number, number>();
  const w = doc.context.lookup(cidFont.get(PDFName.of("W")) as never);
  if (!(w instanceof PDFArray)) return out;

  const num = (i: number): number | null => {
    const v = doc.context.lookup(w.get(i) as never);
    return v instanceof PDFNumber ? v.asNumber() : null;
  };

  let i = 0;
  while (i < w.size()) {
    const first = num(i);
    if (first === null) {
      i++;
      continue;
    }
    const next = doc.context.lookup(w.get(i + 1) as never);
    if (next instanceof PDFArray) {
      for (let k = 0; k < next.size(); k++) {
        const width = doc.context.lookup(next.get(k) as never);
        if (width instanceof PDFNumber) out.set(first + k, width.asNumber());
      }
      i += 2;
    } else {
      const last = num(i + 1);
      const width = num(i + 2);
      if (last !== null && width !== null && last >= first) {
        // A pathological range would spin here; the real files use these for
        // short runs, so cap what we'll expand.
        for (let c = first; c <= Math.min(last, first + 2000); c++) {
          out.set(c, width);
        }
      }
      i += 3;
    }
  }
  return out;
}
