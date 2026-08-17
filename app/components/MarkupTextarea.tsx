/**
 * The app's editor for wiki-format text — a textarea, an "Insert a link to…"
 * picker, and the one-line syntax hint. Shared by the wiki page editor and the
 * FAQ answer editor so the two can never drift into different markup or
 * different link affordances (see plans/camp-faq.md).
 *
 * The picker is the point: linking deep into CampTool — and especially at a
 * wiki page — should be a click, not a memorized path.
 */
import { Group, Select, Text, Textarea } from "@mantine/core";
import { useRef } from "react";
import { type LinkTarget, linkSnippet } from "~/lib/wiki";

/** Select values must be unique across groups; a path and a page title could
 * collide, so the kind is part of the key. */
const keyFor = (t: LinkTarget) => `${t.kind}:${t.path}`;

export function MarkupTextarea({
  label,
  value,
  onChange,
  targets,
  minRows = 8,
  maxRows = 40,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  targets: LinkTarget[];
  minRows?: number;
  maxRows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const groups = [...new Set(targets.map((t) => t.group))].map((group) => ({
    group,
    items: targets
      .filter((t) => t.group === group)
      .map((t) => ({ value: keyFor(t), label: t.label })),
  }));

  function insert(target: LinkTarget) {
    const el = ref.current;
    if (!el) {
      const snippet = linkSnippet(target);
      onChange(value ? `${value}\n${snippet}` : snippet);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    // A selection becomes the link text; otherwise the target's own name is.
    const snippet = linkSnippet(target, value.slice(start, end));
    onChange(value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + snippet.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div>
      <Group justify="space-between" align="flex-end" mb={4}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        {targets.length > 0 ? (
          <Select
            size="xs"
            placeholder="Insert a link to…"
            searchable
            w={240}
            value={null}
            data={groups}
            onChange={(v) => {
              const target = targets.find((t) => keyFor(t) === v);
              if (target) insert(target);
            }}
          />
        ) : null}
      </Group>
      <Textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        autosize
        minRows={minRows}
        maxRows={maxRows}
        styles={{ input: { fontFamily: "monospace", fontSize: "0.85rem" } }}
      />
      <Text size="xs" c="dimmed" mt={4}>
        <strong>#</strong> heading · <strong>-</strong> bullet ·{" "}
        <strong>**bold**</strong> · <strong>`code`</strong> ·{" "}
        <strong>[[Another page]]</strong> to link a wiki page ·{" "}
        <strong>[[/map|the map]]</strong> to link anywhere in CampTool.
      </Text>
    </div>
  );
}
