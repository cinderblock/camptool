/**
 * A camp's public programming lineup — what they're offering the event, open
 * to anyone. No auth: this is the page you'd put on a flyer or a QR code.
 * Exists only while the `programming` feature is fully ON (preview means
 * "officers exploring internally" and must not publish a public surface).
 * Design: plans/programming-offerings.md.
 */
import {
  Badge,
  Card,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { eq } from "drizzle-orm";
import { data } from "react-router";
import { CampHero } from "~/components/CampHero";
import { getFeatureState } from "~/lib/features.server";
import {
  durationLabel,
  offeringKindColor,
  offeringKindLabel,
  presenterName,
} from "~/lib/programming";
import { loadPublicLineup } from "~/lib/programming.server";
import { dateLabel, timeRangeLabel, todayIso } from "~/lib/schedule";
import { loadCampEditions } from "~/lib/session.server";
import { db } from "../../db/client.server";
import { camp } from "../../db/schema";
import type { Route } from "./+types/c.$slug.schedule";

export function meta({ data: d }: Route.MetaArgs) {
  const name = d?.campName ?? "Camp";
  return [{ title: `${name} — what's on · CampTool` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const [found] = await db
    .select({
      id: camp.id,
      name: camp.name,
      logo: camp.logo,
      description: camp.description,
    })
    .from(camp)
    .where(eq(camp.slug, params.slug))
    .limit(1);
  if (!found) throw data("Camp not found", { status: 404 });
  // Same gate as /c/:slug — fully ON only, and a 404 rather than a bounce:
  // there's no session here, and a camp that turned this off shouldn't
  // advertise that the page ever existed.
  if ((await getFeatureState(found.id, "programming")) !== "on") {
    throw data("Camp not found", { status: 404 });
  }

  // The public sees the current year — editions come back newest-first.
  const editions = await loadCampEditions(found.id);
  const current = editions[0] ?? null;

  return {
    campName: found.name,
    campLogo: found.logo,
    campDescription: found.description,
    year: current?.year ?? null,
    lineup: current ? await loadPublicLineup(found.id, current.id) : [],
  };
}

export default function PublicSchedule({ loaderData }: Route.ComponentProps) {
  const { campName, campLogo, campDescription, year, lineup } = loaderData;
  const today = todayIso();

  // One heading per day, in order. The lineup already arrives sorted by
  // (date, start time), so a single pass groups it.
  const days: { date: string; items: typeof lineup }[] = [];
  for (const item of lineup) {
    const last = days[days.length - 1];
    if (last?.date === item.date) last.items.push(item);
    else days.push({ date: item.date, items: [item] });
  }

  return (
    <Container size="sm" py="xl" id="main-content">
      <Stack gap="lg">
        <CampHero
          name={campName}
          logo={campLogo}
          description={campDescription}
          tagline="Here's what we're offering this year — everyone's welcome."
        />
        <div>
          <Title order={2}>What&rsquo;s on{year ? ` in ${year}` : ""}</Title>
          <Text c="dimmed" size="sm">
            Everything here is open to everyone — just show up.
          </Text>
        </div>

        {days.length === 0 ? (
          <Text c="dimmed">
            Nothing scheduled yet — check back closer to the event.
          </Text>
        ) : (
          days.map((day) => (
            <section key={day.date}>
              <Text fw={600} mb="xs">
                {dateLabel(day.date)}
                {day.date < today ? " · past" : ""}
              </Text>
              <Stack gap="xs">
                {day.items.map((item) => {
                  const cancelled = item.sessionStatus === "cancelled";
                  return (
                    <Card key={item.sessionId} withBorder radius="md" p="sm">
                      <Group gap="xs" wrap="wrap">
                        <Text
                          fw={600}
                          td={cancelled ? "line-through" : undefined}
                          c={cancelled ? "dimmed" : undefined}
                        >
                          {item.title}
                        </Text>
                        <Badge
                          size="sm"
                          color={offeringKindColor(item.kind)}
                          variant="light"
                        >
                          {offeringKindLabel(item.kind)}
                        </Badge>
                        {cancelled ? (
                          <Badge size="sm" color="red" variant="light">
                            Cancelled
                          </Badge>
                        ) : null}
                      </Group>
                      <Text size="sm" c="dimmed">
                        {[
                          timeRangeLabel(item.startTime, item.endTime),
                          item.location,
                          durationLabel(item.durationMin),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                      {item.presenters.length > 0 ? (
                        <Text size="sm" c="dimmed">
                          with{" "}
                          {item.presenters
                            .map((p) => presenterName(p))
                            .join(", ")}
                        </Text>
                      ) : null}
                      {item.description ? (
                        <Text size="sm" mt={4}>
                          {item.description}
                        </Text>
                      ) : null}
                    </Card>
                  );
                })}
              </Stack>
            </section>
          ))
        )}
      </Stack>
    </Container>
  );
}
