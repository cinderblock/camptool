/**
 * End-to-end check of the camp FAQ (plans/camp-faq.md), over real HTTP.
 *
 * The assertions that matter most are the ones a unit test can't reach:
 *   - the feature is genuinely OPT-IN — off means the route bounces, not 404s
 *   - officers write answers; members and recruits cannot (403, not a no-op)
 *   - ANYONE who can see the FAQ can ask, including a recruit
 *   - a pending question is private to its asker and the officers
 *   - answering publishes the SAME row, keeping the slug a deep link can hold
 *   - re-wording a published question does not move its address
 *   - deleting a category keeps its answers (they fall back to General)
 *   - an answer's `[[…]]` links resolve — in-app and straight at a wiki page
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/faq.db PUBLIC_BASE_URL=http://localhost:17925 \
 *     PORT=17925 bun run dev
 *   E2E_BASE_URL=http://localhost:17925 bun e2e/faq.ts
 */
import { and, eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  faqCategory,
  faqEntry,
  membership,
  user,
  wikiPage,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17925";
const STAMP = Date.now();
const PW = "faq-tester-pw-1";

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

/** Sign up + sign in, returning the session cookie header. */
async function account(tag: string): Promise<{ id: string; cookie: string }> {
  const email = `faq-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Faq ${tag}`, email, password: PW }),
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

const entryBySlug = async (slug: string) => {
  const [row] = await db
    .select()
    .from(faqEntry)
    .where(and(eq(faqEntry.campId, campId), eq(faqEntry.slug, slug)));
  return row ?? null;
};

console.log(`\ncamp FAQ e2e → ${BASE}\n`);

// ---------------------------------------------------------------- seed a camp
const officer = await account("officer");
const member = await account("member");
const other = await account("other");
const recruit = await account("recruit");

const campId = crypto.randomUUID();
await db.insert(camp).values({
  id: campId,
  name: `FAQ Camp ${STAMP}`,
  slug: `faq-${STAMP}`,
});
await db
  .insert(campEdition)
  .values({ id: crypto.randomUUID(), campId, year: 2026, label: "2026" });

const memberships: Record<string, string> = {};
for (const [who, role] of [
  [officer, "officer"],
  [member, "member"],
  [other, "member2"],
  [recruit, "recruit"],
] as const) {
  const id = crypto.randomUUID();
  memberships[role] = id;
  await db.insert(membership).values({
    id,
    organizationId: campId,
    userId: who.id,
    role: role === "member2" ? "member" : role,
    // Past the onboarding wizard: the dashboard layout bounces wizardStep 0 to
    // /start, which would mask every assertion below.
    wizardStep: 1,
  });
}
const setState = (key: "faq" | "wiki", state: "off" | "preview" | "on") =>
  setFeatureState({
    campId,
    key,
    state,
    updatedByMembershipId: memberships.officer as string,
  });

// 1. OPT-IN: the FAQ is not in the starter set, so it starts off.
const offRes = await get("/faq", member.cookie);
check(
  "1. with the feature off, /faq bounces to the overview",
  offRes.status === 302 && offRes.headers.get("location") === "/",
  `HTTP ${offRes.status} → ${offRes.headers.get("location")}`,
);

// 2. Preview = officers only, so leadership can seed answers before launch.
await setState("faq", "preview");
const previewMember = await get("/faq", member.cookie);
const previewOfficer = await get("/faq", officer.cookie);
check(
  "2. in preview, a member still can't see it",
  previewMember.status === 302,
  `HTTP ${previewMember.status}`,
);
check(
  "2b. in preview, an officer can",
  previewOfficer.status === 200,
  `HTTP ${previewOfficer.status}`,
);

await setState("faq", "on");
await setState("wiki", "on");

// A wiki page to link at, so the "especially wiki" requirement is exercised.
await db.insert(wikiPage).values({
  id: crypto.randomUUID(),
  campId,
  slug: "fire-safety",
  title: "Fire safety",
  body: "Keep the extinguisher by the kitchen.",
});

// 3. Only officers write answers.
const memberWrite = await post("/faq", member.cookie, {
  intent: "create",
  question: "Can a member publish?",
  answer: "No.",
  status: "published",
});
check(
  "3. a member cannot author an answer — 403, not a silent no-op",
  memberWrite.status === 403,
  `HTTP ${memberWrite.status}`,
);

const madeCategory = await post("/faq", officer.cookie, {
  intent: "addCategory",
  name: "Getting there",
});
check("3b. an officer creates a category", madeCategory.ok);
const [category] = await db
  .select()
  .from(faqCategory)
  .where(eq(faqCategory.campId, campId));
check("3c. the category got a slug", category?.slug === "getting-there");

const authored = await post("/faq", officer.cookie, {
  intent: "create",
  question: "Where do I park if I arrive after dark?",
  // The whole point of requirement 4: an answer links deep, especially at wiki.
  answer:
    "Pull into the lot and wait for a marshal. See [[Fire safety]] and the [[/map|camp map]].",
  categoryId: category?.id ?? "",
  status: "published",
});
check("3d. an officer publishes an answer", authored.ok);
const parking = await entryBySlug("where-do-i-park-if-i-arrive-after-dark");
check("3e. the answer got a slug from the question", !!parking, parking?.slug);
check(
  "3f. publishing recorded who answered it",
  !!parking?.answeredById && !!parking?.answeredAt,
);

// 4. Anyone who can SEE the FAQ can ask — including a recruit.
const recruitRead = await get("/faq", recruit.cookie);
check(
  "4. a recruit can read the FAQ",
  recruitRead.status === 200,
  `HTTP ${recruitRead.status}`,
);
const recruitAsk = await post("/faq", recruit.cookie, {
  intent: "ask",
  question: "Do I need my own shade?",
});
check("4b. a recruit can ask a question", recruitAsk.ok);
const shade = await entryBySlug("do-i-need-my-own-shade");
check(
  "4c. the question landed pending, credited to the asker",
  shade?.status === "pending" && shade?.askedById === recruit.id,
  `${shade?.status}`,
);

// 5. A pending question is private to its asker and the officers.
const memberSees = await (await get("/faq", member.cookie)).text();
const recruitSees = await (await get("/faq", recruit.cookie)).text();
const officerSees = await (await get("/faq", officer.cookie)).text();
check(
  "5. another member does not see someone else's pending question",
  !memberSees.includes("Do I need my own shade?"),
);
check("5b. the asker sees their own", recruitSees.includes("own shade"));
check("5c. officers see the queue", officerSees.includes("own shade"));

// 6. Answering publishes the SAME row — the slug a deep link holds is stable.
if (!shade) throw new Error("no pending question to answer");
const answered = await post("/faq", officer.cookie, {
  intent: "update",
  id: shade.id,
  question: "Do I need my own shade?",
  answer: "Yes — bring shade for your own tent. Details on [[Fire safety]].",
  categoryId: category?.id ?? "",
  status: "published",
});
check("6. an officer answers a pending question", answered.ok);
const shadeAfter = await entryBySlug("do-i-need-my-own-shade");
check(
  "6b. it published in place, keeping its id and slug",
  shadeAfter?.id === shade.id && shadeAfter?.status === "published",
  `${shadeAfter?.status}`,
);
check(
  "6c. the answer stuck",
  (shadeAfter?.answer ?? "").includes("bring shade"),
);

// 7. Re-wording a published question must NOT move its address.
await post("/faq", officer.cookie, {
  intent: "update",
  id: shade.id,
  question: "Should I bring my own shade structure?",
  answer: shadeAfter?.answer ?? "",
  categoryId: category?.id ?? "",
  status: "published",
});
const reworded = await entryBySlug("do-i-need-my-own-shade");
check(
  "7. re-wording the question keeps the slug — deep links survive",
  reworded?.question === "Should I bring my own shade structure?",
  reworded?.slug,
);

// 8. The deep-link route renders the answer, with its links resolved.
if (!parking) throw new Error("no published answer to fetch");
const deep = await get(`/faq/${parking.slug}`, member.cookie);
const deepText = await deep.text();
check("8. the deep link resolves", deep.status === 200, `HTTP ${deep.status}`);
check("8b. the answer renders", deepText.includes("wait for a marshal"));
check("8c. an in-app link renders as a link", deepText.includes('href="/map"'));
check(
  "8d. a wiki link resolves to the page",
  deepText.includes('href="/wiki/fire-safety"'),
);
check("8e. it carries its category", deepText.includes("Getting there"));

// 9. With the wiki turned OFF, a wiki link degrades instead of pointing into a
//    gated route.
await setState("wiki", "off");
const noWiki = await (await get(`/faq/${parking.slug}`, member.cookie)).text();
check(
  "9. with the wiki off, a wiki link is plain text, not a dead link",
  !noWiki.includes('href="/wiki/fire-safety"') &&
    noWiki.includes("Fire safety"),
);
await setState("wiki", "on");

// 10. Withdrawing is the asker's alone.
const toWithdraw = await post("/faq", member.cookie, {
  intent: "ask",
  question: "Is there a camp dinner?",
});
check("10. a member asks a question", toWithdraw.ok);
const dinner = await entryBySlug("is-there-a-camp-dinner");
const strangerWithdraw = await post("/faq", other.cookie, {
  intent: "withdraw",
  id: dinner?.id ?? "",
});
check(
  "10b. someone else cannot withdraw it",
  strangerWithdraw.status === 403,
  `HTTP ${strangerWithdraw.status}`,
);
await post("/faq", member.cookie, {
  intent: "withdraw",
  id: dinner?.id ?? "",
});
check(
  "10c. the asker can",
  (await entryBySlug("is-there-a-camp-dinner")) === null,
);

// 11. Deleting a category keeps its answers — they fall back to General.
await post("/faq", officer.cookie, {
  intent: "deleteCategory",
  id: category?.id ?? "",
});
const survivor = await entryBySlug(parking.slug);
check(
  "11. deleting a category keeps the answers under it",
  !!survivor && survivor.categoryId === null,
  `categoryId ${survivor?.categoryId}`,
);
const afterDelete = await (await get("/faq", member.cookie)).text();
check("11b. they show under General instead", afterDelete.includes("General"));

// 12. Archiving hides an answer from members but keeps it for officers.
await post("/faq", officer.cookie, {
  intent: "status",
  id: parking.id,
  status: "archived",
});
// Match on the entry's own permalink, not on its wording — the ask box's
// placeholder copy uses the same example question, and a substring check on
// that text passes for the wrong reason.
const parkingLink = `/faq/${parking.slug}`;
const memberAfterArchive = await (await get("/faq", member.cookie)).text();
check(
  "12. an archived answer disappears for members",
  !memberAfterArchive.includes(parkingLink),
);
const officerAfterArchive = await (await get("/faq", officer.cookie)).text();
check(
  "12b. officers still have it, to restore or delete",
  officerAfterArchive.includes("Archived · officers only"),
);

// 13. The symmetry that makes the two features each other's destination: the
//     wiki editor's link picker offers the camp's published FAQ answers.
const editor = await (
  await get("/wiki/fire-safety/edit", officer.cookie)
).text();
check(
  "13. the wiki editor can link straight at an FAQ answer",
  editor.includes("/faq/do-i-need-my-own-shade"),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
