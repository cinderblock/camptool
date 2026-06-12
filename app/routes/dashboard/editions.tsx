import {
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { and, eq, inArray } from "drizzle-orm";
import { Form, data, redirect } from "react-router";
import { CURRENT_EVENT_YEAR } from "~/lib/brc";
import { hasAtLeast } from "~/lib/permissions";
import {
  loadCampEditions,
  requireActiveCamp,
  setEditionCookie,
} from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  campEdition,
  mapObject,
  mapObjectOccupant,
  placement,
} from "../../../db/schema";
import type { Route } from "./+types/editions";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Years · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveCamp(request);
  const editions = await loadCampEditions(active.camp.id);
  return {
    canManage: hasAtLeast(active.membership.role, "officer"),
    activeEditionId: activeEdition?.id ?? null,
    editions: editions.map((e) => ({
      id: e.id,
      year: e.year,
      label: e.label,
      locked: e.locked,
    })),
  };
}

/** Copy a source edition's lot + objects (+ occupants) into a fresh edition. */
async function copyEditionContents(sourceId: string, targetId: string) {
  const [lot] = await db
    .select()
    .from(placement)
    .where(eq(placement.editionId, sourceId))
    .limit(1);
  if (lot) {
    const { id: _drop, createdAt: _c, ...rest } = lot;
    await db
      .insert(placement)
      .values({ ...rest, id: crypto.randomUUID(), editionId: targetId });
  }

  const objects = await db
    .select()
    .from(mapObject)
    .where(eq(mapObject.editionId, sourceId));
  const idMap = new Map<string, string>();
  for (const o of objects) {
    const newId = crypto.randomUUID();
    idMap.set(o.id, newId);
    const { createdAt: _c, updatedAt: _u, ...rest } = o;
    await db
      .insert(mapObject)
      .values({ ...rest, id: newId, editionId: targetId });
  }

  if (idMap.size > 0) {
    const occupants = await db
      .select()
      .from(mapObjectOccupant)
      .where(inArray(mapObjectOccupant.objectId, [...idMap.keys()]));
    for (const occ of occupants) {
      const newObjectId = idMap.get(occ.objectId);
      if (!newObjectId) continue;
      await db.insert(mapObjectOccupant).values({
        id: crypto.randomUUID(),
        campId: occ.campId,
        editionId: targetId,
        objectId: newObjectId,
        membershipId: occ.membershipId,
      });
    }
  }
}

export async function action({ request }: Route.ActionArgs) {
  const { active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  const role = active.membership.role;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  // Anyone in the camp may switch which year they're viewing.
  if (intent === "setActive") {
    const editionId = String(form.get("editionId"));
    const [owned] = await db
      .select({ id: campEdition.id })
      .from(campEdition)
      .where(and(eq(campEdition.id, editionId), eq(campEdition.campId, campId)))
      .limit(1);
    if (!owned) return data({ error: "Unknown year." }, { status: 404 });
    return data(
      { ok: true },
      { headers: { "Set-Cookie": setEditionCookie(editionId) } },
    );
  }

  // Creating / locking years is an officer+ action.
  if (!hasAtLeast(role, "officer")) {
    return data({ error: "Officers manage years." }, { status: 403 });
  }

  if (intent === "create") {
    const year = Math.round(Number(form.get("year")));
    if (!Number.isFinite(year) || year < 1900 || year > 3000) {
      return data({ error: "Enter a valid year." }, { status: 400 });
    }
    const [clash] = await db
      .select({ id: campEdition.id })
      .from(campEdition)
      .where(and(eq(campEdition.campId, campId), eq(campEdition.year, year)))
      .limit(1);
    if (clash) {
      return data({ error: `${year} already exists.` }, { status: 409 });
    }

    const labelRaw = String(form.get("label") ?? "").trim();
    const copyFromId = String(form.get("copyFromId") ?? "");
    let forkedFromId: string | null = null;
    if (copyFromId) {
      const [src] = await db
        .select({ id: campEdition.id })
        .from(campEdition)
        .where(
          and(eq(campEdition.id, copyFromId), eq(campEdition.campId, campId)),
        )
        .limit(1);
      if (src) forkedFromId = src.id;
    }

    const id = crypto.randomUUID();
    await db.insert(campEdition).values({
      id,
      campId,
      year,
      label: labelRaw || null,
      forkedFromId,
    });
    if (forkedFromId) await copyEditionContents(forkedFromId, id);

    // Make the new year active.
    return redirect("/editions", {
      headers: { "Set-Cookie": setEditionCookie(id) },
    });
  }

  if (intent === "setLock") {
    const editionId = String(form.get("editionId"));
    const locked = form.get("locked") === "true";
    await db
      .update(campEdition)
      .set({ locked })
      .where(
        and(eq(campEdition.id, editionId), eq(campEdition.campId, campId)),
      );
    return redirect("/editions");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Editions({ loaderData }: Route.ComponentProps) {
  const { editions, activeEditionId, canManage } = loaderData;

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Years</Title>
          <Text c="dimmed" size="sm">
            Each year is its own edition of the camp — the map and everyone's
            inventory are scoped to it. Editing this year never changes a past
            one. Lock a year to make it read-only; copy a year to start the next
            from last year's layout.
          </Text>
        </div>

        {canManage ? (
          <Card withBorder padding="md" radius="md">
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <Group align="flex-end" wrap="wrap">
                <NumberInput
                  size="xs"
                  label="New year"
                  name="year"
                  defaultValue={CURRENT_EVENT_YEAR}
                  min={1900}
                  max={3000}
                  w={110}
                />
                <Select
                  size="xs"
                  label="Copy from (optional)"
                  name="copyFromId"
                  placeholder="Start blank"
                  clearable
                  data={editions.map((e) => ({
                    value: e.id,
                    label: e.label ? `${e.year} · ${e.label}` : String(e.year),
                  }))}
                  comboboxProps={{ withinPortal: true }}
                  w={220}
                />
                <Button type="submit" size="xs">
                  Add year
                </Button>
              </Group>
            </Form>
          </Card>
        ) : null}

        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Year</Table.Th>
              <Table.Th>Status</Table.Th>
              {canManage ? <Table.Th>Actions</Table.Th> : null}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {editions.map((e) => {
              const isActive = e.id === activeEditionId;
              return (
                <Table.Tr key={e.id}>
                  <Table.Td>
                    {e.label ? `${e.year} · ${e.label}` : e.year}
                    {isActive ? (
                      <Badge ml={8} size="xs" variant="light">
                        viewing
                      </Badge>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    {e.locked ? (
                      <Badge size="sm" color="gray" variant="light">
                        locked
                      </Badge>
                    ) : (
                      <Badge size="sm" color="green" variant="light">
                        open
                      </Badge>
                    )}
                  </Table.Td>
                  {canManage ? (
                    <Table.Td>
                      <Group gap="xs">
                        {!isActive ? (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="setActive"
                            />
                            <input
                              type="hidden"
                              name="editionId"
                              value={e.id}
                            />
                            <Button type="submit" size="xs" variant="light">
                              View
                            </Button>
                          </Form>
                        ) : null}
                        <Form method="post">
                          <input type="hidden" name="intent" value="setLock" />
                          <input type="hidden" name="editionId" value={e.id} />
                          <input
                            type="hidden"
                            name="locked"
                            value={e.locked ? "false" : "true"}
                          />
                          <Button
                            type="submit"
                            size="xs"
                            variant="subtle"
                            color={e.locked ? "blue" : "gray"}
                          >
                            {e.locked ? "Unlock" : "Lock"}
                          </Button>
                        </Form>
                      </Group>
                    </Table.Td>
                  ) : null}
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Stack>
    </Container>
  );
}
