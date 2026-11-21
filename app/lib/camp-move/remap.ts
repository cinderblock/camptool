/**
 * Re-pointing a camp's rows at different people (plans/camp-portability.md).
 * Pure, over raw rows keyed by SQL column name.
 *
 * Used twice with the same rules:
 * - on export, people who aren't the camp's are cleared (`mapUser` → null);
 * - on import, source user ids become the target's (linked people), and
 *   anyone the import didn't bring is cleared.
 *
 * A cleared NOT NULL user column drops its row, and the drop cascades the way
 * the schema's foreign keys would: NOT NULL children go too, nullable ones are
 * cleared. That's exactly what deleting the account would have done, so the
 * result is a state the app already handles.
 */
import { IDENTITY, JSON_COLUMNS } from "./registry";
import type { SchemaGraph } from "./schema-graph";

export type Row = Record<string, unknown>;
export type Rows = Map<string, Row[]>;

const isIdentity = (t: string) => (IDENTITY as readonly string[]).includes(t);

export type RemapResult = {
  rows: Rows;
  /** Rows left out, per table, because someone they needed isn't coming. */
  dropped: Map<string, number>;
};

export function remapPeople(
  input: Rows,
  graph: SchemaGraph,
  mapUser: (id: string) => string | null,
): RemapResult {
  const rows: Rows = new Map();
  const gone = new Map<string, Set<unknown>>();
  const dropped = new Map<string, number>();
  const drop = (table: string, row: Row) => {
    const t = graph.get(table);
    const key =
      t?.primaryKey.length === 1 ? row[t.primaryKey[0] as string] : undefined;
    if (key !== undefined) {
      if (!gone.has(table)) gone.set(table, new Set());
      gone.get(table)?.add(key);
    }
    dropped.set(table, (dropped.get(table) ?? 0) + 1);
  };

  for (const [table, list] of input) {
    if (isIdentity(table)) {
      rows.set(table, list);
      continue;
    }
    const t = graph.get(table);
    const userFks = (t?.foreignKeys ?? []).filter((f) => f.table === "user");
    const jsonCols = Object.entries(JSON_COLUMNS)
      .filter(([id, rule]) => rule.userIds && id.startsWith(`${table}.`))
      .map(([id, rule]) => [id.slice(table.length + 1), rule] as const);
    const kept: Row[] = [];
    for (const original of list) {
      const row = { ...original };
      let keep = true;
      for (const f of userFks) {
        const v = row[f.column];
        if (typeof v !== "string") continue;
        const m = mapUser(v);
        row[f.column] = m;
        if (m === null && f.notNull) keep = false;
      }
      for (const [col, rule] of jsonCols) {
        if (rule.userIds && typeof row[col] === "string") {
          row[col] = rule.rewrite(row[col] as string, mapUser);
        }
      }
      if (keep) kept.push(row);
      else drop(table, row);
    }
    rows.set(table, kept);
  }

  // Cascade the drops through the camp's own foreign keys.
  let changed = gone.size > 0;
  while (changed) {
    changed = false;
    for (const [table, list] of rows) {
      if (isIdentity(table)) continue;
      const fks = (graph.get(table)?.foreignKeys ?? []).filter((f) =>
        gone.has(f.table),
      );
      if (!fks.length) continue;
      const kept: Row[] = [];
      for (const row of list) {
        let keep = true;
        for (const f of fks) {
          const v = row[f.column];
          if (v == null || !gone.get(f.table)?.has(v)) continue;
          if (f.notNull) keep = false;
          else row[f.column] = null;
        }
        if (keep) kept.push(row);
        else {
          drop(table, row);
          changed = true;
        }
      }
      rows.set(table, kept);
    }
  }
  return { rows, dropped };
}
