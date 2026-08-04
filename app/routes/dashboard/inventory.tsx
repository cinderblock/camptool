import {
  Badge,
  Container,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { eq } from "drizzle-orm";
import { data } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { ShapeSwatch, kindDef } from "~/lib/structures";
import { db } from "../../../db/client.server";
import { mapObject, membership, user } from "../../../db/schema";
import type { Route } from "./+types/inventory";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Inventory · CampTool" }];
}

type Row = {
  id: string;
  kind: string;
  width: number;
  height: number;
  placed: boolean;
  ownerName: string | null;
  placeNearVehicle: boolean;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "bringing");
  if (!hasAtLeast(active.membership.role, "officer")) {
    throw data("Not authorized", { status: 403 });
  }
  const rows = await db
    .select({
      id: mapObject.id,
      kind: mapObject.kind,
      width: mapObject.width,
      height: mapObject.height,
      placed: mapObject.placed,
      placeNearVehicle: mapObject.placeNearVehicle,
      ownerName: user.name,
    })
    .from(mapObject)
    .leftJoin(membership, eq(mapObject.ownerMembershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(eq(mapObject.editionId, activeEdition.id));

  // Unplaced first (these still need an officer to place them).
  const items = rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      width: r.width,
      height: r.height,
      placed: r.placed,
      ownerName: r.ownerName,
      placeNearVehicle: r.placeNearVehicle,
    }))
    .sort(
      (a, b) =>
        Number(a.placed) - Number(b.placed) || a.kind.localeCompare(b.kind),
    ) satisfies Row[];

  return redact(privacy, { items });
}

function round(v: number) {
  return Math.round(v * 2) / 2;
}

export default function Inventory({ loaderData }: Route.ComponentProps) {
  const { items } = loaderData;
  const placed = items.filter((i) => i.placed).length;
  const unplaced = items.length - placed;

  return (
    <Container size="lg">
      <Stack gap="lg">
        <div>
          <Title order={2}>Inventory</Title>
          <Text c="dimmed" size="sm">
            Everything campers are bringing plus shared camp items — so nothing
            gets missed. {items.length} items · {placed} placed ·{" "}
            <Text
              span
              c={unplaced ? "orange" : "dimmed"}
              fw={unplaced ? 600 : 400}
            >
              {unplaced} unplaced
            </Text>
            .
          </Text>
        </div>

        {items.length === 0 ? (
          <Text c="dimmed">
            Nothing declared yet. Campers add items on their “Bringing” page;
            officers add shared items from the map legend.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={620}>
            <Table verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40} />
                  <Table.Th>Item</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Owner</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((item) => {
                  const def = kindDef(item.kind);
                  return (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <ShapeSwatch kind={def} size={18} />
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="wrap">
                          {def.label}
                          {/* The camper's placement preference — advisory, so
                              whoever arranges the map can honour it. */}
                          {item.placeNearVehicle ? (
                            <Badge size="xs" color="blue" variant="light">
                              near their vehicle
                            </Badge>
                          ) : null}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {round(item.width)}′ × {round(item.height)}′
                      </Table.Td>
                      <Table.Td>
                        {item.ownerName ?? (
                          <Text span c="dimmed">
                            camp / shared
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {item.placed ? (
                          <Badge size="sm" color="green" variant="light">
                            placed
                          </Badge>
                        ) : (
                          <Badge size="sm" color="orange" variant="light">
                            unplaced
                          </Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Container>
  );
}
