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
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, asc, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { QuestionField } from "~/components/QuestionField";
import { hasAtLeast } from "~/lib/permissions";
import {
  QUESTION_AUDIENCES,
  QUESTION_TYPES,
  type QuestionAudience,
  type QuestionType,
  isSelectType,
  parseOptions,
} from "~/lib/questions";
import {
  filterByAudience,
  loadAnswers,
  loadCampQuestions,
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
  const { active, activeEdition } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const role = active.membership.role;
  const canManage = hasAtLeast(role, "officer");

  const rows = await loadCampQuestions(campId);
  const answers = await loadAnswers({
    editionId: activeEdition.id,
    membershipId: active.membership.id,
  });

  const questions = rows.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    helpText: q.helpText,
    type: q.type as QuestionType,
    options: parseOptions(q.options),
    audience: q.audience as QuestionAudience,
    required: q.required,
  }));

  return {
    canManage,
    audience: audienceForRole(role),
    locked: activeEdition.locked,
    year: activeEdition.year,
    questions,
    answers,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
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
      .select({ id: campQuestion.id })
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
      case "required":
        set.required = val === "true";
        break;
      case "options": {
        const lines = val
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        set.options = lines.length ? JSON.stringify(lines) : null;
        break;
      }
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
  const { questions, canManage, audience, locked, year } = loaderData;
  const mine = questions.filter(
    (q) => q.audience === "all" || q.audience === audience,
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

        {mine.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} mb="xs">
              Your answers
            </Text>
            {locked ? (
              <Text size="sm" c="dimmed" mb="sm">
                This year is locked — answers are read-only.
              </Text>
            ) : null}
            <Stack gap="lg">
              {mine.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  value={loaderData.answers[q.id]}
                  locked={locked}
                />
              ))}
            </Stack>
          </Card>
        ) : (
          <Text c="dimmed">
            No questions yet.
            {canManage ? " Add the first one below." : ""}
          </Text>
        )}

        {canManage ? <QuestionEditor questions={questions} /> : null}
      </Stack>
    </Container>
  );
}

/** Officer view: the questions edited in place, drag-to-reorder, with an add
 * button. Replaces the old read-only "Manage" card + separate add form. */
function QuestionEditor({ questions }: { questions: Question[] }) {
  // Local copy so a drag reorders instantly; re-synced when the loader updates.
  const [order, setOrder] = useState<Question[]>(questions);
  useEffect(() => setOrder(questions), [questions]);

  const reorderFetcher = useFetcher();
  const addFetcher = useFetcher<FetcherData>();
  useFetcherError(addFetcher.data, addFetcher.state);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
                <SortableQuestion key={q.id} q={q} />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}
    </Card>
  );
}

/** One inline-editable question row. Each field auto-saves (blur for text,
 * change for selects/checkbox). The handle is the drag affordance. */
function SortableQuestion({ q }: { q: Question }) {
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
  const save = (field: string, value: string) =>
    fetcher.submit(
      { intent: "editQuestion", id: q.id, field, value },
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
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            size="xs"
            placeholder="Question prompt"
            defaultValue={q.prompt}
            onBlur={(e) =>
              e.currentTarget.value.trim() &&
              e.currentTarget.value !== q.prompt &&
              save("prompt", e.currentTarget.value)
            }
          />
          <TextInput
            size="xs"
            placeholder="Help text (optional)"
            defaultValue={q.helpText ?? ""}
            onBlur={(e) =>
              e.currentTarget.value !== (q.helpText ?? "") &&
              save("helpText", e.currentTarget.value)
            }
          />
          <Group gap="xs" align="flex-end">
            <Select
              size="xs"
              label="Type"
              data={QUESTION_TYPES}
              value={q.type}
              onChange={(v) => v && v !== q.type && save("type", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={150}
            />
            <Select
              size="xs"
              label="Who answers"
              data={QUESTION_AUDIENCES}
              value={q.audience}
              onChange={(v) => v && v !== q.audience && save("audience", v)}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              w={160}
            />
            <Checkbox
              label="Required"
              checked={q.required}
              onChange={(e) =>
                save("required", e.currentTarget.checked ? "true" : "false")
              }
            />
          </Group>
          {isSelectType(q.type) ? (
            <Textarea
              size="xs"
              label="Choices (one per line)"
              defaultValue={q.options.join("\n")}
              onBlur={(e) => save("options", e.currentTarget.value)}
              autosize
              minRows={2}
            />
          ) : null}
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
}

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
