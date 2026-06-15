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
import { and, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { membership, setupPass, setupPassDate, user } from "../../../db/schema";
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
  passDateId: string;
  membershipId: string;
  holderName: string | null;
  status: string;
  note: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
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

  const passes = (await db
    .select({
      id: setupPass.id,
      passDateId: setupPass.passDateId,
      membershipId: setupPass.membershipId,
      holderName: user.name,
      status: setupPass.status,
      note: setupPass.note,
    })
    .from(setupPass)
    .leftJoin(membership, eq(setupPass.membershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(setupPass.editionId, editionId))) satisfies PassRow[];

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
    dates,
    passes,
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

  // --- Member self-service (any role) -------------------------------------
  if (intent === "requestPass") {
    const passDateId = str("passDateId");
    if (!passDateId) return data({ error: "Pick a date." }, { status: 400 });
    const [existing] = await db
      .select({ id: setupPass.id })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.passDateId, passDateId),
          eq(setupPass.membershipId, myMid),
        ),
      )
      .limit(1);
    if (existing) {
      return data(
        { error: "You already have a pass for that date." },
        {
          status: 409,
        },
      );
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      passDateId,
      membershipId: myMid,
      status: "requested",
      note: str("note"),
      createdById: actor.id,
    });
    return data({ ok: "Request sent." });
  }

  if (intent === "cancelPass") {
    await db
      .delete(setupPass)
      .where(
        and(
          eq(setupPass.id, String(form.get("id"))),
          eq(setupPass.membershipId, myMid),
          eq(setupPass.status, "requested"),
        ),
      );
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
    const targetMid = str("membershipId");
    if (!targetMid) return data({ error: "Pick a member." }, { status: 400 });
    if (!(await hasRoom(passDateId))) {
      return data({ error: "That date is at its quota." }, { status: 409 });
    }
    const [existing] = await db
      .select({ id: setupPass.id })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.passDateId, passDateId),
          eq(setupPass.membershipId, targetMid),
        ),
      )
      .limit(1);
    if (existing) {
      await db
        .update(setupPass)
        .set({
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
        membershipId: targetMid,
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
    const [p] = await db
      .select({ passDateId: setupPass.passDateId })
      .from(setupPass)
      .where(and(eq(setupPass.id, id), eq(setupPass.editionId, editionId)))
      .limit(1);
    if (!p) return data({ error: "Not found." }, { status: 404 });
    if (!(await hasRoom(p.passDateId))) {
      return data({ error: "That date is at its quota." }, { status: 409 });
    }
    await db
      .update(setupPass)
      .set({
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
  const { isOfficer, locked, myMembershipId, dates, passes, members } =
    loaderData;
  const fetcher = useFetcher<FetcherData>();
  useFetcherNotifications(fetcher.data, fetcher.state);

  const grantedFor = (dateId: string) =>
    passes.filter((p) => p.passDateId === dateId && p.status === "granted")
      .length;
  const dateById = new Map(dates.map((d) => [d.id, d]));

  const myPasses = passes.filter((p) => p.membershipId === myMembershipId);
  const myDateIds = new Set(myPasses.map((p) => p.passDateId));
  const openDates = dates.filter(
    (d) => grantedFor(d.id) < d.quota && !myDateIds.has(d.id),
  );
  const pending = passes.filter((p) => p.status === "requested");

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Setup access passes</Title>
          <Text c="dimmed" size="sm">
            Early-arrival passes the camp allocates per day. Each pass is tied
            to an entry date.
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
                  const d = dateById.get(p.passDateId);
                  return (
                    <Group key={p.id} gap="xs">
                      <Badge
                        size="lg"
                        variant="light"
                        color={STATUS_COLOR[p.status] ?? "gray"}
                      >
                        {d ? fmtDate(d.date, d.label) : "—"} · {p.status}
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

            {!locked && openDates.length > 0 ? (
              <RequestPassForm fetcher={fetcher} openDates={openDates} />
            ) : !locked ? (
              <Text size="sm" c="dimmed">
                No dates open for request right now.
              </Text>
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
                  {pending.map((p) => {
                    const d = dateById.get(p.passDateId);
                    return (
                      <Group key={p.id} justify="space-between" wrap="nowrap">
                        <div>
                          <Text size="sm" fw={500}>
                            {p.holderName ?? "Unknown"} —{" "}
                            {d ? fmtDate(d.date, d.label) : "—"}
                          </Text>
                          {p.note ? (
                            <Text size="xs" c="dimmed">
                              “{p.note}”
                            </Text>
                          ) : null}
                        </div>
                        {locked ? null : (
                          <Group gap={4} wrap="nowrap">
                            <Button
                              size="compact-xs"
                              variant="light"
                              color="green"
                              onClick={() =>
                                fetcher.submit(
                                  { intent: "approvePass", id: p.id },
                                  { method: "post" },
                                )
                              }
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
                  })}
                </Stack>
              </Card>
            ) : null}

            <Card withBorder padding="md" radius="md">
              <Text fw={600} mb="xs">
                Entry dates &amp; quotas
              </Text>
              {dates.length === 0 ? (
                <Text size="sm" c="dimmed" mb="sm">
                  No dates yet. Add the camp's per-day allocation below.
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
                      members={members}
                      fetcher={fetcher}
                      locked={locked}
                    />
                  ))}
                </Stack>
              )}
              {locked ? null : <AddDateForm fetcher={fetcher} />}
            </Card>
          </>
        ) : null}
      </Stack>
    </Container>
  );
}

function RequestPassForm({
  fetcher,
  openDates,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  openDates: DateRow[];
}) {
  const [dateId, setDateId] = useState<string | null>(null);
  return (
    <Group align="flex-end">
      <Select
        label="Request a pass"
        placeholder="pick a date"
        w={220}
        data={openDates.map((d) => ({
          value: d.id,
          label: fmtDate(d.date, d.label),
        }))}
        value={dateId}
        onChange={setDateId}
        searchable
      />
      <Button
        disabled={!dateId}
        loading={fetcher.state !== "idle"}
        onClick={() => {
          if (dateId)
            fetcher.submit(
              { intent: "requestPass", passDateId: dateId },
              { method: "post" },
            );
          setDateId(null);
        }}
      >
        Request
      </Button>
    </Group>
  );
}

function AddDateForm({ fetcher }: { fetcher: ReturnType<typeof useFetcher> }) {
  const [date, setDate] = useState<Date | null>(null);
  const [label, setLabel] = useState("");
  const [quota, setQuota] = useState<number | string>(1);
  return (
    <Group align="flex-end">
      <DateInput
        label="Entry date"
        placeholder="pick a date"
        value={date}
        onChange={setDate as (v: Date | null) => void}
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
  members,
  fetcher,
  locked,
}: {
  d: DateRow;
  granted: number;
  passes: PassRow[];
  members: { id: string; name: string }[];
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const remaining = d.quota - granted;
  const heldBy = new Set(passes.map((p) => p.membershipId));
  const grantable = members.filter((m) => !heldBy.has(m.id));
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Text fw={600} size="sm">
            {fmtDate(d.date, d.label)}
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
              w={160}
              data={grantable.map((m) => ({ value: m.id, label: m.name }))}
              searchable
              disabled={remaining <= 0}
              value={null}
              onChange={(value) => {
                if (value)
                  fetcher.submit(
                    {
                      intent: "grantPass",
                      passDateId: d.id,
                      membershipId: value,
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
