import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { CampMapView } from "~/components/CampMapView";
import {
  arrivalDistribution,
  arrivalSortKey,
  dayChip,
  dayChipBorder,
} from "~/lib/arrival";
import {
  type AttendeeStatus,
  addGuest,
  getGuest,
  getPartyHostOf,
  listPartyHostCandidates,
  loadRoster,
  removeGuest,
  setPartyHost,
  updateGuest,
} from "~/lib/attendee.server";
import { eventStartIso } from "~/lib/brc";
import { PUBLIC_BASE_URL } from "~/lib/env.server";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState, requireFeature } from "~/lib/features.server";
import {
  getOrCreatePromotionInvite,
  loadPromotionInvites,
} from "~/lib/invite.server";
import { loadMapView } from "~/lib/map.server";
import { claimGuestAsMember } from "~/lib/merge.server";
import { canManageAttendee } from "~/lib/party";
import { partyMapObjects } from "~/lib/party-map.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { dateLabel } from "~/lib/schedule";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/roster";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Roster · CampTool" }];
}

const STATUS_META: Record<AttendeeStatus, { label: string; color: string }> = {
  coming: { label: "Coming", color: "green" },
  maybe: { label: "Maybe", color: "yellow" },
  not_coming: { label: "Not coming", color: "gray" },
  unknown: { label: "No reply", color: "gray" },
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "roster");
  const { members, headcount } = await loadRoster(
    active.camp.id,
    activeEdition.id,
  );
  // "Where are they camped?" is only answerable when this camp actually runs
  // the map — and only linkable for someone whose party has something placed,
  // so the column never offers a link to an empty map.
  const mapVisible = featureVisibleTo(
    await getFeatureState(active.camp.id, "map"),
    active.membership.role,
  );
  const mapCounts = mapVisible
    ? await partyMapObjects(activeEdition.id)
    : new Map<string, string[]>();
  // The mini-map draws with the editor's own renderer and geometry, so it needs
  // the same object rows the map page loads — see lib/map.server.ts.
  const mapView = mapVisible
    ? await loadMapView(activeEdition.id)
    : { lot: null, objects: [] };
  const myMembershipId = active.membership.id;
  const me = members.find((m) => m.membershipId === myMembershipId) ?? null;
  // Persist the per-guest invite link with the page instead of only in the
  // fetcher response, so a host can see at a glance which of their plus-ones
  // already has a link out and which has already used it.
  const invites = await loadPromotionInvites(
    active.camp.id,
    (me?.guests ?? []).map((g) => g.id),
  );
  // Who I could name as anchoring my household. Officers get the same list per
  // row, computed client-side off `members` rather than one query per member.
  const partyHostCandidates = await listPartyHostCandidates(
    active.camp.id,
    activeEdition.id,
    myMembershipId,
  );
  return redact(privacy, {
    members: members.map((m) => {
      // `partyMapObjects` keys a whole household under its host, so someone
      // attending as part of another member's party has no key of their own.
      // Ask under their host, or their row would read "not placed" while they
      // are in fact asleep in that host's tent.
      const ids = mapCounts.get(m.partyHost?.membershipId ?? m.membershipId);
      return {
        ...m,
        mapItems: ids?.length ?? 0,
        // Ids, not just a count, so selecting a row can light them up without a
        // round trip.
        mapObjectIds: ids ?? [],
      };
    }),
    headcount,
    mapVisible,
    mapLot: mapView.lot,
    mapObjects: mapView.objects,
    myMembershipId,
    myGuests: (me?.guests ?? []).map((g) => {
      const invite = invites.get(g.id);
      return {
        ...g,
        inviteLink: invite ? `${PUBLIC_BASE_URL}/i/${invite.token}` : null,
        inviteRedeemed: invite?.redeemed ?? false,
      };
    }),
    myStatus: me?.status ?? ("unknown" as AttendeeStatus),
    myPartyHost: me?.partyHost ?? null,
    myPartyMembers: me?.partyMembers ?? [],
    partyHostCandidates,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    locked: activeEdition.locked,
    year: activeEdition.year,
  });
}

const MAX_NAME = 120;
const MAX_NOTE = 500;

function cleanDate(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "roster");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const myMid = active.membership.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "addGuest") {
    const name = String(form.get("name") ?? "")
      .trim()
      .slice(0, MAX_NAME);
    if (!name) return data({ error: "A name is required." }, { status: 400 });
    await addGuest({
      campId,
      editionId,
      hostMembershipId: myMid,
      name,
      email: String(form.get("email") ?? "").trim() || null,
      arrivalDate: cleanDate(form.get("arrivalDate")),
      departureDate: cleanDate(form.get("departureDate")),
      note: String(form.get("note") ?? "")
        .trim()
        .slice(0, MAX_NOTE),
    });
    return data({ ok: `Added ${name} to your party.` });
  }

  // "That plus-one is me." Someone listed as another member's guest who has
  // since made their own account claims the entry, so the roster stops counting
  // them twice and their tent spot / ticket / pass follow into their account.
  // Deliberately NOT gated on being the host — the whole point is that the
  // person themselves resolves it without chasing down whoever added them.
  // Trust assumption: a camp member won't claim a stranger's entry to take
  // their ticket. Officers can see and undo the result on this page.
  if (intent === "claimGuest") {
    const guestId = String(form.get("guestId"));
    const guest = await getGuest(campId, editionId, guestId);
    if (!guest) return data({ error: "Guest not found." }, { status: 404 });
    if (guest.hostMembershipId === myMid) {
      return data(
        {
          error:
            "That's a guest you're hosting. Use Remove if they're not coming, or Invite to join to give them their own account.",
        },
        { status: 400 },
      );
    }
    try {
      await claimGuestAsMember(campId, editionId, guestId, myMid);
      return data({
        ok: `Merged "${guest.name ?? "that guest"}" into your account — you're no longer double-counted.`,
      });
    } catch (e) {
      console.error("claimGuest failed", e);
      return data(
        {
          error: e instanceof Error ? e.message : "Couldn't claim that entry.",
        },
        { status: 400 },
      );
    }
  }

  if (
    intent === "updateGuest" ||
    intent === "removeGuest" ||
    intent === "promoteGuest"
  ) {
    const guestId = String(form.get("guestId"));
    const guest = await getGuest(campId, editionId, guestId);
    if (!guest) return data({ error: "Guest not found." }, { status: 404 });
    // A guest is editable by their host or an officer. `getGuest` guarantees a
    // guest row, so there is no self branch to consider — a guest has no
    // account to act from.
    if (!canManageAttendee(guest, active.membership)) {
      return data({ error: "Not your guest." }, { status: 403 });
    }
    if (intent === "promoteGuest") {
      // Phase 4: hand the host a one-use invite link; redeeming it creates
      // the account AND adopts this guest's attendee row (RSVP, occupancy,
      // tickets, passes follow — see i.$token).
      const token = await getOrCreatePromotionInvite({
        campId,
        guestAttendeeId: guestId,
        inviterMembershipId: myMid,
        guestName: guest.name ?? "guest",
      });
      return data({
        ok: `Invite link ready — share it with ${guest.name}.`,
        promoteLink: `${PUBLIC_BASE_URL}/i/${token}`,
        promoteName: guest.name,
      });
    }
    if (intent === "removeGuest") {
      try {
        const { ticketsReleased, passesRevoked } = await removeGuest(guestId);
        const extras = [
          ticketsReleased
            ? `${ticketsReleased} ticket${ticketsReleased === 1 ? "" : "s"} returned to the pool`
            : null,
          passesRevoked
            ? `${passesRevoked} granted setup pass${passesRevoked === 1 ? "" : "es"} released`
            : null,
        ].filter(Boolean);
        return data({
          ok: extras.length
            ? `Removed ${guest.name ?? "guest"} — ${extras.join(", ")}.`
            : "Removed.",
        });
      } catch (e) {
        console.error("removeGuest failed", e);
        return data(
          {
            error:
              "Couldn't remove them — something still references this guest. Try again, and tell an officer if it keeps failing.",
          },
          { status: 409 },
        );
      }
    }
    const name = String(form.get("name") ?? "")
      .trim()
      .slice(0, MAX_NAME);
    if (!name) return data({ error: "A name is required." }, { status: 400 });
    await updateGuest(guestId, {
      name,
      arrivalDate: cleanDate(form.get("arrivalDate")),
      departureDate: cleanDate(form.get("departureDate")),
      note: String(form.get("note") ?? "")
        .trim()
        .slice(0, MAX_NOTE),
    });
    return data({ ok: "Updated." });
  }

  // Link a member into another member's party, or take them out of one.
  //
  // `canManageAttendee` is deliberately NOT the gate here. It answers "does this
  // viewer already have authority over that person?", and before the link exists
  // a prospective host has none — that authority is what's being created. So the
  // rule is stated directly: either of the two people involved, or an officer.
  if (intent === "setPartyHost") {
    const subject = String(form.get("membershipId") ?? "");
    const rawHost = String(form.get("hostMembershipId") ?? "").trim();
    const host = rawHost === "" ? null : rawHost;
    if (!subject) {
      return data({ error: "Who are we linking?" }, { status: 400 });
    }
    const involved = subject === myMid || host === myMid;
    if (!involved && !isOfficer) {
      // Clearing: the current host is also entitled, and they aren't named in
      // the form, so look them up before refusing.
      if ((await getPartyHostOf(editionId, subject)) !== myMid) {
        return data({ error: "That isn't your party." }, { status: 403 });
      }
    }
    const result = await setPartyHost({
      campId,
      editionId,
      membershipId: subject,
      hostMembershipId: host,
    });
    if (!result.ok) return data({ error: result.error }, { status: 400 });
    return data({ ok: host ? "Party updated." : "No longer linked." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = {
  ok?: string;
  error?: string;
  promoteLink?: string;
  promoteName?: string | null;
};

export default function Roster({ loaderData }: Route.ComponentProps) {
  const {
    members,
    headcount,
    myGuests,
    locked,
    year,
    myMembershipId,
    mapVisible,
    mapLot,
    mapObjects,
    myPartyHost,
    myPartyMembers,
    partyHostCandidates,
  } = loaderData;

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <Stack gap={2}>
            <Title order={2}>Who's coming · {year}</Title>
            {/* Paired with the same note on /members — the two were confused
                for each other during a camp meeting. */}
            <Text size="sm" c="dimmed">
              This year's actual roster: members who RSVP'd, plus the guests
              they're bringing.{" "}
              <Anchor component={Link} to="/members" size="sm">
                Looking for the full camp list?
              </Anchor>
            </Text>
          </Stack>
          {locked ? (
            <Badge color="gray" variant="light">
              locked
            </Badge>
          ) : null}
        </Group>

        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          <Stat value={headcount.total} label="coming (heads)" strong />
          <Stat value={headcount.membersComing} label="members coming" />
          <Stat value={headcount.guests} label="guests" />
          <Stat value={headcount.membersMaybe} label="maybe" />
        </SimpleGrid>

        <Arrivals members={members} year={year} />

        {!locked ? (
          <CampingWith
            partyHost={myPartyHost}
            partyMembers={myPartyMembers}
            candidates={partyHostCandidates}
            myMembershipId={myMembershipId}
          />
        ) : null}

        {!locked ? <MyParty guests={myGuests} year={year} /> : null}

        <RosterTable
          members={members}
          myMembershipId={myMembershipId}
          locked={locked}
          year={year}
          mapVisible={mapVisible}
          mapLot={mapLot}
          mapObjects={mapObjects}
        />
      </Stack>
    </Container>
  );
}

/**
 * When is everybody actually here? Asked for so camp leadership could pick a
 * night for an early-week potluck without reading down the roster counting by
 * hand.
 *
 * Two bars per day rather than one, because they answer different questions:
 * how many people ARRIVE that day (gate traffic, who needs a hand with a tent)
 * and how many are ON SITE that day (who could come to a dinner). The second
 * is the one the potluck question is about, and it's the one you can't work out
 * by eye from a list of dates.
 *
 * Guests count as people — they eat too. Members who aren't coming contribute
 * nothing because they have no arrival date.
 */
function Arrivals({
  members,
  year,
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  year: number;
}) {
  const dist = useMemo(() => {
    const people: {
      arrivalDate: string | null;
      departureDate: string | null;
    }[] = [];
    for (const m of members) {
      if (m.status === "coming" || m.status === "maybe") {
        people.push({
          arrivalDate: m.arrivalDate,
          departureDate: m.departureDate,
        });
      }
      // A guest is a head on the roster whatever their host's RSVP says.
      for (const g of m.guests) {
        people.push({
          arrivalDate: g.arrivalDate,
          departureDate: g.departureDate,
        });
      }
    }
    return arrivalDistribution(people, year);
  }, [members, year]);

  if (dist.days.length === 0) {
    return (
      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600}>
          Arrivals
        </Text>
        <Text size="sm" c="dimmed">
          Nobody has said when they're arriving yet
          {dist.undated > 0 ? ` (${dist.undated} still to answer)` : ""}. Once
          people fill in their dates this shows how many are on site each day.
        </Text>
      </Paper>
    );
  }

  // Scale to the tallest STACK (known + projected) so the projected band can't
  // overflow the plot when half the roster hasn't answered.
  const peak = Math.max(...dist.days.map((d) => d.onSite + d.projected), 1);

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-end" wrap="wrap" mb="xs">
        <div>
          <Text size="sm" fw={600}>
            Arrivals
          </Text>
          <Text size="xs" c="dimmed">
            How many people are here each day. Above each bar is who arrives
            that day; below it, the number we know and — when dates are missing
            — the estimated total.
          </Text>
        </div>
        {dist.fullest ? (
          <Text size="xs" c="dimmed">
            Fullest: <b>{dist.fullest.long}</b> (
            {dist.fullest.projected > 0
              ? // A range, not a point — with dates missing, a single number
                // here would be the most confident-looking lie on the page.
                `${dist.fullest.onSite} known, up to ~${
                  dist.fullest.onSite + dist.fullest.projected
                }`
              : `${dist.fullest.onSite} people`}
            )
            {dist.busiest ? (
              <>
                {" · "}Most arrivals: <b>{dist.busiest.long}</b> (
                {dist.busiest.arriving})
              </>
            ) : null}
          </Text>
        ) : null}
      </Group>

      <Group gap={4} align="flex-end" wrap="wrap">
        {dist.days.map((d) => (
          <Stack key={d.iso} gap={2} align="center" style={{ width: 40 }}>
            <Text size="xs" c={d.arriving > 0 ? undefined : "dimmed"} fw={600}>
              {d.arriving > 0 ? `+${d.arriving}` : "·"}
            </Text>
            {/* Two stacked segments: the solid one is counted people, the
                faint outlined one is the estimate for those who haven't given
                dates. Deliberately different in FILL, not just shade, so the
                guess never reads as part of the count. */}
            <div style={{ width: "100%" }}>
              {d.projected > 0 ? (
                <div
                  style={{
                    width: "100%",
                    height: Math.max(2, Math.round((d.projected / peak) * 56)),
                    borderRadius: "3px 3px 0 0",
                    background: `repeating-linear-gradient(45deg, var(--mantine-color-${d.color}-5) 0 2px, transparent 2px 5px)`,
                    opacity: 0.55,
                    boxSizing: "border-box",
                  }}
                />
              ) : null}
              <div
                // Proportional to the fullest day. A minimum of 2px so a day
                // with one person still reads as a day rather than a gap.
                style={{
                  width: "100%",
                  height: Math.max(2, Math.round((d.onSite / peak) * 56)),
                  borderRadius: d.projected > 0 ? "0 0 3px 3px" : 3,
                  background: `var(--mantine-color-${d.color}-5)`,
                  // Same dashed-means-setup channel the date chips use, so the
                  // two readings of "before gates open" match.
                  border: dayChipBorder(d.setup),
                  boxSizing: "border-box",
                }}
              />
            </div>
            <Text size="xs" c="dimmed">
              {d.short}
            </Text>
            {/* Both numbers, matching the two bar segments: the count we have,
                then the estimated total. One number alone was the problem —
                the bar showed an estimate the figures didn't. */}
            <Text size="xs" fw={600} lh={1.1}>
              {d.onSite}
            </Text>
            {d.projected > 0 ? (
              <Text size="xs" c="dimmed" lh={1.1}>
                ~{d.onSite + d.projected}
              </Text>
            ) : null}
          </Stack>
        ))}
      </Group>

      <Text size="xs" c="dimmed" mt="xs">
        Dashed bars are setup days, before gates open. Solid = counted.
        {dist.undated > 0 ? (
          <>
            {" "}
            Hatched ={" "}
            <b>
              estimate for the {dist.undated}{" "}
              {dist.undated === 1 ? "person" : "people"}
            </b>{" "}
            who {dist.undated === 1 ? "hasn't" : "haven't"} given dates, spread
            the same way as everyone who has. Treat it as a rough ceiling —
            people who haven't answered are the least likely to be here for
            setup, so the early days are probably overstated.
          </>
        ) : (
          ""
        )}
      </Text>
    </Paper>
  );
}

function Stat({
  value,
  label,
  strong,
}: {
  value: number;
  label: string;
  strong?: boolean;
}) {
  return (
    <Card withBorder padding="md" radius="md">
      <Text size="xl" fw={strong ? 800 : 700} c={strong ? undefined : "dimmed"}>
        {value}
      </Text>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Card>
  );
}

type PartyGuest = {
  id: string;
  name: string;
  arrivalDate: string | null;
  departureDate: string | null;
  note: string | null;
  /** A promotion link already exists for this guest — durable, not transient. */
  inviteLink?: string | null;
  /** They've signed up through it, so their plus-one slot became a real member. */
  inviteRedeemed?: boolean;
};

/** Self-service management of the viewer's own party (guests they bring). */
type PartyPerson = { membershipId: string; name: string };

/**
 * "Who are you camping with?" — the member-to-member half of a party, as
 * opposed to `MyParty` below, which is about people with no account.
 *
 * Both directions live in one card because they're the same fact seen from
 * either end, and because they're mutually exclusive: parties are one level
 * deep, so someone listed under another member can't also anchor a household.
 * Showing only the applicable half keeps that rule from having to be explained.
 */
function CampingWith({
  partyHost,
  partyMembers,
  candidates,
  myMembershipId,
}: {
  partyHost: PartyPerson | null;
  partyMembers: PartyPerson[];
  candidates: PartyPerson[];
  myMembershipId: string;
}) {
  const fetcher = useFetcher<FetcherData>();
  // Two pickers, not one with two buttons: which direction you pick decides who
  // can manage whose tickets, so it has to be an explicit choice rather than a
  // property of which button you happened to hit.
  const [addPick, setAddPick] = useState<string | null>(null);
  const [joinPick, setJoinPick] = useState<string | null>(null);
  useFetcherNotifications(fetcher.data, fetcher.state, () => {
    setAddPick(null);
    setJoinPick(null);
  });
  const busy = fetcher.state !== "idle";
  const options = candidates.map((c) => ({
    value: c.membershipId,
    label: c.name,
  }));

  const link = (membershipId: string, hostMembershipId: string) =>
    fetcher.submit(
      { intent: "setPartyHost", membershipId, hostMembershipId },
      { method: "post" },
    );
  const unlink = (membershipId: string) =>
    fetcher.submit(
      { intent: "setPartyHost", membershipId, hostMembershipId: "" },
      { method: "post" },
    );

  return (
    <Card withBorder padding="lg" radius="md">
      <Text fw={600} mb={4}>
        Who you're camping with
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        For someone in camp who has their own account but is here as part of
        your household — sharing your tent or RV, arriving together. Whoever
        anchors the party can sort out tickets and setup passes for everyone in
        it, and each person can still manage their own.
      </Text>

      {partyHost ? (
        <Group gap="sm" wrap="wrap">
          <Text size="sm">
            You're listed as part of <b>{partyHost.name}</b>'s party.
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            loading={busy}
            onClick={() => unlink(myMembershipId)}
          >
            We're not together
          </Button>
        </Group>
      ) : (
        <>
          {partyMembers.length > 0 ? (
            <Stack gap="xs" mb="md">
              {partyMembers.map((p) => (
                <Group key={p.membershipId} gap="sm" wrap="wrap">
                  <Text size="sm">{p.name}</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    loading={busy}
                    onClick={() => unlink(p.membershipId)}
                  >
                    Remove from your party
                  </Button>
                </Group>
              ))}
            </Stack>
          ) : null}

          <Group gap="sm" align="flex-end" wrap="wrap">
            <Select
              label="Add someone to your party"
              description="You'll be able to sort out their ticket and setup pass"
              placeholder="Pick a member"
              searchable
              clearable
              value={addPick}
              onChange={setAddPick}
              data={options}
              nothingFoundMessage="Nobody available"
              style={{ minWidth: 240 }}
            />
            <Button
              disabled={!addPick}
              loading={busy}
              onClick={() => addPick && link(addPick, myMembershipId)}
            >
              Add to my party
            </Button>
          </Group>

          {partyMembers.length === 0 ? (
            <Group gap="sm" align="flex-end" wrap="wrap" mt="md">
              <Select
                label="Or join someone else's party"
                description="They'll be able to sort out yours"
                placeholder="Pick a member"
                searchable
                clearable
                value={joinPick}
                onChange={setJoinPick}
                data={options}
                nothingFoundMessage="Nobody available"
                style={{ minWidth: 240 }}
              />
              <Button
                variant="light"
                disabled={!joinPick}
                loading={busy}
                onClick={() => joinPick && link(myMembershipId, joinPick)}
              >
                Join their party
              </Button>
            </Group>
          ) : null}

          <Text size="xs" c="dimmed" mt="md">
            Only people who aren't already in someone else's party are listed —
            a party is one level deep, so it always has a single anchor.
          </Text>
        </>
      )}
    </Card>
  );
}

function MyParty({ guests, year }: { guests: PartyGuest[]; year: number }) {
  const addFetcher = useFetcher<FetcherData>();
  const rowFetcher = useFetcher<FetcherData>();
  const promoteFetcher = useFetcher<FetcherData>();
  const addRef = useRef<HTMLFormElement>(null);
  const [edit, setEdit] = useState<PartyGuest | null>(null);

  useFetcherNotifications(addFetcher.data, addFetcher.state, () =>
    addRef.current?.reset(),
  );
  useFetcherNotifications(rowFetcher.data, rowFetcher.state, () =>
    setEdit(null),
  );
  const promoteLink = promoteFetcher.data?.promoteLink ?? null;

  return (
    <Card withBorder padding="lg" radius="md">
      <Text fw={600} mb={4}>
        Your party
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        Bringing people who don't have their own account (a partner, a friend)?
        Add them here so they're counted and can be placed on the map. Each one
        can get their own <b>sign-up link</b> — when they use it, their spot in
        your party turns into their own account, so the camp doesn't end up
        counting them twice.
      </Text>

      {guests.length > 0 ? (
        <Stack gap="sm" mb="md">
          {guests.map((g) => (
            <Paper key={g.id} withBorder p="xs" radius="sm">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                  <Text size="sm">
                    {g.name}
                    {g.note ? (
                      <Text span c="dimmed" size="xs">
                        {" "}
                        — {g.note}
                      </Text>
                    ) : null}
                  </Text>
                  <DayRange
                    arrival={g.arrivalDate}
                    departure={g.departureDate}
                    year={year}
                  />
                  {g.inviteRedeemed ? (
                    <Badge size="xs" color="green" variant="light">
                      has their own account
                    </Badge>
                  ) : g.inviteLink ? (
                    <Badge size="xs" color="blue" variant="light">
                      link sent, not used yet
                    </Badge>
                  ) : null}
                </Group>
                <Group gap="xs" wrap="wrap">
                  {!g.inviteLink && !g.inviteRedeemed ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      loading={promoteFetcher.state !== "idle"}
                      onClick={() =>
                        promoteFetcher.submit(
                          { intent: "promoteGuest", guestId: g.id },
                          { method: "post" },
                        )
                      }
                    >
                      Get their sign-up link
                    </Button>
                  ) : null}
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setEdit(g)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      rowFetcher.submit(
                        { intent: "removeGuest", guestId: g.id },
                        { method: "post" },
                      )
                    }
                  >
                    Remove
                  </Button>
                </Group>
              </Group>
              {/* The link persists with the page rather than only living in a
                  fetcher response that disappears on the next navigation —
                  that disappearing act is what made this feature "confusing".
                  Redeemed links are not re-offered: they're one-use. */}
              {g.inviteLink && !g.inviteRedeemed ? (
                <Group gap="xs" mt={6} wrap="wrap">
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ wordBreak: "break-all", flex: 1, minWidth: 0 }}
                  >
                    {g.inviteLink}
                  </Text>
                  <CopyButton value={g.inviteLink}>
                    {({ copied, copy }) => (
                      <Button size="compact-xs" variant="light" onClick={copy}>
                        {copied ? "Copied" : "Copy link"}
                      </Button>
                    )}
                  </CopyButton>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    component="a"
                    href={`sms:?&body=${encodeURIComponent(
                      `Here's your sign-up link for camp: ${g.inviteLink}`,
                    )}`}
                  >
                    Text it
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    component="a"
                    href={`mailto:?subject=${encodeURIComponent(
                      "Your camp sign-up link",
                    )}&body=${encodeURIComponent(
                      `Here's your sign-up link for camp: ${g.inviteLink}`,
                    )}`}
                  >
                    Email it
                  </Button>
                </Group>
              ) : null}
            </Paper>
          ))}
        </Stack>
      ) : null}

      {promoteLink ? (
        <Card
          withBorder
          radius="md"
          padding="md"
          mb="md"
          bg="var(--mantine-color-default-hover)"
        >
          <Text size="sm" fw={600}>
            Invite link for {promoteFetcher.data?.promoteName ?? "your guest"}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            Send them this link — signing up through it turns their guest spot
            into a real account (their RSVP, tent spot, tickets, and passes come
            along).
          </Text>
          <Group gap="sm" wrap="wrap">
            <Text size="sm" style={{ wordBreak: "break-all" }}>
              {promoteLink}
            </Text>
            <CopyButton value={promoteLink}>
              {({ copied, copy }) => (
                <Button
                  size="compact-xs"
                  variant="light"
                  color={copied ? "green" : "blue"}
                  onClick={copy}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
              )}
            </CopyButton>
          </Group>
        </Card>
      ) : null}

      <addFetcher.Form method="post" ref={addRef}>
        <input type="hidden" name="intent" value="addGuest" />
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput
            name="name"
            label="Add someone to your party"
            placeholder="Full name"
            w={{ base: "100%", xs: 220 }}
            maxLength={MAX_NAME}
            required
          />
          <TextInput
            name="arrivalDate"
            type="date"
            label="Arrives"
            w={{ base: "48%", xs: 150 }}
          />
          <TextInput
            name="departureDate"
            type="date"
            label="Departs"
            w={{ base: "48%", xs: 150 }}
          />
          <Button type="submit" loading={addFetcher.state !== "idle"}>
            Add
          </Button>
        </Group>
      </addFetcher.Form>

      <Modal
        opened={edit !== null}
        onClose={() => setEdit(null)}
        title="Edit party member"
        centered
      >
        {edit ? (
          <EditGuestForm
            guest={edit}
            fetcher={rowFetcher}
            onCancel={() => setEdit(null)}
          />
        ) : null}
      </Modal>
    </Card>
  );
}

function EditGuestForm({
  guest,
  fetcher,
  onCancel,
}: {
  guest: PartyGuest;
  fetcher: ReturnType<typeof useFetcher<FetcherData>>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(guest.name);
  const [note, setNote] = useState(guest.note ?? "");
  // The dates MUST be in this form: `updateGuest` writes whatever the submit
  // carries, so an edit that omitted them silently cleared the guest's arrival
  // and departure.
  const [arrivalDate, setArrivalDate] = useState(guest.arrivalDate ?? "");
  const [departureDate, setDepartureDate] = useState(guest.departureDate ?? "");
  return (
    <Stack gap="md">
      <TextInput
        label="Name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        maxLength={MAX_NAME}
      />
      <Group grow align="flex-start">
        <TextInput
          type="date"
          label="Arrives"
          value={arrivalDate}
          onChange={(e) => setArrivalDate(e.currentTarget.value)}
        />
        <TextInput
          type="date"
          label="Departs"
          value={departureDate}
          onChange={(e) => setDepartureDate(e.currentTarget.value)}
        />
      </Group>
      <Textarea
        label="Note"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
        maxLength={MAX_NOTE}
        autosize
        minRows={2}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!name.trim()}
          loading={fetcher.state !== "idle"}
          onClick={() =>
            fetcher.submit(
              {
                intent: "updateGuest",
                guestId: guest.id,
                name,
                note,
                arrivalDate,
                departureDate,
              },
              { method: "post" },
            )
          }
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}

/** One arrival/departure date as a weekday chip. Color = day of week, dashed
 * border = setup (before gates open) — both spelled out in `DayLegend`. */
function DayCell({ iso, year }: { iso: string | null; year: number }) {
  const chip = dayChip(iso, year);
  if (!chip)
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  return (
    // The weekday is the answer; the exact date is a detail, so it moves behind
    // a tap. `events.touch` matters — a hover-only tooltip would put the date
    // out of reach on a phone, which is exactly why `title=` is banned here.
    <Tooltip
      label={`${chip.long} ${chip.iso}${chip.setup ? " · setup" : ""}`}
      withArrow
      events={{ hover: true, focus: true, touch: true }}
    >
      <Badge
        variant="light"
        color={chip.color}
        size="sm"
        style={{ border: dayChipBorder(chip.setup), cursor: "help" }}
      >
        {chip.short}
        {/* Read out in full rather than made a tab stop: two chips per row
            would add ~70 stops to this table for a secondary detail. */}
        <VisuallyHidden>
          {" "}
          {chip.long} {chip.iso}
          {chip.setup ? " (setup)" : ""}
        </VisuallyHidden>
      </Badge>
    </Tooltip>
  );
}

/** Compact "Thu → Mon" for places without their own columns (a guest badge, a
 * party row). Plain text, so it nests inside a Badge. */
function DayRange({
  arrival,
  departure,
  year,
}: {
  arrival: string | null;
  departure: string | null;
  year: number;
}) {
  const a = dayChip(arrival, year);
  const d = dayChip(departure, year);
  if (!a && !d) return null;
  // "(setup)" hangs off the arrival, not the end of the range — it qualifies
  // when they show up, and a reader shouldn't have to work that out.
  const arrives = a ? `${a.short}${a.setup ? " (setup)" : ""}` : null;
  return (
    <Text span size="xs" c="dimmed">
      {arrives && d
        ? `${arrives} → ${d.short}`
        : arrives
          ? `arrives ${arrives}`
          : `departs ${d?.short}`}
    </Text>
  );
}

/** What the chip colors and borders mean — the page can't lean on a tooltip. */
function DayLegend({ year }: { year: number }) {
  return (
    <Group gap="lg" wrap="wrap">
      <Text size="xs" c="dimmed">
        Chips are colored by day of the week.
      </Text>
      <Group gap={6} wrap="nowrap">
        <Badge
          variant="light"
          color="gray"
          size="sm"
          style={{ border: dayChipBorder(true) }}
        >
          Fri
        </Badge>
        <Text size="xs" c="dimmed">
          setup — before gates open ({dateLabel(eventStartIso(year))})
        </Text>
      </Group>
      <Group gap={6} wrap="nowrap">
        <Badge
          variant="light"
          color="gray"
          size="sm"
          style={{ border: dayChipBorder(false) }}
        >
          Wed
        </Badge>
        <Text size="xs" c="dimmed">
          during the event
        </Text>
      </Group>
    </Group>
  );
}

function RosterTableInner({
  members,
  myMembershipId,
  locked,
  year,
  mapVisible,
  onClaim,
  selected,
  onSelect,
  onHover,
  selectable,
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
  year: number;
  mapVisible: boolean;
  onClaim: (guest: { id: string; name: string }) => void;
  selected: string | null;
  onSelect: (membershipId: string | null) => void;
  onHover: (membershipId: string | null) => void;
  /** Whether rows drive the mini-map at all (no map, no interaction). */
  selectable: boolean;
}) {
  return (
    <Table.ScrollContainer minWidth={mapVisible ? 920 : 820}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>RSVP</Table.Th>
            <Table.Th>Arrives</Table.Th>
            <Table.Th>Departs</Table.Th>
            <Table.Th>Party</Table.Th>
            {mapVisible ? <Table.Th>Where</Table.Th> : null}
          </Table.Tr>
        </Table.Thead>
        {/* Clearing the hover preview belongs to the whole body, not each row:
            per-row it fires on every row-to-row move, flashing the map back to
            full brightness between rows. */}
        <Table.Tbody
          onMouseLeave={selectable ? () => onHover(null) : undefined}
        >
          {members.map((m) => {
            const st = STATUS_META[m.status];
            const isHost = m.membershipId === myMembershipId;
            // Only rows with something placed do anything, so a click that
            // couldn't change the map isn't offered as if it could.
            // Every row is selectable, including people with nothing placed —
            // "none of this is theirs" (a fully dimmed map) is a real answer,
            // and it stops the map snapping back to full brightness as the
            // pointer crosses those rows.
            const canSelect = selectable;
            const isSelected = selected === m.membershipId;
            const toggle = () => onSelect(isSelected ? null : m.membershipId);
            return (
              <Table.Tr
                key={m.membershipId}
                onClick={
                  canSelect
                    ? (e) => {
                        // The row owns the click, but not on top of its own
                        // links and buttons ("That's me", the map link).
                        if ((e.target as HTMLElement).closest("a,button"))
                          return;
                        toggle();
                      }
                    : undefined
                }
                onMouseEnter={
                  canSelect ? () => onHover(m.membershipId) : undefined
                }
                onKeyDown={
                  canSelect
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggle();
                        }
                      }
                    : undefined
                }
                tabIndex={canSelect ? 0 : undefined}
                aria-pressed={canSelect ? isSelected : undefined}
                style={
                  canSelect
                    ? {
                        cursor: "pointer",
                        background: isSelected
                          ? "var(--mantine-color-default-hover)"
                          : undefined,
                      }
                    : undefined
                }
              >
                <Table.Td>
                  <Text size="sm">
                    {m.name}
                    {m.playaName ? (
                      <Text span c="dimmed" size="xs">
                        {" "}
                        “{m.playaName}”
                      </Text>
                    ) : null}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={st.color} variant="light" size="sm">
                    {st.label}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <DayCell iso={m.arrivalDate} year={year} />
                </Table.Td>
                <Table.Td>
                  <DayCell iso={m.departureDate} year={year} />
                </Table.Td>
                <Table.Td>
                  {m.guests.length === 0 &&
                  m.partyMembers.length === 0 &&
                  !m.partyHost ? (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  ) : (
                    // wrap (not nowrap) so a long party doesn't blow out the
                    // row on a phone.
                    <Group gap={6} wrap="wrap">
                      {/* Reads from this row's side: whose household this
                          person belongs to, or who belongs to theirs. Members
                          keep the default colour so they stay visibly distinct
                          from grape guests — they have their own accounts. */}
                      {m.partyHost ? (
                        <Badge variant="outline" size="sm">
                          with {m.partyHost.name}
                        </Badge>
                      ) : null}
                      {m.partyMembers.map((p) => (
                        <Badge key={p.membershipId} variant="light" size="sm">
                          {p.name}
                        </Badge>
                      ))}
                      {m.guests.length > 0 ? (
                        <Text size="sm">+{m.guests.length}</Text>
                      ) : null}
                      {m.guests.map((g) => (
                        <Badge
                          key={g.id}
                          variant="light"
                          color="grape"
                          size="sm"
                        >
                          {g.name}
                          {g.arrivalDate || g.departureDate ? " · " : ""}
                          <DayRange
                            arrival={g.arrivalDate}
                            departure={g.departureDate}
                            year={year}
                          />
                        </Badge>
                      ))}
                      {/* Someone listed under another member who now has their
                          own account can un-double-count themselves here. */}
                      {!locked && !isHost
                        ? m.guests.map((g) => (
                            <Button
                              key={`claim-${g.id}`}
                              size="compact-xs"
                              variant="subtle"
                              onClick={() =>
                                onClaim({ id: g.id, name: g.name })
                              }
                            >
                              {m.guests.length === 1
                                ? "That's me"
                                : `“${g.name}” is me`}
                            </Button>
                          ))
                        : null}
                    </Group>
                  )}
                </Table.Td>
                {mapVisible ? (
                  <Table.Td>
                    {m.mapItems > 0 ? (
                      // Deep-links the map with this whole party highlighted —
                      // the member's own structures plus anything their guests
                      // occupy. Someone in another member's party is keyed under
                      // that host, so link there or the map lights up nothing.
                      // No link when nothing is placed, rather than a link to a
                      // map with nothing lit up.
                      <Anchor
                        component={Link}
                        to={`/map?party=${m.partyHost?.membershipId ?? m.membershipId}`}
                        size="sm"
                      >
                        {m.mapItems} on map
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        not placed
                      </Text>
                    )}
                  </Table.Td>
                ) : null}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * Wraps the roster table with the "that plus-one is me" flow. Kept separate so
 * the table itself stays a pure render of loader data.
 */
function RosterTable({
  members,
  myMembershipId,
  locked,
  year,
  mapVisible,
  mapLot,
  mapObjects,
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
  year: number;
  mapVisible: boolean;
  mapLot: Route.ComponentProps["loaderData"]["mapLot"];
  mapObjects: Route.ComponentProps["loaderData"]["mapObjects"];
}) {
  const claimFetcher = useFetcher<FetcherData>();
  const [claiming, setClaiming] = useState<{ id: string; name: string } | null>(
    null,
  );
  // "Who's coming" means the people who are coming. Not-coming and no-reply
  // members are the whole camp list wearing a gray badge — they drown the page
  // and belong on /members. Still reachable behind the toggle, since chasing
  // no-replies is a real officer job.
  const [showAll, setShowAll] = useState(false);
  // Which party the mini-map is lighting up. SELECTION, not hover: a hover-only
  // highlight doesn't exist on a touch screen. Hover merely previews it on a
  // device that has a pointer, and never clobbers an explicit selection.
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  useFetcherNotifications(claimFetcher.data, claimFetcher.state, () =>
    setClaiming(null),
  );

  const { shown, notComing, noReply } = useMemo(() => {
    // A member who declined but still anchors a party stays visible — the rest
    // of that household is coming, and hiding the host would hide (and orphan)
    // them. That holds for members attending as part of their party just as
    // much as for guests they brought.
    // Belonging to a party counts too, in both directions: someone added to a
    // household hasn't necessarily RSVP'd yet, and dropping them out of the
    // shown roster hides the very link that was just made.
    const coming = (m: (typeof members)[number]) =>
      m.status === "coming" ||
      m.status === "maybe" ||
      m.guests.length > 0 ||
      m.partyMembers.length > 0 ||
      m.partyHost !== null;
    const sorted = [...members].sort((a, b) => {
      const rank = (m: typeof a) => (coming(m) ? 0 : 1);
      return (
        rank(a) - rank(b) ||
        arrivalSortKey(a.arrivalDate).localeCompare(
          arrivalSortKey(b.arrivalDate),
        ) ||
        a.name.localeCompare(b.name)
      );
    });
    return {
      shown: showAll ? sorted : sorted.filter(coming),
      notComing: members.filter((m) => !coming(m) && m.status === "not_coming")
        .length,
      noReply: members.filter((m) => !coming(m) && m.status === "unknown")
        .length,
    };
  }, [members, showAll]);

  const hidden = notComing + noReply;

  // Hover only previews while nothing is pinned, so a stray mouse crossing the
  // table can't silently replace what you chose.
  const active = selected ?? hovered;
  const activeMember = active
    ? (members.find((m) => m.membershipId === active) ?? null)
    : null;

  return (
    <Stack gap="xs">
      {mapVisible && mapLot && mapObjects.length > 0 ? (
        <Paper withBorder radius="md" p="sm">
          <Group justify="space-between" align="center" mb={6} wrap="wrap">
            <Text size="sm" fw={600}>
              {activeMember
                ? `${activeMember.name}'s party on the map`
                : "Camp map"}
            </Text>
            <Group gap="sm" wrap="nowrap">
              <Text size="xs" c="dimmed">
                {!activeMember
                  ? "Pick someone below to light up their spot"
                  : activeMember.mapObjectIds.length === 0
                    ? // The dimmed map is the answer here, so say what it means.
                      "Nothing of theirs is placed yet"
                    : `${activeMember.mapObjectIds.length} highlighted`}
              </Text>
              {selected ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setSelected(null)}
                >
                  Clear
                </Button>
              ) : null}
            </Group>
          </Group>
          <CampMapView
            lot={mapLot}
            objects={mapObjects}
            highlightIds={
              activeMember ? new Set(activeMember.mapObjectIds) : null
            }
            label={
              !activeMember
                ? "Camp map"
                : activeMember.mapObjectIds.length === 0
                  ? `Camp map — nothing of ${activeMember.name}'s is placed`
                  : `Camp map with ${activeMember.name}'s structures highlighted`
            }
          />
        </Paper>
      ) : null}

      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <DayLegend year={year} />
        {hidden > 0 ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed">
              {[
                notComing ? `${notComing} not coming` : null,
                noReply ? `${noReply} no reply` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Hide them" : "Show them"}
            </Button>
          </Group>
        ) : null}
      </Group>

      <RosterTableInner
        members={shown}
        myMembershipId={myMembershipId}
        locked={locked}
        year={year}
        mapVisible={mapVisible}
        onClaim={setClaiming}
        selected={selected}
        onSelect={setSelected}
        onHover={setHovered}
        selectable={mapVisible && !!mapLot && mapObjects.length > 0}
      />
      <Modal
        opened={claiming !== null}
        onClose={() => setClaiming(null)}
        title="Is this you?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            You're saying <strong>{claiming?.name}</strong> — currently listed
            as someone else's guest — is you. That entry will be merged into
            your account, so you stop being counted twice, and anything attached
            to it (a tent spot, ticket, or setup pass) comes with you.
          </Text>
          <Text size="xs" c="dimmed">
            Only do this if it's genuinely you. Officers can see the result.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setClaiming(null)}>
              Cancel
            </Button>
            <Button
              loading={claimFetcher.state !== "idle"}
              onClick={() => {
                if (claiming)
                  claimFetcher.submit(
                    { intent: "claimGuest", guestId: claiming.id },
                    { method: "post" },
                  );
              }}
            >
              Yes, that's me
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function useFetcherNotifications(
  fetcherData: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !fetcherData || fetcherData === seen.current)
      return;
    seen.current = fetcherData;
    if (fetcherData.error) {
      notifications.show({
        color: "red",
        title: "Error",
        message: fetcherData.error,
      });
    } else if (fetcherData.ok) {
      notifications.show({ title: "Done", message: fetcherData.ok });
      onOk?.();
    }
  }, [fetcherData, state, onOk]);
}
