import { Alert, Button, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useRevalidator } from "react-router";
import { authClient } from "~/lib/auth-client";
import { defaultDeviceName } from "~/lib/device-name";

/**
 * Shown on setup/invite doors when a visitor is already signed in (e.g. via
 * Discord or a carry-over session) but doesn't have a passkey yet. Enrolling a
 * passkey here unlocks the next step before any one-use link is consumed.
 */
export function PasskeySetupGate({
  viewerName,
  nextStepLabel,
  hasLink = false,
}: {
  viewerName: string;
  /** e.g. "start your camp" or "join Entheos" */
  nextStepLabel: string;
  hasLink?: boolean;
}) {
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enrol() {
    setError(null);
    if (typeof window.PublicKeyCredential === "undefined") {
      setError(
        "This browser doesn't support passkeys. Open this link in Safari, Chrome, or another modern browser.",
      );
      return;
    }
    setBusy(true);
    const res = await authClient.passkey.addPasskey({
      name: defaultDeviceName(),
    });
    setBusy(false);
    if (res?.error) {
      setError(
        res.error.message ??
          "Passkey setup was cancelled. Try again when you're ready.",
      );
      return;
    }
    revalidate();
  }

  return (
    <Stack gap="md">
      <Alert color="blue" title="Set up a passkey first">
        Signed in as <strong>{viewerName}</strong>. Before you {nextStepLabel},
        add a passkey on this device so you can always sign back in.
        {hasLink ? " Your link hasn't been used yet." : ""}
      </Alert>

      {error ? <Alert color="red">{error}</Alert> : null}

      <Button onClick={enrol} loading={busy} fullWidth>
        Set up a passkey
      </Button>
      <Text size="xs" c="dimmed" ta="center">
        Your device asks for your face, fingerprint, or PIN. Once that&rsquo;s
        saved, you&rsquo;ll continue right where you left off.
      </Text>
    </Stack>
  );
}
