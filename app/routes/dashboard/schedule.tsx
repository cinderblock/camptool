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
import {
  type RoleDraft,
  ShiftRoleBuilder,
  emptyRole,
} from "~/components/ShiftRoleBuilder";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  GATHERING_KINDS,
  MAX_TEMPLATE_ROLES,
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
  loadAgenda,
  loadGatherings,
  parseShiftTemplate,
} from "~/lib/schedule.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/schedule";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Schedule · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "schedule");
  return redact(privacy, {
    year: activeEdition.year,
    locked: activeEdition.locked,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    agenda: await loadAgenda(activeEdition.id, active.membership.id),
    gatherings: await loadGatherings(activeEdition.id, todayIso()),
  });
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
  // Optional role template: several jobs per day, stamped onto every day. When
  // empty this falls back to the single general shift it always made.
  const shifts = parseShiftTemplate(form);

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
    shifts,
    recurrenceRule,
  });
  return redirect(`/schedule/${id}`);
}

type AgendaRow = Route.ComponentProps["loaderData"]["agenda"][number];

export default function Schedule({ loaderData }: Route.ComponentProps) {
  const { year, locked, isOfficer, agenda, gatherings } = loaderData;
  const [view, setView] = useState<"agenda" | "calendar" | "mine">("agenda");
  const today = todayIso();
  // Gatherings whose days were all deleted/cancelled would otherwise be
  // unreachable — surface them so officers can still manage/archive them.
  const orphans = gatherings.filter((g) => g.nextDate == null);

  return (
    <Container size="md">
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={2}>Schedule</Title>
            <Text c="dimmed" size="sm">
              Work parties, meetings, and shifts for {year}.
            </Text>
          </div>
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as typeof view)}
            data={[
              { value: "agenda", label: "Agenda" },
              { value: "calendar", label: "Calendar" },
              { value: "mine", label: "Mine" },
            ]}
          />
        </Group>

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

        <WhatIsThis isOfficer={isOfficer} empty={agenda.length === 0} />

        {isOfficer && !locked ? <NewGatheringForm /> : null}

        {view === "calendar" ? (
          <MonthCalendar agenda={agenda} today={today} />
        ) : view === "mine" ? (
          <AgendaList
            rows={agenda.filter((r) => r.mine != null)}
            today={today}
            emptyText="You're not signed up for anything yet — check the Agenda."
          />
        ) : (
          <AgendaList
            rows={agenda}
            today={today}
            emptyText={
              gatherings.length === 0
                ? `Nothing scheduled yet${isOfficer && !locked ? " — create the first gathering above." : "."}`
                : "No days scheduled."
            }
          />
        )}

        {isOfficer && orphans.length > 0 ? (
          <div>
            <Text size="sm" c="dimmed" fw={600} mb={4}>
              Gatherings without scheduled days
            </Text>
            {orphans.map((g) => (
              <Anchor
                key={g.id}
                component={Link}
                to={`/schedule/${g.id}`}
                size="sm"
                display="block"
              >
                {g.title}
              </Anchor>
            ))}
          </div>
        ) : null}
      </Stack>
    </Container>
  );
}

/**
 * Items 12 + 13. Two reports from the same meeting: a camper found the Shifts
 * feature and asked what a shift even *is*, and another went looking for an
 * agenda that had just been switched on and was still empty. Both are answered
 * on the page itself — no tooltip (invisible on a phone), no separate doc.
 */
function WhatIsThis({
  isOfficer,
  empty,
}: {
  isOfficer: boolean;
  empty: boolean;
}) {
  const [open, { toggle }] = useDisclosure(false);
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text size="sm">
            Everything the camp does together on a schedule — and where you say
            you'll be there.
          </Text>
          {empty ? (
            <Text size="sm" c="dimmed" mt={4}>
              {isOfficer
                ? "Nothing is on the calendar yet, so campers can't see this page at all — it stays hidden from them until there's something here. Create the first gathering below."
                : "Nothing is on the calendar yet. When the camp posts work parties, meetings, or daily shifts, they'll appear here and you'll be able to sign up."}
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
            A <b>gathering</b> is one thing the camp does — it can happen once,
            or repeat every day. Kinds:
          </Text>
          <Group gap={6} pl="sm" wrap="wrap">
            {GATHERING_KINDS.map((k) => (
              <Badge
                key={k.value}
                size="xs"
                variant="light"
                color={kindColor(k.value)}
              >
                {k.label}
              </Badge>
            ))}
          </Group>
          <Text size="xs" c="dimmed">
            Each day of a gathering is split into <b>shifts</b>. A shift is{" "}
            <b>one job, on one day, that needs people</b> — like the prep crew
            before a service, the people serving during it, and cleanup
            afterwards. Sign up for a shift and you're on the list for that job
            on that day. A day with no named roles is just one general sign-up
            sheet. How many people a shift wants:
          </Text>
          <Stack gap={2} pl="sm">
            {STAFFING_OPTIONS.map((s) => (
              <Text key={s.value} size="xs" c="dimmed">
                <b>{s.label}</b> — {s.hint}
              </Text>
            ))}
          </Stack>
          <Text size="xs" c="dimmed">
            Signing up isn't a contract — you can withdraw any time, and if a
            shift is already full you'll go on its waitlist instead.
          </Text>
        </Stack>
      </Collapse>
    </Paper>
  );
}

function AgendaList({
  rows,
  today,
  emptyText,
}: {
  rows: AgendaRow[];
  today: string;
  emptyText: string;
}) {
  const upcoming = rows.filter((r) => r.date >= today);
  const past = rows.filter((r) => r.date < today).reverse();
  if (rows.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        {emptyText}
      </Text>
    );
  }
  return (
    <Stack gap="xs">
      {upcoming.map((r) => (
        <AgendaCard key={r.occurrenceId} r={r} />
      ))}
      {past.length > 0 ? (
        <>
          <Text size="sm" c="dimmed" fw={600} mt="sm">
            Past
          </Text>
          {past.map((r) => (
            <AgendaCard key={r.occurrenceId} r={r} />
          ))}
        </>
      ) : null}
    </Stack>
  );
}

function AgendaCard({ r }: { r: AgendaRow }) {
  return (
    <Card
      withBorder
      padding="sm"
      component={Link}
      to={`/schedule/${r.gatheringId}`}
      opacity={r.cancelled ? 0.55 : 1}
    >
      <Group justify="space-between" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text
              fw={600}
              size="sm"
              td={r.cancelled ? "line-through" : undefined}
            >
              {r.title}
            </Text>
            <Badge size="xs" color={kindColor(r.kind)} variant="light">
              {kindLabel(r.kind)}
            </Badge>
            {r.cancelled ? (
              <Badge size="xs" color="red" variant="light">
                cancelled
              </Badge>
            ) : null}
            {r.mine ? (
              <Badge
                size="xs"
                variant="light"
                color={
                  r.mine === "signed_up"
                    ? "green"
                    : r.mine === "waitlisted"
                      ? "yellow"
                      : "gray"
                }
              >
                {r.mine === "signed_up" ? "you're in" : r.mine}
              </Badge>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            {dateLabel(r.date)} · {timeRangeLabel(r.startTime, r.endTime)}
            {r.location ? ` · ${r.location}` : ""}
            {r.needed > 0 ? ` · ${r.committed}/${r.needed} filled` : ""}
          </Text>
        </div>
        <Text size="sm" c="dimmed">
          →
        </Text>
      </Group>
    </Card>
  );
}

/** DIY month grid — no calendar dependency. Weeks start Sunday. */
function MonthCalendar({
  agenda,
  today,
}: {
  agenda: AgendaRow[];
  today: string;
}) {
  // Default to the month of the next upcoming item, else today's month.
  const firstUpcoming = agenda.find((r) => r.date >= today);
  const [month, setMonth] = useState(
    () => (firstUpcoming?.date ?? today).slice(0, 7), // YYYY-MM
  );
  const [y = 0, m = 1] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const iso = (day: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const byDate = new Map<string, AgendaRow[]>();
  for (const r of agenda) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const shiftMonth = (delta: number) => {
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(
      `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  };
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" mb="xs">
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => shiftMonth(-1)}
        >
          ← Prev
        </Button>
        <Text fw={600}>{monthLabel}</Text>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => shiftMonth(1)}
        >
          Next →
        </Button>
      </Group>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 4,
        }}
      >
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <Text key={d} size="xs" c="dimmed" ta="center">
            {d}
          </Text>
        ))}
        {cells.map((day, i) => (
          <div
            key={day ?? `blank-${i}`}
            style={{
              minHeight: 64,
              borderRadius: 4,
              padding: 2,
              border: "1px solid var(--mantine-color-default-border)",
              background:
                day != null && iso(day) === today
                  ? "var(--mantine-color-default-hover)"
                  : undefined,
              visibility: day == null ? "hidden" : undefined,
            }}
          >
            {day != null ? (
              <>
                <Text size="xs" c="dimmed" ta="right" pr={2}>
                  {day}
                </Text>
                <Stack gap={2}>
                  {(byDate.get(iso(day)) ?? []).map((r) => (
                    <Anchor
                      key={r.occurrenceId}
                      component={Link}
                      to={`/schedule/${r.gatheringId}`}
                      underline="never"
                    >
                      <Badge
                        size="xs"
                        color={kindColor(r.kind)}
                        variant={r.mine ? "filled" : "light"}
                        fullWidth
                        style={{
                          textDecoration: r.cancelled
                            ? "line-through"
                            : undefined,
                        }}
                      >
                        {r.title}
                      </Badge>
                    </Anchor>
                  ))}
                </Stack>
              </>
            ) : null}
          </div>
        ))}
      </div>
      <Text size="xs" c="dimmed" mt="xs">
        Filled badges are days you're signed up for.
      </Text>
    </Paper>
  );
}

function NewGatheringForm() {
  const fetcher = useFetcher<{ error?: string }>();
  const [opened, { toggle }] = useDisclosure(false);
  const [repeat, setRepeat] = useState<"single" | "daily">("single");
  const [staffing, setStaffing] = useState("open");
  // "roles" turns the one general sheet into several named slots per day — the
  // thing that made a multi-job daily service practical to set up.
  const [split, setSplit] = useState<"single" | "roles">("single");
  const [roles, setRoles] = useState<RoleDraft[]>(() => [emptyRole()]);
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
            <SegmentedControl
              value={split}
              onChange={(v) => setSplit(v as "single" | "roles")}
              data={[
                { value: "single", label: "One sign-up sheet" },
                { value: "roles", label: "Split into roles" },
              ]}
            />
            {split === "single" ? (
              <>
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
              </>
            ) : (
              <>
                <Text size="xs" c="dimmed">
                  Each role becomes its own sign-up slot, on every day above.
                  You can change any single day's counts afterwards.
                </Text>
                <ShiftRoleBuilder
                  rows={roles}
                  onChange={setRoles}
                  maxRoles={MAX_TEMPLATE_ROLES}
                />
              </>
            )}
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
