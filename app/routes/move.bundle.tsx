/**
 * The moving camp as one encrypted file (plans/camp-portability.md), for when
 * the new site can't reach this one. Only the camp's admin, only while the
 * move is open; the file opens only with the move code.
 */
import { data } from "react-router";
import { blobs } from "~/lib/blobs.server";
import { packBundle } from "~/lib/camp-move/bundle";
import {
  openMoveFor,
  signedBundle,
  unseal,
} from "~/lib/camp-move/move-out.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/move.bundle";

export async function loader({ request }: Route.LoaderArgs) {
  const { active, impersonatedBy } = await requireActiveCamp(request, {
    allowWhileMoving: true,
  });
  if (active.membership.role !== "admin" || impersonatedBy) {
    throw data("Not found", { status: 404 });
  }
  const move = await openMoveFor(active.camp.id);
  if (!move) throw data("Not found", { status: 404 });
  const b = await signedBundle(move);
  const files = new Map<string, Uint8Array>();
  for (const f of b.manifest.files) {
    const blob = await blobs.get(f.key);
    if (blob) files.set(f.key, await blob.bytes());
  }
  const bytes = await packBundle(
    {
      manifest: b.manifest,
      signature: b.signature,
      rows: new Map(Object.entries(b.rows)),
      files,
    },
    await unseal(move.secretSealed),
  );
  const name = `${active.camp.slug ?? "camp"}-${new Date().toISOString().slice(0, 10)}.camptool`;
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
