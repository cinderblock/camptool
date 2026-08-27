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
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { BurningManDisclaimer } from "~/components/BurningManDisclaimer";
import { EventCalendar } from "~/components/EventCalendar";
import { describe } from "~/components/StayRangeField";
import { ageLabel, needsSetupPass } from "~/lib/age";
import { ensureMemberAttendee } from "~/lib/attendee.server";
import { eventStartIso } from "~/lib/brc";
import { featureName, isBurningMan } from "~/lib/events";
import { requireFeature } from "~/lib/features.server";
import { canManageAttendee, inMyParty, isMe } from "~/lib/party";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import type { EventRange } from "~/lib/questions";
import {
  SapImportError,
  SapStateError,
  allocateStockExternally,
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
/** One person in the viewer's party, as the "your group" card needs them. */
type PartyRow = {
  attendeeId: string;
  name: string;
  isSelf: boolean;
  isGuest: boolean;
  ageBand: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  notComing: boolean;
  /** Arriving before gates open and old enough to need their own pass. */
  needsPass: boolean;
  requested: boolean;
  requestId: string | null;
  /** A pass already set aside for them, and how far along it is. */
  passState: "assigned" | "released" | null;
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
  /** Set instead of `holderName` when the pass went to someone outside the camp
   * entirely — see `plans/sap-request-and-external-allocation.md`. */
  externalHolder: string | null;
  /** Why it went outside, if whoever allocated it said. */
  note: string | null;
  holderIsGuest: boolean;
  /** Whose guest, when the holder is one. */
  hostName: string | null;
  /** The holder's RSVP, so a pass held by someone who has since dropped out
   * can be spotted and reclaimed. */
  holderStatus: string | null;
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
    // Join THIS edition's attendee row so the picker knows who is actually
    // coming. Without it the list was every membership the camp has ever had,
    // and somebody who answered "not this year" was as selectable as anyone
    // else — an easy way to hand a scarce pass to a person who won't use it.
    const memberAttendee = alias(attendee, "member_attendee");
    const memberRows = (
      await db
        .select({
          id: membership.id,
          name: user.name,
          status: memberAttendee.status,
          arrivalDate: memberAttendee.arrivalDate,
          ageBand: memberAttendee.ageBand,
        })
        .from(membership)
        .innerJoin(user, eq(membership.userId, user.id))
        .leftJoin(
          memberAttendee,
          and(
            eq(memberAttendee.membershipId, membership.id),
            eq(memberAttendee.editionId, editionId),
          ),
        )
        .where(eq(membership.organizationId, active.camp.id))
    )
      // "Not this year" is a no. Everything else stays, including people who
      // haven't answered — an unanswered RSVP is not a refusal, and an officer
      // may well be setting a pass aside for someone they've spoken to offline.
      .filter((m) => m.status !== "not_coming")
      .filter((m) => needsSetupPass(m.ageBand))
      .sort((a, b) => a.name.localeCompare(b.name));
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
          ne(attendee.status, "not_coming"),
        ),
      );
    grantGroups = [
      {
        group: "Campers",
        // Same detail as guests get: the arrival decides which pass covers
        // them, and an unanswered RSVP is worth seeing before you spend one.
        items: memberRows.map((m) => {
          const when = m.arrivalDate
            ? ` · arrives ${dayjs(m.arrivalDate).format("MMM D")}`
            : " · no arrival date";
          const doubt = m.status === "maybe" ? " (maybe)" : "";
          return { value: `m:${m.id}`, label: `${m.name}${doubt}${when}` };
        }),
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

  // --- the viewer's party ------------------------------------------------
  // Self plus everyone attending under them. This is the card a camper
  // actually needs: who's in my group, when are they arriving, and has anybody
  // sorted them a pass — in one place, with the buttons next to the answer.
  const gateOpenIso = eventStartIso(activeEdition.year);
  const partyRows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      ageBand: attendee.ageBand,
      status: attendee.status,
    })
    .from(attendee)
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(attendee.editionId, editionId));

  // --- imported pass stock ----------------------------------------------
  // Two different reads, because they answer two different questions and only
  // one of them is allowed to carry secrets.
  const rawStock = await stockForEdition(editionId);
  const allStock: StockRow[] = rawStock.map((s) => ({
    id: s.id,
    onOrAfterDate: s.onOrAfterDate,
    vendorTicketId: s.vendorTicketId,
    status: s.status,
    voidReason: s.voidReason,
    assignedAttendeeId: s.assignedAttendeeId,
    externalHolder: s.externalHolder,
    note: s.note,
    holderName: s.guestName ?? s.memberName ?? null,
    holderIsGuest:
      s.assignedAttendeeId != null && s.attendeeMembershipId == null,
    hostName: s.attendeeMembershipId ? null : (s.hostName ?? null),
    holderStatus: s.holderStatus ?? null,
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
  const mineIds = allStock.filter((s) => s.mine).map((s) => s.id);
  const myCodes: Record<string, { scanCode: string; securityCode: string }> =
    {};
  for (const row of await stockWithCodes(editionId, mineIds)) {
    if (!visibleCodesFor(row, active.membership)) continue;
    myCodes[row.id] = {
      scanCode: row.scanCode,
      securityCode: row.securityCode,
    };
  }

  // The same reasoning one level out: the officer table is the ONLY thing that
  // reads the whole camp's stock, so only an officer is sent it. A member used
  // to receive every holder's name in the loader payload — not a code, but not
  // theirs either, and an outsider's name has no business travelling to a
  // camper's browser at all. Members get their own party's rows and no more.
  const stock = isOfficer ? allStock : allStock.filter((s) => s.mine);

  // Who still needs a pass? Two ways to land here, one list:
  //   - they set an arrival before gates open (the app worked it out), or
  //   - they asked for one outright (plans changed, or they want to help build
  //     without having said so on the calendar).
  // Anyone already holding a live pass is served and drops off.
  const gateOpen = eventStartIso(activeEdition.year);
  const needsPass: NeedRow[] = [];
  if (isOfficer) {
    const held = new Set(
      allStock
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

  // Assembled after `allStock`, because a person's row needs to know whether a
  // pass is already set aside for them.
  const myParty: PartyRow[] = partyRows
    .filter((r) =>
      inMyParty(
        { membershipId: r.membershipId, hostMembershipId: r.hostMembershipId },
        myMembershipId,
      ),
    )
    .map((r) => {
      const held = allStock.find(
        (s) => s.assignedAttendeeId === r.id && s.status !== "void",
      );
      const request = passes.find(
        (p) => p.attendeeId === r.id && p.status !== "denied",
      );
      return {
        attendeeId: r.id,
        name: r.guestName ?? r.memberName ?? "Unknown",
        isSelf: isMe({ membershipId: r.membershipId }, myMembershipId),
        isGuest: r.membershipId == null,
        ageBand: r.ageBand,
        arrivalDate: r.arrivalDate,
        departureDate: r.departureDate,
        notComing: r.status === "not_coming",
        // Under-13s are admitted free, so "needs one" is false for them however
        // early they turn up.
        needsPass:
          needsSetupPass(r.ageBand) &&
          !!r.arrivalDate &&
          r.arrivalDate < gateOpenIso,
        requested: Boolean(request) && request?.status === "requested",
        requestId: request?.status === "requested" ? request.id : null,
        passState: held ? (held.status as "assigned" | "released") : null,
      };
    })
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return redact(privacy, {
    isOfficer,
    // Voiding a pass and handing one to somebody outside the camp are the two
    // transitions nobody else can audit by recognising the name on it.
    isAdmin: hasAtLeast(active.membership.role, "admin"),
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
    myParty,
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

  // Ask for a pass on behalf of anyone in my party — my guests, and members
  // attending under me. `requestPass` above is the self-only shorthand the
  // wizard uses; this is the same thing with a subject.
  if (intent === "requestPassFor" || intent === "setStay") {
    const attendeeId = String(form.get("attendeeId") ?? "");
    const [row] = await db
      .select({
        id: attendee.id,
        membershipId: attendee.membershipId,
        hostMembershipId: attendee.hostMembershipId,
        ageBand: attendee.ageBand,
      })
      .from(attendee)
      .where(
        and(eq(attendee.id, attendeeId), eq(attendee.editionId, editionId)),
      )
      .limit(1);
    if (!row || !canManageAttendee(row, active.membership)) {
      return data({ error: "Not someone you manage." }, { status: 403 });
    }

    if (intent === "setStay") {
      const iso = (k: string) => {
        const v = String(form.get(k) ?? "").trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
      };
      const arrivalDate = iso("arrivalDate");
      const departureDate = iso("departureDate");
      // A departure before the arrival is a mis-tap, not a stay.
      if (arrivalDate && departureDate && departureDate < arrivalDate) {
        return data(
          { error: "That leaves before it arrives." },
          { status: 400 },
        );
      }
      await db
        .update(attendee)
        .set({ arrivalDate, departureDate, updatedAt: new Date() })
        .where(eq(attendee.id, attendeeId));
      return data({ ok: "Dates saved." });
    }

    if (!needsSetupPass(row.ageBand)) {
      return data(
        { error: "Under-13s are admitted free — they need no pass." },
        { status: 400 },
      );
    }
    if (await activePassFor(attendeeId)) {
      return data(
        { error: "They already have a pass or a pending request." },
        { status: 409 },
      );
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      attendeeId,
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

  // --- the viewer's party ------------------------------------------------
  // Self plus everyone attending under them. This is the card a camper
  // actually needs: who's in my group, when are they arriving, and has anybody
  // sorted them a pass — in one place, with the buttons next to the answer.
  const gateOpenIso = eventStartIso(activeEdition.year);
  const partyRows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      hostMembershipId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      ageBand: attendee.ageBand,
      status: attendee.status,
    })
    .from(attendee)
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(attendee.editionId, editionId));

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
    // Out of the pool and out of the camp — to a neighbour, a helper, anyone
    // with no membership and no attendee row to point at.
    allocateExternal: () =>
      allocateStockExternally(
        editionId,
        String(form.get("id")),
        str("holder") ?? "",
        str("note"),
        stockActor,
      ),
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
    const adminOnly: Record<string, string> = {
      voidStock: "Only an admin can void a pass.",
      allocateExternal:
        "Only an admin can allocate a pass to someone outside the camp.",
    };
    const needsAdmin = adminOnly[intent];
    if (needsAdmin && !hasAtLeast(active.membership.role, "admin")) {
      return data({ error: needsAdmin }, { status: 403 });
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
      allocateExternal:
        "Allocated outside the camp. Release it to get the PDF you can send them.",
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
    isAdmin,
    locked,
    event,
    myMembershipId,
    myArrival,
    year,
    passes,
    grantGroups,
    stock,
    myCodes,
    myParty,
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

        {/* ----- Member self-service: the ASK -----
            Granted requests aren't shown here — a granted request IS a pass,
            and the card below shows the pass itself. Leaving both would be the
            two-ledger confusion this screen just got rid of.

            Rendered only when it has something to say. Someone who already
            holds a pass and has no open request was getting a card containing
            nothing but its own heading, which is worse than no card. The group
            card above covers them; this one exists for the ask itself —
            including "I want one anyway", which the group card's arrival-driven
            button can't express. */}
        {myOpenRequests.length > 0 ||
        (!locked && !myOwnActive && myOwnStock.length === 0) ? (
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
        ) : null}

        {/* ----- Your group: dates and pass state, side by side ----- */}
        <PartyCard
          people={myParty}
          year={year}
          locked={locked}
          fetcher={fetcher}
        />

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
              isAdmin={isAdmin}
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
/**
 * Your group — who's coming with you, when they arrive, and whether anybody has
 * sorted them a Setup Access Pass.
 *
 * This is the question a camper arrives at this page with, and it used to take
 * three screens to answer: arrival dates lived on the roster, the request lived
 * here, and whether a pass had been set aside was a card further down. One row
 * per person, with the button that changes each fact next to the fact.
 *
 * Dates are picked on the event calendar, never a browser date box — see
 * `StayRangeField` for why.
 */
function PartyCard({
  people,
  year,
  locked,
  fetcher,
}: {
  people: PartyRow[];
  year: number;
  locked: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [editing, setEditing] = useState<PartyRow | null>(null);
  if (people.length === 0) return null;

  return (
    <>
      <Card withBorder padding="md" radius="md">
        <Stack gap="sm">
          <div>
            <Text fw={600}>Your group</Text>
            <Text size="xs" c="dimmed">
              Arriving before gates open needs a Setup Access Pass. Under-13s
              are admitted free and need none.
            </Text>
          </div>

          {people.map((p) => (
            <Paper key={p.attendeeId} withBorder p="sm" radius="sm">
              <Group justify="space-between" wrap="wrap" align="center">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Text size="sm" fw={600}>
                      {p.name}
                      {p.isSelf ? (
                        <Text span size="xs" c="dimmed">
                          {" "}
                          (you)
                        </Text>
                      ) : null}
                    </Text>
                    {ageLabel(p.ageBand) ? (
                      <Badge size="xs" variant="light" color="gray">
                        {ageLabel(p.ageBand)}
                      </Badge>
                    ) : null}
                    {p.notComing ? (
                      <Badge size="xs" variant="light" color="gray">
                        not coming
                      </Badge>
                    ) : null}
                  </Group>

                  <Text size="sm" c={p.arrivalDate ? undefined : "dimmed"}>
                    {describe({
                      arrival: p.arrivalDate,
                      departure: p.departureDate,
                    })}
                  </Text>

                  <PassState person={p} />
                </div>

                {locked ? null : (
                  <Group gap={4} wrap="nowrap">
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => setEditing(p)}
                    >
                      {p.arrivalDate ? "Change dates" : "Set dates"}
                    </Button>
                    {p.passState === null && !p.requested && p.needsPass ? (
                      <Button
                        size="compact-xs"
                        onClick={() =>
                          fetcher.submit(
                            {
                              intent: "requestPassFor",
                              attendeeId: p.attendeeId,
                            },
                            { method: "post" },
                          )
                        }
                      >
                        Request a pass
                      </Button>
                    ) : null}
                    {p.requestId ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "cancelPass", id: p.requestId as string },
                            { method: "post" },
                          )
                        }
                      >
                        Cancel request
                      </Button>
                    ) : null}
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      </Card>

      <StayModal
        person={editing}
        year={year}
        onClose={() => setEditing(null)}
        fetcher={fetcher}
      />
    </>
  );
}

/** One line saying exactly where this person stands, in plain words. */
function PassState({ person }: { person: PartyRow }) {
  if (person.passState === "released") {
    return (
      <Text size="xs" c="green">
        ✓ Pass ready — codes are below
      </Text>
    );
  }
  if (person.passState === "assigned") {
    return (
      <Text size="xs" c="blue">
        ✓ A pass is set aside — an officer will release the codes
      </Text>
    );
  }
  if (person.requested) {
    return (
      <Text size="xs" c="yellow">
        Pass requested — waiting on an officer
      </Text>
    );
  }
  if (!needsSetupPass(person.ageBand)) {
    return (
      <Text size="xs" c="dimmed">
        No pass needed — admitted free
      </Text>
    );
  }
  if (person.needsPass) {
    return (
      <Text size="xs" c="orange">
        Arriving before gates open — no pass requested yet
      </Text>
    );
  }
  if (!person.arrivalDate) {
    return (
      <Text size="xs" c="dimmed">
        No arrival date yet — set one and we'll say whether a pass is needed
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      Arriving after gates open — no pass needed
    </Text>
  );
}

/** The event calendar in a modal, saving through the party-scoped action. */
function StayModal({
  person,
  year,
  onClose,
  fetcher,
}: {
  person: PartyRow | null;
  year: number;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [range, setRange] = useState<EventRange>({
    arrival: null,
    departure: null,
  });
  // Re-seed whenever a different person is opened.
  useEffect(() => {
    setRange({
      arrival: person?.arrivalDate ?? null,
      departure: person?.departureDate ?? null,
    });
  }, [person]);

  return (
    <Modal
      opened={person !== null}
      onClose={onClose}
      title={person ? `When is ${person.name} here?` : ""}
      size="auto"
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Tap the day they arrive, then the day they head home.
        </Text>
        <EventCalendar
          year={year}
          mode="range"
          range={range}
          onRangeChange={setRange}
        />
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={fetcher.state !== "idle"}
            onClick={() => {
              if (!person) return;
              fetcher.submit(
                {
                  intent: "setStay",
                  attendeeId: person.attendeeId,
                  arrivalDate: range.arrival ?? "",
                  departureDate: range.departure ?? "",
                },
                { method: "post" },
              );
              onClose();
            }}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

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
  isAdmin,
}: {
  stock: StockRow[];
  voided: StockRow[];
  grantGroups: GrantGroup[];
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
  isAdmin: boolean;
}) {
  const [releasing, setReleasing] = useState<StockRow[] | null>(null);
  const [voiding, setVoiding] = useState<StockRow | null>(null);
  const [externalising, setExternalising] = useState<StockRow | null>(null);

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
                      isAdmin={isAdmin}
                      onRelease={() => setReleasing([s])}
                      onVoid={() => setVoiding(s)}
                      onAllocateExternally={() => setExternalising(s)}
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
      <ExternalModal
        row={externalising}
        onClose={() => setExternalising(null)}
        fetcher={fetcher}
      />
    </>
  );
}

/** The holder as it should read in a list: a camper's name, or the outsider's,
 * or nothing yet. Kept in one place because three screens ask. */
function holderLabel(row: StockRow): string | null {
  return row.holderName ?? row.externalHolder ?? null;
}

function StockRowView({
  row,
  grantGroups,
  heldBy,
  fetcher,
  locked,
  isAdmin,
  onRelease,
  onVoid,
  onAllocateExternally,
}: {
  row: StockRow;
  grantGroups: GrantGroup[];
  heldBy: Set<string | null>;
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
  isAdmin: boolean;
  onRelease: () => void;
  onVoid: () => void;
  onAllocateExternally: () => void;
}) {
  const external = row.externalHolder !== null;
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
          {holderLabel(row) ?? (
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
          {external && row.note ? (
            <Text span size="xs" c="dimmed">
              {" "}
              — {row.note}
            </Text>
          ) : null}
        </Text>
        {external ? (
          // Nothing else on this screen would say so: the name is free text,
          // and the row otherwise looks exactly like a camper's.
          <Badge size="sm" variant="light" color="grape">
            outside the camp
          </Badge>
        ) : null}
        {row.holderStatus === "not_coming" ? (
          // They took a pass and then dropped out. Nothing else would ever
          // mention it, and it's a pass the camp could give to someone else.
          <Badge size="sm" variant="light" color="red">
            not coming — reclaim?
          </Badge>
        ) : null}
        <Text size="xs" c="dimmed">
          #{row.vendorTicketId}
        </Text>
      </Group>

      {locked ? null : (
        <Group gap={4} wrap="nowrap">
          {row.status === "available" ? (
            <>
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
              {isAdmin ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="grape"
                  onClick={onAllocateExternally}
                >
                  Outside camp
                </Button>
              ) : null}
            </>
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
          {row.status === "released" && external ? (
            // The only way this pass can reach its holder: they have no page
            // here to be handed the codes on. Without it we'd allocate a pass
            // we could never deliver.
            <Button
              size="compact-xs"
              variant="light"
              component="a"
              href={`/sap/pass/${row.id}`}
              download
            >
              Download PDF
            </Button>
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
              {holderLabel(r) ?? "nobody"}
              {r.externalHolder ? " (outside the camp)" : ""} —{" "}
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
          The codes for {row ? (holderLabel(row) ?? "this pass") : "this pass"}{" "}
          are already out. Voiding records that it must not be used — it does{" "}
          <b>not</b> go back into the pool, and the camp needs a replacement
          from the vendor.
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

/**
 * Give a pass to somebody the app has never heard of.
 *
 * The escape hatch, and it asks for a name because that name is the *only*
 * record of where the pass went — there is no membership to look up later, no
 * roster row, nothing but this and the audit event it writes. A pass that
 * leaves as "someone" is a pass the camp cannot account for.
 */
function ExternalModal({
  row,
  onClose,
  fetcher,
}: {
  row: StockRow | null;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [holder, setHolder] = useState("");
  const [note, setNote] = useState("");
  const close = () => {
    setHolder("");
    setNote("");
    onClose();
  };
  return (
    <Modal
      opened={row !== null}
      onClose={close}
      title="Allocate this pass outside the camp?"
    >
      <Stack gap="sm">
        <Alert color="grape" variant="light">
          For somebody with no CampTool account — a neighbour, a helper, a
          friend of the camp. It leaves the pool immediately, so it stops
          counting towards covering your own early arrivals. Release it
          afterwards to get the PDF you can send them.
        </Alert>
        <TextInput
          label="Who's getting it?"
          description="The only record of where this pass went — a name someone will recognise in November."
          placeholder="e.g. Jamie Reyes (Ranger HQ)"
          value={holder}
          onChange={(e) => setHolder(e.currentTarget.value)}
        />
        <Textarea
          label="Why? (optional)"
          placeholder="e.g. helping us build the shade structure Tuesday; agreed with the leads"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          minRows={2}
          autosize
        />
        <Group justify="flex-end">
          <Button variant="subtle" onClick={close}>
            Cancel
          </Button>
          <Button
            color="grape"
            disabled={holder.trim().length < 2}
            loading={fetcher.state !== "idle"}
            onClick={() => {
              if (!row) return;
              fetcher.submit(
                {
                  intent: "allocateExternal",
                  id: row.id,
                  holder,
                  note,
                },
                { method: "post" },
              );
              close();
            }}
          >
            Allocate the pass
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
