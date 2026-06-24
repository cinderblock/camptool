import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { Form, data, useFetcher } from "react-router";
import { hasAtLeast } from "~/lib/permissions";
import { loadCampEditions, requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { contributionTier } from "../../../db/schema";
import type { Route } from "./+types/dues";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Dues · CampTool" }];
}

const REQUIREMENTS = [
  { value: "required", label: "Required" },
  { value: "suggested", label: "Suggested" },
  { value: "optional", label: "Optional" },
] as const;

function reqColor(r: string): string {
  return r === "required" ? "red" : r === "optional" ? "gray" : "blue";
}

function usd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const tiers = (
    await db
      .select()
      .from(contributionTier)
      .where(eq(contributionTier.editionId, activeEdition.id))
  ).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  // Other years of this camp, for "copy tiers from <year>".
  const editions = await loadCampEditions(active.camp.id);
  const otherEditions = editions
    .filter((e) => e.id !== activeEdition.id)
    .map((e) => ({
      id: e.id,
      label: e.label ? `${e.year} · ${e.label}` : String(e.year),
    }));

  return {
    locked: activeEdition.locked,
    year: activeEdition.year,
    tiers: tiers.map((t) => ({
      id: t.id,
      name: t.name,
      expectedCents: t.expectedCents,
      requirement: t.requirement,
      description: t.description,
    })),
    otherEditions,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers manage dues." }, { status: 403 });
  }
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "deleteTier") {
    await db
      .delete(contributionTier)
      .where(
        and(
          eq(contributionTier.id, String(form.get("id"))),
          eq(contributionTier.editionId, editionId),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "addTier") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return data({ error: "Name the tier." }, { status: 400 });
    const requirement = String(form.get("requirement") ?? "suggested");
    const dollars = Number(form.get("amount"));
    const expectedCents =
      Number.isFinite(dollars) && dollars > 0
        ? Math.round(dollars * 100)
        : null;
    const descRaw = String(form.get("description") ?? "").trim();
    const existing = await db
      .select({ id: contributionTier.id })
      .from(contributionTier)
      .where(eq(contributionTier.editionId, editionId));
    await db.insert(contributionTier).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      name,
      expectedCents,
      requirement,
      description: descRaw || null,
      sortOrder: existing.length + 1,
    });
    return data({ ok: true });
  }

  if (intent === "copyTiers") {
    const fromId = String(form.get("fromEditionId") ?? "");
    // Only copy from another edition of THIS camp.
    const src = await db
      .select()
      .from(contributionTier)
      .where(
        and(
          eq(contributionTier.editionId, fromId),
          eq(contributionTier.campId, campId),
        ),
      );
    if (src.length === 0) {
      return data({ error: "That year has no tiers." }, { status: 400 });
    }
    await db.insert(contributionTier).values(
      src.map((t) => ({
        id: crypto.randomUUID(),
        campId,
        editionId,
        name: t.name,
        expectedCents: t.expectedCents,
        requirement: t.requirement,
        description: t.description,
        sortOrder: t.sortOrder,
      })),
    );
    return data({ ok: true, copied: src.length });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Dues({ loaderData }: Route.ComponentProps) {
  const { locked, year, tiers, otherEditions } = loaderData;
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState<number | string>("");
  const [requirement, setRequirement] = useState("suggested");
  const [copyFrom, setCopyFrom] = useState<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      setName("");
      setAmount("");
    }
  }, [fetcher.data]);

  function addTier() {
    if (!name.trim()) {
      notifications.show({ color: "red", message: "Name the tier." });
      return;
    }
    fetcher.submit(
      {
        intent: "addTier",
        name,
        amount: amount === "" ? "" : String(amount),
        requirement,
      },
      { method: "post" },
    );
  }

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Dues &amp; contributions</Title>
          <Text c="dimmed" size="sm">
            Your camp's contribution tiers for {year}. Each year is its own set
            — edit this year freely without changing past years, or copy last
            year's to start. Some camps have none; that's fine.
          </Text>
        </div>

        {locked ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Text size="sm" c="dimmed">
              This year is locked — tiers are read-only. Switch to an open year
              to make changes.
            </Text>
          </Paper>
        ) : null}

        <Paper withBorder p={0} radius="md">
          {tiers.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              No tiers for {year} yet.
            </Text>
          ) : (
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tier</Table.Th>
                  <Table.Th>Expected</Table.Th>
                  <Table.Th>Requirement</Table.Th>
                  {locked ? null : <Table.Th />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tiers.map((t) => (
                  <Table.Tr key={t.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {t.name}
                      </Text>
                      {t.description ? (
                        <Text size="xs" c="dimmed">
                          {t.description}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{usd(t.expectedCents)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        variant="light"
                        color={reqColor(t.requirement)}
                      >
                        {t.requirement}
                      </Badge>
                    </Table.Td>
                    {locked ? null : (
                      <Table.Td>
                        <Tooltip label="Delete">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="red"
                            aria-label="Delete tier"
                            onClick={() =>
                              fetcher.submit(
                                { intent: "deleteTier", id: t.id },
                                { method: "post" },
                              )
                            }
                          >
                            ✕
                          </ActionIcon>
                        </Tooltip>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Paper>

        {locked ? null : (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} size="sm" mb="sm">
              Add a tier
            </Text>
            <Group align="flex-end" wrap="wrap">
              <TextInput
                size="xs"
                label="Name"
                placeholder="e.g. Full share"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                w={180}
              />
              <NumberInput
                size="xs"
                label="Expected (optional)"
                prefix="$"
                decimalScale={2}
                thousandSeparator=","
                min={0}
                value={amount}
                onChange={setAmount}
                w={140}
              />
              <Select
                size="xs"
                label="Requirement"
                data={REQUIREMENTS.map((r) => ({ ...r }))}
                value={requirement}
                onChange={(v) => setRequirement(v ?? "suggested")}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                w={140}
              />
              <Button
                size="xs"
                onClick={addTier}
                loading={fetcher.state !== "idle"}
              >
                Add tier
              </Button>
            </Group>
          </Card>
        )}

        {!locked && otherEditions.length > 0 ? (
          <Card withBorder padding="md" radius="md">
            <Text fw={600} size="sm" mb="sm">
              Copy tiers from another year
            </Text>
            <Form
              method="post"
              onSubmit={() => {
                /* let it submit */
              }}
            >
              <input type="hidden" name="intent" value="copyTiers" />
              <Group align="flex-end" wrap="wrap">
                <Select
                  size="xs"
                  label="From year"
                  name="fromEditionId"
                  placeholder="Pick a year"
                  data={otherEditions.map((e) => ({
                    value: e.id,
                    label: e.label,
                  }))}
                  value={copyFrom}
                  onChange={setCopyFrom}
                  comboboxProps={{ withinPortal: true }}
                  w={200}
                />
                <Button
                  size="xs"
                  variant="light"
                  type="submit"
                  disabled={!copyFrom}
                >
                  Copy tiers
                </Button>
              </Group>
            </Form>
            <Text size="xs" c="dimmed" mt={6}>
              Copies that year's tiers into {year} (appends — doesn't change the
              other year).
            </Text>
          </Card>
        ) : null}
      </Stack>
    </Container>
  );
}
