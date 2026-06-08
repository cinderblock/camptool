import {
  Anchor,
  Button,
  Container,
  Divider,
  Paper,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import { signIn, signUp } from "~/lib/auth-client";
import { discordEnabled } from "~/lib/auth.server";
import { getSession } from "~/lib/session.server";
import type { Route } from "./+types/login";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) throw redirect("/dashboard");
  return { discordEnabled };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
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

  async function handleSignIn(values: typeof form.values) {
    setBusy(true);
    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
    });
    setBusy(false);
    if (error) return fail(error.message ?? "Sign in failed");
    navigate("/dashboard");
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
    navigate("/dashboard");
  }

  async function handleMagicLink() {
    if (form.validateField("email").hasError) return;
    setBusy(true);
    const { error } = await signIn.magicLink({
      email: form.values.email,
      callbackURL: "/dashboard",
    });
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
    navigate("/dashboard");
  }

  async function handleDiscord() {
    await signIn.social({ provider: "discord", callbackURL: "/dashboard" });
  }

  return (
    <Container size={460} py="xl">
      <Title order={2} ta="center">
        CampTool
      </Title>
      <Text c="dimmed" size="sm" ta="center" mt={4}>
        Sign in to manage your camp
      </Text>

      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Tabs defaultValue="signin">
          <Tabs.List grow>
            <Tabs.Tab value="signin">Sign in</Tabs.Tab>
            <Tabs.Tab value="signup">Create account</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="signin" pt="md">
            <form onSubmit={form.onSubmit(handleSignIn)}>
              <Stack>
                <TextInput
                  label="Email"
                  placeholder="you@example.com"
                  {...form.getInputProps("email")}
                />
                <PasswordInput
                  label="Password"
                  {...form.getInputProps("password")}
                />
                <Button type="submit" loading={busy} fullWidth>
                  Sign in
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

          <Tabs.Panel value="signup" pt="md">
            <form onSubmit={form.onSubmit(handleSignUp)}>
              <Stack>
                <TextInput
                  label="Name"
                  placeholder="Your name"
                  {...form.getInputProps("name")}
                />
                <TextInput
                  label="Email"
                  placeholder="you@example.com"
                  {...form.getInputProps("email")}
                />
                <PasswordInput
                  label="Password"
                  {...form.getInputProps("password")}
                />
                <Button type="submit" loading={busy} fullWidth>
                  Create account
                </Button>
              </Stack>
            </form>
          </Tabs.Panel>
        </Tabs>

        <Divider label="or" labelPosition="center" my="lg" />

        <Stack>
          <Button variant="default" onClick={handlePasskey} disabled={busy}>
            Sign in with a passkey
          </Button>
          {loaderData.discordEnabled ? (
            <Button color="indigo" onClick={handleDiscord} disabled={busy}>
              Continue with Discord
            </Button>
          ) : null}
        </Stack>
      </Paper>
    </Container>
  );
}
