/**
 * Resource route: begin a passkey-first signup.
 *
 * POST { name, email, inviteToken? } -> { context } | { error }
 *
 * The returned `context` is an opaque handle the client hands to
 * `authClient.passkey.addPasskey({ context })`; the passkey plugin's
 * resolveUser/afterVerification pick it back up server-side. See
 * `app/lib/passkey-signup.server.ts` and `plans/passkey-first-auth.md`.
 */
import { data } from "react-router";
import { startPasskeySignup } from "~/lib/passkey-signup.server";
import type { Route } from "./+types/api.passkey-signup";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return data({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { name, email, inviteToken } = body as Record<string, unknown>;
  if (typeof name !== "string" || typeof email !== "string") {
    return data({ error: "name and email are required." }, { status: 400 });
  }

  const result = await startPasskeySignup({
    name,
    email,
    inviteToken: typeof inviteToken === "string" ? inviteToken : undefined,
  });

  if (!result.ok) return data({ error: result.reason }, { status: 400 });
  return data({ context: result.context });
}
