/**
 * Move a Bun + SQLite deployment's data onto the Cloudflare build (D1 + R2):
 * every row, every upload, and everyone's sign-ins
 * (plans/hosting-other-camps.md, "Moving a camp onto the shared site").
 *
 *   bun scripts/import-to-d1.ts <backup.tar.gz> --out data/import \
 *     --legacy-rp-id camptool.mathcamp.us \
 *     --rename-slug math-camp-group-w-m0d3=mathcamp  *     --packs mathcamp=@camptool/mathcamp-theme --discord-guild mathcamp=<server id> \
 *     [--apply local|remote] [--persist-to .wrangler/x]
 *
 * The backup is the super admin's download from /export-db on the old site
 * (`camptool.db` plus `uploads/`). The script:
 *
 * 1. brings a copy of the database up to this checkout's schema (the same
 *    migrations the old site would run on boot);
 * 2. moves passkeys to `legacy_passkey` (`--legacy-rp-id`, the old host):
 *    they're bound to the old address and can't sign in here, but the old
 *    address can still check them once (app/lib/legacy-host.server.ts);
 * 3. renames camps (`--rename-slug <old>=<new>`: the slug becomes the camp's
 *    subdomain, and the app has no way to change it), then applies per-camp
 *    settings the old deploy had in env: `--packs
 *    <slug>=<pack,...>` (structure packs, by package name: the old
 *    `CAMP_THEME`; the new site must bundle them in `CAMP_THEMES`) and
 *    `--discord-guild <slug>=<id>` (the old `DISCORD_GUILD_ID`);
 * 4. writes `<out>/data.sql`: clears the rows migrations seed, then one
 *    INSERT per row, parents before children,
 *    with references that would point forward (a table referring to itself,
 *    or a cycle) filled in by UPDATEs at the end, since D1 always enforces
 *    foreign keys;
 * 5. with `--apply`, refuses unless the D1 database holds no users yet, then
 *    runs `data.sql` and uploads each file to R2 under its key.
 *
 * Passwords, Discord links and sessions are rows like any other, so they come
 * across as-is. Keep `BETTER_AUTH_SECRET` the same as the old site's so its
 * session cookies still verify (that's what lets the old address hand people
 * over signed in).
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { isValidCampSlug } from "../app/lib/camp-host";
import { serializeStructurePacks } from "../app/theme/index";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "data/import" },
    "legacy-rp-id": { type: "string" },
    packs: { type: "string", multiple: true, default: [] },
    "discord-guild": { type: "string", multiple: true, default: [] },
    "rename-slug": { type: "string", multiple: true, default: [] },
    apply: { type: "string" },
    "persist-to": { type: "string" },
    bucket: { type: "string", default: "camptool-uploads" },
  },
});

const fail = (msg: string): never => {
  console.error(`import-to-d1: ${msg}`);
  process.exit(1);
};

const source = positionals[0] ?? fail("give the backup .tar.gz (or a folder)");
if (!existsSync(source)) fail(`${source} doesn't exist`);
if (opt.apply && opt.apply !== "local" && opt.apply !== "remote") {
  fail("--apply is local or remote");
}

const out = resolve(opt.out as string);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Unpack and migrate a copy.
let root = source;
if (statSync(source).isFile()) {
  root = join(out, "backup");
  mkdirSync(root);
  // Relative names: Git for Windows' tar reads `C:` as a remote host.
  await $`tar -xzf ${relative(root, resolve(source)).replaceAll("\\", "/")}`.cwd(
    root,
  );
}
const srcDb = join(root, "camptool.db");
if (!existsSync(srcDb)) fail(`no camptool.db in ${source}`);
const work = join(out, "work.db");
copyFileSync(srcDb, work);
console.log("Migrating a copy to this checkout's schema…");
await $`bun -e ${'await import("./db/host/bun-sqlite.ts")'}`.env({
  ...process.env,
  DATABASE_PATH: work,
});

const db = new Database(work);
db.exec("PRAGMA foreign_keys = OFF;");

// 2. Passkeys belong to the old address.
const passkeys = db.query("SELECT count(*) AS n FROM passkey").get() as {
  n: number;
};
if (passkeys.n > 0) {
  const rp =
    opt["legacy-rp-id"] ??
    fail(`${passkeys.n} passkeys: give --legacy-rp-id (the old host name)`);
  db.run(
    `INSERT INTO legacy_passkey
       (id, user_id, rp_id, name, credential_id, public_key, counter, transports, created_at)
     SELECT id, user_id, ?, name, credential_id, public_key, counter, transports, created_at
     FROM passkey`,
    [rp],
  );
  db.run("DELETE FROM passkey");
  console.log(`Moved ${passkeys.n} passkeys to legacy_passkey (${rp}).`);
}

// Short-lived ceremony and hand-off rows mean nothing on the new site.
db.run("DELETE FROM verification");

// 3. Per-camp settings that lived in the old deploy's env.
const pairs = (list: string[], what: string) =>
  list.map((p) => {
    const eq = p.indexOf("=");
    if (eq < 1) fail(`--${what} takes <slug>=<value>`);
    return [p.slice(0, eq), p.slice(eq + 1)] as const;
  });
const campBySlug = (slug: string) =>
  (
    (db.query("SELECT id FROM camp WHERE slug = ?").get(slug) as {
      id: string;
    } | null) ?? fail(`no camp with slug ${slug}`)
  ).id;
for (const [from, to] of pairs(opt["rename-slug"] as string[], "rename-slug")) {
  if (!isValidCampSlug(to)) fail(`--rename-slug: "${to}" isn't a valid slug`);
  if (db.query("SELECT 1 FROM camp WHERE slug = ?").get(to)) {
    fail(`--rename-slug: a camp already has slug ${to}`);
  }
  db.run("UPDATE camp SET slug = ? WHERE id = ?", [to, campBySlug(from)]);
  console.log(`Renamed camp ${from} → ${to}.`);
}
for (const [slug, packs] of pairs(opt.packs as string[], "packs")) {
  db.run("UPDATE camp SET structure_packs = ? WHERE id = ?", [
    serializeStructurePacks(packs.split(",").map((s) => s.trim())),
    campBySlug(slug),
  ]);
}
for (const [slug, guild] of pairs(
  opt["discord-guild"] as string[],
  "discord-guild",
)) {
  db.run("UPDATE camp SET discord_guild_id = ? WHERE id = ?", [
    guild,
    campBySlug(slug),
  ]);
}
for (const { slug } of db.query("SELECT slug FROM camp").all() as {
  slug: string;
}[]) {
  if (!isValidCampSlug(slug)) {
    console.warn(
      `! camp slug "${slug}" can't be a subdomain; rename it before using CAMP_SUBDOMAINS`,
    );
  }
}

// 4. data.sql, parents first.
type Fk = { table: string; from: string };
const tables = (
  db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('__drizzle_migrations', 'd1_migrations') AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as { name: string }[]
).map((t) => t.name);
const fks = new Map<string, Fk[]>(
  tables.map((t) => [
    t,
    db.query(`PRAGMA foreign_key_list("${t}")`).all() as Fk[],
  ]),
);
const notNull = (t: string) =>
  new Set(
    (
      db.query(`PRAGMA table_info("${t}")`).all() as {
        name: string;
        notnull: number;
      }[]
    )
      .filter((c) => c.notnull)
      .map((c) => c.name),
  );

// Order: repeatedly take tables whose parents are all placed, ignoring
// self-references; break any cycle at a nullable column.
const order: string[] = [];
const placed = new Set<string>();
while (order.length < tables.length) {
  const next = tables.find(
    (t) =>
      !placed.has(t) &&
      (fks.get(t) ?? []).every((f) => f.table === t || placed.has(f.table)),
  );
  const pick =
    next ??
    tables.find(
      (t) =>
        !placed.has(t) &&
        (fks.get(t) ?? []).every(
          (f) =>
            f.table === t || placed.has(f.table) || !notNull(t).has(f.from),
        ),
    ) ??
    fail("a foreign-key cycle through NOT NULL columns");
  order.push(pick);
  placed.add(pick);
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
};
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

const lines: string[] = [];
const later: string[] = [];
const done = new Set<string>();
let rows = 0;
const D1_STATEMENT_LIMIT = 100_000;
for (const t of order) {
  const deferred = new Set(
    (fks.get(t) ?? [])
      .filter((f) => f.table === t || !done.has(f.table))
      .map((f) => f.from),
  );
  const pk = (
    db.query(`PRAGMA table_info("${t}")`).all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  for (const row of db.query(`SELECT * FROM ${q(t)}`).all() as Record<
    string,
    unknown
  >[]) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => (deferred.has(c) ? "NULL" : lit(row[c])));
    const stmt = `INSERT INTO ${q(t)} (${cols.map(q).join(", ")}) VALUES (${vals.join(", ")});`;
    if (stmt.length > D1_STATEMENT_LIMIT) {
      fail(`a ${t} row is ${stmt.length} bytes; D1 takes at most 100 kB`);
    }
    lines.push(stmt);
    rows++;
    const sets = [...deferred].filter((c) => row[c] !== null);
    if (sets.length) {
      if (!pk.length) fail(`${t} needs a primary key to defer references`);
      later.push(
        `UPDATE ${q(t)} SET ${sets.map((c) => `${q(c)} = ${lit(row[c])}`).join(", ")} WHERE ${pk.map((c) => `${q(c)} = ${lit(row[c])}`).join(" AND ")};`,
      );
    }
  }
  done.add(t);
}
// A fresh database isn't quite empty: some migrations seed rows (the
// instance settings singleton). Clear them first, children before parents.
const clear = [...order].reverse().map((t) => `DELETE FROM ${q(t)};`);
writeFileSync(
  join(out, "data.sql"),
  `${[...clear, ...lines, ...later].join("\n")}\n`,
);
db.close();
console.log(
  `Wrote ${join(out, "data.sql")}: ${rows} rows in ${order.length} tables, ${later.length} deferred references.`,
);

// The uploads, keyed as the R2 bucket stores them.
const uploads = join(root, "uploads");
const files: string[] = [];
const walk = (dir: string) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(uploads);
console.log(`${files.length} uploads.`);

// 5. Apply.
if (opt.apply) {
  const where =
    opt.apply === "remote"
      ? ["--remote"]
      : [
          "--local",
          ...(opt["persist-to"] ? ["--persist-to", opt["persist-to"]] : []),
        ];
  const count = JSON.parse(
    (
      await $`bunx wrangler d1 execute DB ${where} --json --command ${"SELECT count(*) AS n FROM user"}`.quiet()
    ).stdout.toString(),
  )[0].results[0].n as number;
  if (count > 0) {
    fail(
      `the ${opt.apply} D1 database already has ${count} users; import into a fresh one`,
    );
  }
  console.log(`Loading data.sql into the ${opt.apply} D1 database…`);
  await $`bunx wrangler d1 execute DB ${where} --yes --file ${join(out, "data.sql")}`.quiet();
  let n = 0;
  for (const f of files) {
    const key = relative(uploads, f).replaceAll("\\", "/");
    await $`bunx wrangler r2 object put ${`${opt.bucket}/${key}`} --file ${f} ${where}`.quiet();
    if (++n % 25 === 0) console.log(`  ${n}/${files.length} uploads`);
  }
  console.log(`Done: ${rows} rows and ${files.length} uploads.`);
}
