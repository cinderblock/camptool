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
import { and, eq } from "drizzle-orm";
import { Form, data, redirect } from "react-router";
import { CURRENT_EVENT_YEAR } from "~/lib/brc";
import { BURNING_MAN, EVENTS, eventLabel, isEvent } from "~/lib/events";
import { hasAtLeast } from "~/lib/permissions";
import {
  loadCampEditions,
  requireActiveCamp,
  setEditionCookie,
} from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { campEdition, placement } from "../../../db/schema";
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
      event: e.event,
      locked: e.locked,
    })),
  };
}

/** Copy a source edition's **lot setup** (placement geometry) into a fresh
 * edition — NOT the placed map objects or campers' declarations. A new year's map
 * is redrawn and campers re-commit what they're bringing (with a "same as last
 * year" shortcut on the Bringing page), so we only carry the lot as a starting
 * point the officer can adjust. */
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

    const eventRaw = String(form.get("event") ?? BURNING_MAN);
    const event = isEvent(eventRaw) ? eventRaw : BURNING_MAN;

    const id = crypto.randomUUID();
    await db.insert(campEdition).values({
      id,
      campId,
      year,
      label: labelRaw || null,
      event,
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
            one. Lock a year to make it read-only. Copying a year brings forward
            only the lot setup as a starting point — the map is redrawn and
            campers re-commit what they're bringing (with a one-click "same as
            last year" on the Bringing page).
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
                  label="Event"
                  name="event"
                  defaultValue={BURNING_MAN}
                  data={EVENTS.map((e) => ({ value: e.value, label: e.label }))}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                  w={150}
                />
                <Select
                  size="xs"
                  label="Copy lot setup from (optional)"
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
              <Table.Th>Event</Table.Th>
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
                    <Text size="sm" c="dimmed">
                      {eventLabel(e.event)}
                    </Text>
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
