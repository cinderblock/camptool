import { redirect } from "react-router";
import {
  canImpersonate,
  clearActAsCookie,
  getRealSession,
  setActAsCookie,
} from "~/lib/session.server";
import type { Route } from "./+types/impersonate";

/**
 * Resource route (no UI) that starts/stops "working as" another member.
 * Authorization always keys off the *real* session, never the effective one,
 * so an impersonated session can't be used to escalate.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "stop") {
    return redirect("/", {
      headers: { "Set-Cookie": clearActAsCookie() },
    });
  }

  if (intent === "start") {
    const real = await getRealSession(request);
    if (!real) throw redirect("/login");

    const targetUserId = String(form.get("targetUserId") ?? "");
    const campId = String(
      form.get("campId") || real.session.activeOrganizationId || "",
    );
    if (!targetUserId || !campId) return redirect("/");

    if (!(await canImpersonate(real.user.id, targetUserId, campId))) {
      return redirect("/");
    }
    return redirect("/", {
      headers: {
        "Set-Cookie": setActAsCookie({ userId: targetUserId, campId }),
      },
    });
  }

  return redirect("/");
}
