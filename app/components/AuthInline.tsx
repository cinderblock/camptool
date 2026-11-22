import {
  Anchor,
  Button,
  Divider,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useRevalidator } from "react-router";
import { signIn } from "~/lib/auth-client";
import { signUpWithPasskey } from "~/lib/passkey-client";
import { InAppBrowserWarning } from "./InAppBrowserWarning";
import { NoMailRecoveryNote } from "./NoMailRecoveryNote";

/**
 * Inline account gate shared by the public apply page, camp setup links, and
 * the invite-redeem page. New accounts are always passkey-first (no password).
 * Existing members sign in with a passkey (or Discord if enabled, or a legacy
 * password when `allowPasswordLogin` is still on). Revalidates after auth so
 * the surrounding loader re-runs and reveals the authenticated flow.
 */
export function AuthInline({
  intro,
  discordEnabled,
  mailEnabled,
  allowPasswordLogin,
  inviteToken,
}: {
  intro: string;
  discordEnabled: boolean;
  /** False when this deployment has no mail transport — see auth.server.ts. */
  mailEnabled: boolean;
  /** True only while legacy password sign-in is enabled on this deployment. */
  allowPasswordLogin: boolean;
  /** Carried through on `/i/:token` so the signup handle knows its invite. */
  inviteToken?: string;
}) {
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const signUpForm = useForm({
    initialValues: { name: "", email: "" },
    validate: {
      name: (v) => (v.trim() ? null : "Required"),
      email: (v) => (/^\S+@\S+\.\S+$/.test(v.trim()) ? null : "Invalid email"),
    },
  });

  const signInForm = useForm({
    initialValues: { email: "", password: "" },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : "Invalid email"),
      password: (v) => (v.length >= 6 ? null : "At least 6 characters"),
    },
  });

  function fail(message: string) {
    notifications.show({ color: "red", title: "Auth error", message });
  }

  async function handlePasskeySignUp(values: typeof signUpForm.values) {
    setBusy(true);
    const res = await signUpWithPasskey({
      name: values.name,
      email: values.email,
      inviteToken,
    });
    setBusy(false);
    if (!res.ok) return fail(res.error);
    revalidate();
  }

  async function handlePasswordSignIn(values: typeof signInForm.values) {
    setBusy(true);
    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
    });
    setBusy(false);
    if (error) return fail(error.message ?? "Sign in failed");
    revalidate();
  }

  async function handleMagicLink() {
    // The link-styled button has no loading spinner — guard against double-fires.
    if (busy) return;
    if (signInForm.validateField("email").hasError) return;
    setBusy(true);
    const { error } = await signIn.magicLink({
      email: signInForm.values.email,
    });
    setBusy(false);
    if (error) return fail(error.message ?? "Could not send link");
    notifications.show({
      title: "Magic link sent",
      message:
        "Check your email. In local dev the link is printed to the server console.",
    });
  }

  async function handlePasskeySignIn() {
    setBusy(true);
    const res = await signIn.passkey();
    setBusy(false);
    if (res?.error) return fail(res.error.message ?? "Passkey sign in failed");
    revalidate();
  }

  async function handleDiscord() {
    await signIn.social({ provider: "discord" });
  }

  return (
    <Stack gap="md">
      <InAppBrowserWarning />
      <Text size="sm" c="dimmed">
        {intro}
      </Text>
      <Tabs defaultValue="signup">
        <Tabs.List grow>
          <Tabs.Tab value="signup">Create account</Tabs.Tab>
          <Tabs.Tab value="signin">I have an account</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="signup" pt="md">
          <form onSubmit={signUpForm.onSubmit(handlePasskeySignUp)}>
            <Stack>
              <TextInput
                label="Your name"
                placeholder="Jane Doe"
                autoComplete="name"
                {...signUpForm.getInputProps("name")}
              />
              <TextInput
                label="Email"
                placeholder="jane@example.com"
                autoComplete="email"
                {...signUpForm.getInputProps("email")}
              />
              <Button type="submit" loading={busy} fullWidth>
                Create account with a passkey
              </Button>
              <Text size="xs" c="dimmed" ta="center">
                Your device asks for your face, fingerprint, or PIN. Nothing to
                remember, no password to type later.
              </Text>
            </Stack>
          </form>
        </Tabs.Panel>

        <Tabs.Panel value="signin" pt="md">
          <Stack>
            <Button onClick={handlePasskeySignIn} loading={busy} fullWidth>
              Sign in with a passkey
            </Button>

            {allowPasswordLogin ? (
              showPassword ? (
                <>
                  <Divider label="or use a password" labelPosition="center" />
                  <form onSubmit={signInForm.onSubmit(handlePasswordSignIn)}>
                    <Stack>
                      <TextInput
                        label="Email"
                        placeholder="jane@example.com"
                        autoComplete="email"
                        {...signInForm.getInputProps("email")}
                      />
                      <PasswordInput
                        label="Password"
                        autoComplete="current-password"
                        {...signInForm.getInputProps("password")}
                      />
                      <Button
                        type="submit"
                        variant="default"
                        loading={busy}
                        fullWidth
                      >
                        Sign in with password
                      </Button>
                      {mailEnabled ? (
                        <Anchor
                          component="button"
                          type="button"
                          size="sm"
                          ta="center"
                          onClick={handleMagicLink}
                        >
                          Email me a magic link instead
                        </Anchor>
                      ) : null}
                    </Stack>
                  </form>
                </>
              ) : (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  onClick={() => setShowPassword(true)}
                >
                  Sign in with a legacy password instead
                </Button>
              )
            ) : null}

            <NoMailRecoveryNote allowPasswordLogin={allowPasswordLogin} />
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {discordEnabled ? (
        <>
          <Divider label="or" labelPosition="center" />
          <Button color="indigo" onClick={handleDiscord} disabled={busy}>
            Continue with Discord
          </Button>
        </>
      ) : null}
    </Stack>
  );
}
