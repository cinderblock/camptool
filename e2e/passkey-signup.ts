/**
 * Passkey-first signup, sign-in, password kill-switch, and in-app browser
 * warning E2E test — driving the real `/login` UI with a CDP virtual
 * authenticator.
 *
 * Run under NODE, not bun (Playwright hangs under bun — see
 * plans/passkey-first-auth.md), against a SCRATCH database:
 *   DATABASE_PATH=./data/verify/pk-signup.db PUBLIC_BASE_URL=http://localhost:17923 \
 *     PORT=17923 bun run dev
 *   E2E_BASE_URL=http://localhost:17923 bun run e2e:passkey
 *
 * Deliberately NOT named *.spec.ts: `bun test` globs that pattern and would try
 * to run this without a live server.
 */
import { type Browser, chromium, type Page } from "playwright";

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

async function main() {
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

  const email = `passkey-${Date.now()}@example.com`;

  try {
    // --- 0. Password endpoints are refused server-side by default ----------
    stage("checking password kill switch");
    const pwUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        name: "Blocked",
        email: `blocked-${Date.now()}@example.com`,
        password: "password123",
      }),
    });
    check(
      "password sign-up is refused server-side (403)",
      pwUp.status === 403,
      `HTTP ${pwUp.status}`,
    );

    const pwIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "password123",
      }),
    });
    check(
      "password sign-in is refused server-side (403)",
      pwIn.status === 403,
      `HTTP ${pwIn.status}`,
    );

    // --- 1. Sign up with a passkey via real /login UI ----------------------
    stage("creating context");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`    [browser:error] ${m.text()}`);
    });
    page.on("pageerror", (e) =>
      console.log(`    [browser:pageerror] ${e.message}`),
    );

    stage("attaching virtual authenticator");
    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    stage(`navigating to ${BASE}/login`);
    await page.goto(`${BASE}/login`, {
      waitUntil: "load",
      timeout: 60000,
    });
    await page
      .getByRole("button", { name: "Sign in with a passkey" })
      .waitFor({ state: "visible", timeout: 30000 });

    check(
      "login page shows Sign in with a passkey as primary CTA",
      await page
        .getByRole("button", { name: "Sign in with a passkey" })
        .isVisible(),
    );
    check(
      "login page hides password input when passwords are off",
      (await page.locator('input[type="password"]').count()) === 0,
    );

    // Wait for React hydration before clicking the Mantine tab (in Vite dev,
    // SSR HTML arrives before client bundles finish hydrating).
    const createTab = page.getByRole("tab", { name: "Create account" });
    for (let i = 0; i < 20; i++) {
      await createTab.click();
      if ((await createTab.getAttribute("aria-selected")) === "true") break;
      await page.waitForTimeout(250);
    }
    const signupPanel = page.locator('[role="tabpanel"]:visible');
    await signupPanel.getByLabel("Name").waitFor({ state: "visible" });
    check(
      "Create account tab has no password field",
      (await signupPanel.locator('input[type="password"]').count()) === 0,
    );

    await signupPanel.getByLabel("Name").fill("Passkey Tester");
    await signupPanel.getByLabel("Email").fill(email);
    await signupPanel
      .getByRole("button", { name: "Create account with a passkey" })
      .click();

    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 30000,
    });
    check(
      "passkey signup lands signed-in inside the app",
      !page.url().includes("/login"),
      page.url(),
    );

    const session1 = await page.evaluate(async () =>
      (await fetch("/api/auth/get-session")).json(),
    );
    check(
      "session belongs to the new email",
      session1?.user?.email === email,
      JSON.stringify(session1?.user ?? null),
    );

    const { credentials } = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    check("exactly one credential was created", credentials.length === 1);
    check(
      "credential is discoverable (resident key)",
      credentials[0]?.isResidentCredential === true,
      "usernameless signIn.passkey() depends on this",
    );

    // --- 2. Clear session, then sign back in with only the passkey ---------
    stage("clearing cookies and signing back in with passkey");
    await ctx.clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    check(
      "cleared session lands back on /login",
      page.url().includes("/login"),
      page.url(),
    );

    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 30000,
    });
    const session2 = await page.evaluate(async () =>
      (await fetch("/api/auth/get-session")).json(),
    );
    check(
      "usernameless sign-in with passkey restores the same account",
      session2?.user?.email === email,
      JSON.stringify(session2?.user ?? null),
    );

    await ctx.close();

    // --- 3. Abandoned ceremony must not create an orphan account -----------
    stage("testing aborted ceremony leaves no orphan");
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(`${BASE}/login`, { waitUntil: "load" });
    const createTab2 = page2.getByRole("tab", { name: "Create account" });
    for (let i = 0; i < 20; i++) {
      await createTab2.click();
      if ((await createTab2.getAttribute("aria-selected")) === "true") break;
      await page2.waitForTimeout(250);
    }
    const panel2 = page2.locator('[role="tabpanel"]:visible');
    await panel2.getByLabel("Name").waitFor({ state: "visible" });
    const orphanEmail = `orphan-${Date.now()}@example.com`;
    await panel2.getByLabel("Name").fill("Orphan Tester");
    await panel2.getByLabel("Email").fill(orphanEmail);
    await panel2
      .getByRole("button", { name: "Create account with a passkey" })
      .click();
    await page2.waitForTimeout(2500);
    check(
      "aborted ceremony stays on /login",
      page2.url().includes("/login"),
      page2.url(),
    );
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

    // --- 4. In-app browser warning shows for Messenger UA ------------------
    stage("checking in-app browser warning");
    const ctx3 = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22A3354 [FBAN/MessengerForiOS;FBAV/475.0.0.48.108]",
    });
    const page3 = await ctx3.newPage();
    await page3.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page3
      .getByText("Open this link in Safari")
      .waitFor({ timeout: 8000 });
    check(
      "Messenger WebView sees 'Open this link in Safari' warning",
      await page3.getByText("Open this link in Safari").isVisible(),
    );
    check(
      "warning includes a Copy this link button",
      await page3.getByRole("button", { name: "Copy this link" }).isVisible(),
    );
    await ctx3.close();
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
