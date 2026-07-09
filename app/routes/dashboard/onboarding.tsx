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
  Box,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  Progress,
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
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { type QuestionType, parseOptions } from "~/lib/questions";
import {
  filterByAudience,
  loadAnswers,
  loadCampQuestions,
  loadInviterName,
} from "~/lib/questions.server";
import { requireActiveCamp, requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { onboardingCompletion, onboardingTask } from "../../../db/schema";
import type { Route } from "./+types/onboarding";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Onboarding · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "onboarding");
  const campId = active.camp.id;
  const membershipId = active.membership.id;
  const role = active.membership.role;

  const tasks = await db
    .select()
    .from(onboardingTask)
    .where(eq(onboardingTask.campId, campId))
    .orderBy(asc(onboardingTask.sortOrder), asc(onboardingTask.createdAt));

  const done = await db
    .select({ taskId: onboardingCompletion.taskId })
    .from(onboardingCompletion)
    .where(eq(onboardingCompletion.membershipId, membershipId));
  const doneSet = new Set(done.map((d) => d.taskId));

  // The camp questionnaire (e.g. the email-list opt-in) is part of onboarding,
  // so surface the member's relevant questions here too. Answers are
  // edition-scoped and saved via the /questions route's "answer" action.
  const questions = filterByAudience(await loadCampQuestions(campId), role).map(
    (q) => ({
      id: q.id,
      prompt: q.prompt,
      helpText: q.helpText,
      type: q.type as QuestionType,
      options: parseOptions(q.options),
      required: q.required,
      exclusiveOption: q.exclusiveOption,
    }),
  );
  const answers = await loadAnswers({
    editionId: activeEdition.id,
    membershipId,
  });
  const invitedByName = await loadInviterName(membershipId);

  return {
    canManage: hasAtLeast(role, "officer"),
    tasks: tasks.map((t) => ({ ...t, done: doneSet.has(t.id) })),
    questions,
    answers,
    invitedByName,
    year: activeEdition.year,
    locked: activeEdition.locked,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  await requireFeature(active, "onboarding");
  const campId = active.camp.id;
  const membershipId = active.membership.id;
  const canManage = hasAtLeast(active.membership.role, "officer");

  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "toggle") {
    const taskId = String(form.get("taskId"));
    const [task] = await db
      .select({ id: onboardingTask.id })
      .from(onboardingTask)
      .where(
        and(eq(onboardingTask.id, taskId), eq(onboardingTask.campId, campId)),
      );
    if (!task) return data({ error: "Task not found." }, { status: 404 });

    const [existing] = await db
      .select({ id: onboardingCompletion.id })
      .from(onboardingCompletion)
      .where(
        and(
          eq(onboardingCompletion.membershipId, membershipId),
          eq(onboardingCompletion.taskId, taskId),
        ),
      );
    if (existing) {
      await db
        .delete(onboardingCompletion)
        .where(eq(onboardingCompletion.id, existing.id));
    } else {
      await db.insert(onboardingCompletion).values({
        id: crypto.randomUUID(),
        campId,
        membershipId,
        taskId,
      });
    }
    return data({ ok: true });
  }

  if (intent === "addTask") {
    if (!canManage) {
      return data({ error: "You don't have permission." }, { status: 403 });
    }
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim() || null;
    if (!title) return data({ error: "Title is required." }, { status: 400 });

    const [last] = await db
      .select({ sortOrder: onboardingTask.sortOrder })
      .from(onboardingTask)
      .where(eq(onboardingTask.campId, campId))
      .orderBy(asc(onboardingTask.sortOrder));
    await db.insert(onboardingTask).values({
      id: crypto.randomUUID(),
      campId,
      title,
      description,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    });
    return data({ ok: true });
  }

  if (intent === "editTask") {
    if (!canManage) {
      return data({ error: "You don't have permission." }, { status: 403 });
    }
    const taskId = String(form.get("taskId"));
    const field = String(form.get("field"));
    const raw = String(form.get("value") ?? "");
    const set: Partial<typeof onboardingTask.$inferInsert> = {};
    if (field === "title") {
      const t = raw.trim();
      if (!t) return data({ error: "Title can't be empty." }, { status: 400 });
      set.title = t;
    } else if (field === "description") {
      set.description = raw.trim() || null;
    } else {
      return data({ error: "Unknown field." }, { status: 400 });
    }
    await db
      .update(onboardingTask)
      .set(set)
      .where(
        and(eq(onboardingTask.id, taskId), eq(onboardingTask.campId, campId)),
      );
    return data({ ok: true });
  }

  if (intent === "reorderTasks") {
    if (!canManage) {
      return data({ error: "You don't have permission." }, { status: 403 });
    }
    let ids: string[] = [];
    try {
      const v = JSON.parse(String(form.get("ids") ?? "[]"));
      if (Array.isArray(v))
        ids = v.filter((x): x is string => typeof x === "string");
    } catch {
      return data({ error: "Bad order." }, { status: 400 });
    }
    const owned = new Set(
      (
        await db
          .select({ id: onboardingTask.id })
          .from(onboardingTask)
          .where(eq(onboardingTask.campId, campId))
      ).map((r) => r.id),
    );
    let k = 0;
    for (const id of ids) {
      if (!owned.has(id)) continue;
      await db
        .update(onboardingTask)
        .set({ sortOrder: k })
        .where(
          and(eq(onboardingTask.id, id), eq(onboardingTask.campId, campId)),
        );
      k++;
    }
    return data({ ok: true });
  }

  if (intent === "deleteTask") {
    if (!canManage) {
      return data({ error: "You don't have permission." }, { status: 403 });
    }
    const taskId = String(form.get("taskId"));
    await db
      .delete(onboardingTask)
      .where(
        and(eq(onboardingTask.id, taskId), eq(onboardingTask.campId, campId)),
      );
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: boolean; error?: string };
type Task = Route.ComponentProps["loaderData"]["tasks"][number];

/** One officer task row: drag handle + done checkbox + inline-editable title and
 * description (auto-save on blur) + delete. */
function SortableTask({
  task,
  onToggle,
  onEdit,
  onDelete,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onEdit: (id: string, field: string, value: string) => void;
  onDelete: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  return (
    <Group
      ref={setNodeRef}
      wrap="nowrap"
      align="flex-start"
      gap="sm"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <ActionIcon
        variant="subtle"
        color="gray"
        aria-label="Drag to reorder"
        mt={6}
        style={{ cursor: "grab", touchAction: "none" }}
        {...attributes}
        {...listeners}
      >
        ⠿
      </ActionIcon>
      <Checkbox mt={6} checked={task.done} onChange={() => onToggle(task.id)} />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <TextInput
          size="xs"
          defaultValue={task.title}
          placeholder="Task title"
          onBlur={(e) =>
            e.currentTarget.value.trim() &&
            e.currentTarget.value !== task.title &&
            onEdit(task.id, "title", e.currentTarget.value)
          }
        />
        <Textarea
          size="xs"
          autosize
          minRows={1}
          placeholder="Description (optional)"
          defaultValue={task.description ?? ""}
          onBlur={(e) =>
            e.currentTarget.value !== (task.description ?? "") &&
            onEdit(task.id, "description", e.currentTarget.value)
          }
        />
      </Stack>
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label="Delete task"
        mt={6}
        onClick={() => onDelete(task.id)}
      >
        ×
      </ActionIcon>
    </Group>
  );
}

export default function Onboarding({ loaderData }: Route.ComponentProps) {
  const { tasks, canManage, questions, answers, invitedByName, year, locked } =
    loaderData;
  const toggleFetcher = useFetcher<FetcherData>();
  const manageFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);

  useFetcherError(toggleFetcher.data, toggleFetcher.state);
  useFetcherError(manageFetcher.data, manageFetcher.state, () =>
    addFormRef.current?.reset(),
  );

  const editTask = (taskId: string, field: string, value: string) =>
    manageFetcher.submit(
      { intent: "editTask", taskId, field, value },
      { method: "post" },
    );
  const onToggle = (taskId: string) =>
    toggleFetcher.submit({ intent: "toggle", taskId }, { method: "post" });
  const onDelete = (taskId: string) =>
    manageFetcher.submit({ intent: "deleteTask", taskId }, { method: "post" });

  // Local order so a drag reorders instantly; re-synced when the loader updates.
  const reorderFetcher = useFetcher();
  const [order, setOrder] = useState(tasks);
  useEffect(() => setOrder(tasks), [tasks]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((t) => t.id === active.id);
    const newIndex = order.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    reorderFetcher.submit(
      { intent: "reorderTasks", ids: JSON.stringify(next.map((t) => t.id)) },
      { method: "post" },
    );
  }

  const completed = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

  return (
    <Container size="md">
      <Stack gap="lg">
        <Title order={2}>Onboarding</Title>

        {tasks.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" mb="xs">
              <Text fw={600}>Your checklist</Text>
              <Text size="sm" c="dimmed">
                {completed} / {tasks.length} done
              </Text>
            </Group>
            <Progress value={pct} mb="md" />
            {canManage ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={order.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <Stack gap="sm">
                    {order.map((t) => (
                      <SortableTask
                        key={t.id}
                        task={t}
                        onToggle={onToggle}
                        onEdit={editTask}
                        onDelete={onDelete}
                      />
                    ))}
                  </Stack>
                </SortableContext>
              </DndContext>
            ) : (
              <Stack gap="sm">
                {tasks.map((t) => (
                  <Checkbox
                    key={t.id}
                    checked={t.done}
                    onChange={() => onToggle(t.id)}
                    label={
                      <Box>
                        <Text size="sm">{t.title}</Text>
                        {t.description ? (
                          <Text size="xs" c="dimmed">
                            {t.description}
                          </Text>
                        ) : null}
                      </Box>
                    }
                  />
                ))}
              </Stack>
            )}
          </Card>
        ) : (
          <Text c="dimmed">
            No onboarding tasks yet.
            {canManage ? " Add the first one below." : ""}
          </Text>
        )}

        {questions.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Group justify="space-between" mb="xs">
              <Text fw={600}>Camp questions</Text>
              {locked ? (
                <Text size="sm" c="dimmed">
                  Locked — answers are read-only
                </Text>
              ) : null}
            </Group>
            <Stack gap="lg">
              {questions.map((q) => (
                <QuestionField
                  key={q.id}
                  question={q}
                  value={answers[q.id]}
                  locked={locked}
                  year={year}
                  invitedByName={invitedByName}
                  action="/questions"
                />
              ))}
            </Stack>
          </Card>
        ) : null}

        {canManage ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} mb="sm">
              Add an onboarding task
            </Text>
            <manageFetcher.Form method="post" ref={addFormRef}>
              <input type="hidden" name="intent" value="addTask" />
              <Stack gap="sm">
                <TextInput
                  name="title"
                  label="Title"
                  placeholder="e.g. Pay your dues"
                  required
                />
                <Textarea
                  name="description"
                  label="Description"
                  placeholder="Optional details or a link."
                  autosize
                  minRows={2}
                />
                <Group justify="flex-end">
                  <Button
                    type="submit"
                    loading={manageFetcher.state !== "idle"}
                  >
                    Add task
                  </Button>
                </Group>
              </Stack>
            </manageFetcher.Form>
          </Card>
        ) : null}
      </Stack>
    </Container>
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
