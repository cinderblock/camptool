/**
 * Reading and writing a PDF page's content stream as text.
 *
 * A page's drawing instructions are a byte stream, usually Flate-compressed and
 * sometimes split across several objects. Two things in this codebase need it:
 * the slicer, which scans for `Do` operators to learn which images a page
 * actually paints, and the renamer, which rewrites the text-showing operator
 * carrying the purchaser's name.
 *
 * **`latin1`, deliberately.** The stream is binary — PDF text strings in an
 * Identity-H font are raw UTF-16BE bytes, full of NULs — and `latin1` is the one
 * encoding that maps bytes 0–255 to code units 0–255 and back with nothing lost.
 * Treating it as UTF-8 would corrupt every string on the page. Anything derived
 * from this text must be re-encoded the same way.
 */
import { inflateRawSync, inflateSync } from "node:zlib";
import {
  PDFArray,
  type PDFContext,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from "pdf-lib";

/** Just enough of pdf-lib's page node for these two helpers. */
type PageNode = {
  Contents: () => unknown;
  set: (key: PDFName, value: PDFObject) => void;
};

/**
 * A page's whole content stream as latin1 text, or `null` if any part of it
 * couldn't be decompressed.
 *
 * Null means "we could not establish what this page does" — callers must treat
 * that as a refusal, never as an empty page.
 */
export function readPageContent(
  context: PDFContext,
  node: Pick<PageNode, "Contents">,
): string | null {
  const streams: PDFRawStream[] = [];
  const push = (v: unknown) => {
    const resolved = v instanceof PDFRef ? context.lookup(v) : v;
    if (resolved instanceof PDFRawStream) streams.push(resolved);
  };
  const contents = node.Contents();
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) push(contents.get(i));
  } else {
    push(contents);
  }
  if (streams.length === 0) return null;

  let out = "";
  for (const stream of streams) {
    const decoded = decodeStream(stream);
    if (decoded === null) return null;
    // Streams in an array are concatenated with whitespace between them; a
    // token must not be allowed to run into the next stream's first token.
    out += `${decoded}\n`;
  }
  return out;
}

/**
 * Replace a page's content with `text`, as a single **uncompressed** stream.
 *
 * Uncompressed on purpose: these streams are a few kilobytes, the file is
 * delivered once to one person, and a stream anyone can read with `less` is
 * worth more than the three kilobytes Flate would save when something goes
 * wrong at the gate and someone has to look.
 *
 * Any previous multi-stream array is collapsed to this one object, which is why
 * callers must pass the text `readPageContent` gave them, edited — not a
 * fragment.
 */
export function writePageContent(
  context: PDFContext,
  node: PageNode,
  text: string,
): void {
  const bytes = new Uint8Array(Buffer.from(text, "latin1"));
  const stream = PDFRawStream.of(context.obj({ Length: bytes.length }), bytes);
  node.set(PDFName.of("Contents"), context.register(stream));
}

/** One stream as latin1 text, or null if we can't read it. */
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
