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
 *   GET  /api/move/:id/files?start=<n> → a tar of the camp's files from the
 *        n-th (in key order), up to ~16 MB or 200 files; `X-Next-Start` says
 *        where the next batch starts (absent at the end). Fewer requests than
 *        one per file, which matters under per-visitor rate limits.
 *   POST /api/move/:id/done    { targetOrigin, targetCampUrl } → { ok, windowEndsAt }
 */
import { data } from "react-router";
import { blobs } from "~/lib/blobs.server";
import { tar } from "~/lib/camp-move/bundle";
import { forgetMoves } from "~/lib/camp-move/forward.server";
import {
  authorizePull,
  completeMoveOut,
  findMoveOut,
  signedBundle,
} from "~/lib/camp-move/move-out.server";
import { APEX } from "~/lib/env.server";
import type { Route } from "./+types/api.move";

const notFound = () => data({ error: "Not found" }, { status: 404 });

const BATCH_BYTES = 16 * 1024 * 1024;
const BATCH_FILES = 200;

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
  if (what === "files") {
    const start = Number(new URL(request.url).searchParams.get("start") ?? 0);
    if (!Number.isInteger(start) || start < 0) return notFound();
    const all = (await blobs.list()).filter((f) =>
      f.key.startsWith(`${row.campId}/`),
    );
    const entries: [string, Uint8Array][] = [];
    let size = 0;
    let i = start;
    for (; i < all.length; i++) {
      const f = all[i] as { key: string; size: number };
      if (
        entries.length &&
        (size + f.size > BATCH_BYTES || entries.length >= BATCH_FILES)
      ) {
        break;
      }
      const blob = await blobs.get(f.key);
      if (!blob) continue;
      const bytes = await blob.bytes();
      entries.push([f.key, bytes]);
      size += bytes.length;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-tar",
      "Cache-Control": "no-store",
    };
    if (i < all.length) headers["X-Next-Start"] = String(i);
    return new Response(tar(entries) as BodyInit, { headers });
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
  const o = new URL(origin);
  const c = new URL(campUrl);
  const local = APEX.protocol === "http:";
  if (
    (o.protocol !== "https:" && !(local && o.protocol === "http:")) ||
    c.protocol !== o.protocol ||
    !(c.hostname === o.hostname || c.hostname.endsWith(`.${o.hostname}`))
  ) {
    return data({ error: "Bad target address." }, { status: 400 });
  }
  await completeMoveOut(row, { origin, campUrl });
  forgetMoves();
  const done = await findMoveOut(row.id);
  return data({
    ok: true,
    windowEndsAt: done?.windowEndsAt?.getTime() ?? null,
  });
}
