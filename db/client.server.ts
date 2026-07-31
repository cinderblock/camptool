import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH ?? "./data/camptool.db";

const dir = dirname(dbPath);
if (dir && dir !== "." && !existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");

export const db = drizzle({ client: sqlite, schema });
// The raw bun:sqlite handle + resolved path — used by the admin DB backup
// (super-admin only). `sqlite.serialize()` yields a consistent whole-db snapshot.
export { schema, sqlite, dbPath };

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
sqlite.exec("PRAGMA foreign_keys = OFF;");
migrate(db, { migrationsFolder: resolve(cwd(), "db/migrations") });
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
