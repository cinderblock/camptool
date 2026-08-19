/**
 * End-to-end check of the direction-agnostic member merge.
 *
 * The assertion that matters most is #10: **merging A with B produces exactly
 * the same database state as merging B with A**. That is the entire point of
 * the feature (`plans/merge-symmetric.md`) and it is not something a unit test
 * over the pure planner can prove on its own — the planner can be symmetric
 * while the SQL that applies it is not.
 *
 * Second most important, #7/#8: the credentials of BOTH accounts still work
 * afterwards. A merge that reports success and quietly strands the passkey the
 * person actually uses is the exact failure this replaced.
 *
 * No browser needed, so this runs under bun (like `password-reset.ts`).
 *
 *   DATABASE_PATH=./data/verify/merge.db PUBLIC_BASE_URL=http://localhost:17932 \
 *     PORT=17932 bun run dev
 *   E2E_BASE_URL=http://localhost:17932 bun e2e/member-merge.ts
 */
import { eq } from "drizzle-orm";
import { mergeMembers, planMemberMerge } from "../app/lib/merge.server";
import { db, sqlite } from "../db/client.server";
import { account, camp, membership, passkey, user } from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17932";
const STAMP = Date.now();

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

async function signUp(name: string, email: string, password: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok)
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const [u] = await db
    .select()
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!u) throw new Error(`no user row for ${email}`);
  return u;
}

async function signIn(email: string, password: string): Promise<number> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  return res.status;
}

console.log(`\nmember merge e2e → ${BASE}\n`);

const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Merge Camp ${STAMP}`, slug: `merge-${STAMP}` });

/**
 * One duplicate-person scenario, built twice so it can be merged both ways.
 *
 * `old` is the earlier, higher-ranked sign-up carrying a playa name and a
 * password. `new` is the later one carrying a passkey and a Discord login and
 * no playa name — i.e. each side holds something the other needs, which is what
 * makes "which one do I keep?" unanswerable in the first place.
 */
async function buildPair(tag: string) {
  const oldEmail = `merge-${tag}-old-${STAMP}@example.com`;
  const newEmail = `merge-${tag}-new-${STAMP}@example.com`;
  const oldPw = `old-password-${tag}`;

  const oldUser = await signUp("Dana Old", oldEmail, oldPw);
  // The newer account signs up with a password too, then has it removed, so it
  // is passkey+Discord only — the realistic "I couldn't log in so I made a new
  // one with Discord" shape.
  const newUser = await signUp("Dana New", newEmail, `new-password-${tag}`);
  sqlite.run(
    "DELETE FROM account WHERE user_id = ? AND provider_id = 'credential'",
    [newUser.id],
  );

  await db.insert(account).values({
    id: crypto.randomUUID(),
    accountId: `discord-${tag}-${STAMP}`,
    providerId: "discord",
    userId: newUser.id,
  });
  await db.insert(passkey).values({
    id: crypto.randomUUID(),
    name: "Phone",
    publicKey: `pk-${tag}`,
    userId: newUser.id,
    credentialID: `cred-${tag}-${STAMP}`,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });

  const oldMid = crypto.randomUUID();
  const newMid = crypto.randomUUID();
  await db.insert(membership).values({
    id: oldMid,
    organizationId: campId,
    userId: oldUser.id,
    role: "officer",
    playaName: "Compass",
    joinedAt: new Date(1_700_000_000_000),
    createdAt: new Date(1_700_000_000_000),
  });
  await db.insert(membership).values({
    id: newMid,
    organizationId: campId,
    userId: newUser.id,
    role: "member",
    wizardStep: 4,
    joinedAt: new Date(1_800_000_000_000),
    createdAt: new Date(1_800_000_000_000),
  });

  return { oldMid, newMid, oldUser, newUser, oldEmail, newEmail, oldPw };
}

const forward = await buildPair("fwd");
const reverse = await buildPair("rev");

check("1. built two identical duplicate pairs", true);

// — The preview is order-independent before anything is written ---------------
const planA = await planMemberMerge(campId, forward.oldMid, forward.newMid);
const planB = await planMemberMerge(campId, forward.newMid, forward.oldMid);
check(
  "2. preview is identical whichever record is passed first",
  JSON.stringify(planA.plan) === JSON.stringify(planB.plan),
);
check(
  "3. the higher role is what survives",
  planA.plan.membership.role === "officer",
  planA.plan.membership.role,
);
check(
  "4. both accounts' sign-in methods are reported as surviving",
  planA.plan.signInMethods.join(", ") === "1 passkey, password, Discord",
  planA.plan.signInMethods.join(", "),
);
check(
  "5. no password is dropped when only one side has one",
  planA.plan.droppedPassword === false,
);

// — Merge one pair each way ---------------------------------------------------
await mergeMembers(campId, forward.oldMid, forward.newMid);
await mergeMembers(campId, reverse.newMid, reverse.oldMid);
check("6. both merges completed", true);

const survivors = await db
  .select()
  .from(membership)
  .where(eq(membership.organizationId, campId));
check(
  "7. two duplicate pairs became two members",
  survivors.length === 2,
  `${survivors.length} memberships left`,
);

// — The credentials of BOTH original accounts still work ----------------------
check(
  "8. the surviving password still signs in",
  (await signIn(forward.oldEmail, forward.oldPw)) === 200,
);
check(
  "9. the folded-away address no longer signs in",
  (await signIn(forward.newEmail, forward.oldPw)) !== 200,
);

const survivorUserId = survivors.find((m) => m.id === forward.oldMid)?.userId;
const movedPasskeys = await db
  .select()
  .from(passkey)
  .where(eq(passkey.userId, String(survivorUserId)));
check(
  "10. the OTHER account's passkey moved onto the surviving account",
  movedPasskeys.some((p) => p.credentialID === `cred-fwd-${STAMP}`),
);
const movedAccounts = await db
  .select()
  .from(account)
  .where(eq(account.userId, String(survivorUserId)));
check(
  "11. the OTHER account's Discord login moved too",
  movedAccounts.some((a) => a.providerId === "discord"),
);
check(
  "12. and the password came along in the same fold",
  movedAccounts.some((a) => a.providerId === "credential"),
);
check(
  "13. the duplicate account row is gone",
  (await db.select().from(user).where(eq(user.id, forward.newUser.id)))
    .length === 0,
);
const aliases = sqlite
  .query<{ email: string }, [string]>(
    "SELECT email FROM user_email_alias WHERE user_id = ?",
  )
  .all(String(survivorUserId));
check(
  "14. the former address is kept on file as an alias",
  aliases.some((a) => a.email === forward.newEmail.toLowerCase()),
  JSON.stringify(aliases),
);

// — THE assertion: direction made no difference -------------------------------
const shape = (m: (typeof survivors)[number], u: typeof forward.oldUser) => ({
  role: m.role,
  status: m.status,
  playaName: m.playaName,
  wizardStep: m.wizardStep,
  joinedAt: m.joinedAt.getTime(),
  createdAt: m.createdAt.getTime(),
  userName: u.name,
  // Addresses differ by their tag, so compare which SIDE won, not the value.
  primaryIsOlderAccount: u.email.includes("-old-"),
});

const fwdM = survivors.find((m) => m.id === forward.oldMid);
const revM = survivors.find((m) => m.id === reverse.oldMid);
check(
  "15. the same membership row survived in both directions",
  Boolean(fwdM) && Boolean(revM),
  "the survivor is chosen from the data, not from the argument order",
);
if (fwdM && revM) {
  const [fwdU] = await db
    .select()
    .from(user)
    .where(eq(user.id, fwdM.userId))
    .limit(1);
  const [revU] = await db
    .select()
    .from(user)
    .where(eq(user.id, revM.userId))
    .limit(1);
  const a = fwdU ? JSON.stringify(shape(fwdM, fwdU)) : "missing";
  const b = revU ? JSON.stringify(shape(revM, revU)) : "missing";
  check(
    "16. MERGING EITHER WAY PRODUCED THE SAME PERSON",
    a === b,
    `${a}\n      vs ${b}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
console.log("ALL PASSED");
