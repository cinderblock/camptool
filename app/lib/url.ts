/**
 * Making a user-typed link safe to put in an `href`.
 *
 * Shared rather than per-route: the documents library, the prospect log's
 * "link back to the original post", and prospect handles all take a link typed
 * by a human who will not include the scheme, and all of them are equally
 * unwilling to render a `javascript:` URL.
 */

/** Require http(s); default to https:// when no scheme was typed. Null when it
 * doesn't parse as a link at all. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A link shortened for display: host plus a truncated path, no scheme. Full
 * URLs in a table blow the column out and tell the reader nothing extra. */
export function displayUrl(raw: string, max = 44): string {
  try {
    const u = new URL(raw);
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    const shown = `${u.host}${rest}`;
    return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
  } catch {
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
  }
}
