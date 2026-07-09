import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, asc, eq } from "drizzle-orm";
import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import {
  inventoryCategory,
  inventoryItem,
  membership,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/supplies";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp supplies · CampTool" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "supplies");
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const role = active.membership.role;
  const canManage = hasAtLeast(role, "officer");

  const categories = await db
    .select()
    .from(inventoryCategory)
    .where(eq(inventoryCategory.campId, campId))
    .orderBy(
      asc(inventoryCategory.sortOrder),
      asc(inventoryCategory.createdAt),
    );

  const itemRows = await db
    .select({
      id: inventoryItem.id,
      categoryId: inventoryItem.categoryId,
      name: inventoryItem.name,
      quantity: inventoryItem.quantity,
      notes: inventoryItem.notes,
      ownerMembershipId: inventoryItem.ownerMembershipId,
      ownerName: user.name,
      ownerPlaya: membership.playaName,
    })
    .from(inventoryItem)
    .leftJoin(membership, eq(inventoryItem.ownerMembershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(
      and(
        eq(inventoryItem.campId, campId),
        eq(inventoryItem.editionId, editionId),
      ),
    )
    .orderBy(asc(inventoryItem.sortOrder), asc(inventoryItem.createdAt));

  const items = itemRows.map((r) => ({
    id: r.id,
    categoryId: r.categoryId,
    name: r.name,
    quantity: r.quantity,
    notes: r.notes,
    ownerMembershipId: r.ownerMembershipId,
    ownerName: r.ownerPlaya || r.ownerName || null,
  }));

  let roster: { value: string; label: string }[] = [];
  if (canManage) {
    const rows = await db
      .select({
        id: membership.id,
        name: user.name,
        playa: membership.playaName,
      })
      .from(membership)
      .leftJoin(user, eq(membership.userId, user.id))
      .where(
        and(
          eq(membership.organizationId, campId),
          eq(membership.status, "active"),
        ),
      );
    roster = rows.map((r) => ({
      value: r.id,
      label: r.playa || r.name || "Member",
    }));
  }

  return {
    canManage,
    locked: activeEdition.locked,
    year: activeEdition.year,
    myMembershipId: active.membership.id,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    items,
    roster,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "supplies");
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  const mid = active.membership.id;
  const canManage = hasAtLeast(active.membership.role, "officer");
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }

  // Confirm an item belongs to this camp + edition before touching it.
  const ownItem = async (id: string) => {
    const [row] = await db
      .select({ id: inventoryItem.id, owner: inventoryItem.ownerMembershipId })
      .from(inventoryItem)
      .where(
        and(
          eq(inventoryItem.id, id),
          eq(inventoryItem.campId, campId),
          eq(inventoryItem.editionId, editionId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  // --- Member self-service: claim / unclaim an item to bring. ---
  if (intent === "claim" || intent === "unclaim") {
    const id = String(form.get("id"));
    const item = await ownItem(id);
    if (!item) return data({ error: "Item not found." }, { status: 404 });
    if (intent === "claim") {
      // Only claim if unclaimed (don't steal someone else's).
      if (item.owner && item.owner !== mid) {
        return data({ error: "Already claimed." }, { status: 409 });
      }
      await db
        .update(inventoryItem)
        .set({ ownerMembershipId: mid, updatedAt: new Date() })
        .where(eq(inventoryItem.id, id));
    } else if (item.owner === mid) {
      await db
        .update(inventoryItem)
        .set({ ownerMembershipId: null, updatedAt: new Date() })
        .where(eq(inventoryItem.id, id));
    }
    return data({ ok: true });
  }

  // --- Everything below is officer-only management. ---
  if (!canManage) {
    return data({ error: "You don't have permission." }, { status: 403 });
  }

  switch (intent) {
    case "addCategory": {
      const [last] = await db
        .select({ sortOrder: inventoryCategory.sortOrder })
        .from(inventoryCategory)
        .where(eq(inventoryCategory.campId, campId))
        .orderBy(asc(inventoryCategory.sortOrder));
      await db.insert(inventoryCategory).values({
        id: crypto.randomUUID(),
        campId,
        name: "New category",
        sortOrder: (last?.sortOrder ?? 0) + 1,
      });
      return data({ ok: true });
    }
    case "renameCategory": {
      const name = String(form.get("name") ?? "").trim();
      if (!name)
        return data({ error: "Name can't be empty." }, { status: 400 });
      await db
        .update(inventoryCategory)
        .set({ name })
        .where(
          and(
            eq(inventoryCategory.id, String(form.get("id"))),
            eq(inventoryCategory.campId, campId),
          ),
        );
      return data({ ok: true });
    }
    case "deleteCategory": {
      await db
        .delete(inventoryCategory)
        .where(
          and(
            eq(inventoryCategory.id, String(form.get("id"))),
            eq(inventoryCategory.campId, campId),
          ),
        );
      return data({ ok: true });
    }
    case "addItem": {
      const categoryId = String(form.get("categoryId"));
      // Confirm the category is ours before adding into it.
      const [cat] = await db
        .select({ id: inventoryCategory.id })
        .from(inventoryCategory)
        .where(
          and(
            eq(inventoryCategory.id, categoryId),
            eq(inventoryCategory.campId, campId),
          ),
        )
        .limit(1);
      if (!cat) return data({ error: "Category not found." }, { status: 404 });
      await db.insert(inventoryItem).values({
        id: crypto.randomUUID(),
        campId,
        editionId,
        categoryId,
        name: "New item",
      });
      return data({ ok: true });
    }
    case "updateItem": {
      const id = String(form.get("id"));
      if (!(await ownItem(id)))
        return data({ error: "Item not found." }, { status: 404 });
      const field = String(form.get("field"));
      const raw = String(form.get("value") ?? "");
      const set: Partial<typeof inventoryItem.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (field === "name") {
        if (!raw.trim())
          return data({ error: "Name can't be empty." }, { status: 400 });
        set.name = raw.trim();
      } else if (field === "notes") {
        set.notes = raw.trim() || null;
      } else if (field === "quantity") {
        set.quantity = Math.max(0, Math.round(Number(raw) || 0));
      } else {
        return data({ error: "Unknown field." }, { status: 400 });
      }
      await db.update(inventoryItem).set(set).where(eq(inventoryItem.id, id));
      return data({ ok: true });
    }
    case "assignOwner": {
      const id = String(form.get("id"));
      if (!(await ownItem(id)))
        return data({ error: "Item not found." }, { status: 404 });
      const membershipId = String(form.get("membershipId") ?? "");
      let owner: string | null = null;
      if (membershipId) {
        const [m] = await db
          .select({ id: membership.id })
          .from(membership)
          .where(
            and(
              eq(membership.id, membershipId),
              eq(membership.organizationId, campId),
            ),
          )
          .limit(1);
        if (!m) return data({ error: "Not a camp member." }, { status: 400 });
        owner = m.id;
      }
      await db
        .update(inventoryItem)
        .set({ ownerMembershipId: owner, updatedAt: new Date() })
        .where(eq(inventoryItem.id, id));
      return data({ ok: true });
    }
    case "deleteItem": {
      const id = String(form.get("id"));
      await db
        .delete(inventoryItem)
        .where(and(eq(inventoryItem.id, id), eq(inventoryItem.campId, campId)));
      return data({ ok: true });
    }
    default:
      return data({ error: "Unknown action." }, { status: 400 });
  }
}

type FetcherData = { ok?: boolean; error?: string };
type LoaderData = Route.ComponentProps["loaderData"];
type Item = LoaderData["items"][number];

export default function Supplies({ loaderData }: Route.ComponentProps) {
  const { categories, items, canManage, locked, year, roster, myMembershipId } =
    loaderData;

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Camp supplies</Title>
          <Text c="dimmed" size="sm">
            Shared camp gear for {year}, by group — what we need and who's
            bringing it. (Your own tents/vehicles live under Bringing.)
          </Text>
        </div>

        {locked ? (
          <Text size="sm" c="dimmed">
            This year is locked — supplies are read-only.
          </Text>
        ) : null}

        {categories.length === 0 ? (
          <Text c="dimmed">
            No supply groups yet.{canManage ? " Add the first one below." : ""}
          </Text>
        ) : (
          categories.map((c) => (
            <CategoryCard
              key={c.id}
              category={c}
              items={items.filter((i) => i.categoryId === c.id)}
              canManage={canManage}
              locked={locked}
              roster={roster}
              myMembershipId={myMembershipId}
            />
          ))
        )}

        {canManage && !locked ? <AddCategory /> : null}
      </Stack>
    </Container>
  );
}

function CategoryCard({
  category,
  items,
  canManage,
  locked,
  roster,
  myMembershipId,
}: {
  category: { id: string; name: string };
  items: Item[];
  canManage: boolean;
  locked: boolean;
  roster: { value: string; label: string }[];
  myMembershipId: string;
}) {
  const fetcher = useFetcher<FetcherData>();
  useFetcherError(fetcher.data, fetcher.state);
  const claimed = items.filter((i) => i.ownerMembershipId).length;

  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" wrap="nowrap" mb="sm">
        {canManage && !locked ? (
          <TextInput
            variant="unstyled"
            size="md"
            fw={600}
            defaultValue={category.name}
            onBlur={(e) =>
              e.currentTarget.value.trim() &&
              e.currentTarget.value !== category.name &&
              fetcher.submit(
                {
                  intent: "renameCategory",
                  id: category.id,
                  name: e.currentTarget.value,
                },
                { method: "post" },
              )
            }
            styles={{ input: { fontWeight: 600, fontSize: 18 } }}
          />
        ) : (
          <Text fw={600} size="lg">
            {category.name}
          </Text>
        )}
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed">
            {claimed}/{items.length} covered
          </Text>
          {canManage && !locked ? (
            <Tooltip label="Delete group (and its items)">
              <ActionIcon
                variant="subtle"
                color="red"
                onClick={() =>
                  fetcher.submit(
                    { intent: "deleteCategory", id: category.id },
                    { method: "post" },
                  )
                }
              >
                ×
              </ActionIcon>
            </Tooltip>
          ) : null}
        </Group>
      </Group>

      <Stack gap="xs">
        {items.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing listed yet.
          </Text>
        ) : (
          items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              canManage={canManage}
              locked={locked}
              roster={roster}
              mine={item.ownerMembershipId === myMembershipId}
            />
          ))
        )}
      </Stack>

      {canManage && !locked ? (
        <Button
          mt="sm"
          size="compact-xs"
          variant="subtle"
          loading={fetcher.state !== "idle"}
          onClick={() =>
            fetcher.submit(
              { intent: "addItem", categoryId: category.id },
              { method: "post" },
            )
          }
        >
          + Add item
        </Button>
      ) : null}
    </Card>
  );
}

function ItemRow({
  item,
  canManage,
  locked,
  roster,
  mine,
}: {
  item: Item;
  canManage: boolean;
  locked: boolean;
  roster: { value: string; label: string }[];
  mine: boolean;
}) {
  const fetcher = useFetcher<FetcherData>();
  useFetcherError(fetcher.data, fetcher.state);
  const save = (field: string, value: string) =>
    fetcher.submit(
      { intent: "updateItem", id: item.id, field, value },
      { method: "post" },
    );

  return (
    <Group gap="sm" wrap="wrap" align="center">
      {canManage && !locked ? (
        <>
          <NumberInput
            size="xs"
            w={64}
            min={0}
            defaultValue={item.quantity}
            onBlur={(e) => save("quantity", e.currentTarget.value)}
            aria-label="Quantity"
          />
          <TextInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            defaultValue={item.name}
            onBlur={(e) =>
              e.currentTarget.value !== item.name &&
              save("name", e.currentTarget.value)
            }
            aria-label="Item name"
          />
          <TextInput
            size="xs"
            w={160}
            placeholder="notes"
            defaultValue={item.notes ?? ""}
            onBlur={(e) =>
              e.currentTarget.value !== (item.notes ?? "") &&
              save("notes", e.currentTarget.value)
            }
          />
          <Select
            size="xs"
            w={150}
            placeholder="Unclaimed"
            data={roster}
            value={item.ownerMembershipId}
            onChange={(v) =>
              fetcher.submit(
                { intent: "assignOwner", id: item.id, membershipId: v ?? "" },
                { method: "post" },
              )
            }
            clearable
            searchable
            comboboxProps={{ withinPortal: true }}
          />
          <Tooltip label="Delete item">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() =>
                fetcher.submit(
                  { intent: "deleteItem", id: item.id },
                  { method: "post" },
                )
              }
            >
              ×
            </ActionIcon>
          </Tooltip>
        </>
      ) : (
        <>
          <Text size="sm" w={36} c="dimmed" ta="right">
            ×{item.quantity}
          </Text>
          <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
            {item.name}
            {item.notes ? (
              <Text component="span" c="dimmed" size="xs">
                {" "}
                — {item.notes}
              </Text>
            ) : null}
          </Text>
          {item.ownerName ? (
            <Badge variant="light" color="green">
              {item.ownerName}
            </Badge>
          ) : (
            <Text size="xs" c="dimmed">
              unclaimed
            </Text>
          )}
          {!locked ? (
            item.ownerMembershipId ? (
              mine ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "unclaim", id: item.id },
                      { method: "post" },
                    )
                  }
                >
                  Unclaim
                </Button>
              ) : null
            ) : (
              <Button
                size="compact-xs"
                variant="light"
                onClick={() =>
                  fetcher.submit(
                    { intent: "claim", id: item.id },
                    { method: "post" },
                  )
                }
              >
                I'll bring this
              </Button>
            )
          ) : null}
        </>
      )}
    </Group>
  );
}

function AddCategory() {
  const fetcher = useFetcher<FetcherData>();
  useFetcherError(fetcher.data, fetcher.state);
  return (
    <Button
      variant="light"
      w="fit-content"
      loading={fetcher.state !== "idle"}
      onClick={() =>
        fetcher.submit({ intent: "addCategory" }, { method: "post" })
      }
    >
      + Add supply group
    </Button>
  );
}

function useFetcherError(
  d: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
) {
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !d || d === seen.current) return;
    seen.current = d;
    if (d.error) {
      notifications.show({ color: "red", title: "Error", message: d.error });
    }
  }, [d, state]);
}
