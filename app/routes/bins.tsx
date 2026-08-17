/**
 * /bins — hands the member off to the camp's bins instance, signed in.
 *
 * A resource route, never rendered: it exists so the top-bar menu item can be
 * a plain CampTool link while the bins access code stays server-side until the
 * moment of the click. The alternative — putting `…/join#code` straight in the
 * menu's href — would ship the camp's shared secret in the HTML of every single
 * page, to every session, forever.
 */
import { redirect } from "react-router";
import { binsEntryUrl, getBinsLink } from "~/lib/bins.server";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/bins";

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  await requireFeature(active, "bins");
  // Members and up. A recruit is an applicant the camp hasn't taken on yet;
  // handing them the warehouse access code is not the same call as letting
  // them read the camp's pages.
  if (!hasAtLeast(active.membership.role, "member")) throw redirect("/");

  const link = await getBinsLink(active.camp.id);
  // Configured by an admin at /settings; until then there is nowhere to go.
  if (!link?.baseUrl) throw redirect("/settings");

  return redirect(binsEntryUrl(link));
}
