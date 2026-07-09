import {
  ActionIcon,
  Anchor,
  Autocomplete,
  Badge,
  Container,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { financeEntry, membership, user } from "../../../db/schema";
import type { Route } from "./+types/finances";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Finances · CampTool" }];
}

/** Format integer cents as US dollars, e.g. 12345 → "$123.45". */
function usd(cents: number): string {
  const v = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "−" : ""}$${v}`;
}

type EntryRow = {
  id: string;
  kind: string;
  amountCents: number;
  description: string | null;
  category: string | null;
  memberName: string | null;
  counterparty: string | null;
  occurredAt: Date | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "finances");
  // Officer-only: the ledger isn't shared with all campers.
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const editionId = activeEdition.id;

  const entries = (await db
    .select({
      id: financeEntry.id,
      kind: financeEntry.kind,
      amountCents: financeEntry.amountCents,
      description: financeEntry.description,
      category: financeEntry.category,
      memberName: user.name,
      counterparty: financeEntry.counterparty,
      occurredAt: financeEntry.occurredAt,
    })
    .from(financeEntry)
    .leftJoin(membership, eq(financeEntry.memberId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(financeEntry.editionId, editionId))) satisfies EntryRow[];

  entries.sort((a, b) => {
    const ta = a.occurredAt ? a.occurredAt.getTime() : 0;
    const tb = b.occurredAt ? b.occurredAt.getTime() : 0;
    return tb - ta;
  });

  const donations = entries
    .filter((e) => e.kind === "donation")
    .reduce((s, e) => s + e.amountCents, 0);
  const expenses = entries
    .filter((e) => e.kind === "expense")
    .reduce((s, e) => s + e.amountCents, 0);

  const members = (
    await db
      .select({ id: membership.id, name: user.name })
      .from(membership)
      .innerJoin(user, eq(membership.userId, user.id))
      .where(eq(membership.organizationId, active.camp.id))
  ).sort((a, b) => a.name.localeCompare(b.name));

  const categories = [
    ...new Set(entries.map((e) => e.category).filter((c): c is string => !!c)),
  ].sort();

  return {
    locked: activeEdition.locked,
    year: activeEdition.year,
    // Dues is its own camp feature now (admin-managed on /settings).
    duesEnabled: featureVisibleTo(
      await getFeatureState(active.camp.id, "dues"),
      active.membership.role,
    ),
    isAdmin: active.membership.role === "admin",
    entries,
    members,
    categories,
    totals: { donations, expenses, net: donations - expenses },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  await requireFeature(active, "finances");
  if (!hasAtLeast(active.membership.role, "officer")) {
    return data({ error: "Officers manage finances." }, { status: 403 });
  }
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  if (intent === "deleteEntry") {
    const id = String(form.get("id"));
    await db
      .delete(financeEntry)
      .where(
        and(eq(financeEntry.id, id), eq(financeEntry.editionId, editionId)),
      );
    return data({ ok: true });
  }

  if (intent === "addEntry") {
    const kind = String(form.get("kind"));
    if (kind !== "donation" && kind !== "expense") {
      return data({ error: "Pick donation or expense." }, { status: 400 });
    }
    const amountCents = Math.round(Number(form.get("amount")));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return data({ error: "Enter an amount." }, { status: 400 });
    }
    const memberId = String(form.get("memberId") ?? "");
    const occurredRaw = Number(form.get("occurredAt"));
    const str = (k: string) => {
      const v = form.get(k);
      const s = v == null ? "" : String(v).trim();
      return s === "" ? null : s;
    };
    await db.insert(financeEntry).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      kind,
      amountCents,
      description: str("description"),
      category: str("category"),
      memberId: memberId || null,
      counterparty: str("counterparty"),
      occurredAt: Number.isFinite(occurredRaw) ? new Date(occurredRaw) : null,
      createdById: actor.id,
    });
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Finances({ loaderData }: Route.ComponentProps) {
  const {
    locked,
    year,
    duesEnabled,
    isAdmin,
    entries,
    members,
    categories,
    totals,
  } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const [kind, setKind] = useState("donation");
  const [amount, setAmount] = useState<number | string>("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [memberId, setMemberId] = useState<string | null>(null);
  const [occurred, setOccurred] = useState<Date | null>(() => new Date());

  // Reset the amount/description after a successful add; surface errors.
  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data.ok) {
      setAmount("");
      setDescription("");
    }
  }, [fetcher.data]);

  function submitAdd() {
    const cents = Math.round(Number(amount) * 100);
    if (!cents || cents <= 0) {
      notifications.show({ color: "red", message: "Enter an amount." });
      return;
    }
    fetcher.submit(
      {
        intent: "addEntry",
        kind,
        amount: String(cents),
        description,
        category,
        memberId: memberId ?? "",
        occurredAt: occurred ? String(occurred.getTime()) : "",
      },
      { method: "post" },
    );
  }

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Finances</Title>
          <Text c="dimmed" size="sm">
            Donations to the camp and camp spends for {year}. Officers only —
            not shared with all campers.
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
              This year is locked — finances are read-only. Switch to an open
              year to make changes.
            </Text>
          </Paper>
        ) : null}

        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed">
              Donations in
            </Text>
            <Text fw={700} size="xl" c="teal">
              {usd(totals.donations)}
            </Text>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed">
              Spends out
            </Text>
            <Text fw={700} size="xl" c="red">
              {usd(totals.expenses)}
            </Text>
          </Paper>
          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed">
              Net balance
            </Text>
            <Text fw={700} size="xl" c={totals.net < 0 ? "red" : undefined}>
              {usd(totals.net)}
            </Text>
          </Paper>
        </SimpleGrid>

        <Paper withBorder p="sm" radius="md">
          {duesEnabled ? (
            <Group justify="space-between" wrap="wrap">
              <Text size="xs" c="dimmed">
                This camp tracks member dues & contribution tiers.
              </Text>
              <Anchor component={Link} to="/dues" size="xs">
                Open Dues →
              </Anchor>
            </Group>
          ) : (
            <Group justify="space-between" wrap="wrap">
              <Text size="xs" c="dimmed">
                Dues tracking is off. If your camp has dues, the camp admin can
                turn on the Dues feature.
              </Text>
              {isAdmin ? (
                <Anchor component={Link} to="/settings" size="xs">
                  Camp settings →
                </Anchor>
              ) : null}
            </Group>
          )}
        </Paper>

        {locked ? null : (
          <Paper withBorder p="md" radius="md">
            <Text fw={600} size="sm" mb="sm">
              Record a {kind === "donation" ? "donation" : "spend"}
            </Text>
            <Stack gap="sm">
              <Group align="flex-end" wrap="wrap">
                <SegmentedControl
                  size="xs"
                  value={kind}
                  onChange={setKind}
                  data={[
                    { label: "Donation in", value: "donation" },
                    { label: "Spend out", value: "expense" },
                  ]}
                />
                <NumberInput
                  size="xs"
                  label="Amount"
                  prefix="$"
                  decimalScale={2}
                  thousandSeparator=","
                  min={0}
                  value={amount}
                  onChange={setAmount}
                  w={130}
                />
                <DateInput
                  size="xs"
                  label="Date"
                  value={occurred}
                  onChange={(v) => setOccurred(v ? new Date(v) : null)}
                  valueFormat="MMM D, YYYY"
                  w={150}
                  clearable
                />
              </Group>
              <Group align="flex-end" wrap="wrap">
                <TextInput
                  size="xs"
                  label="Description"
                  placeholder={
                    kind === "donation"
                      ? "e.g. camp dues, gift"
                      : "e.g. propane, lumber"
                  }
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  style={{ flex: "1 1 220px" }}
                />
                <Autocomplete
                  size="xs"
                  label="Category"
                  placeholder="optional"
                  data={categories}
                  value={category}
                  onChange={setCategory}
                  w={150}
                />
                <Select
                  size="xs"
                  label={
                    kind === "donation" ? "Donor (member)" : "Paid by (member)"
                  }
                  placeholder="External / none"
                  data={members.map((m) => ({ value: m.id, label: m.name }))}
                  value={memberId}
                  onChange={setMemberId}
                  clearable
                  searchable
                  comboboxProps={{ withinPortal: true }}
                  w={180}
                />
                <Tooltip label="Add entry">
                  <ActionIcon
                    size="lg"
                    variant="filled"
                    aria-label="Add entry"
                    onClick={submitAdd}
                    loading={fetcher.state !== "idle"}
                  >
                    +
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Stack>
          </Paper>
        )}

        <Paper withBorder p={0} radius="md">
          {entries.length === 0 ? (
            <Text size="sm" c="dimmed" p="md">
              No entries yet for {year}.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={620}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Description</Table.Th>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Who</Table.Th>
                    <Table.Th ta="right">Amount</Table.Th>
                    {locked ? null : <Table.Th />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {entries.map((e) => {
                    const donation = e.kind === "donation";
                    return (
                      <Table.Tr key={e.id}>
                        <Table.Td>
                          <Text size="sm">
                            {e.occurredAt
                              ? new Date(e.occurredAt).toLocaleDateString(
                                  "en-US",
                                  { month: "short", day: "numeric" },
                                )
                              : "—"}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            size="sm"
                            variant="light"
                            color={donation ? "teal" : "red"}
                          >
                            {donation ? "donation" : "spend"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{e.description ?? "—"}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {e.category ?? ""}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {e.memberName ?? e.counterparty ?? ""}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text
                            size="sm"
                            fw={600}
                            c={donation ? "teal" : "red"}
                          >
                            {donation ? "+" : "−"}
                            {usd(e.amountCents)}
                          </Text>
                        </Table.Td>
                        {locked ? null : (
                          <Table.Td>
                            <Tooltip label="Delete">
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="red"
                                aria-label="Delete entry"
                                onClick={() =>
                                  fetcher.submit(
                                    { intent: "deleteEntry", id: e.id },
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
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>
      </Stack>
    </Container>
  );
}
