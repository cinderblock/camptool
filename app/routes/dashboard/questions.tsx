import {
  ActionIcon,
  Badge,
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
  Tooltip,
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
  audienceLabel,
  isSelectType,
  parseOptions,
  questionTypeLabel,
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

  if (intent === "move") {
    const id = String(form.get("id"));
    const dir = form.get("dir") === "up" ? -1 : 1;
    const rows = await loadCampQuestions(campId);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return data({ ok: true });
    const j = i + dir;
    if (j < 0 || j >= rows.length) return data({ ok: true });
    // Move the row, then renumber sequentially so order is stable regardless of ties.
    const reordered = rows.slice();
    const [moved] = reordered.splice(i, 1);
    if (!moved) return data({ ok: true });
    reordered.splice(j, 0, moved);
    for (let k = 0; k < reordered.length; k++) {
      const r = reordered[k];
      if (!r) continue;
      await db
        .update(campQuestion)
        .set({ sortOrder: k })
        .where(eq(campQuestion.id, r.id));
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

        {canManage ? <ManagePanel questions={questions} /> : null}
      </Stack>
    </Container>
  );
}

function ManagePanel({ questions }: { questions: Question[] }) {
  const manageFetcher = useFetcher<FetcherData>();
  const addFormRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<QuestionType>("short_text");
  useFetcherError(manageFetcher.data, manageFetcher.state, () => {
    addFormRef.current?.reset();
    setType("short_text");
  });

  return (
    <Stack gap="md">
      {questions.length > 0 ? (
        <Card withBorder padding="md" radius="md">
          <Text fw={600} mb="sm">
            Manage questions
          </Text>
          <Stack gap="xs">
            {questions.map((q, idx) => (
              <Group
                key={q.id}
                justify="space-between"
                wrap="nowrap"
                align="flex-start"
              >
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={500}>
                    {q.prompt}
                    {q.required ? (
                      <Text component="span" c="red" inherit>
                        {" *"}
                      </Text>
                    ) : null}
                  </Text>
                  <Group gap={6} mt={4}>
                    <Badge size="xs" variant="light">
                      {questionTypeLabel(q.type)}
                    </Badge>
                    <Badge size="xs" variant="light" color="grape">
                      {audienceLabel(q.audience)}
                    </Badge>
                    {q.options.length > 0 ? (
                      <Text size="xs" c="dimmed">
                        {q.options.join(" · ")}
                      </Text>
                    ) : null}
                  </Group>
                </div>
                <Group gap={2} wrap="nowrap">
                  <Tooltip label="Move up">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      disabled={idx === 0}
                      onClick={() =>
                        manageFetcher.submit(
                          { intent: "move", id: q.id, dir: "up" },
                          { method: "post" },
                        )
                      }
                    >
                      ↑
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Move down">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      disabled={idx === questions.length - 1}
                      onClick={() =>
                        manageFetcher.submit(
                          { intent: "move", id: q.id, dir: "down" },
                          { method: "post" },
                        )
                      }
                    >
                      ↓
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Delete (also removes answers)">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        manageFetcher.submit(
                          { intent: "deleteQuestion", id: q.id },
                          { method: "post" },
                        )
                      }
                    >
                      ×
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            ))}
          </Stack>
        </Card>
      ) : null}

      <Card withBorder padding="md" radius="md">
        <Text fw={600} mb="sm">
          Add a question
        </Text>
        <manageFetcher.Form method="post" ref={addFormRef}>
          <input type="hidden" name="intent" value="addQuestion" />
          <Stack gap="sm">
            <TextInput
              name="prompt"
              label="Question"
              placeholder="e.g. Is this your first Burning Man?"
              required
            />
            <TextInput
              name="helpText"
              label="Help text"
              placeholder="Optional note shown under the question."
            />
            <Group grow align="flex-start">
              <Select
                label="Type"
                data={QUESTION_TYPES}
                value={type}
                onChange={(v) => setType((v as QuestionType) ?? "short_text")}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
              />
              <Select
                name="audience"
                label="Who answers"
                data={QUESTION_AUDIENCES}
                defaultValue="all"
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
              />
            </Group>
            {/* The Select above is controlled; mirror its value into the form. */}
            <input type="hidden" name="type" value={type} />
            {isSelectType(type) ? (
              <Textarea
                name="options"
                label="Choices (one per line)"
                placeholder={
                  "First Burning Man\nNew to Math Camp\nReturning camper"
                }
                autosize
                minRows={3}
              />
            ) : null}
            <Checkbox name="required" label="Required" />
            <Group justify="flex-end">
              <Button type="submit" loading={manageFetcher.state !== "idle"}>
                Add question
              </Button>
            </Group>
          </Stack>
        </manageFetcher.Form>
      </Card>
    </Stack>
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
