import {
  ActionIcon,
  Anchor,
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
  Title,
  Tooltip,
} from "@mantine/core";
import { and, asc, eq } from "drizzle-orm";
import { useState } from "react";
import { Link, data, useFetcher, useNavigate } from "react-router";
import { type AddSize, AddStructures } from "~/components/AddStructures";
import { announce } from "~/components/Announcer";
import { PlayaNameField } from "~/components/PlayaNameField";
import { QuestionField } from "~/components/QuestionField";
import {
  type ParticipationStatus,
  RsvpButtons,
  StayPicker,
  type TripData,
  TripNote,
} from "~/components/TripPlanner";
import { parseBannedKinds } from "~/lib/bans";
import { eventWindowFor, weeksUntilEvent } from "~/lib/brc";
import { shownQuestions } from "~/lib/conditions";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState } from "~/lib/features.server";
import { redact } from "~/lib/privacy.server";
import type { QuestionType } from "~/lib/questions";
import { isAnswered, parseOptions, surfacedInWizard } from "~/lib/questions";
import {
  filterByAudience,
  importApplicationAnswers,
  loadAnswers,
  loadCampQuestions,
  loadInviterName,
  loadInviterOptions,
} from "~/lib/questions.server";
import { loadMySapState } from "~/lib/sap.server";
import { requireActiveEdition } from "~/lib/session.server";
import { ShapeSwatch, hasTag, kindDef } from "~/lib/structures";
import type { AskKey } from "~/lib/wizard";
import { audienceForRole } from "~/lib/wizard";
import { loadWizardState, resolveAsk } from "~/lib/wizard.server";
import { db } from "../../db/client.server";
import {
  attendee,
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
    privacy,
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
  //
  // Whether this is that first visit also decides the page's voice: someone who
  // was *sent* here is being welcomed, someone who came back on purpose (via the
  // "Guided setup" nav link, Overview, or /guide) already knows what this is and
  // shouldn't be greeted as a stranger.
  const firstVisit = (me?.wizardStep ?? 0) === 0;
  if (firstVisit) {
    await db
      .update(membership)
      .set({ wizardStep: 1 })
      .where(eq(membership.id, mid));
  }

  const state = await loadWizardState({
    campId,
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
    attendeeId: string;
    membershipId: string | null;
    name: string | null;
  }[] = [];
  let roster: { membershipId: string; name: string | null }[] = [];
  // The viewer's own guests (attendee rows), addable as occupants of their tent.
  let myGuests: { attendeeId: string; name: string | null }[] = [];
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
    const occRows = await db
      .select({
        objectId: mapObjectOccupant.objectId,
        attendeeId: attendee.id,
        membershipId: attendee.membershipId,
        guestName: attendee.name,
        memberName: user.name,
      })
      .from(mapObjectOccupant)
      .innerJoin(mapObject, eq(mapObjectOccupant.objectId, mapObject.id))
      .innerJoin(attendee, eq(mapObjectOccupant.attendeeId, attendee.id))
      .leftJoin(membership, eq(attendee.membershipId, membership.id))
      .leftJoin(user, eq(membership.userId, user.id))
      .where(
        and(
          eq(mapObject.ownerMembershipId, mid),
          eq(mapObjectOccupant.editionId, editionId),
        ),
      );
    occupants = occRows.map((o) => ({
      objectId: o.objectId,
      attendeeId: o.attendeeId,
      membershipId: o.membershipId,
      name: o.guestName ?? o.memberName,
    }));

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

    // The viewer's own guests — addable as occupants alongside members.
    myGuests = await db
      .select({ attendeeId: attendee.id, name: attendee.name })
      .from(attendee)
      .where(
        and(
          eq(attendee.editionId, editionId),
          eq(attendee.hostMembershipId, mid),
        ),
      );
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
    // A just-accepted applicant's apply-form answers become their answers here
    // (one-time; no-op for everyone else).
    await importApplicationAnswers({
      campId,
      editionId,
      membershipId: mid,
      userId: authUser.id,
    });
    const inWizard = filterByAudience(
      await loadCampQuestions(campId),
      role,
    ).filter((q) => surfacedInWizard(q.surface));
    // Conditions are evaluated against the answers they already have, so a
    // follow-up appears the moment its premise is answered (the page
    // revalidates on save) and disappears when it's taken back.
    const rows = shownQuestions(inWizard, answers);
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

  // The trip controls are shared with `/trip`, which owns the writes — this
  // just feeds them (plans/wizard-step-homes.md). That includes the "requesting
  // a Setup Access Pass" switch, whose state comes from the same resolver both
  // pages use, so the wizard and the page can't disagree about it.
  const trip = {
    year: activeEdition.year,
    locked: activeEdition.locked,
    status: state.participation.status,
    arrivalDate: state.participation.arrivalDate,
    departureDate: state.participation.departureDate,
    note: state.participation.note,
    arrivalWindow: eventWindowFor(activeEdition.year),
    sap: {
      visible: featureVisibleTo(await getFeatureState(campId, "passes"), role),
      ...(await loadMySapState(editionId, mid)),
    },
  } satisfies TripData;

  return redact(privacy, {
    firstVisit,
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
    trip,
    playaName: me?.playaName ?? null,
    items,
    occupants,
    roster,
    myGuests,
    tasks,
    questionsBefore,
    questionsAfter,
    answers,
    invitedByName,
    inviterOptions,
  });
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
    // The questionnaire steps can't be resolved (done OR skipped) while a
    // required in-scope question is unanswered — the guarantee that important
    // questions get answered. Locked years are exempt: answers are read-only.
    if (
      (askKey === "questionnaire" || askKey === "extras") &&
      !activeEdition.locked
    ) {
      const placement = askKey === "extras" ? "after" : "before";
      const inWizard = filterByAudience(
        await loadCampQuestions(campId),
        active.membership.role,
      ).filter((q) => surfacedInWizard(q.surface));
      const answers = await loadAnswers({ editionId, membershipId: mid });
      // Hidden questions can't block: an unanswerable required question is a
      // disabled button with no visible cause. Evaluate conditions FIRST, then
      // ask which of the remaining are required.
      const required = shownQuestions(inWizard, answers).filter(
        (q) =>
          q.required &&
          (q.wizardPlacement === "after" ? "after" : "before") === placement,
      );
      if (required.length > 0) {
        const missing = required.filter(
          (q) => !isAnswered(q.type, answers[q.id]),
        );
        if (missing.length > 0) {
          return data(
            { error: "Please answer the required questions (marked *) first." },
            { status: 400 },
          );
        }
      }
    }
    await resolveAsk({ campId, editionId, membershipId: mid, askKey, status });
    return data({ ok: true });
  }

  // RSVP, stay dates and the Setup Access Pass request are owned by `/trip`;
  // occupants by `/bringing`. The wizard posts there rather than keeping a
  // second copy of those writes (plans/wizard-step-homes.md).
  return data({ error: "Unknown action." }, { status: 400 });
}

type LoaderData = Route.ComponentProps["loaderData"];

export default function StartWizard({ loaderData }: Route.ComponentProps) {
  const { scheduled, resolved, locked, weeksToEvent, firstVisit } = loaderData;
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const steps = scheduled;
  // Start at the first unresolved ask so returning campers land on what's left.
  const firstPending = steps.findIndex((s) => !resolved[s.key]);
  const [active, setActive] = useState(firstPending < 0 ? 0 : firstPending);
  const last = steps.length - 1;

  // A questionnaire step holds its Next/Skip until every required question on
  // it is answered (answers save as you go, so this clears live). The action
  // enforces the same rule server-side. Locked years exempt — read-only.
  const stepQuestions = (key: string | undefined) =>
    key === "questionnaire"
      ? loaderData.questionsBefore
      : key === "extras"
        ? loaderData.questionsAfter
        : [];
  const blocked =
    !locked &&
    stepQuestions(steps[active]?.key).some(
      (q) => q.required && !isAnswered(q.type, loaderData.answers[q.id]),
    );

  function mark(key: string, status: "done" | "skipped") {
    fetcher.submit(
      { intent: "resolveAsk", askKey: key, status },
      { method: "post" },
    );
  }
  // Step transitions are only visible (the vertical stepper collapses/expands)
  // — say where we landed so screen-reader users can follow along.
  function goTo(index: number) {
    setActive(index);
    const step = steps[index];
    announce(
      step
        ? `Step ${index + 1} of ${steps.length}: ${step.label}`
        : "All steps complete — you're all set. Your answers are saved.",
    );
  }
  function next(status: "done" | "skipped" = "done") {
    if (steps[active]) mark(steps[active].key, status);
    goTo(Math.min(last, active + 1));
  }
  function finish() {
    if (steps[active]) mark(steps[active].key, "done");
    // Advance past the last step so the Stepper shows its Completed panel —
    // an explicit "you're saved, safe to leave" confirmation — rather than
    // silently bouncing to the dashboard.
    goTo(last + 1);
  }

  return (
    <Container component="main" id="main-content" size="sm" py="xl">
      <Group justify="space-between" align="flex-end" mb="lg">
        <div>
          <Title order={1} size="h2">
            {firstVisit
              ? "Welcome — let's get you set up"
              : "Your setup, step by step"}
          </Title>
          <Text c="dimmed" size="sm">
            We only ask for what's relevant right now
            {weeksToEvent > 0 ? ` (~${weeksToEvent} weeks to the event)` : ""}.
            {firstVisit
              ? " Stop anytime and pick up where you left off."
              : " Everything here also has its own page — this is just the guided pass."}
          </Text>
        </div>
        <Button variant="subtle" size="xs" onClick={() => navigate("/")}>
          {firstVisit ? "Skip for now" : "Back to dashboard"}
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
        onStepClick={goTo}
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

      {blocked ? (
        <Text size="sm" c="red" mt="md">
          Answer the required questions (marked *) above to continue.
        </Text>
      ) : null}
      <Group justify="space-between" mt={blocked ? "xs" : "xl"}>
        <Button
          variant="default"
          onClick={() => goTo(Math.max(0, active - 1))}
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
                disabled={blocked}
                onClick={() => next("skipped")}
              >
                Skip this
              </Button>
              {active < last ? (
                <Button disabled={blocked} onClick={() => next("done")}>
                  Next
                </Button>
              ) : (
                <Button color="green" disabled={blocked} onClick={finish}>
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

function QuestionnaireStep({ data: d }: { data: LoaderData }) {
  return (
    <Stack gap="lg" mt="md" maw={520}>
      {/* The RSVP and stay controls are the same ones `/trip` renders, and they
          post to `/trip`'s action — the wizard is a view over that page's data,
          not a second copy of it. */}
      <Stack gap="xs">
        <RsvpButtons trip={d.trip} />
        {d.trip.status === "coming" || d.trip.status === "maybe" ? (
          <StayPicker trip={d.trip} />
        ) : null}
        <Anchor component={Link} to="/trip" size="xs">
          This lives on Your trip — you can change it there anytime.
        </Anchor>
      </Stack>
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
      {/* Walking past this step is itself the acknowledgement, so no
          "nothing to add" button here — that's `/trip`'s job. */}
      <TripNote trip={d.trip} settled />
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
                          aria-label={`Remove ${item.name ?? kindDef(item.kind).label}`}
                          onClick={() => remove(item.id)}
                        >
                          <span aria-hidden="true">✕</span>
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
  // Reuse the Bringing page's action — occupants live there now, so there is
  // one write path (plans/wizard-step-homes.md).
  const fetcher = useFetcher();
  const post = (fields: Record<string, string>) =>
    fetcher.submit(fields, { method: "post", action: "/bringing" });
  // Only structures that hold people (domiciles + vehicles) take occupants.
  const holders = d.items.filter(
    (i) => hasTag(i.kind, "domicile") || hasTag(i.kind, "vehicle"),
  );
  // Pick from other camp members (m:) or the viewer's own guests (a:).
  const memberOptions = d.roster.map((r) => ({
    value: `m:${r.membershipId}`,
    label: r.name ?? "Member",
    mid: r.membershipId,
  }));
  const guestOptions = d.myGuests.map((g) => ({
    value: `a:${g.attendeeId}`,
    label: `${g.name ?? "Guest"} (guest)`,
    aid: g.attendeeId,
  }));

  return (
    <Stack gap="md" mt="md">
      <Text size="sm" c="dimmed">
        Sharing a tent, RV, or vehicle? Add the other people staying in it —
        campers or your own guests.
      </Text>
      {holders.length === 0 ? (
        <Text c="dimmed" size="sm">
          Add a tent/RV/vehicle in the previous step to assign occupants.
        </Text>
      ) : (
        holders.map((item) => {
          const def = kindDef(item.kind);
          const occ = d.occupants.filter((o) => o.objectId === item.id);
          const occMids = new Set(
            occ.map((o) => o.membershipId).filter(Boolean),
          );
          const occAids = new Set(occ.map((o) => o.attendeeId));
          const availMembers = memberOptions.filter((m) => !occMids.has(m.mid));
          const availGuests = guestOptions.filter((g) => !occAids.has(g.aid));
          const grouped = [
            ...(availMembers.length > 0
              ? [{ group: "Campers", items: availMembers }]
              : []),
            ...(availGuests.length > 0
              ? [{ group: "Your guests", items: availGuests }]
              : []),
          ];
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
                      key={o.attendeeId}
                      variant="light"
                      color={o.membershipId ? undefined : "grape"}
                      rightSection={
                        d.locked ? null : (
                          <ActionIcon
                            size="xs"
                            variant="transparent"
                            color="gray"
                            aria-label={`Remove ${o.name ?? "person"} from ${item.name ?? kindDef(item.kind).label}`}
                            onClick={() =>
                              post({
                                intent: "removeOccupant",
                                objectId: item.id,
                                attendeeId: o.attendeeId,
                              })
                            }
                          >
                            <span aria-hidden="true">✕</span>
                          </ActionIcon>
                        )
                      }
                    >
                      {o.name ?? "Person"}
                    </Badge>
                  ))
                )}
              </Group>
              {!d.locked && grouped.length > 0 ? (
                <Select
                  size="xs"
                  placeholder="Add someone…"
                  searchable
                  data={grouped}
                  value={null}
                  onChange={(v) =>
                    v &&
                    post({
                      intent: "addOccupant",
                      objectId: item.id,
                      occupantRef: v,
                    })
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
