import {
  Alert,
  Button,
  CopyButton,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import {
  detectInAppBrowser,
  type InAppBrowser,
  isStandalonePwa,
} from "~/lib/in-app-browser";

type BlockedState =
  | { kind: "in-app"; browser: InAppBrowser }
  | { kind: "no-webauthn" };

/**
 * Hard gate for doors where consuming a link or starting signup inside a
 * passkey-incapable browser (like Messenger's or Instagram's WebView) would
 * trap the visitor.
 *
 * Uses `serverInApp` (from the request's User-Agent) so SSR blocks immediately
 * on the first byte with no form flicker, and re-checks `navigator.userAgent`
 * plus `window.PublicKeyCredential` on the client to catch unknown WebViews or
 * browsers lacking WebAuthn.
 */
export function PasskeyBrowserGate({
  enabled,
  serverInApp,
  pageUrl,
  reassurance,
  children,
}: {
  /** When false (e.g. legacy password login is on, or user already has a passkey), renders children as-is. */
  enabled: boolean;
  serverInApp: InAppBrowser | null;
  pageUrl: string;
  /** Reassures the visitor that their one-use link is still intact. */
  reassurance?: string;
  children: ReactNode;
}) {
  const [blocked, setBlocked] = useState<BlockedState | null>(() =>
    enabled && serverInApp ? { kind: "in-app", browser: serverInApp } : null,
  );
  const [href, setHref] = useState(pageUrl);

  useEffect(() => {
    setHref(window.location.href);
    if (!enabled) {
      setBlocked(null);
      return;
    }
    const browser = detectInAppBrowser(navigator.userAgent, {
      standalone: isStandalonePwa(),
    });
    if (browser) {
      setBlocked({ kind: "in-app", browser });
      return;
    }
    if (typeof window.PublicKeyCredential === "undefined") {
      setBlocked({ kind: "no-webauthn" });
      return;
    }
    setBlocked(null);
  }, [enabled]);

  if (!enabled || !blocked) return <>{children}</>;

  const title =
    blocked.kind === "in-app"
      ? `Open this link in ${blocked.browser.realBrowser} first`
      : "Open this link in a modern browser first";

  const explanation =
    blocked.kind === "in-app"
      ? `${blocked.browser.appName}'s built-in browser can't set up a passkey, which is how you'll sign back into CampTool.`
      : "This browser doesn't support passkeys, which is how you sign into CampTool.";

  const targetBrowser =
    blocked.kind === "in-app"
      ? blocked.browser.realBrowser
      : "Safari, Chrome, Edge, or Firefox";

  return (
    <Stack gap="md">
      <Alert color="orange" title={title}>
        <Stack gap="xs">
          {reassurance ? (
            <Text size="sm" fw={600}>
              {reassurance}
            </Text>
          ) : null}
          <Text size="sm">{explanation}</Text>
        </Stack>
      </Alert>

      <Stack gap={6}>
        {blocked.kind === "in-app" ? (
          <Text size="sm">
            1. Tap the menu (<strong>⋯</strong> or share button) and choose{" "}
            <strong>Open in {targetBrowser}</strong>.
          </Text>
        ) : null}
        <Text size="sm">
          {blocked.kind === "in-app" ? "2. Or copy " : "Copy "}
          this link and paste it into <strong>{targetBrowser}</strong>:
        </Text>
      </Stack>

      <TextInput
        readOnly
        value={href}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="Link to open in your main browser"
      />

      <CopyButton value={href}>
        {({ copied, copy }) => (
          <Button fullWidth color={copied ? "green" : undefined} onClick={copy}>
            {copied
              ? "Link copied — paste it into your browser"
              : "Copy this link"}
          </Button>
        )}
      </CopyButton>
    </Stack>
  );
}
