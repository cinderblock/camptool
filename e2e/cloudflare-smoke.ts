/**
 * Smoke test of the Cloudflare build (Workers + D1 + R2) under `wrangler dev`,
 * over real HTTP (plans/hosting-other-camps.md). The e2e scripts that open the
 * Bun database directly can't drive a Worker, so this one reads D1 through
 * `wrangler d1 execute` instead. Covers: sign-up, camp creation, feature
 * toggles, a prospect merge (one atomic D1 batch of raw SQL), a picture
 * through R2 and back, and the complete backup.
 *
 * Needs a fresh local database each run (a super admin is the first sign-up):
 *
 *   bun run cf:build
 *   bunx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e1
 *   bunx wrangler dev --config build/server/wrangler.json \
 *     --persist-to .wrangler/e2e1 --port 17940 --ip localhost
 *   E2E_PERSIST=.wrangler/e2e1 bun e2e/cloudflare-smoke.ts
 *
 * Use `localhost` throughout: React Router refuses an action whose Origin
 * doesn't match the request URL, so 127.0.0.1 vs localhost fails every POST.
 */
import { $ } from "bun";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17940";
const PERSIST = process.env.E2E_PERSIST ?? ".wrangler/e2e1";
const ORIGIN = { origin: BASE };
let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) ok++;
  else bad++;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
};
const d1 = async (sql: string) => {
  const out =
    await $`bunx wrangler d1 execute DB --local --persist-to ${PERSIST} --json --command ${sql}`.quiet();
  return JSON.parse(out.stdout.toString())[0].results as Record<
    string,
    unknown
  >[];
};

// 1. Sign up; the first account becomes super admin.
const email = `cf-${Date.now()}@example.com`;
const su = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json", ...ORIGIN },
  body: JSON.stringify({ email, password: "verify123456", name: "CF Host" }),
});
const cookie = su.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .filter((c) => c?.includes("session_token"))
  .join("; ");
check("sign-up over D1", su.ok && cookie.length > 0, `HTTP ${su.status}`);
const H = { cookie, ...ORIGIN };

// 2. Create a camp and make it active.
const oc = await fetch(`${BASE}/api/auth/organization/create`, {
  method: "POST",
  headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ name: "Cloud Camp", slug: "cloudcamp" }),
});
const org = (await oc.json()) as { id?: string };
check("create a camp", oc.ok && !!org.id, `HTTP ${oc.status}`);
await fetch(`${BASE}/api/auth/organization/set-active`, {
  method: "POST",
  headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ organizationId: org.id }),
});

const post = (path: string, fields: Record<string, string>) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: H,
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
for (const feature of ["prospects", "wiki"]) {
  const r = await post("/settings", { feature, state: "on" });
  check(`turn on ${feature}`, r.ok, `HTTP ${r.status}`);
}

// 3. Prospect merge: reads, then one atomic D1 batch of raw SQL.
await post("/prospects", {
  intent: "addProspect",
  name: "Jenny Thread",
  status: "lead",
  handleKind: "facebook",
  handleValue: "https://facebook.com/jennythread",
});
await post("/prospects", {
  intent: "addProspect",
  name: "J. Thread",
  email: "jenny@example.com",
  status: "lead",
  handleKind: "facebook",
  handleValue: "https://facebook.com/jennythread",
});
const ps = await d1("SELECT id, name FROM prospect ORDER BY name");
const jenny = ps.find((p) => p.name === "Jenny Thread")?.id as string;
const dup = ps.find((p) => p.name === "J. Thread")?.id as string;
check("two prospects", ps.length === 2);
const m = await post(`/prospects/${dup}`, {
  intent: "merge",
  survivorId: jenny,
});
check(
  "merge redirects to the survivor",
  m.status === 302 && m.headers.get("location") === `/prospects/${jenny}`,
  `HTTP ${m.status} → ${m.headers.get("location")}`,
);
const after = await d1("SELECT id, email FROM prospect");
const handles = await d1("SELECT prospect_id FROM prospect_handle");
check(
  "merged: one prospect, email filled, duplicate handle collapsed",
  after.length === 1 &&
    after[0]?.email === "jenny@example.com" &&
    handles.length === 1 &&
    handles[0]?.prospect_id === jenny,
  JSON.stringify({ after, handles }),
);

// 4. Picture upload to R2 and back.
// biome-ignore format: a 1x1 PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const fd = new FormData();
fd.append("file", new Blob([png], { type: "image/png" }), "dot.png");
const up = await fetch(`${BASE}/api/media`, {
  method: "POST",
  headers: H,
  body: fd,
});
const upBody = (await up.json()) as { id?: string };
check("upload a picture", up.ok && !!upBody.id, `HTTP ${up.status}`);
const got = await fetch(`${BASE}/media/${upBody.id}/full`, { headers: H });
const gotBytes = new Uint8Array(await got.arrayBuffer());
check(
  "the original comes back byte-for-byte",
  got.ok &&
    gotBytes.length === png.length &&
    gotBytes.every((b, i) => b === png[i]),
  `HTTP ${got.status}, ${gotBytes.length} bytes`,
);

// 5. The complete backup: SQL dump + the R2 file.
const bk = await fetch(`${BASE}/export-db`, { headers: H });
const tgz = new Uint8Array(await bk.arrayBuffer());
await Bun.write("data/cf-backup.tar.gz", tgz);
const list = (
  await $`tar -tzf data/cf-backup.tar.gz`.quiet()
).stdout.toString();
check(
  "backup holds the SQL dump and the picture",
  bk.ok &&
    list.includes("camptool.sql") &&
    list.includes(`uploads/${org.id}/${upBody.id}`),
  list.replaceAll("\n", " "),
);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
