/**
 * Rehearsal of moving a camp from its own Bun deploy onto the shared
 * Cloudflare site (plans/hosting-other-camps.md, "Moving a camp onto the
 * shared site"), over real HTTP. Two halves:
 *
 *   old  Drives a Bun site standing in for camptool.mathcamp.us: a password
 *        user (super admin) with a camp, a picture and a live session; a
 *        passkey-only member whose passkey is a software key made here. Saves
 *        the backup and what the second half needs to data/move/.
 *   new  After scripts/import-to-d1.ts loaded that backup into a local D1,
 *        drives `wrangler dev` serving both the new site and the old host.
 *
 *   # old site
 *   DATABASE_PATH=./data/verify/move-old.db PORT=17960 \
 *     PUBLIC_BASE_URL=http://localhost:17960 BETTER_AUTH_SECRET=<s> bun run dev
 *   bun e2e/camp-move.ts old
 *   # import, then the new site
 *   bun scripts/import-to-d1.ts data/move/backup.tar.gz --out data/move/import \
 *     --legacy-rp-id oldcamp.test --packs mathcamp=@camptool/mathcamp-theme \
 *     --apply local --persist-to .wrangler/move
 *   bunx wrangler dev --config build/server/wrangler.json --persist-to \
 *     .wrangler/move --port 17970 --ip localhost \
 *     --var PUBLIC_BASE_URL:http://localhost:17970 --var CAMP_SUBDOMAINS:1 \
 *     --var LEGACY_HOSTS:oldcamp.test=mathcamp --var BETTER_AUTH_SECRET:<s>
 *   bun e2e/camp-move.ts new
 */
import { Database } from "bun:sqlite";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

const phase = process.argv[2];
const STATE = "data/move/state.json";
let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) ok++;
  else bad++;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
};
const sessionCookie = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] as string)
    .filter((c) => /session_token=/.test(c))
    .join("; ");
const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
// biome-ignore format: a 1x1 PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

if (phase === "old") {
  const OLD = process.env.E2E_OLD_URL ?? "http://localhost:17960";
  const DB = process.env.DATABASE_PATH ?? "./data/verify/move-old.db";
  const H0 = { origin: OLD };
  const email = `host-${Date.now()}@example.com`;
  const su = await fetch(`${OLD}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H0 },
    body: JSON.stringify({ email, password: "verify123456", name: "Old Host" }),
  });
  const cookie = sessionCookie(su);
  check("old site: sign up", su.ok && !!cookie, `HTTP ${su.status}`);
  const H = { cookie, ...H0 };
  const oc = await fetch(`${OLD}/api/auth/organization/create`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ name: "Math Camp", slug: "mathcamp" }),
  });
  const org = (await oc.json()) as { id: string };
  check("old site: create the camp", oc.ok, `HTTP ${oc.status}`);
  await fetch(`${OLD}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ organizationId: org.id }),
  });
  // Pictures go in wiki pages, so the camp needs the wiki.
  await fetch(`${OLD}/settings`, {
    method: "POST",
    headers: H,
    body: new URLSearchParams({ feature: "wiki", state: "on" }),
    redirect: "manual",
  });
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "dot.png");
  const up = await fetch(`${OLD}/api/media`, {
    method: "POST",
    headers: H,
    body: fd,
  });
  const media = (await up.json()) as { id: string };
  check("old site: upload a picture", up.ok, `HTTP ${up.status}`);

  // A passkey-only member, with a software passkey for the old host.
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x as string, "base64url");
  const y = Buffer.from(jwk.y as string, "base64url");
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const credId = b64url(randomBytes(16));
  const pkUser = `pk-${Date.now()}`;
  const sqlite = new Database(DB);
  const now = Date.now();
  sqlite.run(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Passkey Pat', ?, 0, ?, ?)",
    [pkUser, `${pkUser}@example.com`, now, now],
  );
  sqlite.run(
    "INSERT INTO membership (id, camp_id, user_id, role, created_at, wizard_step) VALUES (?, ?, ?, 'member', ?, 1)",
    [`m-${pkUser}`, org.id, pkUser, now],
  );
  sqlite.run(
    "INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) VALUES (?, 'Pat phone', ?, ?, ?, 0, 'singleDevice', 0)",
    [`pk-row-${pkUser}`, cose.toString("base64"), pkUser, credId],
  );
  sqlite.close();

  const bk = await fetch(`${OLD}/export-db`, { headers: H });
  mkdirSync("data/move", { recursive: true });
  await Bun.write(
    "data/move/backup.tar.gz",
    new Uint8Array(await bk.arrayBuffer()),
  );
  check("old site: backup downloaded", bk.ok, `HTTP ${bk.status}`);
  writeFileSync(
    STATE,
    JSON.stringify({
      email,
      cookie,
      campId: org.id,
      mediaId: media.id,
      pkUser,
      credId,
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
    }),
  );
} else if (phase === "new") {
  const APEX = process.env.E2E_BASE_URL ?? "http://localhost:17970";
  const PORT = new URL(APEX).port;
  const OLD_HOST = `oldcamp.test:${PORT}`;
  const OLD_ORIGIN = `http://${OLD_HOST}`;
  const CAMP_HOST = `mathcamp.localhost:${PORT}`;
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const as = (host: string, path: string, init: RequestInit = {}) =>
    fetch(`${APEX}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), host },
    });
  const loc = (r: Response) => r.headers.get("location") ?? "";

  // 1. The old address, signed in: handed over to the same page, signed in.
  const r1 = await as(OLD_HOST, "/map?x=1", { headers: { cookie: s.cookie } });
  const hand = new URL(loc(r1), APEX);
  check(
    "old address with its session → the hand-off",
    r1.status === 302 &&
      hand.pathname === "/handoff" &&
      hand.searchParams.get("next") === `http://${CAMP_HOST}/map?x=1`,
    `${r1.status} → ${loc(r1)}`,
  );
  const r2 = await fetch(`${APEX}${hand.pathname}${hand.search}`, {
    redirect: "manual",
  });
  const newCookie = sessionCookie(r2);
  check(
    "the hand-off signs in for every camp and goes on",
    r2.status === 302 &&
      loc(r2) === `http://${CAMP_HOST}/map?x=1` &&
      /Domain=localhost/i.test(r2.headers.getSetCookie().join(" ")) &&
      !!newCookie,
    `${r2.status} → ${loc(r2)} ${r2.headers.getSetCookie().join(" | ")}`,
  );
  const r3 = await as(CAMP_HOST, "/settings", {
    headers: { cookie: newCookie },
  });
  const html3 = await r3.text();
  check(
    "signed in at the new address, in the imported camp",
    r3.status === 200 && html3.includes("Math Camp"),
    `HTTP ${r3.status}`,
  );
  const r4 = await fetch(`${APEX}${hand.pathname}${hand.search}`, {
    redirect: "manual",
  });
  check(
    "a hand-off code works once",
    r4.status === 302 && loc(r4).startsWith("/login"),
    `${r4.status} → ${loc(r4)}`,
  );

  // 2. The old address, signed out: just moved.
  const r5 = await as(OLD_HOST, "/wiki/x");
  check(
    "old address signed out → same page at the new address",
    r5.status === 302 && loc(r5) === `http://${CAMP_HOST}/wiki/x`,
    `${r5.status} → ${loc(r5)}`,
  );
  const r6 = await as(OLD_HOST, "/login");
  check(
    "old login → the apex login",
    r6.status === 302 && loc(r6) === `${APEX}/login`,
    `${r6.status} → ${loc(r6)}`,
  );
  const r7 = await as(OLD_HOST, "/moved");
  const html7 = await r7.text();
  check(
    "the old address keeps its we've-moved page",
    r7.status === 200 && html7.includes("We&#x27;ve moved"),
    `HTTP ${r7.status}`,
  );
  const r8 = await fetch(`${APEX}/moved`, { redirect: "manual" });
  check("…and only there", r8.status === 404, `HTTP ${r8.status}`);
  const login = await (await fetch(`${APEX}/login`)).text();
  check(
    "the login page points old passkeys at the bridge",
    login.includes("Moved here from oldcamp.test") &&
      login.includes(`http://${OLD_HOST}/moved`),
  );

  // 3. A passkey-only member signs in with the OLD passkey on the old host.
  const post = (body: unknown) =>
    as(OLD_HOST, "/api/legacy-passkey", {
      method: "POST",
      headers: { "content-type": "application/json", origin: OLD_ORIGIN },
      body: JSON.stringify(body),
    });
  const assertion = (challenge: string, origin = OLD_ORIGIN) => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin }),
    );
    const authData = Buffer.concat([
      createHash("sha256").update("oldcamp.test").digest(),
      Buffer.from([0x05]),
      // The signature counter must keep rising across reruns.
      (() => {
        const c = Buffer.alloc(4);
        c.writeUInt32BE(Math.floor(Date.now() / 1000));
        return c;
      })(),
    ]);
    const signature = createSign("SHA256")
      .update(
        Buffer.concat([
          authData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
      )
      .sign(s.privateKey);
    return {
      id: s.credId,
      rawId: s.credId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
      },
    };
  };
  const o1 = (await (await post({ step: "options" })).json()) as {
    id: string;
    options: { challenge: string; rpId: string };
  };
  check(
    "old-passkey options use the old RP ID",
    o1.options.rpId === "oldcamp.test",
  );
  const forged = await post({
    step: "verify",
    id: o1.id,
    response: assertion(o1.options.challenge, "http://evil.test"),
  });
  check(
    "a signature for another origin is refused",
    forged.status === 401,
    `HTTP ${forged.status}`,
  );
  const o2 = (await (await post({ step: "options" })).json()) as typeof o1;
  const v = await post({
    step: "verify",
    id: o2.id,
    response: assertion(o2.options.challenge),
  });
  const vBody = (await v.json()) as { url?: string };
  check("the old passkey is accepted", v.ok && !!vBody.url, `HTTP ${v.status}`);
  const hand2 = new URL(vBody.url ?? "/", APEX);
  const r9 = await fetch(`${APEX}${hand2.pathname}${hand2.search}`, {
    redirect: "manual",
  });
  const pkCookie = sessionCookie(r9);
  check(
    "…and hands over to the camp",
    r9.status === 302 && loc(r9) === `http://${CAMP_HOST}/` && !!pkCookie,
    `${r9.status} → ${loc(r9)}`,
  );
  // For screenshots of the pages a passkey-only member sees.
  writeFileSync("data/move/pk-cookie.txt", pkCookie);
  const r10 = await as(CAMP_HOST, "/", { headers: { cookie: pkCookie } });
  check(
    "with only an old passkey, the app requires a new one first",
    r10.status === 302 && loc(r10) === "/new-passkey?next=%2F",
    `${r10.status} → ${loc(r10)}`,
  );
  const r11 = await as(CAMP_HOST, "/new-passkey?next=%2F", {
    headers: { cookie: pkCookie },
  });
  check(
    "the new-passkey page names the old address",
    r11.status === 200 && (await r11.text()).includes("oldcamp.test"),
    `HTTP ${r11.status}`,
  );

  // 4. Passwords and uploads came across.
  const si = await fetch(`${APEX}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APEX },
    body: JSON.stringify({ email: s.email, password: "verify123456" }),
  });
  check("the old password signs in", si.ok, `HTTP ${si.status}`);
  const pic = await as(CAMP_HOST, `/media/${s.mediaId}/full`, {
    headers: { cookie: newCookie },
  });
  const bytes = new Uint8Array(await pic.arrayBuffer());
  check(
    "the picture came across byte-for-byte",
    pic.ok &&
      bytes.length === png.length &&
      bytes.every((b, i) => b === png[i]),
    `HTTP ${pic.status}, ${bytes.length} bytes`,
  );
  const packs = JSON.parse(
    (
      await $`bunx wrangler d1 execute DB --local --persist-to ${process.env.E2E_PERSIST ?? ".wrangler/move"} --json --command ${"SELECT structure_packs AS p FROM camp"}`.quiet()
    ).stdout.toString(),
  )[0].results[0].p;
  check(
    "the camp's structure pack is on",
    packs === '["@camptool/mathcamp-theme"]',
    String(packs),
  );
} else {
  console.error("usage: bun e2e/camp-move.ts old|new");
  process.exit(2);
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
