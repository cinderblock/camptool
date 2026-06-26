import { and, desc, eq, gte } from "drizzle-orm";
import { checkDevToken, parseSince } from "~/lib/dev-auth.server";
import { db } from "../../db/client.server";
import { feedback, user as userTable } from "../../db/schema";
import type { Route } from "./+types/api.dev.feedback";

/**
 * Dev-only JSON API for user feedback (token-gated; see dev-auth.server.ts).
 * GET `/api/dev/feedback?token=…` with optional `limit`, `since`, `kind`.
 */
export async function loader({ request }: Route.LoaderArgs) {
  if (!checkDevToken(request)) {
    throw new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  const limit = Math.min(
    1000,
    Math.max(1, Number(url.searchParams.get("limit")) || 100),
  );
  const since = parseSince(url.searchParams.get("since"));
  const kind = url.searchParams.get("kind");

  const conds = [
    since ? gte(feedback.createdAt, since) : undefined,
    kind ? eq(feedback.kind, kind) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c != null);

  const rows = await db
    .select({
      id: feedback.id,
      kind: feedback.kind,
      title: feedback.title,
      body: feedback.body,
      details: feedback.details,
      url: feedback.url,
      userAgent: feedback.userAgent,
      metadata: feedback.metadata,
      status: feedback.status,
      userName: userTable.name,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .leftJoin(userTable, eq(feedback.userId, userTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  const safeParse = (s: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };

  return Response.json({
    count: rows.length,
    feedback: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      kind: r.kind,
      status: r.status,
      title: r.title,
      body: r.body,
      details: safeParse(r.details),
      url: r.url,
      user: r.userName,
      userAgent: r.userAgent,
      metadata: safeParse(r.metadata),
    })),
  });
}
