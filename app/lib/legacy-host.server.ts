/**
 * Moving a camp from its old address to the shared site, without making
 * anyone sign in again (plans/hosting-other-camps.md, "Moving a camp onto the
 * shared site"). See `legacy-host.ts` for the configuration.
 *
 * The old host's DNS points at this same deployment, which holds the camp's
 * imported data, sessions included. So a browser that still carries the old
 * site's session cookie is recognised right here, and is handed to the new
 * address with a one-time code (a cookie can't be set across domains).
 *
 * Passkeys can't move: a credential belongs to its RP ID, and the old one is
 * the old host. Someone who signed in only with a passkey uses it once more,
 * on the old host's `/moved` page, which checks it against `legacy_passkey`
 * and hands them over the same way; the new site then has them make a new one.
 *
 * Server-only.
 */
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { and, eq, like, lt } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "../../db/client.server";
import { legacyPasskey, verification } from "../../db/schema";
import { auth } from "./auth.server";
import { campOrigin, pageUrl, safeNext } from "./camp-host";
import { APEX } from "./env.server";
import {
  LEGACY_HOST_PATHS,
  legacyHostOf,
  movedTarget,
  parseLegacyHosts,
} from "./legacy-host";

/** host → camp slug, from `LEGACY_HOSTS`. */
export const LEGACY_HOSTS = parseLegacyHosts(process.env.LEGACY_HOSTS);

/** The old host this request came in on, or null. */
export function requestLegacyHost(request: Request): string | null {
  return legacyHostOf(new URL(request.url).host, LEGACY_HOSTS);
}

// --- One-time hand-off codes (old host → new address) ---

const HANDOFF = "handoff:";
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const CHALLENGE = "legacy-passkey:";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function sweep(prefix: string) {
  await db
    .delete(verification)
    .where(
      and(
        like(verification.identifier, `${prefix}%`),
        lt(verification.expiresAt, new Date()),
      ),
    );
}

/** A code the apex's `/handoff` turns into a session for `userId`. */
async function createHandoff(userId: string): Promise<string> {
  await sweep(HANDOFF);
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
    "base64url",
  );
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: HANDOFF + code,
    value: userId,
    expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
  });
  return code;
}

/** Spend a hand-off code: the user id it was for, or null. Single use. */
export async function consumeHandoff(code: string): Promise<string | null> {
  if (!code) return null;
  const [row] = await db
    .delete(verification)
    .where(eq(verification.identifier, HANDOFF + code))
    .returning({
      value: verification.value,
      expiresAt: verification.expiresAt,
    });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row.value;
}

/** The apex URL that signs `userId` in and lands them on `next`. */
export async function handoffUrl(userId: string, next: string) {
  const code = await createHandoff(userId);
  return `${APEX.origin}/handoff?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`;
}

/**
 * A new better-auth session for `userId`, as the Set-Cookie header that
 * carries it: the same cookie better-auth's own sign-in sets (name, signed
 * value, domain, lifetime).
 */
export async function sessionCookieFor(userId: string): Promise<string> {
  const ctx = await auth.$context;
  const s = await ctx.internalAdapter.createSession(userId);
  if (!s) throw new Error("Couldn't create a session");
  const { name, attributes: a } = ctx.authCookies.sessionToken;
  // better-call's signed-cookie format: `<value>.<base64 HMAC-SHA256>`, URI
  // encoded.
  const sig = createHmac("sha256", ctx.secret).update(s.token).digest("base64");
  const parts = [
    `${name}=${encodeURIComponent(`${s.token}.${sig}`)}`,
    `Path=${a.path ?? "/"}`,
    `Max-Age=${ctx.sessionConfig.expiresIn}`,
    "HttpOnly",
    `SameSite=${a.sameSite === "strict" ? "Strict" : a.sameSite === "none" ? "None" : "Lax"}`,
  ];
  if (a.domain) parts.push(`Domain=${a.domain}`);
  if (a.secure) parts.push("Secure");
  return parts.join("; ");
}

// --- The old host itself ---

/**
 * Answer a request to an old host: send it to the page's new address, signed
 * in when the old session cookie is still good. Only `/moved` (the passkey
 * bridge) and its API stay on the old host. Null for every other host.
 */
export async function legacyHostResponse(
  request: Request,
): Promise<Response | null> {
  const host = requestLegacyHost(request);
  if (!host) return null;
  const url = pageUrl(request.url);
  if (LEGACY_HOST_PATHS.has(url.pathname)) return null;
  // biome-ignore lint/style/noNonNullAssertion: requestLegacyHost found it.
  const slug = LEGACY_HOSTS.get(host)!;
  const target = movedTarget(url, campOrigin(slug, APEX), APEX.origin);
  // Only a page load can carry the sign-in across; anything else (a form
  // post, a data request) just moves.
  if (request.method === "GET") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (session) return redirect(await handoffUrl(session.user.id, target));
  }
  return redirect(target, request.method === "GET" ? 302 : 308);
}

/** Where `/moved` sends someone once it knows who they are. */
export function movedNext(request: Request): string {
  const host = requestLegacyHost(request);
  const slug = host ? LEGACY_HOSTS.get(host) : null;
  const fallback = slug ? `${campOrigin(slug, APEX)}/` : `${APEX.origin}/`;
  const next = new URL(request.url).searchParams.get("next");
  return safeNext(next, APEX)?.startsWith("http") ? (next as string) : fallback;
}

// --- Old passkeys, checked on the old host ---

/** Start a sign-in with an old passkey: WebAuthn options plus the id the
 * answer must come back with. */
export async function legacyPasskeyOptions(rpID: string) {
  await sweep(CHALLENGE);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
  });
  const id = crypto.randomUUID();
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: CHALLENGE + id,
    value: JSON.stringify({ challenge: options.challenge, rpID }),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return { id, options };
}

/**
 * Check the browser's answer against the old passkeys. The user id it proves,
 * or null. The challenge is spent either way.
 */
export async function verifyLegacyPasskey(
  id: string,
  response: AuthenticationResponseJSON,
  origin: string,
): Promise<string | null> {
  const [row] = await db
    .delete(verification)
    .where(eq(verification.identifier, CHALLENGE + id))
    .returning({
      value: verification.value,
      expiresAt: verification.expiresAt,
    });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  const { challenge, rpID } = JSON.parse(row.value) as {
    challenge: string;
    rpID: string;
  };
  const [key] = await db
    .select()
    .from(legacyPasskey)
    .where(
      and(
        eq(legacyPasskey.credentialID, response.id),
        eq(legacyPasskey.rpId, rpID),
      ),
    )
    .limit(1);
  if (!key) return null;
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse(
      {
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: key.credentialID,
          publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64")),
          counter: key.counter,
          transports: key.transports?.split(",") as never,
        },
        requireUserVerification: false,
      },
    );
    if (!verified) return null;
    await db
      .update(legacyPasskey)
      .set({ counter: authenticationInfo.newCounter })
      .where(eq(legacyPasskey.id, key.id));
    return key.userId;
  } catch {
    return null;
  }
}
