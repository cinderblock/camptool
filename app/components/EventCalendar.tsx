import { Box, Text, UnstyledButton } from "@mantine/core";
import { eventStartFor, eventWindowFor } from "~/lib/brc";

/**
 * A single, consistent calendar centered on the event — the shared primitive for
 * picking event-relative dates (and, later, for showing camp events on top).
 *
 * It is intentionally NOT a navigable month calendar: there are no prev/next
 * arrows. It renders the fixed span of whole weeks around the event window
 * (`eventWindowFor`), highlights the event days, and lets the user tap a single
 * day to set it. Days outside the window are dimmed and not selectable.
 */
export function EventCalendar({
  year,
  value,
  onChange,
  disabled,
}: {
  year: number;
  /** Selected day as `YYYY-MM-DD`, or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const start = eventStartFor(year); // Sunday gates open
  // The core event runs gates-open Sunday through Labor Day Monday (+8 days).
  const eventEnd = addDays(start, 8);
  const win = eventWindowFor(year);
  const min = parseYmd(win.min);
  const max = parseYmd(win.max);

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
          const selected = value === ymd;
          const enabled = !disabled && inWindow(d);
          const event = inEvent(d);
          const firstOfMonth = d.getDate() === 1;
          return (
            <UnstyledButton
              key={ymd}
              disabled={!enabled}
              onClick={() => onChange(selected ? null : ymd)}
              style={{
                aspectRatio: "1 / 1",
                borderRadius: "var(--mantine-radius-sm)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1.05,
                cursor: enabled ? "pointer" : "default",
                opacity: inWindow(d) ? 1 : 0.3,
                color: selected
                  ? "var(--mantine-color-white)"
                  : event
                    ? "var(--mantine-color-blue-7)"
                    : undefined,
                fontWeight: event || selected ? 700 : 400,
                backgroundColor: selected
                  ? "var(--mantine-color-blue-6)"
                  : event
                    ? "var(--mantine-color-blue-light)"
                    : "transparent",
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
            </UnstyledButton>
          );
        })}
      </Box>
      <Text size="xs" c="dimmed" mt={6}>
        <Box
          component="span"
          mr={4}
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 2,
            backgroundColor: "var(--mantine-color-blue-light)",
            verticalAlign: "middle",
          }}
        />
        Event days
      </Text>
    </Box>
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
