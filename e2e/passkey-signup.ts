/**
 * Passkey-first signup spike test.
 *
 * WebAuthn can't be exercised by hand-driving a browser (it needs a real
 * authenticator — Windows Hello, a phone, a security key), so this uses
 * Chrome's CDP *virtual* authenticator to run the ceremony headlessly and
 * deterministically. This is the only practical way to regression-test
 * passkey-only auth; see plans/passkey-first-auth.md.
 *
 * Run with the dev server already up on DEV_PORT:
 *   bun run dev            # in one shell
 *   bun run e2e:passkey    # in another
 *
 * Deliberately NOT named *.spec.ts: `bun test` globs that pattern and would try
 * to run this without a live server.
 */
import { type Browser, type Page, chromium } from "playwright";

// Must be "localhost", not an IP: a WebAuthn RP ID has to be a DOMAIN, so
// http://127.0.0.1 / http://[::1] can't host a passkey ceremony at all. The dev
// server must therefore be started with a matching PUBLIC_BASE_URL, since that
// is what auth.server.ts derives rpID and origin from:
//   PUBLIC_BASE_URL=http://localhost:17923 bun run dev
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17923";

const stage = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Attach a CDP virtual authenticator that behaves like a platform passkey
 * (internal transport, resident keys, user-verified). */
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

async function waitForLog(page: Page, timeoutMs = 20000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = (await page.getByTestId("log").textContent()) ?? "";
    if (
      text.includes("DONE-OK") ||
      text.includes("FAIL") ||
      text.includes("THREW")
    ) {
      return text;
    }
    await page.waitForTimeout(150);
  }
  return (await page.getByTestId("log").textContent()) ?? "(timed out)";
}

async function main() {
  // Prefer Playwright's own chromium (what CI would use); fall back to the
  // locally installed Chrome so a dev without `playwright install` can still run.
  const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  stage("launching browser");
  let browser: Browser | undefined;
  for (const attempt of [
    () => chromium.launch({ headless: true, timeout: 30000 }),
    () =>
      chromium.launch({ channel: "chrome", headless: true, timeout: 30000 }),
    () =>
      chromium.launch({
        executablePath: CHROME,
        headless: true,
        timeout: 30000,
      }),
  ]) {
    try {
      browser = await attempt();
      break;
    } catch {
      /* try the next launcher */
    }
  }
  if (!browser) {
    console.error("No usable Chromium. Run: bunx playwright install chromium");
    process.exit(1);
  }

  // A unique email per run so reruns don't collide on the unique constraint.
  const email = `spike-${Date.now()}@example.com`;

  try {
    // --- 1. Sign up with a passkey, no password anywhere ------------------
    stage("creating context");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) =>
      console.log(`    [browser:${m.type()}] ${m.text()}`),
    );
    page.on("pageerror", (e) =>
      console.log(`    [browser:pageerror] ${e.message}`),
    );

    stage("attaching virtual authenticator");
    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    stage(`navigating to ${BASE}/spike/passkey`);
    await page.goto(`${BASE}/spike/passkey`, { timeout: 60000 });
    stage("page loaded, waiting for hydration");
    await page
      .getByTestId("signup")
      .waitFor({ state: "visible", timeout: 30000 });

    stage("filling form");
    await page.getByTestId("email").fill(email);
    await page.getByTestId("name").fill("Spike Tester");
    stage("clicking signup");
    await page.getByTestId("signup").click();

    const log = await waitForLog(page);
    console.log(`\n--- signup log ---\n${log}\n------------------`);
    check(
      "passkey signup completes with no password",
      log.includes("DONE-OK"),
      log,
    );
    check("session belongs to the new email", log.includes(email));

    // A credential really lives on the authenticator.
    const { credentials } = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    check("exactly one credential was created", credentials.length === 1);
    check(
      "credential is discoverable (resident key)",
      credentials[0]?.isResidentCredential === true,
      "usernameless signIn.passkey() depends on this",
    );

    // --- 2. Sign out (and PROVE it), then sign back in with only the passkey
    stage("signing out");
    await page.getByTestId("signout").click();
    const logOut = await waitForLog(page);
    console.log(`\n--- sign-out log ---\n${logOut}\n--------------------`);
    // This guard matters: an earlier version of this test signed out with a
    // bare fetch that better-auth rejected (415), so the "sign back in" step
    // was silently just re-reading the still-live session and always passed.
    check(
      "sign-out actually clears the session",
      logOut.includes("SESSION-AFTER-SIGNOUT: none"),
      logOut,
    );

    stage("signing back in with only the passkey");
    await page.reload();
    await page
      .getByTestId("signin")
      .waitFor({ state: "visible", timeout: 30000 });
    await page.getByTestId("signin").click();
    const log2 = await waitForLog(page);
    console.log(`\n--- sign-in log ---\n${log2}\n-------------------`);
    check(
      "usernameless sign-in with the passkey works",
      log2.includes("DONE-OK"),
      log2,
    );
    check("signs in as the same account", log2.includes(email));

    await ctx.close();

    // --- 3. Abandoned ceremony must not create an orphan account ----------
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    // No virtual authenticator at all => the ceremony cannot complete.
    await page2.goto(`${BASE}/spike/passkey`);
    const orphanEmail = `orphan-${Date.now()}@example.com`;
    await page2.getByTestId("email").fill(orphanEmail);
    await page2.getByTestId("signup").click();
    const log3 = await waitForLog(page2, 12000);
    check(
      "aborted ceremony reports failure rather than succeeding",
      !log3.includes("DONE-OK"),
      log3,
    );
    // Re-requesting a handle for the same email must still be allowed, which
    // proves no user row was created and the email is not squatted.
    const retry = await page2.evaluate(
      async (e) =>
        (
          await fetch("/api/passkey-signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Retry", email: e }),
          })
        ).status,
      orphanEmail,
    );
    check(
      "no orphan user squats the email after an abort",
      retry === 200,
      `status ${retry}`,
    );

    await ctx2.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
