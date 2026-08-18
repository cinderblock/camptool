/**
 * End-to-end check of the officer view of questionnaire answers, and the
 * Members page's invite tree (plans/prospects-crm.md steps 1–2).
 *
 * Both surfaces read data the app was already storing and had never shown, so
 * the assertions worth making are about whether the read is *correct*:
 *   - officers only; a member asking directly gets 403
 *   - answers actually appear, by question and by person
 *   - a `once`-scoped answer (stored with a NULL edition) shows in this year
 *   - audience gating — a recruit-only question isn't counted against a member
 *   - an archived question's answers are still readable, with their prompt
 *   - the CSV quotes commas and newlines rather than corrupting the columns,
 *     and distinguishes "didn't answer" from "wasn't asked"
 *   - Members shows who invited whom, and names the *link* when an open camp
 *     invite recorded a door but no person
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/responses.db \
 *     PUBLIC_BASE_URL=http://localhost:17927 PORT=17927 bun run dev
 *   E2E_BASE_URL=http://localhost:17927 bun e2e/question-responses.ts
 */
import { eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  campInvite,
  campQuestion,
  membership,
  questionAnswer,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17927";
const STAMP = Date.now();
const PW = "responses-tester-pw-1";

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
  const email = `resp-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Resp ${tag}`, email, password: PW }),
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

const get = (path: string, cookie: string) =>
  fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });

/**
 * React's SSR puts `<!-- -->` between adjacent text expressions, so a badge
 * written `{a} of {b}` arrives as `1<!-- --> of <!-- -->1` and a naive
 * `includes("1 of 1")` fails against perfectly correct markup. Strip the
 * separators before matching rendered text.
 */
const text = (html: string) => html.replaceAll("<!-- -->", "");

console.log(`\nquestion responses e2e → ${BASE}\n`);

// ---------------------------------------------------------------- seed a camp
const officer = await account("officer");
const alice = await account("alice");
const bob = await account("bob");

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Resp Camp ${STAMP}`, slug: `resp-${STAMP}` });
const editionId = crypto.randomUUID();
await db
  .insert(campEdition)
  .values({ id: editionId, campId, year: 2026, label: "2026" });

// Alice invited Bob personally; the officer came through an open camp link, so
// they have a door but no named inviter. That contrast is the point of the
// column.
const officerMid = crypto.randomUUID();
const aliceMid = crypto.randomUUID();
const bobMid = crypto.randomUUID();
const openInviteId = crypto.randomUUID();

await db.insert(membership).values({
  id: aliceMid,
  organizationId: campId,
  userId: alice.id,
  role: "member",
  playaName: "Sprocket",
  wizardStep: 1,
});
await db.insert(campInvite).values({
  id: openInviteId,
  campId,
  inviterMembershipId: aliceMid,
  token: `open-${STAMP}`,
  kind: "open",
  note: "2026 art crew channel",
});
await db.insert(membership).values({
  id: officerMid,
  organizationId: campId,
  userId: officer.id,
  role: "officer",
  wizardStep: 1,
  viaInviteId: openInviteId,
});
await db.insert(membership).values({
  id: bobMid,
  organizationId: campId,
  userId: bob.id,
  role: "recruit",
  wizardStep: 1,
  invitedByMembershipId: aliceMid,
});

await setFeatureState({
  campId,
  key: "questions",
  state: "on",
  updatedByMembershipId: officerMid,
});

// Four questions covering the cases that make the read non-trivial.
const qEveryone = crypto.randomUUID();
const qOnce = crypto.randomUUID();
const qRecruit = crypto.randomUUID();
const qArchived = crypto.randomUUID();
await db.insert(campQuestion).values([
  {
    id: qEveryone,
    campId,
    prompt: "What are you bringing to share?",
    type: "long_text",
    audience: "all",
    sortOrder: 1,
  },
  {
    id: qOnce,
    campId,
    prompt: "How did you find us?",
    type: "short_text",
    audience: "all",
    scope: "once",
    sortOrder: 2,
  },
  {
    id: qRecruit,
    campId,
    prompt: "Have you been to the playa before?",
    type: "boolean",
    audience: "recruit",
    sortOrder: 3,
  },
  {
    id: qArchived,
    campId,
    prompt: "Retired question nobody asks now",
    type: "short_text",
    audience: "all",
    sortOrder: 4,
    archivedAt: new Date(),
  },
]);

const answer = (
  membershipId: string,
  questionId: string,
  value: string,
  lifetime = false,
) =>
  db.insert(questionAnswer).values({
    id: crypto.randomUUID(),
    campId,
    editionId: lifetime ? null : editionId,
    questionId,
    membershipId,
    value,
  });

// A comma AND a newline in one answer — the two things that corrupt a CSV.
await answer(
  aliceMid,
  qEveryone,
  'Coffee, tea, and a "big" griddle\nplus a spare tent',
);
await answer(aliceMid, qOnce, "A friend dragged me", true);
await answer(bobMid, qEveryone, "Just myself");
await answer(bobMid, qRecruit, "false");
await answer(aliceMid, qArchived, "an answer that outlived its question");

// 1. Officer-only.
const memberRes = await get("/questions/responses", alice.cookie);
const officerRes = await get("/questions/responses", officer.cookie);
check(
  "1. a member is refused the responses view",
  memberRes.status === 403,
  `HTTP ${memberRes.status}`,
);
check("1b. an officer gets it", officerRes.status === 200);

const html = text(await officerRes.text());

// 2. The answers are actually there — this is the whole gap being closed.
check("2. an answer is shown", html.includes("Just myself"));
check(
  "2b. including one with quotes and a newline in it",
  html.includes("big") && html.includes("spare tent"),
);
check("2c. and the prompt it answers", html.includes("What are you bringing"));

// 3. A lifetime (`once`-scoped) answer carries a NULL edition, so it has to be
//    merged in deliberately or it vanishes from every year.
check(
  "3. a lifetime answer appears in this year's view",
  html.includes("A friend dragged me"),
);

// 4. An archived question's answers stay readable, with their prompt — they are
//    meaningless without it.
check(
  "4. an archived question's answer is still readable",
  html.includes("an answer that outlived its question") &&
    html.includes("Retired question nobody asks now"),
);

// 5. Audience gating: the recruit-only question is asked of Bob (a recruit) and
//    not of Alice, so its tally is "1 of 1", not "1 of 2".
check(
  "5. a recruit-only question counts only the recruits, not the whole camp",
  html.includes("1 of 1") && html.includes("2 of 3"),
  "expected a 1-of-1 badge on the recruit question and 2-of-3 on the open one",
);
// The distribution IS the answer an officer wants for a yes/no question.
check("5b. yes/no answers are tallied", html.includes("No · 1"));

// 6. Regression guard — a Mantine Select/SegmentedControl with duplicate option
//    values throws during SSR and React silently falls back to client render,
//    so the page still 200s. Only its markup being absent catches it.
check(
  "6. the page survives SSR",
  html.includes("By question") && html.includes("By person"),
);

// ------------------------------------------------------------------ the CSV
const csvRes = await get("/questions/responses.csv", officer.cookie);
check("7. the CSV downloads", csvRes.status === 200);
check(
  "7b. as an attachment with a real filename",
  (csvRes.headers.get("content-disposition") ?? "").includes(".csv"),
  String(csvRes.headers.get("content-disposition")),
);
const csv = await csvRes.text();
check(
  "7c. every cell is quoted, so the embedded comma and newline survive",
  csv.includes('"Coffee, tea, and a ""big"" griddle\nplus a spare tent"'),
  csv.split("\n").slice(0, 3).join(" ⏎ "),
);
check(
  "7d. a question someone was never asked reads n/a, not blank",
  csv.includes('"n/a"'),
);
check(
  "7e. and the header carries the prompts",
  csv.includes('"What are you bringing to share?"'),
);
const memberCsv = await get("/questions/responses.csv", alice.cookie);
check(
  "7f. a member can't download it either",
  memberCsv.status === 403,
  `HTTP ${memberCsv.status}`,
);

// --------------------------------------------------------- the invite tree
const members = text(await (await get("/members", officer.cookie)).text());
check(
  "8. Members names who invited whom",
  members.includes("Invited by") && members.includes("Resp alice"),
);
check(
  "8b. and names the LINK when an open invite recorded a door, not a person",
  members.includes("2026 art crew channel"),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
