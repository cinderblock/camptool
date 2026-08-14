/**
 * Officer-issued recovery link → enrol a PASSKEY (not a password).
 *
 * This is the path we actually want people on: a member who can't sign in gets
 * a link, and the link's primary action hands them a passkey rather than
 * another password to forget. See `plans/password-recovery.md`.
 *
 * The mechanism under test is subtle and worth stating: the passkey plugin's
 * `registration.resolveUser` fires only when there is NO session, and we point
 * it at an EXISTING account via an opaque handle. So the ceremony runs with no
 * session, no password, and no account creation — and the invite-only lockdown
 * must not block it, because a camp still has to let its own members back in.
 *
 * WebAuthn needs a real authenticator, so this drives Chrome's CDP *virtual*
 * authenticator. **Run under node, not bun** — chromium.launch() never returns
 * under Bun (see plans/passkey-first-auth.md).
 *
 *   DATABASE_PATH=./data/verify/pkrec.db PUBLIC_BASE_URL=http://localhost:17934 \
 *     PORT=17934 bun run dev
 *   E2E_BASE_URL=http://localhost:17934 bun run e2e:passkey-recovery
 *
 * Deliberately NOT named *.spec.ts: `bun test` globs that pattern.
 */
import { type Browser, type Page, chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17934";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { cdp, authenticatorId };
}

let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await addVirtualAuthenticator(page);

  // The seeding (account + camp + link) happens over HTTP from the harness
  // shell, and the URL is handed in via E2E_RECOVERY_URL so this file needs no
  // database access of its own.
  const url = process.env.E2E_RECOVERY_URL;
  const EMAIL = process.env.E2E_RECOVERY_EMAIL;
  if (!url || !EMAIL) {
    console.error(
      "Set E2E_RECOVERY_URL and E2E_RECOVERY_EMAIL — seed them first with:",
      "  bun scripts/seed-recovery-link.ts <email>",
    );
    process.exit(1);
  }

  await page.goto(url, { waitUntil: "networkidle" });
  const heading = await page.innerText("h1");
  check(
    "1. the recovery page loads",
    /Get back into your account/.test(heading ?? ""),
    heading ?? "",
  );

  check(
    "2. passkey is the primary call to action",
    await page.isVisible("text=Set up a passkey"),
  );
  check(
    "3. the password form is hidden behind an escape hatch",
    !(await page.isVisible('input[name="password"]')) &&
      (await page.isVisible("text=can't do passkeys")),
  );

  // Wrong email must be refused on the passkey path exactly as on the password
  // path — otherwise it's a strictly weaker door onto the same account.
  await page.fill('input[type="email"]', "not-the-right@example.com");
  await page.click("text=Set up a passkey");
  await page.waitForTimeout(1500);
  check(
    "4. a wrong email is refused before any ceremony",
    await page.isVisible("text=not the email this link was issued for"),
  );

  // Correct email: run the real ceremony.
  await page.fill('input[type="email"]', EMAIL);
  await page.click("text=Set up a passkey");
  await page.waitForURL(/\/account/, { timeout: 25000 });
  check("5. enrolling a passkey signs them straight in", true);

  // waitForURL returns as soon as the client-side navigation starts, so the
  // old page's text is still on screen — wait for the destination to render
  // before asserting on content.
  await page.waitForSelector("text=Your passkeys", { timeout: 15000 });
  const body = await page.innerText("body");
  check(
    "6. and lands on the passkey management card",
    /Your passkeys/.test(body),
    body.slice(0, 160),
  );
  // Case-insensitive: Mantine's Badge uppercases its label, so /1 set up/
  // never matches — and a case-sensitive !/None set up yet/ would pass
  // vacuously, which is a test that can never fail.
  check(
    "6b. with exactly one passkey enrolled",
    /\b1 set up\b/i.test(body),
    body.match(/\d+ set up|None set up yet/i)?.[0] ?? "no badge found",
  );
  check(
    "7. the account page no longer says 'None set up yet'",
    !/None set up yet/i.test(body),
  );

  // The link must now be spent.
  await page.goto(url, { waitUntil: "networkidle" });
  const after = await page.innerText("body");
  check(
    "8. the recovery link is spent afterwards",
    /already been used/.test(after),
  );

  // And a fresh sign-in works with the passkey alone — the real proof that
  // recovery produced a durable credential rather than just a session.
  // clearCookies rather than the sign-out endpoint: it is unambiguous, and it
  // also models the realistic case — a different browser session, later.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  check(
    "9. clearing the session really lands on the login page",
    /\/login/.test(page.url()),
    page.url(),
  );
  await page.click("text=Sign in with a passkey");
  await page.waitForTimeout(4000);
  check(
    "9b. the new passkey signs in on its own afterwards",
    !/\/login/.test(page.url()),
    page.url(),
  );
} catch (e) {
  failures++;
  console.error("  FAIL  harness error —", e instanceof Error ? e.message : e);
} finally {
  await browser?.close();
}

console.log(failures === 0 ? "\nall passed\n" : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
