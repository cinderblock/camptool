/**
 * Training — camp-defined qualifications and who's signed off on them.
 * Officers define trainings (validity: one-time / each year / expires after a
 * year), grant and revoke sign-offs; members see their own status. Gatherings
 * can require a training before sign-up (enforced on the schedule pages).
 * Gated by the `training` camp feature. Design: plans/events-scheduling.md.
 */
import {
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import {
  ANNUAL_VALIDITY_MS,
  VALIDITY_OPTIONS,
  isValidSignoff,
  validityLabel,
} from "~/lib/training";
import { loadSignoffs, loadTrainings } from "~/lib/training.server";
import { db } from "../../../db/client.server";
import {
  membership,
  training,
  trainingSignoff,
  user as userTable,
} from "../../../db/schema";
import type { Route } from "./+types/training";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Training · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "training");
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const trainings = await loadTrainings(active.camp.id);
  const signoffs = await loadSignoffs(active.camp.id);
  const now = new Date();
  const validityOf = new Map(trainings.map((t) => [t.id, t.validity]));
  const rows = signoffs.map((s) => ({
    id: s.id,
    trainingId: s.trainingId,
    membershipId: s.membershipId,
    label: s.playaName || s.name,
    grantedAt: s.grantedAt.getTime(),
    expiresAt: s.expiresAt?.getTime() ?? null,
    revoked: s.revokedAt != null,
    valid: isValidSignoff(validityOf.get(s.trainingId) ?? "", s, {
      editionId: activeEdition.id,
      now,
    }),
  }));

  const members = isOfficer
    ? (
        await db
          .select({
            id: membership.id,
            playaName: membership.playaName,
            name: userTable.name,
          })
          .from(membership)
          .innerJoin(userTable, eq(userTable.id, membership.userId))
          .where(eq(membership.organizationId, active.camp.id))
      )
        .map((m) => ({ value: m.id, label: m.playaName || m.name }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];

  return redact(privacy, {
    isOfficer,
    myMembershipId: active.membership.id,
    trainings: trainings.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      validity: t.validity,
    })),
    signoffs: rows,
    members,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "training");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers manage training." }, { status: 403 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "addTraining") {
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 200) {
      return data({ error: "Please give it a name." }, { status: 400 });
    }
    const validity = String(form.get("validity") ?? "per_edition");
    if (!VALIDITY_OPTIONS.some((v) => v.value === validity)) {
      return data({ error: "Unknown validity." }, { status: 400 });
    }
    await db.insert(training).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      name,
      description: String(form.get("description") ?? "").trim() || null,
      validity,
    });
    return data({ ok: true });
  }

  /** A training id belonging to THIS camp, or null. */
  async function campTraining(id: string) {
    const [t] = await db
      .select({ id: training.id, validity: training.validity })
      .from(training)
      .where(and(eq(training.id, id), eq(training.campId, active.camp.id)))
      .limit(1);
    return t ?? null;
  }

  if (intent === "archiveTraining") {
    const t = await campTraining(String(form.get("trainingId")));
    if (!t) return data({ error: "Training not found." }, { status: 404 });
    await db
      .update(training)
      .set({ archivedAt: new Date() })
      .where(eq(training.id, t.id));
    return data({ ok: true });
  }

  if (intent === "grant") {
    const t = await campTraining(String(form.get("trainingId")));
    if (!t) return data({ error: "Training not found." }, { status: 404 });
    const [target] = await db
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.id, String(form.get("membershipId"))),
          eq(membership.organizationId, active.camp.id),
        ),
      )
      .limit(1);
    if (!target) return data({ error: "Member not found." }, { status: 404 });
    await db.insert(trainingSignoff).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      trainingId: t.id,
      membershipId: target.id,
      // The validity level decides which scope field matters (the others stay
      // null and isValidSignoff ignores them).
      editionId: t.validity === "per_edition" ? activeEdition.id : null,
      expiresAt:
        t.validity === "annual"
          ? new Date(Date.now() + ANNUAL_VALIDITY_MS)
          : null,
      grantedByMembershipId: active.membership.id,
    });
    return data({ ok: true });
  }

  if (intent === "revoke") {
    const [row] = await db
      .select({ id: trainingSignoff.id })
      .from(trainingSignoff)
      .where(
        and(
          eq(trainingSignoff.id, String(form.get("signoffId"))),
          eq(trainingSignoff.campId, active.camp.id),
        ),
      )
      .limit(1);
    if (!row) return data({ error: "Sign-off not found." }, { status: 404 });
    await db
      .update(trainingSignoff)
      .set({ revokedAt: new Date() })
      .where(eq(trainingSignoff.id, row.id));
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type LoaderData = Route.ComponentProps["loaderData"];

export default function Training({ loaderData }: Route.ComponentProps) {
  const { isOfficer, myMembershipId, trainings, signoffs } = loaderData;
  const mine = signoffs.filter(
    (s) => s.membershipId === myMembershipId && !s.revoked,
  );

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Training</Title>
          <Text c="dimmed" size="sm">
            Qualifications the camp signs people off on. Some shifts require one
            before you can sign up.
          </Text>
        </div>

        <Card withBorder padding="lg" radius="md">
          <Text fw={600} mb="xs">
            Your sign-offs
          </Text>
          {mine.length === 0 ? (
            <Text size="sm" c="dimmed">
              None yet — an officer signs you off after the training happens.
            </Text>
          ) : (
            <Stack gap={4}>
              {mine.map((s) => {
                const t = trainings.find((tr) => tr.id === s.trainingId);
                return (
                  <Group key={s.id} gap="xs">
                    <Badge
                      variant="light"
                      color={s.valid ? "green" : "gray"}
                      size="sm"
                    >
                      {s.valid ? "valid" : "expired"}
                    </Badge>
                    <Text size="sm">{t?.name ?? "(retired training)"}</Text>
                    {s.expiresAt ? (
                      <Text size="xs" c="dimmed">
                        until {new Date(s.expiresAt).toISOString().slice(0, 10)}
                      </Text>
                    ) : null}
                  </Group>
                );
              })}
            </Stack>
          )}
        </Card>

        {isOfficer ? <AddTraining /> : null}

        {trainings.map((t) => (
          <TrainingCard key={t.id} t={t} loaderData={loaderData} />
        ))}
        {trainings.length === 0 && isOfficer ? (
          <Text size="sm" c="dimmed">
            No trainings defined yet — add the first one above.
          </Text>
        ) : null}
      </Stack>
    </Container>
  );
}

function AddTraining() {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [opened, { toggle }] = useDisclosure(false);
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between">
        <Text fw={600} size="sm">
          New training
        </Text>
        <Button size="xs" variant="light" onClick={toggle}>
          {opened ? "Close" : "Add"}
        </Button>
      </Group>
      <Collapse in={opened}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="addTraining" />
          <Stack gap="sm" mt="sm">
            <Group grow align="flex-end">
              <TextInput
                name="name"
                label="Name"
                placeholder="e.g. Fire safety"
                required
              />
              <Select
                name="validity"
                label="How long a sign-off lasts"
                defaultValue="per_edition"
                data={VALIDITY_OPTIONS.map((v) => ({
                  value: v.value,
                  label: v.label,
                }))}
                allowDeselect={false}
              />
            </Group>
            <Textarea
              name="description"
              label="What it covers"
              autosize
              minRows={2}
            />
            <Group justify="flex-end">
              <Button
                type="submit"
                size="xs"
                loading={fetcher.state !== "idle"}
              >
                Add training
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Collapse>
    </Paper>
  );
}

function TrainingCard({
  t,
  loaderData,
}: {
  t: LoaderData["trainings"][number];
  loaderData: LoaderData;
}) {
  const { isOfficer, members, signoffs } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [granting, setGranting] = useState(false);
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  const rows = signoffs.filter((s) => s.trainingId === t.id && !s.revoked);
  const holders = rows.filter((s) => s.valid);
  const stale = rows.filter((s) => !s.valid);

  return (
    <Card withBorder padding="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={600}>{t.name}</Text>
            <Badge size="xs" variant="light">
              {validityLabel(t.validity)}
            </Badge>
          </Group>
          {t.description ? (
            <Text size="sm" c="dimmed">
              {t.description}
            </Text>
          ) : null}
        </div>
        {isOfficer ? (
          <Group gap="xs">
            {granting ? (
              <Select
                size="xs"
                placeholder="Sign someone off…"
                data={members}
                searchable
                onChange={(id) => {
                  if (id) {
                    fetcher.submit(
                      { intent: "grant", trainingId: t.id, membershipId: id },
                      { method: "post" },
                    );
                  }
                  setGranting(false);
                }}
              />
            ) : (
              <Button
                size="compact-xs"
                variant="light"
                onClick={() => setGranting(true)}
              >
                Sign off…
              </Button>
            )}
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={() =>
                fetcher.submit(
                  { intent: "archiveTraining", trainingId: t.id },
                  { method: "post" },
                )
              }
            >
              Retire
            </Button>
          </Group>
        ) : null}
      </Group>

      {isOfficer && rows.length > 0 ? (
        <Table.ScrollContainer minWidth={640}>
          <Table mt="sm" verticalSpacing={4}>
            <Table.Tbody>
              {[...holders, ...stale].map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Text size="sm">{s.label}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="xs"
                      variant="light"
                      color={s.valid ? "green" : "gray"}
                    >
                      {s.valid ? "valid" : "expired"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      granted {new Date(s.grantedAt).toISOString().slice(0, 10)}
                      {s.expiresAt
                        ? ` · until ${new Date(s.expiresAt).toISOString().slice(0, 10)}`
                        : ""}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "revoke", signoffId: s.id },
                          { method: "post" },
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : holders.length > 0 ? (
        <Text size="xs" c="dimmed" mt="xs">
          Signed off: {holders.map((s) => s.label).join(", ")}
        </Text>
      ) : null}
    </Card>
  );
}
