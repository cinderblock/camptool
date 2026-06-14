import {
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
import { type QuestionType, parseMultiValue } from "~/lib/questions";

/** At or below this many options, a single/multi choice renders as a row of
 * buttons instead of a dropdown — quicker to scan and tap for a short list. */
const BUTTON_MAX = 5;

export type QuestionFieldData = {
  id: string;
  prompt: string;
  helpText: string | null;
  type: QuestionType;
  options: string[];
  required: boolean;
};

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
}: {
  question: QuestionFieldData;
  value: string | undefined;
  locked: boolean;
  action?: string;
}) {
  const fetcher = useFetcher();
  const save = (v: string) =>
    fetcher.submit(
      { intent: "answer", questionId: q.id, value: v },
      action ? { method: "post", action } : { method: "post" },
    );

  const label = (
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
          description={q.helpText}
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
          description={q.helpText}
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
          <Input.Wrapper label={label} description={q.helpText}>
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
          description={q.helpText}
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
      const toggle = (o: string) =>
        save(
          JSON.stringify(
            selected.includes(o)
              ? selected.filter((x) => x !== o)
              : [...selected, o],
          ),
        );
      if (q.options.length <= BUTTON_MAX) {
        return (
          <Input.Wrapper label={label} description={q.helpText}>
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
        <Checkbox.Group
          label={label}
          description={q.helpText}
          defaultValue={selected}
          onChange={(v) => save(JSON.stringify(v))}
        >
          <Stack gap={6} mt={6}>
            {q.options.map((o) => (
              <Checkbox key={o} value={o} label={o} disabled={locked} />
            ))}
          </Stack>
        </Checkbox.Group>
      );
    }
    case "boolean":
      return (
        <Checkbox
          label={label}
          description={q.helpText}
          disabled={locked}
          defaultChecked={value === "true"}
          onChange={(e) => save(e.currentTarget.checked ? "true" : "false")}
        />
      );
    case "consent":
      return (
        <Checkbox
          label={label}
          description={q.helpText}
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
          description={q.helpText}
          valueFormat="YYYY-MM-DD"
          disabled={locked}
          defaultValue={value ? new Date(value) : null}
          onChange={(d) => save(d ? formatDate(d) : "")}
          popoverProps={{ withinPortal: true }}
          maw={260}
        />
      );
    default:
      return (
        <TextInput
          label={label}
          description={q.helpText}
          disabled={locked}
          defaultValue={value ?? ""}
          onBlur={(e) => save(e.currentTarget.value)}
        />
      );
  }
}

/** @mantine/dates may hand back a Date or a string depending on version; coerce
 * to a YYYY-MM-DD string for storage either way. */
function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return typeof d === "string" ? d : "";
  return date.toISOString().slice(0, 10);
}
