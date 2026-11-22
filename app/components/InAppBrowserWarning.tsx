import { Alert, Button, CopyButton, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import {
  detectInAppBrowser,
  type InAppBrowser,
  isStandalonePwa,
} from "~/lib/in-app-browser";

type WarningState =
  | { kind: "in-app"; browser: InAppBrowser; href: string }
  | { kind: "no-webauthn"; href: string };

/**
 * Shown on passkey surfaces (login, signup doors, recovery, /account) when the
 * visitor is inside an embedded in-app browser (Messenger, Instagram, etc.) or
 * a browser without WebAuthn support.
 *
 * Client-only detection via useEffect so SSR and hydration never disagree.
 */
export function InAppBrowserWarning() {
  const [warning, setWarning] = useState<WarningState | null>(null);

  useEffect(() => {
    const href = window.location.href;
    const browser = detectInAppBrowser(navigator.userAgent, {
      standalone: isStandalonePwa(),
    });
    if (browser) {
      setWarning({ kind: "in-app", browser, href });
      return;
    }
    if (typeof window.PublicKeyCredential === "undefined") {
      setWarning({ kind: "no-webauthn", href });
    }
  }, []);

  if (!warning) return null;

  if (warning.kind === "in-app") {
    const { appName, realBrowser } = warning.browser;
    return (
      <Alert color="orange" title={`Open this link in ${realBrowser}`}>
        <Stack gap="xs">
          <Text size="sm">
            {appName}&rsquo;s built-in browser doesn&rsquo;t support passkeys.
            Tap the menu (<strong>⋯</strong> or share button) and choose{" "}
            <strong>Open in {realBrowser}</strong>, or copy this link and paste
            it there.
          </Text>
          <Group>
            <CopyButton value={warning.href}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant={copied ? "filled" : "light"}
                  color={copied ? "green" : "orange"}
                  onClick={copy}
                >
                  {copied ? "Link copied" : "Copy this link"}
                </Button>
              )}
            </CopyButton>
          </Group>
        </Stack>
      </Alert>
    );
  }

  return (
    <Alert color="orange" title="This browser doesn't support passkeys">
      <Stack gap="xs">
        <Text size="sm">
          Passkeys need a modern browser such as Safari, Chrome, Edge, or
          Firefox. Copy this link and open it in one of those to continue.
        </Text>
        <Group>
          <CopyButton value={warning.href}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                variant={copied ? "filled" : "light"}
                color={copied ? "green" : "orange"}
                onClick={copy}
              >
                {copied ? "Link copied" : "Copy this link"}
              </Button>
            )}
          </CopyButton>
        </Group>
      </Stack>
    </Alert>
  );
}
