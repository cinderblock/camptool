/**
 * The pull API a camp's new install uses to fetch it from this one
 * (plans/camp-portability.md, "Pull API"). Server to server, JSON. Every
 * answer but `key` needs the move code's bearer (`Authorization: Bearer
 * <sha256 of its secret>`); anything wrong is a bare 404, so the API says
 * nothing about which moves exist.
 *
 *   GET  /api/move/:id/key     → { publicKey }
 *   GET  /api/move/:id/bundle  → { manifest, signature, rows }
 *   GET  /api/move/:id/file?key=<blob key> → the bytes
 *   POST /api/move/:id/done    { targetOrigin, targetCampUrl } → { ok, windowEndsAt }
 */
import { data } from "react-router";
import { blobs } from "~/lib/blobs.server";
import { forgetMoves } from "~/lib/camp-move/forward.server";
import {
  authorizePull,
  completeMoveOut,
  findMoveOut,
  signedBundle,
} from "~/lib/camp-move/move-out.server";
import type { Route } from "./+types/api.move";

const notFound = () => data({ error: "Not found" }, { status: 404 });

const bearer = (request: Request) =>
  request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? null;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { id, what } = params;
  if (what === "key") {
    const row = await findMoveOut(id);
    if (!row || (row.state !== "open" && row.state !== "done")) {
      return notFound();
    }
    return data({ publicKey: row.publicKey });
  }
  const row = await authorizePull(id, bearer(request));
  if (!row?.campId) return notFound();
  if (what === "bundle") {
    const b = await signedBundle(row);
    return data(
      { manifest: b.manifest, signature: b.signature, rows: b.rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (what === "file") {
    const key = new URL(request.url).searchParams.get("key") ?? "";
    if (!key.startsWith(`${row.campId}/`) || key.includes("..")) {
      return notFound();
    }
    const blob = await blobs.get(key);
    if (!blob) return notFound();
    return new Response(blob.stream(), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(blob.size),
        "Cache-Control": "no-store",
      },
    });
  }
  return notFound();
}

export async function action({ request, params }: Route.ActionArgs) {
  if (params.what !== "done" || request.method !== "POST") return notFound();
  const row = await authorizePull(params.id, bearer(request));
  if (!row) return notFound();
  const body = (await request.json().catch(() => ({}))) as {
    targetOrigin?: string;
    targetCampUrl?: string;
  };
  let origin: string;
  let campUrl: string;
  try {
    origin = new URL(String(body.targetOrigin)).origin;
    campUrl = new URL(String(body.targetCampUrl)).href;
  } catch {
    return data(
      { error: "Give targetOrigin and targetCampUrl." },
      { status: 400 },
    );
  }
  if (!/^https?:$/.test(new URL(origin).protocol)) {
    return data({ error: "Bad origin." }, { status: 400 });
  }
  await completeMoveOut(row, { origin, campUrl });
  forgetMoves();
  const done = await findMoveOut(row.id);
  return data({
    ok: true,
    windowEndsAt: done?.windowEndsAt?.getTime() ?? null,
  });
}
