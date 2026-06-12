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
import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership, ticket, ticketRequest, user } from "../../../db/schema";
import type { Route } from "./+types/tickets";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tickets · CampTool" }];
}

type TicketRow = {
  id: string;
  tier: string | null;
  priceCents: number | null;
  status: string;
  assignedMembershipId: string | null;
  assigneeName: string | null;
  notes: string | null;
};
type RequestRow = {
  id: string;
  membershipId: string;
  requesterName: string | null;
  note: string | null;
  status: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  const editionId = activeEdition.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const tickets = (
    await db
      .select({
        id: ticket.id,
        tier: ticket.tier,
        priceCents: ticket.priceCents,
        status: ticket.status,
        assignedMembershipId: ticket.assignedMembershipId,
        assigneeName: user.name,
        notes: ticket.notes,
      })
      .from(ticket)
      .leftJoin(membership, eq(ticket.assignedMembershipId, membership.id))
      .leftJoin(user, eq(membership.userId, user.id))
      .where(eq(ticket.editionId, editionId))
  ).sort(
    (a, b) =>
      (a.priceCents ?? Number.POSITIVE_INFINITY) -
        (b.priceCents ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id),
  ) satisfies TicketRow[];

  const requests = (await db
    .select({
      id: ticketRequest.id,
      membershipId: ticketRequest.membershipId,
      requesterName: user.name,
      note: ticketRequest.note,
      status: ticketRequest.status,
    })
    .from(ticketRequest)
    .leftJoin(membership, eq(ticketRequest.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(ticketRequest.editionId, editionId))) satisfies RequestRow[];

  // Camp members for the officer assign Select.
  const members = isOfficer
    ? (
        await db
          .select({ id: membership.id, name: user.name })
          .from(membership)
          .innerJoin(user, eq(membership.userId, user.id))
          .where(eq(membership.organizationId, active.camp.id))
      ).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    isOfficer,
    locked: activeEdition.locked,
    myMembershipId: active.membership.id,
    tickets,
    requests,
    members,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const myMid = active.membership.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (k: string) => {
    const v = form.get(k);
    return v == null || v === "" ? null : String(v);
  };

  // --- Member self-service (any role) -------------------------------------
  if (intent === "requestTicket") {
    const [existing] = await db
      .select({ id: ticketRequest.id })
      .from(ticketRequest)
      .where(
        and(
          eq(ticketRequest.editionId, editionId),
          eq(ticketRequest.membershipId, myMid),
          eq(ticketRequest.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) {
      return data(
        { error: "You already have a pending request." },
        {
          status: 409,
        },
      );
    }
    await db.insert(ticketRequest).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      membershipId: myMid,
      note: str("note"),
    });
    return data({ ok: "Request sent." });
  }

  if (intent === "cancelRequest") {
    await db
      .delete(ticketRequest)
      .where(
        and(
          eq(ticketRequest.id, String(form.get("id"))),
          eq(ticketRequest.membershipId, myMid),
          eq(ticketRequest.status, "pending"),
        ),
      );
    return data({ ok: "Request cancelled." });
  }

  // --- Officer-only from here ---------------------------------------------
  if (!isOfficer) {
    return data({ error: "Officers only." }, { status: 403 });
  }

  const num = (k: string): number | null => {
    const v = form.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const dollarsToCents = (k: string): number | null => {
    const v = num(k);
    return v == null ? null : Math.round(v * 100);
  };

  if (intent === "addTickets") {
    const count = Math.min(200, Math.max(1, Math.round(num("count") ?? 1)));
    const tier = str("tier");
    const priceCents = dollarsToCents("price");
    const rows = Array.from({ length: count }, () => ({
      id: crypto.randomUUID(),
      campId,
      editionId,
      tier,
      priceCents,
      createdById: actor.id,
    }));
    await db.insert(ticket).values(rows);
    return data({ ok: `Added ${count} ticket${count === 1 ? "" : "s"}.` });
  }

  const ownTicket = (id: string) =>
    and(eq(ticket.id, id), eq(ticket.editionId, editionId));

  if (intent === "editTicket") {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("tier")) set.tier = str("tier");
    if (form.has("price")) set.priceCents = dollarsToCents("price");
    if (form.has("notes")) set.notes = str("notes");
    await db
      .update(ticket)
      .set(set)
      .where(ownTicket(String(form.get("id"))));
    return data({ ok: "Saved." });
  }

  if (intent === "deleteTicket") {
    await db.delete(ticket).where(ownTicket(String(form.get("id"))));
    return data({ ok: "Ticket deleted." });
  }

  if (intent === "assignTicket") {
    const ticketId = String(form.get("ticketId"));
    const targetMid = str("membershipId");
    if (!targetMid) {
      return data({ error: "Pick a member." }, { status: 400 });
    }
    await db
      .update(ticket)
      .set({
        assignedMembershipId: targetMid,
        status: "assigned",
        updatedAt: new Date(),
      })
      .where(ownTicket(ticketId));
    // Auto-resolve any pending request from that member.
    await db
      .update(ticketRequest)
      .set({
        status: "approved",
        resolvedTicketId: ticketId,
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(ticketRequest.editionId, editionId),
          eq(ticketRequest.membershipId, targetMid),
          eq(ticketRequest.status, "pending"),
        ),
      );
    return data({ ok: "Ticket assigned." });
  }

  if (intent === "unassignTicket") {
    await db
      .update(ticket)
      .set({
        assignedMembershipId: null,
        status: "available",
        updatedAt: new Date(),
      })
      .where(ownTicket(String(form.get("ticketId"))));
    return data({ ok: "Returned to pool." });
  }

  if (intent === "setPaid") {
    const paid = String(form.get("paid")) === "true";
    await db
      .update(ticket)
      .set({ status: paid ? "paid" : "assigned", updatedAt: new Date() })
      .where(ownTicket(String(form.get("ticketId"))));
    return data({ ok: paid ? "Marked paid." : "Marked unpaid." });
  }

  if (intent === "denyRequest") {
    await db
      .update(ticketRequest)
      .set({
        status: "denied",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(ticketRequest.id, String(form.get("id"))),
          eq(ticketRequest.editionId, editionId),
        ),
      );
    return data({ ok: "Request denied." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Per-ticket price: blank = TBD, 0 = a free ticket. (Aggregate $ totals use
// `dollars` directly so a $0 sum reads "$0.00", not "Free".)
function usd(cents: number | null): string {
  if (cents == null) return "—";
  if (cents === 0) return "Free";
  return dollars(cents);
}

const STATUS_COLOR: Record<string, string> = {
  available: "gray",
  assigned: "blue",
  paid: "green",
};

type FetcherData = { ok?: string; error?: string };

export default function Tickets({ loaderData }: Route.ComponentProps) {
  const { isOfficer, locked, myMembershipId, tickets, requests, members } =
    loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);

  const myTickets = tickets.filter(
    (t) => t.assignedMembershipId === myMembershipId,
  );
  const myRequest = requests.find(
    (r) => r.membershipId === myMembershipId && r.status === "pending",
  );
  const pending = requests.filter((r) => r.status === "pending");

  const available = tickets.filter((t) => t.status === "available").length;
  const assigned = tickets.filter((t) => t.status === "assigned").length;
  const paid = tickets.filter((t) => t.status === "paid").length;
  const collected = tickets
    .filter((t) => t.status === "paid")
    .reduce((sum, t) => sum + (t.priceCents ?? 0), 0);
  const outstanding = tickets
    .filter((t) => t.status === "assigned")
    .reduce((sum, t) => sum + (t.priceCents ?? 0), 0);

  const memberData = members.map((m) => ({ value: m.id, label: m.name }));

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Direct Group Sale tickets</Title>
          <Text c="dimmed" size="sm">
            The camp's guaranteed ticket allocation for this year. Every ticket
            gets you in the same — they only differ in price.
          </Text>
        </div>

        {locked ? (
          <Paper withBorder p="md" radius="md" bg="var(--mantine-color-gray-0)">
            <Text size="sm" c="dimmed">
              This year is locked — tickets are read-only. Switch to an open
              year to make changes.
            </Text>
          </Paper>
        ) : null}

        {/* ----- Member self-service ----- */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="sm">
            <Text fw={600}>Your tickets</Text>
            {myTickets.length === 0 ? (
              <Text size="sm" c="dimmed">
                None assigned to you yet.
              </Text>
            ) : (
              <Group gap="sm">
                {myTickets.map((t) => (
                  <Badge
                    key={t.id}
                    size="lg"
                    variant="light"
                    color={STATUS_COLOR[t.status] ?? "gray"}
                  >
                    {t.tier ? `${t.tier} · ` : ""}
                    {usd(t.priceCents)} · {t.status}
                  </Badge>
                ))}
              </Group>
            )}

            {locked ? null : myRequest ? (
              <Group gap="xs">
                <Badge color="yellow" variant="light">
                  request pending
                </Badge>
                {myRequest.note ? (
                  <Text size="sm" c="dimmed">
                    “{myRequest.note}”
                  </Text>
                ) : null}
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "cancelRequest", id: myRequest.id },
                      { method: "post" },
                    )
                  }
                >
                  Cancel request
                </Button>
              </Group>
            ) : (
              <RequestForm fetcher={fetcher} />
            )}
          </Stack>
        </Card>

        {/* ----- Officer management ----- */}
        {isOfficer ? (
          <>
            <Card withBorder padding="md" radius="md">
              <Text fw={600} mb="xs">
                Allocation · {tickets.length} total
              </Text>
              <Group gap="lg" mb="md">
                <Stat label="available" value={available} color="gray" />
                <Stat label="assigned" value={assigned} color="blue" />
                <Stat label="paid" value={paid} color="green" />
                <Stat
                  label="collected"
                  value={dollars(collected)}
                  color="green"
                />
                <Stat
                  label="outstanding"
                  value={dollars(outstanding)}
                  color="orange"
                />
              </Group>
              {locked ? null : <AddTicketsForm fetcher={fetcher} />}
            </Card>

            {pending.length > 0 ? (
              <Card withBorder padding="md" radius="md">
                <Text fw={600} mb="xs">
                  Pending requests · {pending.length}
                </Text>
                <Stack gap="xs">
                  {pending.map((r) => (
                    <Group key={r.id} justify="space-between" wrap="nowrap">
                      <div>
                        <Text size="sm" fw={500}>
                          {r.requesterName ?? "Unknown"}
                        </Text>
                        {r.note ? (
                          <Text size="xs" c="dimmed">
                            “{r.note}”
                          </Text>
                        ) : null}
                      </div>
                      {locked ? null : (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            fetcher.submit(
                              { intent: "denyRequest", id: r.id },
                              { method: "post" },
                            )
                          }
                        >
                          Deny
                        </Button>
                      )}
                    </Group>
                  ))}
                </Stack>
                <Text size="xs" c="dimmed" mt="xs">
                  Assign an available ticket below to fulfill a request.
                </Text>
              </Card>
            ) : null}

            <Table.ScrollContainer minWidth={720}>
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Tier</Table.Th>
                    <Table.Th>Price</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Assigned to</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {tickets.map((t) => (
                    <TicketRowView
                      key={t.id}
                      t={t}
                      fetcher={fetcher}
                      memberData={memberData}
                      locked={locked}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {tickets.length === 0 ? (
              <Text c="dimmed" size="sm">
                No tickets yet. Add the camp's allocation above.
              </Text>
            ) : null}
          </>
        ) : null}
      </Stack>
    </Container>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div>
      <Text size="xl" fw={700} c={color}>
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </div>
  );
}

function RequestForm({ fetcher }: { fetcher: ReturnType<typeof useFetcher> }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <fetcher.Form
      method="post"
      ref={ref}
      onSubmit={() => setTimeout(() => ref.current?.reset(), 0)}
    >
      <input type="hidden" name="intent" value="requestTicket" />
      <Group align="flex-end">
        <TextInput
          name="note"
          label="Request a ticket"
          placeholder="optional note — e.g. low-income"
          w={320}
        />
        <Button type="submit" loading={fetcher.state !== "idle"}>
          Request
        </Button>
      </Group>
    </fetcher.Form>
  );
}

function AddTicketsForm({
  fetcher,
}: {
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <fetcher.Form
      method="post"
      ref={ref}
      onSubmit={() => setTimeout(() => ref.current?.reset(), 0)}
    >
      <input type="hidden" name="intent" value="addTickets" />
      <Group align="flex-end">
        <TextInput
          name="tier"
          label="Tier (optional)"
          placeholder="Standard / Low-income / Comp"
          w={220}
        />
        <NumberInput
          name="price"
          label="Price ($)"
          placeholder="0 = free"
          w={130}
          min={0}
          decimalScale={2}
          step={1}
        />
        <NumberInput
          name="count"
          label="How many"
          w={110}
          min={1}
          max={200}
          defaultValue={1}
        />
        <Button type="submit" loading={fetcher.state !== "idle"}>
          Add tickets
        </Button>
      </Group>
    </fetcher.Form>
  );
}

function TicketRowView({
  t,
  fetcher,
  memberData,
  locked,
}: {
  t: TicketRow;
  fetcher: ReturnType<typeof useFetcher>;
  memberData: { value: string; label: string }[];
  locked: boolean;
}) {
  return (
    <Table.Tr>
      <Table.Td>
        {locked ? (
          (t.tier ?? "—")
        ) : (
          <TextInput
            size="xs"
            w={150}
            defaultValue={t.tier ?? ""}
            placeholder="tier"
            onBlur={(e) => {
              if ((e.currentTarget.value || null) !== (t.tier ?? null))
                fetcher.submit(
                  {
                    intent: "editTicket",
                    id: t.id,
                    tier: e.currentTarget.value,
                  },
                  { method: "post" },
                );
            }}
          />
        )}
      </Table.Td>
      <Table.Td>
        {locked ? (
          usd(t.priceCents)
        ) : (
          <NumberInput
            size="xs"
            w={110}
            min={0}
            decimalScale={2}
            defaultValue={t.priceCents == null ? undefined : t.priceCents / 100}
            placeholder="TBD"
            onBlur={(e) => {
              const raw = e.currentTarget.value;
              fetcher.submit(
                { intent: "editTicket", id: t.id, price: raw },
                { method: "post" },
              );
            }}
          />
        )}
      </Table.Td>
      <Table.Td>
        <Badge color={STATUS_COLOR[t.status] ?? "gray"} variant="light">
          {t.status}
        </Badge>
      </Table.Td>
      <Table.Td>
        {locked ? (
          (t.assigneeName ?? "—")
        ) : (
          <Select
            size="xs"
            w={170}
            placeholder="— pool —"
            data={memberData}
            value={t.assignedMembershipId}
            searchable
            clearable
            onChange={(value) => {
              if (value)
                fetcher.submit(
                  {
                    intent: "assignTicket",
                    ticketId: t.id,
                    membershipId: value,
                  },
                  { method: "post" },
                );
              else
                fetcher.submit(
                  { intent: "unassignTicket", ticketId: t.id },
                  { method: "post" },
                );
            }}
          />
        )}
      </Table.Td>
      <Table.Td>
        {locked ? null : (
          <Group gap={4} wrap="nowrap" justify="flex-end">
            {t.status === "assigned" ? (
              <Button
                size="compact-xs"
                variant="light"
                color="green"
                onClick={() =>
                  fetcher.submit(
                    { intent: "setPaid", ticketId: t.id, paid: "true" },
                    { method: "post" },
                  )
                }
              >
                Mark paid
              </Button>
            ) : t.status === "paid" ? (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={() =>
                  fetcher.submit(
                    { intent: "setPaid", ticketId: t.id, paid: "false" },
                    { method: "post" },
                  )
                }
              >
                Unpay
              </Button>
            ) : null}
            <Tooltip label="Delete ticket">
              <ActionIcon
                variant="subtle"
                color="red"
                onClick={() =>
                  fetcher.submit(
                    { intent: "deleteTicket", id: t.id },
                    { method: "post" },
                  )
                }
              >
                ✕
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function useFetcherNotifications(
  fdata: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !fdata || fdata === seen.current) return;
    seen.current = fdata;
    if (fdata.error) {
      notifications.show({
        color: "red",
        title: "Error",
        message: fdata.error,
      });
    } else if (fdata.ok) {
      notifications.show({ title: "Done", message: fdata.ok });
    }
  }, [fdata, state]);
}
