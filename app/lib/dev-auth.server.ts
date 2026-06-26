import { timingSafeEqual } from "node:crypto";

/**
 * Gate for the dev-only telemetry API (`/api/dev/*`). Authenticated by a single
 * shared secret in `DEV_API_TOKEN` — NOT a user session — so it can be curled
 * (e.g. by a developer/agent tracing errors). The token is passed as
 * `Authorization: Bearer <token>` or `?token=<token>`.
 *
 * If `DEV_API_TOKEN` is unset, the endpoints are disabled (treat as not found).
 * Comparison is constant-time. Routes should 404 — not 401 — on failure so the
 * endpoint's existence isn't advertised.
 */
export function checkDevToken(request: Request): boolean {
  const expected = process.env.DEV_API_TOKEN;
  if (!expected) return false;
  const url = new URL(request.url);
  const got =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("token") ??
    "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Parse a `since` query: epoch ms, ISO string, or a relative span like
 * "30m" / "24h" / "7d". Returns a Date, or null if absent/invalid. */
export function parseSince(raw: string | null): Date | null {
  if (!raw) return null;
  const rel = /^(\d+)\s*([mhd])$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * ms);
  }
  const num = Number(raw);
  if (Number.isFinite(num)) return new Date(num);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
