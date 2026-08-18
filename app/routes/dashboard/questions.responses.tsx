/**
 * Officer view of what the camp actually answered.
 *
 * The questionnaire shipped with an authoring surface and a self-answering
 * surface but no way to READ the answers — `/questions` only ever loaded the
 * viewer's own. This is that missing half: every member's answers for the
 * active year, sliced two ways (by question / by person), plus the slice
 * officers ask for most, which is the inverse — who still hasn't answered.
 *
 * Read-only by construction: there is no action. Editing someone else's answer
 * is deliberately not offered; "work as" them if that's really needed.
 */
import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Container,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useMemo, useState } from "react";
import { Link, data } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  displayAnswer,
  isAnswered,
  isSelectType,
  parseMultiValue,
  questionApplies,
} from "~/lib/questions";
import { loadResponseMatrix } from "~/lib/questions.server";
import { requireActiveEdition } from "~/lib/session.server";
import type { Route } from "./+types/questions.responses";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Responses · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "questions");
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }

  const { questions, members } = await loadResponseMatrix({
    campId: active.camp.id,
    editionId: activeEdition.id,
  });

  return redact(privacy, { year: activeEdition.year, questions, members });
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Member = LoaderData["members"][number];
type Question = LoaderData["questions"][number];

const applies = questionApplies;

export default function Responses({ loaderData }: Route.ComponentProps) {
  const { year, questions, members } = loaderData;
  const [view, setView] = useState<"question" | "person">("question");
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const shownMembers = useMemo(
    () =>
      needle
        ? members.filter((m) =>
            `${m.name} ${m.playaName ?? ""} ${m.email}`
              .toLowerCase()
              .includes(needle),
          )
        : members,
    [members, needle],
  );
  const shownQuestions = useMemo(
    () =>
      needle
        ? questions.filter((q) => q.prompt.toLowerCase().includes(needle))
        : questions,
    [questions, needle],
  );

  return (
    <Container size="lg">
      <Stack gap="lg">
        <Stack gap={2}>
          <Title order={2}>Responses · {year}</Title>
          <Text size="sm" c="dimmed">
            What everyone answered. Lifetime questions show the same answer in
            every year; the rest are this year's.{" "}
            <Anchor component={Link} to="/questions" size="sm">
              Edit the questions themselves
            </Anchor>
          </Text>
        </Stack>

        <Group align="flex-end" wrap="wrap">
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as "question" | "person")}
            data={[
              { value: "question", label: "By question" },
              { value: "person", label: "By person" },
            ]}
          />
          <TextInput
            label={view === "question" ? "Find a question" : "Find a person"}
            placeholder="Type to filter"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            w={{ base: "100%", xs: 260 }}
          />
          {/* A plain anchor, not <Link>: this is a resource route with no UI,
              so the browser must fetch it rather than the router navigating. */}
          <Button component="a" href="/questions/responses.csv" variant="light">
            Download CSV
          </Button>
        </Group>

        {questions.length === 0 ? (
          <Text c="dimmed">
            No questions yet — add some on the Questions page and answers will
            show up here.
          </Text>
        ) : view === "question" ? (
          <ByQuestion questions={shownQuestions} members={members} />
        ) : (
          <ByPerson questions={questions} members={shownMembers} />
        )}
      </Stack>
    </Container>
  );
}

function ByQuestion({
  questions,
  members,
}: {
  questions: Question[];
  members: Member[];
}) {
  if (questions.length === 0)
    return <Text c="dimmed">No questions match.</Text>;
  return (
    <Accordion variant="separated" multiple>
      {questions.map((q) => {
        const asked = members.filter((m) => applies(q, m));
        const answered = asked.filter((m) =>
          isAnswered(q.type, m.answers[q.id]?.value),
        );
        const missing = asked.filter(
          (m) => !isAnswered(q.type, m.answers[q.id]?.value),
        );
        // For select types the distribution IS the answer an officer wants
        // ("how many need a ride?"), so tally it rather than only listing rows.
        const tally = isSelectType(q.type)
          ? tallyOptions(q, answered)
          : q.type === "boolean" || q.type === "consent"
            ? tallyYesNo(q, answered)
            : null;

        return (
          <Accordion.Item key={q.id} value={q.id}>
            <Accordion.Control>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" fw={500} style={{ minWidth: 0 }}>
                  {q.prompt}
                </Text>
                <Badge
                  size="sm"
                  variant="light"
                  color={answered.length === asked.length ? "green" : "gray"}
                >
                  {answered.length} of {asked.length}
                </Badge>
                {q.scope === "once" ? (
                  <Badge size="sm" variant="light" color="blue">
                    lifetime
                  </Badge>
                ) : null}
                {q.archived ? (
                  <Badge size="sm" variant="light" color="orange">
                    archived
                  </Badge>
                ) : null}
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                {tally ? (
                  <Group gap="xs" wrap="wrap">
                    {tally.map(([option, count]) => (
                      <Badge key={option} variant="light" size="sm">
                        {option} · {count}
                      </Badge>
                    ))}
                  </Group>
                ) : null}

                {answered.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    Nobody has answered this yet.
                  </Text>
                ) : (
                  <Table verticalSpacing="xs" withRowBorders={false}>
                    <Table.Tbody>
                      {answered.map((m) => (
                        <Table.Tr key={m.membershipId}>
                          <Table.Td w="35%">
                            <PersonLabel m={m} />
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                              {displayAnswer(q.type, m.answers[q.id]?.value)}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}

                {missing.length > 0 ? (
                  <Text size="xs" c="dimmed">
                    No answer yet: {missing.map((m) => m.name).join(", ")}
                  </Text>
                ) : null}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}

function ByPerson({
  questions,
  members,
}: {
  questions: Question[];
  members: Member[];
}) {
  if (members.length === 0) return <Text c="dimmed">Nobody matches.</Text>;
  return (
    <Accordion variant="separated" multiple>
      {members.map((m) => {
        const asked = questions.filter((q) => applies(q, m));
        const answered = asked.filter((q) =>
          isAnswered(q.type, m.answers[q.id]?.value),
        );
        return (
          <Accordion.Item key={m.membershipId} value={m.membershipId}>
            <Accordion.Control>
              <Group gap="xs" wrap="nowrap">
                <PersonLabel m={m} />
                <Badge
                  size="sm"
                  variant="light"
                  color={answered.length === asked.length ? "green" : "gray"}
                >
                  {answered.length} of {asked.length}
                </Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {asked.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No questions are asked of {m.role}s.
                </Text>
              ) : (
                <Table verticalSpacing="xs" withRowBorders={false}>
                  <Table.Tbody>
                    {asked.map((q) => {
                      const hit = m.answers[q.id];
                      const shown = displayAnswer(q.type, hit?.value);
                      return (
                        <Table.Tr key={q.id}>
                          <Table.Td w="45%">
                            <Text size="sm" c="dimmed">
                              {q.prompt}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {shown ? (
                              <Text
                                size="sm"
                                style={{ whiteSpace: "pre-wrap" }}
                              >
                                {shown}
                              </Text>
                            ) : (
                              <Text size="sm" c="dimmed">
                                —
                              </Text>
                            )}
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              )}
            </Accordion.Panel>
          </Accordion.Item>
        );
      })}
    </Accordion>
  );
}

function PersonLabel({ m }: { m: Member }) {
  return (
    <Text size="sm" fw={500} style={{ minWidth: 0 }}>
      {m.name}
      {m.playaName ? (
        <Text span size="sm" c="dimmed">
          {" "}
          “{m.playaName}”
        </Text>
      ) : null}
      {m.role !== "member" ? (
        <Text span size="xs" c="dimmed">
          {" "}
          · {m.role}
        </Text>
      ) : null}
    </Text>
  );
}

/** Option → how many people picked it, biggest first. Multi-select counts each
 * chosen option separately, so the totals can exceed the respondent count. */
function tallyOptions(q: Question, answered: Member[]): [string, number][] {
  const counts = new Map<string, number>(q.options.map((o) => [o, 0]));
  for (const m of answered) {
    const raw = m.answers[q.id]?.value ?? "";
    const picked =
      q.type === "multi_select" ? parseMultiValue(raw) : raw ? [raw] : [];
    for (const p of picked) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
}

function tallyYesNo(q: Question, answered: Member[]): [string, number][] {
  let yes = 0;
  for (const m of answered) {
    if (m.answers[q.id]?.value === "true") yes++;
  }
  const no = answered.length - yes;
  return [
    ["Yes", yes],
    ["No", no],
  ].filter(([, n]) => (n as number) > 0) as [string, number][];
}
