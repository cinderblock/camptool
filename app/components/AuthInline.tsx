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
import { signIn, signUp } from "~/lib/auth-client";

/**
 * Inline account gate shared by the public apply page and the invite-redeem
 * page. Lets a logged-out visitor create an account (with a password) or sign
 * in by any supported method, then revalidates so the surrounding loader
 * re-runs and reveals the now-authenticated flow.
 */
export function AuthInline({
  intro,
  discordEnabled,
}: {
  intro: string;
  discordEnabled: boolean;
}) {
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);

  const form = useForm({
    initialValues: { name: "", email: "", password: "" },
    validate: {
      email: (v) => (/^\S+@\S+$/.test(v) ? null : "Invalid email"),
      password: (v) => (v.length >= 6 ? null : "At least 6 characters"),
    },
  });

  function fail(message: string) {
    notifications.show({ color: "red", title: "Auth error", message });
  }

  async function handleSignUp(values: typeof form.values) {
    if (!values.name.trim()) {
      form.setFieldError("name", "Required");
      return;
    }
    setBusy(true);
    const { error } = await signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });
    setBusy(false);
    if (error) return fail(error.message ?? "Sign up failed");
    revalidate();
  }

  async function handleSignIn(values: typeof form.values) {
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
    if (form.validateField("email").hasError) return;
    setBusy(true);
    const { error } = await signIn.magicLink({ email: form.values.email });
    setBusy(false);
    if (error) return fail(error.message ?? "Could not send link");
    notifications.show({
      title: "Magic link sent",
      message:
        "Check your email. In local dev the link is printed to the server console.",
    });
  }

  async function handlePasskey() {
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
      <Text size="sm" c="dimmed">
        {intro}
      </Text>
      <Tabs defaultValue="signup">
        <Tabs.List grow>
          <Tabs.Tab value="signup">Create account</Tabs.Tab>
          <Tabs.Tab value="signin">I have an account</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="signup" pt="md">
          <form onSubmit={form.onSubmit(handleSignUp)}>
            <Stack>
              <TextInput
                label="Your name"
                placeholder="Jane Doe"
                {...form.getInputProps("name")}
              />
              <TextInput
                label="Email"
                placeholder="jane@example.com"
                {...form.getInputProps("email")}
              />
              <PasswordInput
                label="Password"
                {...form.getInputProps("password")}
              />
              <Button type="submit" loading={busy} fullWidth>
                Create account &amp; continue
              </Button>
            </Stack>
          </form>
        </Tabs.Panel>

        <Tabs.Panel value="signin" pt="md">
          <form onSubmit={form.onSubmit(handleSignIn)}>
            <Stack>
              <TextInput
                label="Email"
                placeholder="jane@example.com"
                {...form.getInputProps("email")}
              />
              <PasswordInput
                label="Password"
                {...form.getInputProps("password")}
              />
              <Button type="submit" loading={busy} fullWidth>
                Sign in &amp; continue
              </Button>
              <Anchor
                component="button"
                type="button"
                size="sm"
                ta="center"
                onClick={handleMagicLink}
              >
                Email me a magic link instead
              </Anchor>
            </Stack>
          </form>
        </Tabs.Panel>
      </Tabs>

      <Divider label="or" labelPosition="center" />

      <Stack>
        <Button variant="default" onClick={handlePasskey} disabled={busy}>
          Continue with a passkey
        </Button>
        {discordEnabled ? (
          <Button color="indigo" onClick={handleDiscord} disabled={busy}>
            Continue with Discord
          </Button>
        ) : null}
      </Stack>
    </Stack>
  );
}
