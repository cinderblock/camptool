/**
 * Render the app icons in public/ from public/icon.svg (plans/pwa.md).
 * Run after changing the SVG, under node (Playwright hangs under bun):
 *   node --experimental-strip-types scripts/render-icons.ts
 *
 * - icon-192.png / icon-512.png: the rounded icon, transparent corners.
 * - icon-maskable-512.png: full-bleed square, mark shrunk into the safe zone
 *   (Android crops it to its own shape).
 * - apple-touch-icon.png (180): full-bleed square; iOS rounds it itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const svg = readFileSync("public/icon.svg", "utf8");
// The same drawing on a square background, with the mark scaled about the
// centre: `scale` 1 for iOS, smaller for Android's maskable safe zone.
const square = (scale: number) =>
  svg
    .replace(
      /<rect [^>]*\/>/,
      '<rect width="512" height="512" fill="#1971c2"/>',
    )
    .replace(
      /(<rect [^>]*\/>)([\s\S]*)<\/svg>/,
      `$1<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">$2</g></svg>`,
    );

const outputs: Array<[string, string, number]> = [
  ["public/icon-192.png", svg, 192],
  ["public/icon-512.png", svg, 512],
  ["public/icon-maskable-512.png", square(0.72), 512],
  ["public/apple-touch-icon.png", square(0.86), 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, source, size] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  const sized = source.replace(
    "<svg ",
    `<svg width="${size}" height="${size}" `,
  );
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${sized}</body></html>`,
  );
  writeFileSync(
    file,
    await page.screenshot({ omitBackground: true, type: "png" }),
  );
  console.log(file);
}
await browser.close();
