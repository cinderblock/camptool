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
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import dayjs from "dayjs";
import { and, eq, isNotNull } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { BurningManDisclaimer } from "~/components/BurningManDisclaimer";
import { ensureMemberAttendee } from "~/lib/attendee.server";
import { setupPassWindowFor } from "~/lib/brc";
import { isBurningMan } from "~/lib/events";
import { requireFeature } from "~/lib/features.server";
import { canManageAttendee, inMyParty, isMe } from "~/lib/party";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  attendee,
  membership,
  setupPass,
  setupPassDate,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/passes";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Passes · CampTool" }];
}

type DateRow = {
  id: string;
  date: string;
  label: string | null;
  quota: number;
};
type PassRow = {
  id: string;
  // NULL while a request is unbound — the officer picks the "on or after"
  // date row at grant time.
  passDateId: string | null;
  attendeeId: string | null;
  // The holder as a grant-picker ref: `m:<membershipId>` | `a:<attendeeId>`.
  holderRef: string | null;
  holderName: string | null;
  holderIsGuest: boolean;
  // The holder is in the viewer's party — their own row, or anyone they host.
  mine: boolean;
  // The holder IS the viewer, not merely someone they host. Requesting a pass
  // is a statement about your own arrival, so that form keys off this.
  isSelf: boolean;
  status: string;
  note: string | null;
};
type GrantGroup = { group: string; items: { value: string; label: string }[] };

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "passes");
  const editionId = activeEdition.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");

  const dates = (
    await db
      .select({
        id: setupPassDate.id,
        date: setupPassDate.date,
        label: setupPassDate.label,
        quota: setupPassDate.quota,
      })
      .from(setupPassDate)
      .where(eq(setupPassDate.editionId, editionId))
  ).sort((a, b) => a.date.localeCompare(b.date)) satisfies DateRow[];

  const myMembershipId = active.membership.id;
  const rawPasses = await db
    .select({
      id: setupPass.id,
      passDateId: setupPass.passDateId,
      attendeeId: setupPass.attendeeId,
      attMembershipId: attendee.membershipId,
      attHostId: attendee.hostMembershipId,
      guestName: attendee.name,
      memberName: user.name,
      status: setupPass.status,
      note: setupPass.note,
    })
    .from(setupPass)
    .leftJoin(attendee, eq(setupPass.attendeeId, attendee.id))
    .leftJoin(membership, eq(attendee.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(setupPass.editionId, editionId));
  const passes: PassRow[] = rawPasses.map((p) => ({
    id: p.id,
    passDateId: p.passDateId,
    attendeeId: p.attendeeId,
    holderRef: p.attMembershipId
      ? `m:${p.attMembershipId}`
      : p.attendeeId
        ? `a:${p.attendeeId}`
        : null,
    holderName: p.guestName ?? p.memberName ?? null,
    holderIsGuest: p.attendeeId != null && p.attMembershipId == null,
    mine: inMyParty(
      { membershipId: p.attMembershipId, hostMembershipId: p.attHostId },
      myMembershipId,
    ),
    // Whether this pass is *personally* mine, as opposed to my party's — the
    // request form keys off this, since a pass request is a statement about
    // one's own arrival.
    isSelf: isMe({ membershipId: p.attMembershipId }, myMembershipId),
    status: p.status,
    note: p.note,
  }));

  // Officer grant Select: camp members (m:) + all guests (a:), grouped.
  let grantGroups: GrantGroup[] = [];
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
    grantGroups = [
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

  // Planned arrivals (from onboarding) — shown next to requests so officers can
  // pick a pass date that covers the holder's arrival. Keyed by attendee id.
  const arrivalRows = await db
    .select({
      id: attendee.id,
      membershipId: attendee.membershipId,
      arrivalDate: attendee.arrivalDate,
    })
    .from(attendee)
    .where(eq(attendee.editionId, editionId));
  const arrivals: Record<string, string> = {};
  let myArrival: string | null = null;
  for (const r of arrivalRows) {
    if (r.arrivalDate) arrivals[r.id] = r.arrivalDate;
    if (r.membershipId === myMembershipId) myArrival = r.arrivalDate ?? null;
  }

  return redact(privacy, {
    isOfficer,
    locked: activeEdition.locked,
    event: activeEdition.event,
    myMembershipId,
    myArrival,
    year: activeEdition.year,
    dates,
    passes,
    grantGroups,
    arrivals: isOfficer ? arrivals : {},
  });
}

export async function action({ request }: Route.ActionArgs) {
  const {
    user: actor,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  await requireFeature(active, "passes");
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

  // Quota check: granted passes for a date must stay below its quota.
  async function hasRoom(passDateId: string): Promise<boolean> {
    const [d] = await db
      .select({ quota: setupPassDate.quota })
      .from(setupPassDate)
      .where(eq(setupPassDate.id, passDateId))
      .limit(1);
    if (!d) return false;
    const granted = await db
      .select({ id: setupPass.id })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.passDateId, passDateId),
          eq(setupPass.status, "granted"),
        ),
      );
    return granted.length < d.quota;
  }

  // Does this attendee already hold an active (requested or granted) pass this
  // year? One pass per person — requests are unbound (no date) until granted.
  async function activePassFor(attendeeId: string) {
    const rows = await db
      .select({ id: setupPass.id, status: setupPass.status })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.editionId, editionId),
          eq(setupPass.attendeeId, attendeeId),
        ),
      );
    return rows.find((r) => r.status !== "denied") ?? null;
  }

  // --- Member self-service (any role) -------------------------------------
  // A member requests a pass for themselves; officers grant guest passes
  // directly (guests appear in the officer grant picker).
  if (intent === "requestPass") {
    const myAttendeeId = await ensureMemberAttendee(campId, editionId, myMid);
    if (await activePassFor(myAttendeeId)) {
      return data(
        { error: "You already have a pass or a pending request." },
        { status: 409 },
      );
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      attendeeId: myAttendeeId,
      status: "requested",
      note: str("note"),
      createdById: actor.id,
    });
    return data({ ok: "Request sent." });
  }

  if (intent === "cancelPass") {
    // A party host may cancel for their household; an officer for anyone.
    const passId = String(form.get("id"));
    const [row] = await db
      .select({
        membershipId: attendee.membershipId,
        hostMembershipId: attendee.hostMembershipId,
      })
      .from(setupPass)
      .leftJoin(attendee, eq(setupPass.attendeeId, attendee.id))
      .where(and(eq(setupPass.id, passId), eq(setupPass.editionId, editionId)))
      .limit(1);
    // Previously this reported "Request cancelled." even when the check failed,
    // so a mis-scoped cancel looked like it worked. Say what happened.
    if (!row || !canManageAttendee(row, active.membership)) {
      return data({ error: "Not your pass." }, { status: 403 });
    }
    await db
      .delete(setupPass)
      .where(and(eq(setupPass.id, passId), eq(setupPass.status, "requested")));
    return data({ ok: "Request cancelled." });
  }

  // --- Officer-only -------------------------------------------------------
  if (!isOfficer) {
    return data({ error: "Officers only." }, { status: 403 });
  }
  const num = (k: string): number | null => {
    const v = form.get(k);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (intent === "addDate") {
    const date = str("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return data({ error: "Pick a valid date." }, { status: 400 });
    }
    // Enforce the pre-event setup window server-side too (not just the picker).
    // YYYY-MM-DD strings compare lexicographically the same as chronologically.
    const win = setupPassWindowFor(activeEdition.year);
    if (date < win.min || date > win.max) {
      return data(
        { error: `Setup dates must be between ${win.min} and ${win.max}.` },
        { status: 400 },
      );
    }
    const quota = Math.max(0, Math.round(num("quota") ?? 0));
    try {
      await db.insert(setupPassDate).values({
        id: crypto.randomUUID(),
        campId,
        editionId,
        date,
        label: str("label"),
        quota,
      });
    } catch {
      return data({ error: "That date already exists." }, { status: 409 });
    }
    return data({ ok: "Date added." });
  }

  const ownDate = (id: string) =>
    and(eq(setupPassDate.id, id), eq(setupPassDate.editionId, editionId));

  if (intent === "editDate") {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("label")) set.label = str("label");
    if (form.has("quota"))
      set.quota = Math.max(0, Math.round(num("quota") ?? 0));
    await db
      .update(setupPassDate)
      .set(set)
      .where(ownDate(String(form.get("id"))));
    return data({ ok: "Saved." });
  }

  if (intent === "deleteDate") {
    const id = String(form.get("id"));
    const [granted] = await db
      .select({ id: setupPass.id })
      .from(setupPass)
      .where(and(eq(setupPass.passDateId, id), eq(setupPass.status, "granted")))
      .limit(1);
    if (granted) {
      return data(
        { error: "Revoke its granted passes first." },
        {
          status: 409,
        },
      );
    }
    // Clear any lingering requested/denied rows, then drop the date.
    await db.delete(setupPass).where(eq(setupPass.passDateId, id));
    await db.delete(setupPassDate).where(ownDate(id));
    return data({ ok: "Date removed." });
  }

  if (intent === "grantPass") {
    const passDateId = String(form.get("passDateId"));
    // `m:<membershipId>` (a member) or `a:<attendeeId>` (a guest).
    const ref = str("granteeRef");
    if (!ref) return data({ error: "Pick someone." }, { status: 400 });
    let targetAttendeeId: string | null = null;
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
      targetAttendeeId = await ensureMemberAttendee(
        campId,
        editionId,
        targetMid,
      );
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
      targetAttendeeId = aid;
    }
    if (!targetAttendeeId)
      return data({ error: "Pick someone." }, { status: 400 });
    if (!(await hasRoom(passDateId))) {
      return data({ error: "That date is at its quota." }, { status: 409 });
    }
    const existing = await activePassFor(targetAttendeeId);
    if (existing?.status === "granted") {
      return data(
        { error: "They already have a granted pass." },
        { status: 409 },
      );
    }
    if (existing) {
      // Resolve their open request with this date.
      await db
        .update(setupPass)
        .set({
          passDateId,
          status: "granted",
          resolvedByMembershipId: myMid,
          resolvedAt: new Date(),
        })
        .where(eq(setupPass.id, existing.id));
    } else {
      await db.insert(setupPass).values({
        id: crypto.randomUUID(),
        campId,
        editionId,
        passDateId,
        attendeeId: targetAttendeeId,
        status: "granted",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
        createdById: actor.id,
      });
    }
    return data({ ok: "Pass granted." });
  }

  if (intent === "approvePass") {
    const id = String(form.get("id"));
    // The request is unbound — the officer picks the "on or after" date here.
    const passDateId = str("passDateId");
    if (!passDateId) {
      return data({ error: "Pick an on-or-after date." }, { status: 400 });
    }
    const [p] = await db
      .select({ id: setupPass.id })
      .from(setupPass)
      .where(and(eq(setupPass.id, id), eq(setupPass.editionId, editionId)))
      .limit(1);
    if (!p) return data({ error: "Not found." }, { status: 404 });
    const [d] = await db
      .select({ id: setupPassDate.id })
      .from(setupPassDate)
      .where(ownDate(passDateId))
      .limit(1);
    if (!d) return data({ error: "Unknown date." }, { status: 400 });
    if (!(await hasRoom(passDateId))) {
      return data({ error: "That date is at its quota." }, { status: 409 });
    }
    await db
      .update(setupPass)
      .set({
        passDateId,
        status: "granted",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(eq(setupPass.id, id));
    return data({ ok: "Pass granted." });
  }

  if (intent === "denyPass") {
    await db
      .update(setupPass)
      .set({
        status: "denied",
        resolvedByMembershipId: myMid,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(setupPass.id, String(form.get("id"))),
          eq(setupPass.editionId, editionId),
        ),
      );
    return data({ ok: "Request denied." });
  }

  if (intent === "revokePass") {
    await db
      .delete(setupPass)
      .where(
        and(
          eq(setupPass.id, String(form.get("id"))),
          eq(setupPass.editionId, editionId),
        ),
      );
    return data({ ok: "Pass revoked." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

function fmtDate(date: string, label: string | null): string {
  const d = dayjs(date).format("ddd, MMM D");
  return label ? `${label} · ${d}` : d;
}

const STATUS_COLOR: Record<string, string> = {
  requested: "yellow",
  granted: "green",
  denied: "gray",
};

type FetcherData = { ok?: string; error?: string };

export default function Passes({ loaderData }: Route.ComponentProps) {
  const {
    isOfficer,
    locked,
    event,
    myMembershipId,
    myArrival,
    year,
    dates,
    passes,
    grantGroups,
    arrivals,
  } = loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);

  const grantedFor = (dateId: string) =>
    passes.filter((p) => p.passDateId === dateId && p.status === "granted")
      .length;
  const dateById = new Map(dates.map((d) => [d.id, d]));

  // "mine" = my whole party. The request form is self-only, so it keys off
  // `isSelf` — my own pass, not one belonging to someone I host.
  const myPasses = passes.filter((p) => p.mine);
  const myOwnActive = passes.find((p) => p.isSelf && p.status !== "denied");
  const pending = passes.filter((p) => p.status === "requested");

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Setup access passes</Title>
          <Text c="dimmed" size="sm">
            Early-arrival passes the camp allocates. Each pass admits you on or
            after its date — an earlier-dated pass covers a later arrival.
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
              This year is locked — passes are read-only. Switch to an open year
              to make changes.
            </Text>
          </Paper>
        ) : null}

        {/* ----- Member self-service ----- */}
        <Card withBorder padding="md" radius="md">
          <Stack gap="sm">
            <Text fw={600}>Your passes</Text>
            {myPasses.length === 0 ? (
              <Text size="sm" c="dimmed">
                None yet.
              </Text>
            ) : (
              <Stack gap="xs">
                {myPasses.map((p) => {
                  const d = p.passDateId ? dateById.get(p.passDateId) : null;
                  return (
                    <Group key={p.id} gap="xs">
                      {p.holderIsGuest ? (
                        <Text size="sm" fw={500}>
                          {p.holderName ?? "Guest"}
                          <Text span c="dimmed" size="xs">
                            {" "}
                            (guest)
                          </Text>
                        </Text>
                      ) : null}
                      <Badge
                        size="lg"
                        variant="light"
                        color={STATUS_COLOR[p.status] ?? "gray"}
                      >
                        {d
                          ? `Arrive ${fmtDate(d.date, d.label)} or later · ${p.status}`
                          : p.status === "requested"
                            ? "Requested — awaiting a date"
                            : p.status}
                      </Badge>
                      {!locked && p.status === "requested" ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            fetcher.submit(
                              { intent: "cancelPass", id: p.id },
                              { method: "post" },
                            )
                          }
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </Group>
                  );
                })}
              </Stack>
            )}

            {!locked && !myOwnActive ? (
              <RequestPassForm fetcher={fetcher} myArrival={myArrival} />
            ) : null}
          </Stack>
        </Card>

        {/* ----- Officer management ----- */}
        {isOfficer ? (
          <>
            {pending.length > 0 ? (
              <Card withBorder padding="md" radius="md">
                <Text fw={600} mb="xs">
                  Pending requests · {pending.length}
                </Text>
                <Stack gap="xs">
                  {pending.map((p) => (
                    <PendingRequestRow
                      key={p.id}
                      p={p}
                      arrival={
                        p.attendeeId ? (arrivals[p.attendeeId] ?? null) : null
                      }
                      dates={dates}
                      grantedFor={grantedFor}
                      fetcher={fetcher}
                      locked={locked}
                    />
                  ))}
                </Stack>
              </Card>
            ) : null}

            <Card withBorder padding="md" radius="md">
              <Text fw={600} mb="xs">
                Pass dates &amp; quotas
              </Text>
              {dates.length === 0 ? (
                <Text size="sm" c="dimmed" mb="sm">
                  No dates yet. Add the camp's allocation below — each date is
                  the earliest day its passes admit entry.
                </Text>
              ) : (
                <Stack gap="sm" mb="md">
                  {dates.map((d) => (
                    <DateRowView
                      key={d.id}
                      d={d}
                      granted={grantedFor(d.id)}
                      passes={passes.filter(
                        (p) => p.passDateId === d.id && p.status === "granted",
                      )}
                      grantGroups={grantGroups}
                      fetcher={fetcher}
                      locked={locked}
                    />
                  ))}
                </Stack>
              )}
              {locked ? null : <AddDateForm fetcher={fetcher} year={year} />}
            </Card>
          </>
        ) : null}
        {isBurningMan(event) ? <BurningManDisclaimer /> : null}
      </Stack>
    </Container>
  );
}

function RequestPassForm({
  fetcher,
  myArrival,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  myArrival: string | null;
}) {
  const [note, setNote] = useState("");
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">
        Arriving before gates open? Request a pass and an officer will assign
        you one that covers your arrival
        {myArrival
          ? ` (you plan to arrive ${dayjs(myArrival).format("ddd, MMM D")})`
          : ""}
        .
      </Text>
      <Group align="flex-end">
        <TextInput
          label="Note (optional)"
          placeholder="e.g. helping with build from Tuesday"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          w={{ base: "100%", xs: 320 }}
        />
        <Button
          loading={fetcher.state !== "idle"}
          onClick={() => {
            fetcher.submit({ intent: "requestPass", note }, { method: "post" });
            setNote("");
          }}
        >
          Request a pass
        </Button>
      </Group>
    </Stack>
  );
}

/** An unbound request in the officer queue: shows the requester's planned
 * arrival and lets the officer pick the "on or after" date row to grant. */
function PendingRequestRow({
  p,
  arrival,
  dates,
  grantedFor,
  fetcher,
  locked,
}: {
  p: PassRow;
  arrival: string | null;
  dates: DateRow[];
  grantedFor: (dateId: string) => number;
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const open = dates.filter((d) => grantedFor(d.id) < d.quota);
  // Best default: the latest date that still covers their arrival (least
  // early-entry burn), else whatever the request already carried.
  const covering = arrival ? open.filter((d) => d.date <= arrival) : [];
  const suggested = covering.at(-1)?.id ?? p.passDateId;
  const [dateId, setDateId] = useState<string | null>(
    suggested && open.some((d) => d.id === suggested) ? suggested : null,
  );
  return (
    <Group justify="space-between" wrap="wrap" align="flex-end">
      <div>
        <Text size="sm" fw={500}>
          {p.holderName ?? "Unknown"}
          {arrival ? (
            <Text span size="xs" c="dimmed">
              {" "}
              — arriving {dayjs(arrival).format("ddd, MMM D")}
            </Text>
          ) : (
            <Text span size="xs" c="dimmed">
              {" "}
              — no arrival date set
            </Text>
          )}
        </Text>
        {p.note ? (
          <Text size="xs" c="dimmed">
            “{p.note}”
          </Text>
        ) : null}
      </div>
      {locked ? null : (
        <Group gap={4} wrap="nowrap" align="flex-end">
          <Select
            size="xs"
            w={210}
            placeholder="on or after…"
            data={open.map((d) => ({
              value: d.id,
              label: `On or after ${fmtDate(d.date, d.label)}${
                arrival && d.date > arrival ? " (after their arrival!)" : ""
              }`,
            }))}
            value={dateId}
            onChange={setDateId}
          />
          <Button
            size="compact-xs"
            variant="light"
            color="green"
            disabled={!dateId}
            onClick={() => {
              if (dateId)
                fetcher.submit(
                  { intent: "approvePass", id: p.id, passDateId: dateId },
                  { method: "post" },
                );
            }}
          >
            Grant
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={() =>
              fetcher.submit(
                { intent: "denyPass", id: p.id },
                { method: "post" },
              )
            }
          >
            Deny
          </Button>
        </Group>
      )}
    </Group>
  );
}

function AddDateForm({
  fetcher,
  year,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  year: number;
}) {
  const [date, setDate] = useState<Date | null>(null);
  const [label, setLabel] = useState("");
  const [quota, setQuota] = useState<number | string>(1);
  // Setup access only runs the Monday→Saturday before gates open — bound the
  // picker to that window so officers can't add unrelated dates.
  const win = setupPassWindowFor(year);
  const minDate = dayjs(win.min).toDate();
  const maxDate = dayjs(win.max).toDate();
  return (
    <Group align="flex-end">
      <DateInput
        label="On-or-after date"
        placeholder="pick a date"
        value={date}
        onChange={setDate as (v: Date | null) => void}
        minDate={minDate}
        maxDate={maxDate}
        defaultDate={minDate}
        w={170}
        valueFormat="ddd, MMM D"
      />
      <TextInput
        label="Label (optional)"
        placeholder="Monday"
        value={label}
        onChange={(e) => setLabel(e.currentTarget.value)}
        w={140}
      />
      <NumberInput
        label="Quota"
        value={quota}
        onChange={setQuota}
        min={0}
        w={90}
      />
      <Button
        disabled={!date}
        loading={fetcher.state !== "idle"}
        onClick={() => {
          if (!date) return;
          fetcher.submit(
            {
              intent: "addDate",
              date: dayjs(date).format("YYYY-MM-DD"),
              label,
              quota: String(quota),
            },
            { method: "post" },
          );
          setDate(null);
          setLabel("");
          setQuota(1);
        }}
      >
        Add date
      </Button>
    </Group>
  );
}

function DateRowView({
  d,
  granted,
  passes,
  grantGroups,
  fetcher,
  locked,
}: {
  d: DateRow;
  granted: number;
  passes: PassRow[];
  grantGroups: GrantGroup[];
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const remaining = d.quota - granted;
  const heldBy = new Set(passes.map((p) => p.holderRef).filter(Boolean));
  const grantable = grantGroups
    .map((g) => ({
      group: g.group,
      items: g.items.filter((i) => !heldBy.has(i.value)),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" wrap="wrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">
            On or after {fmtDate(d.date, d.label)}
          </Text>
          <Group gap={6} mt={2}>
            <Badge size="sm" variant="light" color="green">
              {granted} granted
            </Badge>
            <Badge
              size="sm"
              variant="light"
              color={remaining > 0 ? "blue" : "gray"}
            >
              {remaining} of {d.quota} left
            </Badge>
          </Group>
          {passes.length > 0 ? (
            <Group gap={4} mt={6}>
              {passes.map((p) => (
                <Badge
                  key={p.id}
                  size="sm"
                  variant="outline"
                  color="green"
                  rightSection={
                    locked ? null : (
                      <ActionIcon
                        size="xs"
                        variant="transparent"
                        color="red"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "revokePass", id: p.id },
                            { method: "post" },
                          )
                        }
                      >
                        ✕
                      </ActionIcon>
                    )
                  }
                >
                  {p.holderName ?? "—"}
                </Badge>
              ))}
            </Group>
          ) : null}
        </div>
        {locked ? null : (
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <Select
              size="xs"
              placeholder="grant to…"
              w={180}
              data={grantable}
              searchable
              disabled={remaining <= 0}
              value={null}
              onChange={(value) => {
                if (value)
                  fetcher.submit(
                    {
                      intent: "grantPass",
                      passDateId: d.id,
                      granteeRef: value,
                    },
                    { method: "post" },
                  );
              }}
            />
            <NumberInput
              size="xs"
              w={80}
              min={0}
              defaultValue={d.quota}
              aria-label="quota"
              onBlur={(e) => {
                const q = Number(e.currentTarget.value);
                if (Number.isFinite(q) && q !== d.quota)
                  fetcher.submit(
                    { intent: "editDate", id: d.id, quota: String(q) },
                    { method: "post" },
                  );
              }}
            />
            <Tooltip
              label={granted > 0 ? "Remove its passes first" : "Remove date"}
            >
              <ActionIcon
                variant="subtle"
                color="red"
                disabled={passes.length > 0}
                onClick={() =>
                  fetcher.submit(
                    { intent: "deleteDate", id: d.id },
                    { method: "post" },
                  )
                }
              >
                ✕
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
    </Paper>
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
