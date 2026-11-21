import { describe, expect, test } from "bun:test";
// better-call doesn't export it; the real signer, so the format is the one sessions use.
// @ts-expect-error: untyped internal module, imported for the real signer.
import { signCookieValue as sign } from "../node_modules/better-call/dist/crypto.mjs";

const signCookieValue = sign as (
  value: string,
  secret: string,
) => Promise<string>;

import {
  isAuthAttempt,
  type RateLimitEnv,
  rateLimitResponse,
  signedSessionToken,
} from "./rate-limit";

const SECRET = "test-secret-test-secret-test-secret";
const NAME = "__Secure-better-auth.session_token";

/** A limiter that allows `allow` calls per key, recording the keys it saw. */
function limiter(allow: number) {
  const seen: string[] = [];
  return {
    seen,
    async limit({ key }: { key: string }) {
      seen.push(key);
      return { success: seen.filter((k) => k === key).length <= allow };
    },
  };
}

function request(opts: { cookie?: string; ip?: string; method?: string }) {
  const headers = new Headers();
  if (opts.cookie) headers.set("Cookie", opts.cookie);
  if (opts.ip) headers.set("CF-Connecting-IP", opts.ip);
  return new Request("https://camptool.org/", {
    method: opts.method ?? "GET",
    headers,
  });
}

describe("signedSessionToken", () => {
  test("accepts the cookie better-auth writes", async () => {
    const cookie = `${NAME}=${await signCookieValue("tok123", SECRET)}`;
    expect(await signedSessionToken(`a=b; ${cookie}`, SECRET)).toBe("tok123");
  });

  test("refuses a forged or foreign cookie", async () => {
    const forged = `${NAME}=${await signCookieValue("tok123", "other-secret")}`;
    expect(await signedSessionToken(forged, SECRET)).toBeNull();
    expect(await signedSessionToken(`${NAME}=tok123.junk`, SECRET)).toBeNull();
    expect(await signedSessionToken(`${NAME}=%E0%A4%A`, SECRET)).toBeNull();
    expect(await signedSessionToken(null, SECRET)).toBeNull();
  });
});

describe("isAuthAttempt", () => {
  test("covers sign-in, sign-up and starting a camp, POSTs only", () => {
    expect(isAuthAttempt("POST", "/api/auth/sign-in/email")).toBe(true);
    expect(isAuthAttempt("POST", "/api/auth/sign-up/email")).toBe(true);
    expect(isAuthAttempt("POST", "/new-camp/abc")).toBe(true);
    expect(isAuthAttempt("GET", "/new-camp/abc")).toBe(false);
    expect(isAuthAttempt("POST", "/members")).toBe(false);
  });
});

describe("rateLimitResponse", () => {
  test("signed in is keyed by session, not the shared address", async () => {
    const anon = limiter(1);
    const signedIn = limiter(2);
    const env: RateLimitEnv = {
      RATE_LIMIT_ANON: anon,
      RATE_LIMIT_SIGNED_IN: signedIn,
      BETTER_AUTH_SECRET: SECRET,
    };
    const a = `${NAME}=${await signCookieValue("alice", SECRET)}`;
    const b = `${NAME}=${await signCookieValue("bob", SECRET)}`;
    for (const cookie of [a, a, b, b]) {
      expect(
        await rateLimitResponse(env, request({ cookie, ip: "1.2.3.4" }), "/"),
      ).toBeNull();
    }
    expect(
      (await rateLimitResponse(env, request({ cookie: a, ip: "1.2.3.4" }), "/"))
        ?.status,
    ).toBe(429);
    expect(anon.seen).toHaveLength(0);
  });

  test("a forged cookie gets the anonymous, per-address limit", async () => {
    const anon = limiter(1);
    const env: RateLimitEnv = {
      RATE_LIMIT_ANON: anon,
      RATE_LIMIT_SIGNED_IN: limiter(100),
      BETTER_AUTH_SECRET: SECRET,
    };
    const forged = `${NAME}=${await signCookieValue("x", "nope")}`;
    const r = () => request({ cookie: forged, ip: "5.6.7.8" });
    expect(await rateLimitResponse(env, r(), "/")).toBeNull();
    expect((await rateLimitResponse(env, r(), "/"))?.status).toBe(429);
    expect(anon.seen).toEqual(["ip:5.6.7.8", "ip:5.6.7.8"]);
  });

  test("sign-in attempts hit the tighter limit even when signed in", async () => {
    const env: RateLimitEnv = {
      RATE_LIMIT_AUTH: limiter(1),
      RATE_LIMIT_SIGNED_IN: limiter(100),
      BETTER_AUTH_SECRET: SECRET,
    };
    const cookie = `${NAME}=${await signCookieValue("alice", SECRET)}`;
    const r = () => request({ cookie, ip: "9.9.9.9", method: "POST" });
    const path = "/api/auth/sign-in/email";
    expect(await rateLimitResponse(env, r(), path)).toBeNull();
    expect((await rateLimitResponse(env, r(), path))?.status).toBe(429);
  });

  test("fails open without bindings or when a binding throws", async () => {
    expect(
      await rateLimitResponse({}, request({ ip: "1.1.1.1" }), "/"),
    ).toBeNull();
    const broken = {
      RATE_LIMIT_ANON: {
        limit: async () => {
          throw new Error("down");
        },
      },
    };
    expect(
      await rateLimitResponse(broken, request({ ip: "1.1.1.1" }), "/"),
    ).toBeNull();
  });
});
