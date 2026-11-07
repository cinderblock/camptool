/**
 * Aerial photo under the camp map (plans/map-aerial-photo.md): upload, the
 * seeded rotation, a two-point alignment, and the per-viewer show/hide.
 *
 * Run under NODE, not bun (Playwright hangs under bun). Needs an officer
 * session on a camp whose lot has a clock address and NO aerial photo yet
 * (the checks read the first one), and a picture to upload:
 *   E2E_BASE_URL=http://localhost:17923 E2E_COOKIE='<name>=<value>' \
 *   E2E_AERIAL=path/to/photo.png E2E_EXPECT_ROTATION=83 \
 *     node --experimental-strip-types e2e/map-aerial.ts
 */
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:17923";
const COOKIE = process.env.E2E_COOKIE ?? "";
const PHOTO = process.env.E2E_AERIAL ?? "";
const EXPECT_ROT = Number(process.env.E2E_EXPECT_ROTATION ?? "NaN");
const SHOT = process.env.E2E_SHOT ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const stage = (m: string) => console.log(`[stage] ${m}`);

type Placement = {
  tx: number;
  ty: number;
  rot: number;
  scale: number;
  w: number;
  h: number;
};

/** The photo group's transform, parsed back out of the SVG. */
async function placement(page: Page): Promise<Placement | null> {
  return page.evaluate(() => {
    const g = document.querySelector(
      "#camp-map-svg [data-map-aerial] g[transform]",
    );
    const img = g?.querySelector("image");
    if (!g || !img) return null;
    const t = g.getAttribute("transform") ?? "";
    const m = t.match(
      /translate\(([-\d.e]+) ([-\d.e]+)\) rotate\(([-\d.e]+)\) scale\(([-\d.e]+)\)/,
    );
    if (!m) return null;
    return {
      tx: Number(m[1]),
      ty: Number(m[2]),
      rot: Number(m[3]),
      scale: Number(m[4]),
      w: Number(img.getAttribute("width")),
      h: Number(img.getAttribute("height")),
    };
  });
}

/** Map-SVG view units → screen px. */
async function toScreen(page: Page, x: number, y: number) {
  return page.evaluate(
    ({ x, y }) => {
      const svg = document.querySelector("#camp-map-svg") as SVGSVGElement;
      const p = svg.createSVGPoint();
      p.x = x;
      p.y = y;
      const s = p.matrixTransform(svg.getScreenCTM() as DOMMatrix);
      return { x: s.x, y: s.y };
    },
    { x, y },
  );
}

/** Photo pixel → view units, through the photo's current placement. */
function photoToView(pl: Placement, u: number, v: number) {
  const r = (pl.rot * Math.PI) / 180;
  const a = (u - pl.w / 2) * pl.scale;
  const b = (v - pl.h / 2) * pl.scale;
  return {
    x: pl.tx + a * Math.cos(r) - b * Math.sin(r),
    y: pl.ty + a * Math.sin(r) + b * Math.cos(r),
  };
}

async function main() {
  if (!COOKIE || !PHOTO) throw new Error("Set E2E_COOKIE and E2E_AERIAL.");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  // `__Secure-` cookies are fine on http://localhost, which counts as secure.
  const eq = COOKIE.indexOf("=");
  await ctx.addCookies([
    {
      name: COOKIE.slice(0, eq),
      value: COOKIE.slice(eq + 1),
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
    },
  ]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  stage("open the map");
  await page.goto(`${BASE}/map`);
  await page.getByText("Aerial photo", { exact: true }).waitFor();

  stage("upload");
  const input = page.locator('input[type="file"][accept*="image/png"]');
  await input.setInputFiles(PHOTO);
  await page
    .locator("#camp-map-svg [data-map-aerial] image")
    .first()
    .waitFor({ state: "attached", timeout: 20000 });
  let pl = await placement(page);
  check("photo is drawn on the map", !!pl);
  if (!pl) throw new Error("no placement");
  if (Number.isFinite(EXPECT_ROT)) {
    check(
      `seeded rotation is ${EXPECT_ROT}°`,
      Math.abs(pl.rot - EXPECT_ROT) < 0.01,
      `got ${pl.rot}`,
    );
  }
  const href = await page
    .locator("#camp-map-svg [data-map-aerial] image")
    .first()
    .getAttribute("href");
  const served = await page.evaluate(
    async (h) => (await fetch(h ?? "")).status,
    href,
  );
  check("photo bytes are served", served === 200, `status ${served}`);

  stage("two-point alignment");
  // Two photo features and where they should land, in view units: land photo
  // point A 40 view-units right of where it is now, and B 30 below its spot.
  const A = { u: pl.w * 0.57, v: pl.h * 0.57 };
  const B = { u: pl.w * 0.23, v: pl.h * 0.47 };
  const a0 = photoToView(pl, A.u, A.v);
  const b0 = photoToView(pl, B.u, B.v);
  const aT = { x: a0.x + 40, y: a0.y };
  const bT = { x: b0.x, y: b0.y + 30 };
  await page.getByRole("button", { name: "Align by two points" }).click();
  check(
    "photo step draws the photo over the map too",
    (await page.locator("#camp-map-svg [data-map-aerial] image").count()) >= 2,
  );
  for (const p of [a0, aT, b0, bT]) {
    const s = await toScreen(page, p.x, p.y);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  pl = await placement(page);
  if (!pl) throw new Error("photo vanished after aligning");
  const a1 = photoToView(pl, A.u, A.v);
  const b1 = photoToView(pl, B.u, B.v);
  const err = Math.max(
    Math.hypot(a1.x - aT.x, a1.y - aT.y),
    Math.hypot(b1.x - bT.x, b1.y - bT.y),
  );
  // Clicks land on whole screen pixels, so allow a pixel or two of slop.
  check(
    "both picked features land where they were clicked",
    err < 2.5,
    `off by ${err.toFixed(2)}`,
  );

  stage("survives a reload");
  await page.reload();
  await page
    .locator("#camp-map-svg [data-map-aerial] image")
    .first()
    .waitFor({ state: "attached" });
  const pl2 = await placement(page);
  check(
    "saved placement matches",
    !!pl2 &&
      Math.abs(pl2.rot - pl.rot) < 0.01 &&
      Math.abs(pl2.tx - pl.tx) < 0.5,
    JSON.stringify({ before: pl, after: pl2 }),
  );

  stage("clip to the lot");
  await page.getByRole("button", { name: "Adjust" }).click();
  await page.getByRole("checkbox", { name: "Clip to the lot" }).check();
  await page.waitForTimeout(1200);
  await page.reload();
  await page
    .locator("#camp-map-svg [data-map-aerial] image")
    .first()
    .waitFor({ state: "attached" });
  check(
    "clipped to the lot outline after a reload",
    (await page
      .locator(
        '#camp-map-svg [data-map-aerial] > g[clip-path="url(#lot-clip)"]',
      )
      .count()) === 1,
  );

  stage("before/after swiper");
  await page.getByText("Left | right", { exact: true }).click();
  const swipe = page.locator("input.ct-swipe");
  await swipe.waitFor({ state: "attached" });
  const svgBox = await page.locator("#camp-map-svg").boundingBox();
  if (!svgBox) throw new Error("no map box");
  const setSwipe = (v: number) =>
    swipe.evaluate((el, v) => {
      (el as HTMLInputElement).value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, v);
  // Two thin strips either side of centre, well inside the photo.
  const strip = (dx: number) => ({
    x: svgBox.x + svgBox.width / 2 + dx - 20,
    y: svgBox.y + svgBox.height / 2 - 40,
    width: 40,
    height: 80,
  });
  const shots = async () => ({
    L: await page.screenshot({ clip: strip(-70) }),
    R: await page.screenshot({ clip: strip(70) }),
  });
  await setSwipe(1000);
  await page.waitForTimeout(200);
  const allPhoto = await shots();
  await setSwipe(0);
  await page.waitForTimeout(200);
  const allPlan = await shots();
  await setSwipe(500);
  await page.waitForTimeout(200);
  const half = await shots();
  check("swiper actually changes what's drawn", !allPhoto.L.equals(allPlan.L));
  check("left of the line is the photo", half.L.equals(allPhoto.L));
  check("right of the line is the plan", half.R.equals(allPlan.R));
  // A real drag on the divider (the thumb sits at the centre line).
  const cx = svgBox.x + svgBox.width / 2;
  const cy = svgBox.y + Math.min(svgBox.height, 700) / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy, { steps: 6 });
  await page.mouse.up();
  const after = Number(await swipe.inputValue());
  check("dragging the line moves it", after < 450, `value ${after}`);
  check(
    "the BM export would drop the swiper copy too",
    await page.evaluate(() => {
      const c = document
        .getElementById("camp-map-svg")
        ?.cloneNode(true) as Element;
      for (const el of Array.from(c.querySelectorAll("[data-map-aerial]")))
        el.remove();
      return c.querySelectorAll("image[href^='/media']").length === 0;
    }),
  );
  if (SHOT) await page.screenshot({ path: SHOT, fullPage: false });
  await page.getByText("Top / bottom", { exact: true }).click();
  await page.waitForTimeout(200);
  if (SHOT) await page.screenshot({ path: SHOT.replace(/\.png$/, "-y.png") });
  await page
    .locator(".mantine-Paper-root", { hasText: "Add aerial photo" })
    .getByText("Off", { exact: true })
    .click();

  stage("viewer can hide it");
  const box = page
    .locator(".mantine-Paper-root", { hasText: "Add aerial photo" })
    .getByRole("checkbox")
    .first();
  await box.uncheck();
  check(
    "hidden after unticking",
    (await page.locator("#camp-map-svg [data-map-aerial] image").count()) === 0,
  );
  await box.check();

  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
