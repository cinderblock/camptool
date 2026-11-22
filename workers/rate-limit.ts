/**
 * Per-visitor request limits on Cloudflare, through the Workers rate-limit
 * bindings in wrangler.jsonc (which also set the numbers). Cloudflare has no
 * spending cap, so this bounds what one client can make the Worker and D1 do.
 * The Bun build has no equivalent and doesn't need one: it runs on a box with
 * a fixed cost.
 *
 * Keyed by who's asking:
 * - Signed in (a session cookie with a valid signature): by session, so a
 *   whole camp behind one address (one Starlink on the playa) doesn't share a
 *   limit. The signature is checked here with the auth secret, never the
 *   database, so a made-up cookie costs nothing and gets the anonymous limit.
 * - Everyone else: by IP.
 * - Sign-in, sign-up and starting a camp (POSTs): a tighter per-IP limit on
 *   top, since those are what a password guesser or a spammer would hammer.
 *
 * Fails open: a missing binding, no client IP, or an error from the binding
 * lets the request through, since locking everyone out is worse.
 */

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnv {
  RATE_LIMIT_ANON?: RateLimit;
  RATE_LIMIT_SIGNED_IN?: RateLimit;
  RATE_LIMIT_AUTH?: RateLimit;
  BETTER_AUTH_SECRET?: unknown;
}

/** The session cookie better-auth sets in production (`__Secure-` because the
 * site is HTTPS). Local dev uses another prefix and has no bindings anyway. */
const SESSION_COOKIE = "__Secure-better-auth.session_token";

/** POSTs worth guessing at or spamming. */
export function isAuthAttempt(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return (
    pathname.startsWith("/api/auth/sign-in") ||
    pathname.startsWith("/api/auth/sign-up") ||
    pathname.startsWith("/api/auth/forget-password") ||
    pathname.startsWith("/api/auth/request-password-reset") ||
    pathname.startsWith("/api/auth/passkey/") ||
    pathname.startsWith("/api/passkey-signup") ||
    pathname.startsWith("/api/passkey-recovery") ||
    pathname.startsWith("/api/legacy-passkey") ||
    pathname.startsWith("/new-camp")
  );
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(secret, key);
  }
  return key;
}

/**
 * The session token from a correctly signed session cookie, or null. Same
 * format better-call writes: `encodeURIComponent(token + "." + base64(HMAC))`.
 * Doesn't say the session is still live, only that we issued it.
 */
export async function signedSessionToken(
  cookieHeader: string | null,
  secret: string,
): Promise<string | null> {
  const raw = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!raw) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith("=")) return null;
  try {
    const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      bytes,
      new TextEncoder().encode(token),
    );
    return ok ? token : null;
  } catch {
    return null;
  }
}

async function allowed(limiter: RateLimit | undefined, key: string) {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (err) {
    console.error(
      "Rate limiter failed:",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

/** A 429 for a client over its limit, or null to carry on. */
export async function rateLimitResponse(
  env: RateLimitEnv,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP");

  if (ip && isAuthAttempt(request.method, pathname)) {
    if (!(await allowed(env.RATE_LIMIT_AUTH, `auth:${ip}`))) return tooMany();
  }

  const secret =
    typeof env.BETTER_AUTH_SECRET === "string" ? env.BETTER_AUTH_SECRET : "";
  const session = secret
    ? await signedSessionToken(request.headers.get("Cookie"), secret)
    : null;
  if (session) {
    return (await allowed(env.RATE_LIMIT_SIGNED_IN, `s:${session}`))
      ? null
      : tooMany();
  }
  if (!ip) return null;
  return (await allowed(env.RATE_LIMIT_ANON, `ip:${ip}`)) ? null : tooMany();
}

function tooMany(): Response {
  return new Response("Too many requests. Try again in a minute.", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "60",
    },
  });
}
