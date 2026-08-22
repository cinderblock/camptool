/**
 * Map versions everyone can see, and the diff against the official map
 * (`plans/map-versions-and-diffs.md`).
 *
 * Three things resolve to a whole layout — the live official map, a saved named
 * snapshot, and the set of suggestions one camper has outstanding — and this
 * drives all three through the same viewer, checking that opening one is
 * read-only, that the diff says the true thing, and that a MEMBER (not just an
 * officer) can see the list at all, which was the whole complaint.
 *
 * Run under NODE, not bun (Playwright hangs under bun — see
 * plans/passkey-first-auth.md). Needs a dev server with a saved snapshot that
 * differs from the official map and at least one camper's suggestions:
 *   E2E_BASE_URL=http://localhost:17923 E2E_COOKIE='<name>=<value>' \
 *   E2E_MEMBER_COOKIE='<name>=<value>' \
 *     node --experimental-strip-types e2e/map-versions.ts
 */
import { type Browser, type Page, chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17923";
const COOKIE = process.env.E2E_COOKIE ?? "";
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

async function openMap(browser: Browser, cookie: string): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
  });
  if (cookie) {
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
  }
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${BASE}/map`, { waitUntil: "networkidle" });
  await page.waitForSelector("#camp-map-svg", { timeout: 20000 });
  return page;
}

const errors: string[] = [];

/** Every object's centre in view units — so a probe can prove the map redrew. */
async function objectCenters(page: Page): Promise<string[]> {
  return page.$$eval("#camp-map-svg g[transform^='rotate']", (ns) =>
    ns.map((n) => n.getAttribute("transform") ?? "").sort(),
  );
}

const browser = await chromium.launch();

// ---- Officer ---------------------------------------------------------------
stage("officer: the Versions panel lists every layout in flight");
const page = await openMap(browser, COOKIE);
const panel = page
  .locator("[data-version-row]")
  .first()
  .locator("xpath=ancestor::div[contains(@class,'mantine-Paper-root')][1]");
check("the panel is called Versions", await panel.isVisible());
check(
  "the official map is in the list",
  await page.getByText("Official map", { exact: true }).isVisible(),
);
check(
  "the saved snapshot is in the list",
  await page.getByText("Planned v1", { exact: true }).isVisible(),
);
check(
  "the camper's suggestions read as a version of their own",
  await page.getByText("Mabel Member's version").isVisible(),
);
await page.screenshot({ path: "data/verify/versions-1-list.png" });

stage("officer: open the saved snapshot — read-only, and the diff is honest");
const beforeCenters = await objectCenters(page);
const snapKey = await page
  .locator("[data-version-row^='snapshot:']")
  .first()
  .getAttribute("data-version-row");
await page
  .locator(`[data-version-row='${snapKey}']`)
  .getByRole("button", { name: "View" })
  .click();
await page.waitForTimeout(700);
check(
  "a banner names what's on screen",
  await page.getByText("Viewing Planned v1").isVisible(),
);
check(
  "the banner says it's read-only",
  (await page.getByText(/read-only/).count()) > 0,
);
check(
  "the map actually redrew to the version",
  JSON.stringify(await objectCenters(page)) !== JSON.stringify(beforeCenters),
);
// The fixture: the officer moved+turned a tent and deleted a container AFTER
// saving, so vs. official the snapshot has one thing moved and one thing only
// it has.
const diffText = (await panel.textContent()) ?? "";
check(
  "the diff names the thing that moved",
  /moved/.test(diffText),
  diffText.slice(0, 300),
);
check(
  "the diff names the thing only this version has",
  /only in this version/.test(diffText),
  diffText.slice(0, 300),
);
check(
  "the diff overlay is drawn on the map",
  (await page.locator("#camp-map-svg polygon[stroke='#868e96']").count()) > 0 ||
    (await page.locator("#camp-map-svg polygon[stroke='#fa5252']").count()) > 0,
);
await page.screenshot({ path: "data/verify/versions-2-snapshot-diff.png" });

stage("officer: a version cannot be edited");
check(
  "the officer's editing palettes stand down",
  (await page.getByText(/drag onto the map/i).count()) === 0,
  `${await page.getByText(/drag onto the map/i).count()} palette headers still showing`,
);
check(
  "saving is not offered while looking at a version",
  (await page.getByPlaceholder("Save the official map as…").count()) === 0,
);
// Arrow keys nudge a selected object on the official map; on a version there is
// nothing to nudge and nothing may move.
const viewCenters = await objectCenters(page);
await page.locator("#camp-map-svg").click({ position: { x: 300, y: 300 } });
for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(500);
check(
  "arrow keys move nothing while a version is open",
  JSON.stringify(await objectCenters(page)) === JSON.stringify(viewCenters),
);

stage("officer: open the camper's version");
await page
  .locator("[data-version-row^='member:']")
  .first()
  .getByRole("button", { name: "View" })
  .click();
await page.waitForTimeout(700);
check(
  "the banner names the camper",
  await page.getByText("Viewing Mabel Member's version").isVisible(),
);
const memberDiff = (await panel.textContent()) ?? "";
// Two suggestions were made, and a suggestion can only ever move something.
check(
  "both of the camper's moves show up, and nothing is added or dropped",
  (memberDiff.match(/moved/g) ?? []).length === 2 &&
    !/only in this version/.test(memberDiff) &&
    !/not in this version/.test(memberDiff),
  memberDiff.slice(0, 400),
);
await page.screenshot({ path: "data/verify/versions-3-member-diff.png" });

stage("officer: back to the official map");
await page.getByRole("button", { name: "Back to the official map" }).click();
await page.waitForTimeout(600);
check("the banner is gone", (await page.getByText(/^Viewing /).count()) === 0);
check(
  "the official map is back exactly as it was",
  JSON.stringify(await objectCenters(page)) === JSON.stringify(beforeCenters),
);

// ---- Member ----------------------------------------------------------------
// The point of the whole change: a member could not see the saved layouts at
// all, because the panel was officer-gated.
stage("member: can see every version, and none of the officer verbs");
const mpage = await openMap(browser, MEMBER_COOKIE);
check(
  "a member sees the Versions panel",
  await mpage.getByText("Versions", { exact: true }).isVisible(),
);
check(
  "a member sees the officer's saved snapshot",
  await mpage.getByText("Planned v1", { exact: true }).isVisible(),
);
check(
  "a member sees their own version",
  await mpage.getByText("Mabel Member's version").isVisible(),
);
check(
  "a member gets no way to save a version",
  (await mpage.getByPlaceholder("Save the official map as…").count()) === 0,
);
check(
  "a member gets no way to restore or delete one",
  (await mpage.getByRole("button", { name: "Version actions" }).count()) === 0,
);

stage("member: can open a version and read the diff");
await mpage
  .locator("[data-version-row^='snapshot:']")
  .first()
  .getByRole("button", { name: "View" })
  .click();
await mpage.waitForTimeout(700);
check(
  "the version opens for a member too",
  await mpage.getByText("Viewing Planned v1").isVisible(),
);
await mpage.screenshot({ path: "data/verify/versions-4-member-view.png" });

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
console.log(`\n${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
