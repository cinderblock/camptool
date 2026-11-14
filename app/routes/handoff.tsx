/**
 * Resource route on the apex: turn a one-time hand-off code from a camp's old
 * address into a session here, then go on to `next`
 * (app/lib/legacy-host.server.ts). A bad or spent code just goes to the login
 * page, keeping `next`.
 */
import { redirect } from "react-router";
import { safeNext } from "~/lib/camp-host";
import { APEX } from "~/lib/env.server";
import { consumeHandoff, sessionCookieFor } from "~/lib/legacy-host.server";
import type { Route } from "./+types/handoff";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), APEX) ?? "/";
  const userId = await consumeHandoff(url.searchParams.get("code") ?? "");
  if (!userId) {
    return redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return redirect(next, {
    headers: { "Set-Cookie": await sessionCookieFor(userId) },
  });
}
