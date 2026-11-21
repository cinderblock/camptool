/**
 * The start-the-new-year banner (app/lib/year-nudge.ts).
 *
 * A brand-new camp has no year, and an existing camp sails past exodus still
 * on last year. Officers get a banner with a one-click fix and a two-week
 * "Not now"; a member of a camp with no year at all is told to wait.
 *
 * Run under NODE, not bun (Playwright hangs under bun), against a SCRATCH
 * database:
 *   DATABASE_PATH=./data/verify/yearnudge.db PUBLIC_BASE_URL=http://localhost:17926 \
 *     PORT=17926 bun run dev
 *   node --experimental-strip-types e2e/year-nudge.ts
 */
import { type Browser, chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17926";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

/** Wait for some text to reach a state. A bare isVisible() never waits, so it
 * races the SPA after every navigation. */
async function textIs(
  page: Page,
  text: string | RegExp,
  state: "visible" | "hidden",
  timeout = 8000,
): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ state, timeout });
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

  const email = `yearnudge-${Date.now()}@example.com`;

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`    [pageerror] ${e.message}`));

    // — 1. A new camp, with no year ------------------------------------------
    stage("signing up and creating a camp");
    // Over the API: the login page is passkey-first now, and what's under
    // test here is the shell, not sign-up. The context's request shares its
    // cookie jar, so the page is signed in afterwards.
    const res = await ctx.request.post(`${BASE}/api/auth/sign-up/email`, {
      headers: { Origin: BASE },
      data: { email, password: "hunter2hunter2", name: "Year Nudge Tester" },
    });
    check("signed up", res.ok(), String(res.status()));
    await page.goto(`${BASE}/`, { timeout: 60000 });
    // Typing before hydration lands in the server-rendered input but never
    // reaches React's state, so the button stays disabled. Retype until the
    // form has taken it.
    const createBtn = page.getByRole("button", { name: "Create camp" });
    for (let i = 0; i < 10 && !(await createBtn.isEnabled()); i++) {
      await page.getByLabel("Camp name").fill(`Nudge Camp ${Date.now()}`);
      await page.waitForTimeout(1000);
    }
    await createBtn.click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${BASE}/`);

    check(
      "a camp with no year asks for its first",
      await textIs(page, "Add your camp's first year.", "visible"),
    );
    const addBtn = page.getByRole("button", { name: /^Add \d{4}$/ });
    const addLabel = (await addBtn.textContent()) ?? "";
    const current = Number(addLabel.replace("Add ", ""));
    check("it offers the current event year", current >= 2026, addLabel);

    // — 2. Behind by a year: last year exists, this one doesn't ---------------
    stage(`adding ${current - 1} by hand on /editions`);
    await page.goto(`${BASE}/editions`);
    // Same hydration race as the camp name: a value typed too early is
    // replaced by the default when React takes over.
    await page.waitForLoadState("networkidle");
    await page.getByLabel("New year").fill(String(current - 1));
    await page.getByRole("button", { name: "Add year" }).click();
    await page.waitForLoadState("networkidle");

    check(
      `with only ${current - 1}, it offers to start ${current}`,
      await textIs(page, `Time to start ${current}.`, "visible"),
    );
    const startBtn = page.getByRole("button", { name: `Start ${current}` });
    check("the button names the year", await startBtn.isVisible());

    // — 3. "Not now" snoozes it for two weeks ---------------------------------
    stage("snoozing");
    await page.goto(`${BASE}/`);
    // The passkey banner has a "Not now" too.
    await page
      .locator('form:has(input[value="snoozeYearNudge"])')
      .getByRole("button", { name: "Not now" })
      .click();
    check(
      "banner is gone after Not now",
      await textIs(page, `Time to start ${current}.`, "hidden"),
    );
    check(
      "Not now came back to the same page",
      new URL(page.url()).pathname === "/",
      page.url(),
    );
    await page.reload();
    check(
      "snooze survives a reload",
      await textIs(page, `Time to start ${current}.`, "hidden"),
    );
    const snooze = (await ctx.cookies()).find(
      (c) => c.name === "camptool_yrnudge",
    );
    check(
      "snooze cookie names the year",
      snooze?.value === String(current),
      snooze?.value,
    );
    if (snooze) {
      const days = (snooze.expires * 1000 - Date.now()) / 86_400_000;
      check(
        "snooze lasts ~2 weeks",
        days > 13.9 && days < 14.1,
        `${days.toFixed(2)} days`,
      );
    }

    // — 4. Two weeks later, it's back; one click starts the year --------------
    stage("simulating two weeks later and starting the year");
    await ctx.clearCookies({ name: "camptool_yrnudge" });
    await page.reload();
    check(
      "banner returns once the snooze expires",
      await textIs(page, `Time to start ${current}.`, "visible"),
    );
    await page.getByRole("button", { name: `Start ${current}` }).click();
    await page.waitForURL((u) => u.pathname === "/editions", {
      timeout: 15000,
    });
    await page.waitForLoadState("networkidle");
    check(
      `${current} is now the year being viewed`,
      await page
        .getByRole("row")
        .filter({ hasText: String(current) })
        .getByText("viewing")
        .isVisible(),
    );
    check(
      `the header picker shows ${current}`,
      (await page
        .getByRole("textbox", { name: "Year" })
        .first()
        .inputValue()) === String(current),
    );
    check(
      "banner is gone once the year exists",
      await textIs(page, /Time to start|first year/, "hidden"),
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
