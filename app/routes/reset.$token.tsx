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
  data,
  Form,
  Link,
  redirect,
  useNavigate,
  useNavigation,
  useParams,
  useRevalidator,
} from "react-router";
import { InAppBrowserWarning } from "~/components/InAppBrowserWarning";
import { PasskeyBrowserGate } from "~/components/PasskeyBrowserGate";
import { authClient, signOut } from "~/lib/auth-client";
import { pageUrl } from "~/lib/camp-host";
import { defaultDeviceName } from "~/lib/device-name";
import { getInstanceSettings } from "~/lib/instance.server";
import { requestInAppBrowser } from "~/lib/passkey-gate.server";
import {
  inspectPasswordReset,
  type ResetLinkState,
  redeemPasswordReset,
} from "~/lib/password-reset.server";
import { getRealSession } from "~/lib/session.server";
import type { Route } from "./+types/reset.$token";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Get back into your account · CampTool" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const [status, { allowPasswordLogin }, session] = await Promise.all([
    inspectPasswordReset(params.token),
    getInstanceSettings(),
    getRealSession(request),
  ]);
  return {
    status,
    allowPasswordLogin,
    signedInAs: session ? { name: session.user.name } : null,
    inAppBrowser: requestInAppBrowser(request),
    pageUrl: pageUrl(request.url).href,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { allowPasswordLogin } = await getInstanceSettings();
  if (!allowPasswordLogin) {
    return data(
      {
        error:
          "Password sign-in is disabled on this site. Use the passkey button above to get back in.",
      },
      { status: 403 },
    );
  }
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
    title: "Invalid recovery link",
    body: "This link may have been mistyped or cut off. Ask an officer for a new one.",
  },
  expired: {
    title: "Recovery link expired",
    body: "Recovery links expire after 7 days. Ask an officer for a new one.",
  },
  used: {
    title: "Link already used",
    body: "This link has already been used. If that wasn't you, contact an officer.",
  },
  revoked: {
    title: "Link replaced",
    body: "This link was replaced by a newer recovery link. Use the latest link you received.",
  },
  locked: {
    title: "Link locked",
    body: "Too many incorrect email attempts. Ask an officer for a new link.",
  },
};

export default function ResetPassword({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const {
    status,
    allowPasswordLogin,
    signedInAs,
    inAppBrowser,
    pageUrl: url,
  } = loaderData;
  const nav = useNavigation();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const params = useParams();
  const busy = nav.state !== "idle";
  const error = actionData && "error" in actionData ? actionData.error : null;

  const [email, setEmail] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  async function handleSignOutToUse() {
    setSigningOut(true);
    try {
      await signOut();
      revalidate();
    } finally {
      setSigningOut(false);
    }
  }

  /**
   * Enrol a passkey onto the account this link belongs to.
   *
   * Single WebAuthn prompt: the server checks the link + email and hands back
   * an opaque handle, then `addPasskey({ context, createSession: true })` runs
   * the WebAuthn ceremony with NO existing session (the plugin's resolveUser
   * points it at the existing account, afterVerification spends the link and
   * clears old sessions, and createSession mints the fresh session cookie).
   * Cancelling the prompt costs nothing and they can retry.
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
        createSession: true,
      });
      if (added?.error) {
        setPasskeyError(
          added.error.message ??
            (allowPasswordLogin
              ? "Your browser cancelled that. You can try again, or set a password instead."
              : "Your browser cancelled that. Make sure you're in Safari, Chrome, or another modern browser and try again."),
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
                Issued by {status.campName ?? "a site admin"} for {status.name}{" "}
                ({status.maskedEmail}).
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
        ) : signedInAs ? (
          <Stack gap="md">
            <Alert
              color="blue"
              title={`You're signed in as ${signedInAs.name}`}
            >
              <Text size="sm">
                This recovery link is valid for <strong>{status.name}</strong> (
                {status.maskedEmail}) until {status.expires}. Opening it here
                didn&rsquo;t use it.
              </Text>
            </Alert>
            <Text size="sm" c="dimmed">
              If you&rsquo;re an officer checking the link before sending it,
              you&rsquo;re all set — just send them this URL.
            </Text>
            <Text size="sm" c="dimmed">
              If this link is for you and you want to use it on this device,
              sign out first (or add a passkey directly from{" "}
              <Link to="/account">Your account</Link> if you&rsquo;re already in
              the right account).
            </Text>
            <Button
              onClick={handleSignOutToUse}
              loading={signingOut}
              variant="default"
              fullWidth
            >
              Sign out to use this link
            </Button>
          </Stack>
        ) : (
          <PasskeyBrowserGate
            enabled={!allowPasswordLogin}
            serverInApp={inAppBrowser}
            pageUrl={url}
            reassurance="Your recovery link hasn't been used yet — it's still good."
          >
            <Stack>
              <InAppBrowserWarning />
              <Text size="sm">
                Recovery link from{" "}
                <strong>{status.campName ?? "a site admin"}</strong> for{" "}
                <strong>{status.name}</strong> ({status.maskedEmail}). Valid
                until {status.expires}.
              </Text>

              {error ? <Alert color="red">{error}</Alert> : null}
              {passkeyError ? <Alert color="red">{passkeyError}</Alert> : null}

              <TextInput
                type="email"
                label="Confirm your email"
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
                Sign in with your device's biometrics or PIN — no password
                needed.
              </Text>

              {allowPasswordLogin ? (
                <>
                  <Divider label="or" labelPosition="center" my={4} />

                  {/* The escape hatch stays only while legacy password login is
                    still enabled on this deployment. */}
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
                          label="New password"
                          description="Passphrases with spaces are supported."
                          autoComplete="new-password"
                          required
                        />
                        <PasswordInput
                          name="confirm"
                          label="Confirm password"
                          autoComplete="new-password"
                          required
                        />
                        <Button
                          type="submit"
                          loading={busy}
                          variant="default"
                          fullWidth
                        >
                          Set password
                        </Button>
                        <Text size="xs" c="dimmed">
                          Signs you out on other devices.
                        </Text>
                      </Stack>
                    </Form>
                  ) : (
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => setShowPassword(true)}
                    >
                      Set a password instead
                    </Button>
                  )}
                </>
              ) : null}
            </Stack>
          </PasskeyBrowserGate>
        )}
      </Paper>
    </Container>
  );
}
