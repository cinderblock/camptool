/**
 * Resource route on a camp's OLD address only: sign in once with a passkey
 * made for that address, to be handed over to the new one
 * (app/lib/legacy-host.server.ts). Two steps, JSON in and out:
 *
 *   { step: "options" }                 → { id, options }
 *   { step: "verify", id, response, next } → { url } (the hand-off) or 401
 */
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { data } from "react-router";
import { safeNext } from "~/lib/camp-host";
import { APEX } from "~/lib/env.server";
import { legacyHostOf } from "~/lib/legacy-host";
import {
  handoffUrl,
  LEGACY_HOSTS,
  legacyPasskeyOptions,
  movedNext,
  requestLegacyHost,
  verifyLegacyPasskey,
} from "~/lib/legacy-host.server";
import type { Route } from "./+types/api.legacy-passkey";

export async function action({ request }: Route.ActionArgs) {
  const host = requestLegacyHost(request);
  if (!host) throw data("Not found", { status: 404 });
  // The RP ID is the old host name, without any port.
  const rpID = host.replace(/:\d+$/, "");
  const body = (await request.json()) as {
    step?: string;
    id?: string;
    response?: AuthenticationResponseJSON;
    next?: string;
  };

  if (body.step === "options") return legacyPasskeyOptions(rpID);

  if (body.step === "verify" && body.id && body.response) {
    // WebAuthn checks the page's origin; it must be this old host.
    const origin = request.headers.get("origin") ?? "";
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (legacyHostOf(originHost, LEGACY_HOSTS) !== host) {
      throw data({ error: "Wrong origin" }, { status: 403 });
    }
    const userId = await verifyLegacyPasskey(body.id, body.response, origin);
    if (!userId) {
      return data(
        { error: "That passkey wasn't recognised. Try again." },
        { status: 401 },
      );
    }
    const next = safeNext(body.next ?? null, APEX)?.startsWith("http")
      ? (body.next as string)
      : movedNext(request);
    return { url: await handoffUrl(userId, next) };
  }

  throw data({ error: "Bad request" }, { status: 400 });
}
