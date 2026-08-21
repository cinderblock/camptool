/**
 * Read a vendor Setup Access Pass PDF and report what CampTool would import.
 *
 *   bun scripts/parse-sap-pdf.ts <file.pdf> [more.pdf ...]     # masked summary
 *   bun scripts/parse-sap-pdf.ts --json --reveal <file.pdf>    # full JSON
 *
 * Secrets are **masked by default**. A parse summary is the sort of thing that
 * gets pasted into a chat window to ask "does this look right?", and a SAP's
 * security and scan codes are the whole value of the pass — so showing them has
 * to be something you asked for on purpose, with `--reveal`.
 *
 * See `plans/sap-import-and-distribution.md`.
 */
import { type SapPageResult, parseSapPdf } from "../app/lib/sap-pdf.server";

const args = process.argv.slice(2);
const json = args.includes("--json");
const reveal = args.includes("--reveal");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error(
    "usage: bun scripts/parse-sap-pdf.ts [--json] [--reveal] <file.pdf> ...",
  );
  process.exit(2);
}

/** Show enough to tell two codes apart, never enough to use one. */
const mask = (s: string) =>
  reveal ? s : `${s.slice(0, 3)}…${s.slice(-2)} (${s.length} chars)`;

let totalOk = 0;
let totalBad = 0;
const everything: Record<string, SapPageResult[]> = {};

for (const file of files) {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const pages = await parseSapPdf(bytes);
  everything[file] = pages;

  const ok = pages.filter((p) => p.ok);
  const bad = pages.filter((p) => !p.ok);
  totalOk += ok.length;
  totalBad += bad.length;

  if (json) continue;

  console.log(`\n=== ${file} — ${pages.length} page(s) ===`);
  for (const p of pages) {
    if (!p.ok) {
      console.log(`  p${p.pageIndex + 1}: UNREADABLE — ${p.reason}`);
      continue;
    }
    console.log(
      `  p${p.pageIndex + 1}: ${p.onOrAfterDate} & later` +
        `  ticket=${p.vendorTicketId}` +
        `  conf=${p.confirmationId ?? "—"}` +
        `  scan=${mask(p.scanCode)}` +
        `  sec=${mask(p.securityCode)}`,
    );
  }

  // The camp cares about the shape of the allocation, not the individual rows.
  const byDate = new Map<string, number>();
  for (const p of ok) {
    if (p.ok)
      byDate.set(p.onOrAfterDate, (byDate.get(p.onOrAfterDate) ?? 0) + 1);
  }
  const shape = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([d, n]) => `${d}×${n}`)
    .join("  ");
  if (shape) console.log(`  allocation: ${shape}`);
}

if (json) {
  const shown = reveal
    ? everything
    : JSON.parse(
        JSON.stringify(everything, (k, v) =>
          (k === "securityCode" || k === "scanCode") && typeof v === "string"
            ? mask(v)
            : v,
        ),
      );
  console.log(JSON.stringify(shown, null, 2));
} else {
  console.log(
    `\n${totalOk} pass(es) read, ${totalBad} unreadable, across ${files.length} file(s).`,
  );
  if (!reveal)
    console.log("Codes masked — pass --reveal to print them in full.");
}
