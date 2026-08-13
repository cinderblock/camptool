/**
 * End-to-end check of the officer-issued password reset link.
 *
 * The assertion that matters most is #8: **the new password actually signs you
 * in**. It is entirely possible to write a reset flow that looks right, stores
 * a hash, reports success, and produces a password better-auth's sign-in path
 * can never verify — that happens the moment anyone hand-rolls the hashing
 * instead of going through `ctx.password.hash`. A test that stops at "the
 * action returned 200" would not catch it.
 *
 * No browser needed, so this runs under bun (unlike the passkey suites — see
 * `plans/passkey-first-auth.md` on Playwright hanging under Bun).
 *
 *   DATABASE_PATH=./data/verify/pwreset.db PUBLIC_BASE_URL=http://localhost:17931 \
 *     PORT=17931 bun run dev
 *   E2E_BASE_URL=http://localhost:17931 bun e2e/password-reset.ts
 */
import { eq } from "drizzle-orm";
import { issuePasswordReset } from "../app/lib/password-reset.server";
import { db } from "../db/client.server";
import { camp, membership, user } from "../db/schema";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17931";
const STAMP = Date.now();
const EMAIL = `reset-${STAMP}@example.com`;
const OLD_PW = "original-pw-1";
const NEW_PW = "brand-new-pw-2";

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

async function signIn(password: string): Promise<number> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
    redirect: "manual",
  });
  return res.status;
}

async function postReset(url: string, email: string, password: string) {
  const body = new URLSearchParams({
    email,
    password,
    confirm: password,
  });
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
}

console.log(`\npassword reset e2e → ${BASE}\n`);

// 1. A normal password account.
const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Reset Tester",
    email: EMAIL,
    password: OLD_PW,
  }),
});
check("1. signed up a password account", signUp.ok, `HTTP ${signUp.status}`);
if (!signUp.ok) {
  console.log(await signUp.text());
  process.exit(1);
}

check("2. the original password signs in", (await signIn(OLD_PW)) === 200);

// A camp + membership, because a reset link is camp-scoped (the officer's
// authority comes from a membership, even though the credential is account-wide).
const [u] = await db.select().from(user).where(eq(user.email, EMAIL)).limit(1);
if (!u) throw new Error("signup did not create a user row");
const campId = crypto.randomUUID();
await db
  .insert(camp)
  .values({ id: campId, name: `Reset Camp ${STAMP}`, slug: `reset-${STAMP}` });
const midMember = crypto.randomUUID();
await db.insert(membership).values({
  id: midMember,
  organizationId: campId,
  userId: u.id,
  role: "member",
});

const { url, expires } = await issuePasswordReset({
  campId,
  userId: u.id,
  issuedByMembershipId: null,
});
check("3. issued a link", url.includes("/reset/"), url);
check(
  "3b. expiry is 7 days out, as an ISO date",
  expires === new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
  expires,
);

// 4. Opening it is read-only: status only, no side effects, no full address.
const page1 = await (await fetch(url)).text();
check("4. status page renders", page1.includes("Reset your password"));
check(
  "4b. the full email is NOT on the page",
  !page1.includes(EMAIL),
  "a leaked link must not disclose the address it belongs to",
);
check("4c. a masked hint IS shown", page1.includes("•"));

const page2 = await (await fetch(url)).text();
check(
  "5. opening it again leaves it usable (an officer can click it safely)",
  page2.includes("Set my password"),
);
check("5b. the original password still works", (await signIn(OLD_PW)) === 200);

// 6. Wrong email burns an attempt but not the link.
const wrong = await postReset(url, "someone-else@example.com", NEW_PW);
const wrongBody = await wrong.text();
check(
  "6. wrong email is refused",
  wrongBody.includes("not the email this link was issued for"),
  `HTTP ${wrong.status}`,
);
check(
  "6b. it says how many tries remain",
  /\d+ tries left/.test(wrongBody),
  wrongBody.match(/\d+ tries left/)?.[0] ?? "no count found",
);
check(
  "6c. a wrong guess did NOT change the password",
  (await signIn(OLD_PW)) === 200,
);

// 7. Right email completes the reset.
const done = await postReset(url, EMAIL.toUpperCase(), NEW_PW);
check(
  "7. correct email (case-insensitive) redirects to /login?reset=1",
  done.status === 302 && done.headers.get("location") === "/login?reset=1",
  `HTTP ${done.status} → ${done.headers.get("location")}`,
);

// 8. THE assertion this whole file exists for.
check("8. the NEW password signs in", (await signIn(NEW_PW)) === 200);
check("8b. the OLD password no longer works", (await signIn(OLD_PW)) !== 200);

// 9. Spent links report themselves as spent.
const page3 = await (await fetch(url)).text();
check("9. the link now reads as used", page3.includes("already been used"));
check("9b. and offers no form", !page3.includes("Set my password"));
const reuse = await postReset(url, EMAIL, "yet-another-pw-3");
check(
  "9c. and refuses to be redeemed twice",
  (await signIn("yet-another-pw-3")) !== 200,
  `HTTP ${reuse.status}`,
);

// 10. Reissuing retires the previous link.
const first = await issuePasswordReset({
  campId,
  userId: u.id,
  issuedByMembershipId: null,
});
const second = await issuePasswordReset({
  campId,
  userId: u.id,
  issuedByMembershipId: null,
});
check(
  "10. issuing a new link revokes the previous one",
  (await (await fetch(first.url)).text()).includes("was replaced"),
);
check(
  "10b. the newest link is live",
  (await (await fetch(second.url)).text()).includes("Set my password"),
);

// 11. A garbage token is a status page, not a crash.
const bogus = await fetch(`${BASE}/reset/not-a-real-token`);
const bogusBody = await bogus.text();
check(
  // Matched on apostrophe-free copy: React escapes ' to &#x27; in SSR output,
  // so asserting on "isn't valid" silently never matches.
  "11. an unknown token renders the 'not valid' status",
  bogus.status === 200 && bogusBody.includes("may have been mistyped"),
  `HTTP ${bogus.status}`,
);
check("11b. and offers no form", !bogusBody.includes("Set my password"));

// --- Self-serve password management on /account --------------------------
//
// The account page changes a password through better-auth with
// revokeOtherSessions, which rotates the CALLER's session token too. If the
// action swallows the resulting Set-Cookie the user is silently signed out the
// instant they succeed — which is what happened the first time this was built,
// and is invisible to any test that only checks the status code.

const acctEmail = `acct-${STAMP}@example.com`;
const signUp2 = await fetch(`${BASE}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "Account Tester",
    email: acctEmail,
    password: "acct-pw-111",
  }),
});
const cookie1 = (signUp2.headers.get("set-cookie") ?? "").split(";")[0];
check("12. signed up a second account", signUp2.ok && cookie1.length > 0);

const alive = async (cookie: string) =>
  (await (
    await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie } })
  ).text()) !== "null";

const changePw = (cookie: string, current: string, next: string) =>
  fetch(`${BASE}/account`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      intent: "change-password",
      currentPassword: current,
      newPassword: next,
      confirmPassword: next,
    }),
    redirect: "manual",
  });

const badCurrent = await changePw(cookie1, "not-my-password", "acct-pw-222");
check("13. a wrong current password is refused", badCurrent.status === 400);

const changed = await changePw(cookie1, "acct-pw-111", "acct-pw-222");
check(
  "14. a good change redirects (it must, to deliver the new cookie)",
  changed.status === 302,
  `HTTP ${changed.status}`,
);
const rotated = (changed.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .find((c) => c.includes("session_token"));
check("14b. and carries a rotated session cookie", Boolean(rotated));
check(
  "15. the caller is STILL SIGNED IN afterwards",
  rotated ? await alive(rotated) : false,
  "regression guard: swallowing better-auth's Set-Cookie logs the user out",
);
check("15b. but the old session token is dead", !(await alive(cookie1)));

const acctSignIn = async (p: string) =>
  (
    await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: acctEmail, password: p }),
    })
  ).status;
check(
  "16. the changed password signs in",
  (await acctSignIn("acct-pw-222")) === 200,
);
check(
  "16b. the previous one does not",
  (await acctSignIn("acct-pw-111")) !== 200,
);

// 17. Removing a password is refused server-side, not merely disabled in the UI.
const removed = await fetch(`${BASE}/account`, {
  method: "POST",
  headers: {
    cookie: rotated ?? cookie1,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ intent: "remove-password" }),
  redirect: "manual",
});
check(
  "17. removing the password with no passkey is refused",
  removed.status === 400,
  `HTTP ${removed.status}`,
);
check(
  "17b. and the password still works",
  (await acctSignIn("acct-pw-222")) === 200,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
