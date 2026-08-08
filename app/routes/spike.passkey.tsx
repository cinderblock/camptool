/**
 * TEMPORARY spike page — proves passkey-first (password-less) signup works
 * end-to-end. Driven by `e2e/passkey-signup.ts` with a CDP virtual
 * authenticator.
 *
 * DEV-ONLY: the loader 404s in production. This page creates real accounts, so
 * it must never be reachable on a live deployment even though the invite-only
 * gate still applies to it.
 *
 * DELETE THIS FILE once step 5 of `plans/passkey-first-auth.md` folds the flow
 * into AuthInline / login. It is deliberately ugly and unstyled; it exists to
 * exercise the server wiring, not to be shipped.
 */
import { useState } from "react";
import { authClient, signIn, signOut } from "~/lib/auth-client";

export function loader() {
  if (process.env.NODE_ENV === "production") {
    throw new Response("Not found", { status: 404 });
  }
  return null;
}

export default function SpikePasskey() {
  const [name, setName] = useState("Spike Tester");
  const [email, setEmail] = useState("spike@example.com");
  const [log, setLog] = useState<string[]>([]);

  const say = (m: string) => setLog((l) => [...l, m]);

  async function handleSignUp() {
    setLog([]);
    try {
      say("1. requesting signup handle…");
      const res = await fetch("/api/passkey-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const body = await res.json();
      if (!res.ok) return say(`FAIL: ${body.error}`);
      say(`2. got context ${body.context}`);

      say("3. starting WebAuthn registration…");
      const reg = await authClient.passkey.addPasskey({
        context: body.context,
        name: "Spike device",
      });
      if (reg?.error) return say(`FAIL at register: ${reg.error.message}`);
      say("4. credential registered");

      say("5. signing in with the new passkey…");
      const si = await signIn.passkey();
      if (si?.error) return say(`FAIL at sign-in: ${si.error.message}`);
      say("6. signed in");

      const session = await authClient.getSession();
      say(`RESULT: ${JSON.stringify(session?.data?.user ?? null)}`);
      say("DONE-OK");
    } catch (e) {
      say(`THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSignIn() {
    setLog([]);
    const si = await signIn.passkey();
    if (si?.error) return say(`FAIL: ${si.error.message}`);
    const session = await authClient.getSession();
    say(`RESULT: ${JSON.stringify(session?.data?.user ?? null)}`);
    say("DONE-OK");
  }

  /** Sign out and REPORT the resulting session, so a test can prove the
   * session really went away rather than assuming it did. */
  async function handleSignOut() {
    setLog([]);
    await signOut();
    const session = await authClient.getSession();
    const u = session?.data?.user ?? null;
    say(`SESSION-AFTER-SIGNOUT: ${u ? JSON.stringify(u) : "none"}`);
    say(u ? "FAIL: still signed in" : "DONE-OK");
  }

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Passkey-first signup spike</h1>
      <div>
        <input
          data-testid="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div>
        <input
          data-testid="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <button data-testid="signup" type="button" onClick={handleSignUp}>
        Create account with a passkey
      </button>
      <button data-testid="signin" type="button" onClick={handleSignIn}>
        Sign in with a passkey
      </button>
      <button data-testid="signout" type="button" onClick={handleSignOut}>
        Sign out
      </button>
      <pre data-testid="log">{log.join("\n")}</pre>
    </div>
  );
}
