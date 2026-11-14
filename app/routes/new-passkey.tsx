/**
 * Make a passkey for this address, required of anyone whose passkeys were all
 * made for the camp's old one (the dashboard layout sends them here; see
 * app/lib/legacy-host.server.ts). There's no skipping it: for someone who
 * signs in only with a passkey, it's the only way back in next time.
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
import { eq } from "drizzle-orm";
import { useState } from "react";
import { redirect } from "react-router";
import { authClient, signOut } from "~/lib/auth-client";
import { defaultDeviceName } from "~/lib/device-name";
import { requireUser } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { legacyPasskey, passkey } from "../../db/schema";
import type { Route } from "./+types/new-passkey";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Make a new passkey · CampTool" }];
}

/** Relative paths only, so `next` can't send anyone elsewhere. */
function localNext(raw: string | null): string {
  return raw?.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  const next = localNext(new URL(request.url).searchParams.get("next"));
  const [current] = await db
    .select({ id: passkey.id })
    .from(passkey)
    .where(eq(passkey.userId, session.user.id))
    .limit(1);
  if (current) throw redirect(next);
  const [old] = await db
    .select({ rpId: legacyPasskey.rpId })
    .from(legacyPasskey)
    .where(eq(legacyPasskey.userId, session.user.id))
    .limit(1);
  return {
    next,
    oldHost: old?.rpId ?? null,
    host: new URL(request.url).hostname,
  };
}

export default function NewPasskey({ loaderData }: Route.ComponentProps) {
  const { next, oldHost } = loaderData;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const res = await authClient.passkey.addPasskey({
      name: defaultDeviceName(),
    });
    if (res?.error) {
      setBusy(false);
      setError(res.error.message ?? "The browser cancelled it. Try again.");
      return;
    }
    window.location.assign(next);
  }

  return (
    <Container component="main" id="main-content" size={460} py="xl">
      <Title order={1} size="h2" ta="center">
        Make a new passkey
      </Title>
      <Paper withBorder shadow="sm" p="lg" radius="md" mt="xl">
        <Stack>
          <Text>
            Your camp moved to this address
            {oldHost ? (
              <>
                {" "}
                from <b>{oldHost}</b>
              </>
            ) : null}
            . Passkeys only work at the address they were made for, so your old
            one can't sign you in here.
          </Text>
          <Text>
            Make a new one now; it takes a few seconds. It's how you'll sign in
            from now on.
          </Text>
          {error ? <Alert color="red">{error}</Alert> : null}
          <Button onClick={add} loading={busy}>
            Make a passkey
          </Button>
          <Text size="sm" c="dimmed">
            Not your device?{" "}
            <Anchor
              component="button"
              type="button"
              size="sm"
              onClick={async () => {
                await signOut();
                window.location.assign("/login");
              }}
            >
              Sign out
            </Anchor>
          </Text>
        </Stack>
      </Paper>
    </Container>
  );
}
