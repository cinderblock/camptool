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
import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { onboardingCompletion, onboardingTask } from "../../../db/schema";
import type { Route } from "./+types/onboarding";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Onboarding · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  const membershipId = active.membership.id;

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

  return {
    canManage: hasAtLeast(active.membership.role, "officer"),
    tasks: tasks.map((t) => ({ ...t, done: doneSet.has(t.id) })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
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

export default function Onboarding({ loaderData }: Route.ComponentProps) {
  const { tasks, canManage } = loaderData;
  const toggleFetcher = useFetcher<FetcherData>();
  const manageFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);

  useFetcherError(toggleFetcher.data, toggleFetcher.state);
  useFetcherError(manageFetcher.data, manageFetcher.state, () =>
    addFormRef.current?.reset(),
  );

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
            <Stack gap="sm">
              {tasks.map((t) => (
                <Group
                  key={t.id}
                  justify="space-between"
                  wrap="nowrap"
                  align="flex-start"
                >
                  <Checkbox
                    checked={t.done}
                    onChange={() =>
                      toggleFetcher.submit(
                        { intent: "toggle", taskId: t.id },
                        { method: "post" },
                      )
                    }
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
                  {canManage ? (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label="Delete task"
                      onClick={() =>
                        manageFetcher.submit(
                          { intent: "deleteTask", taskId: t.id },
                          { method: "post" },
                        )
                      }
                    >
                      ×
                    </ActionIcon>
                  ) : null}
                </Group>
              ))}
            </Stack>
          </Card>
        ) : (
          <Text c="dimmed">
            No onboarding tasks yet.
            {canManage ? " Add the first one below." : ""}
          </Text>
        )}

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
