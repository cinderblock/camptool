import { Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import dayjs from "dayjs";
import { useFetcher } from "react-router";
import { announce } from "~/components/Announcer";
import { EventCalendar } from "~/components/EventCalendar";

/**
 * "Am I coming, and when?" — the shared trip controls.
 *
 * Rendered in two places: the `/trip` page (the datum's permanent home) and the
 * `/start` wizard (a guided first pass over the same thing). Both post to
 * `/trip`'s action, so there is exactly one write path — same pattern as the
 * wizard's Bringing and Checklist steps, which post to `/bringing` and
 * `/onboarding`.
 *
 * See `plans/wizard-step-homes.md`.
 */

export type ParticipationStatus = "unknown" | "coming" | "maybe" | "not_coming";

/** Everything these controls read. Assembled by `/trip` and by `/start`. */
export type TripData = {
  year: number;
  locked: boolean;
  status: ParticipationStatus;
  arrivalDate: string | null;
  departureDate: string | null;
  note: string | null;
  /** Bounds and gate-open day for the stay picker — `eventWindowFor(year)`. */
  arrivalWindow: { min: string; max: string; focus: string };
  /** The camper's Setup Access Pass, if they have one or asked for one. */
  myPass: { status: string; date: string | null } | null;
  /** False when the deployment/camp has no Setup Access Pass feature to offer. */
  passesVisible: boolean;
};

/** Every write goes to `/trip`, wherever these controls are rendered. */
const TRIP_ACTION = { method: "post", action: "/trip" } as const;

export function RsvpButtons({ trip }: { trip: TripData }) {
  const fetcher = useFetcher();
  const choices: {
    value: ParticipationStatus;
    label: string;
    color: string;
  }[] = [
    { value: "coming", label: "I'm coming", color: "green" },
    { value: "maybe", label: "Maybe", color: "yellow" },
    { value: "not_coming", label: "Not this year", color: "gray" },
  ];
  const setStatus = (status: ParticipationStatus, label: string) => {
    fetcher.submit({ intent: "rsvp", status }, TRIP_ACTION);
    // The reveal of the stay picker (and the save itself) is otherwise silent.
    announce(
      status === "coming" || status === "maybe"
        ? `${label} saved — pick your stay dates below.`
        : `${label} saved.`,
    );
  };
  return (
    <Stack gap="xs" maw={460}>
      <Text size="sm" fw={600}>
        Are you camping with us for {trip.year}?
      </Text>
      <Text size="sm" c="dimmed">
        This helps us plan tickets and space — you can change it anytime.
      </Text>
      <Group gap="xs">
        {choices.map((c) => (
          <Button
            key={c.value}
            variant={trip.status === c.value ? "filled" : "default"}
            color={c.color}
            aria-pressed={trip.status === c.value}
            disabled={trip.locked}
            onClick={() => setStatus(c.value, c.label)}
          >
            {c.label}
          </Button>
        ))}
      </Group>
    </Stack>
  );
}

/** Booking-style stay ask (tap arrival day, tap last day) + the Setup Access
 * Pass prompt: arriving before gate-open needs a pass, which the camper can
 * auto-request right here (an officer picks the pass's "on or after" date on
 * /passes). */
export function StayPicker({ trip }: { trip: TripData }) {
  const fetcher = useFetcher();
  const arrival = trip.arrivalDate;
  const departure = trip.departureDate;
  const gateOpen = trip.arrivalWindow.focus;
  const gateOpenFmt = dayjs(gateOpen).format("dddd, MMM D");
  const arrivingEarly = arrival != null && arrival < gateOpen;
  const fmt = (day: string) => dayjs(day).format("ddd, MMM D");
  const nights =
    arrival && departure ? dayjs(departure).diff(dayjs(arrival), "day") : null;
  const saveStay = (range: {
    arrival: string | null;
    departure: string | null;
  }) =>
    fetcher.submit(
      {
        intent: "rsvp",
        status: trip.status,
        arrivalDate: range.arrival ?? "",
        departureDate: range.departure ?? "",
      },
      TRIP_ACTION,
    );
  return (
    <Stack gap="xs" maw={460}>
      <div>
        <Text size="sm" fw={600}>
          When will you be there?
        </Text>
        <Text size="xs" c="dimmed">
          Tap the day you'll arrive, then the day you'll head home. Gates open{" "}
          {gateOpenFmt}.
        </Text>
      </div>
      <EventCalendar
        year={trip.year}
        mode="range"
        range={{ arrival, departure }}
        onRangeChange={saveStay}
        disabled={trip.locked}
      />
      <Text size="sm" c={arrival && departure ? undefined : "dimmed"}>
        {arrival && departure
          ? `${fmt(arrival)} → ${fmt(departure)} · ${nights} ${nights === 1 ? "night" : "nights"}`
          : arrival
            ? `Arriving ${fmt(arrival)} — now tap your last day.`
            : "No stay picked yet."}
      </Text>
      {arrivingEarly && trip.passesVisible ? (
        <Paper withBorder p="sm" radius="md">
          {trip.myPass?.status === "granted" ? (
            <Stack gap={4}>
              <Text size="sm" c="green">
                ✓ You have a Setup Access Pass
                {trip.myPass.date
                  ? ` — it admits you on or after ${dayjs(trip.myPass.date).format("ddd, MMM D")}`
                  : ""}
                .
              </Text>
              {trip.myPass.date && arrival && trip.myPass.date > arrival ? (
                <Text size="sm" c="orange">
                  Heads up: that's after your planned arrival — talk to an
                  officer about an earlier pass.
                </Text>
              ) : null}
            </Stack>
          ) : trip.myPass ? (
            <Text size="sm" c="dimmed">
              ✓ Setup Access Pass requested — an officer will assign you one
              that covers your arrival.
            </Text>
          ) : (
            <Stack gap="xs">
              <Text size="sm">
                Arriving before gates open requires a Setup Access Pass. Want us
                to request one for you?
              </Text>
              <Group>
                <Button
                  size="xs"
                  disabled={trip.locked}
                  loading={fetcher.state !== "idle"}
                  onClick={() =>
                    fetcher.submit({ intent: "requestSetupPass" }, TRIP_ACTION)
                  }
                >
                  Yes, request a pass
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      ) : null}
    </Stack>
  );
}

/**
 * The free-text "anything else?".
 *
 * It carries an explicit **Nothing else to add** button because there is nothing
 * to derive from an empty box: without it the to-do would be unclearable for the
 * (common) camper who has nothing to say, which is the resolution-vs-satisfaction
 * trap `plans/outstanding-asks.md` exists to avoid. Writing a note settles it too.
 */
export function TripNote({
  trip,
  settled,
}: {
  trip: TripData;
  settled: boolean;
}) {
  const fetcher = useFetcher();
  return (
    <Stack gap="xs" maw={520}>
      <Textarea
        label="Anything to add?"
        description="Anything else we should know — arriving late, bringing a friend, a question for us…"
        autosize
        minRows={2}
        disabled={trip.locked}
        defaultValue={trip.note ?? ""}
        onBlur={(e) =>
          fetcher.submit(
            {
              intent: "rsvp",
              status: trip.status,
              note: e.currentTarget.value,
            },
            TRIP_ACTION,
          )
        }
      />
      {!settled && !trip.locked ? (
        <Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() =>
              fetcher.submit({ intent: "nothingToAdd" }, TRIP_ACTION)
            }
          >
            Nothing else to add
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}
