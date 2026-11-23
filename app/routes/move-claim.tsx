/**
 * Claiming your place in a camp that moved here (plans/camp-portability.md,
 * "User matching"). The camp arrived holding a placeholder for you, because
 * an account here already uses your address and nothing proved it's yours.
 * You proved who you are at the old site (that's how you got here); signing
 * in here proves the account. Then your place in the camp moves onto it.
 */
import {
  Alert,
  Button,
  Container,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { data, Form, redirect, useNavigation } from "react-router";
import { safeNext } from "~/lib/camp-host";
import {
  claimInto,
  findClaim,
  spendClaim,
} from "~/lib/camp-move/handoff.server";
import { APEX } from "~/lib/env.server";
import { getRealSession } from "~/lib/session.server";
import type { Route } from "./+types/move-claim";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Claim your place · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const person = await findClaim(url.searchParams.get("c") ?? "");
  const session = await getRealSession(request);
  return {
    valid: !!person,
    email: person?.email ?? null,
    viewer: session
      ? { name: session.user.name, email: session.user.email }
      : null,
    here: url.pathname + url.search,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("c") ?? "";
  const person = await findClaim(code);
  if (!person)
    return data({ error: "This link has expired." }, { status: 400 });
  const session = await getRealSession(request);
  if (!session) return data({ error: "Sign in first." }, { status: 401 });
  const problem = await claimInto(person, session.user.id);
  if (problem) return data({ error: problem }, { status: 400 });
  await spendClaim(code);
  throw redirect(safeNext(url.searchParams.get("next"), APEX) ?? "/");
}

export default function MoveClaim({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { valid, email, viewer, here } = loaderData;
  const busy = useNavigation().state !== "idle";
  const error = (actionData as { error?: string } | undefined)?.error;
  return (
    <Container component="main" id="main-content" size={480} py="xl">
      <Title order={1} size="h2" ta="center">
        Claim your place
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        {!valid ? (
          <Alert color="red" title="Link expired">
            Go back to your camp&apos;s old site and sign in there again.
          </Alert>
        ) : (
          <Stack gap="md">
            <Text size="sm">
              Your camp moved here, and an account with <b>{email}</b> already
              exists. Sign in to claim your membership.
            </Text>
            {error && <Alert color="red">{error}</Alert>}
            {viewer ? (
              <Form method="post">
                <Stack gap="sm">
                  <Text size="sm">
                    Signed in as <b>{viewer.name}</b> ({viewer.email}).
                  </Text>
                  <Button type="submit" loading={busy}>
                    Claim it for this account
                  </Button>
                </Stack>
              </Form>
            ) : (
              <Button
                component="a"
                href={`/login?next=${encodeURIComponent(here)}`}
              >
                Sign in here
              </Button>
            )}
          </Stack>
        )}
      </Paper>
    </Container>
  );
}
