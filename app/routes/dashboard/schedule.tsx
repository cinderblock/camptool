/**
 * Schedule — the camp's gatherings (work parties / meetings / prep / shifts)
 * for the active year. Officers create gatherings (single date or repeat
 * daily across a range, e.g. every day during the event); everyone browses.
 * Sign-ups live on the gathering detail page. Gated by the `schedule` camp
 * feature. Design: plans/events-scheduling.md.
 */
import {
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
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
import { hasAtLeast } from "~/lib/permissions";
import {
  GATHERING_KINDS,
  STAFFING_OPTIONS,
  dailyDatesBetween,
  dateLabel,
  isIsoDate,
  kindColor,
  kindLabel,
  timeRangeLabel,
  todayIso,
} from "~/lib/schedule";
import {
  cleanTime,
  createGathering,
  loadGatherings,
} from "~/lib/schedule.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/schedule";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Schedule · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "schedule");
  return {
    year: activeEdition.year,
    locked: activeEdition.locked,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    gatherings: await loadGatherings(activeEdition.id, todayIso()),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "schedule");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers manage the schedule." }, { status: 403 });
  }
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const form = await request.formData();
  if (String(form.get("intent")) !== "createGathering") {
    return data({ error: "Unknown action." }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title || title.length > 200) {
    return data({ error: "Please give it a title." }, { status: 400 });
  }
  const kind = String(form.get("kind") ?? "work_party");
  if (!GATHERING_KINDS.some((k) => k.value === kind)) {
    return data({ error: "Unknown kind." }, { status: 400 });
  }
  const staffing = String(form.get("staffing") ?? "open");
  if (!STAFFING_OPTIONS.some((s) => s.value === staffing)) {
    return data({ error: "Unknown staffing." }, { status: 400 });
  }

  const repeat = String(form.get("repeat")) === "daily";
  const date = String(form.get("date") ?? "");
  const endDate = String(form.get("endDate") ?? "");
  let dates: string[];
  let recurrenceRule: string | null = null;
  if (repeat) {
    if (!isIsoDate(date) || !isIsoDate(endDate)) {
      return data({ error: "Pick a start and end date." }, { status: 400 });
    }
    dates = dailyDatesBetween(date, endDate);
    if (dates.length === 0) {
      return data(
        { error: "The end date must be on or after the start." },
        { status: 400 },
      );
    }
    recurrenceRule = `daily:${date}..${endDate}`;
  } else {
    if (!isIsoDate(date)) {
      return data({ error: "Pick a date." }, { status: 400 });
    }
    dates = [date];
  }

  const capacityRaw = Number(form.get("capacity"));
  const capacity =
    staffing === "needed" && Number.isInteger(capacityRaw) && capacityRaw > 0
      ? capacityRaw
      : null;

  const id = await createGathering({
    campId: active.camp.id,
    editionId: activeEdition.id,
    createdById: user.id,
    title,
    description: String(form.get("description") ?? "").trim() || null,
    kind,
    location: String(form.get("location") ?? "").trim() || null,
    dates,
    startTime: cleanTime(form.get("startTime")),
    endTime: cleanTime(form.get("endTime")),
    shift: { staffing, minNeeded: capacity, capacity },
    recurrenceRule,
  });
  return redirect(`/schedule/${id}`);
}

export default function Schedule({ loaderData }: Route.ComponentProps) {
  const { year, locked, isOfficer, gatherings } = loaderData;
  const today = todayIso();
  const upcoming = gatherings.filter(
    (g) => g.nextDate != null && g.nextDate >= today,
  );
  const past = gatherings.filter(
    (g) => g.nextDate == null || g.nextDate < today,
  );

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Schedule</Title>
          <Text c="dimmed" size="sm">
            Work parties, meetings, and shifts for {year}.
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
              This year is locked — the schedule is read-only.
            </Text>
          </Paper>
        ) : null}

        {isOfficer && !locked ? <NewGatheringForm /> : null}

        {gatherings.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing scheduled yet
            {isOfficer && !locked
              ? " — create the first gathering above."
              : "."}
          </Text>
        ) : (
          <>
            {upcoming.map((g) => (
              <GatheringCard key={g.id} g={g} />
            ))}
            {past.length > 0 ? (
              <>
                <Text size="sm" c="dimmed" fw={600}>
                  Past
                </Text>
                {past.map((g) => (
                  <GatheringCard key={g.id} g={g} />
                ))}
              </>
            ) : null}
          </>
        )}
      </Stack>
    </Container>
  );
}

function GatheringCard({
  g,
}: {
  g: Route.ComponentProps["loaderData"]["gatherings"][number];
}) {
  return (
    <Card withBorder padding="md" component={Link} to={`/schedule/${g.id}`}>
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Group gap="xs">
            <Text fw={600}>{g.title}</Text>
            <Badge size="xs" color={kindColor(g.kind)} variant="light">
              {kindLabel(g.kind)}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {g.nextDate
              ? `${dateLabel(g.nextDate)} · ${timeRangeLabel(g.nextStartTime, g.nextEndTime)}`
              : "No dates scheduled"}
            {g.occurrenceCount > 1 ? ` · ${g.occurrenceCount} days` : ""}
            {g.location ? ` · ${g.location}` : ""}
          </Text>
        </div>
        <Text size="sm" c="dimmed">
          →
        </Text>
      </Group>
    </Card>
  );
}

function NewGatheringForm() {
  const fetcher = useFetcher<{ error?: string }>();
  const [opened, { toggle }] = useDisclosure(false);
  const [repeat, setRepeat] = useState<"single" | "daily">("single");
  const [staffing, setStaffing] = useState("open");
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between">
        <Text fw={600}>New gathering</Text>
        <Button size="xs" variant="light" onClick={toggle}>
          {opened ? "Close" : "Create"}
        </Button>
      </Group>
      <Collapse in={opened}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="createGathering" />
          <input type="hidden" name="repeat" value={repeat} />
          <Stack gap="sm" mt="sm">
            <Group grow align="flex-end">
              <TextInput
                name="title"
                label="Title"
                placeholder="e.g. Build weekend work party"
                required
              />
              <Select
                name="kind"
                label="Kind"
                defaultValue="work_party"
                data={GATHERING_KINDS.map((k) => ({
                  value: k.value,
                  label: k.label,
                }))}
                allowDeselect={false}
              />
            </Group>
            <Textarea
              name="description"
              label="Details"
              placeholder="What's happening, what to bring…"
              autosize
              minRows={2}
            />
            <Group grow align="flex-end">
              <TextInput
                name="location"
                label="Where"
                placeholder="e.g. The warehouse / camp HQ"
              />
              <SegmentedControl
                value={repeat}
                onChange={(v) => setRepeat(v as "single" | "daily")}
                data={[
                  { value: "single", label: "One day" },
                  { value: "daily", label: "Repeats daily" },
                ]}
              />
            </Group>
            <Group grow align="flex-end">
              <TextInput
                type="date"
                name="date"
                label={repeat === "daily" ? "First day" : "Date"}
                required
              />
              {repeat === "daily" ? (
                <TextInput
                  type="date"
                  name="endDate"
                  label="Last day"
                  required
                />
              ) : null}
              <TextInput type="time" name="startTime" label="Starts" />
              <TextInput type="time" name="endTime" label="Ends" />
            </Group>
            <Group grow align="flex-end">
              <Select
                label="Who's needed"
                value={staffing}
                onChange={(v) => setStaffing(v ?? "open")}
                data={STAFFING_OPTIONS.map((s) => ({
                  value: s.value,
                  label: s.label,
                }))}
                allowDeselect={false}
              />
              {staffing === "needed" ? (
                <NumberInput
                  name="capacity"
                  label="How many people"
                  min={1}
                  placeholder="e.g. 2"
                />
              ) : null}
            </Group>
            <input type="hidden" name="staffing" value={staffing} />
            <Text size="xs" c="dimmed">
              {STAFFING_OPTIONS.find((s) => s.value === staffing)?.hint}
            </Text>
            <Group justify="flex-end">
              <Button type="submit" loading={busy}>
                Create gathering
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Collapse>
    </Paper>
  );
}
