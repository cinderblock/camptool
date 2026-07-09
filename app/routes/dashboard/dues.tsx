import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
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
import { and, eq, sql } from "drizzle-orm";
import { useEffect, useState } from "react";
import { Form, data, redirect, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { loadCampEditions, requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  contributionTier,
  financeEntry,
  memberRequirement,
  membership,
  user,
} from "../../../db/schema";
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
  await requireFeature(active, "dues");
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

  // Roster: each member, their assigned tier/waive, and what they've paid (sum of
  // their donation entries for this edition).
  const members = (
    await db
      .select({ id: membership.id, name: user.name })
      .from(membership)
      .innerJoin(user, eq(membership.userId, user.id))
      .where(eq(membership.organizationId, active.camp.id))
  ).sort((a, b) => a.name.localeCompare(b.name));

  const reqs = await db
    .select({
      membershipId: memberRequirement.membershipId,
      tierId: memberRequirement.tierId,
      waived: memberRequirement.waived,
    })
    .from(memberRequirement)
    .where(eq(memberRequirement.editionId, activeEdition.id));
  const reqByMember = new Map(reqs.map((r) => [r.membershipId, r]));

  const paidRows = await db
    .select({
      memberId: financeEntry.memberId,
      cents: sql<number>`sum(${financeEntry.amountCents})`,
    })
    .from(financeEntry)
    .where(
      and(
        eq(financeEntry.editionId, activeEdition.id),
        eq(financeEntry.kind, "donation"),
      ),
    )
    .groupBy(financeEntry.memberId);
  const paidByMember = new Map(
    paidRows
      .filter((r) => r.memberId)
      .map((r) => [r.memberId as string, Number(r.cents) || 0]),
  );

  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const roster = members.map((m) => {
    const req = reqByMember.get(m.id);
    const tier = req?.tierId ? tierById.get(req.tierId) : undefined;
    const waived = req?.waived ?? false;
    const expectedCents = waived ? 0 : (tier?.expectedCents ?? null);
    const paidCents = paidByMember.get(m.id) ?? 0;
    return {
      membershipId: m.id,
      name: m.name,
      tierId: req?.tierId ?? null,
      waived,
      expectedCents,
      paidCents,
    };
  });

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
    roster,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "dues");
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

  if (intent === "setMemberTier" || intent === "setMemberWaived") {
    const membershipId = String(form.get("membershipId") ?? "");
    // Only members of this camp.
    const [m] = await db
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.id, membershipId),
          eq(membership.organizationId, campId),
        ),
      )
      .limit(1);
    if (!m) return data({ error: "Unknown member." }, { status: 404 });

    const set: { tierId?: string | null; waived?: boolean; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (intent === "setMemberTier") {
      const tierId = String(form.get("tierId") ?? "");
      set.tierId = tierId || null;
    } else {
      set.waived = form.get("waived") === "true";
    }
    await db
      .insert(memberRequirement)
      .values({
        id: crypto.randomUUID(),
        campId,
        editionId,
        membershipId,
        tierId: set.tierId ?? null,
        waived: set.waived ?? false,
      })
      .onConflictDoUpdate({
        target: [memberRequirement.editionId, memberRequirement.membershipId],
        set,
      });
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Dues({ loaderData }: Route.ComponentProps) {
  const { locked, year, tiers, otherEditions, roster } = loaderData;
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  // Separate fetcher for roster edits so they don't clear the add-tier form.
  const rosterFetcher = useFetcher();
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

        <div>
          <Group justify="space-between" align="flex-end" mb={6}>
            <Title order={3}>Members</Title>
            {(() => {
              const expected = roster.reduce(
                (s, r) => s + (r.expectedCents ?? 0),
                0,
              );
              const paid = roster.reduce((s, r) => s + r.paidCents, 0);
              return (
                <Text size="xs" c="dimmed">
                  {usd(expected)} expected · {usd(paid)} collected ·{" "}
                  {usd(Math.max(0, expected - paid))} outstanding
                </Text>
              );
            })()}
          </Group>
          <Paper withBorder p={0} radius="md">
            {roster.length === 0 ? (
              <Text size="sm" c="dimmed" p="md">
                No members yet.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={640}>
                <Table verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Member</Table.Th>
                      <Table.Th>Tier</Table.Th>
                      <Table.Th ta="right">Expected</Table.Th>
                      <Table.Th ta="right">Paid</Table.Th>
                      <Table.Th>Status</Table.Th>
                      {locked ? null : <Table.Th>Waive</Table.Th>}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {roster.map((r) => {
                      const owes =
                        r.expectedCents != null
                          ? r.expectedCents - r.paidCents
                          : null;
                      return (
                        <Table.Tr key={r.membershipId}>
                          <Table.Td>
                            <Text size="sm">{r.name}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Select
                              size="xs"
                              placeholder="—"
                              data={tiers.map((t) => ({
                                value: t.id,
                                label: t.name,
                              }))}
                              value={r.tierId}
                              disabled={locked}
                              clearable
                              comboboxProps={{ withinPortal: true }}
                              w={150}
                              onChange={(v) =>
                                rosterFetcher.submit(
                                  {
                                    intent: "setMemberTier",
                                    membershipId: r.membershipId,
                                    tierId: v ?? "",
                                  },
                                  { method: "post" },
                                )
                              }
                            />
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm">{usd(r.expectedCents)}</Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm">{usd(r.paidCents)}</Text>
                          </Table.Td>
                          <Table.Td>
                            {r.waived ? (
                              <Badge size="sm" variant="light" color="gray">
                                waived
                              </Badge>
                            ) : r.expectedCents == null ? (
                              <Text size="xs" c="dimmed">
                                —
                              </Text>
                            ) : owes != null && owes <= 0 ? (
                              <Badge size="sm" variant="light" color="teal">
                                paid
                              </Badge>
                            ) : (
                              <Badge size="sm" variant="light" color="orange">
                                owes {usd(owes)}
                              </Badge>
                            )}
                          </Table.Td>
                          {locked ? null : (
                            <Table.Td>
                              <Checkbox
                                size="xs"
                                checked={r.waived}
                                onChange={(e) =>
                                  rosterFetcher.submit(
                                    {
                                      intent: "setMemberWaived",
                                      membershipId: r.membershipId,
                                      waived: e.currentTarget.checked
                                        ? "true"
                                        : "false",
                                    },
                                    { method: "post" },
                                  )
                                }
                              />
                            </Table.Td>
                          )}
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Paper>
          <Text size="xs" c="dimmed" mt={6}>
            "Paid" is the sum of each member's donations on the Finances page
            for {year}.
          </Text>
        </div>
      </Stack>
    </Container>
  );
}
