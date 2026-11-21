import { and, desc, eq, gte } from "drizzle-orm";
import { checkDevToken, parseSince } from "~/lib/dev-auth.server";
import { db } from "../../db/client.server";
import { navTiming, user as userTable } from "../../db/schema";
import type { Route } from "./+types/api.dev.nav";

/**
 * Dev-only JSON API for page load / switch timings from real browsers
 * (token-gated; see dev-auth.server.ts, plans/fast-navigation.md).
 * GET `/api/dev/nav?token=…` with optional:
 *   since  (default "24h"; epoch ms, ISO, or "30m"/"24h"/"7d")
 *   kind   (nav | load)
 *   path   (exact pathname)
 *   user   (exact user name)
 *   group  ("1" → per path: count, then median and 90th percentile of each
 *           part; "0" → raw rows, newest first)
 *   limit  (raw rows only; default 200, max 2000)
 */
const PARTS = [
  "totalMs",
  "fetchMs",
  "ttfbMs",
  "fetchLeadMs",
  "serverMs",
  "dbMs",
  "dbWaits",
  "codeMs",
  "renderMs",
  "netRttMs",
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  if (!checkDevToken(request)) {
    throw new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  const since =
    parseSince(url.searchParams.get("since")) ??
    new Date(Date.now() - 86_400_000);
  const kind = url.searchParams.get("kind");
  const path = url.searchParams.get("path");
  const userName = url.searchParams.get("user");
  const grouped = url.searchParams.get("group") !== "0";
  const limit = Math.min(
    2000,
    Math.max(1, Number(url.searchParams.get("limit")) || 200),
  );

  const conds = [
    gte(navTiming.createdAt, since),
    kind ? eq(navTiming.kind, kind) : undefined,
    path ? eq(navTiming.path, path) : undefined,
    userName ? eq(userTable.name, userName) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c != null);

  const rows = await db
    .select({
      at: navTiming.createdAt,
      kind: navTiming.kind,
      path: navTiming.path,
      totalMs: navTiming.totalMs,
      fetchMs: navTiming.fetchMs,
      ttfbMs: navTiming.ttfbMs,
      fetchLeadMs: navTiming.fetchLeadMs,
      serverMs: navTiming.serverMs,
      dbMs: navTiming.dbMs,
      dbWaits: navTiming.dbWaits,
      colo: navTiming.colo,
      codeMs: navTiming.codeMs,
      renderMs: navTiming.renderMs,
      netType: navTiming.netType,
      netRttMs: navTiming.netRttMs,
      userAgent: navTiming.userAgent,
      user: userTable.name,
    })
    .from(navTiming)
    .leftJoin(userTable, eq(navTiming.userId, userTable.id))
    .where(and(...conds))
    .orderBy(desc(navTiming.createdAt))
    .limit(grouped ? 20_000 : limit);

  if (!grouped) {
    return Response.json({
      count: rows.length,
      rows: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    });
  }

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.kind} ${r.path}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const groups = [...byKey.entries()]
    .map(([key, list]) => {
      const stats: Record<string, { p50: number; p90: number } | null> = {};
      for (const part of PARTS) {
        const values = list
          .map((r) => r[part])
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b);
        stats[part] = values.length
          ? { p50: pct(values, 0.5), p90: pct(values, 0.9) }
          : null;
      }
      const colos: Record<string, number> = {};
      for (const r of list) {
        if (r.colo) colos[r.colo] = (colos[r.colo] ?? 0) + 1;
      }
      return { key, count: list.length, ...stats, colos };
    })
    .sort((a, b) => b.count - a.count);
  return Response.json({
    since: since.toISOString(),
    total: rows.length,
    groups,
  });
}

/** Nearest-rank percentile of an ascending list. */
function pct(sorted: number[], p: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
}
