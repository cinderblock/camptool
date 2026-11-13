/**
 * Database host: Cloudflare D1, on Workers. Selected by the `workerd` import
 * condition (see package.json `imports`). See `./types.ts`.
 *
 * Migrations are NOT applied here: D1 can't switch foreign keys off, so they
 * go through `wrangler d1 migrations apply` from the folder that
 * `scripts/d1-migrations.ts` prepares, before a deploy.
 */
import { env } from "cloudflare:workers";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import journal from "../migrations/meta/_journal.json";
import * as schema from "../schema";
import type { AtomicStatement, Db, DbSnapshot } from "./types";

const d1 = env.DB;
const d1Db = drizzle(d1, { schema });

export const db = d1Db as unknown as Db;

const dialect = new SQLiteAsyncDialect();

/**
 * Run writes together: a D1 batch is one transaction, all or nothing.
 *
 * Goes straight to D1's `batch()` rather than Drizzle's: Drizzle 0.45's D1
 * batch assumes every item carries a prepared statement, and a raw
 * `db.run(sql)` item doesn't ("Cannot read properties of undefined (reading
 * 'bind')"). Rendering each statement to SQL + params ourselves works for
 * builders and raw SQL alike.
 */
export async function atomic(statements: AtomicStatement[]): Promise<void> {
  if (statements.length === 0) return;
  const prepared = statements.map((s) => {
    const q = is(s, SQL) ? dialect.sqlToQuery(s) : s.toSQL();
    return d1.prepare(q.sql).bind(...q.params);
  });
  await d1.batch(prepared);
}

/**
 * The whole database as a SQL script (schema, then every row). D1 has no
 * file to copy; a script restores anywhere SQLite runs: `sqlite3 camptool.db <
 * camptool.sql` for a Bun host, `wrangler d1 execute --file` for D1.
 */
export async function dbSnapshot(): Promise<DbSnapshot> {
  const { results: objects } = await d1
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    )
    .all<{ type: string; name: string; sql: string }>();

  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
  const tables = objects.filter((o) => o.type === "table");
  for (const t of tables) lines.push(`${t.sql};`);
  for (const t of tables) {
    const { results: rows } = await d1
      .prepare(`SELECT * FROM "${t.name}"`)
      .all<Record<string, unknown>>();
    for (const row of rows) {
      const cols = Object.keys(row);
      lines.push(
        `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols
          .map((c) => sqlLiteral(row[c]))
          .join(", ")});`,
      );
    }
  }
  for (const o of objects.filter((o) => o.type !== "table")) {
    lines.push(`${o.sql};`);
  }
  lines.push(...(await drizzleMigrationRecord()));
  lines.push("COMMIT;", "");
  return {
    name: "camptool.sql",
    bytes: new TextEncoder().encode(lines.join("\n")),
  };
}

/**
 * The Bun host's record of applied migrations, for the dump. Wrangler records
 * them in `d1_migrations`; Drizzle's migrator (the Bun host) reads
 * `__drizzle_migrations` and runs every migration newer than its newest
 * `created_at`. Without this, a dump restored onto a Bun host would try to
 * create every table again. Only `created_at` (the journal's `when`) is
 * compared, so the hash just says where the row came from.
 */
async function drizzleMigrationRecord(): Promise<string[]> {
  const applied = await d1
    .prepare("SELECT name FROM d1_migrations")
    .all<{ name: string }>()
    .then((r) => new Set(r.results.map((m) => m.name.replace(/\.sql$/, ""))))
    .catch(() => new Set<string>());
  const lines = [
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);',
  ];
  for (const e of journal.entries) {
    if (!applied.has(e.tag)) continue;
    lines.push(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('d1:${e.tag}', ${e.when});`,
    );
  }
  return lines;
}

/** A value as a SQLite literal. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const bytes =
      v instanceof ArrayBuffer
        ? new Uint8Array(v)
        : Array.isArray(v)
          ? Uint8Array.from(v as number[])
          : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replaceAll("'", "''")}'`;
}
