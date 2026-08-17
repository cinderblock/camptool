import { backupArchive } from "~/lib/backup.server";
import { isSuperAdmin } from "~/lib/instance.server";
import { requireUser, resolveActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/export-db";

/**
 * Resource route: download a COMPLETE backup — the whole SQLite database plus
 * every uploaded picture — as a streamed `.tar.gz`.
 *
 * Super-admin only: it holds every camp's data, so it is the deployment
 * owner's backup, not a per-camp export. The database half is a `serialize()`
 * snapshot (WAL included), so it is safe to take while the app runs.
 *
 * This used to hand back the bare `.db` file, which made it a backup that lied
 * once pictures moved to disk: it carried their metadata and none of their
 * bytes. See plans/complete-backup.md.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) {
    throw new Response("Not authorized", { status: 403 });
  }
  // Raw database bytes cannot be pseudonymized in flight, so this is the one
  // surface privacy mode has to refuse outright rather than transform.
  const { privacyMode } = await resolveActiveCamp(request);
  if (privacyMode.on) {
    throw new Response(
      "Turn off privacy mode to download a backup — the backup contains real data and can't be pseudonymized.",
      { status: 409 },
    );
  }

  const { stream, filename } = await backupArchive(new Date().toISOString());
  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No Content-Length: the archive is gzipped as it streams, so its final
      // size isn't known until the last byte. Chunked is the honest answer.
      "Cache-Control": "no-store",
    },
  });
}
