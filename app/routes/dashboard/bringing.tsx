import {
  ActionIcon,
  Badge,
  Button,
  Container,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { and, eq } from "drizzle-orm";
import { data, useFetcher } from "react-router";
import { type AddSize, AddStructures } from "~/components/AddStructures";
import { requireActiveEdition } from "~/lib/session.server";
import { ShapeSwatch, kindDef, kindHeight } from "~/lib/structures";
import { db } from "../../../db/client.server";
import { campEdition, mapObject } from "../../../db/schema";
import type { Route } from "./+types/bringing";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Bringing · CampTool" }];
}

type Item = {
  id: string;
  kind: string;
  name: string | null;
  width: number;
  height: number;
  placed: boolean;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  const rows = await db
    .select()
    .from(mapObject)
    .where(
      and(
        eq(mapObject.editionId, activeEdition.id),
        eq(mapObject.ownerMembershipId, active.membership.id),
      ),
    );
  // "Same as last year": the caller's items from the most recent PRIOR edition
  // (year < this one). We DON'T copy anything automatically — campers re-commit
  // each year; this just offers a one-click way to re-declare the same things.
  const prior = await db
    .select({
      kind: mapObject.kind,
      name: mapObject.name,
      width: mapObject.width,
      height: mapObject.height,
      year: campEdition.year,
    })
    .from(mapObject)
    .innerJoin(campEdition, eq(mapObject.editionId, campEdition.id))
    .where(
      and(
        eq(mapObject.ownerMembershipId, active.membership.id),
        eq(mapObject.campId, active.camp.id),
      ),
    );
  const priorYears = prior
    .map((p) => p.year)
    .filter((y) => y < activeEdition.year);
  const lastYearNum = priorYears.length ? Math.max(...priorYears) : null;
  const lastYear =
    lastYearNum != null
      ? {
          year: lastYearNum,
          items: prior
            .filter((p) => p.year === lastYearNum)
            .map((p) => ({
              kind: p.kind,
              name: p.name,
              width: p.width,
              height: p.height,
            })),
        }
      : null;

  return {
    locked: activeEdition.locked,
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      width: r.width,
      height: r.height,
      placed: r.placed,
    })) satisfies Item[],
    lastYear,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const num = (k: string, fallback = 0) => {
    const v = form.get(k);
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // All intents act only on the caller's own items, within the active edition.
  const ownItem = (id: string) =>
    and(
      eq(mapObject.id, id),
      eq(mapObject.editionId, editionId),
      eq(mapObject.ownerMembershipId, mid),
    );

  if (intent === "addItem") {
    const kind = String(form.get("kind") ?? "tent");
    const def = kindDef(kind);
    // Rigid kinds keep their fixed footprint; sizable ones may carry a
    // camper-picked width/height from the size prompt.
    const width = def.rigid
      ? def.w
      : form.has("width")
        ? Math.max(1, num("width", def.w))
        : def.w;
    const height = def.rigid
      ? def.h
      : form.has("height")
        ? Math.max(1, num("height", def.h))
        : def.h;
    await db.insert(mapObject).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      ownerMembershipId: mid,
      kind,
      placed: false,
      width,
      height,
      tallFt: kindHeight(kind),
      createdById: user.id,
    });
    return data({ ok: true });
  }

  if (intent === "updateItem") {
    const id = String(form.get("id"));
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("width")) set.width = Math.max(1, num("width"));
    if (form.has("height")) set.height = Math.max(1, num("height"));
    if (form.has("name")) {
      const v = form.get("name");
      set.name = v == null || v === "" ? null : String(v);
    }
    await db.update(mapObject).set(set).where(ownItem(id));
    return data({ ok: true });
  }

  if (intent === "removeItem") {
    await db.delete(mapObject).where(ownItem(String(form.get("id"))));
    return data({ ok: true });
  }

  if (intent === "bringSameAsLastYear") {
    // Re-derive the source server-side (don't trust the client): the caller's
    // items from the most recent prior edition. Re-declares them fresh + unplaced
    // for this year (size/name/config kept; the map is redrawn, so no position).
    const prior = await db
      .select({
        kind: mapObject.kind,
        name: mapObject.name,
        width: mapObject.width,
        height: mapObject.height,
        tallFt: mapObject.tallFt,
        config: mapObject.config,
        mirrored: mapObject.mirrored,
        year: campEdition.year,
      })
      .from(mapObject)
      .innerJoin(campEdition, eq(mapObject.editionId, campEdition.id))
      .where(
        and(eq(mapObject.ownerMembershipId, mid), eq(mapObject.campId, campId)),
      );
    const years = prior
      .map((p) => p.year)
      .filter((y) => y < activeEdition.year);
    if (years.length === 0) {
      return data({ error: "Nothing from a prior year." }, { status: 400 });
    }
    const lastYear = Math.max(...years);
    const src = prior.filter((p) => p.year === lastYear);
    await db.insert(mapObject).values(
      src.map((s) => ({
        id: crypto.randomUUID(),
        campId,
        editionId,
        ownerMembershipId: mid,
        kind: s.kind,
        name: s.name,
        width: s.width,
        height: s.height,
        tallFt: s.tallFt,
        config: s.config,
        mirrored: s.mirrored,
        placed: false,
        createdById: user.id,
      })),
    );
    return data({ ok: true, added: src.length });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Bringing({ loaderData }: Route.ComponentProps) {
  const { items, locked, lastYear } = loaderData;
  const fetcher = useFetcher();

  function add(kind: string, size?: AddSize) {
    const fields: Record<string, string> = { intent: "addItem", kind };
    if (size?.width != null) fields.width = String(Math.round(size.width));
    if (size?.height != null) fields.height = String(Math.round(size.height));
    fetcher.submit(fields, { method: "post" });
  }

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>What you're bringing</Title>
          <Text c="dimmed" size="sm">
            List your structures and vehicles so officers can place them on the
            camp map. Sizes are in feet — set them as accurately as you can.
          </Text>
        </div>

        {/* A returning camper re-commits each year; this just makes re-declaring
        last year's gear one click. Shown only before they've added anything. */}
        {!locked && lastYear && items.length === 0 ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm">
                  Bringing the same as {lastYear.year}?
                </Text>
                <Text size="xs" c="dimmed" mt={2}>
                  Last year you brought:{" "}
                  {lastYear.items
                    .map(
                      (it) =>
                        `${it.name ? `${it.name} ` : ""}${kindDef(it.kind).label} (${Math.round(it.width)}×${Math.round(it.height)}′)`,
                    )
                    .join(", ")}
                  . Add them again to re-declare for this year (officers
                  re-place them on the new map).
                </Text>
              </div>
              <Button
                size="xs"
                onClick={() =>
                  fetcher.submit(
                    { intent: "bringSameAsLastYear" },
                    { method: "post" },
                  )
                }
                loading={fetcher.state !== "idle"}
                style={{ flex: "0 0 auto" }}
              >
                Bring these again
              </Button>
            </Group>
          </Paper>
        ) : null}

        {locked ? (
          <Paper
            withBorder
            p="md"
            radius="md"
            bg="var(--mantine-color-default-hover)"
          >
            <Text size="sm" c="dimmed">
              This year is locked — your inventory is read-only. Switch to an
              open year to make changes.
            </Text>
          </Paper>
        ) : (
          <Paper withBorder p="md" radius="md">
            <Text fw={600} size="sm" mb="xs">
              Add an item
            </Text>
            <AddStructures onAdd={add} />
          </Paper>
        )}

        {items.length === 0 ? (
          <Text c="dimmed">
            {locked
              ? "Nothing was declared for this year."
              : "Nothing yet. Add what you're bringing using the buttons above."}
          </Text>
        ) : (
          <Stack gap="sm">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                fetcher={fetcher}
                locked={locked}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

function ItemRow({
  item,
  fetcher,
  locked,
}: {
  item: Item;
  fetcher: ReturnType<typeof useFetcher>;
  locked: boolean;
}) {
  const def = kindDef(item.kind);
  function commit(fields: Record<string, string | number>) {
    fetcher.submit(
      { intent: "updateItem", id: item.id, ...fields },
      { method: "post" },
    );
  }

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Group gap="sm" wrap="nowrap" align="center">
          <ShapeSwatch kind={def} size={22} />
          <div>
            <Group gap={6}>
              <Text fw={600} size="sm">
                {def.label}
              </Text>
              {item.placed ? (
                <Badge size="xs" color="green" variant="light">
                  placed
                </Badge>
              ) : (
                <Badge size="xs" color="gray" variant="light">
                  not placed
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {def.rigid
                ? `${round(item.width)}′ × ${round(item.height)}′ (fixed)`
                : def.vehicle
                  ? `${round(item.width)}′ wide × adjustable length`
                  : "adjustable"}
            </Text>
          </div>
        </Group>

        <Group gap="sm" wrap="nowrap" align="flex-end">
          <TextInput
            size="xs"
            label="Name"
            w={130}
            placeholder="optional"
            disabled={locked}
            defaultValue={item.name ?? ""}
            onBlur={(e) => commit({ name: e.currentTarget.value })}
          />
          {def.rigid ? null : def.vehicle ? (
            <NumberInput
              size="xs"
              label="Length (ft)"
              w={110}
              min={6}
              disabled={locked}
              defaultValue={Math.round(item.height)}
              onBlur={(e) =>
                commit({
                  height: Math.max(6, Number(e.currentTarget.value) || 6),
                })
              }
            />
          ) : (
            <>
              <NumberInput
                size="xs"
                label="Width (ft)"
                w={90}
                min={1}
                disabled={locked}
                defaultValue={Math.round(item.width)}
                onBlur={(e) =>
                  commit({
                    width: Math.max(1, Number(e.currentTarget.value) || 1),
                  })
                }
              />
              <NumberInput
                size="xs"
                label="Depth (ft)"
                w={90}
                min={1}
                disabled={locked}
                defaultValue={Math.round(item.height)}
                onBlur={(e) =>
                  commit({
                    height: Math.max(1, Number(e.currentTarget.value) || 1),
                  })
                }
              />
            </>
          )}
          {locked ? null : (
            <Tooltip label="Remove">
              <ActionIcon
                variant="subtle"
                color="red"
                mb={4}
                onClick={() =>
                  fetcher.submit(
                    { intent: "removeItem", id: item.id },
                    { method: "post" },
                  )
                }
              >
                ✕
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
    </Paper>
  );
}

function round(v: number) {
  return Math.round(v * 2) / 2;
}
