import { describe, expect, test } from "bun:test";
import {
  MAX_RESET_ATTEMPTS,
  RESET_TTL_MS,
  maskEmail,
  resetLinkState,
} from "./password-reset";

const NOW = Date.parse("2026-08-12T12:00:00Z");

/** A freshly issued link: nothing used, nothing revoked, no bad guesses. */
function link(over: Partial<Parameters<typeof resetLinkState>[0]> = {}) {
  return {
    usedAt: null,
    revokedAt: null,
    expiresAt: new Date(NOW + RESET_TTL_MS),
    attempts: 0,
    ...over,
  };
}

describe("resetLinkState", () => {
  test("a fresh link is valid", () => {
    expect(resetLinkState(link(), NOW)).toBe("valid");
  });

  test("valid right up to the expiry instant, expired at it", () => {
    const l = link({ expiresAt: new Date(NOW) });
    expect(resetLinkState(l, NOW - 1)).toBe("valid");
    // Boundary is inclusive-dead: <= now counts as expired.
    expect(resetLinkState(l, NOW)).toBe("expired");
  });

  test("the 7-day TTL is what's actually applied", () => {
    const l = link();
    expect(resetLinkState(l, NOW + RESET_TTL_MS - 1000)).toBe("valid");
    expect(resetLinkState(l, NOW + RESET_TTL_MS)).toBe("expired");
  });

  test("used beats expired — the reset already happened, say so", () => {
    // Someone who used their link and comes back a fortnight later should be
    // told it was used, not sent to ask for a replacement.
    const l = link({
      usedAt: new Date(NOW),
      expiresAt: new Date(NOW - 1),
    });
    expect(resetLinkState(l, NOW)).toBe("used");
  });

  test("revoked when a newer link superseded it", () => {
    expect(resetLinkState(link({ revokedAt: new Date(NOW) }), NOW)).toBe(
      "revoked",
    );
  });

  test("locks only once the attempt cap is reached", () => {
    expect(
      resetLinkState(link({ attempts: MAX_RESET_ATTEMPTS - 1 }), NOW),
    ).toBe("valid");
    expect(resetLinkState(link({ attempts: MAX_RESET_ATTEMPTS }), NOW)).toBe(
      "locked",
    );
  });

  test("a used link stays used even after being locked out or revoked", () => {
    const l = link({
      usedAt: new Date(NOW),
      revokedAt: new Date(NOW),
      attempts: 99,
    });
    expect(resetLinkState(l, NOW)).toBe("used");
  });
});

describe("maskEmail", () => {
  test("keeps two of the local part and one of the host", () => {
    expect(maskEmail("cinderblock63@gmail.com")).toBe(
      "ci•••••••••••@g••••.com",
    );
  });

  test("never reveals the whole local part, however short", () => {
    // One-character local: still gets a bullet, so length isn't given away.
    expect(maskEmail("a@b.co")).toBe("a•@b•.co");
    expect(maskEmail("ab@cd.io")).toBe("ab•@c•.io");
  });

  test("keeps the TLD so it's recognisable", () => {
    expect(maskEmail("someone@mathcamp.us").endsWith(".us")).toBe(true);
    expect(maskEmail("x@y.co.uk").endsWith(".uk")).toBe(true);
  });

  test("subdomains stay masked, not split", () => {
    expect(maskEmail("me@mail.example.com")).toBe("me•@m•••••••••••.com");
  });

  test("garbage in doesn't throw or leak", () => {
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail("@nolocal.com")).toBe("•••");
    expect(maskEmail("")).toBe("•••");
  });

  test("a masked address never contains the full original", () => {
    for (const e of [
      "cinderblock63@gmail.com",
      "a@b.co",
      "officer@mathcamp.us",
    ]) {
      expect(maskEmail(e)).not.toBe(e);
      expect(maskEmail(e)).toContain("•");
    }
  });
});
