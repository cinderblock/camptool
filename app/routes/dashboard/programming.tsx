/**
 * Programming — what the camp offers the event this year. Campers propose
 * talks/workshops; officers accept or decline, then schedule accepted ones
 * (scheduling is what publishes them). Gated by the `programming` camp
 * feature. Design: plans/programming-offerings.md.
 */
import {
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
import { and, eq } from "drizzle-orm";
import { useEffect } from "react";
import { Link, data, redirect, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import {
  AUDIENCE_OPTIONS,
  DURATION_OPTIONS,
  OFFERING_KINDS,
  OFFERING_STATUS_COLOR,
  OFFERING_STATUS_LABEL,
  type OfferingStatus,
  audienceLabel,
  durationLabel,
  isOfferingAudience,
  isOfferingKind,
  offeringKindColor,
  offeringKindLabel,
  presenterName,
} from "~/lib/programming";
import { createOffering, loadOfferings } from "~/lib/programming.server";
import { dateLabel, timeRangeLabel, todayIso } from "~/lib/schedule";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { offering } from "../../../db/schema";
import type { Route } from "./+types/programming";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Programming · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  const state = await requireFeature(active, "programming");
  return {
    year: activeEdition.year,
    locked: activeEdition.locked,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    canPropose: hasAtLeast(active.membership.role, "member"),
    myMembershipId: active.membership.id,
    campSlug: active.camp.slug,
    // The public page only exists while the feature is fully on — don't link
    // officers to a URL that would 404 for them during preview.
    publicLive: state === "on",
    offerings: await loadOfferings(activeEdition.id),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "programming");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const role = active.membership.role;
  const isOfficer = hasAtLeast(role, "officer");

  if (intent === "propose") {
    if (!hasAtLeast(role, "member")) {
      return data(
        { error: "Only camp members can propose something." },
        { status: 403 },
      );
    }
    const title = String(form.get("title") ?? "").trim();
    if (!title || title.length > 200) {
      return data({ error: "Please give it a title." }, { status: 400 });
    }
    const kind = String(form.get("kind") ?? "lecture");
    if (!isOfferingKind(kind)) {
      return data({ error: "Unknown kind." }, { status: 400 });
    }
    const audience = String(form.get("audience") ?? "public");
    if (!isOfferingAudience(audience)) {
      return data({ error: "Unknown audience." }, { status: 400 });
    }
    const durationRaw = Number(form.get("durationMin"));
    const capacityRaw = Number(form.get("capacity"));
    const id = await createOffering({
      campId: active.camp.id,
      editionId: activeEdition.id,
      proposedByMembershipId: active.membership.id,
      title,
      description: String(form.get("description") ?? "").trim() || null,
      kind,
      durationMin:
        Number.isInteger(durationRaw) && durationRaw > 0 ? durationRaw : null,
      audience,
      capacity:
        Number.isInteger(capacityRaw) && capacityRaw > 0 ? capacityRaw : null,
    });
    return redirect(`/programming/${id}`);
  }

  // Everything below acts on an existing offering — load it camp-scoped first
  // so an id from another camp can't be touched.
  const offeringId = String(form.get("offeringId") ?? "");
  const [row] = await db
    .select()
    .from(offering)
    .where(
      and(
        eq(offering.id, offeringId),
        eq(offering.editionId, activeEdition.id),
      ),
    )
    .limit(1);
  if (!row) return data({ error: "Not found." }, { status: 404 });

  if (intent === "withdraw") {
    // The proposer can pull their own back while it's still awaiting review;
    // officers can withdraw anything (e.g. a presenter who dropped out).
    const mine = row.proposedByMembershipId === active.membership.id;
    if (!mine && !isOfficer) {
      return data({ error: "That's not yours." }, { status: 403 });
    }
    if (!isOfficer && row.status !== "proposed") {
      return data(
        { error: "It's already been reviewed — talk to an officer." },
        { status: 409 },
      );
    }
    await db
      .update(offering)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(eq(offering.id, offeringId));
    return data({ ok: "Withdrawn." });
  }

  if (intent !== "accept" && intent !== "decline") {
    return data({ error: "Unknown action." }, { status: 400 });
  }
  if (!isOfficer) {
    return data({ error: "Officers review proposals." }, { status: 403 });
  }
  await db
    .update(offering)
    .set({
      status: intent === "accept" ? "accepted" : "declined",
      reviewedByMembershipId: active.membership.id,
      reviewedAt: new Date(),
      reviewNote: String(form.get("reviewNote") ?? "").trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(offering.id, offeringId));
  return data({
    ok: intent === "accept" ? "Accepted — now give it a time." : "Declined.",
  });
}

type Offering = Route.ComponentProps["loaderData"]["offerings"][number];

export default function Programming({ loaderData }: Route.ComponentProps) {
  const {
    year,
    locked,
    isOfficer,
    canPropose,
    myMembershipId,
    campSlug,
    publicLive,
    offerings,
  } = loaderData;

  const pending = offerings.filter((o) => o.status === "proposed");
  const scheduled = offerings
    .filter((o) => o.status === "accepted" && o.sessions.length > 0)
    .sort((a, b) => (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999"));
  const needTimes = offerings.filter(
    (o) => o.status === "accepted" && o.sessions.length === 0,
  );
  const mine = offerings.filter(
    (o) => o.proposedByMembershipId === myMembershipId,
  );

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Programming</Title>
          <Text c="dimmed" size="sm">
            What our camp is offering the event in {year}.
            {publicLive ? (
              <>
                {" "}
                The lineup is public at{" "}
                <Anchor component={Link} to={`/c/${campSlug}/schedule`}>
                  /c/{campSlug}/schedule
                </Anchor>
                .
              </>
            ) : null}{" "}
            <Anchor component={Link} to="/programming/board">
              Print a day sheet
            </Anchor>{" "}
            for the sandwich board or the lecture hall.
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
              This year is locked — programming is read-only.
            </Text>
          </Paper>
        ) : null}

        {canPropose && !locked ? <ProposeForm /> : null}

        {isOfficer && pending.length > 0 ? (
          <section>
            <Text size="sm" fw={600} mb="xs">
              Awaiting review · {pending.length}
            </Text>
            <Stack gap="xs">
              {pending.map((o) => (
                <ReviewCard key={o.id} o={o} locked={locked} />
              ))}
            </Stack>
          </section>
        ) : null}

        {isOfficer && needTimes.length > 0 ? (
          <section>
            <Text size="sm" fw={600} mb="xs">
              Accepted, still need a time · {needTimes.length}
            </Text>
            <Stack gap="xs">
              {needTimes.map((o) => (
                <OfferingCard key={o.id} o={o} />
              ))}
            </Stack>
          </section>
        ) : null}

        <section>
          <Text size="sm" fw={600} mb="xs">
            The lineup
          </Text>
          {scheduled.length === 0 ? (
            <Text c="dimmed" size="sm">
              Nothing scheduled yet
              {canPropose && !locked
                ? " — propose the first thing above."
                : "."}
            </Text>
          ) : (
            <Stack gap="xs">
              {scheduled.map((o) => (
                <OfferingCard key={o.id} o={o} showSessions />
              ))}
            </Stack>
          )}
        </section>

        {mine.length > 0 ? (
          <section>
            <Text size="sm" fw={600} mb="xs">
              Your proposals
            </Text>
            <Stack gap="xs">
              {mine.map((o) => (
                <OfferingCard key={o.id} o={o} showStatus />
              ))}
            </Stack>
          </section>
        ) : null}
      </Stack>
    </Container>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = status as OfferingStatus;
  return (
    <Badge size="sm" color={OFFERING_STATUS_COLOR[s] ?? "gray"} variant="light">
      {OFFERING_STATUS_LABEL[s] ?? status}
    </Badge>
  );
}

function Presenters({ o }: { o: Offering }) {
  if (o.presenters.length === 0) return null;
  return (
    <Text size="sm" c="dimmed">
      {o.presenters.map((p) => presenterName(p)).join(", ")}
    </Text>
  );
}

function OfferingCard({
  o,
  showSessions,
  showStatus,
}: {
  o: Offering;
  showSessions?: boolean;
  showStatus?: boolean;
}) {
  const today = todayIso();
  return (
    <Card
      withBorder
      radius="md"
      p="sm"
      component={Link}
      to={`/programming/${o.id}`}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Text fw={600}>{o.title}</Text>
            <Badge size="sm" color={offeringKindColor(o.kind)} variant="light">
              {offeringKindLabel(o.kind)}
            </Badge>
            {o.audience === "camp_only" ? (
              <Badge size="sm" color="gray" variant="outline">
                Camp only
              </Badge>
            ) : null}
            {showStatus ? <StatusBadge status={o.status} /> : null}
          </Group>
          <Presenters o={o} />
          {showSessions ? (
            <Stack gap={2} mt={4}>
              {o.sessions.map((s) => (
                <Text
                  key={s.id}
                  size="sm"
                  c={s.status === "cancelled" ? "dimmed" : undefined}
                  td={s.status === "cancelled" ? "line-through" : undefined}
                >
                  {dateLabel(s.date)}
                  {timeRangeLabel(s.startTime, s.endTime)
                    ? ` · ${timeRangeLabel(s.startTime, s.endTime)}`
                    : ""}
                  {(s.location ?? o.location)
                    ? ` · ${s.location ?? o.location}`
                    : ""}
                  {s.date < today ? " · past" : ""}
                </Text>
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {[durationLabel(o.durationMin), o.location]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
        </div>
      </Group>
    </Card>
  );
}

/** Officer review: the proposal in full, with Accept / Decline. */
function ReviewCard({ o, locked }: { o: Offering; locked: boolean }) {
  const fetcher = useFetcher<{ error?: string; ok?: string }>();
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    } else if (fetcher.data?.ok) {
      notifications.show({ color: "green", message: fetcher.data.ok });
    }
  }, [fetcher.data]);

  return (
    <Card withBorder radius="md" p="sm">
      <Stack gap="xs">
        <Group gap="xs" wrap="wrap">
          <Anchor component={Link} to={`/programming/${o.id}`} fw={600}>
            {o.title}
          </Anchor>
          <Badge size="sm" color={offeringKindColor(o.kind)} variant="light">
            {offeringKindLabel(o.kind)}
          </Badge>
          <Badge size="sm" color="gray" variant="outline">
            {audienceLabel(o.audience)}
          </Badge>
        </Group>
        {o.description ? <Text size="sm">{o.description}</Text> : null}
        <Text size="sm" c="dimmed">
          {[
            durationLabel(o.durationMin),
            o.capacity ? `room for ~${o.capacity}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "No duration given"}
        </Text>
        <Presenters o={o} />
        {!locked ? (
          <fetcher.Form method="post">
            <input type="hidden" name="offeringId" value={o.id} />
            <Group gap="xs" align="flex-end">
              <TextInput
                name="reviewNote"
                label="Note to the proposer"
                placeholder="Optional"
                size="xs"
                style={{ flex: 1 }}
              />
              <Button
                type="submit"
                name="intent"
                value="accept"
                size="xs"
                loading={fetcher.state !== "idle"}
              >
                Accept
              </Button>
              <Button
                type="submit"
                name="intent"
                value="decline"
                size="xs"
                variant="light"
                color="red"
                loading={fetcher.state !== "idle"}
              >
                Decline
              </Button>
            </Group>
          </fetcher.Form>
        ) : null}
      </Stack>
    </Card>
  );
}

function ProposeForm() {
  const [opened, { toggle }] = useDisclosure(false);
  const fetcher = useFetcher<{ error?: string }>();
  useEffect(() => {
    if (fetcher.data?.error) {
      notifications.show({ color: "red", message: fetcher.data.error });
    }
  }, [fetcher.data]);

  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between">
        <div>
          <Text fw={600}>Propose something</Text>
          <Text size="sm" c="dimmed">
            Got a talk or a workshop in you? Pitch it — officers build the
            schedule from what comes in.
          </Text>
        </div>
        <Button variant="light" size="xs" onClick={toggle}>
          {opened ? "Cancel" : "Propose"}
        </Button>
      </Group>
      <Collapse in={opened}>
        <fetcher.Form
          method="post"
          style={{ marginTop: "var(--mantine-spacing-md)" }}
        >
          <input type="hidden" name="intent" value="propose" />
          <Stack gap="sm">
            <TextInput
              name="title"
              label="Title"
              placeholder="A Brief History of Infinity"
              required
              maxLength={200}
            />
            <Textarea
              name="description"
              label="What is it?"
              description="This is the blurb people read to decide whether to come."
              autosize
              minRows={2}
            />
            <Group grow align="flex-start">
              <Select
                name="kind"
                label="Kind"
                defaultValue="lecture"
                data={OFFERING_KINDS.map((k) => ({
                  value: k.value,
                  label: k.label,
                }))}
                allowDeselect={false}
              />
              <Select
                name="durationMin"
                label="How long?"
                placeholder="Pick a length"
                data={DURATION_OPTIONS}
              />
            </Group>
            <Group grow align="flex-start">
              <Select
                name="audience"
                label="Who's it for?"
                defaultValue="public"
                data={AUDIENCE_OPTIONS.map((a) => ({
                  value: a.value,
                  label: a.label,
                }))}
                allowDeselect={false}
                description="Open to the event means it's listed on our public page."
              />
              <NumberInput
                name="capacity"
                label="How many can it fit?"
                placeholder="Optional"
                description="A rough number — nobody reserves a spot."
                min={1}
              />
            </Group>
            <Group>
              <Button type="submit" loading={fetcher.state !== "idle"}>
                Submit proposal
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Collapse>
    </Paper>
  );
}
