/** A best-effort human label for a new passkey, so people aren't all staring
 * at "My device". Client-safe. */
export function defaultDeviceName(): string {
  if (typeof navigator === "undefined") return "My device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "My device";
}
