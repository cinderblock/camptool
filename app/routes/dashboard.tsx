import { Card, Container, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { Route } from "./+types/dashboard";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Dashboard · CampTool" }];
}

const SECTIONS = [
  { title: "Members", note: "Admins, officers, members, recruits — coming next." },
  { title: "Camp map", note: "Visual placement editor — planned." },
  { title: "Dues", note: "Optional financials — planned." },
  { title: "Onboarding", note: "New-member checklists — planned." },
  { title: "Documents", note: "Shared camp docs — planned." },
  { title: "Announcements", note: "Broadcasts + Discord — planned." },
];

export default function Dashboard() {
  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Title order={2}>Dashboard</Title>
        <Text c="dimmed">
          Scaffold only. Auth and the member directory land in the next phase.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {SECTIONS.map((s) => (
            <Card key={s.title} withBorder padding="lg" radius="md">
              <Text fw={600}>{s.title}</Text>
              <Text size="sm" c="dimmed">
                {s.note}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </Stack>
    </Container>
  );
}
