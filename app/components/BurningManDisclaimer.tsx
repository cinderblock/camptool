import { Text } from "@mantine/core";
import type { MantineSpacing, StyleProp } from "@mantine/core";

/**
 * Trademark disclaimer for the app's Burning Man–related features (the Black Rock
 * City map, ticket & setup-pass tracking). CampTool is an independent,
 * open-source project — this notice makes clear it isn't an official tool.
 */
export function BurningManDisclaimer({
  mt = "md",
}: {
  mt?: StyleProp<MantineSpacing>;
}) {
  return (
    <Text size="xs" c="dimmed" ta="center" mt={mt}>
      This app is not affiliated, endorsed, or verified by Burning Man Project.
    </Text>
  );
}
