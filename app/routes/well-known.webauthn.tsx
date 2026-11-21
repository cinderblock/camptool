/**
 * WebAuthn Related Origin Requests (plans/camp-portability.md, "Logins after
 * a move"): the sites this site's passkeys may also be used on. A camp that
 * moved away lists its new home here for the move's window, so its people's
 * passkeys from here sign them in there directly (Chrome/Edge 128+, Safari
 * 18+; other browsers use the sign-in bridge).
 */
import { data } from "react-router";
import { relatedOrigins } from "~/lib/camp-move/forward.server";

export async function loader() {
  const origins = await relatedOrigins();
  if (!origins.length) throw data("Not found", { status: 404 });
  return Response.json(
    { origins },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
