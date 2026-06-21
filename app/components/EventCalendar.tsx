import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { eventDayLabels, eventStartFor, eventWindowFor } from "~/lib/brc";
import type { EventRange } from "~/lib/questions";

/**
 * A single, consistent calendar centered on the event — the shared primitive for
 * picking event-relative dates (and, later, for showing camp events on top).
 *
 * It is intentionally NOT a navigable month calendar: there are no prev/next
 * arrows. It renders the fixed span of whole weeks around the event window
 * (`eventWindowFor`), highlights the event days, calls out the named days (gates
 * open, Man burn, Temple burn, exodus), and lets the user tap days to set a value.
 *
 * Two modes:
 *  - `single` (default): tap one day. Driven by `value` / `onChange`.
 *  - `range`: tap an arrival day, then a departure day — for "when do you arrive
 *    and leave?". Driven by `range` / `onRangeChange`.
 */
export function EventCalendar({
  year,
  value,
  onChange,
  mode = "single",
  range,
  onRangeChange,
  disabled,
}: {
  year: number;
  /** single mode: selected day as `YYYY-MM-DD`, or null. */
  value?: string | null;
  onChange?: (value: string | null) => void;
  mode?: "single" | "range";
  /** range mode: the arrival/departure pair. */
  range?: EventRange;
  onRangeChange?: (range: EventRange) => void;
  disabled?: boolean;
}) {
  const start = eventStartFor(year); // Sunday gates open
  // The core event runs gates-open Sunday through Labor Day Monday (+8 days).
  const eventEnd = addDays(start, 8);
  const win = eventWindowFor(year);
  const min = parseYmd(win.min);
  const max = parseYmd(win.max);
  const named = new Map(eventDayLabels(year).map((d) => [d.date, d.short]));

  // Pad out to whole Sun–Sat weeks so the grid columns line up.
  const gridStart = addDays(min, -min.getDay());
  const gridEnd = addDays(max, 6 - max.getDay());

  const weeks: Date[][] = [];
  let cur = gridStart;
  while (cur <= gridEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cur);
      cur = addDays(cur, 1);
    }
    weeks.push(week);
  }

  const inWindow = (d: Date) => d >= min && d <= max;
  const inEvent = (d: Date) => d >= start && d <= eventEnd;

  const arrival = range?.arrival ?? null;
  const departure = range?.departure ?? null;

  // Tapping in range mode: first tap (or a tap with both already set) starts a new
  // arrival; a tap before the arrival restarts; tapping the arrival again clears it.
  const tapRange = (ymd: string) => {
    if (!onRangeChange) return;
    if (!arrival || (arrival && departure)) {
      onRangeChange({ arrival: ymd, departure: null });
    } else if (ymd < arrival) {
      onRangeChange({ arrival: ymd, departure: null });
    } else if (ymd === arrival) {
      onRangeChange({ arrival: null, departure: null });
    } else {
      onRangeChange({ arrival, departure: ymd });
    }
  };

  return (
    <Box maw={320}>
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 2,
        }}
      >
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed weekday header
            key={i}
            ta="center"
            size="xs"
            c="dimmed"
            fw={600}
            pb={2}
          >
            {d}
          </Text>
        ))}
        {weeks.flat().map((d) => {
          const ymd = formatYmd(d);
          const enabled = !disabled && inWindow(d);
          const event = inEvent(d);
          const firstOfMonth = d.getDate() === 1;
          const callout = named.get(ymd);

          // Selection state differs by mode.
          const isArrival = mode === "range" && ymd === arrival;
          const isDeparture = mode === "range" && ymd === departure;
          const isEndpoint = isArrival || isDeparture;
          const between =
            mode === "range" &&
            !!arrival &&
            !!departure &&
            ymd > arrival &&
            ymd < departure;
          const singleSelected = mode === "single" && value === ymd;
          const selected = singleSelected || isEndpoint;

          const bg = singleSelected
            ? "var(--mantine-color-blue-6)"
            : isEndpoint
              ? "var(--mantine-color-green-6)"
              : between
                ? "var(--mantine-color-green-light)"
                : event
                  ? "var(--mantine-color-blue-light)"
                  : "transparent";
          const fg = selected
            ? "var(--mantine-color-white)"
            : event
              ? "var(--mantine-color-blue-7)"
              : undefined;

          return (
            <UnstyledButton
              key={ymd}
              disabled={!enabled}
              onClick={() =>
                mode === "range"
                  ? tapRange(ymd)
                  : onChange?.(singleSelected ? null : ymd)
              }
              title={callout}
              style={{
                aspectRatio: "1 / 1",
                borderRadius: "var(--mantine-radius-sm)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1.0,
                cursor: enabled ? "pointer" : "default",
                opacity: inWindow(d) ? 1 : 0.3,
                color: fg,
                fontWeight: event || selected ? 700 : 400,
                backgroundColor: bg,
                border: enabled
                  ? "1px solid var(--mantine-color-default-border)"
                  : "1px solid transparent",
              }}
            >
              {firstOfMonth ? (
                <Text span fz={9} lh={1} c={selected ? "white" : "dimmed"}>
                  {MONTHS[d.getMonth()]}
                </Text>
              ) : null}
              <Text span fz="sm" lh={1}>
                {d.getDate()}
              </Text>
              {callout ? (
                <Text
                  span
                  fz={8}
                  lh={1}
                  mt={1}
                  c={selected ? "white" : "blue.7"}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {callout}
                </Text>
              ) : null}
            </UnstyledButton>
          );
        })}
      </Box>
      <Group gap="md" mt={6}>
        <Legend color="var(--mantine-color-blue-light)" label="Event days" />
        {mode === "range" ? (
          <Legend color="var(--mantine-color-green-6)" label="Your stay" />
        ) : null}
      </Group>
    </Box>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <Text size="xs" c="dimmed">
      <Box
        component="span"
        mr={4}
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: 2,
          backgroundColor: color,
          verticalAlign: "middle",
        }}
      />
      {label}
    </Text>
  );
}

const MONTHS = [
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

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Parse a `YYYY-MM-DD` string as a LOCAL date (no UTC midnight day-shift). */
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function formatYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
