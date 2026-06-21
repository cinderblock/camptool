import {
  Box,
  Button,
  Checkbox,
  Group,
  Input,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useFetcher } from "react-router";
import { EventCalendar } from "~/components/EventCalendar";
import {
  type QuestionType,
  parseEventRange,
  parseMultiValue,
  stringifyEventRange,
} from "~/lib/questions";

/** At or below this many options, a single/multi choice renders as a row of
 * buttons instead of a dropdown — quicker to scan and tap for a short list. */
const BUTTON_MAX = 5;

/** Escape-hatch choice for the `invited_by` dropdown, for campers whose inviter
 * isn't a listed member (found the camp some other way). */
export const INVITED_BY_OTHER = "I found camp another way";

export type QuestionFieldData = {
  id: string;
  prompt: string;
  helpText: string | null;
  type: QuestionType;
  options: string[];
  required: boolean;
  /** multi_select only: the option that clears the others when picked. */
  exclusiveOption?: string | null;
};

/** Next multi_select selection after toggling `opt`, honoring an exclusive
 * option: picking the exclusive one clears the rest; picking any other clears
 * the exclusive one. */
function nextMulti(
  selected: string[],
  opt: string,
  exclusive: string | null | undefined,
): string[] {
  if (selected.includes(opt)) return selected.filter((x) => x !== opt);
  if (exclusive && opt === exclusive) return [opt];
  return [...selected.filter((x) => x !== exclusive), opt];
}

/**
 * Renders one questionnaire field by type and saves the answer via a fetcher.
 * `action` targets a different route's action (the wizard reuses /questions);
 * omit it to post to the current route. Used by /questions and the /start wizard.
 */
export function QuestionField({
  question: q,
  value,
  locked,
  action,
  bare,
  year,
  invitedByName,
  inviterOptions,
}: {
  question: QuestionFieldData;
  value: string | undefined;
  locked: boolean;
  action?: string;
  /** Render only the input control — no prompt label or help text. The editor
   * shows those as separate click-to-edit text, so it suppresses them here. */
  bare?: boolean;
  /** Active edition year — bounds the `event_date` calendar to the event window. */
  year?: number;
  /** Who invited this member (from the invite tree) — pre-fills `invited_by`. */
  invitedByName?: string | null;
  /** Active member names for the `invited_by` dropdown (so it isn't open-ended). */
  inviterOptions?: string[];
}) {
  const fetcher = useFetcher();
  const save = (v: string) =>
    fetcher.submit(
      { intent: "answer", questionId: q.id, value: v },
      action ? { method: "post", action } : { method: "post" },
    );

  const description = bare ? undefined : q.helpText;
  const label = bare ? undefined : (
    <span>
      {q.prompt}
      {q.required ? (
        <Text component="span" c="red" inherit>
          {" *"}
        </Text>
      ) : null}
    </span>
  );

  switch (q.type) {
    case "long_text":
      return (
        <Textarea
          label={label}
          description={description}
          autosize
          minRows={3}
          disabled={locked}
          defaultValue={value ?? ""}
          onBlur={(e) => save(e.currentTarget.value)}
        />
      );
    case "number":
      return (
        <NumberInput
          label={label}
          description={description}
          disabled={locked}
          defaultValue={value === undefined ? undefined : Number(value)}
          onBlur={(e) => save(e.currentTarget.value)}
          w={200}
        />
      );
    case "single_select": {
      const current = value ?? "";
      if (q.options.length <= BUTTON_MAX) {
        return (
          <Input.Wrapper label={label} description={description}>
            <Group gap="xs" mt={6}>
              {q.options.map((o) => (
                <Button
                  key={o}
                  size="xs"
                  variant={current === o ? "filled" : "default"}
                  disabled={locked}
                  onClick={() => save(current === o ? "" : o)}
                >
                  {o}
                </Button>
              ))}
            </Group>
          </Input.Wrapper>
        );
      }
      return (
        <Select
          label={label}
          description={description}
          data={q.options}
          disabled={locked}
          defaultValue={value ?? null}
          onChange={(v) => save(v ?? "")}
          clearable
          comboboxProps={{ withinPortal: true }}
          maw={360}
        />
      );
    }
    case "multi_select": {
      const selected = parseMultiValue(value);
      const exclusive = q.exclusiveOption;
      const toggle = (o: string) =>
        save(JSON.stringify(nextMulti(selected, o, exclusive)));
      if (q.options.length <= BUTTON_MAX) {
        return (
          <Input.Wrapper label={label} description={description}>
            <Group gap="xs" mt={6}>
              {q.options.map((o) => (
                <Button
                  key={o}
                  size="xs"
                  variant={selected.includes(o) ? "filled" : "default"}
                  disabled={locked}
                  onClick={() => toggle(o)}
                >
                  {o}
                </Button>
              ))}
            </Group>
          </Input.Wrapper>
        );
      }
      return (
        <Input.Wrapper label={label} description={description}>
          <Stack gap={6} mt={6}>
            {q.options.map((o) => (
              <Checkbox
                key={o}
                label={o}
                checked={selected.includes(o)}
                disabled={locked}
                onChange={() => toggle(o)}
              />
            ))}
          </Stack>
        </Input.Wrapper>
      );
    }
    case "boolean": {
      // Yes/No as two buttons (not a lone checkbox) so an unanswered question is
      // distinguishable from an explicit "No". Re-clicking the active one clears it.
      const yn = value === "true" ? "yes" : value === "false" ? "no" : "";
      const pick = (choice: "yes" | "no") =>
        save(yn === choice ? "" : choice === "yes" ? "true" : "false");
      return (
        <Input.Wrapper label={label} description={description}>
          <Group gap="xs" mt={6}>
            <Button
              size="xs"
              variant={yn === "yes" ? "filled" : "default"}
              disabled={locked}
              onClick={() => pick("yes")}
            >
              Yes
            </Button>
            <Button
              size="xs"
              variant={yn === "no" ? "filled" : "default"}
              disabled={locked}
              onClick={() => pick("no")}
            >
              No
            </Button>
          </Group>
        </Input.Wrapper>
      );
    }
    case "consent":
      return (
        <Checkbox
          label={label}
          description={description}
          color="green"
          disabled={locked}
          defaultChecked={value === "true"}
          onChange={(e) => save(e.currentTarget.checked ? "true" : "")}
        />
      );
    case "date":
      return (
        <DateInput
          label={label}
          description={description}
          valueFormat="YYYY-MM-DD"
          disabled={locked}
          defaultValue={value ? new Date(value) : null}
          onChange={(d) => save(d ? formatDate(d) : "")}
          popoverProps={{ withinPortal: true }}
          maw={260}
        />
      );
    case "event_date":
      // One consistent calendar centered on the event (no month arrows — those
      // rendered awkwardly at the window edges). Falls back to a plain date
      // picker only when we don't know the year (no event to center on).
      return year == null ? (
        <DateInput
          label={label}
          description={description}
          valueFormat="YYYY-MM-DD"
          disabled={locked}
          defaultValue={value ? parseLocalDate(value) : null}
          onChange={(d) => save(d ? formatDate(d) : "")}
          popoverProps={{ withinPortal: true }}
          maw={260}
        />
      ) : (
        <Input.Wrapper label={label} description={description}>
          <Box mt={6}>
            <EventCalendar
              year={year}
              value={value ?? null}
              onChange={(v) => save(v ?? "")}
              disabled={locked}
            />
          </Box>
        </Input.Wrapper>
      );
    case "event_range": {
      // Arrival + departure picked on one event calendar. Falls back to two plain
      // date inputs only when we don't know the year (no event to center on).
      const range = parseEventRange(value);
      if (year == null) {
        return (
          <Input.Wrapper label={label} description={description}>
            <Group gap="sm" mt={6} align="flex-end">
              <DateInput
                label="Arrival"
                valueFormat="YYYY-MM-DD"
                disabled={locked}
                defaultValue={
                  range.arrival ? parseLocalDate(range.arrival) : null
                }
                onChange={(d) =>
                  save(
                    stringifyEventRange({
                      ...range,
                      arrival: d ? formatDate(d) : null,
                    }),
                  )
                }
                popoverProps={{ withinPortal: true }}
                maw={200}
              />
              <DateInput
                label="Departure"
                valueFormat="YYYY-MM-DD"
                disabled={locked}
                defaultValue={
                  range.departure ? parseLocalDate(range.departure) : null
                }
                onChange={(d) =>
                  save(
                    stringifyEventRange({
                      ...range,
                      departure: d ? formatDate(d) : null,
                    }),
                  )
                }
                popoverProps={{ withinPortal: true }}
                maw={200}
              />
            </Group>
          </Input.Wrapper>
        );
      }
      return (
        <Input.Wrapper label={label} description={description}>
          <Text size="xs" c="dimmed" mt={4}>
            Tap your arrival day, then your departure day.
          </Text>
          <Box mt={6}>
            <EventCalendar
              year={year}
              mode="range"
              range={range}
              onRangeChange={(r) => save(stringifyEventRange(r))}
              disabled={locked}
            />
          </Box>
        </Input.Wrapper>
      );
    }
    case "invited_by": {
      // Not open-ended: pick from current members (pre-filled with the detected
      // inviter) plus an escape hatch for "found camp another way".
      const opts = inviterOptions ?? [];
      const current = value ?? invitedByName ?? null;
      // Keep a stored value that isn't in the roster (e.g. a member who left)
      // selectable so it isn't silently dropped.
      const extra =
        current && current !== INVITED_BY_OTHER && !opts.includes(current)
          ? [current]
          : [];
      const data = [...opts, ...extra, INVITED_BY_OTHER];
      return (
        <Select
          label={label}
          description={description}
          data={data}
          disabled={locked}
          defaultValue={current}
          onChange={(v) => save(v ?? "")}
          searchable
          clearable
          placeholder="Choose a member…"
          comboboxProps={{ withinPortal: true }}
          maw={360}
          nothingFoundMessage="No match"
        />
      );
    }
    default:
      return (
        <TextInput
          label={label}
          description={description}
          disabled={locked}
          defaultValue={value ?? ""}
          onBlur={(e) => save(e.currentTarget.value)}
        />
      );
  }
}

/** Parse a `YYYY-MM-DD` string as a LOCAL date (avoids the UTC-midnight day-shift
 * `new Date("YYYY-MM-DD")` causes in negative-offset timezones). */
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** @mantine/dates may hand back a Date or a string depending on version; coerce
 * to a YYYY-MM-DD string for storage either way. */
function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "";
  return date.toISOString().slice(0, 10);
}
