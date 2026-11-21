/**
 * Look inside a camp bundle file (plans/camp-portability.md).
 *
 *   bun scripts/camp-move.ts inspect <file.camptool> <move code>
 *
 * Opens the file with the move code, prints the manifest's summary, and checks
 * every table's and file's hash and the manifest's signature. The signature
 * is checked against the key inside the file, so it proves the file is intact,
 * not where it came from; `/import-camp` also asks the old site for its key.
 */
import { readFileSync } from "node:fs";
import {
  checkBundle,
  parseMoveCode,
  unpackBundle,
} from "../app/lib/camp-move/bundle";

const [cmd, file, code] = process.argv.slice(2);
if (cmd !== "inspect" || !file || !code) {
  console.error("usage: bun scripts/camp-move.ts inspect <file> <move code>");
  process.exit(2);
}
const parsed = parseMoveCode(code);
if (!parsed) {
  console.error("That isn't a move code (camptool-move:1:…).");
  process.exit(2);
}
const parts = await unpackBundle(readFileSync(file), parsed.secret);
const m = parts.manifest;
console.log(`Camp:       ${m.camp.name} (${m.camp.slug ?? "no address"})`);
console.log(`From:       ${m.source.campUrl}`);
console.log(`Made:       ${new Date(m.createdAt).toString()}`);
console.log(
  `Schema:     ${m.migrations.length} migrations, last ${m.migrations.at(-1)}`,
);
console.log(`People:     ${m.people}`);
const tables = Object.entries(m.tables).filter(([, t]) => t.rows > 0);
console.log(
  `Rows:       ${tables.reduce((n, [, t]) => n + t.rows, 0)} in ${tables.length} tables`,
);
console.log(
  `Files:      ${m.files.length} (${(m.files.reduce((n, f) => n + f.size, 0) / 1e6).toFixed(1)} MB)`,
);
for (const [t, n] of Object.entries(m.dropped)) {
  console.log(`Left out:   ${n} ${t} (needed someone not in the camp)`);
}
const problems = await checkBundle(parts, parts.files, m.move.publicKey);
console.log(
  problems.length ? `\nProblems:\n- ${problems.join("\n- ")}` : "\nIntact.",
);
process.exit(problems.length ? 1 : 0);
