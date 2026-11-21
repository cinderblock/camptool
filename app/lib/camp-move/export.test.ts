/**
 * Exporting one camp out of a database that holds two (plans/camp-portability.md):
 * only that camp's rows and people go, never another camp's, never instance
 * tables, never a password.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uploads = mkdtempSync(join(tmpdir(), "camp-move-export-"));
process.env.DATABASE_PATH = ":memory:";
process.env.UPLOADS_PATH = uploads;

const { db } = await import("../../../db/client.server");
const s = await import("../../../db/schema");
const { blobs } = await import("../blobs.server");
const { exportCamp } = await import("./export.server");
const { decodeRows, sha256 } = await import("./bundle");

afterAll(() => rmSync(uploads, { recursive: true, force: true }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

await db.insert(s.camp).values([
  { id: A, name: "Camp A", slug: "camp-a" },
  { id: B, name: "Camp B", slug: "camp-b" },
]);
await db.insert(s.user).values([
  { id: "u-alice", name: "Alice", email: "alice@example.com" },
  { id: "u-bob", name: "Bob", email: "bob@example.com" },
  { id: "u-admin", name: "Site Admin", email: "admin@example.com" },
  { id: "u-gone", name: "Gone", email: "gone@example.com" },
]);
await db.insert(s.superAdmin).values({ userId: "u-admin" } as never);
await db.insert(s.membership).values([
  { id: "m-alice", organizationId: A, userId: "u-alice", role: "admin" },
  { id: "m-bob", organizationId: B, userId: "u-bob", role: "admin" },
  { id: "m-alice-b", organizationId: B, userId: "u-alice", role: "member" },
]);
await db.insert(s.account).values([
  {
    id: "a-pw",
    accountId: "u-alice",
    providerId: "credential",
    userId: "u-alice",
    password: "scrypt-hash",
  },
  {
    id: "a-discord",
    accountId: "1234567890",
    providerId: "discord",
    userId: "u-alice",
    accessToken: "secret-token",
    refreshToken: "secret-refresh",
  },
]);
await db.insert(s.passkey).values({
  id: "pk-alice",
  publicKey: "pub",
  userId: "u-alice",
  credentialID: "cred-alice",
  counter: 3,
  deviceType: "multiDevice",
  backedUp: true,
});
await db.insert(s.session).values({
  id: "sess",
  token: "tok",
  userId: "u-alice",
  expiresAt: new Date(Date.now() + 1e7),
});
await db.insert(s.faqCategory).values([
  {
    id: "fc-1",
    campId: A,
    name: "General",
    slug: "general",
    createdById: "u-gone",
  },
  { id: "fc-2", campId: A, name: "Bob's", slug: "bobs", createdById: "u-bob" },
  { id: "fc-b", campId: B, name: "B only", slug: "b", createdById: "u-bob" },
]);
await db.insert(s.invitation).values([
  {
    id: "inv-1",
    organizationId: A,
    email: "new@example.com",
    role: "member",
    status: "pending",
    inviterId: "u-admin",
    expiresAt: new Date(Date.now() + 1e7),
  },
] as never);
await db
  .insert(s.campEdition)
  .values({ id: "ed-a", campId: A, year: 2026 } as never);
await db.insert(s.mapSnapshot).values({
  id: "snap-1",
  campId: A,
  editionId: "ed-a",
  kind: "auto",
  seq: 1,
  data: JSON.stringify({
    placement: null,
    objects: [
      { id: "o1", createdById: "u-alice" },
      { id: "o2", createdById: "u-gone" },
    ],
  }),
} as never);
await blobs.put(`${A}/img-1`, new Uint8Array([1, 2, 3]));
await blobs.put(`${B}/img-b`, new Uint8Array([9]));

const out = await exportCamp(A);
const rows = (t: string) => decodeRows(out.rows.get(t) ?? "");

describe("exportCamp", () => {
  it("carries only that camp's rows", () => {
    expect(rows("camp").map((r) => r.id)).toEqual([A]);
    expect(rows("membership").map((r) => r.id)).toEqual(["m-alice"]);
    expect(
      rows("faq_category")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["fc-1", "fc-2"]);
  });

  it("carries only the camp's people", () => {
    expect(rows("user").map((r) => r.id)).toEqual(["u-alice"]);
    expect(out.manifest.people).toBe(1);
  });

  it("clears people who aren't coming, and drops what can't exist without them", () => {
    const fc = Object.fromEntries(
      rows("faq_category").map((r) => [r.id, r.created_by_id]),
    );
    expect(fc).toEqual({ "fc-1": null, "fc-2": null });
    // The invitation's inviter is a site admin, not a member: it can't come.
    expect(rows("invitation")).toEqual([]);
    expect(out.manifest.dropped.invitation).toBe(1);
  });

  it("rewrites user ids inside map snapshots", () => {
    const data = JSON.parse(String(rows("map_snapshot")[0]?.data));
    expect(
      data.objects.map((o: { createdById: unknown }) => o.createdById),
    ).toEqual(["u-alice", null]);
  });

  it("never carries passwords, tokens, sessions or instance tables", () => {
    const accounts = rows("account");
    expect(accounts.map((a) => a.provider_id)).toEqual(["discord"]);
    expect(accounts[0]?.access_token).toBeNull();
    expect(accounts[0]?.refresh_token).toBeNull();
    for (const t of [
      "session",
      "super_admin",
      "instance_setting",
      "verification",
    ]) {
      expect(out.rows.has(t)).toBe(false);
    }
    expect(JSON.stringify([...out.rows.values()])).not.toContain("scrypt-hash");
    expect(JSON.stringify([...out.rows.values()])).not.toContain(
      "secret-token",
    );
  });

  it("carries passkeys as public keys", () => {
    expect(rows("passkey").map((r) => r.credential_id)).toEqual(["cred-alice"]);
  });

  it("lists only that camp's files, with hashes", async () => {
    expect(out.manifest.files).toEqual([
      {
        key: `${A}/img-1`,
        size: 3,
        sha256: await sha256(new Uint8Array([1, 2, 3])),
      },
    ]);
  });

  it("hashes each table as written", async () => {
    for (const [t, info] of Object.entries(out.manifest.tables)) {
      expect(await sha256(out.rows.get(t) ?? "")).toBe(info.sha256);
    }
  });
});
