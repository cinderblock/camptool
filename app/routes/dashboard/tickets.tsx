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
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { and, eq, isNotNull } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { BurningManDisclaimer } from "~/components/BurningManDisclaimer";
import { ensureMemberAttendee } from "~/lib/attendee.server";
import { isBurningMan } from "~/lib/events";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  attendee,
  campEdition,
  membership,
  ticket,
  ticketRequest,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/tickets";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Tickets · CampTool" }];
}

type TicketRow = {
  id: string;
  tier: string | null;
  priceCents: number | null;
  status: string;
  // The assignee as a picker ref: `m:<membershipId>` | `a:<attendeeId>` | null.
  assigneeRef: string | null;
  assigneeName: string | null;
  // The assignee is a guest (vs the assigned member themselves).
  assigneeIsGuest: boolean;
  // The assignee is in the viewer's party (their own row or one of their guests).
  mine: boolean;
  notes: string | null;
};
type AssignGroup = { group: string; items: { value: string; label: string }[] };
type RequestRow = {
  id: string;
  membershipId: string;
  requesterName: string | null;
  note: string | null;
  status: string;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "tickets");
  const editionId = activeEdition.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const published = activeEdition.ticketsPublishedAt != null;
  const myMembershipId = active.membership.id;

  const rawTickets = await db
    .select({
      id: ticket.id,
      tier: ticket.tier,
      priceCents: ticket.priceCents,
      status: ticket.status,
      notes: ticket.notes,
      assignedAttendeeId: ticket.assignedAttendeeId,
      attMembershipId: attendee.membershipId,
      attHostId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
    })
    .from(ticket)
    .leftJoin(attendee, eq(ticket.assignedAttendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(ticket.editionId, editionId));

  const allTickets: TicketRow[] = rawTickets
    .map((t) => ({
      id: t.id,
      tier: t.tier,
      priceCents: t.priceCents,
      status: t.status,
      notes: t.notes,
      // Members resolve to m:<membershipId> (stable even before an attendee row);
      // guests to a:<attendeeId>.
      assigneeRef: t.attMembershipId
        ? `m:${t.attMembershipId}`
        : t.assignedAttendeeId
          ? `a:${t.assignedAttendeeId}`
          : null,
      assigneeName: t.guestName ?? t.memberName ?? null,
      assigneeIsGuest:
        t.assignedAttendeeId != null && t.attMembershipId == null,
      mine:
        t.attMembershipId === myMembershipId || t.attHostId === myMembershipId,
    }))
    .sort(
      (a, b) =>
        (a.priceCents ?? Number.POSITIVE_INFINITY) -
          (b.priceCents ?? Number.POSITIVE_INFINITY) ||
        a.id.localeCompare(b.id),
    );

  // Assignments are a draft until published: officers see the whole allocation;
  // a member sees only their party's tickets, and only once it's published.
  const tickets = isOfficer
    ? allTickets
    : published
      ? allTickets.filter((t) => t.mine)
      : [];

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

  // Officer assign Select: camp members + all guests, grouped. Members carry a
  // m:<membershipId> ref (their attendee row is created on assign if missing);
  // guests carry a:<attendeeId>.
  let assignGroups: AssignGroup[] = [];
  if (isOfficer) {
    const memberRows = (
      await db
        .select({ id: membership.id, name: user.name })
        .from(membership)
        .innerJoin(user, eq(membership.userId, user.id))
        .where(eq(membership.organizationId, active.camp.id))
    ).sort((a, b) => a.name.localeCompare(b.name));
    const guestRows = await db
      .select({ id: attendee.id, name: attendee.name })
      .from(attendee)
      .where(
        and(
          eq(attendee.editionId, editionId),
          isNotNull(attendee.hostMembershipId),
        ),
      );
    assignGroups = [
      {
        group: "Campers",
        items: memberRows.map((m) => ({ value: `m:${m.id}`, label: m.name })),
      },
      ...(guestRows.length > 0
        ? [
            {
              group: "Guests",
              items: guestRows.map((g) => ({
                value: `a:${g.id}`,
                label: `${g.name ?? "Guest"} (guest)`,
              })),
            },
          ]
        : []),
    ];
  }

  return redact(privacy, {
    isOfficer,
    locked: activeEdition.locked,
    event: activeEdition.event,
    myMembershipId,
    published,
    publishedAt: activeEdition.ticketsPublishedAt,
    saleStartsAt: activeEdition.ticketSaleStartsAt,
    saleEndsAt: activeEdition.ticketSaleEndsAt,
    tickets,
    requests,
    assignGroups,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  await requireFeature(active, "tickets");
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

  // The assignee confirms (or un-confirms) they bought their ticket from the
  // vendor. Scoped to their own assigned ticket so no one can flip another's.
  if (intent === "markPurchased" || intent === "unmarkPurchased") {
    const purchased = intent === "markPurchased";
    const ticketId = String(form.get("ticketId"));
    // The host may mark purchased for their own ticket OR one of their guests'.
    const [row] = await db
      .select({
        attMid: attendee.membershipId,
        attHostId: attendee.hostMembershipId,
      })
      .from(ticket)
      .leftJoin(attendee, eq(ticket.assignedAttendeeId, attendee.id))
      .where(and(eq(ticket.id, ticketId), eq(ticket.editionId, editionId)))
      .limit(1);
    if (!row || (row.attMid !== myMid && row.attHostId !== myMid)) {
      return data({ error: "Not your ticket." }, { status: 403 });
    }
    await db
      .update(ticket)
      .set({
        status: purchased ? "purchased" : "assigned",
        updatedAt: new Date(),
      })
      .where(and(eq(ticket.id, ticketId), eq(ticket.editionId, editionId)));
    return data({ ok: purchased ? "Marked purchased." : "Undone." });
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
    // Price/value is fixed at creation — only tier and notes are editable.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("tier")) set.tier = str("tier");
    if (form.has("notes")) set.notes = str("notes");
    await db
      .update(ticket)
      .set(set)
      .where(ownTicket(String(form.get("id"))));
    return data({ ok: "Saved." });
  }

  if (intent === "setSaleWindow") {
    const ts = (k: string): Date | null => {
      const v = form.get(k);
      if (v == null || v === "") return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    await db
      .update(campEdition)
      .set({
        ticketSaleStartsAt: ts("saleStartsAt"),
        ticketSaleEndsAt: ts("saleEndsAt"),
      })
      .where(eq(campEdition.id, editionId));
    return data({ ok: "Sale window saved." });
  }

  if (intent === "publishTickets" || intent === "unpublishTickets") {
    const publish = intent === "publishTickets";
    await db
      .update(campEdition)
      .set({ ticketsPublishedAt: publish ? new Date() : null })
      .where(eq(campEdition.id, editionId));
    return data({
      ok: publish
        ? "Assignments published — members can now see their tickets."
        : "Unpublished — assignments are hidden from members again.",
    });
  }

  if (intent === "deleteTicket") {
    await db.delete(ticket).where(ownTicket(String(form.get("id"))));
    return data({ ok: "Ticket deleted." });
  }

  if (intent === "assignTicket") {
    const ticketId = String(form.get("ticketId"));
    // `m:<membershipId>` (a member) or `a:<attendeeId>` (a guest).
    const ref = str("assigneeRef");
    if (!ref) return data({ error: "Pick someone." }, { status: 400 });
    let attendeeId: string | null = null;
    let resolvedMid: string | null = null;
    if (ref.startsWith("m:")) {
      const targetMid = ref.slice(2);
      const [tm] = await db
        .select({ id: membership.id })
        .from(membership)
        .where(
          and(
            eq(membership.id, targetMid),
            eq(membership.organizationId, campId),
          ),
        )
        .limit(1);
      if (!tm) return data({ error: "Unknown member." }, { status: 400 });
      attendeeId = await ensureMemberAttendee(campId, editionId, targetMid);
      resolvedMid = targetMid;
    } else if (ref.startsWith("a:")) {
      const aid = ref.slice(2);
      const [g] = await db
        .select({ id: attendee.id })
        .from(attendee)
        .where(
          and(
            eq(attendee.id, aid),
            eq(attendee.campId, campId),
            eq(attendee.editionId, editionId),
          ),
        )
        .limit(1);
      if (!g) return data({ error: "Unknown guest." }, { status: 400 });
      attendeeId = aid;
    }
    if (!attendeeId) return data({ error: "Pick someone." }, { status: 400 });

    await db
      .update(ticket)
      .set({
        assignedAttendeeId: attendeeId,
        status: "assigned",
        updatedAt: new Date(),
      })
      .where(ownTicket(ticketId));
    // Auto-resolve any pending request from that member (guests don't request).
    if (resolvedMid) {
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
            eq(ticketRequest.membershipId, resolvedMid),
            eq(ticketRequest.status, "pending"),
          ),
        );
    }
    return data({ ok: "Ticket assigned." });
  }

  if (intent === "unassignTicket") {
    await db
      .update(ticket)
      .set({
        assignedAttendeeId: null,
        status: "available",
        updatedAt: new Date(),
      })
      .where(ownTicket(String(form.get("ticketId"))));
    return data({ ok: "Returned to pool." });
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

// A ticket's value: blank = TBD, 0 = a free ticket, else dollars.
function usd(cents: number | null): string {
  if (cents == null) return "—";
  if (cents === 0) return "Free";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const STATUS_COLOR: Record<string, string> = {
  available: "gray",
  assigned: "blue",
  purchased: "green",
};

type FetcherData = { ok?: string; error?: string };

export default function Tickets({ loaderData }: Route.ComponentProps) {
  const {
    isOfficer,
    locked,
    event,
    myMembershipId,
    published,
    publishedAt,
    saleStartsAt,
    saleEndsAt,
    tickets,
    requests,
    assignGroups,
  } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);

  const saleStart = saleStartsAt ? new Date(saleStartsAt) : null;
  const saleEnd = saleEndsAt ? new Date(saleEndsAt) : null;
  const saleNote =
    saleStart || saleEnd
      ? `Sale window: ${saleStart ? fmtDateTime(saleStart) : "open"} – ${
          saleEnd ? fmtDateTime(saleEnd) : "open"
        }.`
      : null;

  const myTickets = tickets.filter((t) => t.mine);
  const myRequest = requests.find(
    (r) => r.membershipId === myMembershipId && r.status === "pending",
  );
  const pending = requests.filter((r) => r.status === "pending");

  const available = tickets.filter((t) => t.status === "available").length;
  const assigned = tickets.filter((t) => t.status === "assigned").length;
  // What's still outstanding — anything not yet member-confirmed as purchased.
  const unpurchased = tickets.filter((t) => t.status !== "purchased").length;

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Direct Group Sale tickets</Title>
          <Text c="dimmed" size="sm">
            The camp's guaranteed ticket allocation for this year. The camp
            decides who gets each slot; once assignments are published, Burning
            Man emails you a link to buy your ticket directly. Mark it purchased
            here after you do.
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
              This year is locked — tickets are read-only. Switch to an open
              year to make changes.
            </Text>
          </Paper>
        ) : null}

        {/* ----- Member self-service ----- */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="sm">
            <Text fw={600}>Your tickets</Text>
            {!isOfficer && !published ? (
              <Text size="sm" c="dimmed">
                Ticket assignments haven't been announced yet — check back once
                they're published.
              </Text>
            ) : myTickets.length === 0 ? (
              <Text size="sm" c="dimmed">
                None assigned to you or your party yet.
              </Text>
            ) : (
              <Stack gap="sm">
                {myTickets.map((t) => (
                  <MyTicket key={t.id} t={t} fetcher={fetcher} />
                ))}
                <Text size="xs" c="dimmed">
                  Burning Man emails your purchase link once assignments are
                  published. Mark a ticket purchased here after you buy it.
                  {saleNote ? ` ${saleNote}` : ""}
                </Text>
              </Stack>
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
            <Paper
              withBorder
              p="md"
              radius="md"
              bg={published ? undefined : "var(--mantine-color-yellow-light)"}
            >
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text fw={600} size="sm">
                    {published
                      ? "Assignments published"
                      : "Draft — assignments hidden from members"}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {published
                      ? `Members can see their own assigned tickets${
                          publishedAt
                            ? ` (published ${fmtDateTime(new Date(publishedAt))})`
                            : ""
                        }.`
                      : "Only officers can see assignments. Publish when you're ready to announce them to members."}
                  </Text>
                </div>
                {locked ? null : (
                  <Button
                    color={published ? "gray" : "green"}
                    variant={published ? "default" : "filled"}
                    loading={fetcher.state !== "idle"}
                    onClick={() =>
                      fetcher.submit(
                        {
                          intent: published
                            ? "unpublishTickets"
                            : "publishTickets",
                        },
                        { method: "post" },
                      )
                    }
                  >
                    {published ? "Unpublish" : "Publish assignments"}
                  </Button>
                )}
              </Group>
            </Paper>

            <Card withBorder padding="md" radius="md">
              <Text fw={600} mb="xs">
                Allocation · {tickets.length} total
              </Text>
              <SimpleGrid cols={{ base: 3, xs: 3 }} spacing="lg" mb="md">
                <Stat label="available" value={available} color="gray" />
                <Stat label="assigned" value={assigned} color="blue" />
                <Stat label="unpurchased" value={unpurchased} color="orange" />
              </SimpleGrid>
              {locked ? null : (
                <Stack gap="md">
                  <SaleWindowForm
                    fetcher={fetcher}
                    saleStartsAt={saleStartsAt}
                    saleEndsAt={saleEndsAt}
                  />
                  <AddTicketsForm fetcher={fetcher} />
                </Stack>
              )}
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
                    <Table.Th>Value</Table.Th>
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
                      assignGroups={assignGroups}
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
        {isBurningMan(event) ? <BurningManDisclaimer /> : null}
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
          w={{ base: "100%", xs: 320 }}
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
          label="Value ($)"
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

function MyTicket({
  t,
  fetcher,
}: {
  t: TicketRow;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <Group gap="sm">
      {t.assigneeName ? (
        <Text size="sm" fw={500}>
          {t.assigneeName}
          {t.assigneeIsGuest ? (
            <Text span c="dimmed" size="xs">
              {" "}
              (guest)
            </Text>
          ) : null}
        </Text>
      ) : null}
      <Badge size="lg" variant="light" color={STATUS_COLOR[t.status] ?? "gray"}>
        {t.tier ? `${t.tier} · ` : ""}
        {usd(t.priceCents)} · {t.status}
      </Badge>
      {t.status === "purchased" ? (
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          onClick={() =>
            fetcher.submit(
              { intent: "unmarkPurchased", ticketId: t.id },
              { method: "post" },
            )
          }
        >
          Undo
        </Button>
      ) : (
        <Button
          size="xs"
          variant="light"
          color="green"
          onClick={() =>
            fetcher.submit(
              { intent: "markPurchased", ticketId: t.id },
              { method: "post" },
            )
          }
        >
          Mark as purchased
        </Button>
      )}
    </Group>
  );
}

function SaleWindowForm({
  fetcher,
  saleStartsAt,
  saleEndsAt,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
}) {
  const [start, setStart] = useState<Date | null>(saleStartsAt);
  const [end, setEnd] = useState<Date | null>(saleEndsAt);
  return (
    <Group align="flex-end">
      <DateTimePicker
        label="Sale opens"
        placeholder="not set"
        value={start}
        onChange={setStart as (v: Date | null) => void}
        clearable
        w={200}
        valueFormat="MMM D, YYYY h:mm A"
      />
      <DateTimePicker
        label="Sale closes"
        placeholder="not set"
        value={end}
        onChange={setEnd as (v: Date | null) => void}
        clearable
        w={200}
        valueFormat="MMM D, YYYY h:mm A"
      />
      <Button
        variant="default"
        loading={fetcher.state !== "idle"}
        onClick={() =>
          fetcher.submit(
            {
              intent: "setSaleWindow",
              saleStartsAt: start ? start.toISOString() : "",
              saleEndsAt: end ? end.toISOString() : "",
            },
            { method: "post" },
          )
        }
      >
        Save window
      </Button>
    </Group>
  );
}

function TicketRowView({
  t,
  fetcher,
  assignGroups,
  locked,
}: {
  t: TicketRow;
  fetcher: ReturnType<typeof useFetcher>;
  assignGroups: AssignGroup[];
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
      {/* Value is fixed at creation — never editable here. */}
      <Table.Td>{usd(t.priceCents)}</Table.Td>
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
            w={190}
            placeholder="— pool —"
            data={assignGroups}
            value={t.assigneeRef}
            searchable
            clearable
            onChange={(value) => {
              if (value)
                fetcher.submit(
                  {
                    intent: "assignTicket",
                    ticketId: t.id,
                    assigneeRef: value,
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
