import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { checkDevToken, parseSince } from "~/lib/dev-auth.server";
import { db } from "../../db/client.server";
import { feedback, user as userTable } from "../../db/schema";
import type { Route } from "./+types/api.dev.feedback";

/**
 * Dev-only JSON API for user feedback (token-gated; see dev-auth.server.ts).
 *
 * GET `/api/dev/feedback?token=…` — list feedback. Query params:
 *   - `limit` (default 100, max 1000), `since` (epoch ms / ISO / "7d" etc.),
 *     `kind` (filter by kind), `status` (filter by exact status).
 *   - By default only OPEN items are returned (status != "done"), so a check
 *     shows just what's unresolved. Pass `all=1` to include done items.
 *
 * POST `/api/dev/feedback?token=…` — triage feedback (mirrors the Site admin
 * Done/Delete). JSON or form body:
 *   - `op`: "done" (status=done, hidden from the queue) | "reopen" (status=new)
 *     | "delete" (hard delete).
 *   - `id`: a single id, OR `ids`: an array (JSON) / repeated `id` fields (form).
 *   Returns `{ updated, status }` or `{ deleted }`.
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
  const status = url.searchParams.get("status");
  const includeAll = url.searchParams.get("all") === "1";

  const conds = [
    since ? gte(feedback.createdAt, since) : undefined,
    kind ? eq(feedback.kind, kind) : undefined,
    status ? eq(feedback.status, status) : undefined,
    // Default to the open queue (hide handled items) unless asked for all.
    !status && !includeAll ? ne(feedback.status, "done") : undefined,
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

export async function action({ request }: Route.ActionArgs) {
  if (!checkDevToken(request)) {
    throw new Response("Not found", { status: 404 });
  }

  // Accept JSON (`{op, id|ids}`) or a form body (`op`, repeated `id`).
  let op = "";
  let ids: string[] = [];
  if (
    (request.headers.get("content-type") ?? "").includes("application/json")
  ) {
    const b = (await request.json().catch(() => ({}))) as {
      op?: unknown;
      id?: unknown;
      ids?: unknown;
    };
    op = String(b.op ?? "");
    ids = Array.isArray(b.ids)
      ? b.ids.map(String)
      : b.id != null
        ? [String(b.id)]
        : [];
  } else {
    const f = await request.formData();
    op = String(f.get("op") ?? "");
    ids = f.getAll("id").map(String).filter(Boolean);
  }

  if (ids.length === 0) {
    return Response.json({ error: "No id(s) given." }, { status: 400 });
  }

  if (op === "delete") {
    await db.delete(feedback).where(inArray(feedback.id, ids));
    return Response.json({ deleted: ids.length });
  }

  const status = op === "done" ? "done" : op === "reopen" ? "new" : null;
  if (!status) {
    return Response.json(
      { error: 'Unknown op (use "done", "reopen", or "delete").' },
      { status: 400 },
    );
  }
  await db.update(feedback).set({ status }).where(inArray(feedback.id, ids));
  return Response.json({ updated: ids.length, status });
}
