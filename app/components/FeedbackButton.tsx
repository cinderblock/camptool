import {
  Button,
  Group,
  Modal,
  Select,
  Stack,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { getBreadcrumbs } from "~/lib/telemetry.client";

const KINDS = [
  { value: "bug", label: "Bug" },
  { value: "question", label: "Question" },
  { value: "issue", label: "Issue" },
  { value: "improvement", label: "Improvement" },
  { value: "suggestion", label: "Suggestion" },
  { value: "compliment", label: "Compliment" },
  { value: "other", label: "Other" },
];

/** Header button → modal for users to send a bug/issue/suggestion/etc. Bug type
 * gets a structured template; everything captures the current URL + breadcrumbs
 * (recent navigation/errors) so we can trace what happened. */
export function FeedbackButton() {
  const [opened, { open, close }] = useDisclosure(false);
  const [kind, setKind] = useState("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [doing, setDoing] = useState("");
  const [trying, setTrying] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [busy, setBusy] = useState(false);

  const isBug = kind === "bug";

  function reset() {
    setTitle("");
    setBody("");
    setDoing("");
    setTrying("");
    setExpected("");
    setActual("");
  }

  async function submit() {
    const details = isBug ? { doing, trying, expected, actual } : null;
    const hasContent = isBug
      ? `${doing}${trying}${expected}${actual}`.trim() !== ""
      : body.trim() !== "";
    if (!hasContent) {
      notifications.show({
        color: "red",
        message: isBug ? "Fill in at least one field." : "Add a message.",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title,
          body,
          details,
          url: location.pathname + location.search,
          userAgent: navigator.userAgent,
          metadata: {
            breadcrumbs: getBreadcrumbs(),
            viewport: { w: window.innerWidth, h: window.innerHeight },
            at: new Date().toISOString(),
          },
        }),
      });
      if (!res.ok) throw new Error("send failed");
      notifications.show({ message: "Thanks! Your feedback was sent." });
      reset();
      close();
    } catch {
      notifications.show({
        color: "red",
        message: "Couldn't send feedback. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="subtle" size="xs" color="gray" onClick={open}>
        Feedback
      </Button>
      <Modal opened={opened} onClose={close} title="Send feedback" size="lg">
        <Stack gap="sm">
          <Select
            label="Type"
            data={KINDS}
            value={kind}
            onChange={(v) => setKind(v ?? "other")}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <TextInput
            label="Summary (optional)"
            placeholder="One line"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          {isBug ? (
            <>
              <Textarea
                label="What were you doing?"
                autosize
                minRows={2}
                value={doing}
                onChange={(e) => setDoing(e.currentTarget.value)}
              />
              <Textarea
                label="What did you try?"
                autosize
                minRows={2}
                value={trying}
                onChange={(e) => setTrying(e.currentTarget.value)}
              />
              <Textarea
                label="What did you expect to happen?"
                autosize
                minRows={2}
                value={expected}
                onChange={(e) => setExpected(e.currentTarget.value)}
              />
              <Textarea
                label="What actually happened?"
                autosize
                minRows={2}
                value={actual}
                onChange={(e) => setActual(e.currentTarget.value)}
              />
            </>
          ) : (
            <Textarea
              label={kind === "question" ? "Your question" : "Message"}
              placeholder={
                kind === "question"
                  ? "What would you like to know?"
                  : "Tell us what's on your mind…"
              }
              autosize
              minRows={4}
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              Send
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
