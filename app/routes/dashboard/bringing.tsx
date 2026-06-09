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
import { requireActiveEdition } from "~/lib/session.server";
import { KINDS, ShapeSwatch, kindDef } from "~/lib/structures";
import { db } from "../../../db/client.server";
import { mapObject } from "../../../db/schema";
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
    await db.insert(mapObject).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      ownerMembershipId: mid,
      kind,
      placed: false,
      width: def.w,
      height: def.h,
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

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Bringing({ loaderData }: Route.ComponentProps) {
  const { items, locked } = loaderData;
  const fetcher = useFetcher();

  function add(kind: string) {
    fetcher.submit({ intent: "addItem", kind }, { method: "post" });
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

        {locked ? (
          <Paper withBorder p="md" radius="md" bg="var(--mantine-color-gray-0)">
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
            <Group gap="xs">
              {KINDS.map((k) => (
                <Button
                  key={k.value}
                  size="xs"
                  variant="default"
                  leftSection={<ShapeSwatch kind={k} size={14} />}
                  onClick={() => add(k.value)}
                >
                  {k.label}
                </Button>
              ))}
            </Group>
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
