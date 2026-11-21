/**
 * Export a camp, make the database look like a different install that already
 * has people, and import it back (plans/camp-portability.md, "User
 * matching"). One process has one database, so "the other install" is the
 * same file after the camp is deleted and the people rearranged.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uploads = mkdtempSync(join(tmpdir(), "camp-move-import-"));
process.env.DATABASE_PATH = ":memory:";
process.env.UPLOADS_PATH = uploads;

const { sql } = await import("drizzle-orm");
const { db } = await import("../../../db/client.server");
const s = await import("../../../db/schema");
const { blobs } = await import("../blobs.server");
const { deleteCamp } = await import("../camp-admin.server");
const { exportCamp } = await import("./export.server");
const { decodeRows, encodeRows, manifestText, newMoveKeys, sha256, sign } =
  await import("./bundle");
const { applyImport, claimEmail, loadRows, preflight } = await import(
  "./import.server"
);
type BundleSource = import("./import.server").BundleSource;

afterAll(() => rmSync(uploads, { recursive: true, force: true }));

const CAMP = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const MOVE = "aaaaaaaa-0000-4000-8000-0000000000ff";
const ALICE = { id: "im-alice", email: "im-alice@example.com" };

await db.insert(s.camp).values([
  { id: CAMP, name: "Movers", slug: "movers" },
  { id: OTHER, name: "Stayers", slug: "stayers" },
]);
await db.insert(s.user).values([
  { id: "im-alice", name: "Alice", email: "im-alice@example.com" },
  { id: "im-carol", name: "Carol", email: "im-carol@example.com" },
  { id: "im-dave", name: "Dave", email: "im-dave@example.com" },
  { id: "im-erin", name: "Erin", email: "im-erin@example.com" },
]);
await db.insert(s.membership).values([
  { id: "im-m-alice", organizationId: CAMP, userId: "im-alice", role: "admin" },
  {
    id: "im-m-alice-2",
    organizationId: OTHER,
    userId: "im-alice",
    role: "member",
  },
  {
    id: "im-m-carol",
    organizationId: CAMP,
    userId: "im-carol",
    role: "member",
  },
  { id: "im-m-dave", organizationId: CAMP, userId: "im-dave", role: "member" },
  { id: "im-m-erin", organizationId: CAMP, userId: "im-erin", role: "member" },
]);
await db.insert(s.account).values([
  {
    id: "im-a-carol",
    accountId: "carol-discord",
    providerId: "discord",
    userId: "im-carol",
  },
  {
    id: "im-a-carol-pw",
    accountId: "im-carol",
    providerId: "credential",
    userId: "im-carol",
    password: "hash",
  },
  {
    id: "im-a-erin",
    accountId: "erin-discord",
    providerId: "discord",
    userId: "im-erin",
  },
]);
await db.insert(s.passkey).values({
  id: "im-pk-carol",
  publicKey: "carol-pub",
  userId: "im-carol",
  credentialID: "im-cred-carol",
  counter: 5,
  deviceType: "multiDevice",
  backedUp: true,
});
await db.insert(s.faqCategory).values({
  id: "im-fc",
  campId: CAMP,
  name: "General",
  slug: "general",
  createdById: "im-dave",
});
await blobs.put(`${CAMP}/pic`, new Uint8Array([4, 5, 6]));

// --- Export, then turn this into "another install". ---
const out = await exportCamp(CAMP);
const keys = await newMoveKeys();
const manifest = {
  ...out.manifest,
  move: { id: MOVE, publicKey: keys.publicKey },
};
const files = new Map([[`${CAMP}/pic`, new Uint8Array([4, 5, 6])]]);
function sourceOf(m = manifest, rows = out.rows): Promise<BundleSource> {
  return sign(keys.privateKey, manifestText(m)).then((signature) => ({
    manifest: m,
    signature,
    rows: async (t) => rows.get(t) ?? "",
    file: async (k) => files.get(k) ?? new Uint8Array(),
  }));
}

await deleteCamp(CAMP);
// Carol isn't here at all; Dave's address belongs to someone unproven;
// Erin's Discord account is on an account with another address.
await db.delete(s.user).where(sql`id IN ('im-carol', 'im-dave', 'im-erin')`);
await db.insert(s.user).values([
  { id: "im-dave-here", name: "Not Dave?", email: "IM-DAVE@example.com" },
  { id: "im-erin-here", name: "Erin H", email: "erin.elsewhere@example.com" },
]);
await db.insert(s.account).values({
  id: "im-a-erin-here",
  accountId: "erin-discord",
  providerId: "discord",
  userId: "im-erin-here",
});

describe("importing a camp", () => {
  it("refuses a bundle signed by someone else", async () => {
    const { problems } = await loadRows(
      await sourceOf(),
      (await newMoveKeys()).publicKey,
    );
    expect(problems[0]).toContain("signature");
  });

  it("ignores tables that aren't a camp's here", async () => {
    const evil = new Map(out.rows);
    evil.set("super_admin", encodeRows([{ user_id: "im-carol" }]));
    const m = structuredClone(manifest);
    m.tables.super_admin = { columns: ["user_id"], rows: 1, sha256: "x" };
    const { rows, ignored } = await loadRows(
      await sourceOf(m, evil),
      keys.publicKey,
    );
    expect(ignored).toEqual(["super_admin"]);
    expect(rows.has("super_admin")).toBe(false);
  });

  /** The bundle with one table's rows changed (and the manifest re-signed,
   * as a hostile old site would). */
  async function tampered(
    table: string,
    change: (rows: Record<string, unknown>[]) => Record<string, unknown>[],
    m = structuredClone(manifest),
  ) {
    const rows = new Map(out.rows);
    const text = encodeRows(change(decodeRows(rows.get(table) ?? "")));
    rows.set(table, text);
    m.tables[table] = {
      columns: m.tables[table]?.columns ?? [],
      rows: decodeRows(text).length,
      sha256: await sha256(text),
    };
    const source = await sourceOf(m, rows);
    const loaded = await loadRows(source, keys.publicKey);
    return preflight(source, loaded.rows, { importer: ALICE });
  }

  it("refuses rows that belong to another camp", async () => {
    const plan = await tampered("membership", (list) => [
      ...list,
      { ...list[0], id: "im-evil", camp_id: OTHER, role: "admin" },
    ]);
    expect(plan.problems.join()).toContain("belong to another camp");
    expect(plan.people).toEqual([]);
  });

  it("refuses references to rows outside the camp", async () => {
    await db.insert(s.faqCategory).values({
      id: "im-other-cat",
      campId: OTHER,
      name: "Theirs",
      slug: "theirs",
    });
    const plan = await tampered("faq_entry", () => [
      {
        id: "im-evil-entry",
        camp_id: CAMP,
        category_id: "im-other-cat",
        slug: "x",
        question: "?",
      },
    ]);
    expect(plan.problems.join()).toContain("points outside the camp");
  });

  it("refuses a second camp", async () => {
    const plan = await tampered("camp", (list) => [
      ...list,
      { ...list[0], id: "im-second", slug: "second" },
    ]);
    expect(plan.problems.join()).toContain("exactly one camp");
  });

  it("refuses files outside the camp", async () => {
    const m = structuredClone(manifest);
    m.files.push({ key: `${OTHER}/logo`, size: 1, sha256: "x" });
    const plan = await tampered("camp", (list) => list, m);
    expect(plan.problems.join()).toContain("files outside");
  });

  it("refuses map snapshots holding another camp's rows", async () => {
    const plan = await tampered("map_snapshot", () => [
      {
        id: "im-snap",
        camp_id: CAMP,
        edition_id: "im-ed",
        kind: "auto",
        seq: 1,
        data: JSON.stringify({ objects: [{ id: "o", campId: OTHER }] }),
      },
    ]);
    expect(plan.problems.join()).toContain("another camp's rows");
  });

  it("matches people and imports", async () => {
    const source = await sourceOf();
    const { rows, problems } = await loadRows(source, keys.publicKey);
    expect(problems).toEqual([]);
    const plan = await preflight(source, rows, { importer: ALICE });
    expect(plan.problems).toEqual([]);
    expect(plan.camp.slugProblem).toBeNull();
    const who = Object.fromEntries(
      plan.people.map((p) => [p.sourceUserId, [p.outcome, p.userId]]),
    );
    expect(who["im-alice"]).toEqual(["link", "im-alice"]);
    expect(who["im-carol"]).toEqual(["create", "im-carol"]);
    // A Discord id is only the old site's word: no link on it.
    expect(who["im-erin"]).toEqual(["create", "im-erin"]);
    expect(who["im-dave"]?.[0]).toBe("claim");

    await applyImport(source, rows, plan, { importedByUserId: "im-alice" });

    const members = await db.all<{ user_id: string; role: string }>(
      sql`SELECT user_id, role FROM membership WHERE camp_id = ${CAMP} ORDER BY role, user_id`,
    );
    const daveId = who["im-dave"]?.[1] as string;
    expect(members.map((m) => m.user_id).sort()).toEqual(
      ["im-alice", "im-carol", daveId, "im-erin"].sort(),
    );
    const [placeholder] = await db.all<{ email: string }>(
      sql`SELECT email FROM user WHERE id = ${daveId}`,
    );
    expect(placeholder?.email).toBe(claimEmail(daveId));
    const [fc] = await db.all<{ created_by_id: string }>(
      sql`SELECT created_by_id FROM faq_category WHERE id = 'im-fc'`,
    );
    expect(fc?.created_by_id).toBe(daveId);
  });

  it("carries a new person's passkeys (as legacy), and no other sign-in", async () => {
    const accounts = await db.all<{ provider_id: string }>(
      sql`SELECT provider_id FROM account WHERE user_id = 'im-carol'`,
    );
    expect(accounts).toEqual([]);
    const [carol] = await db.all<{ email_verified: number }>(
      sql`SELECT email_verified FROM user WHERE id = 'im-carol'`,
    );
    expect(carol?.email_verified).toBe(0);
    const legacy = await db.all<{ rp_id: string; credential_id: string }>(
      sql`SELECT rp_id, credential_id FROM legacy_passkey WHERE user_id = 'im-carol'`,
    );
    expect(legacy).toEqual([
      { rp_id: manifest.source.rpId, credential_id: "im-cred-carol" },
    ]);
  });

  it("adds nothing to accounts that were already here", async () => {
    const [{ n } = { n: -1 }] = await db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM account WHERE user_id IN ('im-alice', 'im-erin-here', 'im-dave-here')`,
    );
    expect(n).toBe(1); // Erin's own Discord account, from before.
  });

  it("records the move and puts the files back", async () => {
    const [moveIn] = await db.all<{ public_key: string }>(
      sql`SELECT public_key FROM camp_move_in WHERE id = ${MOVE}`,
    );
    expect(moveIn?.public_key).toBe(keys.publicKey);
    const outcomes = await db.all<{ outcome: string }>(
      sql`SELECT outcome FROM camp_move_user WHERE move_id = ${MOVE} ORDER BY outcome`,
    );
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "claim",
      "created",
      "created",
      "linked",
    ]);
    expect(await (await blobs.get(`${CAMP}/pic`))?.bytes()).toEqual(
      new Uint8Array([4, 5, 6]),
    );
  });

  it("refuses to import a camp that's already here", async () => {
    const source = await sourceOf();
    const { rows } = await loadRows(source, keys.publicKey);
    const plan = await preflight(source, rows, { slug: "movers-2" });
    expect(plan.problems[0]).toContain("already on this install");
  });

  it("leaves nothing behind when the rows don't fit", async () => {
    await deleteCamp(CAMP);
    // Something else now holds one of the camp's row ids.
    await db.insert(s.faqCategory).values({
      id: "im-fc",
      campId: OTHER,
      name: "Squatter",
      slug: "squatter",
    });
    const source = await sourceOf();
    const { rows } = await loadRows(source, keys.publicKey);
    const plan = await preflight(source, rows);
    await expect(
      applyImport(source, rows, plan, { importedByUserId: null }),
    ).rejects.toThrow("already on this install");
    const [{ n } = { n: -1 }] = await db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM camp WHERE id = ${CAMP}`,
    );
    expect(n).toBe(0);
    expect(await blobs.get(`${CAMP}/pic`)).toBeNull();
  });
});
