import {
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  CopyButton,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useRef, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import {
  type AttendeeStatus,
  addGuest,
  getGuest,
  loadRoster,
  removeGuest,
  updateGuest,
} from "~/lib/attendee.server";
import { PUBLIC_BASE_URL } from "~/lib/env.server";
import { requireFeature } from "~/lib/features.server";
import { getOrCreatePromotionInvite } from "~/lib/invite.server";
import { claimGuestAsMember } from "~/lib/merge.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
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
  const myMembershipId = active.membership.id;
  const me = members.find((m) => m.membershipId === myMembershipId) ?? null;
  return redact(privacy, {
    members,
    headcount,
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
  const { members, headcount, myGuests, locked, year, myMembershipId } =
    loaderData;

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

        {!locked ? <MyParty guests={myGuests} /> : null}

        <RosterTable
          members={members}
          myMembershipId={myMembershipId}
          locked={locked}
        />
      </Stack>
    </Container>
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

/** Self-service management of the viewer's own party (guests they bring). */
function MyParty({
  guests,
}: {
  guests: { id: string; name: string; note: string | null }[];
}) {
  const addFetcher = useFetcher<FetcherData>();
  const rowFetcher = useFetcher<FetcherData>();
  const promoteFetcher = useFetcher<FetcherData>();
  const addRef = useRef<HTMLFormElement>(null);
  const [edit, setEdit] = useState<{
    id: string;
    name: string;
    note: string | null;
  } | null>(null);

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
              <Text size="sm">
                {g.name}
                {g.note ? (
                  <Text span c="dimmed" size="xs">
                    {" "}
                    — {g.note}
                  </Text>
                ) : null}
              </Text>
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
                  onClick={() =>
                    setEdit({ id: g.id, name: g.name, note: g.note })
                  }
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
  guest: { id: string; name: string; note: string | null };
  fetcher: ReturnType<typeof useFetcher<FetcherData>>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(guest.name);
  const [note, setNote] = useState(guest.note ?? "");
  return (
    <Stack gap="md">
      <TextInput
        label="Name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        maxLength={MAX_NAME}
      />
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
              { intent: "updateGuest", guestId: guest.id, name, note },
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

function RosterTableInner({
  members,
  myMembershipId,
  locked,
  onClaim,
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
  onClaim: (guest: { id: string; name: string }) => void;
}) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>RSVP</Table.Th>
            <Table.Th>Arrives</Table.Th>
            <Table.Th>Party</Table.Th>
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
                  <Text size="sm" c="dimmed">
                    {m.arrivalDate ?? "—"}
                  </Text>
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
}: {
  members: Route.ComponentProps["loaderData"]["members"];
  myMembershipId: string | null;
  locked: boolean;
}) {
  const claimFetcher = useFetcher<FetcherData>();
  const [claiming, setClaiming] = useState<{ id: string; name: string } | null>(
    null,
  );
  useFetcherNotifications(claimFetcher.data, claimFetcher.state, () =>
    setClaiming(null),
  );

  return (
    <>
      <RosterTableInner
        members={members}
        myMembershipId={myMembershipId}
        locked={locked}
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
    </>
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
