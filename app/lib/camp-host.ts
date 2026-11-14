/**
 * Camp subdomains (plans/hosting-other-camps.md, "Camp subdomains").
 *
 * With `CAMP_SUBDOMAINS=1` and `PUBLIC_BASE_URL` at the apex (e.g.
 * `https://camptool.org`), each camp lives at `<slug>.camptool.org`. The apex
 * keeps everything to do with signing in and joining (login, passkeys, the
 * Discord callback, invites, public apply pages), so those have exactly one
 * origin. Off, the app is single-host exactly as before. Client-safe: pure.
 */

/** Names a camp can't take as its subdomain. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "app",
  "admin",
  "auth",
  "login",
  "mail",
  "email",
  "smtp",
  "static",
  "assets",
  "cdn",
  "media",
  "status",
  "docs",
  "help",
  "support",
  "blog",
  "dev",
  "staging",
  "test",
]);

/** Whether `slug` works as a single DNS label and isn't reserved. */
export function isValidCampSlug(slug: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  );
}

/**
 * The camp slug a request's host names, or null for the apex or any host that
 * isn't one label under it. `host` may carry a port.
 */
export function campSlugFromHost(host: string, apex: URL): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${apex.hostname.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return label && !label.includes(".") ? label : null;
}

/** `https://<slug>.<apex>` (with the apex's port, if any). */
export function campOrigin(slug: string, apex: URL): string {
  const port = apex.port ? `:${apex.port}` : "";
  return `${apex.protocol}//${slug}.${apex.hostname}${port}`;
}

/**
 * Whether `target` is a safe place to send someone after signing in: a path on
 * this site, or an absolute URL on the apex or one of its camp subdomains.
 * Anything else (another site, `//evil`, `javascript:`) is refused, so `next`
 * can't be used as an open redirect.
 */
export function safeNext(target: string | null, apex: URL): string | null {
  if (!target) return null;
  if (target.startsWith("/") && !target.startsWith("//")) return target;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (u.protocol !== apex.protocol) return null;
  if (u.port !== apex.port) return null;
  const h = u.hostname.toLowerCase();
  const a = apex.hostname.toLowerCase();
  if (h !== a && campSlugFromHost(h, apex) === null) return null;
  return u.toString();
}

/**
 * The page a request is for. React Router's client navigations fetch a page's
 * data at `<path>.data` (`/_.data` for `/`), with a `_routes` parameter, and
 * that's the URL a loader sees. A redirect to another host can't stay a data
 * request (the browser navigates there), so it must name the page itself.
 */
export function pageUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.pathname.endsWith(".data")) {
    const p = url.pathname.slice(0, -".data".length);
    url.pathname = p === "/_" ? "/" : p;
    url.searchParams.delete("_routes");
  }
  return url;
}
