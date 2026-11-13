/**
 * Database host: Bun + a SQLite file. The default host (firefly, jackson, the
 * Docker image, local dev, `bun test`). See `./types.ts`.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../schema";
import type { AtomicStatement, Db, DbSnapshot } from "./types";

export const dbPath = process.env.DATABASE_PATH ?? "./data/camptool.db";

const dir = dirname(dbPath);
if (dir && dir !== "." && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

/** The raw bun:sqlite handle. Host-specific: only for this module, scripts and
 * the Bun-only e2e harness. App code goes through `db`/`atomic`. */
export const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");

const bunDb = drizzle({ client: sqlite, schema });

/** See `Db` in ./types.ts for why the sync driver is typed async. */
export const db = bunDb as unknown as Db;

/** Run writes together: all land or none do. */
export async function atomic(statements: AtomicStatement[]): Promise<void> {
  if (statements.length === 0) return;
  sqlite.transaction(() => {
    for (const s of statements) {
      // Builders from the sync driver execute synchronously inside `run()`,
      // which is what keeps them inside this transaction.
      if (is(s, SQL)) bunDb.run(s);
      else s.run();
    }
  })();
}

/** The whole database file, WAL included; safe while the app runs. */
export async function dbSnapshot(): Promise<DbSnapshot> {
  return { name: "camptool.db", bytes: new Uint8Array(sqlite.serialize()) };
}

// Apply pending migrations on startup so a self-hoster never has to run a
// separate command. Idempotent: drizzle tracks applied migrations in-db.
// Resolved from the project root (cwd) so it works in both dev and the built
// server bundle, which lives under build/.
//
// Foreign keys MUST be off while migrating. drizzle-kit's generated table
// rebuilds ("__new_x" -> copy -> DROP TABLE x -> RENAME) emit their own
// `PRAGMA foreign_keys=OFF`, but drizzle's migrator wraps every migration in an
// explicit transaction (sqlite-core/dialect: `session.run(sql`BEGIN`)`), and
// SQLite silently IGNORES that pragma inside a transaction. With foreign keys
// live, `DROP TABLE` performs an implicit `DELETE FROM` that fires ON DELETE
// CASCADE on every referencing table — rebuilding `membership` would wipe
// attendees, sign-ups, answers, tickets and more. Earlier rebuilds (0053/0055/
// 0059) only survived because those tables had nothing referencing them.
// Toggling here, outside any transaction, is the only place it actually takes.
// (D1 can't do this at all; see scripts/d1-migrations.ts.)
sqlite.exec("PRAGMA foreign_keys = OFF;");
migrate(bunDb, { migrationsFolder: resolve(cwd(), "db/migrations") });
sqlite.exec("PRAGMA foreign_keys = ON;");

// A rebuild that dropped rows or left a dangling reference must not boot
// silently — surface it while the operator is still watching the deploy.
const fkViolations = sqlite.query("PRAGMA foreign_key_check;").all();
if (fkViolations.length > 0) {
  console.error("[db] foreign key violations after migration:", fkViolations);
  throw new Error(
    `Database has ${fkViolations.length} foreign key violation(s) after migration; refusing to start.`,
  );
}
