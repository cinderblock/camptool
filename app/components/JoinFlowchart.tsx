import { Box, Paper, Stack, Text, VisuallyHidden } from "@mantine/core";

/**
 * The "joining the camp" journey as a small flowchart: two entry doors (a
 * friend's invite link, finding us online) merge into onboarding → getting
 * ready → the event, then the easy every-year loop back to "get ready".
 *
 * Pure Mantine/CSS — no chart library — so it follows the app theme. Lives in
 * components so the guide page (and later a public page) can share it.
 * ("Go to Burning Man" is event-layer copy; revisit when that layer peels out.)
 */
export function JoinFlowchart({ year }: { year?: number }) {
  const border = "2px solid var(--mantine-color-default-border)";
  const dashed = "2px dashed var(--mantine-color-dimmed)";
  return (
    <Box maw={640} pr={44}>
      {/* The chart is drawn with CSS borders and glyph arrows — meaningless
          (or worse, noisy) to a screen reader, so the whole visual is hidden
          and the narrative below tells the same story in prose. */}
      <VisuallyHidden>
        <ol>
          <li>
            There are two ways in: a friend in the camp sends you their one-time
            invite link (create an account, tap Join, you're in right away), or
            you find us online and apply on the public page — the camp reviews
            applications and reaches out.
          </li>
          <li>
            Both paths meet at onboarding: quick setup covering who you are,
            when you'll be there, and what you're bringing.
          </li>
          <li>
            Then you get ready{year ? ` for ${year}` : ""} — tickets and passes,
            dues, your spot on the camp map — and go to Burning Man (come early
            for setup or stay for strike if you can).
          </li>
          <li>
            After that you're in the camp, and each following year loops back to
            "get ready" — the easy path.
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
              title="A friend invites you"
              hint="Someone in the camp makes you a one-time invite link."
            />
            <FlowArrow />
            <FlowNode
              title="Create an account & tap Join"
              hint="You're in right away."
            />
          </Stack>
          <Stack gap={0}>
            <FlowNode
              title="You find us online"
              hint="Apply on the public page — tell us a bit about yourself."
            />
            <FlowArrow />
            <FlowNode
              title="The camp reviews & reaches out"
              hint="Accepted folks get invited in."
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
          title="Onboarding"
          hint="Quick setup: who you are, when you'll be there, what you're bringing."
          accent
        />
        <FlowArrow />

        {/* The yearly loop: get ready → burn → you're in → (next year) back up */}
        <Box style={{ display: "grid", gridTemplateColumns: "1fr 26px" }}>
          <Stack gap={0}>
            <FlowNode
              title={`Get ready${year ? ` for ${year}` : ""}`}
              hint="Tickets & passes, dues, your spot on the camp map."
            />
            <FlowArrow />
            <FlowNode
              title="Go to Burning Man 🔥"
              hint="Come early for setup or stay for strike if you can."
              accent
            />
            <FlowArrow />
            <FlowNode
              title="You're in the camp"
              hint="From here on it's the easy path."
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
