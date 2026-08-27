import {
  Button,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@mantine/core";
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
  /** The "requesting a Setup Access Pass" control's state — `loadMySapState`
   * plus whether this camp runs passes at all. */
  sap: {
    /** False when the deployment/camp has no Setup Access Pass feature. */
    visible: boolean;
    requesting: boolean;
    fixedReason: string | null;
    onOrAfterDate: string | null;
    held: "assigned" | "released" | null;
    denied: boolean;
  };
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
 * Pass switch below it. */
export function StayPicker({ trip }: { trip: TripData }) {
  const fetcher = useFetcher();
  const arrival = trip.arrivalDate;
  const departure = trip.departureDate;
  const gateOpen = trip.arrivalWindow.focus;
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
          {longDay(gateOpen)}.
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
      <SetupPassSwitch trip={trip} />
    </Stack>
  );
}

/**
 * "I'm requesting a Setup Access Pass" — a standing answer, not a one-time
 * button.
 *
 * It is **always here** while the camp runs passes, rather than appearing only
 * when the arrival happens to be early. The old prompt could only ever be
 * answered *yes*, and only from one screen state: pick a later date and the
 * question vanished along with any way to change your mind.
 *
 * The tick is not a client-side default. Saving an early arrival creates the
 * request server-side, so the box being ticked and the officers' queue knowing
 * about you are the same fact rather than two that can disagree. Turning it off
 * records an explicit decline, which is what stops the next date edit quietly
 * asking again.
 *
 * Once a pass is genuinely set aside the switch goes read-only: unticking would
 * be either a lie or a silent hand-back of a scarce, possibly already-sent
 * secret, so that goes through an officer.
 */
function SetupPassSwitch({ trip }: { trip: TripData }) {
  const fetcher = useFetcher();
  const { sap } = trip;
  if (!sap.visible) return null;

  const gateOpen = trip.arrivalWindow.focus;
  const arrival = trip.arrivalDate;
  const arrivingEarly = arrival != null && arrival < gateOpen;
  const fmt = (day: string) => dayjs(day).format("ddd, MMM D");
  // Optimistic, so the switch moves under the finger rather than after a round
  // trip — the fetcher carries the intent it's mid-flight with.
  const pending = fetcher.formData?.get("intent");
  const checked = pending ? pending === "requestSetupPass" : sap.requesting;

  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap={6}>
        <Switch
          checked={checked}
          disabled={trip.locked || sap.fixedReason !== null}
          label="I'm requesting a Setup Access Pass"
          description={
            arrivingEarly
              ? `You're arriving ${fmt(arrival)}, before gates open — you need one.`
              : `Only needed to get in before gates open on ${fmt(gateOpen)}.`
          }
          onChange={(e) =>
            fetcher.submit(
              {
                intent: e.currentTarget.checked
                  ? "requestSetupPass"
                  : "declineSetupPass",
              },
              TRIP_ACTION,
            )
          }
        />
        {sap.fixedReason ? (
          <Text size="sm" c={sap.held === "released" ? "green" : undefined}>
            {sap.held === "released" ? "✓ " : ""}
            {sap.fixedReason}
            {sap.onOrAfterDate
              ? ` It admits you on or after ${fmt(sap.onOrAfterDate)}.`
              : ""}
          </Text>
        ) : checked ? (
          <Text size="sm" c="dimmed">
            An officer will set one aside that covers your arrival.
          </Text>
        ) : null}
        {sap.onOrAfterDate && arrival && sap.onOrAfterDate > arrival ? (
          <Text size="sm" c="orange">
            Heads up: that's after your planned arrival — talk to an officer
            about an earlier pass.
          </Text>
        ) : null}
        {!checked && arrivingEarly && !sap.fixedReason ? (
          <Text size="sm" c="orange">
            Without one you won't be let in until gates open on{" "}
            {longDay(gateOpen)}.
          </Text>
        ) : null}
        {checked && !arrivingEarly && !sap.fixedReason ? (
          <Text size="sm" c="dimmed">
            Your arrival is after gates open, so you probably don't need one —
            passes are scarce, so switch this off if you don't.
          </Text>
        ) : null}
        {sap.denied ? (
          <Text size="sm" c="dimmed">
            An earlier request was declined by an officer.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );
}

/** "Sunday, Aug 30" — the long form, for the one day everybody has to know. */
const longDay = (day: string) => dayjs(day).format("dddd, MMM D");

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
