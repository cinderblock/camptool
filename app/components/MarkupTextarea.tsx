/**
 * The app's editor for wiki-format text — a textarea, an "Insert a link to…"
 * picker, picture uploads, and the one-line syntax hint. Shared by the wiki
 * page editor and the FAQ answer editor so the two can never drift into
 * different markup or different affordances (see plans/camp-faq.md and
 * plans/pictures-in-bodies.md).
 *
 * Two things are the point here: linking deep into CampTool should be a click
 * rather than a memorized path, and adding a picture should work the three ways
 * people actually try — pick a file, paste, or drag it onto the box.
 */
import { Button, Group, Select, Text, Textarea } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useRef, useState } from "react";
import { prepareUpload } from "~/lib/images.client";
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
  allowPictures = true,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  targets: LinkTarget[];
  minRows?: number;
  maxRows?: number;
  placeholder?: string;
  allowPictures?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const groups = [...new Set(targets.map((t) => t.group))].map((group) => ({
    group,
    items: targets
      .filter((t) => t.group === group)
      .map((t) => ({ value: keyFor(t), label: t.label })),
  }));

  /** Drop text in at the cursor, or append when the textarea isn't mounted. */
  function insertText(snippet: string, wrapSelection = false) {
    const el = ref.current;
    if (!el) {
      onChange(value ? `${value}\n${snippet}` : snippet);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = wrapSelection ? (el.selectionEnd ?? start) : start;
    onChange(value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + snippet.length;
      el.setSelectionRange(caret, caret);
    });
  }

  function insertLink(target: LinkTarget) {
    const el = ref.current;
    const selected = el
      ? value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      : "";
    insertText(linkSnippet(target, selected), true);
  }

  /**
   * Upload the original at full resolution, plus whatever smaller copy the
   * browser managed to make for display. One path for the file picker, paste
   * and drop alike.
   */
  async function uploadPictures(files: File[]) {
    const pictures = files.filter((f) => f.type.startsWith("image/"));
    if (pictures.length === 0) return;
    setUploading(true);
    try {
      for (const file of pictures) {
        const prepared = await prepareUpload(file);
        const body = new FormData();
        body.append("file", file);
        if (prepared.display) {
          body.append("display", prepared.display, "display.webp");
        }
        if (prepared.width) body.append("width", String(prepared.width));
        if (prepared.height) body.append("height", String(prepared.height));

        const res = await fetch("/api/media", { method: "POST", body });
        const json = (await res.json().catch(() => null)) as {
          src?: string;
          alt?: string;
          error?: string;
        } | null;
        if (!res.ok || !json?.src) {
          notifications.show({
            color: "red",
            message: json?.error ?? "That picture didn't upload.",
          });
          // Stop at the first failure rather than firing one toast per file.
          break;
        }
        insertText(`\n![${json.alt ?? ""}](${json.src})\n`);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Group justify="space-between" align="flex-end" mb={4}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Group gap="xs">
          {allowPictures ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  uploadPictures([...(e.currentTarget.files ?? [])]);
                  // Let the same file be chosen twice in a row.
                  e.currentTarget.value = "";
                }}
              />
              <Button
                size="xs"
                variant="default"
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                Add a picture
              </Button>
            </>
          ) : null}
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
                if (target) insertLink(target);
              }}
            />
          ) : null}
        </Group>
      </Group>
      <Textarea
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
        autosize
        minRows={minRows}
        maxRows={maxRows}
        onPaste={
          allowPictures
            ? (e) => {
                const files = [...(e.clipboardData?.files ?? [])];
                if (files.some((f) => f.type.startsWith("image/"))) {
                  // Only swallow the paste when it really is a picture —
                  // pasting text must still behave like pasting text.
                  e.preventDefault();
                  uploadPictures(files);
                }
              }
            : undefined
        }
        onDragOver={
          allowPictures
            ? (e) => {
                e.preventDefault();
                setDragging(true);
              }
            : undefined
        }
        onDragLeave={allowPictures ? () => setDragging(false) : undefined}
        onDrop={
          allowPictures
            ? (e) => {
                e.preventDefault();
                setDragging(false);
                uploadPictures([...(e.dataTransfer?.files ?? [])]);
              }
            : undefined
        }
        styles={{
          input: {
            fontFamily: "monospace",
            fontSize: "0.85rem",
            outline: dragging
              ? "2px dashed var(--mantine-color-blue-5)"
              : undefined,
          },
        }}
      />
      <Text size="xs" c="dimmed" mt={4}>
        <strong>#</strong> heading · <strong>-</strong> bullet ·{" "}
        <strong>**bold**</strong> · <strong>`code`</strong> ·{" "}
        <strong>[[Another page]]</strong> to link a wiki page ·{" "}
        <strong>[[/map|the map]]</strong> to link anywhere in CampTool
        {allowPictures ? (
          <>
            {" "}
            · <strong>drop, paste or pick a picture</strong> to add one
          </>
        ) : null}
        .
      </Text>
    </div>
  );
}
