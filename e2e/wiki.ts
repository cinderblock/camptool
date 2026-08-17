/**
 * End-to-end check of the camp wiki (plans/camp-wiki.md), over real HTTP.
 *
 * The assertions that matter most are the ones a unit test can't reach:
 *   - the feature is genuinely OPT-IN — off means the route bounces, not 404s
 *   - a plain MEMBER can create and edit any page (that is the whole ask)
 *   - a recruit cannot, and gets a 403 rather than a silent no-op
 *   - editing keeps the PREVIOUS body as a revision (nothing is destroyed)
 *   - a page tied to a structure kind comes back from the MAP loader, which is
 *     what makes "the Sierpinski pyramid deserves a page" actually work
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/wiki.db PUBLIC_BASE_URL=http://localhost:17924 \
 *     PORT=17924 bun run dev
 *   E2E_BASE_URL=http://localhost:17924 bun e2e/wiki.ts
 */
import { and, eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  camp,
  campEdition,
  mapObject,
  membership,
  user,
  wikiPage,
  wikiRevision,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17924";
const STAMP = Date.now();
const PW = "wiki-tester-pw-1";

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
  const email = `wiki-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Wiki ${tag}`, email, password: PW }),
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
  return fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: "manual",
  });
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

console.log(`\ncamp wiki e2e → ${BASE}\n`);

// ---------------------------------------------------------------- seed a camp
const officer = await account("officer");
const member = await account("member");
const recruit = await account("recruit");

const campId = crypto.randomUUID();
await db.insert(camp).values({
  id: campId,
  name: `Wiki Camp ${STAMP}`,
  slug: `wiki-${STAMP}`,
});
const editionId = crypto.randomUUID();
await db
  .insert(campEdition)
  .values({ id: editionId, campId, year: 2026, label: "2026" });

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
    // Past the onboarding wizard: the dashboard layout bounces wizardStep 0 to
    // /start, which would mask every assertion below.
    wizardStep: 1,
  });
}

// 1. OPT-IN: the wiki is not in the starter set, so it starts off.
const offRes = await get("/wiki", member.cookie);
check(
  "1. with the feature off, /wiki bounces to the overview",
  offRes.status === 302 && offRes.headers.get("location") === "/",
  `HTTP ${offRes.status} → ${offRes.headers.get("location")}`,
);

// 2. Preview = officers only, so leadership can try it before the camp sees it.
await setFeatureState({
  campId,
  key: "wiki",
  state: "preview",
  updatedByMembershipId: memberships.officer as string,
});
const previewMember = await get("/wiki", member.cookie);
const previewOfficer = await get("/wiki", officer.cookie);
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

await setFeatureState({
  campId,
  key: "wiki",
  state: "on",
  updatedByMembershipId: memberships.officer as string,
});

// 3. A plain MEMBER creates a page — the core of the ask.
const created = await post("/wiki", member.cookie, {
  intent: "create",
  title: "Raising the Sierpinski Pyramid",
});
check("3. a member can create a page", created.ok, `HTTP ${created.status}`);
const [page] = await db
  .select()
  .from(wikiPage)
  .where(
    and(
      eq(wikiPage.campId, campId),
      eq(wikiPage.slug, "raising-the-sierpinski-pyramid"),
    ),
  );
check("3b. it stored a slug derived from the title", !!page, page?.slug);

// 4. A recruit may read, but not write.
const recruitRead = await get("/wiki", recruit.cookie);
check(
  "4. a recruit can read the wiki",
  recruitRead.status === 200,
  `HTTP ${recruitRead.status}`,
);
const recruitWrite = await post("/wiki", recruit.cookie, {
  intent: "create",
  title: "Recruit page",
});
check(
  "4b. a recruit cannot create — 403, not a silent no-op",
  recruitWrite.status === 403,
  `HTTP ${recruitWrite.status}`,
);

// 5. Editing keeps the previous body. This is what makes open editing safe.
if (!page) throw new Error("no page to edit");
const BODY_1 = "# Setup\n\nBring the 8ft panels. See [[Fire Safety]].";
const BODY_2 = `${BODY_1}\n\nAlso check [[/map|the camp map]].`;
await post(`/wiki/${page.slug}/edit`, member.cookie, {
  title: page.title,
  body: BODY_1,
  summary: "first pass",
});
await post(`/wiki/${page.slug}/edit`, member.cookie, {
  title: page.title,
  body: BODY_2,
  summary: "linked the map",
});
const [after] = await db
  .select()
  .from(wikiPage)
  .where(eq(wikiPage.id, page.id));
const revisions = await db
  .select()
  .from(wikiRevision)
  .where(eq(wikiRevision.pageId, page.id));
check("5. the latest body is saved", after?.body === BODY_2);
check(
  "5b. two edits left two revisions",
  revisions.length === 2,
  `${revisions.length}`,
);
check(
  "5c. a revision holds the body as it was BEFORE that save",
  revisions.some((r) => r.body === BODY_1) &&
    revisions.some((r) => r.body === ""),
  "expected the empty original and the first pass",
);

// 6. Rendering: an in-app link resolves, and a link to an unwritten page is
//    marked as such rather than looking like a working link.
const view = await (await get(`/wiki/${page.slug}`, member.cookie)).text();
check("6. the body renders", view.includes("Bring the 8ft panels"));
check("6b. an in-app link renders as a link", view.includes('href="/map"'));
check(
  "6c. a link to an unwritten page is flagged, not silently broken",
  view.includes("not written yet"),
);

// 7. Tie the page to a STRUCTURE KIND, then confirm the MAP loader hands it
//    back — the "Math Camp's Sierpinski deserves a page" requirement.
const linked = await post(`/wiki/${page.slug}`, member.cookie, {
  intent: "addLink",
  subjectType: "structure_kind",
  subjectId: "sierpinski-pyramid",
});
check("7. a member can tie the page to a structure", linked.ok);

await db.insert(mapObject).values({
  id: crypto.randomUUID(),
  campId,
  editionId,
  kind: "sierpinski-pyramid",
  placed: true,
});
// The map is its own opt-in feature; turn it on so the page is reachable.
await setFeatureState({
  campId,
  key: "map",
  state: "on",
  updatedByMembershipId: memberships.officer as string,
});
const mapRes = await get("/map", officer.cookie);
const mapText = await mapRes.text();
check(
  "7b. the map page carries the tie for that kind",
  mapText.includes("raising-the-sierpinski-pyramid"),
  `HTTP ${mapRes.status}`,
);

// 8. Officers delete; members don't.
const memberDelete = await post(`/wiki/${page.slug}`, member.cookie, {
  intent: "delete",
});
check(
  "8. a member cannot delete a page",
  memberDelete.status === 403,
  `HTTP ${memberDelete.status}`,
);
const officerDelete = await post(`/wiki/${page.slug}`, officer.cookie, {
  intent: "delete",
});
const remaining = await db
  .select()
  .from(wikiPage)
  .where(eq(wikiPage.id, page.id));
check(
  "8b. an officer can",
  remaining.length === 0,
  `HTTP ${officerDelete.status}`,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
