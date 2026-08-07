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
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, data, useFetcher } from "react-router";
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
  loadRoster,
  removeGuest,
  updateGuest,
} from "~/lib/attendee.server";
import { eventStartIso } from "~/lib/brc";
import { PUBLIC_BASE_URL } from "~/lib/env.server";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState, requireFeature } from "~/lib/features.server";
import { getOrCreatePromotionInvite } from "~/lib/invite.server";
import { claimGuestAsMember } from "~/lib/merge.server";
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
  const myMembershipId = active.membership.id;
  const me = members.find((m) => m.membershipId === myMembershipId) ?? null;
  return redact(privacy, {
    members: members.map((m) => ({
      ...m,
      mapItems: mapCounts.get(m.membershipId)?.length ?? 0,
    })),
    headcount,
    mapVisible,
    myMembershipId,
    myGuests: me?.guests ?? [],
    myStatus: me?.status ?? ("unknown" as AttendeeStatus),
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
    // A guest is editable by their host or an officer.
    if (guest.hostMembershipId !== myMid && !isOfficer) {
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

        {!locked ? <MyParty guests={myGuests} year={year} /> : null}

        <RosterTable
          members={members}
          myMembershipId={myMembershipId}
          locked={locked}
          year={year}
          mapVisible={mapVisible}
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

  const peak = Math.max(...dist.days.map((d) => d.onSite), 1);

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-end" wrap="wrap" mb="xs">
        <div>
          <Text size="sm" fw={600}>
            Arrivals
          </Text>
          <Text size="xs" c="dimmed">
            How many people are here each day — the bar is who's on site, the
            number above it is who arrives that day.
          </Text>
        </div>
        {dist.fullest ? (
          <Text size="xs" c="dimmed">
            Fullest: <b>{dist.fullest.long}</b> ({dist.fullest.onSite} people)
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
            <div
              // Proportional to the fullest day. A minimum of 2px so a day with
              // one person still reads as a day rather than a gap.
              style={{
                width: "100%",
                height: Math.max(2, Math.round((d.onSite / peak) * 56)),
                borderRadius: 3,
                background: `var(--mantine-color-${d.color}-5)`,
                // Same dashed-means-setup channel the date chips use, so the
                // two readings of "before gates open" match.
                border: dayChipBorder(d.setup),
                boxSizing: "border-box",
              }}
            />
            <Text size="xs" c="dimmed">
              {d.short}
            </Text>
            <Text size="xs" fw={600}>
              {d.onSite}
            </Text>
          </Stack>
        ))}
      </Group>

      <Text size="xs" c="dimmed" mt="xs">
        Dashed bars are setup days, before gates open.
        {dist.undated > 0
          ? ` ${dist.undated} ${dist.undated === 1 ? "person hasn't" : "people haven't"} given dates yet, so the real numbers are higher.`
          : ""}
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
};

/** Self-service management of the viewer's own party (guests they bring). */
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
        Add them here so they're counted and can be placed on the map. They can
        be promoted to a full account later.
      </Text>

      {guests.length > 0 ? (
        <Stack gap="xs" mb="md">
          {guests.map((g) => (
            <Group key={g.id} justify="space-between" wrap="nowrap">
              <Group gap={6} wrap="wrap">
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
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  loading={promoteFetcher.state !== "idle"}
                  onClick={() =>
                    promoteFetcher.submit(
                      { intent: "promoteGuest", guestId: g.id },
                      { method: "post" },
                    )
                  }
                >
                  Invite to join
                </Button>
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
    <Group gap={6} wrap="nowrap">
      <Badge
        variant="light"
        color={chip.color}
        size="sm"
        style={{ border: dayChipBorder(chip.setup) }}
      >
        {chip.short}
      </Badge>
      <Text size="xs" c="dimmed">
        {chip.iso}
      </Text>
    </Group>
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
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
  year: number;
  mapVisible: boolean;
  onClaim: (guest: { id: string; name: string }) => void;
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
        <Table.Tbody>
          {members.map((m) => {
            const st = STATUS_META[m.status];
            const isHost = m.membershipId === myMembershipId;
            return (
              <Table.Tr key={m.membershipId}>
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
                  {m.guests.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  ) : (
                    // wrap (not nowrap) so a long party doesn't blow out the
                    // row on a phone.
                    <Group gap={6} wrap="wrap">
                      <Text size="sm">+{m.guests.length}</Text>
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
                      // occupy. No link when they have nothing placed, rather
                      // than a link to a map with nothing lit up.
                      <Anchor
                        component={Link}
                        to={`/map?party=${m.membershipId}`}
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
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
  year: number;
  mapVisible: boolean;
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
  useFetcherNotifications(claimFetcher.data, claimFetcher.state, () =>
    setClaiming(null),
  );

  const { shown, notComing, noReply } = useMemo(() => {
    // A member who declined but still has guests listed stays visible — their
    // guests are coming, and hiding the host would hide (and orphan) them.
    const coming = (m: (typeof members)[number]) =>
      m.status === "coming" || m.status === "maybe" || m.guests.length > 0;
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

  return (
    <Stack gap="xs">
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
