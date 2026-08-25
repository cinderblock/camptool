/**
 * A party host is an officer scoped to their party — they can read and cancel
 * the tickets and setup passes of everyone in it (plans/party-member-links.md,
 * decision 5). So writing `attendee.host_membership_id` onto someone else's row
 * is a **grant of authority over another account**, and this suite exists to
 * prove no member can do it to another member unilaterally.
 *
 * The bug being locked out: the action used to authorize `subject === me ||
 * host === me`, and that second clause is true of every attempt to grab
 * somebody. Any member could POST themselves onto any other member's row and
 * immediately cancel that person's setup pass.
 *
 * Also covers the invitation flow that replaced it, in both directions, and the
 * asymmetry it is built on — joining a party gives your own things away and
 * needs no permission; taking someone into yours takes theirs and needs theirs.
 *
 * No browser needed, so this runs under bun.
 *
 *   DATABASE_PATH=./data/verify/party.db \
 *     PUBLIC_BASE_URL=http://localhost:17937 PORT=17937 bun run dev
 *   E2E_BASE_URL=http://localhost:17937 bun e2e/party-invites.ts
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
  membership,
  setupPass,
  user,
} from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17937";
const STAMP = Date.now();
const PW = "party-tester-pw-1";
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
  const email = `party-${tag}-${STAMP}@example.com`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Party ${tag}`, email, password: PW }),
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

console.log(`\nparty invitations e2e → ${BASE}\n`);

// ------------------------------------------------------------------- fixture
const grabber = await account("grabber");
const target = await account("target");
const boss = await account("boss");

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Party Camp ${STAMP}`, slug: `party-${STAMP}` });
const editionId = crypto.randomUUID();
await db
  .insert(campEdition)
  .values({ id: editionId, campId, year: YEAR, label: String(YEAR) });

const mids: Record<string, string> = {};
for (const [tag, who, role] of [
  ["grabber", grabber, "member"],
  ["target", target, "member"],
  ["boss", boss, "admin"],
] as const) {
  const id = crypto.randomUUID();
  mids[tag] = id;
  await db.insert(membership).values({
    id,
    organizationId: campId,
    userId: who.id,
    role,
    wizardStep: 1,
  });
}
const GRABBER = mids.grabber as string;
const TARGET = mids.target as string;

for (const key of ["roster", "passes", "tickets"] as const) {
  await setFeatureState({
    campId,
    key,
    state: "on",
    updatedByMembershipId: mids.boss as string,
  });
}

/** The target's row, which is what every authorization question is about. */
async function targetRow() {
  const [row] = await db
    .select({
      id: attendee.id,
      hostMembershipId: attendee.hostMembershipId,
      pendingHostMembershipId: attendee.pendingHostMembershipId,
    })
    .from(attendee)
    .where(
      and(eq(attendee.editionId, editionId), eq(attendee.membershipId, TARGET)),
    )
    .limit(1);
  return row ?? null;
}

/** The target says they're coming, which gives them an attendee row to attack. */
await post("/trip", target.cookie, { intent: "rsvp", status: "coming" });
const seeded = await targetRow();
check("0. the target has an attendee row to fight over", !!seeded);

// A pass request in the target's name — the thing a stolen party link destroys.
const passId = crypto.randomUUID();
await db.insert(setupPass).values({
  id: passId,
  campId,
  editionId,
  attendeeId: seeded?.id ?? "",
  status: "requested",
  createdById: target.id,
});
const passExists = async () =>
  (await db.select().from(setupPass).where(eq(setupPass.id, passId))).length >
  0;

// ---------------------------------------------------------------- the attack
const grab = await post("/roster", grabber.cookie, {
  intent: "setPartyHost",
  membershipId: TARGET,
  hostMembershipId: GRABBER,
});
check(
  "1. a member cannot write themselves onto another member's row",
  grab.status === 403,
  `got ${grab.status}`,
);
check(
  "1b. and the row is untouched",
  (await targetRow())?.hostMembershipId === null,
);
check(
  "1c. so the target's setup pass is still theirs to cancel",
  (await post("/passes", grabber.cookie, { intent: "cancelPass", id: passId }))
    .status === 403 && (await passExists()),
);

// ------------------------------------------------------------ the invitation
const asked = await post("/roster", grabber.cookie, {
  intent: "invitePartyMember",
  membershipId: TARGET,
});
check("2. but they may ask", asked.status === 200, `got ${asked.status}`);
check(
  "2b. which records a proposal, not a link",
  (await targetRow())?.pendingHostMembershipId === GRABBER &&
    (await targetRow())?.hostMembershipId === null,
);
check(
  "2c. an unanswered invitation grants nothing",
  (await post("/passes", grabber.cookie, { intent: "cancelPass", id: passId }))
    .status === 403 && (await passExists()),
);

async function targetTodos(): Promise<string[]> {
  const snap = await loadAskSnapshot(campId, editionId, YEAR, TARGET);
  if (!snap) throw new Error("no snapshot");
  return outstandingAsks(snap, {
    weeksUntilEvent: 4,
    featureStates: { roster: "on", passes: "on", tickets: "on" },
    capabilities: { discord: false },
  }).map((a) => a.key);
}
check(
  "2d. and the target is actually told about it",
  (await targetTodos()).includes("party_invite"),
);
// Needles must avoid apostrophes: React's SSR escapes `'` to `&#x27;`, so
// "says you're camping with them" never appears literally in the markup.
const invitedPage = await (await get("/roster", target.cookie)).text();
check(
  "2e. the roster page puts the question in front of them",
  invitedPage.includes("<b>Party grabber</b> says you") &&
    invitedPage.includes("camping with them"),
);
check(
  "2f. with both answers offered, and nothing done yet",
  invitedPage.includes("Nothing has changed yet"),
);

// A second suitor must not silently displace the first.
const jumped = await post("/roster", boss.cookie, {
  intent: "invitePartyMember",
  membershipId: TARGET,
});
check(
  "3. a second invitation cannot overwrite a pending one",
  jumped.status === 400 &&
    (await targetRow())?.pendingHostMembershipId === GRABBER,
  `got ${jumped.status}`,
);

// Accepting something other than what was displayed must not go through.
const stale = await post("/roster", target.cookie, {
  intent: "acceptPartyInvite",
  hostMembershipId: mids.boss as string,
});
check(
  "4. accepting an invitation nobody sent is refused",
  stale.status === 400 && (await targetRow())?.hostMembershipId === null,
  `got ${stale.status}`,
);

// -------------------------------------------------------------- saying yes
const yes = await post("/roster", target.cookie, {
  intent: "acceptPartyInvite",
  hostMembershipId: GRABBER,
});
check("5. the target may accept", yes.status === 200, `got ${yes.status}`);
const linked = await targetRow();
check(
  "5b. which creates the link and closes the question",
  linked?.hostMembershipId === GRABBER &&
    linked?.pendingHostMembershipId === null,
);
check(
  "5c. clearing the to-do",
  !(await targetTodos()).includes("party_invite"),
);
check(
  "5d. and NOW the host can manage their party's setup pass",
  (await post("/passes", grabber.cookie, { intent: "cancelPass", id: passId }))
    .status === 200 && !(await passExists()),
);

// ------------------------------------------------------ letting people go
const released = await post("/roster", grabber.cookie, {
  intent: "setPartyHost",
  membershipId: TARGET,
  hostMembershipId: "",
});
check(
  "6. a host may still remove someone from their own party",
  released.status === 200 && (await targetRow())?.hostMembershipId === null,
  `got ${released.status}`,
);

// -------------------------------------------------- declining and withdrawing
await post("/roster", grabber.cookie, {
  intent: "invitePartyMember",
  membershipId: TARGET,
});
const declined = await post("/roster", target.cookie, {
  intent: "clearPartyInvite",
  membershipId: TARGET,
});
check(
  "7. the target may decline",
  declined.status === 200 &&
    (await targetRow())?.pendingHostMembershipId === null,
);

await post("/roster", grabber.cookie, {
  intent: "invitePartyMember",
  membershipId: TARGET,
});
const withdrawn = await post("/roster", grabber.cookie, {
  intent: "clearPartyInvite",
  membershipId: TARGET,
});
check(
  "7b. and the inviter may withdraw",
  withdrawn.status === 200 &&
    (await targetRow())?.pendingHostMembershipId === null,
);

// ------------------------------------------------- the direction that is free
const joined = await post("/roster", target.cookie, {
  intent: "setPartyHost",
  membershipId: TARGET,
  hostMembershipId: GRABBER,
});
check(
  "8. joining someone's party needs nobody's permission — it gives your own things away",
  joined.status === 200 && (await targetRow())?.hostMembershipId === GRABBER,
  `got ${joined.status}`,
);
await post("/roster", target.cookie, {
  intent: "setPartyHost",
  membershipId: TARGET,
  hostMembershipId: "",
});

// ------------------------------------------------------------------ officers
const byOfficer = await post("/roster", boss.cookie, {
  intent: "setPartyHost",
  membershipId: TARGET,
  hostMembershipId: GRABBER,
});
check(
  "9. an officer may still link two people directly",
  byOfficer.status === 200 && (await targetRow())?.hostMembershipId === GRABBER,
  `got ${byOfficer.status}`,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
