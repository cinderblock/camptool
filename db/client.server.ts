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
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle({ client: sqlite, schema });
// The raw bun:sqlite handle + resolved path — used by the admin DB backup
// (super-admin only). `sqlite.serialize()` yields a consistent whole-db snapshot.
export { schema, sqlite, dbPath };

// Apply pending migrations on startup so a self-hoster never has to run a
// separate command. Idempotent: drizzle tracks applied migrations in-db.
// Resolved from the project root (cwd) so it works in both dev and the built
// server bundle, which lives under build/.
migrate(db, { migrationsFolder: resolve(cwd(), "db/migrations") });
