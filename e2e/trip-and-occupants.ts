/**
 * Every to-do must land on the page that owns the datum, never back in the
 * `/start` wizard (plans/wizard-step-homes.md).
 *
 * Covers the two homes this created:
 *   - `/trip` — RSVP, stay dates, and the free-text note, with the wizard
 *     posting into the same action rather than keeping its own copy
 *   - `/bringing` — who's sleeping in each of your structures, plus the
 *     "N people with you have no bed yet" callout that the `sharing` to-do
 *     is about
 *
 * and asserts the derived to-do list actually clears when each is answered.
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/trip.db \
 *     PUBLIC_BASE_URL=http://localhost:17935 PORT=17935 bun run dev
 *   E2E_BASE_URL=http://localhost:17935 bun e2e/trip-and-occupants.ts
 */
import { and, eq } from "drizzle-orm";
import { outstandingAsks } from "../app/lib/asks";
import { loadAskSnapshot } from "../app/lib/asks.server";
import { setFeatureState } from "../app/lib/features.server";
import { db } from "../db/client.server";
import {
  attendee,
  camp,
  campEdition,
  mapObject,
  mapObjectOccupant,
  membership,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17935";
const STAMP = Date.now();
const PW = "trip-tester-pw-1";
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
  const email = `trip-${tag}-${STAMP}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Trip ${tag}`, email, password: PW }),
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

console.log(`\ntrip + occupants e2e → ${BASE}\n`);

const me = await account("host");
const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Trip Camp ${STAMP}`, slug: `trip-${STAMP}` });
const editionId = crypto.randomUUID();
await db
  .insert(campEdition)
  .values({ id: editionId, campId, year: YEAR, label: String(YEAR) });
const mid = crypto.randomUUID();
await db.insert(membership).values({
  id: mid,
  organizationId: campId,
  userId: me.id,
  role: "member",
  wizardStep: 1,
});
for (const key of ["bringing", "passes"] as const) {
  await setFeatureState({
    campId,
    key,
    state: "on",
    updatedByMembershipId: mid,
  });
}

/** What the camper still owes, straight from the registry. */
async function todos(): Promise<{ key: string; route: string }[]> {
  const snap = await loadAskSnapshot(campId, editionId, YEAR, mid);
  if (!snap) throw new Error("no snapshot");
  return outstandingAsks(snap, {
    weeksUntilEvent: 4,
    featureStates: { bringing: "on", passes: "on" },
    capabilities: { discord: false },
  }).map((a) => ({ key: a.key, route: a.route }));
}

// ------------------------------------------------------------- no dead ends
const open = await todos();
check(
  "1. nothing on the to-do list sends the camper back into the wizard",
  open.every((t) => t.route !== "/start"),
  open
    .filter((t) => t.route === "/start")
    .map((t) => t.key)
    .join(", "),
);
check(
  "1b. and the trip asks point at /trip",
  open.filter((t) => t.key === "rsvp").every((t) => t.route === "/trip"),
);

// -------------------------------------------------------------------- /trip
const tripPage = await (await get("/trip", me.cookie)).text();
check("2. /trip renders for a plain member", tripPage.includes("Your trip"));
check(
  "2b. and asks the RSVP question",
  tripPage.includes("Are you camping with us"),
);
check(
  "2c. the stay picker stays hidden until they've said they're coming",
  !tripPage.includes("When will you be there?"),
);

const rsvped = await post("/trip", me.cookie, {
  intent: "rsvp",
  status: "coming",
});
check("3. the RSVP saves from /trip", rsvped.status === 200);
check(
  "3b. and clears the rsvp to-do",
  !(await todos()).some((t) => t.key === "rsvp"),
);

const withStay = await (await get("/trip", me.cookie)).text();
check(
  "4. saying yes reveals the stay picker",
  withStay.includes("When will you be there?"),
);

await post("/trip", me.cookie, {
  intent: "rsvp",
  status: "coming",
  arrivalDate: `${YEAR}-08-25`,
  departureDate: `${YEAR}-09-01`,
});
check(
  "4b. stay dates save and clear their to-do",
  !(await todos()).some((t) => t.key === "stay_dates"),
);

const badRange = await post("/trip", me.cookie, {
  intent: "rsvp",
  status: "coming",
  arrivalDate: `${YEAR}-09-01`,
  departureDate: `${YEAR}-08-25`,
});
check(
  "5. departure before arrival is refused",
  badRange.status === 400,
  `HTTP ${badRange.status}`,
);

// The note: a written note satisfies it, and so does saying there's nothing.
check(
  "6. 'anything else?' is outstanding to start with",
  (await todos()).some((t) => t.key === "extras"),
);
await post("/trip", me.cookie, {
  intent: "rsvp",
  status: "coming",
  note: "Bringing a spare shade structure.",
});
check(
  "6b. writing a note settles it without touching the wizard",
  !(await todos()).some((t) => t.key === "extras"),
);
await post("/trip", me.cookie, {
  intent: "rsvp",
  status: "coming",
  note: "",
});
check(
  "6c. clearing the note brings it back",
  (await todos()).some((t) => t.key === "extras"),
);
const nothing = await post("/trip", me.cookie, { intent: "nothingToAdd" });
check("6d. 'nothing else to add' is accepted", nothing.status === 200);
check(
  "6e. and settles it for good",
  !(await todos()).some((t) => t.key === "extras"),
);

// ---------------------------------------------------------------- occupants
// A guest attending under this member: someone whose bed nobody can infer.
const guestId = crypto.randomUUID();
await db.insert(attendee).values({
  id: guestId,
  campId,
  editionId,
  hostMembershipId: mid,
  name: "Pat Guest",
  status: "coming",
});

const sharing = (await todos()).find((t) => t.key === "sharing");
check("7. a guest with no bed raises the sharing to-do", !!sharing);
check(
  "7b. pointing at /bringing, where the structures are",
  sharing?.route === "/bringing",
  sharing?.route,
);

const bringingPage = await (await get("/bringing", me.cookie)).text();
check(
  "8. /bringing names who still has no bed",
  bringingPage.includes("Pat Guest") && bringingPage.includes("no bed yet"),
);

// Give them a tent to sleep in.
await post("/bringing", me.cookie, { intent: "addItem", kind: "tent" });
const [tent] = await db
  .select()
  .from(mapObject)
  .where(
    and(
      eq(mapObject.editionId, editionId),
      eq(mapObject.ownerMembershipId, mid),
    ),
  );
if (!tent) throw new Error("no tent");

const withPicker = await (await get("/bringing", me.cookie)).text();
// Apostrophes come back HTML-escaped, so match on a fragment without one.
check(
  "9. the tent offers an occupant list",
  withPicker.includes("sleeping in it"),
);

const added = await post("/bringing", me.cookie, {
  intent: "addOccupant",
  objectId: tent.id,
  occupantRef: `a:${guestId}`,
});
check("10. the guest can be added as an occupant", added.status === 200);
const occRows = await db
  .select()
  .from(mapObjectOccupant)
  .where(eq(mapObjectOccupant.objectId, tent.id));
check("10b. and the row lands in the database", occRows.length === 1);
check(
  "10c. which clears the sharing to-do",
  !(await todos()).some((t) => t.key === "sharing"),
);

const shown = await (await get("/bringing", me.cookie)).text();
check(
  "10d. the page shows them in the tent, and drops the callout",
  shown.includes("Pat Guest") && !shown.includes("no bed yet"),
);

// Someone else's structure is not yours to fill.
const other = await account("other");
const otherMid = crypto.randomUUID();
await db.insert(membership).values({
  id: otherMid,
  organizationId: campId,
  userId: other.id,
  role: "member",
  wizardStep: 1,
});
const trespass = await post("/bringing", other.cookie, {
  intent: "addOccupant",
  objectId: tent.id,
  occupantRef: `a:${guestId}`,
});
check(
  "11. another member can't put people in your tent",
  trespass.status === 403,
  `HTTP ${trespass.status}`,
);

const removed = await post("/bringing", me.cookie, {
  intent: "removeOccupant",
  objectId: tent.id,
  attendeeId: guestId,
});
check("12. and the owner can take them back out", removed.status === 200);
check(
  "12b. which brings the to-do back",
  (await todos()).some((t) => t.key === "sharing"),
);

// ----------------------------------------------------- the wizard still works
// Mantine's Stepper only renders the ACTIVE step's body, and the wizard opens
// on the first unresolved ask — so walk past `profile` to reach the RSVP step.
await post("/start", me.cookie, {
  intent: "resolveAsk",
  askKey: "profile",
  status: "done",
});
const wizard = await (await get("/start", me.cookie)).text();
check(
  "13. the wizard still renders its RSVP step from the shared controls",
  wizard.includes("Are you camping with us"),
);
check(
  "13c. and says where that setting actually lives",
  wizard.includes("This lives on Your trip"),
);
check(
  "13b. and no longer answers the moved intents itself",
  (await post("/start", me.cookie, { intent: "rsvp", status: "coming" }))
    .status === 400,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
