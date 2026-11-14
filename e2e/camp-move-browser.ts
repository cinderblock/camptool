/**
 * The passkey half of moving a camp (e2e/camp-move.ts), in a real headless
 * Chrome with a virtual authenticator holding the member's OLD passkey: use it
 * on the old host's "we've moved" page, get handed over to the camp's new
 * address, be made to create a new passkey there, then sign in with the new
 * one on the apex.
 *
 * Needs real-looking names: Chrome won't take `localhost` as the RP ID for a
 * `*.localhost` page. Run after `bun e2e/camp-move.ts new` (which leaves the
 * old passkey's key in data/move/state.json), against a server started with
 * `--var PUBLIC_BASE_URL:http://camptool.test:17970` (else as in
 * camp-move.ts), and with Node, not Bun (Playwright hangs under Bun):
 *
 *   node --experimental-strip-types e2e/camp-move-browser.ts
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 17970;
const APEX = `http://camptool.test:${PORT}`;
const OLD = `http://oldcamp.test:${PORT}`;
const CAMP = `http://mathcamp.camptool.test:${PORT}`;
const s = JSON.parse(readFileSync("data/move/state.json", "utf8"));
let ok = 0;
let bad = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) ok++;
  else bad++;
  console.log(
    `${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
};

// The insecure-origin flag only takes effect with a profile directory.
const ctx = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "camp-move-")),
  {
    headless: true,
    // Full Chromium in its new headless mode; the headless shell ignores the
    // insecure-origin flag.
    channel: "chromium",
    args: [
      "--host-resolver-rules=MAP *.test 127.0.0.1",
      // WebAuthn needs a secure context; these stand in for https.
      `--unsafely-treat-insecure-origin-as-secure=${APEX},${OLD},${CAMP}`,
    ],
  },
);
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
page.on("console", (m) => {
  if (m.type() === "error") console.log("  console:", m.text());
});
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
});
// The member's old passkey, as their phone would hold it.
await cdp.send("WebAuthn.addCredential", {
  authenticatorId,
  credential: {
    credentialId: Buffer.from(s.credId, "base64url").toString("base64"),
    isResidentCredential: true,
    rpId: "oldcamp.test",
    privateKey: (s.privateKey as string)
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, ""),
    userHandle: Buffer.from(s.pkUser).toString("base64"),
    signCount: 2 ** 31 - 1000,
  },
});

await page.goto(`${OLD}/moved`);
await page.click("button:has-text('Sign in with my old passkey')");
await page
  .waitForURL((u) => u.pathname.startsWith("/new-passkey"), { timeout: 20000 })
  .catch(() => {});
check(
  "old passkey on the old host → signed in at the new address, made to add a passkey",
  page.url().startsWith(`${CAMP}/new-passkey`),
  `${page.url()} ${(await page.locator("[role=alert]").allInnerTexts()).join(" ")}`,
);

await page.click("button:has-text('Make a passkey')");
await page
  .waitForURL((u) => !u.pathname.startsWith("/new-passkey"), {
    timeout: 20000,
  })
  .catch(() => {});
const { credentials } = await cdp.send("WebAuthn.getCredentials", {
  authenticatorId,
});
check(
  "a new passkey for the new address, then on into the camp",
  page.url().startsWith(`${CAMP}/`) &&
    !page.url().includes("new-passkey") &&
    credentials.some((c) => c.rpId === "camptool.test"),
  `${page.url()}; RP IDs ${credentials.map((c) => c.rpId).join(", ")}`,
);

// Signed out, the new passkey alone gets them back in.
await ctx.clearCookies();
await page.goto(`${APEX}/login`);
await page.click("button:has-text('Sign in with a passkey')");
await page
  .waitForURL((u) => u.host !== new URL(APEX).host, { timeout: 20000 })
  .catch(() => {});
check(
  "signed out, the new passkey signs in, and lands in the camp",
  page.url() === `${CAMP}/`,
  page.url(),
);

await ctx.close();
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
