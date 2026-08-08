/**
 * Resource route: snooze the "set up a passkey" banner for 24 hours.
 *
 * Deliberately snooze-only — there is no "never show again". The persistent
 * reminder is the `passkey` ask (see `app/lib/asks.ts`), which is `required`
 * and so cannot be dismissed at all; this route only quiets the loud banner
 * until tomorrow.
 */
import { redirect } from "react-router";
import { requireUser, snoozePasskeyNagCookie } from "~/lib/session.server";
import type { Route } from "./+types/passkey-nag";

export async function action({ request }: Route.ActionArgs) {
  // Requiring a session keeps this from being a drive-by cookie setter, and
  // matches every other mutation in the app.
  await requireUser(request);

  const form = await request.formData();
  // Come back to wherever the banner was dismissed from. Relative paths only,
  // so this can't be turned into an open redirect.
  const raw = String(form.get("returnTo") ?? "/");
  const returnTo = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";

  return redirect(returnTo, {
    headers: { "Set-Cookie": snoozePasskeyNagCookie() },
  });
}
