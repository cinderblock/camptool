/**
 * End-to-end check of `/account` self-service and the wizard's RSVP gating.
 *
 * Two things a unit test can't reach:
 *   - the account page actually renders the identity and groups cards, and its
 *     actions really write (name → user, playa name → membership, group
 *     join/leave scoped to the caller)
 *   - answering "not this year" in `/start` stops the wizard asking about
 *     gear. The dashboard to-do list has always gated on that; the wizard's own
 *     schedule didn't, so the two disagreed about the same person.
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/acct.db \
 *     PUBLIC_BASE_URL=http://localhost:17934 PORT=17934 bun run dev
 *   E2E_BASE_URL=http://localhost:17934 bun e2e/account-and-wizard.ts
 */
import { eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { createGroup } from "../app/lib/groups.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  campGroupMember,
  membership,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17934";
const STAMP = Date.now();
const PW = "acct-tester-pw-1";
const YEAR = 2026;

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
  const email = `acct-${tag}-${STAMP}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Acct ${tag}`, email, password: PW }),
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

const post = (path: string, cookie: string, fields: Record<string, string>) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });

console.log(`\naccount + wizard e2e → ${BASE}\n`);

const me = await account("member");
const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Acct Camp ${STAMP}`, slug: `acct-${STAMP}` });
await db
  .insert(campEdition)
  .values({ id: crypto.randomUUID(), campId, year: YEAR, label: String(YEAR) });
const mid = crypto.randomUUID();
await db.insert(membership).values({
  id: mid,
  organizationId: campId,
  userId: me.id,
  role: "member",
  wizardStep: 1,
});
for (const key of ["bringing", "onboarding"] as const) {
  await setFeatureState({
    campId,
    key,
    state: "on",
    updatedByMembershipId: mid,
  });
}

// ------------------------------------------------------------------ account
const page = await (await get("/account", me.cookie)).text();
check(
  "1. the account page shows the details card",
  page.includes("Your details"),
);
check("1b. and the groups card", page.includes("Your groups"));
check(
  "1c. and still shows the credential cards",
  page.includes("Your passkeys"),
);

const saved = await post("/account", me.cookie, {
  intent: "saveIdentity",
  name: "Renamed Person",
  playaName: "Bug",
});
const [afterSave] = await db.select().from(user).where(eq(user.id, me.id));
const [mem] = await db.select().from(membership).where(eq(membership.id, mid));
check("2. saving the identity works", saved.status === 200);
check(
  "2b. the real name lands on the account",
  afterSave?.name === "Renamed Person",
  `name is ${afterSave?.name}`,
);
check(
  "2c. the playa name lands on the camp membership",
  mem?.playaName === "Bug",
  `playaName is ${mem?.playaName}`,
);

const blank = await post("/account", me.cookie, {
  intent: "saveIdentity",
  name: "   ",
  playaName: "Bug",
});
check(
  "3. a blank name is refused rather than orphaning the account",
  blank.status === 400,
  `HTTP ${blank.status}`,
);

// Clearing the playa name is a legitimate edit, not a no-op.
await post("/account", me.cookie, {
  intent: "saveIdentity",
  name: "Renamed Person",
  playaName: "",
});
const [cleared] = await db
  .select()
  .from(membership)
  .where(eq(membership.id, mid));
check("4. a playa name can be removed again", cleared?.playaName === null);

// -------------------------------------------------------------------- groups
const groupId = await createGroup({
  campId,
  name: "The Test Family",
  createdByMembershipId: mid,
});
await post("/account", me.cookie, { intent: "joinGroup", groupId });
const joined = await db
  .select()
  .from(campGroupMember)
  .where(eq(campGroupMember.membershipId, mid));
check("5. a member can put themselves in a group", joined.length === 1);

const withGroup = await (await get("/account", me.cookie)).text();
check("5b. and it shows on the page", withGroup.includes("The Test Family"));

await post("/account", me.cookie, { intent: "leaveGroup", groupId });
const left = await db
  .select()
  .from(campGroupMember)
  .where(eq(campGroupMember.membershipId, mid));
check("6. and take themselves back out", left.length === 0);

// -------------------------------------------------------- the wizard's RSVP
const coming = await (await get("/start", me.cookie)).text();
check(
  "7. before answering, the wizard asks about gear",
  coming.includes("Bringing"),
);

// The RSVP's home is /trip now; the wizard posts there too.
await post("/trip", me.cookie, { intent: "rsvp", status: "not_coming" });
const notComing = await (await get("/start", me.cookie)).text();
check(
  "8. saying 'not this year' stops the gear questions",
  !notComing.includes("Tents, vehicles"),
);
check(
  "8b. but the questionnaire stays, so they can change their mind",
  notComing.includes("Questionnaire"),
);
check(
  "8c. and their own details stay editable",
  notComing.includes("Your info"),
);

await post("/trip", me.cookie, { intent: "rsvp", status: "coming" });
const backOn = await (await get("/start", me.cookie)).text();
check(
  "9. changing back brings the gear questions with it",
  backOn.includes("Bringing"),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
