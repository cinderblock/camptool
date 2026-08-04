/**
 * Resource route for the privacy-mode toggle (see the header menu in
 * `routes/dashboard/layout.tsx` and `plans/privacy-and-demo-mode.md`).
 *
 * Admin-only. The check lives here AND in `resolveActiveCamp`, which re-derives
 * the mode from the role on every request — so a demoted admin's stale cookie
 * stops applying immediately rather than lingering until they clear it.
 */
import { data } from "react-router";
import { parsePrivacyMode } from "~/lib/privacy";
import { resolveActiveCamp, setPrivacyCookie } from "~/lib/session.server";
import type { Route } from "./+types/privacy";

export async function action({ request }: Route.ActionArgs) {
  // allowWrite: turning privacy OFF is itself a write, and the read-only guard
  // would otherwise trap you inside the mode with no way out.
  const { canUsePrivacy } = await resolveActiveCamp(request, {
    allowWrite: true,
  });
  if (!canUsePrivacy) {
    return data({ error: "Only camp admins can use privacy mode." }, 403);
  }

  const form = await request.formData();
  const mode = parsePrivacyMode(
    form.get("on") === "true"
      ? form.get("keepSelf") === "true"
        ? "on+self"
        : "on"
      : "off",
  );

  return data(
    { ok: true, mode },
    { headers: { "Set-Cookie": setPrivacyCookie(mode) } },
  );
}
