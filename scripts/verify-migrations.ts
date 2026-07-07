/**
 * Sanity-check the migration chain: apply every journaled migration, in order,
 * to a fresh scratch SQLite DB — the same thing production startup does. Fails
 * loudly on a journal entry whose SQL file is missing (a committed journal
 * must never reference a file that isn't there: the app migrates on boot, so
 * that's a production crash).
 *
 *   bun scripts/verify-migrations.ts
 */
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(tmpdir(), `camptool-verify-${process.pid}.db`);
const db = new Database(path);
db.run("PRAGMA foreign_keys = ON");

const journal = await Bun.file("db/migrations/meta/_journal.json").json();
let applied = 0;
try {
  for (const entry of journal.entries) {
    const file = Bun.file(`db/migrations/${entry.tag}.sql`);
    if (!(await file.exists())) {
      throw new Error(
        `journal references db/migrations/${entry.tag}.sql but the file does not exist`,
      );
    }
    const sql = await file.text();
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) db.run(s);
    }
    applied++;
  }
  const tables = db
    .query("SELECT count(*) n FROM sqlite_master WHERE type = 'table'")
    .get() as { n: number };
  console.log(`OK: ${applied} migrations applied cleanly (${tables.n} tables)`);
} finally {
  db.close();
  unlinkSync(path);
}
