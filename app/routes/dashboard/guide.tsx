import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  List,
  Stack,
  Text,
  Timeline,
  Title,
} from "@mantine/core";
import { Link } from "react-router";
import { JoinFlowchart } from "~/components/JoinFlowchart";
import { weeksUntilEvent } from "~/lib/brc";
import { eventLabel, isBurningMan } from "~/lib/events";
import { featureVisibleTo } from "~/lib/features";
import { featureStatesFor } from "~/lib/features.server";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import type { Route } from "./+types/guide";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp guide · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  // The feature states came with the camp, so they cost no query of their own
  // (plans/fast-navigation.md).
  const [state, featureStates] = await Promise.all([
    loadWizardState({
      campId: active.camp.id,
      editionId: activeEdition.id,
      membershipId: active.membership.id,
      role: active.membership.role,
      year: activeEdition.year,
    }),
    featureStatesFor(active),
  ]);
  const seeFeature = (key: Parameters<typeof featureStates.get>[0]) =>
    featureVisibleTo(featureStates.get(key) ?? "off", active.membership.role);
  return redact(privacy, {
    campName: active.camp.name,
    year: activeEdition.year,
    event: activeEdition.event,
    weeksToEvent: weeksUntilEvent(activeEdition.year),
    scheduled: state.scheduled.map((a) => ({
      key: a.key,
      label: a.label,
      hint: a.hint,
    })),
    resolved: state.resolved,
    pendingCount: state.pending.length,
    // The narrative below only mentions features this camp actually uses.
    features: {
      map: seeFeature("map") || seeFeature("bringing"),
      tickets: seeFeature("tickets") || seeFeature("passes"),
    },
  });
}

export default function Guide({ loaderData }: Route.ComponentProps) {
  const {
    campName,
    year,
    event,
    weeksToEvent,
    scheduled,
    resolved,
    pendingCount,
    features,
  } = loaderData;
  const doneCount = scheduled.filter((s) => resolved[s.key]).length;
  const burningMan = isBurningMan(event);
  const destination = burningMan
    ? "the playa"
    : event !== "other"
      ? eventLabel(event)
      : "the event";

  return (
    <Container size="md">
      <Stack gap="xl">
        <div>
          <Title order={1} size="h2">
            {campName} guide
          </Title>
          <Text c="dimmed" size="sm">
            Joining, preparing for {destination}, and returning next year
            {burningMan && weeksToEvent > 0
              ? ` · ~${weeksToEvent} weeks out`
              : ""}
            .
          </Text>
        </div>

        <Card withBorder padding="lg" radius="md">
          <Group justify="space-between" mb="md">
            <Text fw={600}>Your progress · {year}</Text>
            <Badge
              variant="light"
              color={pendingCount === 0 ? "green" : "blue"}
            >
              {doneCount} of {scheduled.length} done
            </Badge>
          </Group>
          {scheduled.length === 0 ? (
            <Text size="sm" c="dimmed">
              All set for {year}.
            </Text>
          ) : (
            <Timeline active={doneCount} bulletSize={20} lineWidth={2}>
              {scheduled.map((s) => {
                const status = resolved[s.key];
                return (
                  <Timeline.Item
                    key={s.key}
                    title={s.label}
                    color={status ? "green" : "gray"}
                    bullet={
                      status === "done"
                        ? "✓"
                        : status === "skipped"
                          ? "–"
                          : null
                    }
                  >
                    <Text size="xs" c="dimmed">
                      {s.hint}
                      {status === "skipped" ? " · skipped" : ""}
                    </Text>
                  </Timeline.Item>
                );
              })}
            </Timeline>
          )}
          {/* Offered even when nothing is pending: the wizard is also how you
              revisit what you said, and hiding it once you're caught up is how
              someone who skipped it ends up unable to find it at all. */}
          <Button
            component={Link}
            to="/start"
            mt="md"
            variant="light"
            w="fit-content"
          >
            {pendingCount > 0 ? "Continue setup" : "Review setup"}
          </Button>
        </Card>

        <div>
          <Title order={2} size="h4" mb="sm">
            How it works
          </Title>
          <JoinFlowchart year={year} event={event} />
        </div>

        <div>
          <Title order={2} size="h4" mb="sm">
            Details
          </Title>
          <Stack gap="md">
            <PhaseCard
              title="1 · Joining"
              items={[
                "Join via an invite link, apply on the public page, or get added by an officer.",
                "Officers review applications and update member roles as people get involved.",
              ]}
            />
            <PhaseCard
              title="2 · Getting ready"
              items={[
                "Guided setup walks through your RSVP and camp questions as the event approaches.",
                ...(features.map
                  ? [
                      "List your tents and vehicles on Your gear so officers can place them on the camp map.",
                    ]
                  : []),
                ...(features.tickets
                  ? [
                      burningMan
                        ? "Request Directed Group Sale tickets and Setup Access Passes as needed."
                        : "Request camp tickets and early-arrival passes as needed.",
                    ]
                  : []),
              ]}
            />
            <PhaseCard
              title="3 · Next year"
              items={[
                "Your account and camp role carry over when officers start a new year.",
                "RSVPs, yearly questions, gear lists, and tickets start fresh.",
                "Returning campers can copy last year's gear in one click on Your gear.",
              ]}
            />
          </Stack>
        </div>
      </Stack>
    </Container>
  );
}

function PhaseCard({ title, items }: { title: string; items: string[] }) {
  return (
    <Card withBorder padding="md" radius="md">
      <Text fw={600} mb="xs">
        {title}
      </Text>
      <List size="sm" spacing={4}>
        {items.map((it) => (
          <List.Item key={it}>{it}</List.Item>
        ))}
      </List>
    </Card>
  );
}
