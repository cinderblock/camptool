/**
 * Client-side passkey-first signup ceremony shared by `AuthInline` (invites,
 * applications, camp setup links) and `/login`.
 *
 * Two steps, ONE WebAuthn prompt (`createSession: true` in
 * `@better-auth/passkey` 1.7.x):
 *   1. `POST /api/passkey-signup` validates name + email and returns an opaque
 *      handle (creating no user row yet, so an abandoned prompt leaves no
 *      orphan account squatting the email).
 *   2. `authClient.passkey.addPasskey({ context, name, createSession: true })`
 *      runs the single WebAuthn registration ceremony; the server materializes
 *      the user row, saves the passkey, and sets the session cookie in one
 *      round trip — avoiding a second biometric prompt (which can expire the
 *      iOS Safari user-gesture window or show a shared-device account picker).
 */
import { authClient } from "./auth-client";
import { defaultDeviceName } from "./device-name";

export type PasskeySignUpResult = { ok: true } | { ok: false; error: string };

export async function signUpWithPasskey(input: {
  name: string;
  email: string;
}): Promise<PasskeySignUpResult> {
  if (
    typeof window === "undefined" ||
    typeof window.PublicKeyCredential === "undefined"
  ) {
    return {
      ok: false,
      error:
        "This browser doesn't support passkeys. Open this link in Safari, Chrome, or another modern browser.",
    };
  }

  try {
    const startRes = await fetch("/api/passkey-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        email: input.email,
      }),
    });
    const startBody = (await startRes.json().catch(() => ({}))) as {
      context?: string;
      error?: string;
    };
    if (!startRes.ok || !startBody.context) {
      return {
        ok: false,
        error: startBody.error ?? "Couldn't start passkey signup. Try again.",
      };
    }

    const reg = await authClient.passkey.addPasskey({
      context: startBody.context,
      name: defaultDeviceName(),
      createSession: true,
    });
    if (reg?.error) {
      const code = "code" in reg.error ? reg.error.code : undefined;
      if (code === "AUTH_CANCELLED") {
        return {
          ok: false,
          error:
            "Passkey setup was cancelled. Nothing was created — you can try again whenever you're ready.",
        };
      }
      return {
        ok: false,
        error:
          reg.error.message ??
          "Passkey setup didn't finish. Make sure you're in Safari, Chrome, or another modern browser and try again.",
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Something went wrong setting up your passkey. Try again.",
    };
  }
}
