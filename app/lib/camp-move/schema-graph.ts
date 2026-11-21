/**
 * The database's shape, read from the Drizzle schema: tables, columns, primary
 * keys and foreign keys (plans/camp-portability.md). Moving a camp walks this
 * graph, so it is derived rather than hand-listed: a table added next month
 * joins the move by itself, or fails the registry test until someone says
 * where it belongs.
 *
 * Pure: no database. Both the exporting and the importing install compute it
 * from their own code; the bundle's manifest carries the source's column
 * lists so the target can tell what drifted.
 */
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../db/schema";

export type ColumnInfo = {
  /** SQL name. */
  name: string;
  /** Drizzle's JS key (what a `select()` row and a map snapshot use). */
  key: string;
  notNull: boolean;
  /** Has a SQL or JS default, so an INSERT may leave it out. */
  hasDefault: boolean;
  /** Stored as text, integer, real or blob. */
  sqlType: string;
};

export type ForeignKey = {
  column: string;
  table: string;
  targetColumn: string;
  notNull: boolean;
  onDelete: string;
};

export type TableInfo = {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
};

export type SchemaGraph = Map<string, TableInfo>;

let cached: SchemaGraph | null = null;

/** Every table in this checkout's schema. */
export function schemaGraph(): SchemaGraph {
  if (cached) return cached;
  const out: SchemaGraph = new Map();
  for (const t of Object.values(schema)) {
    if (!is(t, SQLiteTable)) continue;
    const cfg = getTableConfig(t);
    const keyOf = new Map<string, string>();
    for (const [key, col] of Object.entries(t as unknown as object)) {
      if (
        col &&
        typeof col === "object" &&
        "name" in col &&
        "columnType" in col
      ) {
        keyOf.set((col as { name: string }).name, key);
      }
    }
    const columns: ColumnInfo[] = cfg.columns.map((c) => ({
      name: c.name,
      key: keyOf.get(c.name) ?? c.name,
      notNull: c.notNull,
      hasDefault: c.hasDefault,
      sqlType: c.getSQLType(),
    }));
    const pk = cfg.columns.filter((c) => c.primary).map((c) => c.name);
    for (const p of cfg.primaryKeys) pk.push(...p.columns.map((c) => c.name));
    const foreignKeys: ForeignKey[] = [];
    for (const fk of cfg.foreignKeys) {
      const r = fk.reference();
      r.columns.forEach((c, i) => {
        foreignKeys.push({
          column: c.name,
          table: getTableConfig(r.foreignTable).name,
          targetColumn: r.foreignColumns[i]?.name ?? "id",
          notNull: c.notNull,
          onDelete: fk.onDelete ?? "no action",
        });
      });
    }
    out.set(cfg.name, { name: cfg.name, columns, primaryKey: pk, foreignKeys });
  }
  cached = out;
  return out;
}

/** Tables ordered parents before children (self-references ignored). Throws
 * on a cycle through NOT NULL columns, which no insert order could satisfy. */
export function insertOrder(
  graph: SchemaGraph,
  tables: Iterable<string>,
): string[] {
  const want = new Set(tables);
  const order: string[] = [];
  const placed = new Set<string>();
  const parents = (t: string) =>
    (graph.get(t)?.foreignKeys ?? []).filter(
      (f) => f.table !== t && want.has(f.table),
    );
  while (order.length < want.size) {
    const ready =
      [...want].find(
        (t) => !placed.has(t) && parents(t).every((f) => placed.has(f.table)),
      ) ??
      [...want].find(
        (t) =>
          !placed.has(t) &&
          parents(t).every((f) => placed.has(f.table) || !f.notNull),
      );
    if (!ready) throw new Error("foreign-key cycle through NOT NULL columns");
    order.push(ready);
    placed.add(ready);
  }
  return order;
}
