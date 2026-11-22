/**
 * Detect embedded in-app browsers (Facebook Messenger, Instagram, TikTok, etc.)
 * where WebAuthn / passkeys are missing or broken, and tell the visitor which
 * real browser to open the link in instead.
 *
 * Pure and client-safe — takes a user-agent string rather than reading
 * `navigator` directly so it can be unit-tested cleanly.
 */

export type InAppBrowser = {
  /** Human-friendly name of the host app, e.g. "Facebook Messenger". */
  appName: string;
  /** The real browser to point them toward on this device. */
  realBrowser: "Safari" | "Chrome" | "your browser";
};

function realBrowserFor(ua: string): InAppBrowser["realBrowser"] {
  if (/iPhone|iPad|iPod/i.test(ua)) return "Safari";
  if (/Android/i.test(ua)) return "Chrome";
  return "your browser";
}

const RULES: ReadonlyArray<{ pattern: RegExp; appName: string }> = [
  // Messenger must come before the generic Facebook rule because Messenger
  // WebViews also carry `FBAN/` / `FB_IAB/`.
  {
    pattern:
      /MessengerForiOS|MessengerLiteForiOS|Orca-Android|FB_IAB\/MESSENGER|\bFBAN\/Messenger/i,
    appName: "Facebook Messenger",
  },
  { pattern: /\bInstagram\b/i, appName: "Instagram" },
  { pattern: /\bFBAN\b|\bFBAV\b|\bFB_IAB\b/i, appName: "Facebook" },
  { pattern: /BytedanceWebview|\bTikTok\b|musical_ly/i, appName: "TikTok" },
  { pattern: /\bSnapchat\b/i, appName: "Snapchat" },
  { pattern: /\bLine\//i, appName: "LINE" },
  { pattern: /\bLinkedInApp\b/i, appName: "LinkedIn" },
  { pattern: /\bTwitter\b/i, appName: "X" },
  { pattern: /\bMicroMessenger\b/i, appName: "WeChat" },
  { pattern: /\bSlack\b/i, appName: "Slack" },
  // Generic Android embedded WebView token (`; wv)` in Chromium-based WebViews).
  { pattern: /;\s*wv\)/i, appName: "This app" },
];

export function detectInAppBrowser(userAgent: string): InAppBrowser | null {
  if (!userAgent) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(userAgent)) {
      return {
        appName: rule.appName,
        realBrowser: realBrowserFor(userAgent),
      };
    }
  }
  return null;
}
