/**
 * Make a `wrangler d1 export` load into a fresh D1.
 *
 *   bun scripts/order-d1-dump.ts export.sql ordered.sql
 *   wrangler d1 execute <database> --remote --file ordered.sql
 *
 * The export writes each table's rows right after its CREATE, in
 * sqlite_master order, and D1 checks foreign keys statement by statement
 * during an import (the export's `PRAGMA defer_foreign_keys` doesn't span
 * it). Loaded as is, a child table's rows come before its parent exists ("no
 * such table: main.user") or before the parent's rows do ("FOREIGN KEY
 * constraint failed"). This writes every table first, then the rows parent
 * table first, then indexes, and proves the result loads with foreign keys
 * checked immediately before saving it.
 */
import { Database } from "bun:sqlite";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: bun scripts/order-d1-dump.ts <export.sql> <out.sql>");
  process.exit(2);
}

// One statement per `;` at a line end, as `wrangler d1 export` writes them.
const statements: string[] = [];
let current = "";
for (const line of (await Bun.file(src).text()).split(/\r?\n/)) {
  current += `${line}\n`;
  if (line.trimEnd().endsWith(";")) {
    statements.push(current);
    current = "";
  }
}
if (current.trim()) throw new Error("the export ends mid-statement");

const tableOf = (s: string) =>
  s.match(
    /^(?:CREATE TABLE(?: IF NOT EXISTS)?|INSERT INTO)\s+[`"]?(\w+)/i,
  )?.[1];
const isCreate = (s: string) => /^CREATE TABLE/i.test(s);
const isInsert = (s: string) => /^INSERT INTO/i.test(s);
const isPragma = (s: string) => /^PRAGMA/i.test(s);

// Parent tables before the tables that reference them.
const parents = new Map<string, string[]>();
for (const s of statements.filter(isCreate)) {
  const table = tableOf(s) as string;
  const refs = [...s.matchAll(/REFERENCES\s+[`"]?(\w+)/gi)].map((m) => m[1]);
  parents.set(
    table,
    refs.filter((r) => r !== table),
  );
}
const order: string[] = [];
const done = new Set<string>();
const visiting = new Set<string>();
const visit = (table: string) => {
  if (done.has(table)) return;
  if (visiting.has(table))
    throw new Error(`foreign keys loop through ${table}`);
  visiting.add(table);
  for (const p of parents.get(table) ?? []) visit(p);
  visiting.delete(table);
  done.add(table);
  order.push(table);
};
for (const table of parents.keys()) visit(table);
const rank = new Map(order.map((t, i) => [t, i]));
// Tables with no CREATE (sqlite_sequence) go first; ties keep export order.
const byRank = (a: string, b: string) =>
  (rank.get(tableOf(a) as string) ?? -1) -
  (rank.get(tableOf(b) as string) ?? -1);

const ordered = [
  ...statements.filter(isPragma),
  ...statements.filter(isCreate).sort(byRank),
  ...statements.filter(isInsert).sort(byRank),
  ...statements.filter((s) => !isPragma(s) && !isCreate(s) && !isInsert(s)),
];

// Prove it: immediate foreign key checks, one statement at a time.
const db = new Database(":memory:");
db.run("PRAGMA foreign_keys=ON");
for (const s of ordered) {
  if (/^PRAGMA defer_foreign_keys/i.test(s)) continue;
  db.run(s);
}

await Bun.write(out, ordered.join(""));
console.log(`${ordered.length} statements, ${order.length} tables → ${out}`);
