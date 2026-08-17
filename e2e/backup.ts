/**
 * End-to-end check that /export-db really is a COMPLETE backup
 * (plans/complete-backup.md), over real HTTP.
 *
 * The point of this file is the claim in the UI. A backup that says it is
 * complete and isn't is worse than one that admits the gap, so these assert on
 * the archive's actual bytes:
 *   - super-admin only; an ordinary member gets 403
 *   - the download is a real gzip containing a real tar
 *   - it holds camptool.db, and that file starts with SQLite's magic
 *   - it holds the uploaded picture, byte-for-byte identical to what went in
 *   - the manifest tells the truth when a picture's file has already been lost
 *
 *   DATABASE_PATH=./data/verify/backup.db UPLOADS_PATH=./data/verify/bupl \
 *     PUBLIC_BASE_URL=http://localhost:17927 PORT=17927 bun run dev
 *   E2E_BASE_URL=http://localhost:17927 bun e2e/backup.ts
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import { camp, campEdition, membership, superAdmin, user } from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17927";
const UPLOADS = process.env.UPLOADS_PATH ?? "./data/verify/bupl";
const STAMP = Date.now();
const PW = "backup-tester-pw-1";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function account(tag: string): Promise<{ id: string; cookie: string }> {
  const email = `backup-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Backup ${tag}`, email, password: PW }),
  });
  if (!signUp.ok) throw new Error(`sign-up failed for ${tag}`);
  const cookie = (signUp.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c?.includes("session_token"))
    .join("; ");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) throw new Error(`no user row for ${tag}`);
  return { id: u.id, cookie };
}

/** Minimal tar reader — deliberately not the writer's own code. */
function parseTar(archive: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const str = (from: number, length: number, at: number) =>
    new TextDecoder()
      .decode(archive.slice(at + from, at + from + length))
      .replace(/\0.*$/s, "");
  let at = 0;
  while (at + 512 <= archive.length) {
    if (archive.slice(at, at + 512).every((b) => b === 0)) break;
    const name = str(0, 100, at);
    const size = Number.parseInt(str(124, 12, at).trim() || "0", 8);
    at += 512;
    out.set(name, archive.slice(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }
  return out;
}

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function downloadBackup(cookie: string) {
  const res = await fetch(`${BASE}/export-db`, {
    headers: { cookie },
    redirect: "manual",
  });
  if (!res.ok) return { res, entries: new Map<string, Uint8Array>() };
  const gz = new Uint8Array(await res.arrayBuffer());
  return { res, entries: parseTar(new Uint8Array(gunzipSync(gz))) };
}

console.log(`\ncomplete backup e2e → ${BASE}\n`);

// ------------------------------------------------------------------- seeding
const owner = await account("owner");
const member = await account("member");
// The first account on a fresh deployment is auto-granted super admin, so on a
// clean DB this row already exists; on a re-used one it doesn't. Either way,
// `owner` ends up holding the grant.
await db.insert(superAdmin).values({ userId: owner.id }).onConflictDoNothing();

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Backup Camp ${STAMP}`, slug: `bk-${STAMP}` });
await db
  .insert(campEdition)
  .values({ id: crypto.randomUUID(), campId, year: 2026, label: "2026" });

const memberships: Record<string, string> = {};
for (const [who, role] of [
  [owner, "admin"],
  [member, "member"],
] as const) {
  const id = crypto.randomUUID();
  memberships[role] = id;
  await db.insert(membership).values({
    id,
    organizationId: campId,
    userId: who.id,
    role,
    wizardStep: 1,
  });
}
await setFeatureState({
  campId,
  key: "wiki",
  state: "on",
  updatedByMembershipId: memberships.admin as string,
});

// A picture to prove the archive carries bytes, not just rows.
const uploadBody = new FormData();
uploadBody.append(
  "file",
  new Blob([PNG as unknown as BlobPart], { type: "image/png" }),
  "tent.png",
);
const uploaded = await fetch(`${BASE}/api/media`, {
  method: "POST",
  headers: { cookie: member.cookie },
  body: uploadBody,
});
const picture = (await uploaded.json()) as { id: string };
check("0. a picture is uploaded to back up", uploaded.ok && !!picture.id);

// 1. The gate: it holds every camp's data, so only the deployment owner.
const forbidden = await fetch(`${BASE}/export-db`, {
  headers: { cookie: member.cookie },
  redirect: "manual",
});
check(
  "1. an ordinary member cannot download the backup",
  forbidden.status === 403,
  `HTTP ${forbidden.status}`,
);

// 2. The download is a real gzip of a real tar.
const { res, entries } = await downloadBackup(owner.cookie);
check(
  "2. the super admin can download it",
  res.status === 200,
  `HTTP ${res.status}`,
);
check(
  "2b. it is served as a .tar.gz attachment",
  (res.headers.get("content-type") ?? "").includes("gzip") &&
    /filename="camptool-backup-\d{4}-\d{2}-\d{2}\.tar\.gz"/.test(
      res.headers.get("content-disposition") ?? "",
    ),
  `${res.headers.get("content-type")} / ${res.headers.get("content-disposition")}`,
);
check(
  "2c. it unpacks into named entries",
  entries.size >= 3,
  `${[...entries.keys()].join(", ")}`,
);

// 3. THE DATABASE HALF — and that it is genuinely a SQLite file.
const dbFile = entries.get("camptool.db");
const magic = dbFile ? new TextDecoder().decode(dbFile.slice(0, 15)) : "";
check(
  "3. camptool.db is in the archive and is a real SQLite file",
  magic === "SQLite format 3",
  `${dbFile?.byteLength ?? 0} bytes, magic "${magic}"`,
);

// 4. THE PICTURE HALF — the whole reason this change exists.
const inArchive = entries.get(`uploads/${campId}/${picture.id}`);
check(
  "4. the uploaded picture's BYTES are in the archive",
  !!inArchive && inArchive.byteLength === PNG.length,
  `${inArchive?.byteLength ?? "absent"} vs ${PNG.length}`,
);
check(
  "4b. byte for byte identical to what was uploaded",
  !!inArchive && inArchive.every((b, i) => b === PNG[i]),
);

// 5. The manifest explains itself and says how to put it back.
const manifest = new TextDecoder().decode(
  entries.get("MANIFEST.txt") ?? new Uint8Array(),
);
check(
  "5. the manifest states it is the complete backup",
  manifest.includes("complete backup"),
);
check(
  "5b. and gives the restore command",
  manifest.includes("tar -xzf") && manifest.includes("/srv/camptool/data"),
);
check(
  "5c. with nothing missing, it says so plainly",
  manifest.includes("has its file"),
  manifest.split("INTEGRITY")[1]?.trim().slice(0, 80),
);

// 6. HONESTY: a picture whose file was already lost must be REPORTED, not
//    silently omitted. That failure mode is the reason for this whole change.
await rm(join(UPLOADS, campId, picture.id), { force: true });
const second = await downloadBackup(owner.cookie);
const manifest2 = new TextDecoder().decode(
  second.entries.get("MANIFEST.txt") ?? new Uint8Array(),
);
check(
  "6. a picture whose file is gone is flagged in the manifest",
  manifest2.includes("NO file on disk") && manifest2.includes(picture.id),
  manifest2.split("INTEGRITY")[1]?.trim().slice(0, 120),
);
check(
  "6b. and the rest of the backup still completes",
  !!second.entries.get("camptool.db"),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
