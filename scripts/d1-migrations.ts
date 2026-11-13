/**
 * Prepare db/migrations for Cloudflare D1, and refuse migrations D1 would run
 * destructively (plans/hosting-other-camps.md, "D1 migrations").
 *
 *   bun scripts/d1-migrations.ts           write .d1-migrations/ for wrangler
 *   bun scripts/d1-migrations.ts --check   only check (part of db:verify)
 *
 * Why this exists. On Bun, `db/host/bun-sqlite.ts` turns foreign keys OFF
 * around migrations, because drizzle-kit rebuilds a table by creating
 * `__new_x`, copying, `DROP TABLE x` and renaming, and with foreign keys on,
 * that DROP deletes every row that cascades from `x`. D1 can't turn foreign
 * keys off. The closest it has is `PRAGMA defer_foreign_keys`, which defers
 * the *checks* to commit but does NOT stop `ON DELETE CASCADE` / `SET NULL`
 * from firing. So on D1 a rebuild of a table other tables cascade from wipes
 * or nulls their rows, silently.
 *
 * - Every migration up to `D1_BASELINE` predates D1 support. A brand-new D1
 *   database applies them while empty, so their rebuilds cascade nothing.
 * - A later migration that rebuilds a table some foreign key cascades or
 *   sets-null from fails this check. Write that migration by hand instead
 *   (rebuild the children with plain references first, then the parent, then
 *   restore the children), and test it on a copy of real data.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../db/schema";

/** The last migration that existed before D1 support (2026-11-13). `--since
 * N` checks from N instead, e.g. to see what the old rebuilds would do. */
const sinceArg = process.argv.indexOf("--since");
const D1_BASELINE = sinceArg >= 0 ? Number(process.argv[sinceArg + 1]) - 1 : 89;

const root = resolve(import.meta.dir, "..");
const src = join(root, "db/migrations");
/** Hand-written D1 versions of migrations D1 can't run as generated. */
const overrides = join(root, "db/migrations-d1");
const out = join(root, ".d1-migrations");
const checkOnly = process.argv.includes("--check");

/** Tables that some foreign key cascades or sets-null from. */
function cascadeParents(): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const t of Object.values(schema)) {
    if (!is(t, SQLiteTable)) continue;
    const cfg = getTableConfig(t);
    for (const fk of cfg.foreignKeys) {
      const action = fk.onDelete ?? "no action";
      if (action === "no action" || action === "restrict") continue;
      const parent = getTableConfig(fk.reference().foreignTable).name;
      const list = parents.get(parent) ?? [];
      list.push(`${cfg.name} (on delete ${action})`);
      parents.set(parent, list);
    }
  }
  return parents;
}

/** Tables a migration rebuilds the drizzle-kit way. */
function rebuiltTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/DROP TABLE [`"]?(\w+)[`"]?/gi)) {
    const name = m[1] as string;
    if (sql.includes(`__new_${name}`)) out.add(name);
  }
  return [...out];
}

/** drizzle's pragmas, in the form D1 accepts. */
export function forD1(sql: string): string {
  return sql
    .replace(
      /PRAGMA foreign_keys\s*=\s*OFF;?/gi,
      "PRAGMA defer_foreign_keys = on;",
    )
    .replace(
      /PRAGMA foreign_keys\s*=\s*ON;?/gi,
      "PRAGMA defer_foreign_keys = off;",
    );
}

const files = (await readdir(src)).filter((f) => f.endsWith(".sql")).sort();
const parents = cascadeParents();
const problems: string[] = [];
for (const f of files) {
  const n = Number.parseInt(f, 10);
  if (!(n > D1_BASELINE)) continue;
  const sql = await readFile(join(src, f), "utf8");
  for (const t of rebuiltTables(sql)) {
    const kids = parents.get(t);
    if (kids) {
      problems.push(
        `${f} rebuilds \`${t}\`, and on D1 that would delete or null rows in: ${kids.join(", ")}.`,
      );
    }
  }
}
if (problems.length) {
  console.error("D1-unsafe migrations:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nRewrite them by hand so no cascading table is dropped. See the header of scripts/d1-migrations.ts.",
  );
  process.exit(1);
}

if (checkOnly) {
  console.log(`OK: no D1-unsafe migrations after ${D1_BASELINE}.`);
} else {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const replaced = new Set(
    (await readdir(overrides).catch(() => [])).filter((f) =>
      f.endsWith(".sql"),
    ),
  );
  for (const f of files) {
    const from = replaced.has(f) ? join(overrides, f) : join(src, f);
    await writeFile(join(out, f), forD1(await readFile(from, "utf8")));
  }
  console.log(`Wrote ${files.length} D1 migrations to .d1-migrations/`);
}
