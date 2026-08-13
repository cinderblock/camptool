/**
 * Redeem an officer-issued password reset link.
 *
 * Public and unauthenticated — the whole point is that the person can't get in.
 *
 * The **loader is strictly read-only**: opening this URL reports the link's
 * status and does nothing else. That is a requirement, not an implementation
 * detail — the officer who generated the link will sometimes click it to check
 * it, and that must not consume it, invalidate it, or change anyone's password.
 *
 * Actually resetting needs the email the link was issued for as well as the
 * link itself. See `plans/password-recovery.md`.
 */
import {
  Alert,
  Button,
  Container,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Form, Link, data, redirect, useNavigation } from "react-router";
import {
  type ResetLinkState,
  inspectPasswordReset,
  redeemPasswordReset,
} from "~/lib/password-reset.server";
import type { Route } from "./+types/reset.$token";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Reset your password · CampTool" }];
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
    body: "The password was reset with it, so it can't be used again. If that wasn't you, tell an officer of your camp right away.",
  },
  revoked: {
    title: "This link was replaced",
    body: "A newer reset link was issued for this account, which retires this one. Use the most recent link you were sent.",
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
  const busy = nav.state !== "idle";
  const error = actionData && "error" in actionData ? actionData.error : null;

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        Reset your password
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
              Valid until {status.expires}. Your current password keeps working
              until you finish this.
            </Text>

            {error ? <Alert color="red">{error}</Alert> : null}

            <Form method="post">
              <Stack>
                <TextInput
                  name="email"
                  label="Your email address"
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
                <PasswordInput
                  name="password"
                  label="New password"
                  autoComplete="new-password"
                  required
                />
                <PasswordInput
                  name="confirm"
                  label="New password again"
                  autoComplete="new-password"
                  required
                />
                <Button type="submit" loading={busy} fullWidth>
                  Set my password
                </Button>
              </Stack>
            </Form>

            <Text size="xs" c="dimmed">
              Setting a new password signs you out everywhere else. Once you're
              back in, consider adding a passkey on your account page — then you
              won't need a password at all.
            </Text>
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
