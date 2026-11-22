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
import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { redirect, useNavigate } from "react-router";
import { InAppBrowserWarning } from "~/components/InAppBrowserWarning";
import { NoMailRecoveryNote } from "~/components/NoMailRecoveryNote";
import { discordEnabled, mailEnabled } from "~/lib/auth.server";
import { signIn } from "~/lib/auth-client";
import { safeNext } from "~/lib/camp-host";
import { movedFrom as campsMovedIn } from "~/lib/camp-move/move-in-auth.server";
import { APEX } from "~/lib/env.server";
import { getInstanceSettings } from "~/lib/instance.server";
import { LEGACY_HOSTS } from "~/lib/legacy-host.server";
import { signUpWithPasskey } from "~/lib/passkey-client";
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
  const { allowOpenSignups, allowPasswordLogin } = await getInstanceSettings();
  // Set by /reset/:token after a successful password reset — only reachable
  // while legacy password sign-in is enabled (plans/password-recovery.md).
  const justReset = new URL(request.url).searchParams.get("reset") === "1";
  // A camp that moved here from its own address (LEGACY_HOSTS): passkeys
  // made there can't sign in here, so offer the old address's bridge.
  const movedFrom = [...LEGACY_HOSTS.keys()].map((host) => ({
    host,
    // Same scheme and (in local dev) port as here.
    bridge: `${APEX.protocol}//${host}${!host.includes(":") && APEX.port ? `:${APEX.port}` : ""}/moved${next ? `?next=${encodeURIComponent(next)}` : ""}`,
  }));
  // Camps that moved here from another CampTool site
  // (plans/camp-portability.md): their passkeys can be used here directly,
  // where the browser supports it, or once at the old site.
  const campMoves = (await campsMovedIn()).map((m) => ({
    rpId: m.rpId,
    bridge: `${m.sourceOrigin}/moved/${m.moveId}`,
  }));
  return {
    discordEnabled,
    mailEnabled,
    allowOpenSignups,
    allowPasswordLogin,
    justReset,
    next,
    movedFrom,
    campMoves,
  };
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(loaderData.justReset);
  const { next, allowPasswordLogin } = loaderData;
  // A camp subdomain is another origin, so leave the app for it rather than
  // routing within this one.
  const go = () =>
    next && !next.startsWith("/")
      ? window.location.assign(next)
      : navigate(next ?? "/");

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

  async function handlePasswordSignIn(values: typeof signInForm.values) {
    setBusy(true);
    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
    });
    setBusy(false);
    if (error) return fail(error.message ?? "Sign in failed");
    go();
  }

  async function handlePasskeySignUp(values: typeof signUpForm.values) {
    setBusy(true);
    const res = await signUpWithPasskey({
      name: values.name,
      email: values.email,
    });
    setBusy(false);
    if (!res.ok) return fail(res.error);
    go();
  }

  async function handleMagicLink() {
    if (signInForm.validateField("email").hasError) return;
    setBusy(true);
    const { error } = await signIn.magicLink({
      email: signInForm.values.email,
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
            ? `No passkey for ${location.hostname} was used. A passkey made at ${oldHost} only works there: use the link above${allowPasswordLogin ? ", or sign in with your password" : ""}.`
            : allowPasswordLogin
              ? `No passkey for ${location.hostname} was used. Try again, or sign in with your password.`
              : `No passkey for ${location.hostname} was used. Try again, or ask an officer of your camp for a recovery link.`,
        );
      }
      return fail(res.error.message ?? "Passkey sign in failed");
    }
    go();
  }

  async function handleOldSitePasskey(rpId: string) {
    setBusy(true);
    try {
      const post = (body: unknown) =>
        fetch("/api/move-passkey", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const start = await post({ step: "options", rpId });
      const { id, options } = await start.json();
      const response = await startAuthentication({ optionsJSON: options });
      const done = await post({ step: "verify", id, response, next });
      const out = await done.json();
      if (!done.ok) throw new Error(out.error ?? "Sign in failed");
      window.location.assign(out.url);
    } catch (e) {
      setBusy(false);
      fail(
        `${e instanceof Error ? e.message : String(e)} If your browser can't use a passkey from ${rpId} here, use the link to sign in there once instead.`,
      );
    }
  }

  async function handleDiscord() {
    await signIn.social({ provider: "discord", callbackURL: next ?? "/" });
  }

  const signInBody = (
    <Stack>
      <Button onClick={handlePasskey} loading={busy} fullWidth>
        Sign in with a passkey
      </Button>

      {loaderData.discordEnabled ? (
        <Button color="indigo" onClick={handleDiscord} disabled={busy}>
          Continue with Discord
        </Button>
      ) : null}

      {allowPasswordLogin ? (
        showPassword ? (
          <>
            <Divider label="or use a password" labelPosition="center" />
            <form onSubmit={signInForm.onSubmit(handlePasswordSignIn)}>
              <Stack>
                <TextInput
                  label="Email"
                  placeholder="you@example.com"
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
  );

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        CampTool
      </Title>
      <Text c="dimmed" size="sm" ta="center" mt={4}>
        Sign in to manage your camp
      </Text>

      <Stack gap="md" mt="lg">
        <InAppBrowserWarning />

        {loaderData.justReset && allowPasswordLogin ? (
          <Alert color="green">
            Your password is set. Sign in with it below — and once you're in,
            consider adding a passkey so you never need a password again.
          </Alert>
        ) : null}

        {loaderData.movedFrom.map(({ host, bridge }) => (
          <Alert key={host} color="blue" title={`Moved here from ${host}?`}>
            Your account came along
            {allowPasswordLogin
              ? ", and your password and Discord sign-in work here"
              : ""}
            . A passkey made for {host} doesn&rsquo;t work here, so{" "}
            <Anchor href={bridge}>use it once at {host}</Anchor> to get signed
            in here, then make a new one.
          </Alert>
        ))}

        {loaderData.campMoves.map(({ rpId, bridge }) => (
          <Alert
            key={rpId}
            color="blue"
            title={`Your camp moved here from ${rpId}?`}
          >
            <Stack gap="xs">
              <Text size="sm">
                Your account came along. Sign in with a passkey you made there,
                or <Anchor href={bridge}>sign in at {rpId} once</Anchor> and
                you&apos;ll arrive here signed in.
              </Text>
              <Button
                size="xs"
                variant="light"
                loading={busy}
                onClick={() => handleOldSitePasskey(rpId)}
              >
                Use a passkey from {rpId}
              </Button>
            </Stack>
          </Alert>
        ))}
      </Stack>

      <Paper withBorder shadow="sm" p="lg" radius="md" mt="lg">
        {loaderData.allowOpenSignups ? (
          <Tabs defaultValue="signin">
            <Tabs.List grow>
              <Tabs.Tab value="signin">Sign in</Tabs.Tab>
              <Tabs.Tab value="signup">Create account</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="signin" pt="md">
              {signInBody}
            </Tabs.Panel>

            <Tabs.Panel value="signup" pt="md">
              <form onSubmit={signUpForm.onSubmit(handlePasskeySignUp)}>
                <Stack>
                  <TextInput
                    label="Name"
                    placeholder="Your name"
                    autoComplete="name"
                    {...signUpForm.getInputProps("name")}
                  />
                  <TextInput
                    label="Email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    {...signUpForm.getInputProps("email")}
                  />
                  <Button type="submit" loading={busy} fullWidth>
                    Create account with a passkey
                  </Button>
                  <Text size="xs" c="dimmed" ta="center">
                    Your device asks for your face, fingerprint, or PIN. Nothing
                    to remember, no password to type later.
                  </Text>
                  {loaderData.discordEnabled ? (
                    <>
                      <Divider label="or" labelPosition="center" />
                      <Button
                        color="indigo"
                        onClick={handleDiscord}
                        disabled={busy}
                      >
                        Continue with Discord
                      </Button>
                    </>
                  ) : null}
                </Stack>
              </form>
            </Tabs.Panel>
          </Tabs>
        ) : (
          <Stack gap="md">
            {signInBody}
            <Text c="dimmed" size="sm" ta="center">
              New accounts are invite-only. Ask your camp for an invite link to
              join.
            </Text>
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
