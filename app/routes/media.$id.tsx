/**
 * Serve an uploaded picture at display size (see plans/pictures-in-bodies.md).
 *
 * A resource route, not a static path: pictures are camp data, and CampTool is
 * private-first. Anonymous requests bounce to login like any other route, and
 * an id belonging to another camp 404s.
 */
import { serveImage } from "~/lib/images.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/media.$id";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  return serveImage(active.camp.id, params.id, "display");
}
