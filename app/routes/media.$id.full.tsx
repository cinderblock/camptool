/**
 * Serve the FULL-RESOLUTION original of an uploaded picture.
 *
 * Originals are kept deliberately (plans/pictures-in-bodies.md, decision 2) —
 * this is the route that makes keeping them worth anything. Every rendered
 * picture links here.
 */
import { serveImage } from "~/lib/images.server";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/media.$id.full";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  return serveImage(active.camp.id, params.id, "full");
}
