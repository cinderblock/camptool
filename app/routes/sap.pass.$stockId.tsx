import { requireFeature } from "~/lib/features.server";
/**
 * Download one Setup Access Pass as its own single-page PDF
 * (see `plans/sap-import-and-distribution.md`).
 *
 * A resource route, outside the shell: it streams bytes, not markup. The page
 * is cut out of the vendor's order on demand — we store the order once and
 * never a per-person copy, so there is no stale file to go looking for and no
 * second place a pass can leak from.
 *
 * The gate is `visibleCodesFor`: released, and the viewer is the holder, their
 * party host, or an officer. A pass that is merely *assigned* is not
 * downloadable by anyone, which is the whole point of assignment being a
 * separate state.
 */
import {
  slicedPassPdf,
  stockWithCodes,
  visibleCodesFor,
} from "~/lib/sap.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/sap.pass.$stockId";

export async function loader({ params, request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "passes");

  // A non-null lens means privacy/demo mode is on. It exists so the app can be
  // shown to people who shouldn't see real data, and a pass PDF is real data of
  // the most consequential kind.
  if (privacy) {
    throw new Response("Not available in privacy mode", { status: 403 });
  }

  const [pass] = await stockWithCodes(activeEdition.id, [params.stockId]);
  // One 404 for "no such pass" and for "not yours": which of the two it is, is
  // itself information about someone else's pass.
  if (!pass || !visibleCodesFor(pass, active.membership)) {
    throw new Response("Not found", { status: 404 });
  }

  const pdf = await slicedPassPdf(active.camp.id, pass);
  const who = (
    pass.guestName ??
    pass.memberName ??
    pass.externalHolder ??
    "pass"
  ).replace(/[^A-Za-z0-9]+/g, "-");
  return new Response(
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="SAP-${who}-${pass.onOrAfterDate}.pdf"`,
        // Never let a shared cache hold a pass.
        "Cache-Control": "private, no-store",
      },
    },
  );
}
