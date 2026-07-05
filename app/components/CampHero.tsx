import { Image, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * Public-page header for a camp: logo, name, the officer-authored blurb, and a
 * context line ("apply here" / "so-and-so invited you"). Shared by the public
 * application page (/c/:slug) and the invite-redeem page (/i/:token) so a
 * stranger gets the same introduction on both doors.
 */
export function CampHero({
  name,
  logo,
  description,
  tagline,
}: {
  name: string;
  logo: string | null;
  description: string | null;
  tagline: ReactNode;
}) {
  return (
    <Stack gap="xs" align="center">
      {logo ? <Image src={logo} alt={name} w={96} h={96} radius="md" /> : null}
      <Title order={1} ta="center">
        {name}
      </Title>
      {description ? (
        <Text style={{ whiteSpace: "pre-line" }}>{description}</Text>
      ) : null}
      <Text c="dimmed" ta="center">
        {tagline}
      </Text>
    </Stack>
  );
}
