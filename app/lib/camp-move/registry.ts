/**
 * What a camp's move carries, table by table (plans/camp-portability.md, "What
 * a camp's export contains"). `registry.test.ts` fails on any table or
 * JSON-ish column nobody has placed here, so a new feature can't leak into
 * (or silently drop out of) a move.
 *
 * - **camp**: the `camp` row and every row reachable from it through a NOT
 *   NULL foreign key. Derived from the schema, not listed.
 * - **identity**: per-person tables, carried only for the camp's people
 *   (`PEOPLE_SOURCES`), scrubbed by `scrubIdentityRow`.
 * - **never**: instance-wide, transient, secret, or someone else's.
 */
import { type SchemaGraph, schemaGraph } from "./schema-graph";

/** Tables a move never carries, and why. */
export const NEVER: Readonly<Record<string, string>> = {
  session:
    "Sign-ins belong to the old install's secret; the login bridge replaces them.",
  verification: "Short-lived ceremony and hand-off rows.",
  super_admin: "Instance role, not the camp's.",
  instance_setting: "Instance-wide settings.",
  camp_setup_link: "Instance admin's links for starting camps.",
  user_email_alias:
    "Merge bookkeeping about other addresses a person had; not needed to sign in, and not the camp's to share.",
  client_error: "Instance telemetry.",
  feedback: "Instance telemetry.",
  password_reset:
    "One-time recovery credentials (decision 6: no passwords move).",
  legacy_passkey:
    "Passkeys for an even older address (a previous move); no browser can use them at a third address.",
};

/** Per-person tables, carried for the camp's people only. */
export const IDENTITY = ["user", "account", "passkey"] as const;

/** Who counts as one of the camp's people: their user rows (and sign-in
 * methods) travel with the camp. Anyone else a camp row points at (someone
 * who left and whose membership is gone, a site admin) is cleared from
 * nullable columns, and rows that can't exist without them are left out,
 * exactly as if that account had been deleted. */
export const PEOPLE_SOURCES: readonly { table: string; column: string }[] = [
  { table: "membership", column: "user_id" },
  { table: "recruit_application", column: "user_id" },
];

/** Account columns that are secrets of the old install or its OAuth apps. */
const ACCOUNT_SECRETS = [
  "access_token",
  "refresh_token",
  "id_token",
  "access_token_expires_at",
  "refresh_token_expires_at",
  "scope",
  "password",
] as const;

/**
 * An identity row as it may leave the install, or null to leave it out.
 * Passwords never move (decision 6): the `credential` account row is dropped,
 * and every OAuth token (minted for the old install's app) is cleared. What's
 * left of a Discord account is the Discord user id, which is what sign-in
 * matches on.
 */
export function scrubIdentityRow(
  table: (typeof IDENTITY)[number],
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  if (table !== "account") return row;
  if (row.provider_id === "credential") return null;
  const out = { ...row };
  for (const c of ACCOUNT_SECRETS) if (c in out) out[c] = null;
  return out;
}

/** Text columns holding structured data, and whether user ids hide inside. */
export type JsonColumn =
  | { userIds: false; why: string }
  | {
      userIds: true;
      /** Rewrite every user id in the stored text; null clears one. */
      rewrite: (text: string, mapUser: (id: string) => string | null) => string;
    };

/**
 * A map snapshot is the edition's map rows as `select()` objects (JS keys),
 * grouped by section (app/routes/dashboard/map.tsx `serializeMap`). Restoring
 * one re-inserts the rows, so their user columns must point at users that
 * exist here.
 */
const SNAPSHOT_SECTIONS: Record<string, string> = {
  placement: "placement",
  objects: "map_object",
  occupants: "map_object_occupant",
  zones: "map_zone",
  cables: "map_cable",
  roads: "map_road",
};

export function userKeysOf(table: string, graph = schemaGraph()): string[] {
  const t = graph.get(table);
  if (!t) return [];
  const userCols = new Set(
    t.foreignKeys.filter((f) => f.table === "user").map((f) => f.column),
  );
  return t.columns.filter((c) => userCols.has(c.name)).map((c) => c.key);
}

function rewriteSnapshot(
  text: string,
  mapUser: (id: string) => string | null,
): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  for (const [section, table] of Object.entries(SNAPSHOT_SECTIONS)) {
    const keys = userKeysOf(table);
    if (!keys.length) continue;
    const value = data[section];
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    for (const row of rows as Record<string, unknown>[]) {
      for (const k of keys) {
        if (typeof row[k] === "string") row[k] = mapUser(row[k] as string);
      }
    }
  }
  return JSON.stringify(data);
}

export const JSON_COLUMNS: Readonly<Record<string, JsonColumn>> = {
  "map_snapshot.data": { userIds: true, rewrite: rewriteSnapshot },
  "map_object.pending_prev": { userIds: false, why: "Geometry only." },
  "map_object.config": { userIds: false, why: "Structure control values." },
  "camp.metadata": { userIds: false, why: "Camp display settings." },
  "camp.structure_packs": { userIds: false, why: "Package names." },
  "camp_edition.banned_kinds": { userIds: false, why: "Kind values." },
  "camp_feature.state": { userIds: false, why: "off / preview / on." },
  "camp_question.show_if_value": { userIds: false, why: "An answer value." },
  "question_answer.value": { userIds: false, why: "A person's answer." },
  "recruit_application.answers": {
    userIds: false,
    why: "{questionId: value}.",
  },
  "structure_kind.outline": { userIds: false, why: "Outline points." },
};

/** Text columns that look structured: each must be in `JSON_COLUMNS` or be
 * plain prose (`PROSE`). Kept loose on purpose; false alarms are cheap. */
export const JSONISH =
  /data|json|state|meta|answers|prev|outline|snapshot|payload|config|kinds|packs|_ids$/;

/** Columns `JSONISH` catches that are plain text. */
export const PROSE: ReadonlySet<string> = new Set([
  "recruit_application.previous_camp",
  "recruit_application.previous_camp_notes",
]);

/** Every table the move derives as the camp's, mapped to how its rows are
 * found: a column pointing at the camp, or a NOT NULL parent that is. */
export type CampPath =
  | { kind: "root" }
  | { kind: "column"; column: string }
  | { kind: "parent"; column: string; parent: string; parentColumn: string };

export function campTables(graph: SchemaGraph = schemaGraph()) {
  const paths = new Map<string, CampPath>();
  paths.set("camp", { kind: "root" });
  const skip = (t: string) =>
    t in NEVER || (IDENTITY as readonly string[]).includes(t);
  for (const t of graph.values()) {
    if (skip(t.name) || t.name === "camp") continue;
    const direct = t.foreignKeys.find((f) => f.table === "camp" && f.notNull);
    if (direct) paths.set(t.name, { kind: "column", column: direct.column });
  }
  // Tables that reach the camp only through a parent (one hop at a time).
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of graph.values()) {
      if (paths.has(t.name) || skip(t.name)) continue;
      const via = t.foreignKeys.find(
        (f) => f.notNull && f.table !== t.name && paths.has(f.table),
      );
      if (via) {
        paths.set(t.name, {
          kind: "parent",
          column: via.column,
          parent: via.table,
          parentColumn: via.targetColumn,
        });
        grew = true;
      }
    }
  }
  return paths;
}
