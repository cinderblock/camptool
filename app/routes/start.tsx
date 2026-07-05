import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Container,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import dayjs from "dayjs";
import { and, asc, eq } from "drizzle-orm";
import { useState } from "react";
import { data, useFetcher, useNavigate } from "react-router";
import { type AddSize, AddStructures } from "~/components/AddStructures";
import { EventCalendar } from "~/components/EventCalendar";
import { PlayaNameField } from "~/components/PlayaNameField";
import { QuestionField } from "~/components/QuestionField";
import { parseBannedKinds } from "~/lib/bans";
import { eventWindowFor, weeksUntilEvent } from "~/lib/brc";
import type { QuestionType } from "~/lib/questions";
import { parseOptions } from "~/lib/questions";
import {
  filterByAudience,
  loadAnswers,
  loadCampQuestions,
  loadInviterName,
  loadInviterOptions,
} from "~/lib/questions.server";
import { requireActiveEdition } from "~/lib/session.server";
import { ShapeSwatch, hasTag, kindDef } from "~/lib/structures";
import type { AskKey } from "~/lib/wizard";
import { audienceForRole } from "~/lib/wizard";
import {
  type ParticipationStatus,
  loadWizardState,
  resolveAsk,
  setParticipation,
} from "~/lib/wizard.server";
import { db } from "../../db/client.server";
import {
  mapObject,
  mapObjectOccupant,
  membership,
  onboardingCompletion,
  onboardingTask,
  setupPass,
  setupPassDate,
  user,
} from "../../db/schema";
import type { Route } from "./+types/start";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Get started · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const {
    user: authUser,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  const role = active.membership.role;

  const [me] = await db
    .select({
      playaName: membership.playaName,
      wizardStep: membership.wizardStep,
    })
    .from(membership)
    .where(eq(membership.id, mid))
    .limit(1);

  // Visiting the wizard once is enough to stop the layout's one-time forced
  // redirect; per-ask resolution (below) drives everything after that.
  if ((me?.wizardStep ?? 0) === 0) {
    await db
      .update(membership)
      .set({ wizardStep: 1 })
      .where(eq(membership.id, mid));
  }

  const state = await loadWizardState({
    editionId,
    membershipId: mid,
    role,
    year: activeEdition.year,
  });
  const keys = new Set(state.scheduled.map((a) => a.key));

  // Load supporting data only for the steps that are actually in season.
  let items: {
    id: string;
    kind: string;
    name: string | null;
    width: number;
    height: number;
    placed: boolean;
  }[] = [];
  let occupants: {
    objectId: string;
    membershipId: string;
    name: string | null;
  }[] = [];
  let roster: { membershipId: string; name: string | null }[] = [];
  let tasks: { id: string; title: string; done: boolean }[] = [];
  type WizardQuestion = {
    id: string;
    prompt: string;
    helpText: string | null;
    type: QuestionType;
    options: string[];
    required: boolean;
    exclusiveOption: string | null;
  };
  let questionsBefore: WizardQuestion[] = [];
  let questionsAfter: WizardQuestion[] = [];
  let answers: Record<string, string> = {};
  let invitedByName: string | null = null;
  let inviterOptions: string[] = [];

  if (keys.has("bringing") || keys.has("sharing")) {
    items = await db
      .select({
        id: mapObject.id,
        kind: mapObject.kind,
        name: mapObject.name,
        width: mapObject.width,
        height: mapObject.height,
        placed: mapObject.placed,
      })
      .from(mapObject)
      .where(
        and(
          eq(mapObject.editionId, editionId),
          eq(mapObject.ownerMembershipId, mid),
        ),
      );
  }

  if (keys.has("sharing")) {
    occupants = await db
      .select({
        objectId: mapObjectOccupant.objectId,
        membershipId: mapObjectOccupant.membershipId,
        name: user.name,
      })
      .from(mapObjectOccupant)
      .innerJoin(mapObject, eq(mapObjectOccupant.objectId, mapObject.id))
      .leftJoin(membership, eq(mapObjectOccupant.membershipId, membership.id))
      .leftJoin(user, eq(membership.userId, user.id))
      .where(
        and(
          eq(mapObject.ownerMembershipId, mid),
          eq(mapObjectOccupant.editionId, editionId),
        ),
      );

    const rosterRows = await db
      .select({ membershipId: membership.id, name: user.name })
      .from(membership)
      .leftJoin(user, eq(membership.userId, user.id))
      .where(
        and(
          eq(membership.organizationId, campId),
          eq(membership.status, "active"),
        ),
      );
    roster = rosterRows.filter((r) => r.membershipId !== mid);
  }

  if (keys.has("checklist")) {
    const taskRows = await db
      .select()
      .from(onboardingTask)
      .where(eq(onboardingTask.campId, campId))
      .orderBy(asc(onboardingTask.sortOrder), asc(onboardingTask.createdAt));
    const doneRows = await db
      .select({ taskId: onboardingCompletion.taskId })
      .from(onboardingCompletion)
      .where(eq(onboardingCompletion.membershipId, mid));
    const doneSet = new Set(doneRows.map((d) => d.taskId));
    tasks = taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      done: doneSet.has(t.id),
    }));
  }

  if (keys.has("questionnaire") || keys.has("extras")) {
    const rows = filterByAudience(await loadCampQuestions(campId), role);
    const mapped: (WizardQuestion & { placement: string })[] = rows.map(
      (q) => ({
        id: q.id,
        prompt: q.prompt,
        helpText: q.helpText,
        type: q.type as QuestionType,
        options: parseOptions(q.options),
        required: q.required,
        exclusiveOption: q.exclusiveOption,
        placement: q.wizardPlacement,
      }),
    );
    questionsBefore = mapped.filter((q) => q.placement !== "after");
    questionsAfter = mapped.filter((q) => q.placement === "after");
    answers = await loadAnswers({ editionId, membershipId: mid });
    invitedByName = await loadInviterName(mid);
    inviterOptions = await loadInviterOptions(campId);
  }

  // The camper's setup pass (if any) — drives the "arriving early needs a
  // Setup Access Pass" prompt on the RSVP step. Denied rows don't count.
  const passRows = await db
    .select({
      status: setupPass.status,
      date: setupPassDate.date,
    })
    .from(setupPass)
    .leftJoin(setupPassDate, eq(setupPass.passDateId, setupPassDate.id))
    .where(
      and(eq(setupPass.editionId, editionId), eq(setupPass.membershipId, mid)),
    );
  const myPass = passRows.find((p) => p.status !== "denied") ?? null;

  const arrivalWindow = eventWindowFor(activeEdition.year);

  return {
    locked: activeEdition.locked,
    bannedKinds: parseBannedKinds(activeEdition.bannedKinds),
    userName: authUser.name,
    year: activeEdition.year,
    weeksToEvent: weeksUntilEvent(activeEdition.year),
    audience: audienceForRole(role),
    scheduled: state.scheduled.map((a) => ({
      key: a.key,
      label: a.label,
      hint: a.hint,
      priority: a.priority,
    })),
    resolved: state.resolved,
    participation: state.participation,
    playaName: me?.playaName ?? null,
    items,
    occupants,
    roster,
    tasks,
    questionsBefore,
    questionsAfter,
    answers,
    invitedByName,
    inviterOptions,
    myPass,
    // Gates open on `focus`; min/max bound the arrival picker.
    arrivalWindow,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: authUser,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "saveProfile") {
    // Real name and playa name are collected together (real name lives on the
    // shared `user`; playa name is per-membership). Either may be sent alone.
    if (form.has("playaName")) {
      const v = form.get("playaName");
      const playaName = v == null || v === "" ? null : String(v);
      await db
        .update(membership)
        .set({ playaName })
        .where(eq(membership.id, mid));
    }
    if (form.has("name")) {
      const name = String(form.get("name") ?? "").trim();
      // A blank name would orphan the account's display; ignore empty submits.
      if (name) {
        await db.update(user).set({ name }).where(eq(user.id, authUser.id));
      }
    }
    return data({ ok: true });
  }

  if (intent === "resolveAsk") {
    const askKey = String(form.get("askKey")) as AskKey;
    const status = form.get("status") === "skipped" ? "skipped" : "done";
    await resolveAsk({ campId, editionId, membershipId: mid, askKey, status });
    return data({ ok: true });
  }

  // RSVP writes edition-scoped data, so a locked year is read-only.
  if (intent === "rsvp") {
    if (activeEdition.locked) {
      return data({ error: "This year is locked." }, { status: 403 });
    }
    const status = String(form.get("status")) as ParticipationStatus;
    if (!["unknown", "coming", "maybe", "not_coming"].includes(status)) {
      return data({ error: "Bad status." }, { status: 400 });
    }
    const noteRaw = form.get("note");
    // Absent field = leave unchanged; empty string = clear; else YYYY-MM-DD.
    const readDay = (key: string): string | null | undefined => {
      const raw = form.get(key);
      if (raw == null) return undefined;
      return String(raw) || null;
    };
    const arrivalDate = readDay("arrivalDate");
    const departureDate = readDay("departureDate");
    for (const day of [arrivalDate, departureDate]) {
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return data({ error: "Bad date." }, { status: 400 });
      }
    }
    if (arrivalDate && departureDate && departureDate < arrivalDate) {
      return data(
        { error: "Departure can't be before arrival." },
        { status: 400 },
      );
    }
    await setParticipation({
      campId,
      editionId,
      membershipId: mid,
      status,
      arrivalDate,
      departureDate,
      note: noteRaw == null ? undefined : String(noteRaw) || null,
    });
    return data({ ok: true });
  }

  // Auto-request a Setup Access Pass (unbound — an officer assigns the
  // "on or after" date on /passes) when the camper is arriving pre-event.
  if (intent === "requestSetupPass") {
    if (activeEdition.locked) {
      return data({ error: "This year is locked." }, { status: 403 });
    }
    const existing = await db
      .select({ id: setupPass.id, status: setupPass.status })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.editionId, editionId),
          eq(setupPass.membershipId, mid),
        ),
      );
    if (existing.some((p) => p.status !== "denied")) {
      return data({ ok: true }); // already requested/granted — idempotent
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      membershipId: mid,
      status: "requested",
      note: "Requested during onboarding (arriving before gates open).",
      createdById: authUser.id,
    });
    return data({ ok: true });
  }

  // Occupant edits touch edition-scoped data, so they respect the lock.
  if (intent === "addOccupant" || intent === "removeOccupant") {
    if (activeEdition.locked) {
      return data({ error: "This year is locked." }, { status: 403 });
    }
    const objectId = String(form.get("objectId"));
    const membershipId = String(form.get("membershipId"));
    // Confirm the structure is the caller's own item in this edition.
    const [own] = await db
      .select({ id: mapObject.id })
      .from(mapObject)
      .where(
        and(
          eq(mapObject.id, objectId),
          eq(mapObject.editionId, editionId),
          eq(mapObject.ownerMembershipId, mid),
        ),
      )
      .limit(1);
    if (!own) return data({ error: "Not your item." }, { status: 403 });

    if (intent === "addOccupant") {
      const [existing] = await db
        .select({ id: mapObjectOccupant.id })
        .from(mapObjectOccupant)
        .where(
          and(
            eq(mapObjectOccupant.objectId, objectId),
            eq(mapObjectOccupant.membershipId, membershipId),
          ),
        )
        .limit(1);
      if (!existing) {
        await db.insert(mapObjectOccupant).values({
          id: crypto.randomUUID(),
          campId,
          editionId,
          objectId,
          membershipId,
        });
      }
      return data({ ok: true });
    }
    await db
      .delete(mapObjectOccupant)
      .where(
        and(
          eq(mapObjectOccupant.objectId, objectId),
          eq(mapObjectOccupant.membershipId, membershipId),
        ),
      );
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type LoaderData = Route.ComponentProps["loaderData"];

export default function StartWizard({ loaderData }: Route.ComponentProps) {
  const { scheduled, resolved, locked, weeksToEvent } = loaderData;
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const steps = scheduled;
  // Start at the first unresolved ask so returning campers land on what's left.
  const firstPending = steps.findIndex((s) => !resolved[s.key]);
  const [active, setActive] = useState(firstPending < 0 ? 0 : firstPending);
  const last = steps.length - 1;

  function mark(key: string, status: "done" | "skipped") {
    fetcher.submit(
      { intent: "resolveAsk", askKey: key, status },
      { method: "post" },
    );
  }
  function next(status: "done" | "skipped" = "done") {
    if (steps[active]) mark(steps[active].key, status);
    setActive((a) => Math.min(last, a + 1));
  }
  function finish() {
    if (steps[active]) mark(steps[active].key, "done");
    // Advance past the last step so the Stepper shows its Completed panel —
    // an explicit "you're saved, safe to leave" confirmation — rather than
    // silently bouncing to the dashboard.
    setActive(last + 1);
  }

  return (
    <Container size="sm" py="xl">
      <Group justify="space-between" align="flex-end" mb="lg">
        <div>
          <Title order={2}>Welcome — let's get you set up</Title>
          <Text c="dimmed" size="sm">
            We only ask for what's relevant right now
            {weeksToEvent > 0 ? ` (~${weeksToEvent} weeks to the event)` : ""}.
            Stop anytime and pick up where you left off.
          </Text>
        </div>
        <Button variant="subtle" size="xs" onClick={() => navigate("/")}>
          Skip for now
        </Button>
      </Group>

      {locked ? (
        <Paper
          withBorder
          p="md"
          radius="md"
          mb="md"
          bg="var(--mantine-color-default-hover)"
        >
          <Text size="sm" c="dimmed">
            This year is locked — items and RSVP are read-only.
          </Text>
        </Paper>
      ) : null}

      <Stepper
        active={active}
        onStepClick={setActive}
        size="sm"
        orientation="vertical"
      >
        {steps.map((s) => (
          <Stepper.Step
            key={s.key}
            label={s.label}
            description={s.hint}
            color={resolved[s.key] ? "green" : undefined}
          >
            <AskBody askKey={s.key} data={loaderData} fetcher={fetcher} />
          </Stepper.Step>
        ))}
        <Stepper.Completed>
          <Paper withBorder p="lg" radius="md" mt="md">
            <Title order={4} mb="xs">
              You're all set!
            </Title>
            <Text size="sm" c="dimmed">
              Your answers are saved — it's safe to close this tab now. You can
              refine any of this anytime from the dashboard — Bringing, the map,
              tickets, and the checklist.
            </Text>
          </Paper>
        </Stepper.Completed>
      </Stepper>

      <Group justify="space-between" mt="xl">
        <Button
          variant="default"
          onClick={() => setActive((a) => Math.max(0, a - 1))}
          disabled={active === 0}
        >
          Back
        </Button>
        <Group gap="xs">
          {active > last ? (
            <Button color="green" onClick={() => navigate("/")}>
              Go to dashboard
            </Button>
          ) : (
            <>
              <Button
                variant="subtle"
                color="gray"
                onClick={() => next("skipped")}
              >
                Skip this
              </Button>
              {active < last ? (
                <Button onClick={() => next("done")}>Next</Button>
              ) : (
                <Button color="green" onClick={finish}>
                  Finish
                </Button>
              )}
            </>
          )}
        </Group>
      </Group>
    </Container>
  );
}

function AskBody({
  askKey,
  data: d,
  fetcher,
}: {
  askKey: AskKey;
  data: LoaderData;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  switch (askKey) {
    case "profile":
      return <ProfileStep data={d} fetcher={fetcher} />;
    case "questionnaire":
      return <QuestionnaireStep data={d} />;
    case "bringing":
      return <BringingStep data={d} />;
    case "extras":
      return <ExtrasStep data={d} />;
    case "sharing":
      return <OccupantsStep data={d} />;
    case "checklist":
      return <ChecklistStep data={d} />;
    default:
      return null;
  }
}

/** The "coming back?" RSVP, folded into the questionnaire step. */
function RsvpButtons({ data: d }: { data: LoaderData }) {
  const fetcher = useFetcher();
  const current = d.participation.status;
  const choices: {
    value: ParticipationStatus;
    label: string;
    color: string;
  }[] = [
    { value: "coming", label: "I'm coming", color: "green" },
    { value: "maybe", label: "Maybe", color: "yellow" },
    { value: "not_coming", label: "Not this year", color: "gray" },
  ];
  const setStatus = (status: ParticipationStatus) =>
    fetcher.submit({ intent: "rsvp", status }, { method: "post" });
  return (
    <Stack gap="xs" maw={460}>
      <Text size="sm" fw={600}>
        Are you camping with us for {d.year}?
      </Text>
      <Text size="sm" c="dimmed">
        This helps us plan tickets and space — you can change it anytime.
      </Text>
      <Group gap="xs">
        {choices.map((c) => (
          <Button
            key={c.value}
            variant={current === c.value ? "filled" : "default"}
            color={c.color}
            disabled={d.locked}
            onClick={() => setStatus(c.value)}
          >
            {c.label}
          </Button>
        ))}
      </Group>
      {current === "coming" || current === "maybe" ? (
        <StayAsk data={d} fetcher={fetcher} />
      ) : null}
    </Stack>
  );
}

/** Booking-style stay ask (tap arrival day, tap last day) + the Setup Access
 * Pass prompt: arriving before gate-open needs a pass, which the camper can
 * auto-request right here (an officer picks the pass's "on or after" date on
 * /passes). */
function StayAsk({
  data: d,
  fetcher,
}: {
  data: LoaderData;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const arrival = d.participation.arrivalDate;
  const departure = d.participation.departureDate;
  const gateOpen = d.arrivalWindow.focus;
  const gateOpenFmt = dayjs(gateOpen).format("dddd, MMM D");
  const arrivingEarly = arrival != null && arrival < gateOpen;
  const fmt = (day: string) => dayjs(day).format("ddd, MMM D");
  const nights =
    arrival && departure ? dayjs(departure).diff(dayjs(arrival), "day") : null;
  const saveStay = (range: {
    arrival: string | null;
    departure: string | null;
  }) =>
    fetcher.submit(
      {
        intent: "rsvp",
        status: d.participation.status,
        arrivalDate: range.arrival ?? "",
        departureDate: range.departure ?? "",
      },
      { method: "post" },
    );
  return (
    <Stack gap="xs" mt="xs">
      <div>
        <Text size="sm" fw={600}>
          When will you be there?
        </Text>
        <Text size="xs" c="dimmed">
          Tap the day you'll arrive, then the day you'll head home. Gates open{" "}
          {gateOpenFmt}.
        </Text>
      </div>
      <EventCalendar
        year={d.year}
        mode="range"
        range={{ arrival, departure }}
        onRangeChange={saveStay}
        disabled={d.locked}
      />
      <Text size="sm" c={arrival && departure ? undefined : "dimmed"}>
        {arrival && departure
          ? `${fmt(arrival)} → ${fmt(departure)} · ${nights} ${nights === 1 ? "night" : "nights"}`
          : arrival
            ? `Arriving ${fmt(arrival)} — now tap your last day.`
            : "No stay picked yet."}
      </Text>
      {arrivingEarly ? (
        <Paper withBorder p="sm" radius="md">
          {d.myPass?.status === "granted" ? (
            <Stack gap={4}>
              <Text size="sm" c="green">
                ✓ You have a Setup Access Pass
                {d.myPass.date
                  ? ` — it admits you on or after ${dayjs(d.myPass.date).format("ddd, MMM D")}`
                  : ""}
                .
              </Text>
              {d.myPass.date && arrival && d.myPass.date > arrival ? (
                <Text size="sm" c="orange">
                  Heads up: that's after your planned arrival — talk to an
                  officer about an earlier pass.
                </Text>
              ) : null}
            </Stack>
          ) : d.myPass ? (
            <Text size="sm" c="dimmed">
              ✓ Setup Access Pass requested — an officer will assign you one
              that covers your arrival.
            </Text>
          ) : (
            <Stack gap="xs">
              <Text size="sm">
                Arriving before gates open requires a Setup Access Pass. Want us
                to request one for you?
              </Text>
              <Group>
                <Button
                  size="xs"
                  disabled={d.locked}
                  loading={fetcher.state !== "idle"}
                  onClick={() =>
                    fetcher.submit(
                      { intent: "requestSetupPass" },
                      { method: "post" },
                    )
                  }
                >
                  Yes, request a pass
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      ) : null}
    </Stack>
  );
}

function QuestionnaireStep({ data: d }: { data: LoaderData }) {
  return (
    <Stack gap="lg" mt="md" maw={520}>
      <RsvpButtons data={d} />
      <div>
        <Text size="sm" c="dimmed" mb="sm">
          {d.audience === "recruit"
            ? "A few questions so we can get to know you."
            : "A quick check-in to help us plan the camp."}{" "}
          Answers save as you go.
        </Text>
        {d.questionsBefore.length === 0 ? (
          <Text c="dimmed" size="sm">
            No questions right now — you're good.
          </Text>
        ) : (
          <Stack gap="md">
            {d.questionsBefore.map((q) => (
              <QuestionField
                key={q.id}
                question={q}
                value={d.answers[q.id]}
                locked={d.locked}
                year={d.year}
                invitedByName={d.invitedByName}
                inviterOptions={d.inviterOptions}
                action="/questions"
              />
            ))}
          </Stack>
        )}
      </div>
    </Stack>
  );
}

/** The wrap-up step: questions an officer placed *after* the gear selection,
 * plus the free-text "anything to add?" (moved off the first page). */
function ExtrasStep({ data: d }: { data: LoaderData }) {
  const fetcher = useFetcher();
  const current = d.participation.status;
  return (
    <Stack gap="lg" mt="md" maw={520}>
      {d.questionsAfter.length > 0 ? (
        <Stack gap="md">
          {d.questionsAfter.map((q) => (
            <QuestionField
              key={q.id}
              question={q}
              value={d.answers[q.id]}
              locked={d.locked}
              year={d.year}
              invitedByName={d.invitedByName}
              inviterOptions={d.inviterOptions}
              action="/questions"
            />
          ))}
        </Stack>
      ) : null}
      <Textarea
        label="Anything to add?"
        description="Anything else we should know — arriving late, bringing a friend, a question for us…"
        autosize
        minRows={2}
        disabled={d.locked}
        defaultValue={d.participation.note ?? ""}
        onBlur={(e) =>
          fetcher.submit(
            { intent: "rsvp", status: current, note: e.currentTarget.value },
            { method: "post" },
          )
        }
      />
    </Stack>
  );
}

function ProfileStep({
  data: d,
  fetcher,
}: {
  data: LoaderData;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <Stack gap="sm" mt="md" maw={420}>
      <TextInput
        label="Your name"
        description="Your real / default name on your account."
        placeholder="e.g. Alex Rivera"
        defaultValue={d.userName ?? ""}
        onBlur={(e) =>
          fetcher.submit(
            { intent: "saveProfile", name: e.currentTarget.value },
            { method: "post" },
          )
        }
      />
      <PlayaNameField
        defaultValue={d.playaName ?? ""}
        onBlur={(e) =>
          fetcher.submit(
            { intent: "saveProfile", playaName: e.currentTarget.value },
            { method: "post" },
          )
        }
      />
    </Stack>
  );
}

function BringingStep({ data: d }: { data: LoaderData }) {
  // Reuse the Bringing page's action so there's one source of truth for items.
  const itemFetcher = useFetcher();
  const add = (kind: string, size?: AddSize) => {
    const fields: Record<string, string> = { intent: "addItem", kind };
    if (size?.width != null) fields.width = String(Math.round(size.width));
    if (size?.height != null) fields.height = String(Math.round(size.height));
    itemFetcher.submit(fields, { method: "post", action: "/bringing" });
  };
  const update = (id: string, fields: Record<string, string>) =>
    itemFetcher.submit(
      { intent: "updateItem", id, ...fields },
      { method: "post", action: "/bringing" },
    );
  const remove = (id: string) =>
    itemFetcher.submit(
      { intent: "removeItem", id },
      { method: "post", action: "/bringing" },
    );

  return (
    <Stack gap="md" mt="md">
      <Text size="sm" c="dimmed">
        What are you bringing? Add each structure or vehicle and give its size.
      </Text>
      {!d.locked ? (
        <AddStructures onAdd={add} bannedKinds={d.bannedKinds} />
      ) : null}
      {d.items.length === 0 ? (
        <Text c="dimmed" size="sm">
          Nothing yet — add what you're bringing above.
        </Text>
      ) : (
        <Stack gap="sm">
          {d.items.map((item) => {
            const def = kindDef(item.kind);
            return (
              <Paper key={item.id} withBorder p="sm" radius="md">
                <Group justify="space-between" wrap="wrap" align="flex-end">
                  <Group gap="sm" wrap="nowrap" align="center">
                    <ShapeSwatch kind={def} size={20} />
                    <Text fw={600} size="sm">
                      {def.label}
                    </Text>
                  </Group>
                  <Group gap="sm" wrap="wrap" align="flex-end">
                    <TextInput
                      size="xs"
                      label="Name"
                      w={120}
                      placeholder="optional"
                      disabled={d.locked}
                      defaultValue={item.name ?? ""}
                      onBlur={(e) =>
                        update(item.id, { name: e.currentTarget.value })
                      }
                    />
                    {def.rigid ? null : (
                      <NumberInput
                        size="xs"
                        label={def.vehicle ? "Length (ft)" : "Depth (ft)"}
                        w={96}
                        min={def.vehicle ? 6 : 1}
                        disabled={d.locked}
                        defaultValue={Math.round(item.height)}
                        onBlur={(e) =>
                          update(item.id, {
                            height: String(
                              Math.max(1, Number(e.currentTarget.value) || 1),
                            ),
                          })
                        }
                      />
                    )}
                    {!def.rigid && !def.vehicle ? (
                      <NumberInput
                        size="xs"
                        label="Width (ft)"
                        w={96}
                        min={1}
                        disabled={d.locked}
                        defaultValue={Math.round(item.width)}
                        onBlur={(e) =>
                          update(item.id, {
                            width: String(
                              Math.max(1, Number(e.currentTarget.value) || 1),
                            ),
                          })
                        }
                      />
                    ) : null}
                    {d.locked ? null : (
                      <Tooltip label="Remove">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          mb={4}
                          onClick={() => remove(item.id)}
                        >
                          ✕
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

function OccupantsStep({ data: d }: { data: LoaderData }) {
  const fetcher = useFetcher();
  // Only structures that hold people (domiciles + vehicles) take occupants.
  const holders = d.items.filter(
    (i) => hasTag(i.kind, "domicile") || hasTag(i.kind, "vehicle"),
  );
  const rosterOptions = d.roster.map((r) => ({
    value: r.membershipId,
    label: r.name ?? "Member",
  }));

  return (
    <Stack gap="md" mt="md">
      <Text size="sm" c="dimmed">
        Sharing a tent, RV, or vehicle? Add the other campers staying in it.
      </Text>
      {holders.length === 0 ? (
        <Text c="dimmed" size="sm">
          Add a tent/RV/vehicle in the previous step to assign occupants.
        </Text>
      ) : (
        holders.map((item) => {
          const def = kindDef(item.kind);
          const occ = d.occupants.filter((o) => o.objectId === item.id);
          const occIds = new Set(occ.map((o) => o.membershipId));
          const avail = rosterOptions.filter((r) => !occIds.has(r.value));
          return (
            <Paper key={item.id} withBorder p="sm" radius="md">
              <Group gap="sm" mb={6}>
                <ShapeSwatch kind={def} size={18} />
                <Text fw={600} size="sm">
                  {item.name ?? def.label}
                </Text>
              </Group>
              <Group gap={6} mb="xs">
                {occ.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    Just you so far.
                  </Text>
                ) : (
                  occ.map((o) => (
                    <Badge
                      key={o.membershipId}
                      variant="light"
                      rightSection={
                        d.locked ? null : (
                          <ActionIcon
                            size="xs"
                            variant="transparent"
                            color="gray"
                            onClick={() =>
                              fetcher.submit(
                                {
                                  intent: "removeOccupant",
                                  objectId: item.id,
                                  membershipId: o.membershipId,
                                },
                                { method: "post" },
                              )
                            }
                          >
                            ✕
                          </ActionIcon>
                        )
                      }
                    >
                      {o.name ?? "Member"}
                    </Badge>
                  ))
                )}
              </Group>
              {!d.locked && avail.length > 0 ? (
                <Select
                  size="xs"
                  placeholder="Add a camper…"
                  searchable
                  data={avail}
                  value={null}
                  onChange={(v) =>
                    v &&
                    fetcher.submit(
                      {
                        intent: "addOccupant",
                        objectId: item.id,
                        membershipId: v,
                      },
                      { method: "post" },
                    )
                  }
                  comboboxProps={{ withinPortal: true }}
                />
              ) : null}
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

function ChecklistStep({ data: d }: { data: LoaderData }) {
  // Reuse the onboarding page's toggle action.
  const fetcher = useFetcher();
  return (
    <Stack gap="sm" mt="md">
      <Text size="sm" c="dimmed">
        A few things the camp asks everyone to take care of.
      </Text>
      {d.tasks.length === 0 ? (
        <Text c="dimmed" size="sm">
          No checklist items yet — you're good.
        </Text>
      ) : (
        d.tasks.map((t) => (
          <Checkbox
            key={t.id}
            label={t.title}
            checked={t.done}
            onChange={() =>
              fetcher.submit(
                { intent: "toggle", taskId: t.id },
                { method: "post", action: "/onboarding" },
              )
            }
          />
        ))
      )}
    </Stack>
  );
}
