import {
  Alert,
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
import { NoMailRecoveryNote } from "~/components/NoMailRecoveryNote";
import { discordEnabled, mailEnabled } from "~/lib/auth.server";
import { signIn, signUp } from "~/lib/auth-client";
import { safeNext } from "~/lib/camp-host";
import { APEX } from "~/lib/env.server";
import { getInstanceSettings } from "~/lib/instance.server";
import { LEGACY_HOSTS } from "~/lib/legacy-host.server";
import { getSession } from "~/lib/session.server";
import type { Route } from "./+types/login";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Sign in · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // Where to go afterwards: a camp subdomain sends people here to sign in
  // (signing in only happens on the apex), and back with `next`.
  const next = safeNext(new URL(request.url).searchParams.get("next"), APEX);
  const session = await getSession(request);
  if (session) throw redirect(next ?? "/");
  const { allowOpenSignups } = await getInstanceSettings();
  // Set by /reset/:token after a successful password reset — the only way in
  // when there's no mail transport (plans/password-recovery.md).
  const justReset = new URL(request.url).searchParams.get("reset") === "1";
  // A camp that moved here from its own address (LEGACY_HOSTS): passkeys
  // made there can't sign in here, so offer the old address's bridge.
  const movedFrom = [...LEGACY_HOSTS.keys()].map((host) => ({
    host,
    // Same scheme and (in local dev) port as here.
    bridge: `${APEX.protocol}//${host}${!host.includes(":") && APEX.port ? `:${APEX.port}` : ""}/moved${next ? `?next=${encodeURIComponent(next)}` : ""}`,
  }));
  return {
    discordEnabled,
    mailEnabled,
    allowOpenSignups,
    justReset,
    next,
    movedFrom,
  };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { next } = loaderData;
  // A camp subdomain is another origin, so leave the app for it rather than
  // routing within this one.
  const go = () =>
    next && !next.startsWith("/")
      ? window.location.assign(next)
      : navigate(next ?? "/");

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
    go();
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
    go();
  }

  async function handleMagicLink() {
    if (form.validateField("email").hasError) return;
    setBusy(true);
    const { error } = await signIn.magicLink({
      email: form.values.email,
      callbackURL: next ?? "/",
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
    if (res?.error) {
      // The plugin reports every browser refusal as "auth cancelled",
      // including "this browser has no passkey for this site", which is
      // what someone gets with only a passkey made at a camp's old address.
      if ("code" in res.error && res.error.code === "AUTH_CANCELLED") {
        const oldHost = loaderData.movedFrom[0]?.host;
        return fail(
          oldHost
            ? `No passkey for ${location.hostname} was used. A passkey made at ${oldHost} only works there: use the link above, or sign in with your password.`
            : `No passkey for ${location.hostname} was used. Try again, or sign in with your password.`,
        );
      }
      return fail(res.error.message ?? "Passkey sign in failed");
    }
    go();
  }

  async function handleDiscord() {
    await signIn.social({ provider: "discord", callbackURL: next ?? "/" });
  }

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        CampTool
      </Title>
      <Text c="dimmed" size="sm" ta="center" mt={4}>
        Sign in to manage your camp
      </Text>

      {loaderData.justReset ? (
        <Alert color="green" mt="lg">
          Your password is set. Sign in with it below — and once you're in,
          consider adding a passkey so you never need a password again.
        </Alert>
      ) : null}

      {loaderData.movedFrom.map(({ host, bridge }) => (
        <Alert
          key={host}
          color="blue"
          mt="lg"
          title={`Moved here from ${host}?`}
        >
          Your account came along, and your password and Discord sign-in work
          here. A passkey made for {host} doesn't, so{" "}
          <Anchor href={bridge}>use it once at {host}</Anchor> to get signed in
          here, then make a new one.
        </Alert>
      ))}

      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Tabs defaultValue="signin">
          <Tabs.List grow>
            <Tabs.Tab value="signin">Sign in</Tabs.Tab>
            {loaderData.allowOpenSignups ? (
              <Tabs.Tab value="signup">Create account</Tabs.Tab>
            ) : null}
          </Tabs.List>

          <Tabs.Panel value="signin" pt="md">
            <form onSubmit={form.onSubmit(handleSignIn)}>
              <Stack>
                <TextInput
                  label="Email"
                  placeholder="you@example.com"
                  autoComplete="email"
                  {...form.getInputProps("email")}
                />
                <PasswordInput
                  label="Password"
                  autoComplete="current-password"
                  {...form.getInputProps("password")}
                />
                <Button type="submit" loading={busy} fullWidth>
                  Sign in
                </Button>
                {loaderData.mailEnabled ? (
                  <Anchor
                    component="button"
                    type="button"
                    size="sm"
                    ta="center"
                    onClick={handleMagicLink}
                  >
                    Email me a magic link instead
                  </Anchor>
                ) : (
                  <NoMailRecoveryNote />
                )}
              </Stack>
            </form>
          </Tabs.Panel>

          {loaderData.allowOpenSignups ? (
            <Tabs.Panel value="signup" pt="md">
              <form onSubmit={form.onSubmit(handleSignUp)}>
                <Stack>
                  <TextInput
                    label="Name"
                    placeholder="Your name"
                    autoComplete="name"
                    {...form.getInputProps("name")}
                  />
                  <TextInput
                    label="Email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    {...form.getInputProps("email")}
                  />
                  <PasswordInput
                    label="Password"
                    autoComplete="new-password"
                    {...form.getInputProps("password")}
                  />
                  <Button type="submit" loading={busy} fullWidth>
                    Create account
                  </Button>
                </Stack>
              </form>
            </Tabs.Panel>
          ) : null}
        </Tabs>

        {loaderData.allowOpenSignups ? null : (
          <Text c="dimmed" size="sm" ta="center" mt="md">
            New accounts are invite-only. Ask your camp for an invite link to
            join.
          </Text>
        )}

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
