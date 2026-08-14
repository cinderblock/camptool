/**
 * Redeem an officer-issued recovery link.
 *
 * Public and unauthenticated — the whole point is that the person can't get in.
 *
 * **Enrolling a passkey is the primary path**, not the password. This is the
 * one moment a locked-out member is guaranteed to be paying attention, so it's
 * the moment to hand them the credential we actually want them on. The password
 * form is kept, demoted, as the escape hatch for devices that can't do WebAuthn.
 *
 * The **loader is strictly read-only**: opening this URL reports the link's
 * status and does nothing else. That is a requirement, not an implementation
 * detail — the officer who generated the link will sometimes click it to check
 * it, and that must not consume it, invalidate it, or change anything.
 *
 * Either path needs the email the link was issued for as well as the link
 * itself, and the link is only spent once a credential actually exists. See
 * `plans/password-recovery.md`.
 */
import {
  Alert,
  Button,
  Container,
  Divider,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";
import { authClient } from "~/lib/auth-client";
import {
  type ResetLinkState,
  inspectPasswordReset,
  redeemPasswordReset,
} from "~/lib/password-reset.server";
import type { Route } from "./+types/reset.$token";

/** A best-effort human label so people aren't all staring at "My device".
 * Mirrors the helper on /account. */
function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "My device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "My device";
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Get back into your account · CampTool" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  return { status: await inspectPasswordReset(params.token) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (password !== confirm) {
    return data({ error: "Those two passwords don't match." }, { status: 400 });
  }

  const result = await redeemPasswordReset({
    token: params.token,
    email,
    newPassword: password,
  });
  if (!result.ok) return data({ error: result.error }, { status: 400 });

  // Straight to /login rather than signing them in: the point of the exercise
  // is a password that works, so make them prove it once.
  return redirect("/login?reset=1");
}

/** What each dead-end state should tell the reader. Keyed exactly so a new
 * state can't be added without deciding what it says here. */
const DEAD_END: Record<
  Exclude<ResetLinkState, "valid">,
  { title: string; body: string }
> = {
  unknown: {
    title: "This link isn't valid",
    body: "It may have been mistyped, or truncated by the app it was sent through. Ask an officer of your camp to send you a fresh one.",
  },
  expired: {
    title: "This link has expired",
    body: "Reset links last 7 days. Ask an officer of your camp for a new one — it only takes them a moment.",
  },
  used: {
    title: "This link has already been used",
    body: "Someone already used it to get back into this account, so it can't be used again. If that wasn't you, tell an officer of your camp right away.",
  },
  revoked: {
    title: "This link was replaced",
    body: "A newer recovery link was issued for this account, which retires this one. Use the most recent link you were sent.",
  },
  locked: {
    title: "This link is locked",
    body: "Too many wrong email addresses were entered. Ask an officer of your camp for a new link.",
  },
};

export default function ResetPassword({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { status } = loaderData;
  const nav = useNavigation();
  const navigate = useNavigate();
  const params = useParams();
  const busy = nav.state !== "idle";
  const error = actionData && "error" in actionData ? actionData.error : null;

  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  /**
   * Enrol a passkey onto the account this link belongs to.
   *
   * Three steps, and the order matters: the server checks the link + email and
   * hands back an opaque handle; `addPasskey({ context })` runs the WebAuthn
   * ceremony with NO session (the plugin's resolveUser points it at the
   * existing account); then `signIn.passkey()` turns the fresh credential into
   * a session. The link is only spent once the credential is verified, so
   * cancelling the browser prompt costs nothing and they can retry.
   */
  async function enrolPasskey() {
    setPasskeyError(null);
    if (!email.trim()) {
      setPasskeyError("Enter your email address first.");
      return;
    }
    setEnrolling(true);
    try {
      const res = await fetch("/api/passkey-recovery", {
        method: "POST",
        body: new URLSearchParams({ token: params.token ?? "", email }),
      });
      const body = (await res.json()) as { context?: string; error?: string };
      if (!res.ok || !body.context) {
        setPasskeyError(body.error ?? "Couldn't start. Try again.");
        return;
      }

      const added = await authClient.passkey.addPasskey({
        context: body.context,
        name: defaultDeviceName(),
      });
      if (added?.error) {
        setPasskeyError(
          added.error.message ??
            "Your browser cancelled that. You can try again, or set a password instead.",
        );
        return;
      }

      // verify-registration deliberately does NOT create a session, so sign in
      // with the credential we just made.
      const signedIn = await authClient.signIn.passkey();
      if (signedIn?.error) {
        setPasskeyError(
          "Your passkey was saved, but signing in failed. Try signing in from the login page.",
        );
        return;
      }
      navigate("/account");
    } catch {
      setPasskeyError("Something went wrong. Try again.");
    } finally {
      setEnrolling(false);
    }
  }

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        Get back into your account
      </Title>

      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        {status.state !== "valid" ? (
          <Stack gap="sm">
            <Alert color={status.state === "used" ? "blue" : "yellow"}>
              <Text fw={600}>{DEAD_END[status.state].title}</Text>
              <Text size="sm" mt={4}>
                {DEAD_END[status.state].body}
              </Text>
            </Alert>

            {/* Status detail for whoever is holding the link — usually the
                officer who generated it, checking that it's the right one. */}
            {status.state !== "unknown" ? (
              <Text size="sm" c="dimmed">
                Issued by {status.campName} for {status.name} (
                {status.maskedEmail}).
                {status.usedOn ? ` Used on ${status.usedOn}.` : ""}
                {status.state === "expired"
                  ? ` Expired ${status.expires}.`
                  : ""}
              </Text>
            ) : null}

            <Button component={Link} to="/login" variant="default" fullWidth>
              Back to sign in
            </Button>
          </Stack>
        ) : (
          <Stack>
            <Text size="sm">
              This link was issued by <strong>{status.campName}</strong> for{" "}
              <strong>{status.name}</strong>. To use it, confirm the email
              address it belongs to — it looks like{" "}
              <strong>{status.maskedEmail}</strong>.
            </Text>
            <Text size="xs" c="dimmed">
              Valid until {status.expires}. Nothing about your account changes
              until you finish below.
            </Text>

            {error ? <Alert color="red">{error}</Alert> : null}
            {passkeyError ? <Alert color="red">{passkeyError}</Alert> : null}

            <TextInput
              type="email"
              label="Your email address"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />

            {/* Passkey is the primary path, not an afterthought at the bottom:
                this is the one moment a locked-out person is guaranteed to be
                paying attention, so it's the moment to hand them the better
                credential rather than another password to forget. */}
            <Button onClick={enrolPasskey} loading={enrolling} fullWidth>
              Set up a passkey
            </Button>
            <Text size="xs" c="dimmed" mt={-8}>
              Your device asks for your face, fingerprint or PIN, and that
              becomes how you sign in. Nothing to remember, nothing to type, and
              nothing that can be leaked in someone else's breach.
            </Text>

            <Divider label="or" labelPosition="center" my={4} />

            {/* The escape hatch stays, deliberately: an old browser, a
                locked-down work laptop or a shared machine can't do WebAuthn,
                and this link is the holder's only way back in. Demoted, not
                removed — see plans/passkey-first-auth.md "Things not to do". */}
            {showPassword ? (
              <Form method="post">
                <input type="hidden" name="email" value={email} />
                <Stack>
                  {/* Nothing here is password-specific: the value is never
                      trimmed and the only limit is better-auth's 128 chars, so
                      a passphrase round-trips intact. Say so — people assume
                      "password" means one short mangled word. */}
                  <PasswordInput
                    name="password"
                    label="New password or passphrase"
                    description="A few unrelated words — “rusty kettle dawn patrol” — beat one short mangled word. Spaces count."
                    autoComplete="new-password"
                    required
                  />
                  <PasswordInput
                    name="confirm"
                    label="Type it again"
                    autoComplete="new-password"
                    required
                  />
                  <Button
                    type="submit"
                    loading={busy}
                    variant="default"
                    fullWidth
                  >
                    Set my password
                  </Button>
                  <Text size="xs" c="dimmed">
                    Signs you out everywhere else. You can still add a passkey
                    later from your account page.
                  </Text>
                </Stack>
              </Form>
            ) : (
              <Button
                variant="subtle"
                size="compact-sm"
                onClick={() => setShowPassword(true)}
              >
                My device can't do passkeys — set a password instead
              </Button>
            )}
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
