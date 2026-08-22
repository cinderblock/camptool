/**
 * Download several passes as ONE sheet — the travel-group page
 * (see `plans/sap-import-and-distribution.md`).
 *
 * `/sap/group?ids=<id>,<id>,…`
 *
 * Addressed by explicit pass ids rather than by party, so one code path serves
 * both cases the camp actually has: a household downloading its own sheet, and
 * an officer building an ad-hoc set for people sharing a vehicle but not a
 * party. Authorization is per id — every pass must independently pass
 * `visibleCodesFor` for this viewer — so an id list is not a way to reach
 * anything a viewer couldn't already open one at a time.
 *
 * Silently dropping unauthorized ids would hand someone a sheet that's quietly
 * missing a pass they're about to drive to the gate with, so a bad id is an
 * error instead.
 */
import { requireFeature } from "~/lib/features.server";
import { type SheetPass, renderGroupSheet } from "~/lib/sap-render.server";
import { stockWithCodes, visibleCodesFor } from "~/lib/sap.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/sap.group";

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "passes");
  // A non-null lens means privacy/demo mode is on. It exists so the app can be
  // shown to people who shouldn't see real data, and a pass PDF is real data of
  // the most consequential kind.
  if (privacy) {
    throw new Response("Not available in privacy mode", { status: 403 });
  }

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Response("No passes requested", { status: 400 });
  }
  // A sheet is for a group that travels together; past a couple of pages it is
  // not that, and it's worth failing rather than rendering forever.
  if (ids.length > 40) {
    throw new Response("Too many passes for one sheet", { status: 400 });
  }

  const rows = await stockWithCodes(activeEdition.id, ids);
  const allowed = rows.filter((r) => visibleCodesFor(r, active.membership));
  if (allowed.length !== ids.length) {
    throw new Response("Not found", { status: 404 });
  }

  // Keep the caller's order: the UI lists a household in a deliberate order and
  // the sheet should match what they just looked at.
  const byId = new Map(allowed.map((r) => [r.id, r]));
  const passes: SheetPass[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    passes.push({
      holderName: r.guestName ?? r.memberName ?? "Unassigned",
      onOrAfterDate: r.onOrAfterDate,
      scanCode: r.scanCode,
      securityCode: r.securityCode,
      vendorTicketId: r.vendorTicketId,
    });
  }

  const pdf = await renderGroupSheet({
    groupLabel: groupLabel(allowed),
    year: activeEdition.year,
    passes,
  });
  return new Response(
    new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
    {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="SAPs-${activeEdition.year}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    },
  );
}

/**
 * Name the sheet after the party when they all share one, because the sheet's
 * job is to be the single piece of paper a group carries — and a stack of
 * identically-titled sheets is the problem it set out to solve.
 */
function groupLabel(
  rows: {
    hostMembershipId: string | null;
    memberName: string | null;
    guestName: string | null;
  }[],
): string {
  const hosts = new Set(rows.map((r) => r.hostMembershipId ?? "—"));
  if (rows.length === 1) {
    const only = rows[0];
    return only?.guestName ?? only?.memberName ?? "Setup Access Passes";
  }
  if (hosts.size === 1 && !hosts.has("—")) {
    // Everyone here is hosted by the same person; that person is usually in the
    // set too, and their own row is the one with no host.
    const host = rows.find((r) => r.hostMembershipId === null);
    const name = host?.memberName ?? host?.guestName;
    if (name) return `${name}'s party`;
  }
  return "Travelling together";
}
