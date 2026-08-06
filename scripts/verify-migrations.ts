/**
 * Sanity-check the migration chain: apply every journaled migration, in order,
 * to a fresh scratch SQLite DB — the same thing production startup does. Fails
 * loudly on a journal entry whose SQL file is missing (a committed journal
 * must never reference a file that isn't there: the app migrates on boot, so
 * that's a production crash).
 *
 * Also enforces that journal `when` timestamps strictly increase. That is not
 * cosmetic: drizzle's migrator does NOT record which migrations ran. It reads
 * the single newest row of `__drizzle_migrations` and applies only migrations
 * stamped later than it (sqlite-core/dialect.js). A migration whose `when`
 * predates an already-applied one is skipped in silence — no warning, no error,
 * forever. Migration 0066 was lost that way: hand-written 0065 was stamped a
 * fabricated 24h after 0064, landing ahead of the real clock, so the next
 * generated migration sorted *before* it and never ran in production. See
 * plans/migration-timestamp-skip.md.
 *
 * Applying to a fresh DB cannot catch that on its own — a fresh DB has no
 * migration rows, so the timestamp gate is bypassed entirely and any ordering
 * passes. Monotonicity is precisely the invariant that makes "apply in journal
 * order" equivalent to what the gate does on a database with history.
 *
 *   bun scripts/verify-migrations.ts
 */
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Entry = { idx: number; when: number; tag: string };

const journal = (await Bun.file("db/migrations/meta/_journal.json").json()) as {
  entries: Entry[];
};

// Structural checks first — they explain a failure better than a SQL error would.
let prev: Entry | undefined;
for (const [i, entry] of journal.entries.entries()) {
  if (entry.idx !== i) {
    throw new Error(
      `journal entry ${i} ("${entry.tag}") has idx ${entry.idx}; entries must be contiguous and in order`,
    );
  }
  if (prev && entry.when <= prev.when) {
    throw new Error(
      `journal timestamps must strictly increase, but "${entry.tag}" (when ${entry.when}, ${new Date(entry.when).toISOString()}) is not after "${prev.tag}" (when ${prev.when}, ${new Date(prev.when).toISOString()}).
drizzle applies only migrations stamped later than the newest already-applied one, so this migration would be SILENTLY SKIPPED on any database currently at "${prev.tag}". Lower the earlier-authored entry's \`when\` — never raise the later one, which would re-run it on databases that already applied it.`,
    );
  }
  prev = entry;
}

const path = join(tmpdir(), `camptool-verify-${process.pid}.db`);
const db = new Database(path);
db.run("PRAGMA foreign_keys = ON");

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
