import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

// merge.server reads foreign keys from the Drizzle schema (portable: no
// database round trip, works on D1). It used to ask SQLite directly. Hold the
// two to agreement on a freshly migrated database, so a migration-only
// foreign key the schema doesn't know about can't slip past a merge.
process.env.DATABASE_PATH = ":memory:";
const { referencesTo } = await import("./merge.server");

const sqlite = new Database(":memory:");
sqlite.exec("PRAGMA foreign_keys = OFF;");
migrate(drizzle({ client: sqlite }), {
  migrationsFolder: resolve(import.meta.dir, "../../db/migrations"),
});

function pragmaRefs(target: string) {
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all();
  const out: string[] = [];
  for (const { name } of tables) {
    for (const fk of sqlite
      .query<{ table: string; from: string }, []>(
        `PRAGMA foreign_key_list("${name}")`,
      )
      .all()) {
      if (fk.table === target) out.push(`${name}.${fk.from}`);
    }
  }
  return out.sort();
}

describe("merge reference sweep", () => {
  for (const target of ["membership", "user", "attendee", "prospect"]) {
    it(`finds every reference to ${target}`, () => {
      const fromSchema = referencesTo(target)
        .map((r) => `${r.table}.${r.column}`)
        .sort();
      expect(fromSchema.length).toBeGreaterThan(0);
      expect(fromSchema).toEqual(pragmaRefs(target));
    });
  }
});
