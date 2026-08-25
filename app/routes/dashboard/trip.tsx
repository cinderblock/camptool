import {
  Anchor,
  Card,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, eq } from "drizzle-orm";
import { Link, data } from "react-router";
import {
  type ParticipationStatus,
  RsvpButtons,
  StayPicker,
  type TripData,
  TripNote,
} from "~/components/TripPlanner";
import { ensureMemberAttendee } from "~/lib/attendee.server";
import { eventWindowFor } from "~/lib/brc";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState } from "~/lib/features.server";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { resolveAsk, setParticipation } from "~/lib/wizard.server";
import { db } from "../../../db/client.server";
import {
  attendee,
  setupPass,
  setupPassDate,
  wizardAsk,
} from "../../../db/schema";
import type { Route } from "./+types/trip";

/**
 * "Your trip" — the permanent home for whether you're coming, when you arrive
 * and leave, and anything else you want to tell the camp.
 *
 * This page owns those writes. `/start` is a wizard over the same data and posts
 * its RSVP / stay / pass intents *here*, so there is one write path rather than
 * two that can drift (`plans/wizard-step-homes.md`).
 *
 * Deliberately NOT feature-gated: the `rsvp` and `stay_dates` asks are core, and
 * an ask must never link somewhere the camper gets bounced off.
 */
export function meta(_: Route.MetaArgs) {
  return [{ title: "Your trip · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  const mid = active.membership.id;

  const [me] = await db
    .select({
      status: attendee.status,
      arrivalDate: attendee.arrivalDate,
      departureDate: attendee.departureDate,
      note: attendee.note,
    })
    .from(attendee)
    .where(
      and(
        eq(attendee.editionId, activeEdition.id),
        eq(attendee.membershipId, mid),
      ),
    )
    .limit(1);

  // Their Setup Access Pass, if any — a denied row is not one.
  const passRows = await db
    .select({ status: setupPass.status, date: setupPassDate.date })
    .from(setupPass)
    .leftJoin(setupPassDate, eq(setupPass.passDateId, setupPassDate.id))
    .innerJoin(attendee, eq(setupPass.attendeeId, attendee.id))
    .where(
      and(
        eq(setupPass.editionId, activeEdition.id),
        eq(attendee.membershipId, mid),
      ),
    );

  // The early-arrival prompt offers a Setup Access Pass, so only show it when
  // this camp actually runs passes — otherwise it points at nothing.
  const passesVisible = featureVisibleTo(
    await getFeatureState(active.camp.id, "passes"),
    active.membership.role,
  );

  // Has this camper already said "nothing else to add"? Same acknowledgement
  // row the wizard writes — the note ask has nothing else to derive from.
  const [ack] = await db
    .select({ status: wizardAsk.status })
    .from(wizardAsk)
    .where(
      and(
        eq(wizardAsk.editionId, activeEdition.id),
        eq(wizardAsk.membershipId, mid),
        eq(wizardAsk.askKey, "extras"),
      ),
    )
    .limit(1);

  return redact(privacy, {
    trip: {
      year: activeEdition.year,
      locked: activeEdition.locked,
      status: (me?.status as ParticipationStatus) ?? "unknown",
      arrivalDate: me?.arrivalDate ?? null,
      departureDate: me?.departureDate ?? null,
      note: me?.note ?? null,
      arrivalWindow: eventWindowFor(activeEdition.year),
      myPass: passRows.find((p) => p.status !== "denied") ?? null,
      passesVisible,
    } satisfies TripData,
    campName: active.camp.name,
    noteAcknowledged: ack?.status === "done",
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  // Everything here writes edition-scoped data, so a locked year is read-only.
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  if (intent === "rsvp") {
    const status = String(form.get("status")) as ParticipationStatus;
    if (!["unknown", "coming", "maybe", "not_coming"].includes(status)) {
      return data({ error: "Bad status." }, { status: 400 });
    }
    const noteRaw = form.get("note");
    // Absent field = leave unchanged; empty string = clear; else YYYY-MM-DD.
    const readDay = (key: string): string | null | undefined => {
      const raw = form.get(key);
      if (raw == null) return undefined;
      return String(raw) || null;
    };
    const arrivalDate = readDay("arrivalDate");
    const departureDate = readDay("departureDate");
    for (const day of [arrivalDate, departureDate]) {
      if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return data({ error: "Bad date." }, { status: 400 });
      }
    }
    if (arrivalDate && departureDate && departureDate < arrivalDate) {
      return data(
        { error: "Departure can't be before arrival." },
        { status: 400 },
      );
    }
    await setParticipation({
      campId,
      editionId,
      membershipId: mid,
      status,
      arrivalDate,
      departureDate,
      note: noteRaw == null ? undefined : String(noteRaw) || null,
    });
    return data({ ok: true });
  }

  // Auto-request a Setup Access Pass (unbound — an officer assigns the
  // "on or after" date on /passes) when the camper is arriving pre-event.
  if (intent === "requestSetupPass") {
    const myAttendeeId = await ensureMemberAttendee(campId, editionId, mid);
    const existing = await db
      .select({ id: setupPass.id, status: setupPass.status })
      .from(setupPass)
      .where(
        and(
          eq(setupPass.editionId, editionId),
          eq(setupPass.attendeeId, myAttendeeId),
        ),
      );
    if (existing.some((p) => p.status !== "denied")) {
      return data({ ok: true }); // already requested/granted — idempotent
    }
    await db.insert(setupPass).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      attendeeId: myAttendeeId,
      status: "requested",
      note: "Requested during onboarding (arriving before gates open).",
      createdById: user.id,
    });
    return data({ ok: true });
  }

  // "Nothing else to add" — the only way to settle an ask with nothing to
  // derive. Recorded as the same acknowledgement the wizard writes.
  if (intent === "nothingToAdd") {
    await resolveAsk({
      campId,
      editionId,
      membershipId: mid,
      askKey: "extras",
      status: "done",
    });
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Trip({ loaderData }: Route.ComponentProps) {
  const { trip, campName, noteAcknowledged } = loaderData;
  const noteSettled = noteAcknowledged || (trip.note ?? "").trim().length > 0;

  return (
    <Container size="sm">
      <Stack gap="lg">
        <div>
          <Title order={2}>Your trip · {trip.year}</Title>
          <Text c="dimmed" size="sm">
            Whether you're coming to {campName} this year, when you'll be there,
            and anything else we should know. Change it whenever your plans do.
          </Text>
        </div>

        {trip.locked ? (
          <Card withBorder padding="md" bg="var(--mantine-color-default-hover)">
            <Text size="sm" c="dimmed">
              This year is locked — your trip is read-only. Switch to an open
              year to make changes.
            </Text>
          </Card>
        ) : null}

        <Card withBorder padding="lg" radius="md">
          <RsvpButtons trip={trip} />
        </Card>

        {trip.status === "coming" || trip.status === "maybe" ? (
          <Card withBorder padding="lg" radius="md">
            <StayPicker trip={trip} />
          </Card>
        ) : null}

        <Card withBorder padding="lg" radius="md">
          <TripNote trip={trip} settled={noteSettled} />
        </Card>

        <Group gap="lg">
          <Anchor component={Link} to="/bringing" size="sm">
            What you're bringing
          </Anchor>
          <Anchor component={Link} to="/questions" size="sm">
            The camp's questions
          </Anchor>
          <Anchor component={Link} to="/account" size="sm">
            Your name and account
          </Anchor>
        </Group>
      </Stack>
    </Container>
  );
}
