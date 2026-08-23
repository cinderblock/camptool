/**
 * Camp meetings end to end: an officer schedules a repeating meeting, both an
 * officer and a plain member put things on its agenda, the member RSVPs, and a
 * summary goes from officer-only draft to something the member is told to read
 * and can then clear. Also checks the two invariants the design rests on — a
 * meeting is one `gathering` shown two ways (it appears on /schedule as well),
 * and a draft summary is invisible to everyone but officers.
 *
 * Drives two browser contexts at once (officer + member), because most of what
 * matters here is the difference between what the two of them see.
 *
 * Run under NODE, not bun (Playwright hangs under bun — see
 * plans/passkey-first-auth.md). Needs a dev server and two session cookies:
 *   E2E_BASE_URL=http://localhost:17924 \
 *   E2E_OFFICER_COOKIE='<name>=<value>' E2E_MEMBER_COOKIE='<name>=<value>' \
 *     node --experimental-strip-types e2e/meetings.ts
 */
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17924";
const OFFICER_COOKIE = process.env.E2E_OFFICER_COOKIE ?? "";
const MEMBER_COOKIE = process.env.E2E_MEMBER_COOKIE ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

/** ISO date `days` from today, in the same wall-clock terms the app uses. */
function isoIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

async function contextFor(
  browser: Browser,
  cookie: string,
): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  const eq = cookie.indexOf("=");
  await ctx.addCookies([
    {
      name: cookie.slice(0, eq),
      value: cookie.slice(eq + 1),
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return { ctx, page, errors };
}

const browser = await chromium.launch();
const officer = await contextFor(browser, OFFICER_COOKIE);
const member = await contextFor(browser, MEMBER_COOKIE);

/* ------------------------------------------------- 1. an empty Meetings tab */

stage("officer opens an empty Meetings tab");
await officer.page.goto(`${BASE}/meetings`, { waitUntil: "networkidle" });
check(
  "the tab renders for an officer",
  await officer.page.getByRole("heading", { name: "Meetings" }).isVisible(),
);
check(
  "an empty year says so rather than showing a blank page",
  (await officer.page.textContent("body"))?.includes(
    "No meetings scheduled yet",
  ) ?? false,
);

/* --------------------------------------------- 2. schedule a weekly meeting */

stage("officer schedules a weekly meeting");
await officer.page
  .getByRole("button", { name: "Schedule", exact: true })
  .click();
await officer.page.getByLabel("What's it called").fill("Weekly camp meeting");
await officer.page.getByLabel("Where").fill("Discord");
await officer.page.getByText("Every week", { exact: true }).click();
const first = isoIn(2);
const last = isoIn(23);
await officer.page.getByLabel("First one").fill(first);
await officer.page.getByLabel("Keep going until").fill(last);
await officer.page.getByLabel("Starts").fill("19:00");
await officer.page.getByLabel("Ends").fill("20:00");
await officer.page.getByRole("button", { name: "Schedule it" }).click();
await officer.page.waitForURL(/\/meetings\/[^/]+$/, { timeout: 10_000 });
await officer.page.waitForLoadState("networkidle");
const meetingUrl = officer.page.url();
check(
  "creating a series lands on its first meeting",
  /\/meetings\//.test(meetingUrl),
);
// The redirect is a client-side navigation, so waiting on the network isn't
// enough — wait for React to actually commit the heading. `isVisible()` would
// answer immediately and always say no here; only `waitFor` retries.
const landedOk = await officer.page
  .getByRole("heading", { name: "Weekly camp meeting" })
  .waitFor({ state: "visible", timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
check("the meeting page names the meeting", landedOk);

stage("the weekly cadence materialized one meeting per week");
await officer.page.goto(`${BASE}/meetings`, { waitUntil: "networkidle" });
const cards = await officer.page.$$eval('a[href^="/meetings/"]', (ns) =>
  ns.map((n) => n.getAttribute("href") ?? ""),
);
const distinct = new Set(cards.filter((h) => h !== "/meetings"));
check(
  "four weekly meetings exist across a three-week span",
  distinct.size === 4,
  `got ${distinct.size}`,
);

/* ---------------------------------------- 3. the standing room, on every one */

stage("every meeting offers the camp's standing room");
await officer.page.goto(meetingUrl, { waitUntil: "networkidle" });
const joinHref = await officer.page.getAttribute(
  'a:has-text("Join the Discord voice channel")',
  "href",
);
check(
  "the join button names Discord and its voice channel",
  joinHref?.startsWith("https://discord.com/channels/") ?? false,
  joinHref ?? "no join link",
);
check(
  "the link opens in a new tab without leaking the referrer",
  (
    await officer.page.getAttribute(
      'a:has-text("Join the Discord voice channel")',
      "rel",
    )
  )?.includes("noreferrer") ?? false,
);

/* ------------------------------------------------------ 4. the open agenda  */

stage("officer puts the first item on the agenda");
await officer.page
  .getByLabel("Put the first thing on the agenda")
  .fill("Truck logistics");
await officer.page.getByRole("button", { name: "Add to agenda" }).click();
await officer.page.waitForTimeout(600);
check(
  "the item appears, numbered",
  (await officer.page.textContent("body"))?.includes("1. Truck logistics") ??
    false,
);

stage("a plain MEMBER can add to the agenda too");
await member.page.goto(`${BASE}/meetings`, { waitUntil: "networkidle" });
check(
  "the member sees the meeting on their tab",
  (await member.page.textContent("body"))?.includes("Weekly camp meeting") ??
    false,
);
await member.page.goto(meetingUrl, { waitUntil: "networkidle" });
check(
  "the member sees the officer's item",
  (await member.page.textContent("body"))?.includes("Truck logistics") ?? false,
);
await member.page.getByLabel("Add an item").fill("Can we get a second shade?");
await member.page.getByRole("button", { name: "Add to agenda" }).click();
await member.page.waitForTimeout(600);
check(
  "the member's own item lands on the agenda",
  (await member.page.textContent("body"))?.includes(
    "2. Can we get a second shade?",
  ) ?? false,
);

stage("an agenda item belongs to whoever added it");
const editButtons = await member.page.$$('button:has-text("Edit")');
check(
  "the member gets edit controls on exactly their own item, not the officer's",
  editButtons.length === 1,
  `${editButtons.length} Edit buttons visible to the member`,
);

await officer.page.reload({ waitUntil: "networkidle" });
const officerEditButtons = await officer.page.$$('button:has-text("Edit")');
check(
  "an officer can moderate every item (both, plus the summary editor's own)",
  officerEditButtons.length >= 2,
  `${officerEditButtons.length} Edit buttons visible to the officer`,
);

/* ---------------------------------------------------------------- 5. RSVP  */

stage("the member says they're coming");
await member.page.getByRole("button", { name: "I'll be there" }).click();
await member.page.waitForTimeout(600);
await officer.page.reload({ waitUntil: "networkidle" });
check(
  "the officer sees who's coming",
  (await officer.page.textContent("body"))?.includes("Mabel coming") ?? false,
);

/* -------------------------------------------------- 6. draft vs published  */

stage("officer writes the summary as a draft");
await officer.page
  .getByLabel("Write-up")
  .fill("Decided: Ollie drives the truck. Shade deferred to next week.");
await officer.page.getByRole("button", { name: "Save as draft" }).click();
await officer.page.waitForTimeout(700);
await officer.page.reload({ waitUntil: "networkidle" });
check(
  "the officer sees it flagged as a draft",
  (await officer.page.textContent("body"))?.includes("draft — only officers") ??
    false,
);

await member.page.reload({ waitUntil: "networkidle" });
const memberDraftView = (await member.page.textContent("body")) ?? "";
check(
  "the member cannot see a draft summary at all",
  !memberDraftView.includes("Ollie drives the truck"),
);
check(
  "and isn't even told one is being written",
  !memberDraftView.includes("draft"),
);

stage("publishing is what distributes it");
await officer.page
  .getByRole("button", { name: "Publish to the camp" })
  .first()
  .click();
await officer.page.waitForTimeout(800);

await member.page.reload({ waitUntil: "networkidle" });
check(
  "the member now reads the summary",
  (await member.page.textContent("body"))?.includes("Ollie drives the truck") ??
    false,
);
check(
  "and is told it's outstanding until they mark it read",
  (await member.page.textContent("body"))?.includes(
    "on your home page until you've marked it read",
  ) ?? false,
);

stage("an unread summary is a to-do on the member's home page");
await member.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
const home = (await member.page.textContent("body")) ?? "";
check(
  "the Overview lists it as something to do",
  home.includes("Read the summary from Weekly camp meeting"),
);
check(
  "the Overview also shows the next meeting",
  home.includes("Next meeting"),
);

stage("marking it read clears the nudge");
await member.page.goto(meetingUrl, { waitUntil: "networkidle" });
await member.page.getByRole("button", { name: "Got it" }).click();
await member.page.waitForTimeout(700);
await member.page.goto(`${BASE}/`, { waitUntil: "networkidle" });
check(
  "the to-do is gone once read",
  !((await member.page.textContent("body")) ?? "").includes(
    "Read the summary from Weekly camp meeting",
  ),
);

/* ------------------------------- 7. one entity, two views (the design bet)  */

stage("the same meeting is on the Schedule, because it IS a gathering");
await member.page.goto(`${BASE}/schedule`, { waitUntil: "networkidle" });
const sched = (await member.page.textContent("body")) ?? "";
check("the Schedule agenda lists it", sched.includes("Weekly camp meeting"));
check("and labels it a Meeting", sched.includes("Meeting"));

/* ------------------------------------------- 8. a locked year is read-only  */

stage("locking the year freezes meetings for everyone");
await officer.page.goto(`${BASE}/editions`, { waitUntil: "networkidle" });
await officer.page
  .getByRole("button", { name: "Lock", exact: true })
  .first()
  .click();
await officer.page.waitForTimeout(900);

await member.page.goto(meetingUrl, { waitUntil: "networkidle" });
const lockedMember = (await member.page.textContent("body")) ?? "";
check(
  "the member is told the year is locked",
  lockedMember.includes("This year is locked"),
);
check(
  "and the add-to-agenda box is gone",
  (await member.page.$('button:has-text("Add to agenda")')) === null,
);
check(
  "and so is the RSVP control",
  (await member.page.$('button:has-text("I\'ll be there")')) === null,
);
check(
  "but the agenda and summary are still readable",
  lockedMember.includes("Truck logistics") &&
    lockedMember.includes("Ollie drives the truck"),
);

// Snapshot the console before the deliberate failures below — a rejected POST
// and a 404 navigation both log, and would otherwise mask a real error.
const consoleBeforeFailures = [...officer.errors, ...member.errors];

stage("the server refuses a write to a locked year, not just the UI");
const refused = await member.page.evaluate(async (url) => {
  const body = new URLSearchParams({
    intent: "addAgendaItem",
    title: "snuck in past the UI",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.status;
}, meetingUrl);
check("a hand-rolled POST is rejected", refused === 403, `status ${refused}`);
await member.page.reload({ waitUntil: "networkidle" });
check(
  "and nothing was written",
  !((await member.page.textContent("body")) ?? "").includes(
    "snuck in past the UI",
  ),
);

stage("unlocking restores it");
await officer.page.goto(`${BASE}/editions`, { waitUntil: "networkidle" });
await officer.page.getByRole("button", { name: "Unlock" }).first().click();
await officer.page.waitForTimeout(900);
await member.page.goto(meetingUrl, { waitUntil: "networkidle" });
check(
  "the add-to-agenda box is back",
  (await member.page.$('button:has-text("Add to agenda")')) !== null,
);

/* -------------------------------------------------------- 9. the 404 guard */

stage("a made-up meeting id is a 404, not a leak");
const bogus = await member.page.goto(`${BASE}/meetings/not-a-real-occurrence`, {
  waitUntil: "networkidle",
});
check(
  "an unknown occurrence 404s",
  bogus?.status() === 404,
  `status ${bogus?.status()}`,
);

/* ------------------------------------------------------------------ wrap up */

const allErrors = consoleBeforeFailures.filter(
  // Vite's dev-time HMR chatter isn't the app's doing.
  (e) => !/favicon|Download the React DevTools/i.test(e),
);
check(
  "no console errors in either browser",
  allErrors.length === 0,
  allErrors.slice(0, 3).join(" | "),
);

await browser.close();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
