/**
 * Arriving from a camp's old install, signed in (plans/camp-portability.md,
 * "Logins after a move"). The old install signed a token saying who this is;
 * if it checks out, they get a session here. Someone whose address belongs to
 * an existing account here goes to the claim page instead. Anything wrong
 * just lands on the login page, keeping `next`.
 */
import { redirect } from "react-router";
import { safeNext } from "~/lib/camp-host";
import { acceptHandoff } from "~/lib/camp-move/handoff.server";
import { APEX } from "~/lib/env.server";
import { sessionCookieFor } from "~/lib/legacy-host.server";
import type { Route } from "./+types/move-handoff";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"), APEX) ?? "/";
  const result = await acceptHandoff(
    url.searchParams.get("t") ?? "",
    APEX.origin,
  );
  if (!result.ok) return redirect(`/login?next=${encodeURIComponent(next)}`);
  if (result.outcome === "claim") {
    return redirect(
      `/move-claim?c=${encodeURIComponent(result.claim)}&next=${encodeURIComponent(next)}`,
    );
  }
  return redirect(next, {
    headers: { "Set-Cookie": await sessionCookieFor(result.userId) },
  });
}
