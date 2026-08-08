/**
 * The passkey nag: a daily-reappearing banner plus a permanent to-do.
 *
 * Exercises the "existing member" path — someone who signed up with a password
 * and therefore has NO passkey, which is precisely who the nag is for. (A
 * passkey-first signup can't test this: those users have one by construction.)
 *
 * Run under NODE, not bun (Playwright hangs under bun — see
 * plans/passkey-first-auth.md), against a SCRATCH database:
 *   DATABASE_PATH=./data/verify/nag.db PUBLIC_BASE_URL=http://localhost:17925 \
 *     PORT=17925 bun run dev
 *   node --experimental-strip-types e2e/passkey-nag.ts
 */
import { type Browser, type Page, chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17925";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

// The nag banner is the only thing carrying a "Not now" control; the Overview
// card and the to-do row do not.
const notNow = (page: Page) => page.getByRole("button", { name: "Not now" });

/**
 * Wait for the banner to reach a state. A bare isVisible() races the SPA — an
 * earlier version of this test checked immediately after signup, before React
 * had rendered, and reported the banner missing when it was merely late.
 */
async function bannerIs(
  page: Page,
  state: "visible" | "hidden",
  timeout = 8000,
): Promise<boolean> {
  try {
    await notNow(page).waitFor({ state, timeout });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let browser: Browser | undefined;
  for (const attempt of [
    () => chromium.launch({ headless: true, timeout: 30000 }),
    () =>
      chromium.launch({ channel: "chrome", headless: true, timeout: 30000 }),
  ]) {
    try {
      browser = await attempt();
      break;
    } catch {
      /* next */
    }
  }
  if (!browser) {
    console.error("No usable Chromium. Run: bunx playwright install chromium");
    process.exit(1);
  }

  const email = `nag-${Date.now()}@example.com`;

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`    [pageerror] ${e.message}`));
    await addVirtualAuthenticator(page);

    // — 1. Sign up the old way: password, no passkey ----------------------
    stage("signing up with a password");
    await page.goto(`${BASE}/login`, { timeout: 60000 });
    await page.getByRole("tab", { name: "Create account" }).click();
    // Both tab panels stay in the DOM, so scope to the visible one or the
    // locators match twice.
    const signup = page.locator('[role="tabpanel"]:visible');
    await signup.getByLabel("Name").fill("Nag Tester");
    await signup.getByLabel("Email").fill(email);
    await signup.getByLabel("Password").fill("hunter2");
    await signup.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 30000,
    });

    check("password signup lands in the app", !page.url().includes("/login"));
    check(
      "banner shows for a user with no passkey",
      await bannerIs(page, "visible"),
    );

    // — 1b. Camp + edition, so the Overview cards and the to-do card render
    // at all (both are camp-scoped, and the ask registry needs an edition).
    stage("creating a camp and a year");
    await page.getByLabel("Camp name").fill("Nag Test Camp");
    await page.getByRole("button", { name: "Create camp" }).click();
    await page.waitForLoadState("networkidle");

    await page.goto(`${BASE}/editions`);
    await page.getByRole("button", { name: "Add year" }).click();
    await page.waitForLoadState("networkidle");

    await page.goto(`${BASE}/`);
    check(
      "passkey sits on the to-do list (the PERSISTENT half)",
      await page.getByText("Set up a passkey").first().isVisible(),
    );

    // — 2. "Not now" snoozes it, and the snooze survives a reload ---------
    stage("dismissing the banner");
    await notNow(page).click();
    check("banner is gone after Not now", await bannerIs(page, "hidden"));

    await page.reload();
    check("snooze survives a reload", await bannerIs(page, "hidden"));

    // Snoozing the banner must NOT clear the to-do row — that's the whole
    // point of "daily nag AND persistent notification".
    check(
      "to-do row survives the snooze",
      await page.getByText("Set up a passkey").first().isVisible(),
    );

    // The snooze is a 24h cookie, so "comes back tomorrow" == the cookie
    // expiring. Assert the mechanism rather than waiting a day.
    const cookies = await ctx.cookies();
    const nag = cookies.find((c) => c.name === "camptool_pknag");
    check("snooze cookie exists", !!nag);
    if (nag) {
      const hours = (nag.expires * 1000 - Date.now()) / 3_600_000;
      check(
        "snooze lasts ~24h, so the nag is DAILY not permanent",
        hours > 23 && hours < 25,
        `expires in ${hours.toFixed(1)}h`,
      );
    }

    // — 3. Clearing the cookie (= the next day) brings it back ------------
    stage("simulating tomorrow");
    await ctx.clearCookies({ name: "camptool_pknag" });
    await page.reload();
    check("banner returns the next day", await bannerIs(page, "visible"));

    // — 4. Enrolling a passkey retires it for good ------------------------
    stage("enrolling a passkey on /account");
    await page.goto(`${BASE}/account`);
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await page.getByText("1 set up").waitFor({ timeout: 20000 });
    check("account page lists the new passkey", true);

    check(
      "the only passkey cannot be removed",
      await page.getByRole("button", { name: "Remove" }).isDisabled(),
      "deleting your last passkey must be refused",
    );

    await page.goto(`${BASE}/`);
    check(
      "banner is gone once a passkey exists",
      await bannerIs(page, "hidden"),
    );
    check(
      "overview card reflects the passkey",
      await page.getByText("1 passkey set up").isVisible(),
    );
    check(
      "to-do row is gone once satisfied",
      !(await page
        .getByText("Set up a passkey")
        .first()
        .isVisible()
        .catch(() => false)),
    );

    // And it stays gone even with no snooze cookie in play.
    await ctx.clearCookies({ name: "camptool_pknag" });
    await page.reload();
    check(
      "still gone after clearing the snooze — satisfied, not snoozed",
      await bannerIs(page, "hidden"),
    );

    await ctx.close();
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
