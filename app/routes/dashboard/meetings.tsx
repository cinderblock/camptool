/**
 * Meetings — the camp's meetings for the active year: when the next one is,
 * how to join it, what's on its agenda, and the write-ups of the ones already
 * held. Design: plans/camp-meetings.md.
 *
 * A meeting is a `gathering` with `kind = "meeting"` (db/schema/schedule.ts) —
 * this page is a view over those rows, not a second scheduling system. A
 * meeting created on /schedule shows up here, and one created here shows up on
 * the Schedule calendar. Gated by the `meetings` camp feature, which requires
 * `schedule`.
 */
import {
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import {
  MEETING_CADENCES,
  MEETING_KIND,
  type MeetingCadence,
  cadenceRule,
  isMeetingCadence,
  joinLabel,
  meetingDates,
  meetingProvider,
} from "~/lib/meetings";
import { getMeetingRoom, loadMeetings } from "~/lib/meetings.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { dateLabel, isIsoDate, timeRangeLabel, todayIso } from "~/lib/schedule";
import { cleanTime, createGathering } from "~/lib/schedule.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/meetings";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Meetings · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "meetings");
  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const room = await getMeetingRoom(active.camp.id);
  return redact(privacy, {
    year: activeEdition.year,
    locked: activeEdition.locked,
    isOfficer,
    isAdmin: active.membership.role === "admin",
    room: room ? { url: room.url, label: room.label, note: room.note } : null,
    meetings: await loadMeetings({
      editionId: activeEdition.id,
      membershipId: active.membership.id,
      isOfficer,
    }),
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "meetings");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers schedule meetings." }, { status: 403 });
  }
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const form = await request.formData();
  if (String(form.get("intent")) !== "createMeeting") {
    return data({ error: "Unknown action." }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title || title.length > 200) {
    return data({ error: "Please give it a title." }, { status: 400 });
  }
  const cadence = String(form.get("cadence") ?? "once");
  if (!isMeetingCadence(cadence)) {
    return data({ error: "Unknown repeat." }, { status: 400 });
  }
  const date = String(form.get("date") ?? "");
  const endDate = String(form.get("endDate") ?? "");
  if (!isIsoDate(date)) {
    return data({ error: "Pick a date." }, { status: 400 });
  }
  const dates = meetingDates(cadence, date, endDate);
  if (dates.length === 0) {
    return data(
      {
        error:
          cadence === "once"
            ? "Pick a date."
            : "Pick a last date on or after the first.",
      },
      { status: 400 },
    );
  }

  const gatheringId = await createGathering({
    campId: active.camp.id,
    editionId: activeEdition.id,
    createdById: user.id,
    title,
    description: String(form.get("description") ?? "").trim() || null,
    kind: MEETING_KIND,
    location: String(form.get("location") ?? "").trim() || null,
    dates,
    startTime: cleanTime(form.get("startTime")),
    endTime: cleanTime(form.get("endTime")),
    // A meeting is everybody's — no capacity, no waitlist, just who's coming.
    shift: { staffing: "all_hands" },
    recurrenceRule: cadenceRule(cadence, date, endDate),
  });
  // Straight to the first meeting of the series, where the agenda lives.
  const meetings = await loadMeetings({
    editionId: activeEdition.id,
    membershipId: active.membership.id,
    isOfficer: true,
  });
  const first = meetings.find((m) => m.gatheringId === gatheringId);
  return redirect(first ? `/meetings/${first.occurrenceId}` : "/meetings");
}

type MeetingRow = Route.ComponentProps["loaderData"]["meetings"][number];

export default function Meetings({ loaderData }: Route.ComponentProps) {
  const { year, locked, isOfficer, isAdmin, room, meetings } = loaderData;
  const today = todayIso();
  const upcoming = meetings.filter((m) => m.date >= today);
  const past = meetings.filter((m) => m.date < today).reverse();
  const next = upcoming.find((m) => !m.cancelled) ?? null;
  const unreadCount = past.filter(
    (m) => m.summary?.published && !m.summary.readByMe,
  ).length;

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Meetings</Title>
          <Text c="dimmed" size="sm">
            When the camp meets in {year}, what's on the agenda, and what got
            decided.
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
              This year is locked — meetings are read-only.
            </Text>
          </Paper>
        ) : null}

        <WhatIsThis
          isOfficer={isOfficer}
          isAdmin={isAdmin}
          empty={meetings.length === 0}
          hasRoom={!!room}
        />

        {next ? (
          <NextMeeting meeting={next} room={room} />
        ) : meetings.length > 0 ? (
          <Text size="sm" c="dimmed">
            Nothing on the calendar ahead — every meeting for {year} has been
            and gone.
          </Text>
        ) : null}

        {isOfficer && !locked ? <NewMeetingForm /> : null}

        {upcoming.length > 1 ? (
          <div>
            <Text size="sm" fw={600} mb="xs">
              Also coming up
            </Text>
            <Stack gap="xs">
              {upcoming
                .filter((m) => m.occurrenceId !== next?.occurrenceId)
                .map((m) => (
                  <MeetingCard key={m.occurrenceId} m={m} />
                ))}
            </Stack>
          </div>
        ) : null}

        {past.length > 0 ? (
          <div>
            <Group gap="xs" mb="xs">
              <Text size="sm" fw={600}>
                Past meetings
              </Text>
              {unreadCount > 0 ? (
                <Badge size="xs" color="blue" variant="filled">
                  {unreadCount} summary to read
                </Badge>
              ) : null}
            </Group>
            <Stack gap="xs">
              {past.map((m) => (
                <MeetingCard key={m.occurrenceId} m={m} />
              ))}
            </Stack>
          </div>
        ) : null}
      </Stack>
    </Container>
  );
}

/** What this page is for, answered on the page rather than in a tooltip. */
function WhatIsThis({
  isOfficer,
  isAdmin,
  empty,
  hasRoom,
}: {
  isOfficer: boolean;
  isAdmin: boolean;
  empty: boolean;
  hasRoom: boolean;
}) {
  const [open, { toggle }] = useDisclosure(false);
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text size="sm">
            Camp meetings — anyone can put something on the agenda before the
            day, and whoever misses one can read what happened.
          </Text>
          {empty ? (
            <Text size="sm" c="dimmed" mt={4}>
              {isOfficer
                ? "No meetings scheduled yet. Create the first one below — a repeating one covers the whole run-up in a single go."
                : "No meetings scheduled yet. When the camp sets one, it'll show up here and you'll be able to add to its agenda."}
            </Text>
          ) : null}
          {isAdmin && !hasRoom ? (
            <Text size="sm" c="dimmed" mt={4}>
              No meeting room is set up. Add your camp's voice-channel link
              under the Meetings feature on{" "}
              <Anchor component={Link} to="/settings" size="sm">
                camp settings
              </Anchor>{" "}
              and every meeting gets a join button.
            </Text>
          ) : null}
        </div>
        <Button size="compact-xs" variant="subtle" onClick={toggle}>
          {open ? "Less" : "What's this?"}
        </Button>
      </Group>
      <Collapse in={open}>
        <Stack gap={6} mt="xs">
          <Text size="xs" c="dimmed">
            Every meeting has its own <b>agenda</b>. Add an item any time before
            the meeting — you don't need to be an officer, and you don't need to
            be there for it to get discussed. You can edit or take back anything
            you added.
          </Text>
          <Text size="xs" c="dimmed">
            The <b>join button</b> goes to whatever the camp meets on — a
            Discord voice channel, a video call, whatever's configured. It's the
            same room every time, so there's no link to hunt for.
          </Text>
          <Text size="xs" c="dimmed">
            Afterwards an officer writes a <b>summary</b>. Published summaries
            show up on your home page until you've read them, so missing a
            meeting doesn't mean missing what happened in it.
          </Text>
          <Text size="xs" c="dimmed">
            Meetings are also on the Schedule calendar alongside work parties —
            they're the same thing seen two ways, not two lists to keep in sync.
          </Text>
        </Stack>
      </Collapse>
    </Paper>
  );
}

/** The one that matters most: the next meeting, with the room and the agenda. */
function NextMeeting({
  meeting,
  room,
}: {
  meeting: MeetingRow;
  room: { url: string; label: string | null; note: string | null } | null;
}) {
  const today = todayIso();
  return (
    <Card withBorder padding="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Badge size="xs" variant="light" color="blue">
                {meeting.date === today ? "Today" : "Next up"}
              </Badge>
              {meeting.mine === "signed_up" ? (
                <Badge size="xs" variant="light" color="green">
                  you're coming
                </Badge>
              ) : meeting.mine === "maybe" ? (
                <Badge size="xs" variant="light" color="gray">
                  maybe
                </Badge>
              ) : null}
            </Group>
            <Text fw={600} mt={4}>
              {meeting.title}
            </Text>
            <Text size="sm" c="dimmed">
              {dateLabel(meeting.date)} ·{" "}
              {timeRangeLabel(meeting.startTime, meeting.endTime)}
              {meeting.location ? ` · ${meeting.location}` : ""}
            </Text>
          </div>
          <Button
            component={Link}
            to={`/meetings/${meeting.occurrenceId}`}
            size="xs"
            variant="light"
          >
            Open
          </Button>
        </Group>
        {room ? <JoinButton room={room} /> : null}
        <Text size="sm" c="dimmed">
          {meeting.agendaCount === 0
            ? "Nothing on the agenda yet — open it and add the first item."
            : `${meeting.agendaCount} item${meeting.agendaCount === 1 ? "" : "s"} on the agenda`}
          {meeting.comingCount > 0 ? ` · ${meeting.comingCount} coming` : ""}
        </Text>
      </Stack>
    </Card>
  );
}

/** Shared by the list and the detail page — the camp's standing room. */
export function JoinButton({
  room,
}: {
  room: { url: string; label: string | null; note: string | null };
}) {
  const provider = meetingProvider(room.url);
  return (
    <div>
      <Button
        component="a"
        href={room.url}
        target="_blank"
        rel="noreferrer noopener"
        size="sm"
      >
        {joinLabel(room.url, room.label)} ↗
      </Button>
      <Text size="xs" c="dimmed" mt={4}>
        {room.note ? room.note : `Opens ${provider.label}.`}
      </Text>
    </div>
  );
}

function MeetingCard({ m }: { m: MeetingRow }) {
  const unread = m.summary?.published && !m.summary.readByMe;
  return (
    <Card
      withBorder
      padding="sm"
      component={Link}
      to={`/meetings/${m.occurrenceId}`}
      opacity={m.cancelled ? 0.55 : 1}
    >
      <Group justify="space-between" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text
              fw={600}
              size="sm"
              td={m.cancelled ? "line-through" : undefined}
            >
              {m.title}
            </Text>
            {m.cancelled ? (
              <Badge size="xs" color="red" variant="light">
                cancelled
              </Badge>
            ) : null}
            {unread ? (
              <Badge size="xs" color="blue" variant="filled">
                new summary
              </Badge>
            ) : m.summary?.published ? (
              <Badge size="xs" color="gray" variant="light">
                summary
              </Badge>
            ) : m.summary ? (
              <Badge size="xs" color="yellow" variant="light">
                summary draft
              </Badge>
            ) : null}
            {m.mine === "signed_up" ? (
              <Badge size="xs" color="green" variant="light">
                you're coming
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {dateLabel(m.date)} · {timeRangeLabel(m.startTime, m.endTime)}
            {m.location ? ` · ${m.location}` : ""}
            {m.agendaCount > 0
              ? ` · ${m.agendaCount} agenda item${m.agendaCount === 1 ? "" : "s"}`
              : ""}
          </Text>
        </div>
        <Text size="sm" c="dimmed">
          →
        </Text>
      </Group>
    </Card>
  );
}

function NewMeetingForm() {
  const fetcher = useFetcher<{ error?: string }>();
  const [opened, { toggle }] = useDisclosure(false);
  const [cadence, setCadence] = useState<MeetingCadence>("once");
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between">
        <Text fw={600}>Schedule a meeting</Text>
        <Button size="xs" variant="light" onClick={toggle}>
          {opened ? "Close" : "Schedule"}
        </Button>
      </Group>
      <Collapse in={opened}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createMeeting" />
          <input type="hidden" name="cadence" value={cadence} />
          <Stack gap="sm" mt="sm">
            <TextInput
              name="title"
              label="What's it called"
              placeholder="e.g. Weekly camp meeting"
              required
            />
            <Textarea
              name="description"
              label="Details"
              placeholder="Standing notes — who runs it, how to dial in by phone…"
              autosize
              minRows={2}
            />
            <TextInput
              name="location"
              label="Where"
              placeholder="e.g. Discord, or the warehouse"
            />
            <SegmentedControl
              value={cadence}
              onChange={(v) => setCadence(v as MeetingCadence)}
              data={MEETING_CADENCES.map((c) => ({
                value: c.value,
                label: c.label,
              }))}
            />
            <Group grow align="flex-end">
              <TextInput
                type="date"
                name="date"
                label={cadence === "once" ? "Date" : "First one"}
                required
              />
              {cadence === "once" ? null : (
                <TextInput
                  type="date"
                  name="endDate"
                  label="Keep going until"
                  required
                />
              )}
              <TextInput type="time" name="startTime" label="Starts" />
              <TextInput type="time" name="endTime" label="Ends" />
            </Group>
            <Text size="xs" c="dimmed">
              {cadence === "once"
                ? "One meeting. Each meeting gets its own agenda and its own write-up."
                : "Every date becomes its own meeting, with its own agenda and write-up. You can cancel or move any single one afterwards on the Schedule page."}
            </Text>
            <Group justify="flex-end">
              <Button type="submit" loading={busy}>
                Schedule it
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Collapse>
    </Paper>
  );
}
