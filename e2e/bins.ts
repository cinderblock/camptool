/**
 * End-to-end check of the bins hand-off (plans/bins-integration.md).
 *
 * The assertion that matters most is #5: **the access code never appears in
 * page HTML**. The menu item renders in the top bar of every page, so the
 * tempting implementation — putting `…/join#code` straight in the href — would
 * ship the camp's shared secret to every session on every page load. The whole
 * reason /bins exists as a redirect is to avoid that, and only a test that
 * greps the HTML can tell the two implementations apart.
 *
 *   DATABASE_PATH=./data/verify/bins.db PUBLIC_BASE_URL=http://localhost:17925 \
 *     PORT=17925 bun run dev
 *   E2E_BASE_URL=http://localhost:17925 bun e2e/bins.ts
 */
import { eq } from "drizzle-orm";
import { setBinsLink } from "../app/lib/bins.server";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import { camp, membership, user } from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17925";
const STAMP = Date.now();
const PW = "bins-tester-pw-1";
const CODE = `secret-code-${STAMP}`;
const BINS_URL = "https://bins.example.com";

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

async function account(tag: string) {
  const email = `bins-${tag}-${STAMP}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Bins ${tag}`, email, password: PW }),
  });
  if (!res.ok) throw new Error(`sign-up failed for ${tag}`);
  const cookie = (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c?.includes("session_token"))
    .join("; ");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) throw new Error(`no user row for ${tag}`);
  return { id: u.id, cookie };
}

const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });

console.log(`\nbins hand-off e2e → ${BASE}\n`);

const admin = await account("admin");
const member = await account("member");
const recruit = await account("recruit");

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Bins Camp ${STAMP}`, slug: `bins-${STAMP}` });
const memberships: Record<string, string> = {};
for (const [who, role] of [
  [admin, "admin"],
  [member, "member"],
  [recruit, "recruit"],
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

// 1. Off by default — the shortcut is opt-in like every other feature.
const off = await get("/bins", member.cookie);
check(
  "1. with the feature off, /bins bounces",
  off.status === 302 && off.headers.get("location") === "/",
  `HTTP ${off.status} → ${off.headers.get("location")}`,
);
const offHome = await (await get("/", member.cookie)).text();
// Assert on the link itself, not on the word "Bins" — the page legitimately
// carries the feature registry (every key and label) in its serialized loader
// data, so a bare word match reports a leak that isn't one.
check("1b. and no menu item is rendered", !offHome.includes('href="/bins"'));

// 2. On, but not yet configured: send the admin somewhere useful rather than
//    dead-ending on a link to nowhere.
await setFeatureState({
  campId,
  key: "bins",
  state: "on",
  updatedByMembershipId: memberships.admin as string,
});
const unconfigured = await get("/bins", member.cookie);
check(
  "2. on but unconfigured redirects to settings",
  unconfigured.headers.get("location") === "/settings",
  `→ ${unconfigured.headers.get("location")}`,
);

// 3. Configured: the click lands on bins' join target, code in the FRAGMENT
//    (which is how bins keeps it out of its own server logs).
await setBinsLink({
  campId,
  baseUrl: BINS_URL,
  accessCode: CODE,
  label: "Warehouse",
  updatedByMembershipId: memberships.admin as string,
});
const hop = await get("/bins", member.cookie);
const location = hop.headers.get("location") ?? "";
check(
  "3. redirects to the bins join URL",
  location === `${BINS_URL}/join#${encodeURIComponent(CODE)}`,
  location,
);
check(
  "3b. the code rides in the fragment, not the query string",
  location.includes("#") && !location.includes("?"),
  location,
);

// 4. The menu item appears, using the camp's chosen label.
const home = await (await get("/", member.cookie)).text();
check("4. the top bar shows the item", home.includes("Warehouse"));
check(
  "4b. pointing at /bins, not at the bins host",
  home.includes('href="/bins"'),
);

// 5. THE ONE THAT MATTERS: the secret is not in the page.
check(
  "5. the access code is NOT in the page HTML",
  !home.includes(CODE),
  "the code must only ever appear in the click-time redirect",
);
check(
  "5b. nor is the bins host, since the href is a CampTool path",
  !home.includes(BINS_URL),
);

// 6. Recruits are camp-adjacent applicants; they don't get warehouse access.
const recruitHop = await get("/bins", recruit.cookie);
check(
  "6. a recruit is bounced",
  recruitHop.headers.get("location") === "/",
  `→ ${recruitHop.headers.get("location")}`,
);
const recruitHome = await (await get("/", recruit.cookie)).text();
check("6b. and never sees the item", !recruitHome.includes("Warehouse"));
check("6c. nor the code", !recruitHome.includes(CODE));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
