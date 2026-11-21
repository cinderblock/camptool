/**
 * Sign in here with a passkey made at a camp's old site
 * (plans/camp-portability.md, "Logins after a move"). The old site lists this
 * one in its `/.well-known/webauthn`, so the browser lets this page use the
 * old site's passkeys; the key itself came with the camp (`legacy_passkey`).
 *
 *   { step: "options", rpId }              → { id, options }
 *   { step: "verify", id, response, next } → { url } and a session, or 401
 */
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { data } from "react-router";
import { safeNext } from "~/lib/camp-host";
import {
  arrivedWithMove,
  movedFrom,
} from "~/lib/camp-move/move-in-auth.server";
import { APEX } from "~/lib/env.server";
import {
  legacyPasskeyOptions,
  sessionCookieFor,
  verifyLegacyPasskey,
} from "~/lib/legacy-host.server";
import type { Route } from "./+types/api.move-passkey";

export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => ({}))) as {
    step?: string;
    rpId?: string;
    id?: string;
    response?: AuthenticationResponseJSON;
    next?: string;
  };
  if (body.step === "options") {
    const known = (await movedFrom()).some((m) => m.rpId === body.rpId);
    if (!known || !body.rpId)
      throw data({ error: "Unknown site" }, { status: 404 });
    return legacyPasskeyOptions(body.rpId);
  }
  if (body.step === "verify" && body.id && body.response) {
    // Signing in happens on the apex.
    const origin = request.headers.get("origin") ?? "";
    if (origin !== APEX.origin) {
      throw data({ error: "Wrong origin" }, { status: 403 });
    }
    const userId = await verifyLegacyPasskey(body.id, body.response, origin);
    if (!userId || !(await arrivedWithMove(userId))) {
      return data(
        { error: "That passkey wasn't recognised. Try again." },
        { status: 401 },
      );
    }
    const next = safeNext(body.next ?? null, APEX) ?? "/";
    return data(
      { url: next },
      { headers: { "Set-Cookie": await sessionCookieFor(userId) } },
    );
  }
  throw data({ error: "Bad request" }, { status: 400 });
}
