/**
 * Reading one camp out of this install (plans/camp-portability.md): its rows,
 * its people, its files. Host-neutral (raw SQL through `db`, files through
 * `blobs`), so it runs the same on Bun and on Workers.
 *
 * Server-only.
 */
import { type SQL, sql } from "drizzle-orm";
import { db } from "../../../db/client.server";
import { blobs } from "../blobs.server";
import { campOrigin } from "../camp-host";
import { APEX, CAMP_SUBDOMAINS } from "../env.server";
import {
  encodeRows,
  FORMAT,
  FORMAT_VERSION,
  localMigrations,
  type Manifest,
  sha256,
} from "./bundle";
import {
  type CampPath,
  campTables,
  IDENTITY,
  PEOPLE_SOURCES,
  scrubIdentityRow,
} from "./registry";
import { type Row, type Rows, remapPeople } from "./remap";
import { schemaGraph } from "./schema-graph";

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

const ident = (n: string) => sql.identifier(n);

/** `SELECT <col> FROM <table> WHERE <it belongs to the camp>`, nested for
 * tables that reach the camp through a parent. */
function campFilter(
  table: string,
  paths: Map<string, CampPath>,
  campId: string,
): SQL {
  const p = paths.get(table);
  if (!p) throw new Error(`${table} isn't a camp table`);
  if (p.kind === "root") return sql`${ident("id")} = ${campId}`;
  if (p.kind === "column") return sql`${ident(p.column)} = ${campId}`;
  return sql`${ident(p.column)} IN (SELECT ${ident(p.parentColumn)} FROM ${ident(
    p.parent,
  )} WHERE ${campFilter(p.parent, paths, campId)})`;
}

async function selectIn(table: string, column: string, ids: string[]) {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(
      ...(await db.all<Row>(
        sql`SELECT * FROM ${ident(table)} WHERE ${ident(column)} IN (${sql.join(
          part.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )),
    );
  }
  return out;
}

export type CampExport = {
  manifest: Omit<Manifest, "move">;
  /** Each table's rows as JSON lines (what the manifest's hashes cover). */
  rows: Map<string, string>;
};

/** This install's address for a camp, and its passkeys' RP ID. */
export function campSource(slug: string | null) {
  return {
    origin: APEX.origin,
    campUrl: CAMP_SUBDOMAINS && slug ? campOrigin(slug, APEX) : APEX.origin,
    rpId: APEX.hostname,
  };
}

/** Everything of `campId` that a move carries. */
export async function exportCamp(campId: string): Promise<CampExport> {
  const graph = schemaGraph();
  const paths = campTables(graph);
  const raw: Rows = new Map();
  for (const table of paths.keys()) {
    raw.set(
      table,
      await db.all<Row>(
        sql`SELECT * FROM ${ident(table)} WHERE ${campFilter(table, paths, campId)}`,
      ),
    );
  }
  const campRow = raw.get("camp")?.[0];
  if (!campRow) throw new Error("No such camp.");

  // The camp's people, and their identity rows.
  const people = new Set<string>();
  for (const s of PEOPLE_SOURCES) {
    for (const r of raw.get(s.table) ?? []) {
      const v = r[s.column];
      if (typeof v === "string") people.add(v);
    }
  }
  const ids = [...people].sort();
  for (const table of IDENTITY) {
    const column = table === "user" ? "id" : "user_id";
    const rows = (await selectIn(table, column, ids))
      .map((r) => scrubIdentityRow(table, r))
      .filter((r): r is Row => r !== null);
    raw.set(table, rows);
  }

  const { rows, dropped } = remapPeople(raw, graph, (id) =>
    people.has(id) ? id : null,
  );

  const text = new Map<string, string>();
  const tables: Manifest["tables"] = {};
  for (const [table, list] of rows) {
    const t = graph.get(table);
    const body = encodeRows(list);
    text.set(table, body);
    tables[table] = {
      columns: t?.columns.map((c) => c.name) ?? [],
      rows: list.length,
      sha256: await sha256(body),
    };
  }

  const prefix = `${campId}/`;
  const files: Manifest["files"] = [];
  for (const f of await blobs.list()) {
    if (!f.key.startsWith(prefix)) continue;
    const blob = await blobs.get(f.key);
    if (!blob) continue;
    files.push({
      key: f.key,
      size: f.size,
      sha256: await sha256(await blob.bytes()),
    });
  }

  const slug = (campRow.slug as string | null) ?? null;
  return {
    manifest: {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt: Date.now(),
      migrations: localMigrations(),
      source: campSource(slug),
      camp: { id: campId, slug, name: String(campRow.name) },
      tables,
      files,
      people: people.size,
      dropped: Object.fromEntries(dropped),
    },
    rows: text,
  };
}
