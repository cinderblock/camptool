/**
 * A camp's OLD address, for someone who isn't signed in there: says where the
 * camp went, and lets anyone with a passkey from the old address use it one
 * last time to be signed in at the new one (app/lib/legacy-host.server.ts).
 * Not served on any other host.
 */
import {
  Alert,
  Anchor,
  Button,
  Container,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { data } from "react-router";
import {
  LEGACY_HOSTS,
  movedNext,
  requestLegacyHost,
} from "~/lib/legacy-host.server";
import type { Route } from "./+types/moved";

export function meta(_: Route.MetaArgs) {
  return [{ title: "We've moved · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const host = requestLegacyHost(request);
  if (!host) throw data("Not found", { status: 404 });
  const next = movedNext(request);
  return {
    oldHost: host,
    newHost: new URL(next).host,
    next,
    slug: LEGACY_HOSTS.get(host) ?? "",
  };
}

export default function Moved({ loaderData }: Route.ComponentProps) {
  const { oldHost, newHost, next } = loaderData;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithOldPasskey() {
    setBusy(true);
    setError(null);
    try {
      const post = (body: unknown) =>
        fetch("/api/legacy-passkey", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const start = await post({ step: "options" });
      const { id, options } = await start.json();
      const response = await startAuthentication({ optionsJSON: options });
      const done = await post({ step: "verify", id, response, next });
      const out = await done.json();
      if (!done.ok) throw new Error(out.error ?? "Sign in failed");
      window.location.assign(out.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        We've moved
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Stack>
          <Text>
            CampTool for this camp now lives at{" "}
            <Anchor href={next}>{newHost}</Anchor>. Your account, and everything
            in it, came along.
          </Text>
          <Text>
            Passkeys belong to the address they were made for, so one made for{" "}
            <b>{oldHost}</b> won't work at the new address. If that's how you
            sign in, use it here one last time: you'll be signed in at the new
            address and asked to make a new passkey there.
          </Text>
          {error ? <Alert color="red">{error}</Alert> : null}
          <Button onClick={signInWithOldPasskey} loading={busy}>
            Sign in with my old passkey
          </Button>
          <Button component="a" href={next} variant="default">
            Go to the new address
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
}
