import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useFetcher } from "react-router";

/** A camp name as a camp address: lowercase, dashes, one DNS label. */
export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/**
 * The camp's name and address, posted to `/new-camp` (or a setup link's
 * `/new-camp/:token`), which makes the camp with the signed-in user as its
 * first admin and sends the browser to it.
 *
 * The address follows the name until it's edited by hand. `apexHost` is the
 * shared site's host when camps get subdomains, so the field reads as the
 * address it is; null on a single-camp site, where it's only the public page's
 * `/c/<address>`.
 */
export function CreateCampForm({
  action,
  apexHost,
}: {
  action: string;
  apexHost: string | null;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const busy = fetcher.state !== "idle";
  const shownSlug = slugEdited ? slug : slugify(name);

  return (
    <fetcher.Form method="post" action={action}>
      <Stack gap="md">
        {fetcher.data?.error ? (
          <Alert color="red">{fetcher.data.error}</Alert>
        ) : null}
        <TextInput
          label="Camp name"
          name="name"
          placeholder="e.g. Math Camp"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          required
        />
        <TextInput
          label={apexHost ? "Camp address" : "Camp page address"}
          description={
            apexHost
              ? "Where your camp lives. Lowercase letters, numbers and dashes."
              : "Your camp's public page is /c/ followed by this."
          }
          name="slug"
          value={shownSlug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.currentTarget.value.toLowerCase());
          }}
          rightSection={
            apexHost ? (
              <Text
                size="sm"
                c="dimmed"
                pr="xs"
                style={{ whiteSpace: "nowrap" }}
              >
                .{apexHost}
              </Text>
            ) : undefined
          }
          rightSectionWidth={apexHost ? apexHost.length * 8 + 24 : undefined}
          required
        />
        <Group>
          <Button
            type="submit"
            loading={busy}
            disabled={!name.trim() || !shownSlug}
          >
            Create camp
          </Button>
        </Group>
      </Stack>
    </fetcher.Form>
  );
}
