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

    const magicIn = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    check(
      "magic-link sign-in is refused server-side (403)",
      magicIn.status === 403,
      `HTTP ${magicIn.status}`,
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

    // First user on a fresh DB is super admin — mint a camp setup link to test
    // the in-app browser & missing-WebAuthn gates on /new-camp/:token.
    stage("minting a camp setup link on /admin");
    await page.goto(`${BASE}/admin`, { waitUntil: "load" });
    await page.getByLabel("Who it's for").fill("Entheos Test");
    await page.getByRole("button", { name: "Make link" }).click();
    await page.getByText("Entheos Test").waitFor({ timeout: 15000 });
    const setupUrl = await page.evaluate(async () => {
      const res = await fetch("/admin", {
        method: "POST",
        body: new URLSearchParams({
          intent: "createSetupLink",
          label: "Gate Test Camp",
          slug: `gate-${Date.now().toString(36)}`,
        }),
      });
      const text = await res.text();
      const m = text.match(/\/new-camp\/[A-Za-z0-9_-]+/);
      return m ? `${location.origin}${m[0]}` : null;
    });
    check(
      "super admin can mint a camp setup link",
      Boolean(setupUrl),
      setupUrl ?? "none",
    );

    // Super admin can also issue a site-level recovery link for a user who
    // belongs to no camp yet (here, the admin themselves has no camp).
    const camplessRecoveryUrl = await page.evaluate(async (targetEmail) => {
      const res = await fetch("/admin", {
        method: "POST",
        body: new URLSearchParams({
          intent: "issueRecoveryLink",
          email: targetEmail,
        }),
      });
      const text = await res.text();
      const m = text.match(/\/reset\/[A-Za-z0-9_-]+/);
      return m ? `${location.origin}${m[0]}` : null;
    }, email);
    check(
      "super admin can issue a recovery link for a user with no camp",
      Boolean(camplessRecoveryUrl),
      camplessRecoveryUrl ?? "none",
    );
    if (camplessRecoveryUrl) {
      // Signed-in session opening a recovery link sees a clear status card and
      // cannot accidentally burn the link via api.passkey-recovery (409).
      await page.goto(camplessRecoveryUrl, { waitUntil: "networkidle" });
      check(
        "signed-in browser opening /reset/:token sees 'You're signed in as' guard",
        await page.getByText("You're signed in as").isVisible(),
      );
      check(
        "signed-in guard reassures that opening it didn't use the link",
        await page.getByText("Opening it here didn").isVisible(),
      );
      const token = camplessRecoveryUrl.split("/reset/")[1] ?? "";
      const signedInRecoveryStatus = await page.evaluate(
        async ({ t, e }) =>
          (
            await fetch("/api/passkey-recovery", {
              method: "POST",
              body: new URLSearchParams({ token: t, email: e }),
            })
          ).status,
        { t: token, e: email },
      );
      check(
        "api.passkey-recovery refuses an already-signed-in browser (409)",
        signedInRecoveryStatus === 409,
        `HTTP ${signedInRecoveryStatus}`,
      );

      const resetHtml = await (await fetch(camplessRecoveryUrl)).text();
      check(
        "site-admin recovery link renders 'a site admin'",
        resetHtml.includes("a site admin"),
      );
      const pwReset = await fetch(camplessRecoveryUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email,
          password: "blocked-password-1",
          confirm: "blocked-password-1",
        }),
        redirect: "manual",
      });
      check(
        "password POST on /reset/:token is refused (403) when passwords are off",
        pwReset.status === 403,
        `HTTP ${pwReset.status}`,
      );
    }

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

    // --- 4. In-app browser warning & hard gate for Messenger UA ------------
    stage("checking in-app browser warning & /new-camp gate");
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
      "Messenger WebView sees 'Open this link in Safari' warning on /login",
      await page3.getByText("Open this link in Safari").isVisible(),
    );
    check(
      "warning includes a Copy this link button",
      await page3.getByRole("button", { name: "Copy this link" }).isVisible(),
    );

    if (setupUrl) {
      await page3.goto(setupUrl, { waitUntil: "networkidle" });
      check(
        "Messenger WebView is hard-gated on /new-camp/:token",
        await page3.getByText("Open this link in Safari first").isVisible(),
      );
      check(
        "hard gate reassures that the setup link hasn't been used yet",
        await page3
          .getByText("Your setup link hasn't been used yet")
          .isVisible(),
      );
      check(
        "Messenger WebView cannot see the signup/camp form",
        (await page3
          .getByRole("button", { name: "Create account with a passkey" })
          .count()) === 0 &&
          (await page3.getByRole("button", { name: "Create camp" }).count()) ===
            0,
      );
    }
    await ctx3.close();

    // --- 5. Browser lacking PublicKeyCredential is hard-gated too ----------
    if (setupUrl) {
      stage("checking missing-WebAuthn hard gate on /new-camp/:token");
      const ctx4 = await browser.newContext();
      await ctx4.addInitScript(() => {
        Object.defineProperty(window, "PublicKeyCredential", {
          value: undefined,
          configurable: true,
        });
      });
      const page4 = await ctx4.newPage();
      await page4.goto(setupUrl, { waitUntil: "networkidle" });
      await page4
        .getByText("Open this link in a modern browser first")
        .waitFor({ timeout: 8000 });
      check(
        "browser without PublicKeyCredential is hard-gated on /new-camp/:token",
        await page4
          .getByText("Open this link in a modern browser first")
          .isVisible(),
      );
      check(
        "missing-WebAuthn browser cannot see the signup form",
        (await page4
          .getByRole("button", { name: "Create account with a passkey" })
          .count()) === 0,
      );
      await ctx4.close();

      // --- 6. Real browser with passkey support still redeems the link -----
      stage("redeeming /new-camp/:token in a real passkey-capable browser");
      const ctx5 = await browser.newContext();
      const page5 = await ctx5.newPage();
      page5.on("console", (m) => {
        if (m.type() === "error") console.log(`    [page5:error] ${m.text()}`);
      });
      page5.on("pageerror", (e) =>
        console.log(`    [page5:pageerror] ${e.message}`),
      );
      await addVirtualAuthenticator(page5);
      await page5.goto(setupUrl, { waitUntil: "networkidle" });
      await page5
        .getByRole("button", { name: "Create account with a passkey" })
        .waitFor({ state: "visible", timeout: 20000 });
      // Ensure React has hydrated the Mantine form before submitting.
      const leadEmail = `lead-${Date.now()}@example.com`;
      await page5.getByLabel("Your name").fill("Camp Lead");
      await page5.getByLabel("Email").fill(leadEmail);
      await page5
        .getByRole("button", { name: "Create account with a passkey" })
        .click();
      await page5
        .getByRole("button", { name: "Create camp" })
        .waitFor({ state: "visible", timeout: 25000 });
      check(
        "passkey signup on /new-camp/:token unlocks Create camp form",
        await page5.getByRole("button", { name: "Create camp" }).isVisible(),
      );
      await page5.getByLabel("Camp name").fill("Entheos Test");
      await page5.getByRole("button", { name: "Create camp" }).click();
      await page5.waitForURL((u) => !u.pathname.startsWith("/new-camp"), {
        timeout: 25000,
      });
      check(
        "real browser completes camp creation from the untouched setup link",
        !page5.url().includes("/new-camp"),
        page5.url(),
      );
      await ctx5.close();
    }
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
