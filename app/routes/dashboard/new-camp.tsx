/**
 * Make another camp, for someone who's already in one. (Someone in no camp
 * gets the same form on the home page.) Linked from the account menu.
 */
import { data } from "react-router";
import { CreateCampForm } from "~/components/CreateCampForm";
import { APEX, CAMP_SUBDOMAINS } from "~/lib/env.server";
import { getInstanceSettings, isSuperAdmin } from "~/lib/instance.server";
import { requireUser } from "~/lib/session.server";
import type { Route } from "./+types/new-camp";

export function meta(_: Route.MetaArgs) {
  return [{ title: "New camp · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireUser(request);
  const allowed =
    (await isSuperAdmin(user.id)) ||
    (await getInstanceSettings()).allowCampCreation;
  if (!allowed) {
    throw data("New camp creation is turned off on this site.", {
      status: 403,
    });
  }
  // On a camp's subdomain, "/" is still that camp. The apex sends the browser
  // on to whichever camp the session has active: the new one, by then.
  return { doneUrl: CAMP_SUBDOMAINS ? `${APEX.origin}/` : "/" };
}

export default function NewCamp({ loaderData }: Route.ComponentProps) {
  return <CreateCampForm doneUrl={loaderData.doneUrl} firstCamp={false} />;
}
