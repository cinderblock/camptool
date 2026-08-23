import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { EventCalendar } from "~/components/EventCalendar";
import type { EventRange } from "~/lib/questions";

/**
 * "When are you here?" as a form field — the event calendar, never a browser
 * date box.
 *
 * A native `<input type="date">` is the wrong tool for an arrival date at an
 * event. It offers a whole decade, defaults to the wrong month, renders
 * differently on every platform, and gives no hint that the useful answers all
 * sit inside one week. `EventCalendar` shows exactly the span around the event,
 * marks the named days (gates open, the burns, exodus), and makes "the Tuesday
 * of build week" a tap rather than a date-arithmetic problem. Arrival and
 * departure are also one decision, not two — picking them on one calendar is
 * what makes the second tap obvious.
 *
 * Collapsed to a button by default so it fits in a row of inputs; the calendar
 * opens in a modal. Pass `names` to emit hidden inputs and work inside a plain
 * form; otherwise drive it with `value`/`onChange`.
 */
export function StayRangeField({
  year,
  value,
  onChange,
  names,
  label = "Dates",
  disabled,
  w,
}: {
  year: number;
  value: EventRange;
  onChange: (range: EventRange) => void;
  /** Field names for the hidden inputs, when used inside a native form. */
  names?: { arrival: string; departure: string };
  label?: string;
  disabled?: boolean;
  w?: React.CSSProperties["width"];
}) {
  const [open, setOpen] = useState(false);
  const summary = describe(value);

  return (
    <div style={{ width: w }}>
      {names ? (
        <>
          <input
            type="hidden"
            name={names.arrival}
            value={value.arrival ?? ""}
          />
          <input
            type="hidden"
            name={names.departure}
            value={value.departure ?? ""}
          />
        </>
      ) : null}

      <Text size="sm" fw={500} mb={2}>
        {label}
      </Text>
      <Button
        variant="default"
        disabled={disabled}
        onClick={() => setOpen(true)}
        fullWidth
        justify="space-between"
        // A dimmed label when nothing is picked reads as placeholder text
        // rather than as a value, which is what it is.
        c={value.arrival ? undefined : "dimmed"}
        fw={value.arrival ? 500 : 400}
      >
        {summary}
      </Button>

      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title="When are they here?"
        size="auto"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Tap the day they arrive, then the day they head home.
          </Text>
          <EventCalendar
            year={year}
            mode="range"
            range={value}
            onRangeChange={onChange}
            disabled={disabled}
          />
          <Group justify="space-between">
            <Button
              variant="subtle"
              color="red"
              disabled={!value.arrival && !value.departure}
              onClick={() => onChange({ arrival: null, departure: null })}
            >
              Clear
            </Button>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

/** "Mon, Aug 24 → Sat, Aug 29", or the half-picked state, or a prompt. */
export function describe(range: EventRange): string {
  const { arrival, departure } = range;
  if (!arrival && !departure) return "Pick dates";
  if (arrival && !departure) return `${day(arrival)} → pick a last day`;
  if (!arrival && departure) return `pick an arrival → ${day(departure)}`;
  return `${day(arrival as string)} → ${day(departure as string)}`;
}

/** UTC-anchored so the weekday can't shift across timezones — same reasoning as
 * `dayChip` in `app/lib/arrival.ts`. */
function day(iso: string): string {
  const [y = 0, m = 1, d = 1] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${days[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
