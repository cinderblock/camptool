import { lt } from "drizzle-orm";
import { getRealSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { navTiming } from "../../db/schema";
import type { Route } from "./+types/api.log-nav";

/**
 * Resource route: the browser reports how long each page load and page switch
 * took (app/lib/nav-timing.ts, plans/fast-navigation.md). Signed-in
 * people only, so it's no write surface for strangers. Best-effort and always
 * 204: timing must never break the app. Values are clamped server-side
 * whatever the client sends.
 */

const KEEP_DAYS = 30;

const ms = (v: unknown): number | null => {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  return Math.min(600_000, Math.max(-600_000, Math.round(n)));
};
const str = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s === "" ? null : s;
};

export async function action({ request }: Route.ActionArgs) {
  try {
    const session = await getRealSession(request);
    if (!session) return new Response(null, { status: 204 });
    const body = (await request.json()) as Record<string, unknown>;
    const totalMs = ms(body.totalMs);
    const kind = body.kind === "load" ? "load" : "nav";
    const path = str(body.path, 300);
    if (totalMs == null || totalMs < 0 || !path) {
      return new Response(null, { status: 204 });
    }
    await db.insert(navTiming).values({
      id: crypto.randomUUID(),
      kind,
      path,
      totalMs,
      fetchMs: ms(body.fetchMs),
      ttfbMs: ms(body.ttfbMs),
      fetchLeadMs: ms(body.fetchLeadMs),
      serverMs: ms(body.serverMs),
      dbMs: ms(body.dbMs),
      dbWaits: ms(body.dbWaits),
      colo: str(body.colo, 8),
      codeMs: ms(body.codeMs),
      renderMs: ms(body.renderMs),
      netType: str(body.netType, 16),
      netRttMs: ms(body.netRttMs),
      userAgent: str(request.headers.get("user-agent"), 300),
      userId: session.user.id,
      campId: session.session.activeOrganizationId ?? null,
    });
    // Old rows only matter for trends; trim now and then rather than on a
    // schedule (there is none on every host).
    if (Math.random() < 0.02) {
      await db
        .delete(navTiming)
        .where(
          lt(
            navTiming.createdAt,
            new Date(Date.now() - KEEP_DAYS * 86_400_000),
          ),
        );
    }
  } catch {
    // Swallow everything: telemetry must never break the app.
  }
  return new Response(null, { status: 204 });
}
