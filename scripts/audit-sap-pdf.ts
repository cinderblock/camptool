/**
 * Check what a SAP PDF actually contains, as opposed to what it shows.
 *
 *   bun scripts/audit-sap-pdf.ts <file.pdf> [more.pdf ...]
 *
 * A PDF page's resource dictionary lists every image in the document it came
 * from, so a file "sliced" by copying a page carries every other pass's QR code
 * along with it — invisible on screen, a few lines of script to recover. This
 * reports both numbers: codes **drawn** (what a person sees) and codes
 * **embedded** (what a recipient could extract).
 *
 * Run it on anything before sending it out. If the two numbers differ, the file
 * is carrying passes that don't belong to its recipient.
 *
 * Codes are never printed — only counted. See
 * `plans/sap-import-and-distribution.md`.
 */
import {
  scanCodesInEmbeddedImages,
  scanCodesInPdf,
} from "../app/lib/sap-qr.server";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: bun scripts/audit-sap-pdf.ts <file.pdf> ...");
  process.exit(2);
}

let leaky = 0;
for (const file of files) {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const drawn = await scanCodesInPdf(bytes);
  const embedded = await scanCodesInEmbeddedImages(bytes);
  // Drawn codes can repeat across pages; embedded is a distinct set. Compare
  // distinct-to-distinct so a legitimately repeated code isn't read as a leak.
  const distinctDrawn = new Set(drawn).size;
  const extra = embedded.length - distinctDrawn;

  const verdict =
    extra > 0 ? `LEAKS ${extra} other pass${extra === 1 ? "" : "es"}` : "clean";
  if (extra > 0) leaky++;
  console.log(
    `${extra > 0 ? "!!" : "ok"}  ${file}\n` +
      `      shows ${distinctDrawn} pass(es), contains ${embedded.length} — ${verdict}`,
  );
}

if (leaky > 0) {
  console.log(
    `\n${leaky} of ${files.length} file(s) carry passes they don't show.
Anyone holding one of these can recover the extra codes. Re-cut them
with CampTool's importer rather than sending these.`,
  );
  process.exit(1);
}
console.log(`\nAll ${files.length} file(s) contain only what they show.`);
