/**
 * Old addresses a camp used to live at, before it moved onto a shared site's
 * subdomain (plans/hosting-other-camps.md, "Moving a camp onto the shared
 * site"). Math Camp ran at `camptool.mathcamp.us` on its own server; now it is
 * `mathcamp.camptool.org`. Point the old host's DNS at the shared site and
 * list it in `LEGACY_HOSTS`:
 *
 *   LEGACY_HOSTS=camptool.mathcamp.us=mathcamp
 *
 * (comma-separated `host=slug` pairs). Every request to an old host is then
 * sent on to the same page at the camp's new address, carrying the sign-in
 * with it when the browser still has an old session cookie. Client-safe: pure.
 */

/** Paths an old host still serves itself rather than redirecting. */
export const LEGACY_HOST_PATHS: ReadonlySet<string> = new Set([
  "/moved",
  "/api/legacy-passkey",
]);

/** `LEGACY_HOSTS` parsed into host → camp slug. Bad entries are skipped. */
export function parseLegacyHosts(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const host = part.slice(0, eq).trim().toLowerCase();
    const slug = part
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    if (/^[a-z0-9.-]+(:\d+)?$/.test(host) && /^[a-z0-9-]+$/.test(slug)) {
      out.set(host, slug);
    }
  }
  return out;
}

/** The old host a request arrived on (host:port as listed), or null. */
export function legacyHostOf(
  host: string | null,
  hosts: ReadonlyMap<string, string>,
): string | null {
  if (!host || hosts.size === 0) return null;
  const h = host.toLowerCase();
  if (hosts.has(h)) return h;
  const bare = h.replace(/:\d+$/, "");
  return hosts.has(bare) ? bare : null;
}

/** Pages that live on the apex rather than a camp's subdomain. */
const APEX_PAGES = /^\/(?:login\/?$|i\/|reset\/|c\/)/;

/** A public camp page, `/c/<slug>` and anything under it. */
const PUBLIC_CAMP_PAGE = /^\/c\/[^/]+(\/.*)?$/;

/**
 * Where a page on the old host lives now: path-for-path at the camp's
 * subdomain, except signing in, invites, recovery links and public camp pages,
 * which live on the apex. An old host only ever served the one camp, so its
 * public pages go to that camp's slug now, whatever slug the old link carried
 * (Math Camp was `math-camp-group-w-m0d3` before the move renamed it).
 */
export function movedTarget(
  url: URL,
  campOrigin: string,
  apexOrigin: string,
  slug: string,
): string {
  const publicPage = url.pathname.match(PUBLIC_CAMP_PAGE);
  if (publicPage) {
    return `${apexOrigin}/c/${slug}${publicPage[1] ?? ""}${url.search}`;
  }
  const base = APEX_PAGES.test(url.pathname) ? apexOrigin : campOrigin;
  return `${base}${url.pathname}${url.search}`;
}
