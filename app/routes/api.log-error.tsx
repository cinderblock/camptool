import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { clientError } from "../../db/schema";
import type { Route } from "./+types/api.log-error";

/**
 * Resource route: the browser forwards JS errors here (see telemetry.client.ts).
 * Best-effort + never errors back at the client — always 204. Attaches the
 * session's user/camp when present (errors can also happen logged-out). Sizes are
 * capped server-side regardless of what the client sends.
 */
const str = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s === "" ? null : s;
};
const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export async function action({ request }: Route.ActionArgs) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const message = str(body.message, 1000) ?? "Unknown error";

    let userId: string | null = null;
    let campId: string | null = null;
    try {
      const session = await getSession(request);
      userId = session?.user.id ?? null;
      campId = session?.session.activeOrganizationId ?? null;
    } catch {
      // no session context — fine
    }

    await db.insert(clientError).values({
      id: crypto.randomUUID(),
      kind: str(body.kind, 32) ?? "error",
      message,
      stack: str(body.stack, 4000),
      source: str(body.source, 500),
      line: intOrNull(body.line),
      col: intOrNull(body.col),
      url: str(body.url, 500),
      userAgent: str(request.headers.get("user-agent"), 500),
      userId,
      campId,
      breadcrumbs: Array.isArray(body.breadcrumbs)
        ? str(JSON.stringify(body.breadcrumbs), 8000)
        : null,
    });
  } catch {
    // Swallow everything — telemetry must never break the app.
  }
  return new Response(null, { status: 204 });
}
