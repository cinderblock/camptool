/**
 * Begin a passkey enrolment from an officer-issued recovery link.
 *
 * Public and unauthenticated by necessity — the person holding this link cannot
 * sign in, which is the entire reason it exists. Authority comes from the link
 * plus knowing the email it was issued for, checked server-side here; the
 * returned handle is what `addPasskey({ context })` carries back through the
 * passkey plugin's `resolveUser`.
 *
 * Returns only an opaque handle. The link is NOT spent until the credential is
 * cryptographically verified, so an abandoned browser prompt leaves the link
 * usable and the account untouched.
 */
import { data } from "react-router";
import { startPasskeyRecoveryFor } from "~/lib/password-reset.server";
import type { Route } from "./+types/api.passkey-recovery";

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed." }, { status: 405 });
  }
  const body = await request.formData();
  const token = String(body.get("token") ?? "");
  const email = String(body.get("email") ?? "");

  const result = await startPasskeyRecoveryFor(token, email);
  if (!result.ok) return data({ error: result.error }, { status: 400 });
  return data({ context: result.context });
}
