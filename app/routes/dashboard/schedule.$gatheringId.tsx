/**
 * One gathering — its days (occurrences), shifts, and sign-ups. Members sign
 * up / withdraw (capacity-capped shifts waitlist); officers manage days,
 * shifts, and assignments. Gated by the `schedule` camp feature. Design:
 * plans/events-scheduling.md.
 */
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { and, count, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import {
  GATHERING_KINDS,
  STAFFING_OPTIONS,
  dateLabel,
  isIsoDate,
  kindColor,
  kindLabel,
  staffingLabel,
  timeRangeLabel,
} from "~/lib/schedule";
import { cleanTime, loadGatheringDetail } from "~/lib/schedule.server";
import { requireActiveEdition } from "~/lib/session.server";
import {
  loadRequirements,
  loadTrainings,
  missingRequirements,
  validTrainingIds,
} from "~/lib/training.server";
import { db } from "../../../db/client.server";
import {
  gathering,
  gatheringOccurrence,
  gatheringRequirement,
  gatheringShift,
  gatheringSignup,
  membership,
  training,
  user as userTable,
} from "../../../db/schema";
import type { Route } from "./+types/schedule.$gatheringId";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `${d?.gathering.title ?? "Gathering"} · CampTool` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "schedule");
  const detail = await loadGatheringDetail(
    params.gatheringId,
    activeEdition.id,
  );
  if (!detail) throw data("Not found", { status: 404 });

  const isOfficer = hasAtLeast(active.membership.role, "officer");
  // For the officer "assign someone" select.
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

  // Requirements only exist to the viewer when they can see the training
  // feature (schedule can run without training entirely).
  const trainingVisible = featureVisibleTo(
    await getFeatureState(active.camp.id, "training"),
    active.membership.role,
  );
  const requirements = trainingVisible
    ? await loadRequirements([detail.gathering.id])
    : [];
  const myValid = trainingVisible
    ? await validTrainingIds({
        campId: active.camp.id,
        membershipId: active.membership.id,
        editionId: activeEdition.id,
      })
    : new Set<string>();
  const trainingOptions =
    trainingVisible && isOfficer
      ? (await loadTrainings(active.camp.id)).map((t) => ({
          value: t.id,
          label: t.name,
        }))
      : [];

  return {
    locked: activeEdition.locked,
    isOfficer,
    canSignUp: hasAtLeast(active.membership.role, "member"),
    myMembershipId: active.membership.id,
    trainingVisible,
    requirements: requirements.map((r) => ({
      id: r.id,
      trainingId: r.trainingId,
      name: r.name,
      enforcement: r.enforcement,
      iHaveIt: myValid.has(r.trainingId),
    })),
    trainingOptions,
    gathering: {
      id: detail.gathering.id,
      title: detail.gathering.title,
      description: detail.gathering.description,
      kind: detail.gathering.kind,
      location: detail.gathering.location,
    },
    occurrences: detail.occurrences.map((o) => ({
      id: o.id,
      date: o.date,
      startTime: o.startTime,
      endTime: o.endTime,
      status: o.status,
      note: o.note,
      shifts: detail.shifts
        .filter((s) => s.occurrenceId === o.id)
        .map((s) => ({
          id: s.id,
          role: s.role,
          staffing: s.staffing,
          minNeeded: s.minNeeded,
          capacity: s.capacity,
          startTime: s.startTime,
          endTime: s.endTime,
          note: s.note,
          signups: detail.signups
            .filter((su) => su.shiftId === s.id && su.status !== "cancelled")
            .map((su) => ({
              id: su.id,
              membershipId: su.membershipId,
              status: su.status,
              origin: su.origin,
              attendance: su.attendance,
              label: su.playaName || su.name,
            })),
        })),
    })),
    members,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "schedule");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  // Everything on this page belongs to THIS gathering in THIS edition.
  const [g] = await db
    .select({ id: gathering.id })
    .from(gathering)
    .where(
      and(
        eq(gathering.id, params.gatheringId),
        eq(gathering.editionId, activeEdition.id),
      ),
    )
    .limit(1);
  if (!g) return data({ error: "Not found." }, { status: 404 });
  const gatheringId = g.id;

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const officerOnly = () =>
    data({ error: "Officers manage the schedule." }, { status: 403 });

  /** Resolve a shift id to its row, verifying it hangs off this gathering. */
  async function shiftInGathering(shiftId: string) {
    const [row] = await db
      .select({
        id: gatheringShift.id,
        staffing: gatheringShift.staffing,
        capacity: gatheringShift.capacity,
      })
      .from(gatheringShift)
      .innerJoin(
        gatheringOccurrence,
        eq(gatheringOccurrence.id, gatheringShift.occurrenceId),
      )
      .where(
        and(
          eq(gatheringShift.id, shiftId),
          eq(gatheringOccurrence.gatheringId, gatheringId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Non-cancelled committed signups (what counts against capacity). */
  async function committedCount(shiftId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(gatheringSignup)
      .where(
        and(
          eq(gatheringSignup.shiftId, shiftId),
          eq(gatheringSignup.status, "signed_up"),
        ),
      );
    return row?.value ?? 0;
  }

  async function upsertSignup(opts: {
    shiftId: string;
    membershipId: string;
    status: string;
    origin: string;
    attendance?: string;
    recordedByMembershipId?: string;
  }) {
    const attendanceFields = opts.attendance
      ? {
          attendance: opts.attendance,
          recordedByMembershipId: opts.recordedByMembershipId ?? null,
          recordedAt: new Date(),
        }
      : {};
    await db
      .insert(gatheringSignup)
      .values({
        id: crypto.randomUUID(),
        campId: active.camp.id,
        editionId: activeEdition.id,
        shiftId: opts.shiftId,
        membershipId: opts.membershipId,
        status: opts.status,
        origin: opts.origin,
        ...attendanceFields,
      })
      .onConflictDoUpdate({
        target: [gatheringSignup.shiftId, gatheringSignup.membershipId],
        set: {
          status: opts.status,
          origin: opts.origin,
          ...attendanceFields,
          updatedAt: new Date(),
        },
      });
  }

  // ---- member self-service ----
  if (intent === "signUp" || intent === "maybe") {
    if (!hasAtLeast(active.membership.role, "member")) {
      return data({ error: "Members can sign up." }, { status: 403 });
    }
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    // Training requirements block self-sign-up only while the training
    // feature is fully ON (preview = officers exploring; don't gate members
    // on qualifications they can't even see). Officer `assign` bypasses.
    if ((await getFeatureState(active.camp.id, "training")) === "on") {
      const missing = await missingRequirements({
        campId: active.camp.id,
        gatheringId,
        membershipId: active.membership.id,
        editionId: activeEdition.id,
      });
      const blocked = missing.filter((m) => m.enforcement === "required");
      if (blocked.length > 0) {
        return data(
          {
            error: `You need the ${blocked
              .map((m) => m.name)
              .join(" and ")} sign-off first — see the Training page.`,
          },
          { status: 403 },
        );
      }
    }
    let status = intent === "maybe" ? "maybe" : "signed_up";
    // A full capacity-capped shift takes further sign-ups as waitlist.
    if (
      status === "signed_up" &&
      shift.staffing === "needed" &&
      shift.capacity != null &&
      (await committedCount(shift.id)) >= shift.capacity
    ) {
      status = "waitlisted";
    }
    await upsertSignup({
      shiftId: shift.id,
      membershipId: active.membership.id,
      status,
      origin: "self",
    });
    return data({ ok: true, waitlisted: status === "waitlisted" });
  }

  if (intent === "withdraw") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    await db
      .update(gatheringSignup)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(gatheringSignup.shiftId, shift.id),
          eq(gatheringSignup.membershipId, active.membership.id),
        ),
      );
    return data({ ok: true });
  }

  // ---- officer management ----
  if (!isOfficer) return officerOnly();

  if (intent === "updateGathering") {
    const title = String(form.get("title") ?? "").trim();
    const kind = String(form.get("kind") ?? "");
    if (!title || title.length > 200) {
      return data({ error: "Please keep a title." }, { status: 400 });
    }
    if (!GATHERING_KINDS.some((k) => k.value === kind)) {
      return data({ error: "Unknown kind." }, { status: 400 });
    }
    await db
      .update(gathering)
      .set({
        title,
        kind,
        description: String(form.get("description") ?? "").trim() || null,
        location: String(form.get("location") ?? "").trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(gathering.id, gatheringId));
    return data({ ok: true });
  }

  if (intent === "archiveGathering") {
    await db
      .update(gathering)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(gathering.id, gatheringId));
    return redirect("/schedule");
  }

  if (intent === "addOccurrence") {
    const date = String(form.get("date") ?? "");
    if (!isIsoDate(date)) {
      return data({ error: "Pick a date." }, { status: 400 });
    }
    const occurrenceId = crypto.randomUUID();
    await db.insert(gatheringOccurrence).values({
      id: occurrenceId,
      campId: active.camp.id,
      editionId: activeEdition.id,
      gatheringId,
      date,
      startTime: cleanTime(form.get("startTime")),
      endTime: cleanTime(form.get("endTime")),
    });
    // Every occurrence gets a starting shift so sign-ups have a target.
    await db.insert(gatheringShift).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      editionId: activeEdition.id,
      occurrenceId,
      staffing: "open",
    });
    return data({ ok: true });
  }

  const occurrenceIntents = new Set([
    "cancelOccurrence",
    "restoreOccurrence",
    "deleteOccurrence",
  ]);
  if (occurrenceIntents.has(intent)) {
    const [occ] = await db
      .select({ id: gatheringOccurrence.id })
      .from(gatheringOccurrence)
      .where(
        and(
          eq(gatheringOccurrence.id, String(form.get("occurrenceId"))),
          eq(gatheringOccurrence.gatheringId, gatheringId),
        ),
      )
      .limit(1);
    if (!occ) return data({ error: "Day not found." }, { status: 404 });
    if (intent === "deleteOccurrence") {
      await db
        .delete(gatheringOccurrence)
        .where(eq(gatheringOccurrence.id, occ.id));
    } else {
      await db
        .update(gatheringOccurrence)
        .set({
          status: intent === "cancelOccurrence" ? "cancelled" : "scheduled",
          updatedAt: new Date(),
        })
        .where(eq(gatheringOccurrence.id, occ.id));
    }
    return data({ ok: true });
  }

  if (intent === "addShift") {
    const [occ] = await db
      .select({ id: gatheringOccurrence.id })
      .from(gatheringOccurrence)
      .where(
        and(
          eq(gatheringOccurrence.id, String(form.get("occurrenceId"))),
          eq(gatheringOccurrence.gatheringId, gatheringId),
        ),
      )
      .limit(1);
    if (!occ) return data({ error: "Day not found." }, { status: 404 });
    const staffing = String(form.get("staffing") ?? "open");
    if (!STAFFING_OPTIONS.some((s) => s.value === staffing)) {
      return data({ error: "Unknown staffing." }, { status: 400 });
    }
    const capacityRaw = Number(form.get("capacity"));
    const capacity =
      staffing === "needed" && Number.isInteger(capacityRaw) && capacityRaw > 0
        ? capacityRaw
        : null;
    await db.insert(gatheringShift).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      editionId: activeEdition.id,
      occurrenceId: occ.id,
      role: String(form.get("role") ?? "").trim() || null,
      staffing,
      minNeeded: capacity,
      capacity,
      startTime: cleanTime(form.get("startTime")),
      endTime: cleanTime(form.get("endTime")),
    });
    return data({ ok: true });
  }

  if (intent === "deleteShift") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    await db.delete(gatheringShift).where(eq(gatheringShift.id, shift.id));
    return data({ ok: true });
  }

  if (intent === "assign") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    const memberId = String(form.get("membershipId") ?? "");
    const [target] = await db
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.id, memberId),
          eq(membership.organizationId, active.camp.id),
        ),
      )
      .limit(1);
    if (!target) return data({ error: "Member not found." }, { status: 404 });
    // Officer assignment is authoritative — no capacity gate, no waitlist.
    await upsertSignup({
      shiftId: shift.id,
      membershipId: target.id,
      status: "signed_up",
      origin: "assigned",
    });
    return data({ ok: true });
  }

  if (intent === "walkIn") {
    // The substitution record: someone covered this shift without signing up
    // (e.g. the scheduled bartender no-showed and another camper stepped in).
    // One upsert marks them signed_up + walk_in + attended.
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
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
    await upsertSignup({
      shiftId: shift.id,
      membershipId: target.id,
      status: "signed_up",
      origin: "walk_in",
      attendance: "attended",
      recordedByMembershipId: active.membership.id,
    });
    return data({ ok: true });
  }

  if (intent === "markAttendance") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    const attendance = String(form.get("attendance"));
    if (!["unknown", "attended", "no_show"].includes(attendance)) {
      return data({ error: "Unknown attendance state." }, { status: 400 });
    }
    await db
      .update(gatheringSignup)
      .set({
        attendance,
        recordedByMembershipId: active.membership.id,
        recordedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gatheringSignup.shiftId, shift.id),
          eq(gatheringSignup.membershipId, String(form.get("membershipId"))),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "addRequirement") {
    const trainingId = String(form.get("trainingId") ?? "");
    const [t] = await db
      .select({ id: training.id })
      .from(training)
      .where(
        and(eq(training.id, trainingId), eq(training.campId, active.camp.id)),
      )
      .limit(1);
    if (!t) return data({ error: "Training not found." }, { status: 404 });
    const enforcement =
      String(form.get("enforcement")) === "warn" ? "warn" : "required";
    await db
      .insert(gatheringRequirement)
      .values({
        id: crypto.randomUUID(),
        campId: active.camp.id,
        gatheringId,
        trainingId: t.id,
        enforcement,
      })
      .onConflictDoUpdate({
        target: [
          gatheringRequirement.gatheringId,
          gatheringRequirement.trainingId,
        ],
        set: { enforcement },
      });
    return data({ ok: true });
  }

  if (intent === "removeRequirement") {
    await db
      .delete(gatheringRequirement)
      .where(
        and(
          eq(gatheringRequirement.id, String(form.get("requirementId"))),
          eq(gatheringRequirement.gatheringId, gatheringId),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "removeSignup") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    await db
      .delete(gatheringSignup)
      .where(
        and(
          eq(gatheringSignup.shiftId, shift.id),
          eq(gatheringSignup.membershipId, String(form.get("membershipId"))),
        ),
      );
    return data({ ok: true });
  }

  if (intent === "promote") {
    const shift = await shiftInGathering(String(form.get("shiftId")));
    if (!shift) return data({ error: "Shift not found." }, { status: 404 });
    await db
      .update(gatheringSignup)
      .set({ status: "signed_up", updatedAt: new Date() })
      .where(
        and(
          eq(gatheringSignup.shiftId, shift.id),
          eq(gatheringSignup.membershipId, String(form.get("membershipId"))),
        ),
      );
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type LoaderData = Route.ComponentProps["loaderData"];
type Occurrence = LoaderData["occurrences"][number];
type Shift = Occurrence["shifts"][number];

export default function GatheringDetail({ loaderData }: Route.ComponentProps) {
  const { locked, isOfficer, gathering: g, occurrences } = loaderData;
  const canManage = isOfficer && !locked;

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Anchor size="sm" component={Link} to="/schedule">
            ← Schedule
          </Anchor>
          <Group gap="sm" mt={4}>
            <Title order={2}>{g.title}</Title>
            <Badge color={kindColor(g.kind)} variant="light">
              {kindLabel(g.kind)}
            </Badge>
          </Group>
          {g.location ? (
            <Text size="sm" c="dimmed">
              {g.location}
            </Text>
          ) : null}
          {g.description ? (
            <Text size="sm" mt="xs" style={{ whiteSpace: "pre-wrap" }}>
              {g.description}
            </Text>
          ) : null}
          {loaderData.requirements.length > 0 ? (
            <Group gap={6} mt="xs">
              {loaderData.requirements.map((r) => (
                <Badge
                  key={r.id}
                  size="sm"
                  variant={r.iHaveIt ? "light" : "outline"}
                  color={
                    r.iHaveIt
                      ? "green"
                      : r.enforcement === "required"
                        ? "red"
                        : "yellow"
                  }
                >
                  {r.enforcement === "warn" ? "suggests" : "requires"} {r.name}
                  {r.iHaveIt ? " ✓" : ""}
                </Badge>
              ))}
            </Group>
          ) : null}
        </div>

        {locked ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Text size="sm" c="dimmed">
              This year is locked — the schedule is read-only.
            </Text>
          </Paper>
        ) : null}

        {canManage ? <EditGathering g={g} /> : null}
        {canManage && loaderData.trainingVisible ? (
          <ManageRequirements loaderData={loaderData} />
        ) : null}

        {occurrences.map((o) => (
          <OccurrenceCard key={o.id} o={o} loaderData={loaderData} />
        ))}

        {canManage ? <AddOccurrence /> : null}
      </Stack>
    </Container>
  );
}

function ManageRequirements({ loaderData }: { loaderData: LoaderData }) {
  const { requirements, trainingOptions } = loaderData;
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [trainingId, setTrainingId] = useState<string | null>(null);
  const [enforcement, setEnforcement] = useState("required");
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);
  const available = trainingOptions.filter(
    (t) => !requirements.some((r) => r.trainingId === t.value),
  );
  return (
    <Paper withBorder p="md" radius="md">
      <Text fw={600} size="sm" mb="xs">
        Required training
      </Text>
      {requirements.length === 0 ? (
        <Text size="xs" c="dimmed" mb="xs">
          No training required to sign up.
        </Text>
      ) : (
        <Stack gap={4} mb="xs">
          {requirements.map((r) => (
            <Group key={r.id} gap="xs">
              <Text size="sm">
                {r.name}{" "}
                <Text span size="xs" c="dimmed">
                  ({r.enforcement === "warn" ? "suggested" : "required"})
                </Text>
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() =>
                  fetcher.submit(
                    { intent: "removeRequirement", requirementId: r.id },
                    { method: "post" },
                  )
                }
              >
                Remove
              </Button>
            </Group>
          ))}
        </Stack>
      )}
      {available.length > 0 ? (
        <Group align="flex-end" gap="xs">
          <Select
            size="xs"
            placeholder="Add a training…"
            data={available}
            value={trainingId}
            onChange={setTrainingId}
            searchable
          />
          <Select
            size="xs"
            data={[
              { value: "required", label: "Required" },
              { value: "warn", label: "Suggested" },
            ]}
            value={enforcement}
            onChange={(v) => setEnforcement(v ?? "required")}
            allowDeselect={false}
            w={110}
          />
          <Button
            size="xs"
            variant="light"
            disabled={!trainingId}
            onClick={() => {
              if (!trainingId) return;
              fetcher.submit(
                { intent: "addRequirement", trainingId, enforcement },
                { method: "post" },
              );
              setTrainingId(null);
            }}
          >
            Add
          </Button>
        </Group>
      ) : trainingOptions.length === 0 ? (
        <Text size="xs" c="dimmed">
          Define trainings on the Training page first.
        </Text>
      ) : null}
    </Paper>
  );
}

/** Small two-step destructive button: first click arms it, second fires. */
function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="compact-xs"
      variant={armed ? "filled" : "subtle"}
      color="red"
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

function EditGathering({ g }: { g: LoaderData["gathering"] }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const archiveFetcher = useFetcher();
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
          Edit gathering
        </Text>
        <Group gap="xs">
          <ConfirmButton
            label="Archive"
            confirmLabel="Really archive?"
            onConfirm={() =>
              archiveFetcher.submit(
                { intent: "archiveGathering" },
                { method: "post" },
              )
            }
          />
          <Button size="xs" variant="light" onClick={toggle}>
            {opened ? "Close" : "Edit"}
          </Button>
        </Group>
      </Group>
      <Collapse in={opened}>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="updateGathering" />
          <Stack gap="sm" mt="sm">
            <Group grow>
              <TextInput name="title" label="Title" defaultValue={g.title} />
              <Select
                name="kind"
                label="Kind"
                defaultValue={g.kind}
                data={GATHERING_KINDS.map((k) => ({
                  value: k.value,
                  label: k.label,
                }))}
                allowDeselect={false}
              />
            </Group>
            <TextInput
              name="location"
              label="Where"
              defaultValue={g.location ?? ""}
            />
            <Textarea
              name="description"
              label="Details"
              defaultValue={g.description ?? ""}
              autosize
              minRows={2}
            />
            <Group justify="flex-end">
              <Button
                type="submit"
                size="xs"
                loading={fetcher.state !== "idle"}
              >
                Save
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Collapse>
    </Paper>
  );
}

function AddOccurrence() {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);
  return (
    <Paper withBorder p="md" radius="md">
      <Text fw={600} size="sm" mb="sm">
        Add a day
      </Text>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="addOccurrence" />
        <Group align="flex-end">
          <TextInput type="date" name="date" label="Date" required />
          <TextInput type="time" name="startTime" label="Starts" />
          <TextInput type="time" name="endTime" label="Ends" />
          <Button type="submit" size="xs" loading={fetcher.state !== "idle"}>
            Add
          </Button>
        </Group>
      </fetcher.Form>
    </Paper>
  );
}

function OccurrenceCard({
  o,
  loaderData,
}: {
  o: Occurrence;
  loaderData: LoaderData;
}) {
  const { isOfficer, locked } = loaderData;
  const canManage = isOfficer && !locked;
  const fetcher = useFetcher();
  const cancelled = o.status === "cancelled";
  return (
    <Card
      withBorder
      padding="md"
      opacity={cancelled ? 0.6 : 1}
      aria-label={`${dateLabel(o.date)}${cancelled ? " (cancelled)" : ""}`}
    >
      <Group justify="space-between" wrap="nowrap" mb="xs">
        <div>
          <Group gap="xs">
            <Text fw={600}>{dateLabel(o.date)}</Text>
            {cancelled ? (
              <Badge size="xs" color="red" variant="light">
                cancelled
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" c="dimmed">
            {timeRangeLabel(o.startTime, o.endTime)}
          </Text>
        </div>
        {canManage ? (
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() =>
                fetcher.submit(
                  {
                    intent: cancelled
                      ? "restoreOccurrence"
                      : "cancelOccurrence",
                    occurrenceId: o.id,
                  },
                  { method: "post" },
                )
              }
            >
              {cancelled ? "Restore" : "Cancel day"}
            </Button>
            <ConfirmButton
              label="Delete"
              confirmLabel="Really delete?"
              onConfirm={() =>
                fetcher.submit(
                  { intent: "deleteOccurrence", occurrenceId: o.id },
                  { method: "post" },
                )
              }
            />
          </Group>
        ) : null}
      </Group>

      <Stack gap="sm">
        {o.shifts.map((s) => (
          <ShiftRow
            key={s.id}
            shift={s}
            loaderData={loaderData}
            muted={cancelled}
          />
        ))}
        {canManage ? <AddShift occurrenceId={o.id} /> : null}
      </Stack>
    </Card>
  );
}

function ShiftRow({
  shift: s,
  loaderData,
  muted,
}: {
  shift: Shift;
  loaderData: LoaderData;
  muted: boolean;
}) {
  const { isOfficer, locked, canSignUp, myMembershipId, members } = loaderData;
  const canManage = isOfficer && !locked;
  const fetcher = useFetcher<{
    ok?: boolean;
    waitlisted?: boolean;
    error?: string;
  }>();
  const assignFetcher = useFetcher();
  const [picker, setPicker] = useState<"assign" | "walkIn" | null>(null);

  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.waitlisted) {
      notifications.show({
        color: "yellow",
        message: "That shift is full — you're on the waitlist.",
      });
    }
  }, [fetcher.data]);

  const committed = s.signups.filter((su) => su.status === "signed_up");
  const maybes = s.signups.filter((su) => su.status === "maybe");
  const waitlist = s.signups.filter((su) => su.status === "waitlisted");
  const mine = s.signups.find((su) => su.membershipId === myMembershipId);
  const needs =
    s.staffing === "needed" && s.capacity != null
      ? `${committed.length}/${s.capacity}`
      : `${committed.length}`;

  const post = (intent: string) =>
    fetcher.submit({ intent, shiftId: s.id }, { method: "post" });

  return (
    <Paper withBorder p="sm" radius="sm" opacity={muted ? 0.7 : 1}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text size="sm" fw={600}>
              {s.role ?? "General"}
            </Text>
            <Badge size="xs" variant="light">
              {staffingLabel(s.staffing)}
            </Badge>
            <Badge size="xs" variant="outline" color="gray">
              {needs} signed up
            </Badge>
            {s.startTime ? (
              <Text size="xs" c="dimmed">
                {timeRangeLabel(s.startTime, s.endTime)}
              </Text>
            ) : null}
          </Group>
          {committed.length + maybes.length + waitlist.length > 0 ? (
            <Text size="xs" c="dimmed" mt={4}>
              {committed
                .map(
                  (su) =>
                    su.label +
                    (su.origin === "walk_in" ? " (walk-in)" : "") +
                    (su.attendance === "attended"
                      ? " ✓"
                      : su.attendance === "no_show"
                        ? " ✗ no-show"
                        : ""),
                )
                .join(", ")}
              {maybes.length > 0
                ? `${committed.length ? " · " : ""}maybe: ${maybes
                    .map((su) => su.label)
                    .join(", ")}`
                : ""}
              {waitlist.length > 0
                ? ` · waitlist: ${waitlist.map((su) => su.label).join(", ")}`
                : ""}
            </Text>
          ) : null}
          {canManage && s.signups.length > 0 ? (
            <Stack gap={2} mt={4}>
              {s.signups.map((su) => (
                <Group gap={4} key={su.id} wrap="nowrap">
                  <Text size="xs" w={140} truncate>
                    {su.label}
                  </Text>
                  {/* Attendance outcome — click the active state to unset. */}
                  <ActionIcon
                    size="xs"
                    variant={su.attendance === "attended" ? "filled" : "subtle"}
                    color="green"
                    aria-label={`${su.label} attended`}
                    onClick={() =>
                      assignFetcher.submit(
                        {
                          intent: "markAttendance",
                          shiftId: s.id,
                          membershipId: su.membershipId,
                          attendance:
                            su.attendance === "attended"
                              ? "unknown"
                              : "attended",
                        },
                        { method: "post" },
                      )
                    }
                  >
                    ✓
                  </ActionIcon>
                  <ActionIcon
                    size="xs"
                    variant={su.attendance === "no_show" ? "filled" : "subtle"}
                    color="orange"
                    aria-label={`${su.label} didn't show`}
                    onClick={() =>
                      assignFetcher.submit(
                        {
                          intent: "markAttendance",
                          shiftId: s.id,
                          membershipId: su.membershipId,
                          attendance:
                            su.attendance === "no_show" ? "unknown" : "no_show",
                        },
                        { method: "post" },
                      )
                    }
                  >
                    ✗
                  </ActionIcon>
                  {su.status === "waitlisted" ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() =>
                        assignFetcher.submit(
                          {
                            intent: "promote",
                            shiftId: s.id,
                            membershipId: su.membershipId,
                          },
                          { method: "post" },
                        )
                      }
                    >
                      Promote
                    </Button>
                  ) : null}
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    aria-label={`Remove ${su.label}`}
                    onClick={() =>
                      assignFetcher.submit(
                        {
                          intent: "removeSignup",
                          shiftId: s.id,
                          membershipId: su.membershipId,
                        },
                        { method: "post" },
                      )
                    }
                  >
                    ✕
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
          ) : null}
        </div>

        <Stack gap={4} align="flex-end">
          {canSignUp && !locked && !muted ? (
            mine && mine.status !== "cancelled" ? (
              <Group gap="xs">
                <Badge
                  size="sm"
                  variant="light"
                  color={mine.status === "waitlisted" ? "yellow" : "green"}
                >
                  {mine.status === "waitlisted"
                    ? "waitlisted"
                    : mine.status === "maybe"
                      ? "maybe"
                      : "you're in"}
                </Badge>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => post("withdraw")}
                >
                  Withdraw
                </Button>
              </Group>
            ) : (
              <Group gap="xs">
                <Button size="compact-xs" onClick={() => post("signUp")}>
                  Sign up
                </Button>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => post("maybe")}
                >
                  Maybe
                </Button>
              </Group>
            )
          ) : null}
          {canManage ? (
            <Group gap="xs">
              {picker ? (
                <Select
                  size="xs"
                  placeholder={
                    picker === "assign"
                      ? "Assign someone…"
                      : "Who covered this shift?"
                  }
                  data={members}
                  searchable
                  onChange={(id) => {
                    if (id) {
                      assignFetcher.submit(
                        {
                          intent: picker === "assign" ? "assign" : "walkIn",
                          shiftId: s.id,
                          membershipId: id,
                        },
                        { method: "post" },
                      );
                    }
                    setPicker(null);
                  }}
                />
              ) : (
                <>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setPicker("assign")}
                  >
                    Assign
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setPicker("walkIn")}
                  >
                    Walk-in
                  </Button>
                </>
              )}
              <ConfirmButton
                label="Delete shift"
                confirmLabel="Really?"
                onConfirm={() =>
                  assignFetcher.submit(
                    { intent: "deleteShift", shiftId: s.id },
                    { method: "post" },
                  )
                }
              />
            </Group>
          ) : null}
        </Stack>
      </Group>
    </Paper>
  );
}

function AddShift({ occurrenceId }: { occurrenceId: string }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [opened, { toggle }] = useDisclosure(false);
  const [staffing, setStaffing] = useState("needed");
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);
  if (!opened) {
    return (
      <Button
        size="compact-xs"
        variant="subtle"
        onClick={toggle}
        w="fit-content"
      >
        + Add shift/role
      </Button>
    );
  }
  return (
    <Paper withBorder p="sm" radius="sm">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="addShift" />
        <input type="hidden" name="occurrenceId" value={occurrenceId} />
        <input type="hidden" name="staffing" value={staffing} />
        <Group align="flex-end" wrap="wrap">
          <TextInput
            name="role"
            label="Role"
            placeholder="e.g. Bartender"
            size="xs"
          />
          <Select
            label="Who's needed"
            size="xs"
            value={staffing}
            onChange={(v) => setStaffing(v ?? "needed")}
            data={STAFFING_OPTIONS.map((so) => ({
              value: so.value,
              label: so.label,
            }))}
            allowDeselect={false}
          />
          {staffing === "needed" ? (
            <NumberInput
              name="capacity"
              label="How many"
              min={1}
              size="xs"
              w={90}
            />
          ) : null}
          <TextInput type="time" name="startTime" label="Starts" size="xs" />
          <TextInput type="time" name="endTime" label="Ends" size="xs" />
          <Button type="submit" size="xs" loading={fetcher.state !== "idle"}>
            Add
          </Button>
          <Button size="xs" variant="subtle" onClick={toggle}>
            Close
          </Button>
        </Group>
      </fetcher.Form>
    </Paper>
  );
}
