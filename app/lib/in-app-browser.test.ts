import { describe, expect, test } from "bun:test";
import { detectInAppBrowser } from "./in-app-browser";

describe("detectInAppBrowser", () => {
  test("recognizes Facebook Messenger on iOS and Android", () => {
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22A3354 [FBAN/MessengerForiOS;FBAV/475.0.0.48.108]";
    expect(detectInAppBrowser(ios)).toEqual({
      appName: "Facebook Messenger",
      realBrowser: "Safari",
    });

    const android =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/470.0.0.41.109;]";
    expect(detectInAppBrowser(android)).toEqual({
      appName: "Facebook Messenger",
      realBrowser: "Chrome",
    });
  });

  test("recognizes Facebook, Instagram, and generic Android WebViews", () => {
    expect(
      detectInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/475.0]",
      ),
    ).toEqual({ appName: "Facebook", realBrowser: "Safari" });

    expect(
      detectInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 345.0.0.29.96",
      ),
    ).toEqual({ appName: "Instagram", realBrowser: "Safari" });

    expect(
      detectInAppBrowser(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ appName: "This app", realBrowser: "Chrome" });
  });

  test("returns null for real browsers", () => {
    const realUAs = [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      "",
    ];
    for (const ua of realUAs) {
      expect(detectInAppBrowser(ua)).toBeNull();
    }
  });
});
