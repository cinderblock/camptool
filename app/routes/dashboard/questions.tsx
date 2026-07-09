import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  restrictToParentElement,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ActionIcon,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, asc, eq } from "drizzle-orm";
import { memo, useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { QuestionField } from "~/components/QuestionField";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import {
  QUESTION_AUDIENCES,
  QUESTION_PLACEMENTS,
  QUESTION_SCOPES,
  QUESTION_SURFACES,
  QUESTION_TYPES,
  type QuestionAudience,
  type QuestionPlacement,
  type QuestionScope,
  type QuestionSurface,
  type QuestionType,
  isSelectType,
  parseOptions,
  surfacedInWizard,
} from "~/lib/questions";
import {
  filterByAudience,
  importApplicationAnswers,
  loadAnswers,
  loadCampQuestions,
  loadInviterName,
  loadInviterOptions,
  setAnswer,
} from "~/lib/questions.server";
import { requireActiveEdition } from "~/lib/session.server";
import { audienceForRole } from "~/lib/wizard";
import { db } from "../../../db/client.server";
import { campQuestion } from "../../../db/schema";
import type { Route } from "./+types/questions";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Questions · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "questions");
  const campId = active.camp.id;
  const role = active.membership.role;
  const canManage = hasAtLeast(role, "officer");

  // A just-accepted applicant's apply-form answers become their answers here.
  await importApplicationAnswers({
    campId,
    editionId: activeEdition.id,
    membershipId: active.membership.id,
    userId: user.id,
  });

  const rows = await loadCampQuestions(campId);
  const answers = await loadAnswers({
    editionId: activeEdition.id,
    membershipId: active.membership.id,
  });
  const invitedByName = await loadInviterName(active.membership.id);
  const inviterOptions = await loadInviterOptions(campId);

  const questions = rows.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    helpText: q.helpText,
    type: q.type as QuestionType,
    options: parseOptions(q.options),
    audience: q.audience as QuestionAudience,
    placement: q.wizardPlacement as QuestionPlacement,
    scope: q.scope as QuestionScope,
    surface: q.surface as QuestionSurface,
    required: q.required,
    exclusiveOption: q.exclusiveOption,
  }));

  return {
    canManage,
    audience: audienceForRole(role),
    locked: activeEdition.locked,
    year: activeEdition.year,
    questions,
    answers,
    invitedByName,
    inviterOptions,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "questions");
  const campId = active.camp.id;
  const membershipId = active.membership.id;
  const role = active.membership.role;
  const canManage = hasAtLeast(role, "officer");

  const form = await request.formData();
  const intent = String(form.get("intent"));

  // --- Member answering (edition-scoped, so a locked year is read-only). ---
  if (intent === "answer") {
    if (activeEdition.locked) {
      return data({ error: "This year is locked." }, { status: 403 });
    }
    const questionId = String(form.get("questionId"));
    // Confirm the question belongs to this camp before storing an answer.
    const [q] = await db
      .select({ id: campQuestion.id, scope: campQuestion.scope })
      .from(campQuestion)
      .where(
        and(eq(campQuestion.id, questionId), eq(campQuestion.campId, campId)),
      )
      .limit(1);
    if (!q) return data({ error: "Question not found." }, { status: 404 });

    const raw = form.get("value");
    const value = raw == null || raw === "" ? null : String(raw);
    await setAnswer({
      campId,
      editionId: activeEdition.id,
      membershipId,
      questionId,
      scope: q.scope,
      value,
    });
    return data({ ok: true });
  }

  // --- Officer question management (camp-scoped config; not edition-gated). ---
  if (!canManage) {
    return data({ error: "You don't have permission." }, { status: 403 });
  }

  if (intent === "addQuestion") {
    const prompt = String(form.get("prompt") ?? "").trim();
    if (!prompt) return data({ error: "Prompt is required." }, { status: 400 });
    const type = String(form.get("type") ?? "short_text") as QuestionType;
    const audience = String(form.get("audience") ?? "all") as QuestionAudience;
    const required = form.get("required") === "on";
    const helpText = String(form.get("helpText") ?? "").trim() || null;

    let options: string | null = null;
    if (isSelectType(type)) {
      const lines = String(form.get("options") ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) {
        return data(
          { error: "Choice questions need at least one option." },
          { status: 400 },
        );
      }
      options = JSON.stringify(lines);
    }

    const [last] = await db
      .select({ sortOrder: campQuestion.sortOrder })
      .from(campQuestion)
      .where(eq(campQuestion.campId, campId))
      .orderBy(asc(campQuestion.sortOrder));
    await db.insert(campQuestion).values({
      id: crypto.randomUUID(),
      campId,
      prompt,
      helpText,
      type,
      options,
      audience,
      required,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    });
    return data({ ok: true });
  }

  if (intent === "deleteQuestion") {
    const id = String(form.get("id"));
    await db
      .delete(campQuestion)
      .where(and(eq(campQuestion.id, id), eq(campQuestion.campId, campId)));
    return data({ ok: true });
  }

  if (intent === "editQuestion") {
    const id = String(form.get("id"));
    const field = String(form.get("field"));
    const val = String(form.get("value") ?? "");
    const set: Partial<typeof campQuestion.$inferInsert> = {
      updatedAt: new Date(),
    };
    switch (field) {
      case "prompt": {
        const p = val.trim();
        if (!p)
          return data({ error: "Prompt can't be empty." }, { status: 400 });
        set.prompt = p;
        break;
      }
      case "helpText":
        set.helpText = val.trim() || null;
        break;
      case "type":
        set.type = val as QuestionType;
        break;
      case "audience":
        set.audience = val as QuestionAudience;
        break;
      case "placement":
        set.wizardPlacement = val === "after" ? "after" : "before";
        break;
      case "scope":
        set.scope = val === "once" ? "once" : "per_edition";
        break;
      case "surface":
        set.surface = val === "application" || val === "both" ? val : "wizard";
        break;
      case "required":
        set.required = val === "true";
        break;
      case "options": {
        const lines = val
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        set.options = lines.length ? JSON.stringify(lines) : null;
        // Drop a stale exclusive option that no longer exists in the new list.
        const [cur] = await db
          .select({ exclusiveOption: campQuestion.exclusiveOption })
          .from(campQuestion)
          .where(and(eq(campQuestion.id, id), eq(campQuestion.campId, campId)))
          .limit(1);
        if (cur?.exclusiveOption && !lines.includes(cur.exclusiveOption)) {
          set.exclusiveOption = null;
        }
        break;
      }
      case "exclusiveOption":
        set.exclusiveOption = val.trim() || null;
        break;
      default:
        return data({ error: "Unknown field." }, { status: 400 });
    }
    await db
      .update(campQuestion)
      .set(set)
      .where(and(eq(campQuestion.id, id), eq(campQuestion.campId, campId)));
    return data({ ok: true });
  }

  if (intent === "reorder") {
    let ids: string[] = [];
    try {
      const v = JSON.parse(String(form.get("ids") ?? "[]"));
      if (Array.isArray(v))
        ids = v.filter((x): x is string => typeof x === "string");
    } catch {
      return data({ error: "Bad order." }, { status: 400 });
    }
    const owned = new Set((await loadCampQuestions(campId)).map((r) => r.id));
    let k = 0;
    for (const id of ids) {
      if (!owned.has(id)) continue;
      await db
        .update(campQuestion)
        .set({ sortOrder: k })
        .where(and(eq(campQuestion.id, id), eq(campQuestion.campId, campId)));
      k++;
    }
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: boolean; error?: string };
type LoaderData = Route.ComponentProps["loaderData"];
type Question = LoaderData["questions"][number];

export default function Questions({ loaderData }: Route.ComponentProps) {
  const {
    questions,
    answers,
    canManage,
    audience,
    locked,
    year,
    invitedByName,
    inviterOptions,
  } = loaderData;
  // Members only see the questions relevant to them (application-only ones are
  // the apply form's, not theirs); officers manage all of them.
  const mine = questions.filter(
    (q) =>
      (q.audience === "all" || q.audience === audience) &&
      surfacedInWizard(q.surface),
  );

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Questions</Title>
          <Text c="dimmed" size="sm">
            Your camp's questionnaire for {year}.
          </Text>
        </div>

        {locked ? (
          <Text size="sm" c="dimmed">
            This year is locked — answers are read-only.
          </Text>
        ) : null}

        {canManage ? (
          // Officers: one combined list — each card edits the question AND shows
          // it live (answer/preview) — plus drag-to-reorder.
          <QuestionEditor
            questions={questions}
            answers={answers}
            locked={locked}
            year={year}
            invitedByName={invitedByName}
            inviterOptions={inviterOptions}
          />
        ) : mine.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Stack gap="lg">
              {mine.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  value={answers[q.id]}
                  locked={locked}
                  year={year}
                  invitedByName={invitedByName}
                  inviterOptions={inviterOptions}
                />
              ))}
            </Stack>
          </Card>
        ) : (
          <Text c="dimmed">No questions yet.</Text>
        )}
      </Stack>
    </Container>
  );
}

/** Officer view: the questions edited in place, drag-to-reorder, with an add
 * button. Replaces the old read-only "Manage" card + separate add form. */
function QuestionEditor({
  questions,
  answers,
  locked,
  year,
  invitedByName,
  inviterOptions,
}: {
  questions: Question[];
  answers: Record<string, string>;
  locked: boolean;
  year: number;
  invitedByName: string | null;
  inviterOptions: string[];
}) {
  // Local copy so a drag reorders instantly; re-synced when the loader updates.
  const [order, setOrder] = useState<Question[]>(questions);
  useEffect(() => setOrder(questions), [questions]);

  const reorderFetcher = useFetcher();
  const addFetcher = useFetcher<FetcherData>();
  useFetcherError(addFetcher.data, addFetcher.state);

  // distance:3 activates the drag quickly (less start-lag) while still letting
  // clicks land on the inputs/handle without triggering a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((q) => q.id === active.id);
    const newIndex = order.findIndex((q) => q.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    reorderFetcher.submit(
      { intent: "reorder", ids: JSON.stringify(next.map((q) => q.id)) },
      { method: "post" },
    );
  }

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Edit questions</Text>
        <Button
          size="xs"
          variant="light"
          loading={addFetcher.state !== "idle"}
          onClick={() =>
            addFetcher.submit(
              {
                intent: "addQuestion",
                prompt: "New question",
                type: "short_text",
                audience: "all",
              },
              { method: "post" },
            )
          }
        >
          + Add question
        </Button>
      </Group>
      {order.length === 0 ? (
        <Text c="dimmed" size="sm">
          No questions yet — add the first one.
        </Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={order.map((q) => q.id)}
            strategy={verticalListSortingStrategy}
          >
            <Stack gap="sm">
              {order.map((q) => (
                <SortableQuestion
                  key={q.id}
                  q={q}
                  value={answers[q.id]}
                  locked={locked}
                  year={year}
                  invitedByName={invitedByName}
                  inviterOptions={inviterOptions}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Card>
  );
}

/** Click-to-edit text: shows `value` as text; clicking swaps to an input that
 * saves on blur / Enter (Escape cancels). The WYSIWYG editing primitive. */
function EditableText({
  value,
  onSave,
  placeholder,
  fw,
  size = "sm",
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder: string;
  fw?: number;
  size?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <TextInput
        size={size}
        autoFocus
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(e) => {
          setEditing(false);
          if (e.currentTarget.value !== value) onSave(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <Text
      size={size}
      fw={fw}
      c={value ? undefined : "dimmed"}
      onClick={() => setEditing(true)}
      style={{ cursor: "text", minHeight: "1.5em" }}
    >
      {value || placeholder}
    </Text>
  );
}

/** Click-to-edit list of choices for single/multi questions. When
 * `onExclusiveChange` is provided (multi_select), each choice gets a toggle to
 * mark it the mutually-exclusive option ("clears the others" — e.g. "I don't
 * have space" on a ride-share question). */
function OptionsEditor({
  options,
  onChange,
  exclusiveOption,
  onExclusiveChange,
}: {
  options: string[];
  onChange: (opts: string[]) => void;
  exclusiveOption?: string | null;
  onExclusiveChange?: (opt: string | null) => void;
}) {
  return (
    <Stack gap={2}>
      {options.map((opt, i) => {
        const isExclusive = !!exclusiveOption && exclusiveOption === opt;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: options are positional
          <Group key={i} gap={4} wrap="nowrap" align="center">
            <Text size="sm" c="dimmed">
              •
            </Text>
            <div style={{ flex: 1, minWidth: 0 }}>
              <EditableText
                value={opt}
                placeholder="Choice"
                onSave={(v) => {
                  const next = options.slice();
                  next[i] = v;
                  onChange(next.filter((o) => o.trim()));
                }}
              />
            </div>
            {onExclusiveChange ? (
              <Tooltip
                label={
                  isExclusive
                    ? "Exclusive: picking this clears the others"
                    : "Make exclusive (clears the others)"
                }
                withArrow
              >
                <ActionIcon
                  size="sm"
                  variant={isExclusive ? "filled" : "subtle"}
                  color={isExclusive ? "blue" : "gray"}
                  aria-label="Toggle exclusive option"
                  onClick={() => onExclusiveChange(isExclusive ? null : opt)}
                >
                  ⊘
                </ActionIcon>
              </Tooltip>
            ) : null}
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label="Remove choice"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
            >
              ×
            </ActionIcon>
          </Group>
        );
      })}
      <Button
        size="compact-xs"
        variant="subtle"
        w="fit-content"
        onClick={() => onChange([...options, `Choice ${options.length + 1}`])}
      >
        + Add choice
      </Button>
    </Stack>
  );
}

/** One question as a WYSIWYG card: the prompt, help, and choices are the rendered
 * question text — click any of them to edit in place. Type / audience / required
 * (not text) sit in a small settings row. Drag handle reorders. Memoized so a drag
 * re-renders only the moving row. */
const SortableQuestion = memo(function SortableQuestion({
  q,
  value,
  locked,
  year,
  invitedByName,
  inviterOptions,
}: {
  q: Question;
  value: string | undefined;
  locked: boolean;
  year: number;
  invitedByName: string | null;
  inviterOptions: string[];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: q.id });
  const fetcher = useFetcher<FetcherData>();
  useFetcherError(fetcher.data, fetcher.state);
  const save = (field: string, val: string) =>
    fetcher.submit(
      { intent: "editQuestion", id: q.id, field, value: val },
      { method: "post" },
    );

  return (
    <Card
      ref={setNodeRef}
      withBorder
      padding="sm"
      radius="md"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Drag to reorder"
          style={{ cursor: "grab", touchAction: "none" }}
          {...attributes}
          {...listeners}
        >
          ⠿
        </ActionIcon>
        <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Group gap={4} wrap="nowrap" align="baseline">
            <div style={{ flex: 1, minWidth: 0 }}>
              <EditableText
                value={q.prompt}
                fw={600}
                placeholder="Question prompt"
                onSave={(v) => v.trim() && save("prompt", v)}
              />
            </div>
            {q.required ? (
              <Text c="red" size="sm">
                *
              </Text>
            ) : null}
          </Group>
          <EditableText
            value={q.helpText ?? ""}
            size="xs"
            placeholder="Add help text (optional)"
            onSave={(v) => save("helpText", v)}
          />
          {isSelectType(q.type) ? (
            <OptionsEditor
              options={q.options}
              onChange={(opts) => save("options", opts.join("\n"))}
              exclusiveOption={
                q.type === "multi_select" ? q.exclusiveOption : undefined
              }
              onExclusiveChange={
                q.type === "multi_select"
                  ? (opt) => save("exclusiveOption", opt ?? "")
                  : undefined
              }
            />
          ) : (
            <QuestionField
              question={q}
              value={value}
              locked={locked}
              year={year}
              invitedByName={invitedByName}
              inviterOptions={inviterOptions}
              bare
            />
          )}
          <Group gap="xs" align="center" mt={4} c="dimmed">
            <Select
              size="xs"
              aria-label="Type"
              data={QUESTION_TYPES}
              value={q.type}
              onChange={(v) => v && v !== q.type && save("type", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={150}
            />
            <Select
              size="xs"
              aria-label="Who answers"
              data={QUESTION_AUDIENCES}
              value={q.audience}
              onChange={(v) => v && v !== q.audience && save("audience", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={160}
            />
            <Select
              size="xs"
              aria-label="Wizard placement"
              data={QUESTION_PLACEMENTS}
              value={q.placement}
              onChange={(v) => v && v !== q.placement && save("placement", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={170}
            />
            <Select
              size="xs"
              aria-label="How often it's asked"
              data={QUESTION_SCOPES}
              value={q.scope}
              onChange={(v) => v && v !== q.scope && save("scope", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={120}
            />
            <Select
              size="xs"
              aria-label="Where it's asked"
              data={QUESTION_SURFACES}
              value={q.surface}
              onChange={(v) => v && v !== q.surface && save("surface", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={180}
            />
            <Checkbox
              size="xs"
              label="Required"
              checked={q.required}
              onChange={(e) =>
                save("required", e.currentTarget.checked ? "true" : "false")
              }
            />
          </Group>
        </Stack>
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label="Delete question"
          onClick={() =>
            fetcher.submit(
              { intent: "deleteQuestion", id: q.id },
              { method: "post" },
            )
          }
        >
          ×
        </ActionIcon>
      </Group>
    </Card>
  );
});

function useFetcherError(
  data: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !data || data === seen.current) return;
    seen.current = data;
    if (data.error) {
      notifications.show({ color: "red", title: "Error", message: data.error });
    } else if (data.ok) {
      onOk?.();
    }
  }, [data, state, onOk]);
}
