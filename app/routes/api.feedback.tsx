import { data } from "react-router";
import { getSession } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { feedback } from "../../db/schema";
import type { Route } from "./+types/api.feedback";

const KINDS = new Set([
  "bug",
  "issue",
  "improvement",
  "suggestion",
  "compliment",
  "other",
]);

const str = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).slice(0, max).trim();
  return s === "" ? null : s;
};

export async function action({ request }: Route.ActionArgs) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return data({ error: "Bad request." }, { status: 400 });
  }

  let kind = String(body.kind ?? "other");
  if (!KINDS.has(kind)) kind = "other";

  const text = str(body.body, 5000) ?? "";
  const details =
    body.details && typeof body.details === "object" ? body.details : null;
  const detailsText = details ? Object.values(details).join("").trim() : "";
  if (!text && !detailsText) {
    return data({ error: "Empty feedback." }, { status: 400 });
  }

  const session = await getSession(request);

  await db.insert(feedback).values({
    id: crypto.randomUUID(),
    kind,
    title: str(body.title, 200),
    body: text,
    details: details ? JSON.stringify(details).slice(0, 5000) : null,
    url: str(body.url, 500),
    userAgent: str(request.headers.get("user-agent"), 500),
    metadata: body.metadata
      ? JSON.stringify(body.metadata).slice(0, 8000)
      : null,
    userId: session?.user.id ?? null,
    campId: session?.session.activeOrganizationId ?? null,
  });

  return data({ ok: true });
}
