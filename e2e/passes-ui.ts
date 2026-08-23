/**
 * Click-through of the camper-facing `/passes` group card and the stay picker,
 * in a real browser.
 *
 * The HTTP e2e (`e2e/sap-passes.ts`) proves the actions and the authorization,
 * but it can't prove the half that only exists in the browser: that the modal
 * opens, that tapping two days on the event calendar produces a range, that
 * Save carries it to the server, and — the one most likely to break silently —
 * that `StayRangeField`'s hidden inputs actually put the dates into a native
 * form submit. A controlled component wired into a plain `<form>` either works
 * or drops the value on the floor, and nothing server-side can tell you which.
 *
 * Authenticates by installing a session cookie minted from the sign-in API
 * rather than typing into the login form, so no password is ever put through a
 * browser.
 *
 * Run with a dev server already up:
 *   DATABASE_PATH=./data/verify/ui.db PUBLIC_BASE_URL=http://localhost:17936 \
 *     PORT=17936 bun run dev
 *   E2E_EMAIL=$(DATABASE_PATH=./data/verify/ui.db bun -e "…")  *     E2E_BASE_URL=http://localhost:17936 bun run e2e:passes-ui
 *
 * Deliberately NOT named *.spec.ts (bun test would try to run it serverless),
 * and run under node, not bun — `chromium.launch()` never returns under Bun.
 */
import { type Browser, type Page, chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17936";
const PW = process.env.E2E_PASSWORD ?? "sap-tester-pw-1";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Sign in over the API and hand the cookie to the browser. */
async function sessionCookie(email: string): Promise<{
  name: string;
  value: string;
}> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    // better-auth checks the Origin against PUBLIC_BASE_URL; node's fetch
    // sends none by default and the request comes back 403.
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  const raw = (res.headers.getSetCookie() ?? []).find((c) =>
    c.includes("session_token"),
  );
  if (!raw) throw new Error("no session cookie in the sign-in response");
  const [pair] = raw.split(";");
  const eq = (pair ?? "").indexOf("=");
  return { name: (pair ?? "").slice(0, eq), value: (pair ?? "").slice(eq + 1) };
}

/**
 * Whose account to drive. Passed in rather than looked up, because the database
 * layer is Bun-only (`bun:sqlite`) and this script has to run under node —
 * `chromium.launch()` never returns under Bun.
 */
function seededEmail(): string {
  const email = process.env.E2E_EMAIL;
  if (!email) {
    throw new Error(
      "set E2E_EMAIL to a seeded account (see the header for the one-liner)",
    );
  }
  return email;
}

/** "Mon, Aug 24" — how the group card renders a picked day. */
function longDay(iso: string): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[dt.getUTCDay()]}, ${shortDay(iso)}`;
}

/** "Tue" — the roster renders stays as weekday chips. */
function weekday(iso: string): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()] ?? ""
  );
}

/** "Aug 24". */
function shortDay(iso: string): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

let browser: Browser | undefined;
try {
  const email = seededEmail();
  const cookie = await sessionCookie(email);
  const url = new URL(BASE);

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const page: Page = await context.newPage();

  // ------------------------------------------------------- the group card
  await page.goto(`${BASE}/passes`, { waitUntil: "networkidle" });
  check(
    "1. the group card renders for a signed-in camper",
    await page.getByText("Your group").first().isVisible(),
  );

  const rows = page.locator("text=/Pick dates|→/");
  check("1b. it shows a stay line per person", (await rows.count()) > 0);

  // A card containing nothing but its own heading is worse than no card. This
  // camper already holds passes and has no open request, so the ask card has
  // nothing to say and must not render.
  const askCard = page
    .locator("div.mantine-Card-root")
    .filter({ hasText: "Early arrival" });
  check(
    "1c. the empty 'Early arrival' card is not rendered",
    (await askCard.count()) === 0,
    `${await askCard.count()} rendered`,
  );

  // ------------------------------------------------ the calendar modal
  const setDates = page
    .getByRole("button", { name: /Set dates|Change dates/ })
    .first();
  await setDates.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  check(
    "2. tapping the dates button opens the calendar",
    await dialog.isVisible(),
  );
  check(
    "2b. and it is the event calendar, not a browser date box",
    (await dialog.getByText(/Tap the day they arrive/).count()) > 0,
    "missing the calendar's own instruction line",
  );
  check(
    "2c. which marks the event's named days",
    (await dialog.getByText(/Gates|Burn|Exodus/i).count()) > 0,
  );

  // Two taps inside the calendar = a range. Day buttons carry their ISO date.
  // Only the ENABLED ones: the grid pads out to whole Sun–Sat weeks with
  // disabled cells outside the event window, and clicking one does nothing —
  // which is exactly how this test first "passed" a save that never happened.
  const days = dialog.locator("[data-date]:not([disabled])");
  const dayCount = await days.count();
  check("3. the calendar renders tappable days", dayCount > 10, `${dayCount}`);

  const first = days.nth(Math.floor(dayCount / 3));
  const second = days.nth(Math.floor(dayCount / 3) + 3);
  const firstIso = await first.getAttribute("data-date");
  const secondIso = await second.getAttribute("data-date");
  await first.click();
  await second.click();

  await dialog.getByRole("button", { name: "Save" }).click();
  await page.waitForLoadState("networkidle");

  const shown = await page.getByText("Your group").first().isVisible();
  check("4. saving closes the modal and the card is still there", shown);
  if (firstIso && secondIso) {
    const body = (await page.textContent("body")) ?? "";
    check(
      "4b. and the picked range is now on the page",
      body.includes(longDay(firstIso)),
      `expected ${longDay(firstIso)}`,
    );
  }

  // ------------------------------------------ the add-guest form's hidden inputs
  // The one that fails silently: a controlled calendar inside a native form.
  await page.goto(`${BASE}/roster`, { waitUntil: "networkidle" });
  const addName = page.getByPlaceholder("Full name");
  if ((await addName.count()) > 0) {
    const guestName = `UI Guest ${Date.now()}`;
    await addName.fill(guestName);

    await page
      .locator('form:has(input[placeholder="Full name"])')
      .getByRole("button", { name: /Pick dates|→/ })
      .click();
    const gd = page.getByRole("dialog");
    await gd.waitFor({ state: "visible", timeout: 5000 });
    const gdays = gd.locator("[data-date]:not([disabled])");
    const gCount = await gdays.count();
    const gFirst = gdays.nth(Math.floor(gCount / 3));
    const gFirstIso = await gFirst.getAttribute("data-date");
    await gFirst.click();
    await gdays.nth(Math.floor(gCount / 3) + 3).click();
    await gd.getByRole("button", { name: "Done" }).click();

    // Scope to the guest form: the page has another "Add" (the party-host
    // member picker) which stays disabled until a member is chosen.
    await page
      .locator('form:has(input[placeholder="Full name"]) button[type="submit"]')
      .click();
    // A fetcher submit revalidates asynchronously, so wait for the row rather
    // than for the network to fall quiet.
    await page
      .getByText(guestName)
      .first()
      .waitFor({ state: "visible", timeout: 10000 })
      .catch(() => {});

    // Verified through the page rather than the database — the stronger check,
    // because it proves the whole round trip rather than just a write.
    const rosterBody = (await page.textContent("body")) ?? "";
    check(
      "5. the guest was added",
      rosterBody.includes(guestName),
      "not on the page",
    );

    // Scoped to THIS guest's card. Checking the whole page would pass on any
    // other person's date — which is exactly how this check first "passed"
    // while the guest hadn't been added at all.
    // `.last()`, not `.first()`: filter matches every ancestor that contains
    // the text, and they come back outermost-first — so first() is the whole
    // party card and last() is the guest's own row.
    const card = page
      .locator("div.mantine-Paper-root")
      .filter({ hasText: guestName })
      .last();
    const cardText = (await card.textContent().catch(() => "")) ?? "";
    // The roster renders a stay as WEEKDAY chips ("Tue (setup) → Fri"), not as
    // a month/day — so assert what it actually shows. That it says "(setup)"
    // for a pre-gate-open arrival is the same boundary the pass rules use.
    check(
      "5b. and the calendar's dates reached the server through the form",
      gFirstIso ? cardText.includes(weekday(gFirstIso)) : false,
      `picked ${gFirstIso} (${gFirstIso ? weekday(gFirstIso) : "?"}), card reads "${cardText.slice(0, 80)}"`,
    );
  } else {
    check("5. add-guest form present", false, "not rendered for this account");
  }

  await page.goto(`${BASE}/passes`, { waitUntil: "networkidle" });
  await page.screenshot({ path: "data/verify/passes-ui.png", fullPage: true });
  console.log("\n  screenshot: data/verify/passes-ui.png");
} finally {
  await browser?.close();
}

console.log(
  `\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
