import {
  Button,
  Container,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { authClient } from "~/lib/auth-client";

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      // Room for the random suffix inside a 63-character DNS label: the slug
      // is the camp's subdomain when those are on (app/lib/camp-host.ts).
      .slice(0, 50)
      .replace(/-+$/g, "")
  );
}

/**
 * Make a camp, with the signed-in user as its first admin, and make it the
 * active one. Shown on the home page to someone in no camp yet, and at
 * /new-camp to someone who already has one.
 *
 * `doneUrl` is where to go afterwards. When it's on another origin (a camp
 * subdomain making a camp, which has to land on the NEW camp's subdomain),
 * it's a full page load: the apex then sends the browser on to the camp the
 * session now has active.
 */
export function CreateCampForm({
  doneUrl = "/",
  firstCamp = true,
}: {
  doneUrl?: string;
  firstCamp?: boolean;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await authClient.organization.create({
      name: name.trim(),
      slug,
    });
    if (error || !data) {
      setBusy(false);
      notifications.show({
        color: "red",
        title: "Could not create camp",
        message: error?.message ?? "Unknown error",
      });
      return;
    }
    await authClient.organization.setActive({ organizationId: data.id });
    if (/^https?:\/\//.test(doneUrl)) {
      window.location.assign(doneUrl);
      return;
    }
    setBusy(false);
    revalidator.revalidate();
    navigate(doneUrl);
  }

  return (
    <Container size="sm">
      <Stack gap="md">
        <div>
          <Title order={1} size="h2">
            {firstCamp ? "Create your camp" : "Create a new camp"}
          </Title>
          <Text c="dimmed">
            {firstCamp
              ? "You're not part of a camp yet. Create one to get started — you'll be its first admin."
              : "A separate camp, with its own members and data. You'll be its first admin, and you stay in your other camps."}
          </Text>
        </div>
        <TextInput
          label="Camp name"
          placeholder="e.g. Math Camp"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <Group>
          <Button onClick={create} loading={busy} disabled={!name.trim()}>
            Create camp
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
