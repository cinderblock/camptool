/**
 * End-to-end check of pictures in wiki pages and FAQ answers
 * (plans/pictures-in-bodies.md), over real HTTP.
 *
 * The assertions that matter most are the security ones a unit test can't reach:
 *   - an anonymous request for a picture does NOT get bytes
 *   - a picture belonging to ANOTHER camp 404s (the tenancy boundary)
 *   - a recruit cannot upload; a member can where the wiki is on
 *   - the stored type comes from the BYTES, so a .png-named HTML file is refused
 *   - the ORIGINAL is kept byte-for-byte at full resolution, and /full serves it
 *   - /media/:id serves the smaller display copy when one was uploaded
 *   - a rendered page shows the picture, and links to the original
 *   - a hostile src in a body never reaches an <img>
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/pics.db PUBLIC_BASE_URL=http://localhost:17926 \
 *     PORT=17926 bun run dev
 *   E2E_BASE_URL=http://localhost:17926 bun e2e/pictures.ts
 */
import { eq } from "drizzle-orm";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import { camp, campEdition, membership, user, wikiPage } from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17926";
const STAMP = Date.now();
const PW = "pics-tester-pw-1";

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
  const email = `pics-${tag}-${STAMP}@example.com`;
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Pics ${tag}`, email, password: PW }),
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

const get = (path: string, cookie = "") =>
  fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });

/** A real, decodable 1x1 PNG — the bytes matter, since the server sniffs them. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
/** A distinguishable second image, used as the "display copy". */
const GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

async function upload(
  cookie: string,
  opts: {
    bytes: Uint8Array;
    filename: string;
    type: string;
    display?: Uint8Array;
  },
) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([opts.bytes as unknown as BlobPart], { type: opts.type }),
    opts.filename,
  );
  if (opts.display) {
    body.append(
      "display",
      new Blob([opts.display as unknown as BlobPart], { type: "image/gif" }),
      "display.webp",
    );
  }
  return fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: { cookie },
    body,
    redirect: "manual",
  });
}

console.log(`\npictures e2e → ${BASE}\n`);

// ------------------------------------------------------------- seed two camps
const officer = await account("officer");
const member = await account("member");
const recruit = await account("recruit");
const stranger = await account("stranger");

const campId = crypto.randomUUID();
const otherCampId = crypto.randomUUID();
for (const [id, name] of [
  [campId, `Pics Camp ${STAMP}`],
  [otherCampId, `Other Camp ${STAMP}`],
] as const) {
  await db
    .insert(camp)
    .values({ id, name, slug: `${id.slice(0, 8)}-${STAMP}` });
  await db
    .insert(campEdition)
    .values({ id: crypto.randomUUID(), campId: id, year: 2026, label: "2026" });
}

const memberships: Record<string, string> = {};
for (const [who, role, org] of [
  [officer, "officer", campId],
  [member, "member", campId],
  [recruit, "recruit", campId],
  // The stranger is a full member of a DIFFERENT camp — the interesting case.
  [stranger, "officer", otherCampId],
] as const) {
  const id = crypto.randomUUID();
  memberships[role === "officer" && org === otherCampId ? "stranger" : role] =
    id;
  await db.insert(membership).values({
    id,
    organizationId: org,
    userId: who.id,
    role,
    wizardStep: 1,
  });
}

for (const org of [campId, otherCampId]) {
  await setFeatureState({
    campId: org,
    key: "wiki",
    state: "on",
    updatedByMembershipId: (org === campId
      ? memberships.officer
      : memberships.stranger) as string,
  });
}

// 1. A recruit may read the wiki but may not add pictures to it.
const recruitUpload = await upload(recruit.cookie, {
  bytes: PNG,
  filename: "nope.png",
  type: "image/png",
});
check(
  "1. a recruit cannot upload — 403, not a silent no-op",
  recruitUpload.status === 403,
  `HTTP ${recruitUpload.status}`,
);

// 2. A member can, because the wiki is member-editable.
const uploaded = await upload(member.cookie, {
  bytes: PNG,
  filename: "shade frame.png",
  type: "image/png",
  display: GIF,
});
check(
  "2. a member can upload a picture",
  uploaded.ok,
  `HTTP ${uploaded.status}`,
);
const created = (await uploaded.json()) as {
  id: string;
  src: string;
  alt: string;
};
check(
  "2b. it comes back with a /media src and an alt from the filename",
  created.src === `/media/${created.id}` && created.alt === "shade frame",
  `${created.src} / ${created.alt}`,
);

// 3. The stored type comes from the BYTES, not the browser's claim.
const liar = await upload(member.cookie, {
  bytes: new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>"),
  filename: "totally-a.png",
  type: "image/png",
});
check(
  "3. an HTML file named .png and declared image/png is refused",
  liar.status === 415,
  `HTTP ${liar.status}`,
);
const svg = await upload(member.cookie, {
  bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  filename: "logo.svg",
  type: "image/svg+xml",
});
check("3b. SVG is refused — it is a scriptable document", svg.status === 415);

// 4. THE TENANCY BOUNDARY: another camp's officer must not get the bytes.
const crossCamp = await get(`/media/${created.id}`, stranger.cookie);
check(
  "4. a picture from another camp 404s, even for an officer",
  crossCamp.status === 404,
  `HTTP ${crossCamp.status}`,
);
const crossCampFull = await get(`/media/${created.id}/full`, stranger.cookie);
check(
  "4b. and so does its full-resolution original",
  crossCampFull.status === 404,
  `HTTP ${crossCampFull.status}`,
);

// 5. Anonymous requests get no bytes at all — private-first.
const anon = await get(`/media/${created.id}`);
check(
  "5. an anonymous request does not receive a picture",
  anon.status !== 200,
  `HTTP ${anon.status}`,
);

// 6. The ORIGINAL is kept byte-for-byte; /media serves the smaller copy.
const full = await get(`/media/${created.id}/full`, member.cookie);
const fullBytes = new Uint8Array(await full.arrayBuffer());
check(
  "6. /full returns the original, byte for byte",
  fullBytes.length === PNG.length &&
    fullBytes.every((b, i) => b === PNG[i]) &&
    full.headers.get("content-type") === "image/png",
  `${fullBytes.length}B ${full.headers.get("content-type")}`,
);
const display = await get(`/media/${created.id}`, member.cookie);
const displayBytes = new Uint8Array(await display.arrayBuffer());
check(
  "6b. /media serves the display copy that was uploaded alongside it",
  displayBytes.length === GIF.length &&
    display.headers.get("content-type") === "image/gif",
  `${displayBytes.length}B ${display.headers.get("content-type")}`,
);
check(
  "6c. served with nosniff and a locked-down CSP",
  display.headers.get("x-content-type-options") === "nosniff" &&
    (display.headers.get("content-security-policy") ?? "").includes(
      "default-src 'none'",
    ),
);

// 7. Without a display copy, the original is served for display too.
const plain = await upload(officer.cookie, {
  bytes: GIF,
  filename: "animated.gif",
  type: "image/gif",
});
const plainId = ((await plain.json()) as { id: string }).id;
const plainDisplay = await get(`/media/${plainId}`, member.cookie);
check(
  "7. with no display copy, /media falls back to the original",
  plainDisplay.status === 200 &&
    plainDisplay.headers.get("content-type") === "image/gif",
  `HTTP ${plainDisplay.status}`,
);

// 8. A page renders the picture, links to the original, and refuses a
//    hostile src rather than putting it in an <img>.
await db.insert(wikiPage).values({
  id: crypto.randomUUID(),
  campId,
  slug: "shade-structure",
  title: "Shade structure",
  body: [
    `![The frame](/media/${created.id})`,
    "",
    "Inline ![tiny](https://example.com/x.png) too.",
    "",
    "![gotcha](javascript:alert(1))",
  ].join("\n"),
});
const page = await (await get("/wiki/shade-structure", member.cookie)).text();
check(
  "8. the uploaded picture renders",
  page.includes(`src="/media/${created.id}"`),
);
check(
  "8b. it links to the full-resolution original",
  page.includes(`href="/media/${created.id}/full"`),
);
check(
  "8c. the alt text becomes a caption on a picture of its own",
  page.includes("The frame"),
);
check(
  "8d. an external picture renders with no-referrer",
  page.includes('src="https://example.com/x.png"') &&
    // React's SSR keeps the DOM property's casing (`referrerPolicy`); HTML
    // attribute names are case-insensitive, so don't assert on the spelling.
    /referrerpolicy="no-referrer"/i.test(page),
);
// The raw body — hostile src and all — legitimately appears once more in the
// page, inside React Router's serialized loader payload, because the editor
// needs the source text. That is a JSON string, not an attribute. What must
// never exist is an element whose src IS that value.
check(
  "8e. a javascript: src never becomes an image",
  !/src="javascript:/i.test(page) && page.includes("gotcha"),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
