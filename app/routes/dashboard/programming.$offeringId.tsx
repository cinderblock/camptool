/**
 * One offering — its details, its dated sessions, and who's presenting.
 * Officers schedule sessions (which is what publishes it) and manage
 * presenters; the proposer can edit their own while it's still awaiting
 * review. Gated by the `programming` camp feature.
 * Design: plans/programming-offerings.md.
 */
import {
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
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect } from "react";
import { Link, data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import {
  AUDIENCE_OPTIONS,
  DURATION_OPTIONS,
  OFFERING_KINDS,
  OFFERING_STATUS_COLOR,
  OFFERING_STATUS_LABEL,
  type OfferingStatus,
  durationLabel,
  isOfferingAudience,
  isOfferingKind,
  offeringKindColor,
  offeringKindLabel,
  presenterName,
} from "~/lib/programming";
import {
  addPresenter,
  addSession,
  cleanTime,
  loadOffering,
} from "~/lib/programming.server";
import { dateLabel, isIsoDate, timeRangeLabel, todayIso } from "~/lib/schedule";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  attendee,
  membership,
  offering,
  offeringPresenter,
  offeringSession,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/programming.$offeringId";

export function meta({ data: d }: Route.MetaArgs) {
  return [{ title: `${d?.offering.title ?? "Offering"} · CampTool` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "programming");
  const detail = await loadOffering(params.offeringId, activeEdition.id);
  if (!detail) throw data("Not found", { status: 404 });

  // Candidates for the presenter picker: everyone in the camp's party this
  // year (members and their guests), which is exactly the attendee roster.
  const party = await db
    .select({
      id: attendee.id,
      guestName: attendee.name,
      memberName: user.name,
    })
    .from(attendee)
    .leftJoin(membership, eq(membership.id, attendee.membershipId))
    .leftJoin(user, eq(user.id, membership.userId))
    .where(eq(attendee.editionId, activeEdition.id));

  return redact(privacy, {
    ...detail,
    locked: activeEdition.locked,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    isMine: detail.offering.proposedByMembershipId === active.membership.id,
    party: party
      .map((p) => ({
        id: p.id,
        name: p.memberName ?? p.guestName ?? "Unnamed",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "programming");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  const [row] = await db
    .select()
    .from(offering)
    .where(
      and(
        eq(offering.id, params.offeringId),
        eq(offering.editionId, activeEdition.id),
      ),
    )
    .limit(1);
  if (!row) return data({ error: "Not found." }, { status: 404 });

  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const isMine = row.proposedByMembershipId === active.membership.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const scope = { campId: active.camp.id, editionId: activeEdition.id };

  if (intent === "update") {
    // The proposer keeps control until an officer has ruled on it; after that
    // it's the officers' schedule to manage.
    const canEdit = isOfficer || (isMine && row.status === "proposed");
    if (!canEdit) {
      return data(
        { error: "It's been reviewed — talk to an officer to change it." },
        { status: 403 },
      );
    }
    const title = String(form.get("title") ?? "").trim();
    if (!title || title.length > 200) {
      return data({ error: "Please give it a title." }, { status: 400 });
    }
    const kind = String(form.get("kind") ?? row.kind);
    if (!isOfferingKind(kind)) {
      return data({ error: "Unknown kind." }, { status: 400 });
    }
    const audience = String(form.get("audience") ?? row.audience);
    if (!isOfferingAudience(audience)) {
      return data({ error: "Unknown audience." }, { status: 400 });
    }
    const duration = Number(form.get("durationMin"));
    const capacity = Number(form.get("capacity"));
    await db
      .update(offering)
      .set({
        title,
        description: String(form.get("description") ?? "").trim() || null,
        kind,
        audience,
        durationMin:
          Number.isInteger(duration) && duration > 0 ? duration : null,
        capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : null,
        location: String(form.get("location") ?? "").trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(offering.id, row.id));
    return data({ ok: "Saved." });
  }

  // Presenters: the proposer can credit collaborators on their own proposal;
  // after review it's officer territory, same rule as editing.
  if (intent === "addPresenter" || intent === "removePresenter") {
    const canEdit = isOfficer || (isMine && row.status === "proposed");
    if (!canEdit) {
      return data({ error: "Officers manage presenters." }, { status: 403 });
    }
    if (intent === "removePresenter") {
      await db
        .delete(offeringPresenter)
        .where(
          and(
            eq(offeringPresenter.id, String(form.get("presenterId") ?? "")),
            eq(offeringPresenter.offeringId, row.id),
          ),
        );
      return data({ ok: "Removed." });
    }
    const attendeeId = String(form.get("attendeeId") ?? "").trim() || null;
    const name = String(form.get("name") ?? "").trim() || null;
    if (!attendeeId && !name) {
      return data(
        {
          error: "Pick someone from camp, or type an outside presenter's name.",
        },
        { status: 400 },
      );
    }
    const existing = await db
      .select({ id: offeringPresenter.id })
      .from(offeringPresenter)
      .where(eq(offeringPresenter.offeringId, row.id));
    const added = await addPresenter({
      campId: active.camp.id,
      offeringId: row.id,
      attendeeId,
      name,
      role: String(form.get("role") ?? "").trim() || null,
      sortOrder: existing.length,
    });
    return added
      ? data({ ok: "Added." })
      : data({ error: "Couldn't add that presenter." }, { status: 400 });
  }

  // Everything below is scheduling — officers only.
  if (!isOfficer) {
    return data({ error: "Officers build the schedule." }, { status: 403 });
  }

  if (intent === "addSession") {
    if (row.status !== "accepted") {
      return data(
        { error: "Accept it first, then give it a time." },
        { status: 409 },
      );
    }
    const date = String(form.get("date") ?? "");
    if (!isIsoDate(date)) {
      return data({ error: "Pick a date." }, { status: 400 });
    }
    const id = await addSession({
      ...scope,
      offeringId: row.id,
      date,
      startTime: cleanTime(form.get("startTime")),
      endTime: cleanTime(form.get("endTime")),
      location: String(form.get("location") ?? "").trim() || null,
    });
    return id
      ? data({ ok: "Scheduled." })
      : data({ error: "Couldn't schedule that." }, { status: 400 });
  }

  if (intent === "cancelSession" || intent === "uncancelSession") {
    await db
      .update(offeringSession)
      .set({
        status: intent === "cancelSession" ? "cancelled" : "scheduled",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(offeringSession.id, String(form.get("sessionId") ?? "")),
          eq(offeringSession.offeringId, row.id),
        ),
      );
    return data({
      ok: intent === "cancelSession" ? "Cancelled." : "Back on.",
    });
  }

  if (intent === "deleteSession") {
    await db
      .delete(offeringSession)
      .where(
        and(
          eq(offeringSession.id, String(form.get("sessionId") ?? "")),
          eq(offeringSession.offeringId, row.id),
        ),
      );
    return data({ ok: "Removed." });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function OfferingDetail({ loaderData }: Route.ComponentProps) {
  const {
    offering: o,
    sessions,
    presenters,
    party,
    locked,
    isOfficer,
    isMine,
  } = loaderData;
  const canEdit = isOfficer || (isMine && o.status === "proposed");
  const status = o.status as OfferingStatus;
  const today = todayIso();

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Group gap="xs" wrap="wrap">
            <Title order={2}>{o.title}</Title>
            <Badge color={offeringKindColor(o.kind)} variant="light">
              {offeringKindLabel(o.kind)}
            </Badge>
            <Badge
              color={OFFERING_STATUS_COLOR[status] ?? "gray"}
              variant="light"
            >
              {OFFERING_STATUS_LABEL[status] ?? o.status}
            </Badge>
            {o.audience === "camp_only" ? (
              <Badge color="gray" variant="outline">
                Camp only
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" c="dimmed">
            <Link to="/programming">← All programming</Link>
          </Text>
        </div>

        {o.description ? <Text>{o.description}</Text> : null}

        <Text size="sm" c="dimmed">
          {[
            durationLabel(o.durationMin),
            o.location,
            o.capacity ? `room for ~${o.capacity}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>

        {o.reviewNote ? (
          <Paper withBorder p="sm" radius="md">
            <Text size="sm" fw={600}>
              Note from the officers
            </Text>
            <Text size="sm">{o.reviewNote}</Text>
          </Paper>
        ) : null}

        {locked ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Text size="sm" c="dimmed">
              This year is locked — read-only.
            </Text>
          </Paper>
        ) : null}

        <PresenterSection
          presenters={presenters}
          party={party}
          canEdit={canEdit && !locked}
        />

        <SessionSection
          sessions={sessions}
          fallbackLocation={o.location}
          today={today}
          canEdit={isOfficer && !locked}
          accepted={o.status === "accepted"}
        />

        {canEdit && !locked ? <EditForm o={o} /> : null}
      </Stack>
    </Container>
  );
}

/** Toast the action result; every form on this page shares the shape. */
function useActionToast(data: { error?: string; ok?: string } | undefined) {
  useEffect(() => {
    if (data?.error) notifications.show({ color: "red", message: data.error });
    else if (data?.ok) notifications.show({ color: "green", message: data.ok });
  }, [data]);
}

function PresenterSection({
  presenters,
  party,
  canEdit,
}: {
  presenters: Route.ComponentProps["loaderData"]["presenters"];
  party: Route.ComponentProps["loaderData"]["party"];
  canEdit: boolean;
}) {
  const fetcher = useFetcher<{ error?: string; ok?: string }>();
  useActionToast(fetcher.data);

  return (
    <section>
      <Text size="sm" fw={600} mb="xs">
        Presenting
      </Text>
      <Stack gap="xs">
        {presenters.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nobody credited yet.
          </Text>
        ) : (
          presenters.map((p) => (
            <Card key={p.id} withBorder radius="md" p="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Text size="sm">{presenterName(p)}</Text>
                  {p.role ? (
                    <Badge size="sm" variant="light" color="gray">
                      {p.role}
                    </Badge>
                  ) : null}
                  {p.attendeeId == null ? (
                    <Badge size="sm" variant="outline" color="gray">
                      Not in camp
                    </Badge>
                  ) : null}
                </Group>
                {canEdit ? (
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="removePresenter"
                    />
                    <input type="hidden" name="presenterId" value={p.id} />
                    <Button
                      type="submit"
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                    >
                      Remove
                    </Button>
                  </fetcher.Form>
                ) : null}
              </Group>
            </Card>
          ))
        )}

        {canEdit ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="addPresenter" />
            <Group align="flex-end" gap="xs">
              <Select
                name="attendeeId"
                label="From camp"
                placeholder="Pick someone"
                data={party.map((p) => ({ value: p.id, label: p.name }))}
                searchable
                clearable
                style={{ flex: 1, minWidth: 160 }}
                size="xs"
              />
              <TextInput
                name="name"
                label="…or an outside presenter"
                description="Someone not camping with us"
                placeholder="Their name"
                size="xs"
                style={{ flex: 1, minWidth: 160 }}
              />
              <TextInput
                name="role"
                label="Role"
                placeholder="Co-presenter"
                size="xs"
                style={{ width: 130 }}
              />
              <Button
                type="submit"
                size="xs"
                loading={fetcher.state !== "idle"}
              >
                Add
              </Button>
            </Group>
          </fetcher.Form>
        ) : null}
      </Stack>
    </section>
  );
}

function SessionSection({
  sessions,
  fallbackLocation,
  today,
  canEdit,
  accepted,
}: {
  sessions: Route.ComponentProps["loaderData"]["sessions"];
  fallbackLocation: string | null;
  today: string;
  canEdit: boolean;
  accepted: boolean;
}) {
  const fetcher = useFetcher<{ error?: string; ok?: string }>();
  useActionToast(fetcher.data);

  return (
    <section>
      <Text size="sm" fw={600} mb="xs">
        When it happens
      </Text>
      <Stack gap="xs">
        {sessions.length === 0 ? (
          <Text size="sm" c="dimmed">
            {accepted
              ? "Not scheduled yet — it won't show publicly until it has a time."
              : "It'll get a time once it's accepted."}
          </Text>
        ) : (
          sessions.map((s) => {
            const cancelled = s.status === "cancelled";
            return (
              <Card key={s.id} withBorder radius="md" p="xs">
                <Group justify="space-between" wrap="nowrap">
                  <Text
                    size="sm"
                    c={cancelled ? "dimmed" : undefined}
                    td={cancelled ? "line-through" : undefined}
                  >
                    {dateLabel(s.date)}
                    {timeRangeLabel(s.startTime, s.endTime)
                      ? ` · ${timeRangeLabel(s.startTime, s.endTime)}`
                      : ""}
                    {(s.location ?? fallbackLocation)
                      ? ` · ${s.location ?? fallbackLocation}`
                      : ""}
                    {s.date < today ? " · past" : ""}
                  </Text>
                  {canEdit ? (
                    <Group gap={4} wrap="nowrap">
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value={
                            cancelled ? "uncancelSession" : "cancelSession"
                          }
                        />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <Button
                          type="submit"
                          size="compact-xs"
                          variant="subtle"
                        >
                          {cancelled ? "Restore" : "Cancel"}
                        </Button>
                      </fetcher.Form>
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="deleteSession"
                        />
                        <input type="hidden" name="sessionId" value={s.id} />
                        <Button
                          type="submit"
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                        >
                          Delete
                        </Button>
                      </fetcher.Form>
                    </Group>
                  ) : null}
                </Group>
              </Card>
            );
          })
        )}

        {canEdit && accepted ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="addSession" />
            <Group align="flex-end" gap="xs">
              <TextInput
                name="date"
                type="date"
                label="Date"
                required
                size="xs"
              />
              <TextInput name="startTime" type="time" label="Start" size="xs" />
              <TextInput name="endTime" type="time" label="End" size="xs" />
              <TextInput
                name="location"
                label="Where"
                placeholder={fallbackLocation ?? "Lecture hall"}
                size="xs"
                style={{ flex: 1, minWidth: 140 }}
              />
              <Button
                type="submit"
                size="xs"
                loading={fetcher.state !== "idle"}
              >
                Schedule
              </Button>
            </Group>
          </fetcher.Form>
        ) : null}
      </Stack>
    </section>
  );
}

function EditForm({
  o,
}: { o: Route.ComponentProps["loaderData"]["offering"] }) {
  const fetcher = useFetcher<{ error?: string; ok?: string }>();
  useActionToast(fetcher.data);

  return (
    <Paper withBorder radius="md" p="md">
      <Text fw={600} mb="sm">
        Edit
      </Text>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="update" />
        <Stack gap="sm">
          <TextInput
            name="title"
            label="Title"
            defaultValue={o.title}
            required
            maxLength={200}
          />
          <Textarea
            name="description"
            label="What is it?"
            defaultValue={o.description ?? ""}
            autosize
            minRows={2}
          />
          <Group grow align="flex-start">
            <Select
              name="kind"
              label="Kind"
              defaultValue={o.kind}
              data={OFFERING_KINDS.map((k) => ({
                value: k.value,
                label: k.label,
              }))}
              allowDeselect={false}
            />
            <Select
              name="durationMin"
              label="How long?"
              defaultValue={o.durationMin ? String(o.durationMin) : null}
              placeholder="Pick a length"
              data={DURATION_OPTIONS}
            />
          </Group>
          <Group grow align="flex-start">
            <Select
              name="audience"
              label="Who's it for?"
              defaultValue={o.audience}
              data={AUDIENCE_OPTIONS.map((a) => ({
                value: a.value,
                label: a.label,
              }))}
              allowDeselect={false}
            />
            <NumberInput
              name="capacity"
              label="How many can it fit?"
              defaultValue={o.capacity ?? undefined}
              placeholder="Optional"
              min={1}
            />
          </Group>
          <TextInput
            name="location"
            label="Where"
            defaultValue={o.location ?? ""}
            placeholder="Lecture hall"
            description="Sessions can override this."
          />
          <Group>
            <Button type="submit" loading={fetcher.state !== "idle"}>
              Save
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
    </Paper>
  );
}
