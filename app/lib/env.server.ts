/**
 * Deployment URL/port env, resolved once. The dev port default is a deliberately
 * uncommon number (not 3000/5173) so multiple dev servers on one machine don't
 * collide — Windows Hyper-V also reserves big chunks around 3000. Keep the
 * default in sync with vite.config.ts (which can't import app modules).
 */
export const DEV_PORT = Number(process.env.PORT ?? 17923);

/** Public-facing base URL; falls back to the local dev server. */
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${DEV_PORT}`;

/** `PUBLIC_BASE_URL` parsed. With camp subdomains on, this is the apex. */
export const APEX = new URL(PUBLIC_BASE_URL);

/** Each camp at `<slug>.<apex>` (see app/lib/camp-host.ts). Off by default. */
export const CAMP_SUBDOMAINS = process.env.CAMP_SUBDOMAINS === "1";
