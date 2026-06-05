import { Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";
import type { Route } from "./+types/_index";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "CampTool" },
    {
      name: "description",
      content: "Registration & management for Burning Man theme camps.",
    },
  ];
}

export default function Index() {
  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Title order={1}>CampTool</Title>
        <Text c="dimmed">
          Registration and management for Burning Man theme camps — members, the
          camp map, dues, onboarding, docs, announcements, and Discord outreach,
          all self-hosted.
        </Text>
        <Group>
          <Button component={Link} to="/dashboard">
            Enter dashboard
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
