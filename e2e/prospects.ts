/**
 * End-to-end check of the Prospects CRM (plans/prospects-crm.md), over real HTTP.
 *
 * The assertions that matter most are the ones a unit test can't reach:
 *   - the feature is opt-in — off means the route bounces
 *   - it is OFFICER-ONLY even when fully ON. This is the one that matters:
 *     every other feature's "on" means the whole camp sees it, and this one
 *     holds candid notes about people who consented to nothing.
 *   - the officer wall is in the ACTION too, not just the loader — a member
 *     POSTing directly gets 403, not a silent write
 *   - logging a conversation advances a cold `lead` to `talking` by itself
 *   - a duplicate handle is refused rather than silently doubled
 *   - MERGE keeps both conversations and collapses the duplicate handle
 *   - an invite minted from a prospect's card stamps that record on redemption,
 *     so the history follows them into the camp
 *   - a public application lands on the prospect we already had for that email
 *     (the "one pipeline" decision) instead of starting a second record
 *   - another camp's prospect id is not reachable
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/prospects.db \
 *     PUBLIC_BASE_URL=http://localhost:17926 PORT=17926 bun run dev
 *   E2E_BASE_URL=http://localhost:17926 bun e2e/prospects.ts
 */
import { and, eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  campInvite,
  membership,
  prospect,
  prospectHandle,
  prospectInteraction,
  recruitApplication,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17926";
const STAMP = Date.now();
const PW = "prospect-tester-pw-1";

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
  const email = `prospect-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Prospect ${tag}`, email, password: PW }),
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

function get(path: string, cookie: string) {
  return fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

const byName = async (name: string) => {
  const rows = await db
    .select()
    .from(prospect)
    .where(and(eq(prospect.campId, campId), eq(prospect.name, name)));
  return rows[0] ?? null;
};

console.log(`\nprospects e2e → ${BASE}\n`);

// ---------------------------------------------------------------- seed a camp
const officer = await account("officer");
const member = await account("member");
const recruit = await account("recruit");
const joiner = await account("joiner");
const applicant = await account("applicant");

const campId = crypto.randomUUID();
const slug = `prospects-${STAMP}`;
await db
  .insert(camp)
  .values({ id: campId, name: `Prospect Camp ${STAMP}`, slug });
await db
  .insert(campEdition)
  .values({ id: crypto.randomUUID(), campId, year: 2026, label: "2026" });

const memberships: Record<string, string> = {};
for (const [who, role] of [
  [officer, "officer"],
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
    // Past the onboarding wizard: the layout bounces wizardStep 0 to /start,
    // which would mask every assertion below.
    wizardStep: 1,
  });
}
const setState = (
  key: "prospects" | "recruiting",
  state: "off" | "preview" | "on",
) =>
  setFeatureState({
    campId,
    key,
    state,
    updatedByMembershipId: memberships.officer as string,
  });

// 1. Opt-in: not in the starter set, so it begins off for a new camp.
const offRes = await get("/prospects", officer.cookie);
check(
  "1. with the feature off, /prospects bounces even for an officer",
  offRes.status === 302 && offRes.headers.get("location") === "/",
  `HTTP ${offRes.status} → ${offRes.headers.get("location")}`,
);

// 2. Fully ON still means officers only. Every other feature's "on" opens it to
//    the whole camp; this one must not, no matter what the admin sets.
await setState("prospects", "on");
const memberOn = await get("/prospects", member.cookie);
const recruitOn = await get("/prospects", recruit.cookie);
const officerOn = await get("/prospects", officer.cookie);
check(
  "2. a member is refused even with the feature fully ON",
  memberOn.status === 403,
  `HTTP ${memberOn.status}`,
);
check(
  "2b. a recruit is refused too",
  recruitOn.status === 403,
  `HTTP ${recruitOn.status}`,
);
check("2c. an officer gets the page", officerOn.status === 200);

// 3. The officer wall is in the action as well — a member POSTing straight at
//    it must be refused, not quietly allowed to write.
const memberWrite = await post("/prospects", member.cookie, {
  intent: "addProspect",
  name: "Snuck In",
});
check(
  "3. a member POSTing to the action is refused",
  memberWrite.status === 403,
  `HTTP ${memberWrite.status}`,
);
check("3b. and nothing was written", (await byName("Snuck In")) === null);

// ------------------------------------------------------------------ the basics
// 4. Add someone with nothing but a name — the "Jenny from the art thread" case.
await post("/prospects", officer.cookie, {
  intent: "addProspect",
  name: "Jenny Thread",
  status: "lead",
  handleKind: "facebook",
  handleValue: "https://facebook.com/jennythread",
});
const jenny = await byName("Jenny Thread");
check("4. a prospect can be created from a name alone", jenny !== null);
check(
  "4b. whoever adds them is put down as looking after them",
  jenny?.ownerMembershipId === memberships.officer,
);

const listHtml = await (await get("/prospects", officer.cookie)).text();
check("4c. they show on the list", listHtml.includes("Jenny Thread"));

// 5. Logging a conversation advances a cold lead by itself — nobody has to
//    remember to move the status.
const logRes = await post(`/prospects/${jenny?.id}`, officer.cookie, {
  intent: "logInteraction",
  channel: "facebook",
  direction: "inbound",
  subject: "Asked about joining",
  body: "Hi! Saw your camp in the group and wondered if you have room.",
  sourceUrl: "facebook.com/groups/1/posts/2",
});
check("5. logging a conversation succeeds", logRes.status === 200);
const jennyAfterLog = await byName("Jenny Thread");
check(
  "5b. a `lead` auto-advances to `talking` once there's a conversation",
  jennyAfterLog?.status === "talking",
  `status = ${jennyAfterLog?.status}`,
);

const threadHtml = await (
  await get(`/prospects/${jenny?.id}`, officer.cookie)
).text();
check(
  "5c. the thread shows what they said",
  threadHtml.includes("wondered if you have room"),
);
check(
  "5d. and links back to the original post",
  threadHtml.includes("facebook.com/groups/1/posts/2"),
);
// Regression guard, same as the FAQ suite's: a Mantine Select with duplicate
// option values THROWS during SSR and React silently falls back to client
// rendering, so the page still 200s. Only the absence of the picker's own
// markup catches it — and this page renders four Selects plus two date pickers.
check(
  "5e. the page survives SSR (no duplicate Select option values)",
  threadHtml.includes("Insert a link to"),
);

// 6. A bare URL typed without a scheme is stored as a real https link, so the
//    "original" anchor is clickable rather than resolving relative to the app.
const [logged] = await db
  .select()
  .from(prospectInteraction)
  .where(eq(prospectInteraction.prospectId, jenny?.id ?? ""));
check(
  "6. a scheme-less source link is normalised to https",
  logged?.sourceUrl === "https://facebook.com/groups/1/posts/2",
  String(logged?.sourceUrl),
);

// 7. The same handle twice is refused, not silently doubled.
const dupe = await post(`/prospects/${jenny?.id}`, officer.cookie, {
  intent: "addHandle",
  kind: "facebook",
  value: "https://facebook.com/jennythread",
});
check(
  "7. a duplicate handle is refused",
  dupe.status === 409,
  `HTTP ${dupe.status}`,
);

// ------------------------------------------------------------------- merging
// 8. A second officer starts their own thread with the same human — the case
//    the whole merge exists for.
await post("/prospects", officer.cookie, {
  intent: "addProspect",
  name: "J. Thread",
  email: `jenny-${STAMP}@example.com`,
  status: "lead",
  handleKind: "facebook",
  handleValue: "https://facebook.com/jennythread",
});
const dupRecord = await byName("J. Thread");
await post(`/prospects/${dupRecord?.id}`, officer.cookie, {
  intent: "logInteraction",
  channel: "email",
  direction: "outbound",
  subject: "Replied about dues",
  body: "Sent her the dues page.",
});

const mergeRes = await post(`/prospects/${dupRecord?.id}`, officer.cookie, {
  intent: "merge",
  survivorId: jenny?.id ?? "",
});
check(
  "8. merging redirects to the surviving record",
  mergeRes.status === 302 &&
    mergeRes.headers.get("location") === `/prospects/${jenny?.id}`,
  `HTTP ${mergeRes.status} → ${mergeRes.headers.get("location")}`,
);
check("8b. the duplicate record is gone", (await byName("J. Thread")) === null);

const mergedLog = await db
  .select()
  .from(prospectInteraction)
  .where(eq(prospectInteraction.prospectId, jenny?.id ?? ""));
check(
  "8c. BOTH conversations survive on the survivor",
  mergedLog.length === 2 &&
    mergedLog.some((i) => i.subject === "Asked about joining") &&
    mergedLog.some((i) => i.subject === "Replied about dues"),
  `${mergedLog.length} entries`,
);

const mergedHandles = await db
  .select()
  .from(prospectHandle)
  .where(eq(prospectHandle.prospectId, jenny?.id ?? ""));
check(
  "8d. the duplicate handle collapsed instead of doubling",
  mergedHandles.filter((h) => h.kind === "facebook").length === 1,
  `${mergedHandles.length} handles`,
);

const survivor = await byName("Jenny Thread");
check(
  "8e. the email fills in from the record that had one",
  survivor?.email === `jenny-${STAMP}@example.com`,
  String(survivor?.email),
);

// --------------------------------------------------------- becoming a member
// 9. An invite minted from the card carries the history in with them.
const inviteRes = await post(`/prospects/${jenny?.id}`, officer.cookie, {
  intent: "createInvite",
});
check("9. an invite can be minted from the card", inviteRes.status === 200);
const [invite] = await db
  .select()
  .from(campInvite)
  .where(eq(campInvite.prospectId, jenny?.id ?? ""));
check("9b. it is tied to this prospect", invite !== undefined);
check(
  "9c. and the record moves to `invited`",
  (await byName("Jenny Thread"))?.status === "invited",
);

const redeem = await post(`/i/${invite?.token}`, joiner.cookie, {});
check(
  "9d. redeeming it joins the camp",
  redeem.status === 302,
  `HTTP ${redeem.status}`,
);
const joined = await byName("Jenny Thread");
const [joinerMembership] = await db
  .select()
  .from(membership)
  .where(
    and(
      eq(membership.organizationId, campId),
      eq(membership.userId, joiner.id),
    ),
  );
check(
  "9e. the prospect is stamped with the new membership — the history follows",
  joined?.membershipId === joinerMembership?.id && joined?.status === "joined",
  `membershipId=${joined?.membershipId} status=${joined?.status}`,
);
check(
  "9f. and the follow-up reminder is cleared",
  joined?.nextFollowUpAt === null,
);

// ------------------------------------------------------------- one pipeline
// 10. A public application lands on the prospect we already have for that
//     email rather than starting a parallel record.
await setState("recruiting", "on");
const [applicantUser] = await db
  .select()
  .from(user)
  .where(eq(user.id, applicant.id));
await post("/prospects", officer.cookie, {
  intent: "addProspect",
  name: "Known Already",
  email: applicantUser?.email ?? "",
  status: "talking",
});
const known = await byName("Known Already");

const applyRes = await post(`/c/${slug}`, applicant.cookie, {
  playaName: "Sparkle",
  message: "I'd love to join",
});
check("10. the public application posts", applyRes.status === 200);

const afterApply = await byName("Known Already");
const [application] = await db
  .select()
  .from(recruitApplication)
  .where(eq(recruitApplication.campId, campId));
check(
  "10b. it attaches to the prospect we already had",
  afterApply?.recruitApplicationId === application?.id,
  `linked=${afterApply?.recruitApplicationId} app=${application?.id}`,
);
check(
  "10c. and moves them to `applied`",
  afterApply?.status === "applied",
  `status = ${afterApply?.status}`,
);
const allWithEmail = await db
  .select()
  .from(prospect)
  .where(
    and(
      eq(prospect.campId, campId),
      eq(prospect.email, applicantUser?.email ?? ""),
    ),
  );
check(
  "10d. no second record was created for the same person",
  allWithEmail.length === 1,
  `${allWithEmail.length} records`,
);
const applyLog = await db
  .select()
  .from(prospectInteraction)
  .where(eq(prospectInteraction.prospectId, known?.id ?? ""));
check(
  "10e. the application itself is logged on the thread",
  applyLog.some((i) => i.subject === "Submitted the camp application"),
);

// ------------------------------------------------------------ camp isolation
// 11. A prospect id from another camp is not reachable, even by an officer.
const otherCampId = crypto.randomUUID();
await db.insert(camp).values({
  id: otherCampId,
  name: `Other Camp ${STAMP}`,
  slug: `other-${STAMP}`,
});
const foreignId = crypto.randomUUID();
await db.insert(prospect).values({
  id: foreignId,
  campId: otherCampId,
  name: "Someone Else's Prospect",
});
const foreign = await get(`/prospects/${foreignId}`, officer.cookie);
check(
  "11. another camp's prospect is not found",
  foreign.status === 404,
  `HTTP ${foreign.status}`,
);
const foreignWrite = await post(`/prospects/${foreignId}`, officer.cookie, {
  intent: "updateDetails",
  name: "Hijacked",
});
check(
  "11b. and cannot be written to either",
  foreignWrite.status === 404,
  `HTTP ${foreignWrite.status}`,
);

// 12. Preview is officers-only as well, which for this feature is the same
//     audience as `on` — the point is that it never widens.
await setState("prospects", "preview");
const previewMember = await get("/prospects", member.cookie);
const previewOfficer = await get("/prospects", officer.cookie);
check(
  "12. in preview a member is still refused",
  previewMember.status === 302 || previewMember.status === 403,
  `HTTP ${previewMember.status}`,
);
check("12b. and an officer still gets in", previewOfficer.status === 200);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
