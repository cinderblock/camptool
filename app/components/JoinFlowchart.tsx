import { Box, Paper, Stack, Text, VisuallyHidden } from "@mantine/core";
import { eventLabel, isBurningMan } from "~/lib/events";

/**
 * The "joining the camp" journey as a small flowchart: two entry doors (a
 * friend's invite link, finding us online) merge into onboarding → getting
 * ready → the event, then the easy every-year loop back to "get ready".
 *
 * Pure Mantine/CSS — no chart library — so it follows the app theme. Lives in
 * components so the guide page (and later a public page) can share it.
 */
export function JoinFlowchart({
  year,
  event,
}: {
  year?: number;
  event?: string | null;
}) {
  const border = "2px solid var(--mantine-color-default-border)";
  const dashed = "2px dashed var(--mantine-color-dimmed)";
  const goToTitle = isBurningMan(event)
    ? "Go to Burning Man"
    : event && event !== "other"
      ? `Go to ${eventLabel(event)}`
      : "Go to the event";
  const goToProse = isBurningMan(event)
    ? "go to Burning Man"
    : event && event !== "other"
      ? `go to ${eventLabel(event)}`
      : "go to the event";
  return (
    <Box maw={640} pr={44}>
      {/* The chart is drawn with CSS borders and glyph arrows — meaningless
          (or worse, noisy) to a screen reader, so the whole visual is hidden
          and the narrative below tells the same story in prose. */}
      <VisuallyHidden>
        <ol>
          <li>
            Two ways in: redeem an invite link (create an account and join right
            away), or apply on the camp's public page for officers to review.
          </li>
          <li>Complete Guided setup: your details, dates, and gear.</li>
          <li>
            Prepare{year ? ` for ${year}` : ""} (tickets, passes, dues, and camp
            map), then {goToProse}.
          </li>
          <li>
            Each following year, your membership carries over and loops back to
            preparing for the new year.
          </li>
        </ol>
      </VisuallyHidden>
      <Box aria-hidden="true">
        {/* Two entry doors */}
        <Box
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
        >
          <Stack gap={0}>
            <FlowNode
              title="Invited by camp"
              hint="Receive an invite link from a member or officer."
            />
            <FlowArrow />
            <FlowNode title="Create account & join" hint="Immediate access." />
          </Stack>
          <Stack gap={0}>
            <FlowNode
              title="Apply online"
              hint="Submit the camp's application form."
            />
            <FlowArrow />
            <FlowNode
              title="Officer review"
              hint="Accepted applicants join the camp."
            />
          </Stack>
        </Box>

        {/* Merge the two columns into the shared path */}
        <Box
          w="50%"
          mx="auto"
          h={16}
          style={{
            borderLeft: border,
            borderRight: border,
            borderBottom: border,
            borderBottomLeftRadius: 8,
            borderBottomRightRadius: 8,
          }}
        />
        <FlowArrow />
        <FlowNode
          title="Guided setup"
          hint="Your info, dates, and gear."
          accent
        />
        <FlowArrow />

        {/* The yearly loop: get ready → burn → return → (next year) back up */}
        <Box style={{ display: "grid", gridTemplateColumns: "1fr 26px" }}>
          <Stack gap={0}>
            <FlowNode
              title={`Get ready${year ? ` for ${year}` : ""}`}
              hint="Tickets, passes, dues, and map placement."
            />
            <FlowArrow />
            <FlowNode
              title={goToTitle}
              hint="Build, enjoy the event, and pack out."
              accent
            />
            <FlowArrow />
            <FlowNode
              title="Return next year"
              hint="Your account and role carry over."
            />
          </Stack>
          <Box style={{ position: "relative", margin: "24px 0" }}>
            <Box
              style={{
                position: "absolute",
                inset: 0,
                borderTop: dashed,
                borderRight: dashed,
                borderBottom: dashed,
                borderTopRightRadius: 12,
                borderBottomRightRadius: 12,
              }}
            />
            <Text
              span
              size="xs"
              c="dimmed"
              style={{ position: "absolute", top: -9, left: -5, lineHeight: 1 }}
            >
              ◀
            </Text>
            <Text
              size="xs"
              c="dimmed"
              style={{
                position: "absolute",
                right: -36,
                top: "50%",
                transform: "translateY(-50%) rotate(90deg)",
                whiteSpace: "nowrap",
              }}
            >
              next year ↺
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function FlowNode({
  title,
  hint,
  accent,
}: {
  title: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      ta="center"
      bg={accent ? "var(--mantine-color-blue-light)" : undefined}
    >
      <Text size="sm" fw={600}>
        {title}
      </Text>
      {hint ? (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Paper>
  );
}

function FlowArrow() {
  return (
    <Text ta="center" c="dimmed" lh={1.2} my={2}>
      ↓
    </Text>
  );
}
