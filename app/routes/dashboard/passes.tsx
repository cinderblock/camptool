import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  FileInput,
  Group,
  List,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import dayjs from "dayjs";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { BurningManDisclaimer } from "~/components/BurningManDisclaimer";
import { needsSetupPass } from "~/lib/age";
import { ensureMemberAttendee } from "~/lib/attendee.server";
import { eventStartIso } from "~/lib/brc";
import { featureName, isBurningMan } from "~/lib/events";
import { requireFeature } from "~/lib/features.server";
import { canManageAttendee, inMyParty, isMe } from "~/lib/party";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  SapImportError,
  SapStateError,
  assignStock,
  earlyArrivalsWithoutStock,
  importSapPdf,
  releaseStock,
  sapCoverage,
  stockForEdition,
  stockWithCodes,
  unassignStock,
  visibleCodesFor,
  voidStock,
} from "~/lib/sap.server";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { attendee, membership, setupPass, user } from "../../../db/schema";
import type { Route } from "./+types/passes";

/** A camp's whole SAP order in one PDF: 26 passes came to ~2MB in 2024, so
 * this is generous without letting an accidental upload of something else tie
 * up the parser. */
const MAX_SAP_PDF_BYTES = 60 * 1024 * 1024;

/** Metadata only — it names the stored document in the UI and never becomes
 * part of a path (the file is stored under the camp id and a uuid). */
function cleanPdfName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base.replace(/\s+/g, " ").trim().slice(0, 120) || "passes.pdf";
}

export function meta({ data }: Route.MetaArgs) {
  // Match the nav, which the event names — a tab reading "Passes" while the
  // sidebar says "Setup Access Passes" is a small translation tax on every
  // glance.
  return [
    { title: `${featureName("passes", data?.event, "Passes")} · CampTool` },
  ];
}

type PassRow = {
  id: string;
  // NULL while a request is unbound — the officer picks the "on or after"
  // date row at grant time.
  passDateId: string | null;
  attendeeId: string | null;
  // The holder as a grant-picker ref: `m:<membershipId>` | `a:<attendeeId>`.
  holderRef: string | null;
  holderName: string | null;
  holderIsGuest: boolean;
  // The holder is in the viewer's party — their own row, or anyone they host.
  mine: boolean;
  // The holder IS the viewer, not merely someone they host. Requesting a pass
  // is a statement about your own arrival, so that form keys off this.
  isSelf: boolean;
  status: string;
  note: string | null;
};
type GrantGroup = { group: string; items: { value: string; label: string }[] };
/** The coverage summary as it arrives in the browser (null for non-officers). */
type CoverageData = Awaited<ReturnType<typeof sapCoverage>> | null;
/** Someone who still needs a pass — because of their arrival date, because
 * they asked, or both. */
type NeedRow = {
  attendeeId: string;
  ref: string;
  name: string;
  /** Whose guest they are — a bare first name is not identifiable in a camp
   * with a dozen of them. NULL for members. */
  hostName: string | null;
  arrivalDate: string | null;
  /** They explicitly requested one, as opposed to us inferring it. */
  asked: boolean;
  /** The request row, when there is one — only an ask can be declined. */
  requestId: string | null;
  note: string | null;
};
/** An imported pass. Never carries codes — those travel separately, only for
 * released passes the viewer is entitled to, in `myCodes`. */
type StockRow = {
  id: string;
  onOrAfterDate: string;
  vendorTicketId: string;
  status: string;
  voidReason: string | null;
  holderName: string | null;
  holderIsGuest: boolean;
  /** Whose guest, when the holder is one. */
  hostName: string | null;
  holderRef: string | null;
  assignedAttendeeId: string | null;
  /** In the viewer's party — their own, or anyone they host. */
  mine: boolean;
  /** The holder IS the viewer. Asking for a pass is a statement about your own
   * arrival, so the request form keys off this — a host holding a pass for a
   * guest must still be able to ask for one of their own. */
  isSelf: boolean;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "passes");
  const editionId = activeEdition.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const myMembershipId = active.membership.id;
  const rawPasses = await db
    .select({
      id: setupPass.id,
      passDateId: setupPass.passDateId,
      attendeeId: setupPass.attendeeId,
      attMembershipId: attendee.membershipId,
      attHostId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      status: setupPass.status,
      note: setupPass.note,
    })
    .from(setupPass)
    .leftJoin(attendee, eq(setupPass.attendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(setupPass.editionId, editionId));
  const passes: PassRow[] = rawPasses.map((p) => ({
    id: p.id,
    passDateId: p.passDateId,
    attendeeId: p.attendeeId,
    holderRef: p.attMembershipId
      ? `m:${p.attMembershipId}`
      : p.attendeeId
        ? `a:${p.attendeeId}`
        : null,
    holderName: p.guestName ?? p.memberName ?? null,
    holderIsGuest: p.attendeeId != null && p.attMembershipId == null,
    mine: inMyParty(
      { membershipId: p.attMembershipId, hostMembershipId: p.attHostId },
      myMembershipId,
    ),
    // Whether this pass is *personally* mine, as opposed to my party's — the
    // request form keys off this, since a pass request is a statement about
    // one's own arrival.
    isSelf: isMe({ membershipId: p.attMembershipId }, myMembershipId),
    status: p.status,
    note: p.note,
  }));

  // Officer grant Select: camp members (m:) + all guests (a:), grouped.
  let grantGroups: GrantGroup[] = [];
  if (isOfficer) {
    const memberRows = (
      await db
        .select({ id: membership.id, name: user.name })
        .from(membership)
        .innerJoin(user, eq(membership.userId, user.id))
        .where(eq(membership.organizationId, active.camp.id))
    ).sort((a, b) => a.name.localeCompare(b.name));
    // A GUEST is `membership_id IS NULL` — "has a host" is not the same test,
    // because a party-linked MEMBER also has one. Using the host column alone
    // listed those members twice: once under Campers and again under Guests.
    const guestRows = await db
      .select({
        id: attendee.id,
        name: attendee.name,
        arrivalDate: attendee.arrivalDate,
        ageBand: attendee.ageBand,
        hostName: user.name,
      })
      .from(attendee)
      .leftJoin(membership, eq(attendee.hostMembershipId, membership.id))
      .leftJoin(user, eq(membership.userId, user.id))
      .where(
        and(
          eq(attendee.editionId, editionId),
          isNull(attendee.membershipId),
          isNotNull(attendee.hostMembershipId),
        ),
      );
    grantGroups = [
      {
        group: "Campers",
        items: memberRows.map((m) => ({ value: `m:${m.id}`, label: m.name })),
      },
      ...(guestRows.length > 0
        ? [
            {
              group: "Guests",
              items: guestRows
                // Under-13s are admitted free and need no pass, so they are not
                // offered here — the note under the picker says so, because a
                // silently missing name reads as a bug.
                .filter((g) => needsSetupPass(g.ageBand))
                .map((g) => {
                  // Whose guest, and when they arrive. A list of bare first
                  // names is unusable once a camp has a dozen of them, and the
                  // arrival is what decides which pass covers them.
                  const whose = g.hostName
                    ? ` — guest of ${g.hostName}`
                    : " (guest)";
                  const when = g.arrivalDate
                    ? ` · arrives ${dayjs(g.arrivalDate).format("MMM D")}`
                    : "";
                  return {
                    value: `a:${g.id}`,
                    label: `${g.name ?? "Guest"}${whose}${when}`,
                  };
                })
                .sort((a, b) => a.label.localeCompare(b.label)),
            },
          ]
        : []),
    ];
  }

  // Planned arrivals (from onboarding) — shown next to requests so officers can
  // pick a pass date that covers the holder's arrival. Keyed by attendee id.
  const arrivalRows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      arrivalDate: attendee.arrivalDate,
    })
    .from(attendee)
    .where(eq(attendee.editionId, editionId));
  const arrivals: Record<string, string> = {};
  let myArrival: string | null = null;
  for (const r of arrivalRows) {
    if (r.arrivalDate) arrivals[r.id] = r.arrivalDate;
    if (r.membershipId === myMembershipId) myArrival = r.arrivalDate ?? null;
  }

  // --- imported pass stock ----------------------------------------------
  // Two different reads, because they answer two different questions and only
  // one of them is allowed to carry secrets.
  const rawStock = await stockForEdition(editionId);
  const stock: StockRow[] = rawStock.map((s) => ({
    id: s.id,
    onOrAfterDate: s.onOrAfterDate,
    vendorTicketId: s.vendorTicketId,
    status: s.status,
    voidReason: s.voidReason,
    assignedAttendeeId: s.assignedAttendeeId,
    holderName: s.guestName ?? s.memberName ?? null,
    holderIsGuest:
      s.assignedAttendeeId != null && s.attendeeMembershipId == null,
    hostName: s.attendeeMembershipId ? null : (s.hostName ?? null),
    holderRef: s.attendeeMembershipId
      ? `m:${s.attendeeMembershipId}`
      : s.assignedAttendeeId
        ? `a:${s.assignedAttendeeId}`
        : null,
    mine: inMyParty(
      {
        membershipId: s.attendeeMembershipId,
        hostMembershipId: s.attendeeHostId,
      },
      myMembershipId,
    ),
    isSelf: isMe({ membershipId: s.attendeeMembershipId }, myMembershipId),
  }));

  // Codes for MY party's released passes only. Everyone else's stay on the
  // server: a code in a loader payload is a code in the browser, in the page
  // source, and in any screenshot.
  const mineIds = stock.filter((s) => s.mine).map((s) => s.id);
  const myCodes: Record<string, { scanCode: string; securityCode: string }> =
    {};
  for (const row of await stockWithCodes(editionId, mineIds)) {
    if (!visibleCodesFor(row, active.membership)) continue;
    myCodes[row.id] = {
      scanCode: row.scanCode,
      securityCode: row.securityCode,
    };
  }

  // Who still needs a pass? Two ways to land here, one list:
  //   - they set an arrival before gates open (the app worked it out), or
  //   - they asked for one outright (plans changed, or they want to help build
  //     without having said so on the calendar).
  // Anyone already holding a live pass is served and drops off.
  const gateOpen = eventStartIso(activeEdition.year);
  const needsPass: NeedRow[] = [];
  if (isOfficer) {
    const held = new Set(
      stock
        .filter((s) => s.status !== "void")
        .map((s) => s.assignedAttendeeId)
        .filter(Boolean),
    );
    const seen = new Set<string>();
    for (const r of await earlyArrivalsWithoutStock(editionId, gateOpen)) {
      seen.add(r.id);
      needsPass.push({
        attendeeId: r.id,
        ref: r.membershipId ? `m:${r.membershipId}` : `a:${r.id}`,
        name: r.guestName ?? r.memberName ?? "Unknown",
        hostName: r.membershipId ? null : (r.hostName ?? null),
        arrivalDate: r.arrivalDate,
        asked: false,
        requestId: null,
        note: null,
      });
    }
    // Requests from people the arrival date didn't catch.
    for (const p of passes) {
      if (p.status !== "requested" || !p.attendeeId) continue;
      if (held.has(p.attendeeId)) continue;
      const already = needsPass.find((n) => n.attendeeId === p.attendeeId);
      if (already) {
        already.asked = true;
        already.requestId = p.id;
        already.note = p.note;
        continue;
      }
      if (seen.has(p.attendeeId)) continue;
      needsPass.push({
        attendeeId: p.attendeeId,
        ref: p.holderRef ?? `a:${p.attendeeId}`,
        name: p.holderName ?? "Unknown",
        hostName: null,
        arrivalDate: arrivals[p.attendeeId] ?? null,
        asked: true,
        requestId: p.id,
        note: p.note,
      });
    }
    needsPass.sort((a, b) =>
      (a.arrivalDate ?? "9999").localeCompare(b.arrivalDate ?? "9999"),
    );
  }

  const coverage = isOfficer ? await sapCoverage(editionId, gateOpen) : null;

  return redact(privacy, {
    isOfficer,
    locked: activeEdition.locked,
    event: activeEdition.event,
    myMembershipId,
    myArrival,
    year: activeEdition.year,
    passes,
    grantGroups,
    arrivals: isOfficer ? arrivals : {},
    stock,
    myCodes,
    needsPass,
    coverage,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  await requireFeature(active, "passes");
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const myMid = active.membership.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (k: string) => {
    const v = form.get(k);
    return v == null || v === "" ? null : String(v);
  };

  // Does this attendee already hold an active (requested or granted) pass this
  // year? One pass per person — requests are unbound (no date) until granted.
  async function activePassFor(attendeeId: string) {
    const rows = await db
      .select({ id: setupPass.id, status: setupPass.status })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.editionId, editionId),
          eq(setupPass.attendeeId, attendeeId),
        ),
      );
    return rows.find((r) => r.status !== "denied") ?? null;
  }

  // --- Member self-service (any role) -------------------------------------
  // A member requests a pass for themselves; officers grant guest passes
  // directly (guests appear in the officer grant picker).
  if (intent === "requestPass") {
    const myAttendeeId = await ensureMemberAttendee(campId, editionId, myMid);
    if (await activePassFor(myAttendeeId)) {
      return data(
        { error: "You already have a pass or a pending request." },
        { status: 409 },
      );
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      attendeeId: myAttendeeId,
      status: "requested",
      note: str("note"),
      createdById: actor.id,
    });
    return data({ ok: "Request sent." });
  }

  if (intent === "cancelPass") {
    // A party host may cancel for their household; an officer for anyone.
    const passId = String(form.get("id"));
    const [row] = await db
      .select({
        membershipId: attendee.membershipId,
        hostMembershipId: attendee.hostMembershipId,
      })
      .from(setupPass)
      .leftJoin(attendee, eq(setupPass.attendeeId, attendee.id))
      .where(and(eq(setupPass.id, passId), eq(setupPass.editionId, editionId)))
      .limit(1);
    // Previously this reported "Request cancelled." even when the check failed,
    // so a mis-scoped cancel looked like it worked. Say what happened.
    if (!row || !canManageAttendee(row, active.membership)) {
      return data({ error: "Not your pass." }, { status: 403 });
    }
    await db
      .delete(setupPass)
      .where(and(eq(setupPass.id, passId), eq(setupPass.status, "requested")));
    return data({ ok: "Request cancelled." });
  }

  // --- Officer-only -------------------------------------------------------
  if (!isOfficer) {
    return data({ error: "Officers only." }, { status: 403 });
  }

  // --- imported pass stock ------------------------------------------------
  const stockActor = { membershipId: myMid, name: actor.name ?? null };

  if (intent === "importPasses") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return data({ error: "No file came through." }, { status: 400 });
    }
    if (file.size > MAX_SAP_PDF_BYTES) {
      return data(
        { error: `That file is over ${MAX_SAP_PDF_BYTES / 1024 / 1024} MB.` },
        { status: 413 },
      );
    }
    try {
      const outcome = await importSapPdf({
        campId,
        editionId,
        year: activeEdition.year,
        filename: cleanPdfName(file.name),
        bytes: new Uint8Array(await file.arrayBuffer()),
        userId: actor.id,
        actorMembershipId: myMid,
        actorName: actor.name ?? null,
      });
      const shape = Object.entries(outcome.byDate)
        .map(([d, n]) => `${d} ×${n}`)
        .join(", ");
      const parts = [`Imported ${outcome.imported} pass(es).`];
      if (outcome.alreadyKnown > 0) {
        parts.push(`${outcome.alreadyKnown} already in stock.`);
      }
      if (outcome.skipped.length > 0) {
        const where = outcome.skipped.map((sk) => `p${sk.page}`).join(", ");
        parts.push(`${outcome.skipped.length} page(s) unreadable: ${where}`);
      }
      if (shape) parts.push(`Now holding ${shape}.`);
      return data({ ok: parts.join(" ") });
    } catch (e) {
      if (e instanceof SapImportError) {
        return data({ error: e.message }, { status: 400 });
      }
      throw e;
    }
  }

  // The four transitions. Each maps a SapStateError onto a 409 with the
  // module's own wording — those messages explain WHY a move isn't allowed
  // ("the codes have already gone out"), which is the part worth showing.
  const stockIntents: Record<string, () => Promise<unknown>> = {
    assignStock: async () => {
      const ref = str("granteeRef");
      if (!ref) throw new SapStateError("Pick someone.");
      const attendeeId = await resolveAttendee(ref);
      return assignStock(
        editionId,
        String(form.get("id")),
        attendeeId,
        stockActor,
      );
    },
    unassignStock: () =>
      unassignStock(editionId, String(form.get("id")), stockActor),
    releaseStock: () =>
      releaseStock(editionId, String(form.get("id")), stockActor),
    voidStock: () =>
      voidStock(
        editionId,
        String(form.get("id")),
        str("reason") ?? "",
        stockActor,
      ),
  };

  const run = stockIntents[intent];
  if (run) {
    if (
      intent === "voidStock" &&
      !hasAtLeast(active.membership.role, "admin")
    ) {
      return data({ error: "Only an admin can void a pass." }, { status: 403 });
    }
    try {
      await run();
    } catch (e) {
      if (e instanceof SapStateError) {
        return data({ error: e.message }, { status: 409 });
      }
      throw e;
    }
    const done: Record<string, string> = {
      assignStock:
        "Pass set aside. The codes stay hidden until you release it.",
      unassignStock: "Pass returned to the pool.",
      releaseStock: "Released — the codes are now visible to them.",
      voidStock: "Pass voided. It has NOT gone back into the pool.",
    };
    return data({ ok: done[intent] ?? "Done." });
  }

  /** `m:<membershipId>` (a member) or `a:<attendeeId>` (a guest) → attendee id. */
  async function resolveAttendee(ref: string): Promise<string> {
    if (ref.startsWith("m:")) {
      const targetMid = ref.slice(2);
      const [tm] = await db
        .select({ id: membership.id })
        .from(membership)
        .where(
          and(
            eq(membership.id, targetMid),
            eq(membership.organizationId, campId),
          ),
        )
        .limit(1);
      if (!tm) throw new SapStateError("Unknown member.");
      return ensureMemberAttendee(campId, editionId, targetMid);
    }
    const aid = ref.slice(2);
    const [g] = await db
      .select({ id: attendee.id })
      .from(attendee)
      .where(
        and(
          eq(attendee.id, aid),
          eq(attendee.campId, campId),
          eq(attendee.editionId, editionId),
        ),
      )
      .limit(1);
    if (!g) throw new SapStateError("Unknown guest.");
    return aid;
  }

  if (intent === "denyPass") {
    await db
      .update(setupPass)
      .set({
        status: "denied",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(setupPass.id, String(form.get("id"))),
          eq(setupPass.editionId, editionId),
        ),
      );
    return data({ ok: "Request denied." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

const STATUS_COLOR: Record<string, string> = {
  requested: "yellow",
  granted: "green",
  denied: "gray",
};

type FetcherData = { ok?: string; error?: string };

export default function Passes({ loaderData }: Route.ComponentProps) {
  const {
    isOfficer,
    locked,
    event,
    myMembershipId,
    myArrival,
    year,
    passes,
    grantGroups,
    stock,
    myCodes,
    needsPass,
    coverage,
  } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);

  const myStock = stock.filter((s) => s.mine && s.status !== "void");
  // Self, not party: a host holding a pass for a guest still needs to be able
  // to ask for their own.
  const myOwnStock = myStock.filter((s) => s.isSelf);
  const liveStock = stock.filter((s) => s.status !== "void");
  const voidStockRows = stock.filter((s) => s.status === "void");

  // "mine" = my whole party. The request form is self-only, so it keys off
  // `isSelf` — my own pass, not one belonging to someone I host.
  // A granted request is a pass, and the pass card renders it; showing it here
  // too would be the second ledger all over again.
  const myOpenRequests = passes.filter((p) => p.mine && p.status !== "granted");
  const myOwnActive = passes.find((p) => p.isSelf && p.status !== "denied");
  const pending = passes.filter((p) => p.status === "requested");

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Setup access passes</Title>
          <Text c="dimmed" size="sm">
            Early-arrival passes the camp allocates. Each pass admits you on or
            after its date — an earlier-dated pass covers a later arrival.
          </Text>
        </div>

        {locked ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Text size="sm" c="dimmed">
              This year is locked — passes are read-only. Switch to an open year
              to make changes.
            </Text>
          </Paper>
        ) : null}

        {/* ----- Member self-service: the ASK ----- */}
        {/* Granted requests aren't shown here — a granted request IS a pass,
            and the card below shows the pass itself. Leaving both would be the
            two-ledger confusion this screen just got rid of. */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="sm">
            <Text fw={600}>Early arrival</Text>
            {myOpenRequests.length > 0 ? (
              <Stack gap="xs">
                {myOpenRequests.map((p) => (
                  <Group key={p.id} gap="xs">
                    {p.holderIsGuest ? (
                      <Text size="sm" fw={500}>
                        {p.holderName ?? "Guest"}
                        <Text span c="dimmed" size="xs">
                          {" "}
                          (guest)
                        </Text>
                      </Text>
                    ) : null}
                    <Badge
                      size="lg"
                      variant="light"
                      color={STATUS_COLOR[p.status] ?? "gray"}
                    >
                      {p.status === "requested"
                        ? "Asked for a pass — an officer will set one aside"
                        : "Not granted"}
                    </Badge>
                    {!locked && p.status === "requested" ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "cancelPass", id: p.id },
                            { method: "post" },
                          )
                        }
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </Group>
                ))}
              </Stack>
            ) : myOwnStock.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nothing set aside for you yet.
              </Text>
            ) : null}

            {!locked && !myOwnActive && myOwnStock.length === 0 ? (
              <RequestPassForm fetcher={fetcher} myArrival={myArrival} />
            ) : null}
          </Stack>
        </Card>

        {/* ----- The actual passes, once they exist ----- */}
        {myStock.length > 0 ? (
          <MyStockCard stock={myStock} codes={myCodes} />
        ) : null}

        {/* ----- Officer management ----- */}
        {isOfficer ? (
          <>
            <CoverageCard coverage={coverage} />
            {needsPass.length > 0 ? (
              <NeedsPassCard
                people={needsPass}
                stock={liveStock}
                fetcher={fetcher}
                locked={locked}
              />
            ) : null}
            <StockCard
              stock={liveStock}
              voided={voidStockRows}
              grantGroups={grantGroups}
              fetcher={fetcher}
              locked={locked}
            />
            {locked ? null : <ImportCard fetcher={fetcher} year={year} />}
          </>
        ) : null}

        {isBurningMan(event) ? <BurningManDisclaimer /> : null}
      </Stack>
    </Container>
  );
}

/**
 * The camper's own passes, once real ones exist.
 *
 * Two states, and the difference between them is the whole feature. **Set
 * aside** shows the date and nothing else — no codes, no download, because
 * they haven't been handed over yet. **Released** shows the codes and both
 * PDFs. Nobody sees a code here who isn't entitled to it: the loader only ever
 * put released, in-my-party codes into `myCodes`.
 */
function MyStockCard({
  stock,
  codes,
}: {
  stock: StockRow[];
  codes: Record<string, { scanCode: string; securityCode: string }>;
}) {
  const released = stock.filter((s) => s.status === "released");
  const groupHref =
    released.length > 1
      ? `/sap/group?ids=${released.map((s) => s.id).join(",")}`
      : null;

  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Text fw={600}>Your setup access passes</Text>
          {groupHref ? (
            // The point of the whole sheet: one page for people arriving in one
            // vehicle, instead of a stack to shuffle through at the gate.
            <Button
              size="xs"
              variant="light"
              component="a"
              href={groupHref}
              download
            >
              All {released.length} on one page (PDF)
            </Button>
          ) : null}
        </Group>

        {stock.map((s) => {
          const code = codes[s.id];
          return (
            <Paper key={s.id} withBorder p="sm" radius="sm">
              <Group justify="space-between" wrap="wrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      {s.holderName ?? "You"}
                      {s.holderIsGuest ? (
                        <Text span c="dimmed" size="xs">
                          {" "}
                          (guest)
                        </Text>
                      ) : null}
                    </Text>
                    <Badge
                      size="sm"
                      variant="light"
                      color={s.status === "released" ? "green" : "blue"}
                    >
                      {s.status === "released" ? "ready" : "set aside"}
                    </Badge>
                  </Group>
                  <Text size="sm">
                    Admits on or after{" "}
                    <b>{dayjs(s.onOrAfterDate).format("ddd, MMM D")}</b>
                  </Text>

                  {code ? (
                    <Stack gap={2} mt={6}>
                      <Text size="sm" ff="monospace">
                        Scan code: {code.scanCode}
                      </Text>
                      <Text size="xs" ff="monospace" c="dimmed">
                        Security: {code.securityCode}
                      </Text>
                    </Stack>
                  ) : (
                    <Text size="xs" c="dimmed" mt={6}>
                      An officer is holding this for you. The codes appear here
                      once it's released to you.
                    </Text>
                  )}
                </div>

                {code ? (
                  <Button
                    size="xs"
                    variant="light"
                    component="a"
                    href={`/sap/pass/${s.id}`}
                    download
                  >
                    Download pass (PDF)
                  </Button>
                ) : null}
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </Card>
  );
}

function RequestPassForm({
  fetcher,
  myArrival,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  myArrival: string | null;
}) {
  const [note, setNote] = useState("");
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Arriving before gates open? Request a pass and an officer will assign
        you one that covers your arrival
        {myArrival
          ? ` (you plan to arrive ${dayjs(myArrival).format("ddd, MMM D")})`
          : ""}
        .
      </Text>
      <Group align="flex-end">
        <TextInput
          label="Note (optional)"
          placeholder="e.g. helping with build from Tuesday"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          w={{ base: "100%", xs: 320 }}
        />
        <Button
          loading={fetcher.state !== "idle"}
          onClick={() => {
            fetcher.submit({ intent: "requestPass", note }, { method: "post" });
            setNote("");
          }}
        >
          Request a pass
        </Button>
      </Group>
    </Stack>
  );
}

/** Upload the vendor's PDF. One file, one pass per page; re-uploading the same
 * order is safe and imports nothing new. */
function ImportCard({
  fetcher,
  year,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  year: number;
}) {
  const [file, setFile] = useState<File | null>(null);
  const busy = fetcher.state !== "idle";
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <div>
          <Text fw={600}>Import passes from the vendor PDF</Text>
          <Text size="xs" c="dimmed">
            The file Burning Man sends, one pass per page. CampTool reads each
            page's date and codes, and each date's quota becomes however many
            passes actually arrived. Uploading the same file twice is safe.
          </Text>
        </div>
        <Group align="flex-end">
          <FileInput
            label={`Setup Access Pass PDF for ${year}`}
            placeholder="choose a PDF"
            accept="application/pdf"
            value={file}
            onChange={setFile}
            clearable
            w={{ base: "100%", xs: 340 }}
          />
          <Button
            disabled={!file}
            loading={busy}
            onClick={() => {
              if (!file) return;
              const body = new FormData();
              body.set("intent", "importPasses");
              body.set("file", file);
              fetcher.submit(body, {
                method: "post",
                encType: "multipart/form-data",
              });
              setFile(null);
            }}
          >
            Import
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Importing stores the order so a single page can be cut from it on
          demand. CampTool never sends a page that carries anyone else's codes.
        </Text>
      </Stack>
    </Card>
  );
}

/**
 * The numbers an officer needs before allocating: what the camp holds, who
 * needs one, and whether those two facts are compatible.
 *
 * "Compatible" is not a subtraction. A pass admits **on or after** its date, so
 * a pass dated the 28th is no use to someone arriving on the 25th — the camp
 * can hold more passes than it has people and still leave somebody stranded.
 * `coverable` comes from an actual matching, which is why it is worth showing
 * beside the raw totals instead of leaving the arithmetic to a tired human.
 */
function CoverageCard({ coverage }: { coverage: CoverageData }) {
  if (!coverage) return null;
  const short = coverage.uncoverable.length;
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <Text fw={600}>Setup access at a glance</Text>

        <Group gap="xs" wrap="wrap">
          <Badge size="lg" variant="light">
            {coverage.held} held
          </Badge>
          <Badge size="lg" variant="light" color="blue">
            {coverage.spare} spare
          </Badge>
          <Badge size="lg" variant="light" color="cyan">
            {coverage.assigned} set aside
          </Badge>
          <Badge size="lg" variant="light" color="green">
            {coverage.released} released
          </Badge>
          {coverage.voided > 0 ? (
            <Badge size="lg" variant="light" color="gray">
              {coverage.voided} void
            </Badge>
          ) : null}
        </Group>

        <Group gap="xs" wrap="wrap">
          <Badge
            size="lg"
            variant="light"
            color={coverage.needing > 0 ? "orange" : "green"}
          >
            {coverage.needing} still need one
          </Badge>
          {coverage.needing > 0 ? (
            <Badge
              size="lg"
              variant="light"
              color={short > 0 ? "red" : "green"}
            >
              {coverage.coverable} of them coverable
            </Badge>
          ) : null}
          {coverage.unknownArrival > 0 ? (
            <Badge size="lg" variant="light" color="yellow">
              {coverage.unknownArrival} haven't said when they arrive
            </Badge>
          ) : null}
        </Group>

        {short > 0 ? (
          <Alert
            color="red"
            variant="light"
            title="Short of early-enough passes"
          >
            <Text size="sm">
              These people arrive before any spare pass admits entry. Holding
              more passes doesn't help — they need passes dated earlier.
            </Text>
            <List size="sm" mt={6}>
              {coverage.uncoverable.map((u) => (
                <List.Item key={`${u.name}-${u.arrivalDate}`}>
                  {u.name} — arriving{" "}
                  {dayjs(u.arrivalDate).format("ddd, MMM D")}
                </List.Item>
              ))}
            </List>
          </Alert>
        ) : null}

        {coverage.unknownArrival > 0 ? (
          <Text size="xs" c="dimmed">
            The unknowns aren't counted as needing a pass — we genuinely don't
            know. They're who to chase, though: an early arrival nobody wrote
            down is the one way to come up short on the day.
          </Text>
        ) : null}

        {coverage.byDate.length > 0 ? (
          <Group gap={6} wrap="wrap">
            {coverage.byDate.map((d) => (
              <Badge key={d.date} size="sm" variant="outline">
                {dayjs(d.date).format("MMM D")}+ · {d.spare}/{d.held} spare
              </Badge>
            ))}
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * Everyone who still needs a pass, from both directions at once: the app worked
 * it out from their arrival date, or they asked outright. One list, because an
 * officer allocating passes doesn't care which way somebody got onto it — and a
 * queue built only from requests silently omits everyone who never asked.
 */
function NeedsPassCard({
  people,
  stock,
  fetcher,
  locked,
}: {
  people: NeedRow[];
  stock: StockRow[];
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const available = stock
    .filter((s) => s.status === "available")
    .sort((a, b) => a.onOrAfterDate.localeCompare(b.onOrAfterDate));

  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <div>
          <Text fw={600}>Needs a pass · {people.length}</Text>
          <Text size="xs" c="dimmed">
            Arriving before gates open, or asked for a pass, and nothing set
            aside yet. Nobody has to ask to appear here — an early arrival date
            is enough.
          </Text>
        </div>
        {people.map((p) => {
          // The latest pass that still covers their arrival — it burns the
          // least early-entry capacity, leaving the early-dated passes for the
          // people who can't use anything else.
          const covering = available.filter(
            (s) => !p.arrivalDate || s.onOrAfterDate <= p.arrivalDate,
          );
          const best = covering.at(-1);
          return (
            <Group key={p.attendeeId} justify="space-between" wrap="wrap">
              <div>
                <Text size="sm">
                  {p.name}
                  {p.hostName ? (
                    <Text span size="xs" c="dimmed">
                      {" "}
                      — guest of {p.hostName}
                    </Text>
                  ) : null}
                  <Text span size="xs" c="dimmed">
                    {" "}
                    — arriving{" "}
                    {p.arrivalDate
                      ? dayjs(p.arrivalDate).format("ddd, MMM D")
                      : "date not given"}
                  </Text>
                  {p.asked ? (
                    <Badge size="xs" variant="light" ml={6}>
                      asked
                    </Badge>
                  ) : null}
                </Text>
                {p.note ? (
                  <Text size="xs" c="dimmed">
                    “{p.note}”
                  </Text>
                ) : null}
              </div>
              {locked ? null : (
                <Group gap={4} wrap="nowrap">
                  {best ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      onClick={() =>
                        fetcher.submit(
                          {
                            intent: "assignStock",
                            id: best.id,
                            granteeRef: p.ref,
                          },
                          { method: "post" },
                        )
                      }
                    >
                      Set aside {dayjs(best.onOrAfterDate).format("MMM D")}
                    </Button>
                  ) : (
                    <Text size="xs" c="orange">
                      No spare pass covers that arrival
                    </Text>
                  )}
                  {p.requestId ? (
                    // Only an explicit ask can be declined. Someone who merely
                    // has an early arrival date hasn't asked for anything, so
                    // there is nothing to say no to — chase the date instead.
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "denyPass", id: p.requestId as string },
                          { method: "post" },
                        )
                      }
                    >
                      Decline
                    </Button>
                  ) : null}
                </Group>
              )}
            </Group>
          );
        })}
      </Stack>
    </Card>
  );
}

/** The imported stock, grouped by the date each pass admits on. */
function StockCard({
  stock,
  voided,
  grantGroups,
  fetcher,
  locked,
}: {
  stock: StockRow[];
  voided: StockRow[];
  grantGroups: GrantGroup[];
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const [releasing, setReleasing] = useState<StockRow[] | null>(null);
  const [voiding, setVoiding] = useState<StockRow | null>(null);

  const dates = [...new Set(stock.map((s) => s.onOrAfterDate))].sort();
  const assigned = stock.filter((s) => s.status === "assigned");
  const heldBy = new Set(stock.map((s) => s.holderRef).filter(Boolean));

  if (stock.length === 0 && voided.length === 0) {
    return (
      <Card withBorder padding="md" radius="md">
        <Text fw={600} mb={4}>
          Pass stock
        </Text>
        <Text size="sm" c="dimmed">
          No passes imported yet. Upload the vendor's PDF below and each page
          becomes a pass you can set aside for someone.
        </Text>
      </Card>
    );
  }

  return (
    <>
      <Card withBorder padding="md" radius="md">
        <Stack gap="sm">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600}>Pass stock · {stock.length}</Text>
              <Text size="xs" c="dimmed">
                Setting a pass aside reveals nothing. Releasing it hands the
                codes over and can't be undone. Guests are listed under whoever
                brought them; under-13s aren't listed at all, because they need
                no pass.
              </Text>
            </div>
            {!locked && assigned.length > 0 ? (
              <Button
                size="xs"
                color="green"
                onClick={() => setReleasing(assigned)}
              >
                Release all {assigned.length} set aside
              </Button>
            ) : null}
          </Group>

          {dates.map((date) => {
            const rows = stock.filter((s) => s.onOrAfterDate === date);
            const free = rows.filter((s) => s.status === "available").length;
            return (
              <Paper key={date} withBorder p="sm" radius="sm">
                <Group gap={6} mb={6}>
                  <Text fw={600} size="sm">
                    On or after {dayjs(date).format("ddd, MMM D")}
                  </Text>
                  <Badge size="sm" variant="light" color="blue">
                    {free} spare of {rows.length}
                  </Badge>
                </Group>
                <Stack gap={6}>
                  {rows.map((s) => (
                    <StockRowView
                      key={s.id}
                      row={s}
                      grantGroups={grantGroups}
                      heldBy={heldBy}
                      fetcher={fetcher}
                      locked={locked}
                      onRelease={() => setReleasing([s])}
                      onVoid={() => setVoiding(s)}
                    />
                  ))}
                </Stack>
              </Paper>
            );
          })}

          {voided.length > 0 ? (
            <>
              <Divider />
              <Text size="xs" c="dimmed">
                Voided · {voided.length}. These are not in the pool and need
                replacing by the vendor.
              </Text>
              {voided.map((v) => (
                <Text key={v.id} size="xs" c="dimmed">
                  {dayjs(v.onOrAfterDate).format("MMM D")} ·{" "}
                  {v.holderName ?? "unassigned"} — {v.voidReason}
                </Text>
              ))}
            </>
          ) : null}
        </Stack>
      </Card>

      <ReleaseModal
        rows={releasing}
        onClose={() => setReleasing(null)}
        fetcher={fetcher}
      />
      <VoidModal
        row={voiding}
        onClose={() => setVoiding(null)}
        fetcher={fetcher}
      />
    </>
  );
}

function StockRowView({
  row,
  grantGroups,
  heldBy,
  fetcher,
  locked,
  onRelease,
  onVoid,
}: {
  row: StockRow;
  grantGroups: GrantGroup[];
  heldBy: Set<string | null>;
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
  onRelease: () => void;
  onVoid: () => void;
}) {
  const assignable = grantGroups
    .map((g) => ({
      group: g.group,
      items: g.items.filter((i) => !heldBy.has(i.value)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <Group justify="space-between" wrap="wrap" align="center">
      <Group gap="xs" wrap="wrap">
        <Badge
          size="sm"
          variant="light"
          color={
            row.status === "released"
              ? "green"
              : row.status === "assigned"
                ? "blue"
                : "gray"
          }
        >
          {row.status === "available" ? "spare" : row.status}
        </Badge>
        <Text size="sm">
          {row.holderName ?? (
            <Text span size="sm" c="dimmed">
              nobody yet
            </Text>
          )}
          {row.hostName ? (
            <Text span size="xs" c="dimmed">
              {" "}
              — guest of {row.hostName}
            </Text>
          ) : null}
        </Text>
        <Text size="xs" c="dimmed">
          #{row.vendorTicketId}
        </Text>
      </Group>

      {locked ? null : (
        <Group gap={4} wrap="nowrap">
          {row.status === "available" ? (
            <Select
              size="xs"
              w={190}
              placeholder="set aside for…"
              data={assignable}
              searchable
              value={null}
              onChange={(value) => {
                if (value)
                  fetcher.submit(
                    { intent: "assignStock", id: row.id, granteeRef: value },
                    { method: "post" },
                  );
              }}
            />
          ) : null}
          {row.status === "assigned" ? (
            <>
              <Button
                size="compact-xs"
                variant="light"
                color="green"
                onClick={onRelease}
              >
                Release
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() =>
                  fetcher.submit(
                    { intent: "unassignStock", id: row.id },
                    { method: "post" },
                  )
                }
              >
                Take back
              </Button>
            </>
          ) : null}
          {row.status === "released" ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={onVoid}
            >
              Void
            </Button>
          ) : null}
        </Group>
      )}
    </Group>
  );
}

/** Releasing is the one-way door, so it gets said out loud before it happens —
 * with the names on it, because releasing the wrong person's pass is the
 * mistake this screen can actually make. */
function ReleaseModal({
  rows,
  onClose,
  fetcher,
}: {
  rows: StockRow[] | null;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const open = rows !== null && rows.length > 0;
  return (
    <Modal opened={open} onClose={onClose} title="Release these passes?">
      <Stack gap="sm">
        <Alert color="orange" variant="light">
          This hands over the codes. They can't be un-sent — if a released pass
          has to be pulled, it gets voided and needs replacing by the vendor.
        </Alert>
        <List size="sm">
          {(rows ?? []).map((r) => (
            <List.Item key={r.id}>
              {r.holderName ?? "nobody"} —{" "}
              {dayjs(r.onOrAfterDate).format("ddd, MMM D")}
            </List.Item>
          ))}
        </List>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="green"
            loading={fetcher.state !== "idle"}
            onClick={() => {
              for (const r of rows ?? []) {
                fetcher.submit(
                  { intent: "releaseStock", id: r.id },
                  { method: "post" },
                );
              }
              onClose();
            }}
          >
            Release {rows?.length ?? 0}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Voiding needs a reason, because "why is this pass dead" is the entire value
 * of the record afterwards. */
function VoidModal({
  row,
  onClose,
  fetcher,
}: {
  row: StockRow | null;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal opened={row !== null} onClose={onClose} title="Void this pass?">
      <Stack gap="sm">
        <Alert color="red" variant="light">
          The codes for {row?.holderName ?? "this pass"} are already out.
          Voiding records that it must not be used — it does <b>not</b> go back
          into the pool, and the camp needs a replacement from the vendor.
        </Alert>
        <Textarea
          label="Why?"
          placeholder="e.g. sent to the wrong person; they're no longer coming"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          minRows={2}
          autosize
        />
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            disabled={reason.trim().length < 3}
            loading={fetcher.state !== "idle"}
            onClick={() => {
              if (!row) return;
              fetcher.submit(
                { intent: "voidStock", id: row.id, reason },
                { method: "post" },
              );
              setReason("");
              onClose();
            }}
          >
            Void the pass
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function useFetcherNotifications(
  fdata: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !fdata || fdata === seen.current) return;
    seen.current = fdata;
    if (fdata.error) {
      notifications.show({
        color: "red",
        title: "Error",
        message: fdata.error,
      });
    } else if (fdata.ok) {
      notifications.show({ title: "Done", message: fdata.ok });
    }
  }, [fdata, state]);
}
