/**
 * Camp structures (plans/custom-structures.md): an officer defines a camp kind
 * in the editor — a custom outline drawn by dragging and adding corners — then
 * drops it onto the map, where it draws as its real outline.
 *
 * Run under NODE, not bun (Playwright hangs under bun). Needs an officer's
 * session cookie in a camp with a lot set up:
 *   E2E_BASE_URL=http://localhost:17931 E2E_COOKIE='<name>=<value>' \
 *     node --experimental-strip-types e2e/custom-structures.ts
 * Optionally E2E_LOT=frontage,depth,rear (feet) for the drop maths (depth is
 * unused, kept so the triple reads naturally); defaults
 * to Math Camp's 100 × 200 lot.
 */
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17923";
const COOKIE = process.env.E2E_COOKIE ?? "";
const [FRONT, , REAR] = (process.env.E2E_LOT ?? "100,200,104.93")
  .split(",")
  .map(Number) as [number, number, number];
const OUT = "data/verify";
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

/** Plot feet → map view units, as `layoutFor` computes it. */
function layout(frontageFt: number, rearFt: number) {
  const maxW = Math.max(frontageFt, rearFt);
  const ppf = (920 - 2 * 28) / (maxW + 100);
  return {
    ppf,
    originX: 28 + 50 * ppf + ((maxW - frontageFt) / 2) * ppf,
    originY: 28 + 50 * ppf,
  };
}

async function dropKind(page: Page, kind: string, fx: number, fy: number) {
  const L = layout(FRONT, REAR);
  await page.evaluate(
    ({ kind, fx, fy, L }) => {
      const svg = document.querySelector("#camp-map-svg") as SVGSVGElement;
      const p = svg.createSVGPoint();
      p.x = L.originX + fx * L.ppf;
      p.y = L.originY + fy * L.ppf;
      const s = p.matrixTransform(svg.getScreenCTM() as DOMMatrix);
      const dt = new DataTransfer();
      dt.setData("application/camptool-kind", kind);
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: s.x,
        clientY: s.y,
        dataTransfer: dt,
      };
      svg.dispatchEvent(new DragEvent("dragover", opts));
      svg.dispatchEvent(new DragEvent("drop", opts));
    },
    { kind, fx, fy, L },
  );
  await page.waitForTimeout(900);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
});
if (COOKIE) {
  const eq = COOKIE.indexOf("=");
  await ctx.addCookies([
    {
      name: COOKIE.slice(0, eq),
      value: COOKIE.slice(eq + 1),
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      secure: COOKIE.startsWith("__Secure-"),
      sameSite: "Lax",
    },
  ]);
}
const page = await ctx.newPage();
const errors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

const NAME = `Tri shade ${Date.now() % 100000}`;

stage("open Camp structures and start a new one");
await page.goto(`${BASE}/map/structures`, { waitUntil: "networkidle" });
check(
  "page renders",
  await page.getByRole("heading", { name: "Camp structures" }).isVisible(),
);
await page.getByRole("button", { name: "New structure" }).click();
const modal = page.getByRole("dialog");
await modal.waitFor({ state: "attached" });
await modal.getByLabel("Name").fill(NAME);
await modal.getByText("Custom outline", { exact: true }).click();
const corners = modal.locator("svg circle");
await corners.first().waitFor();
check("custom outline starts as a triangle", (await corners.count()) === 3);

stage("draw: L preset, drag a corner, add one, remove it");
await modal.getByRole("button", { name: "L-shape" }).click();
check("L preset has 6 corners", (await corners.count()) === 6);
const svg = modal.locator("svg[aria-label^='Preview']");
const box = await svg.boundingBox();
if (!box) throw new Error("no preview svg");
// Drag the L's inner corner (index 2) toward the box centre.
const c2 = await corners.nth(2).boundingBox();
if (c2) {
  await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.6, {
    steps: 6,
  });
  await page.mouse.up();
}
const before = await corners.nth(2).getAttribute("cx");
check(
  "dragging moved the corner",
  before !== null && before !== "5",
  `cx=${before}`,
);
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.97);
check("clicking an edge adds a corner", (await corners.count()) === 7);
await modal.getByRole("button", { name: "Remove corner" }).click();
check("Remove corner takes it away", (await corners.count()) === 6);
// Make it a triangle shade cloth instead: the triangle preset + shade.
await modal.getByRole("button", { name: "triangle" }).click();
await modal.getByLabel("Width (ft)").fill("24");
await modal.getByLabel("Depth (ft)").fill("20");
await modal.getByLabel("Shade cloth: blocks sun, not wind or radio").check();
await page.screenshot({ path: `${OUT}/cs-1-editor.png` });

stage("create it");
await modal.getByRole("button", { name: "Create" }).click();
await modal.waitFor({ state: "detached", timeout: 10000 });
check("the new structure is listed", await page.getByText(NAME).isVisible());
await page.screenshot({ path: `${OUT}/cs-2-list.png` });

stage("phone width");
{
  // A fresh page at phone size: Mantine's AppShell only sizes itself on the
  // first render, so resizing an open page isn't what a phone sees.
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${BASE}/map/structures`, { waitUntil: "networkidle" });
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  check("no sideways scroll at phone width", !overflow);
  await phone.screenshot({ path: `${OUT}/cs-3-phone.png`, fullPage: true });
  await phone.close();
}

stage("it's in the map legend and draws as its outline");
const value = await page.evaluate(async (name) => {
  const r = await fetch("/map/structures.data");
  const t = await r.text();
  // The turbo-stream payload lists value strings beside labels; find ours.
  const i = t.indexOf(name);
  const m = t.slice(Math.max(0, i - 400), i + 400).match(/x-[0-9a-f]{12}/g);
  return m?.[m.length - 1] ?? null;
}, NAME);
check("found the new kind's value", Boolean(value), String(value));
await page.goto(`${BASE}/map`, { waitUntil: "networkidle" });
await page.waitForSelector("#camp-map-svg", { timeout: 20000 });
check(
  "legend links to Camp structures",
  await page.getByRole("link", { name: /Camp structures/ }).isVisible(),
);
const polysBefore = await page.locator("#camp-map-svg polygon").count();
if (value) await dropKind(page, value, 60, 120);
const polysAfter = await page.locator("#camp-map-svg polygon").count();
check(
  "dropping it adds an outline to the map",
  polysAfter > polysBefore,
  `${polysBefore} → ${polysAfter}`,
);
const dashed = await page
  .locator("#camp-map-svg polygon[stroke-dasharray='6 4']")
  .count();
check("shade cloth draws dashed, as its outline", dashed > 0);
await page.screenshot({ path: `${OUT}/cs-4-map.png` });

// The legend's float-precision hydration warning is known and not ours
// (plans/issues.md → "Map legend hydration mismatch").
const real = errors.filter((e) => !e.includes("A tree hydrated but some"));
check("no console errors", real.length === 0, real.slice(0, 3).join(" | "));
await browser.close();
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
