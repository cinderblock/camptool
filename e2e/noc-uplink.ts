/**
 * The NOC uplink radio: the faint bearing vector to Burning Man's NOC tower, the
 * "Uplink radio" structure kind, its aim cone, and the line-of-sight check that
 * flags what blocks it.
 *
 * Drives the real map editor: drops a radio out of the legend palette onto the
 * SVG (a genuine HTML5 drag with the app's own `application/camptool-kind`
 * payload), then reads back what the map draws.
 *
 * Run under NODE, not bun (Playwright hangs under bun — see
 * plans/passkey-first-auth.md). Point it at a dev server and a session cookie:
 *   E2E_BASE_URL=http://localhost:17923 E2E_COOKIE='<name>=<value>' \
 *     node --experimental-strip-types e2e/noc-uplink.ts
 */
import { type Page, chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17923";
const COOKIE = process.env.E2E_COOKIE ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

/** Text of every <text> node inside the map SVG — what the map actually says. */
async function mapLabels(page: Page): Promise<string[]> {
  return page.$$eval("#camp-map-svg text", (ns) =>
    ns.map((n) => (n.textContent ?? "").trim()).filter(Boolean),
  );
}

/**
 * The lot's plot-feet → view-units transform, recomputed exactly as
 * `layoutFor` does it (VIEW_W 920, MARGIN 28, PAD_FT 50) so the test can aim a
 * drop at a real plot-local coordinate instead of guessing at pixels.
 */
function layout(frontageFt: number, depthFt: number, rearFt: number) {
  const maxW = Math.max(frontageFt, rearFt);
  const ppf = (920 - 2 * 28) / (maxW + 100);
  return {
    ppf,
    originX: 28 + 50 * ppf + ((maxW - frontageFt) / 2) * ppf,
    originY: 28 + 50 * ppf,
  };
}

/** Drop a legend kind onto the map at a plot-local point, the way a user does:
 * a real dragover→drop carrying the app's own dataTransfer type. */
async function dropKind(
  page: Page,
  kind: string,
  fx: number,
  fy: number,
  L: ReturnType<typeof layout>,
) {
  await page.evaluate(
    ({ kind, fx, fy, L }) => {
      const svg = document.querySelector("#camp-map-svg") as SVGSVGElement;
      // The SVG letterboxes (preserveAspectRatio "meet"), so a plain viewBox
      // ratio lands in the wrong place — ask the element for its real matrix.
      const p = svg.createSVGPoint();
      p.x = L.originX + fx * L.ppf;
      p.y = L.originY + fy * L.ppf;
      const s = p.matrixTransform(svg.getScreenCTM() as DOMMatrix);
      const cx = s.x;
      const cy = s.y;
      const dt = new DataTransfer();
      dt.setData("application/camptool-kind", kind);
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        dataTransfer: dt,
      };
      svg.dispatchEvent(new DragEvent("dragover", opts));
      svg.dispatchEvent(new DragEvent("drop", opts));
    },
    { kind, fx, fy, L },
  );
  await page.waitForTimeout(700);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1100 },
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
      // The dev server's cookie is `__Secure-`-prefixed (its PUBLIC_BASE_URL is
      // https); Chrome allows that on http://localhost, which counts as secure.
      secure: true,
      sameSite: "Lax",
    },
  ]);
}
const page = await ctx.newPage();
const errors: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

stage("open the map");
await page.goto(`${BASE}/map`, { waitUntil: "networkidle" });
await page.waitForSelector("#camp-map-svg", { timeout: 20000 });

// Math Camp @ Group W: 100′ × 200′ on E street, 3:14, Man-facing → rear 104.9′.
const L = layout(100, 200, (100 * (4060 + 200)) / 4060);

stage("the faint camp-level NOC vector");
let labels = await mapLabels(page);
const nocLabel = labels.find((t) => t.startsWith("NOC "));
check("map draws a NOC bearing label", Boolean(nocLabel), labels.join(" | "));
console.log(`        → "${nocLabel}"`);
check(
  "compass dial carries a NOC ray",
  await page.locator("svg text", { hasText: /^NOC$/ }).first().isVisible(),
);

stage("the Uplink radio kind is in the legend");
const chip = page.locator("text=Uplink radio").first();
check("legend offers 'Uplink radio'", await chip.isVisible());
await page.screenshot({ path: "data/verify/noc-1-vector.png" });

stage("drop a radio directly down-beam of the 9.5′ container");
// The container's centre is ~(84.5, 70.5). The NOC bears 291° while map-up is
// 322°, so on screen it lies up-and-left at (-0.513, -0.858) — meaning a radio
// placed DOWN-RIGHT of the container along that line has it squarely in the way.
await dropKind(page, "uplink", 84.5 + 0.513 * 25, 70.5 + 0.858 * 25, L);
labels = await mapLabels(page);
const tall = labels.find(
  (t) => t.startsWith("Clear ·") || t.startsWith("Blocked"),
);
check(
  "a 12′ mast out-tops the 9.5′ container in its path → still Clear",
  tall?.startsWith("Clear ·") === true,
  labels.join(" | "),
);
console.log(`        → "${tall}"`);
await page.screenshot({ path: "data/verify/noc-2-clear.png" });

stage("probe: drop the mast to 6′ — now the container should block it");
const height = page.getByLabel("Height (ft)");
if (!(await height.isVisible().catch(() => false))) {
  throw new Error("dropping a radio did not select it — no Height field");
}
await height.fill("6");
await height.press("Tab");
await page.waitForTimeout(800);
labels = await mapLabels(page);
const blocked = labels.find((t) => t.startsWith("Blocked by"));
check(
  "a 6′ mast behind the container reports it as a blocker",
  Boolean(blocked),
  labels.join(" | "),
);
console.log(`        → "${blocked}"`);
await page.screenshot({ path: "data/verify/noc-3-blocked.png" });

stage("probe: raise it back to 14′ — the block should clear again");
await height.fill("14");
await height.press("Tab");
await page.waitForTimeout(800);
labels = await mapLabels(page);
check(
  "raising the mast clears the block",
  !labels.some((t) => t.startsWith("Blocked by")),
  labels.join(" | "),
);

stage("probe: turn the overlay off");
await page.getByLabel("Uplink aim (NOC)").uncheck();
await page.waitForTimeout(400);
labels = await mapLabels(page);
check(
  "unchecking hides every uplink annotation",
  !labels.some(
    (t) =>
      t.startsWith("NOC ") ||
      t.startsWith("Clear ·") ||
      t.startsWith("Blocked by"),
  ),
  labels.join(" | "),
);
await page.screenshot({ path: "data/verify/noc-4-off.png" });
await page.getByLabel("Uplink aim (NOC)").check();
await page.waitForTimeout(400);

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 8)) console.log(`  ! ${e}`);
console.log(`\n${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
