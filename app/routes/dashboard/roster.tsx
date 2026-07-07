import {
  Badge,
  Button,
  Card,
  Container,
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
import { data, useFetcher } from "react-router";
import {
  type AttendeeStatus,
  addGuest,
  getGuest,
  loadRoster,
  removeGuest,
  updateGuest,
} from "~/lib/attendee.server";
import { hasAtLeast } from "~/lib/permissions";
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
  const { active, activeEdition } = await requireActiveEdition(request);
  const { members, headcount } = await loadRoster(
    active.camp.id,
    activeEdition.id,
  );
  const myMembershipId = active.membership.id;
  const me = members.find((m) => m.membershipId === myMembershipId) ?? null;
  return {
    members,
    headcount,
    myMembershipId,
    myGuests: me?.guests ?? [],
    myStatus: me?.status ?? ("unknown" as AttendeeStatus),
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    locked: activeEdition.locked,
    year: activeEdition.year,
  };
}

const MAX_NAME = 120;
const MAX_NOTE = 500;

function cleanDate(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
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

  if (intent === "updateGuest" || intent === "removeGuest") {
    const guestId = String(form.get("guestId"));
    const guest = await getGuest(campId, editionId, guestId);
    if (!guest) return data({ error: "Guest not found." }, { status: 404 });
    // A guest is editable by their host or an officer.
    if (guest.hostMembershipId !== myMid && !isOfficer) {
      return data({ error: "Not your guest." }, { status: 403 });
    }
    if (intent === "removeGuest") {
      await removeGuest(guestId);
      return data({ ok: "Removed." });
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

type FetcherData = { ok?: string; error?: string };

export default function Roster({ loaderData }: Route.ComponentProps) {
  const { members, headcount, myGuests, locked, year } = loaderData;

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <Title order={2}>Who's coming · {year}</Title>
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

        <RosterTable members={members} />
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

function RosterTable({
  members,
}: {
  members: Route.ComponentProps["loaderData"]["members"];
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
                    <Text size="sm">
                      +{m.guests.length}
                      <Text span c="dimmed" size="xs">
                        {" "}
                        ({m.guests.map((g) => g.name).join(", ")})
                      </Text>
                    </Text>
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
