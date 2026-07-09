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
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates } from "~/lib/features.server";
import { requireActiveEdition } from "~/lib/session.server";
import { loadWizardState } from "~/lib/wizard.server";
import type { Route } from "./+types/guide";

export function meta(_: Route.MetaArgs) {
  return [{ title: "How camp works · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  const state = await loadWizardState({
    campId: active.camp.id,
    editionId: activeEdition.id,
    membershipId: active.membership.id,
    role: active.membership.role,
    year: activeEdition.year,
  });
  const featureStates = await loadFeatureStates(active.camp.id);
  const seeFeature = (key: Parameters<typeof featureStates.get>[0]) =>
    featureVisibleTo(featureStates.get(key) ?? "off", active.membership.role);
  return {
    campName: active.camp.name,
    year: activeEdition.year,
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
  };
}

export default function Guide({ loaderData }: Route.ComponentProps) {
  const {
    campName,
    year,
    weeksToEvent,
    scheduled,
    resolved,
    pendingCount,
    features,
  } = loaderData;
  const doneCount = scheduled.filter((s) => resolved[s.key]).length;

  return (
    <Container size="md">
      <Stack gap="xl">
        <div>
          <Title order={1} size="h2">
            How {campName} works
          </Title>
          <Text c="dimmed" size="sm">
            From joining to the playa and back again next year
            {weeksToEvent > 0 ? ` — about ${weeksToEvent} weeks out` : ""}.
          </Text>
        </div>

        <Card withBorder padding="lg" radius="md">
          <Group justify="space-between" mb="md">
            <Text fw={600}>Where you are — {year}</Text>
            <Badge
              variant="light"
              color={pendingCount === 0 ? "green" : "blue"}
            >
              {doneCount} of {scheduled.length} done
            </Badge>
          </Group>
          {scheduled.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing to do right now — you're all set for {year}.
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
          {pendingCount > 0 ? (
            <Button
              component={Link}
              to="/start"
              mt="md"
              variant="light"
              w="fit-content"
            >
              Continue setup
            </Button>
          ) : null}
        </Card>

        <div>
          <Title order={2} size="h4" mb="sm">
            Joining {campName} — the big picture
          </Title>
          <JoinFlowchart year={year} />
        </div>

        <div>
          <Title order={2} size="h4" mb="sm">
            The details
          </Title>
          <Stack gap="md">
            <PhaseCard
              title="1 · Joining"
              items={[
                "Redeem a friend's one-time invite link (the usual way in), apply on the public page, or get added by an officer.",
                "Officers review applications — accept, waitlist, or pass.",
                "Recruits become full members as they get involved.",
              ]}
            />
            <PhaseCard
              title="2 · Getting ready for the burn"
              items={[
                "The setup wizard asks for what's relevant as the event nears — an RSVP and whatever else the camp collects.",
                ...(features.map
                  ? [
                      "Declare your tents/vehicles; officers place them on the camp map (you can tweak your own spot).",
                    ]
                  : []),
                ...(features.tickets
                  ? [
                      "Request a Directed Group Sale ticket and any early-arrival passes.",
                    ]
                  : []),
              ]}
            />
            <PhaseCard
              title="3 · Next year"
              items={[
                "We start a new year — your account and camp role carry over.",
                "Per-year things reset: RSVP, answers, what you're bringing, tickets.",
                "Last year's map can be copied as a starting point.",
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
