/**
 * Bringing a camp into this install from a bundle (plans/camp-portability.md,
 * "Importing: merge rules" and "User matching").
 *
 * Two steps: `preflight` reads the bundle and this install and says what
 * would happen (problems that block it, warnings, who each person becomes);
 * `applyImport` does it. Host-neutral: raw SQL through `atomic` (one
 * transaction on Bun, one batch on D1), files through `blobs`.
 *
 * A bundle is untrusted input. Nothing in it can update or overwrite a row
 * that's already here (INSERT only; any clash aborts the whole import), it
 * can only fill tables that are a camp's on this install, and it never adds a
 * sign-in method to an account that already exists here.
 *
 * Server-only.
 */
import { Buffer } from "node:buffer";
import { type SQL, sql } from "drizzle-orm";
import { atomic, db } from "../../../db/client.server";
import { parseStructurePacks } from "../../theme/index";
import { PACKS } from "../../theme/packs";
import { blobs } from "../blobs.server";
import { slugProblem } from "../camp-admin.server";
import {
  decodeRows,
  localMigrations,
  type Manifest,
  manifestText,
  sha256,
  verify,
} from "./bundle";
import { campTables, IDENTITY } from "./registry";
import { type Row, type Rows, remapPeople } from "./remap";
import { insertOrder, schemaGraph } from "./schema-graph";

/** Where a bundle's pieces come from: the source's pull API, or a file. */
export type BundleSource = {
  manifest: Manifest;
  signature: string;
  rows(table: string): Promise<string>;
  file(key: string): Promise<Uint8Array>;
};

export type Outcome = "create" | "link" | "claim";

export type PersonPlan = {
  sourceUserId: string;
  name: string;
  email: string;
  /** Their role in the camp, if they're a member. */
  role: string | null;
  outcome: Outcome;
  /** Their account here: new (create, claim placeholder) or existing (link). */
  userId: string;
  why: string;
};

export type Preflight = {
  /** Anything here blocks the import. */
  problems: string[];
  warnings: string[];
  camp: { id: string; name: string; slug: string; slugProblem: string | null };
  people: PersonPlan[];
  rows: number;
  files: number;
};

/** How long hand-offs and old passkeys are honoured (decision 7). */
export const WINDOW_DAYS = 365;

const CLAIM_DOMAIN = "claim.invalid";

/** The placeholder address of a claim (`.invalid` can never be real). */
export const claimEmail = (userId: string) => `claim-${userId}@${CLAIM_DOMAIN}`;

const lower = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

/**
 * Read and check every table's rows against the manifest. Tables that aren't
 * a camp's (or a person's) on this install are not read at all: a bundle
 * can't smuggle in a site admin or another camp's data.
 */
export async function loadRows(
  source: BundleSource,
  trustedPublicKey: string,
): Promise<{ rows: Rows; problems: string[]; ignored: string[] }> {
  const m = source.manifest;
  const problems: string[] = [];
  if (!(await verify(trustedPublicKey, manifestText(m), source.signature))) {
    return {
      rows: new Map(),
      problems: ["The bundle's signature doesn't match the source's key."],
      ignored: [],
    };
  }
  const allowed = new Set<string>([
    ...campTables().keys(),
    ...(IDENTITY as readonly string[]),
  ]);
  const rows: Rows = new Map();
  const ignored: string[] = [];
  for (const [table, info] of Object.entries(m.tables)) {
    if (!allowed.has(table)) {
      ignored.push(table);
      continue;
    }
    const text = await source.rows(table);
    if ((await sha256(text)) !== info.sha256) {
      problems.push(`Rows for ${table} are damaged.`);
      continue;
    }
    const list = decodeRows(text);
    if (list.length !== info.rows)
      problems.push(`Row count for ${table} is off.`);
    rows.set(table, list);
  }
  return { rows, problems, ignored };
}

/** Can this install's schema take the source's rows as they are? */
export function schemaProblems(m: Manifest): string[] {
  const problems: string[] = [];
  const local = new Set(localMigrations());
  const missing = m.migrations.filter((t) => !local.has(t));
  if (missing.length) {
    problems.push(
      `This install is older than the one the camp is leaving (${missing.length} database update${missing.length === 1 ? "" : "s"} missing, e.g. ${missing[0]}). Update CampTool here first.`,
    );
    return problems;
  }
  const graph = schemaGraph();
  for (const [table, info] of Object.entries(m.tables)) {
    const t = graph.get(table);
    if (!t) {
      problems.push(`Table ${table} doesn't exist here.`);
      continue;
    }
    const here = new Set(t.columns.map((c) => c.name));
    for (const c of info.columns) {
      if (!here.has(c))
        problems.push(`Column ${table}.${c} doesn't exist here.`);
    }
    const there = new Set(info.columns);
    for (const c of t.columns) {
      if (!there.has(c.name) && c.notNull && !c.hasDefault) {
        problems.push(
          `Column ${table}.${c.name} is required here but the bundle has no values for it.`,
        );
      }
    }
  }
  return problems;
}

async function selectWhereIn(
  table: string,
  column: string | SQL,
  values: string[],
  extra?: SQL,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += 90) {
    const part = values.slice(i, i + 90);
    out.push(
      ...(await db.all<Row>(
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${typeof column === "string" ? sql.identifier(column) : column} IN (${sql.join(
          part.map((v) => sql`${v}`),
          sql`, `,
        )})${extra ? sql` AND ${extra}` : sql``}`,
      )),
    );
  }
  return out;
}

/**
 * Who each of the camp's people becomes here.
 *
 * Nothing in a bundle proves who anyone is: the old site writes it, and the
 * old site may be anyone. So the only account a bundle may join to the camp
 * is the importer's own (they're signed in here, and the camp's admin handed
 * them the code). Anyone else whose address already has an account here gets
 * a claim: a placeholder holds their place until they prove both sides (sign
 * in at the old site, then to the account here). Everyone else is new.
 */
export async function planPeople(
  rows: Rows,
  importer?: { id: string; email: string } | null,
): Promise<PersonPlan[]> {
  const users = rows.get("user") ?? [];
  const roles = new Map(
    (rows.get("membership") ?? []).map((r) => [
      String(r.user_id),
      String(r.role),
    ]),
  );
  const emails = users.map((u) => lower(u.email));
  const here = new Set<string>();
  // Addresses compare case-insensitively (older rows may not be lowercased).
  for (const u of await selectWhereIn("user", sql`lower(email)`, emails)) {
    here.add(lower(u.email));
  }
  // Addresses kept from merges still name their account.
  for (const a of await selectWhereIn(
    "user_email_alias",
    sql`lower(email)`,
    emails,
  )) {
    here.add(lower(a.email));
  }
  const takenIds = new Set(
    (
      await selectWhereIn(
        "user",
        "id",
        users.map((u) => String(u.id)),
      )
    ).map((u) => String(u.id)),
  );
  const importerSource = importer
    ? users.find((u) => lower(u.email) === lower(importer.email))
    : undefined;

  return users.map((u): PersonPlan => {
    const id = String(u.id);
    const email = String(u.email);
    const base = {
      sourceUserId: id,
      name: String(u.name),
      email,
      role: roles.get(id) ?? null,
    };
    if (importer && u === importerSource) {
      return {
        ...base,
        outcome: "link",
        userId: importer.id,
        why: "You, importing the camp.",
      };
    }
    if (here.has(lower(email))) {
      return {
        ...base,
        outcome: "claim",
        userId: crypto.randomUUID(),
        why: "Has an account here already; they claim their place by signing in on both sites.",
      };
    }
    return {
      ...base,
      outcome: "create",
      userId: takenIds.has(id) ? crypto.randomUUID() : id,
      why: "New here.",
    };
  });
}

/** Where a bundle's files may live: under its own camp, nowhere else. */
export function badFileKey(key: string, campId: string): boolean {
  return (
    !key.startsWith(`${campId}/`) ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("//") ||
    key.length > 300
  );
}

/** Snapshot sections and the table each one's rows belong to. */
const SNAPSHOT_TABLES: Record<string, string> = {
  placement: "placement",
  objects: "map_object",
  occupants: "map_object_occupant",
  zones: "map_zone",
  cables: "map_cable",
  roads: "map_road",
};

/**
 * Does every row stay inside the bundle's own camp? A bundle is written by
 * the old site, which may be hostile: each camp row must carry this camp's
 * id, every reference must point at a row in the bundle (not at a row already
 * here, which could be another camp's), there must be exactly one camp, and
 * map snapshots (restored later, row by row) must hold only this camp's rows.
 */
export function containmentProblems(m: Manifest, rows: Rows): string[] {
  const graph = schemaGraph();
  const paths = campTables(graph);
  const problems = new Set<string>();
  const camps = rows.get("camp") ?? [];
  if (camps.length !== 1 || camps[0]?.id !== m.camp.id) {
    problems.add("The bundle must hold exactly one camp, its own.");
  }
  const ids = new Map<string, Set<unknown>>();
  for (const [t, list] of rows) ids.set(t, new Set(list.map((r) => r.id)));
  const userIds = ids.get("user") ?? new Set();
  for (const [table, list] of rows) {
    if ((IDENTITY as readonly string[]).includes(table)) {
      if (table === "user") continue;
      for (const r of list) {
        if (!userIds.has(r.user_id)) {
          problems.add(`${table} rows must belong to the camp's people.`);
        }
      }
      continue;
    }
    const path = paths.get(table);
    const t = graph.get(table);
    if (!path || !t) continue;
    for (const r of list) {
      if (path.kind === "column" && r[path.column] !== m.camp.id) {
        problems.add(`${table} has rows that belong to another camp.`);
      }
      for (const fk of t.foreignKeys) {
        if (fk.table === "user") continue;
        const v = r[fk.column];
        if (v == null) continue;
        if (!ids.get(fk.table)?.has(v)) {
          problems.add(`${table}.${fk.column} points outside the camp.`);
        }
      }
    }
  }
  for (const snap of rows.get("map_snapshot") ?? []) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(snap.data));
    } catch {
      problems.add("A map snapshot is damaged.");
      continue;
    }
    for (const section of Object.keys(SNAPSHOT_TABLES)) {
      const v = data[section];
      const list = Array.isArray(v) ? v : v ? [v] : [];
      for (const row of list as Record<string, unknown>[]) {
        if (
          (row.campId !== undefined && row.campId !== m.camp.id) ||
          (row.editionId !== undefined && row.editionId !== snap.edition_id)
        ) {
          problems.add("A map snapshot holds another camp's rows.");
        }
      }
    }
  }
  for (const f of m.files) {
    if (badFileKey(f.key, m.camp.id)) {
      problems.add("The bundle has files outside its own camp.");
    }
  }
  return [...problems].slice(0, 10);
}

/** Everything the import would do, without doing it. */
export async function preflight(
  source: BundleSource,
  rows: Rows,
  opts: {
    slug?: string;
    importer?: { id: string; email: string } | null;
    /** The setup link being used, whose own hold on the address doesn't count. */
    linkId?: string;
  } = {},
): Promise<Preflight> {
  const m = source.manifest;
  const problems = schemaProblems(m);
  if (!problems.length) problems.push(...containmentProblems(m, rows));
  const warnings: string[] = [];
  const campRow = rows.get("camp")?.[0];
  const [existing] = await db.all<{ slug: string | null }>(
    sql`SELECT slug FROM camp WHERE id = ${m.camp.id}`,
  );
  if (existing) {
    problems.push(
      `This camp is already on this install${existing.slug ? ` (${existing.slug})` : ""}. To replace it, delete that copy first (Site admin → Camps).`,
    );
  }
  const slug = (opts.slug ?? m.camp.slug ?? "").trim().toLowerCase();
  const slugIssue = slug
    ? await slugProblem(slug, { campId: m.camp.id, linkId: opts.linkId })
    : "Pick an address.";

  const packs = parseStructurePacks(campRow?.structure_packs as string | null);
  const bundled = new Set(PACKS.map((p) => p.key));
  const missingPacks = packs.filter((p) => !bundled.has(p));
  if (missingPacks.length) {
    warnings.push(
      `This install doesn't bundle ${missingPacks.join(", ")}; those structures won't draw here until it does. Their rows still come across.`,
    );
  }
  if (campRow?.discord_guild_id) {
    warnings.push(
      "The camp has a Discord server set. Invite this install's bot to it (Camp settings → Discord server).",
    );
  }
  for (const [t, n] of Object.entries(m.dropped)) {
    if (n) {
      warnings.push(
        `${n} ${t} row${n === 1 ? "" : "s"} stayed behind at the source (they needed someone who isn't in the camp).`,
      );
    }
  }

  const people = problems.length ? [] : await planPeople(rows, opts.importer);
  let total = 0;
  for (const list of rows.values()) total += list.length;
  return {
    problems,
    warnings,
    camp: { id: m.camp.id, name: m.camp.name, slug, slugProblem: slugIssue },
    people,
    rows: total,
    files: m.files.length,
  };
}

// --- Writing ---

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

/** D1 takes at most 100 kB per statement; stay well under. */
const STATEMENT_BYTES = 90_000;

/**
 * INSERTs for `rows`, parents first. References that point forward (a table
 * to itself, or a cycle) go in as NULL and are filled in by UPDATEs at the
 * end, since D1 always enforces foreign keys.
 */
export function insertStatements(rows: Rows): string[] {
  const graph = schemaGraph();
  const order = insertOrder(
    graph,
    [...rows.keys()].filter((t) => rows.get(t)?.length),
  );
  const inserts: string[] = [];
  const updates: string[] = [];
  const done = new Set<string>();
  for (const table of order) {
    const t = graph.get(table);
    if (!t) continue;
    const deferred = new Set(
      t.foreignKeys
        .filter(
          (f) =>
            f.table === table ||
            (!done.has(f.table) && order.includes(f.table)),
        )
        .map((f) => f.column),
    );
    const local = new Set(t.columns.map((c) => c.name));
    let head = "";
    let cols: string[] = [];
    let values: string[] = [];
    let size = 0;
    const flush = () => {
      if (values.length) inserts.push(`${head}${values.join(", ")};`);
      values = [];
      size = 0;
    };
    for (const row of rows.get(table) ?? []) {
      const rowCols = Object.keys(row).filter((c) => local.has(c));
      if (rowCols.join() !== cols.join()) {
        flush();
        cols = rowCols;
        head = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES `;
      }
      const tuple = `(${cols.map((c) => (deferred.has(c) ? "NULL" : lit(row[c]))).join(", ")})`;
      if (tuple.length + head.length > STATEMENT_BYTES) {
        throw new Error(
          `A ${table} row is ${tuple.length} bytes; D1 takes at most 100 kB.`,
        );
      }
      if (size + tuple.length + head.length > STATEMENT_BYTES) flush();
      values.push(tuple);
      size += tuple.length + 2;
      const sets = [...deferred].filter((c) => row[c] != null && local.has(c));
      if (sets.length) {
        updates.push(
          `UPDATE ${q(table)} SET ${sets.map((c) => `${q(c)} = ${lit(row[c])}`).join(", ")} WHERE ${t.primaryKey.map((c) => `${q(c)} = ${lit(row[c])}`).join(" AND ")};`,
        );
      }
    }
    flush();
    done.add(table);
  }
  return [...inserts, ...updates];
}

export type ImportResult = {
  campId: string;
  slug: string;
  people: PersonPlan[];
};

/**
 * Do the import that `plan` describes. All rows land together or not at all;
 * files go first (a stray file is harmless, a row without its file isn't) and
 * are removed again if the rows fail.
 */
export async function applyImport(
  source: BundleSource,
  rows: Rows,
  plan: Preflight,
  opts: { importedByUserId: string | null; now?: Date },
): Promise<ImportResult> {
  if (plan.problems.length) throw new Error(plan.problems[0]);
  if (plan.camp.slugProblem) throw new Error(plan.camp.slugProblem);
  const m = source.manifest;
  const now = opts.now ?? new Date();
  const people = new Map(plan.people.map((p) => [p.sourceUserId, p]));
  const mapUser = (id: string) => people.get(id)?.userId ?? null;

  // The camp's own rows, re-pointed at people here.
  const campRows: Rows = new Map(
    [...rows].filter(([t]) => !(IDENTITY as readonly string[]).includes(t)),
  );
  const { rows: remapped } = remapPeople(campRows, schemaGraph(), mapUser);
  const campRow = remapped.get("camp")?.[0];
  if (campRow) campRow.slug = plan.camp.slug;

  // People: new accounts (with their passkeys and Discord link), and
  // placeholders for claims. Linked accounts get nothing added.
  const userRows: Row[] = [];
  const legacyRows: Row[] = [];
  const existingCreds = new Set(
    (
      await selectWhereIn(
        "legacy_passkey",
        "credential_id",
        (rows.get("passkey") ?? []).map((p) => String(p.credential_id)),
      )
    ).map((p) => String(p.credential_id)),
  );
  for (const u of rows.get("user") ?? []) {
    const p = people.get(String(u.id));
    if (!p || p.outcome === "link") continue;
    if (p.outcome === "create") {
      // The old site's say-so isn't verification here.
      userRows.push({ ...u, id: p.userId, email_verified: 0 });
    } else {
      userRows.push({
        id: p.userId,
        name: u.name,
        email: claimEmail(p.userId),
        email_verified: 0,
        image: u.image ?? null,
        created_at: u.created_at,
        updated_at: u.updated_at,
      });
    }
  }
  const created = (id: unknown) => {
    const p = people.get(String(id));
    return p?.outcome === "create" ? p.userId : null;
  };
  for (const pk of rows.get("passkey") ?? []) {
    const uid = created(pk.user_id);
    if (!uid || existingCreds.has(String(pk.credential_id))) continue;
    legacyRows.push({
      id: crypto.randomUUID(),
      user_id: uid,
      rp_id: m.source.rpId,
      name: pk.name ?? null,
      credential_id: pk.credential_id,
      public_key: pk.public_key,
      counter: pk.counter,
      transports: pk.transports ?? null,
      created_at: pk.created_at ?? now.getTime(),
    });
  }

  const windowEndsAt = now.getTime() + WINDOW_DAYS * 86_400_000;
  const all: Rows = new Map([
    ["user", userRows],
    ["legacy_passkey", legacyRows],
    ...remapped,
    [
      "camp_move_in",
      [
        {
          id: m.move.id,
          camp_id: m.camp.id,
          source_origin: m.source.origin,
          source_camp_url: m.source.campUrl,
          source_rp_id: m.source.rpId,
          public_key: m.move.publicKey,
          imported_by_user_id: opts.importedByUserId,
          created_at: now.getTime(),
          window_ends_at: windowEndsAt,
        },
      ],
    ],
    [
      "camp_move_user",
      plan.people.map((p) => ({
        id: crypto.randomUUID(),
        move_id: m.move.id,
        source_user_id: p.sourceUserId,
        user_id: p.userId,
        outcome:
          p.outcome === "create"
            ? "created"
            : p.outcome === "link"
              ? "linked"
              : "claim",
        email: p.outcome === "claim" ? p.email : null,
      })),
    ],
  ]);
  const statements = insertStatements(all);

  // Only files this import created are removed if it fails: a retried or
  // doubled import must not delete what a first one put there.
  const put: string[] = [];
  try {
    for (const f of m.files) {
      if (badFileKey(f.key, m.camp.id)) {
        throw new Error("The bundle has files outside its own camp.");
      }
      const bytes = await source.file(f.key);
      if ((await sha256(bytes)) !== f.sha256) {
        throw new Error(`File ${f.key} is damaged.`);
      }
      const existed = !!(await blobs.get(f.key));
      await blobs.put(f.key, bytes);
      if (!existed) put.push(f.key);
    }
    await atomic([
      ...statements.map((s) => sql.raw(s)),
      // A camp coming back to a site it once left: stop forwarding it away.
      sql`UPDATE camp_move_out SET state = 'ended' WHERE camp_id = ${m.camp.id} AND state = 'done'`,
    ]);
  } catch (e) {
    for (const k of put) await blobs.delete(k).catch(() => {});
    throw new Error(explain(e));
  }
  return { campId: m.camp.id, slug: plan.camp.slug, people: plan.people };
}

/** A database error, as the importer can act on it. */
function explain(e: unknown): string {
  // Drizzle wraps the driver's error ("Failed to run the query …"); the
  // reason is further down the cause chain.
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 5; i++) {
    parts.push(c instanceof Error ? c.message : String(c));
    c = c instanceof Error ? c.cause : null;
  }
  const msg = parts.join(" | ");
  const unique = msg.match(/UNIQUE constraint failed: ([\w.]+)/);
  if (unique) {
    return `Something in the bundle is already on this install (${unique[1]}). Nothing was imported.`;
  }
  if (/FOREIGN KEY/.test(msg)) {
    return "The bundle's rows don't fit together (a reference points nowhere). Nothing was imported.";
  }
  return parts[0] ?? "The import failed.";
}
