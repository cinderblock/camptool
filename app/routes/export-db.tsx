import { isSuperAdmin } from "~/lib/instance.server";
import { requireUser } from "~/lib/session.server";
import { sqlite } from "../../db/client.server";
import type { Route } from "./+types/export-db";

/**
 * Resource route: download a consistent snapshot of the whole SQLite database as
 * a `.db` file backup. Super-admin only — the file holds EVERY camp's data, so
 * it's the deployment owner's backup, not a per-camp export. `serialize()` gives
 * a point-in-time copy (WAL included), so it's safe to take while the app runs.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  if (!(await isSuperAdmin(session.user.id))) {
    throw new Response("Not authorized", { status: 403 });
  }
  // Copy into a plain Uint8Array (a valid Response body; Buffer's typing isn't).
  const bytes = new Uint8Array(sqlite.serialize());
  const date = new Date().toISOString().slice(0, 10);
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/x-sqlite3",
      "Content-Disposition": `attachment; filename="camptool-backup-${date}.db"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
