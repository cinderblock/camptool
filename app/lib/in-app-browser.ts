/**
 * Detect embedded in-app browsers (Facebook Messenger, Instagram, TikTok,
 * Gmail / Google app WKWebView, generic Android WebViews, etc.) where WebAuthn
 * passkeys are missing or fail, and tell the visitor which real browser to
 * open the link in instead.
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
  { pattern: /\bGSA\//i, appName: "The Google app" },
  // Generic Android embedded WebView token (`; wv)` in Chromium-based WebViews).
  { pattern: /;\s*wv\)/i, appName: "This app" },
];

/**
 * True when running inside an installed standalone PWA (which on iOS omits
 * `Safari/` from its UA just like a WKWebView, yet DOES support passkeys).
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

export function detectInAppBrowser(
  userAgent: string,
  opts?: { standalone?: boolean },
): InAppBrowser | null {
  if (!userAgent) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(userAgent)) {
      return {
        appName: rule.appName,
        realBrowser: realBrowserFor(userAgent),
      };
    }
  }
  // Generic iOS WKWebView heuristic (Gmail, Outlook, etc.): real iOS browsers
  // — Safari, Chrome (`CriOS`), Firefox (`FxiOS`), Edge (`EdgiOS`), and
  // SFSafariViewController — all include `Safari/` in their UA string, whereas
  // embedded WKWebViews carry `AppleWebKit/... Mobile/...` without `Safari/`.
  // Skip when running as an installed standalone PWA, which also omits it.
  if (
    !opts?.standalone &&
    /iPhone|iPad|iPod/i.test(userAgent) &&
    /AppleWebKit\//i.test(userAgent) &&
    !/\bSafari\//i.test(userAgent)
  ) {
    return { appName: "This app", realBrowser: "Safari" };
  }
  return null;
}
