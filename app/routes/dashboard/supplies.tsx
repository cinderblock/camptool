import {
  ActionIcon,
  Anchor,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { type BinSummary, binHref, binTitle, searchBins } from "~/lib/bins";
import { getBinsStock } from "~/lib/bins-api.server";
import { featureVisibleTo } from "~/lib/features";
import { getFeatureState, requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import {
  duplicateGroups,
  findSimilarSupplies,
  resolveSupplyClaim,
} from "~/lib/supplies";
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
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
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

  // What's already in the camp's storage, read live from its bins instance
  // (plans/bins-integration.md). Absent unless the camp runs bins, has the
  // feature on and has pasted a read token — and it degrades to nothing at all
  // if the warehouse is unreachable, because not being able to reach a
  // warehouse must never stop anyone claiming a supply.
  const binsVisible = featureVisibleTo(
    await getFeatureState(campId, "bins"),
    role,
  );
  const warehouse = binsVisible ? await getBinsStock(campId) : null;

  return redact(privacy, {
    canManage,
    locked: activeEdition.locked,
    year: activeEdition.year,
    myMembershipId: active.membership.id,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    items,
    roster,
    warehouse:
      warehouse?.ok === true
        ? {
            baseUrl: warehouse.baseUrl,
            bins: warehouse.stock.bins,
            locations: warehouse.stock.locations,
            fetchedAt: warehouse.stock.fetchedAt,
          }
        : null,
  });
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

  /**
   * Member self-service: add a line for something you're bringing that nobody
   * listed. Before this, only officers could add items, so a camper who wanted
   * to bring liquor genuinely had nowhere to say so — which is the bug that was
   * reported, dressed up as a dedupe request.
   *
   * Coarse names are fine on purpose ("whiskey" now, "2 handles of rye" later),
   * so the only automatic dedupe is the unambiguous one: if a line with the
   * same name is sitting there UNCLAIMED, claim it rather than adding a second
   * row. Anything already claimed gets a second row — two people each bringing
   * whiskey is two facts, not a conflict — and the form warns first.
   */
  if (intent === "addMine") {
    const categoryId = String(form.get("categoryId"));
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
    if (!cat) return data({ error: "Group not found." }, { status: 404 });
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 120) {
      return data({ error: "Give it a name." }, { status: 400 });
    }
    const qtyRaw = Number(form.get("quantity"));
    const quantity =
      Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : 1;

    const siblings = await db
      .select({
        id: inventoryItem.id,
        name: inventoryItem.name,
        owner: inventoryItem.ownerMembershipId,
      })
      .from(inventoryItem)
      .where(
        and(
          eq(inventoryItem.campId, campId),
          eq(inventoryItem.editionId, editionId),
          eq(inventoryItem.categoryId, categoryId),
        ),
      );
    const resolved = resolveSupplyClaim(name, siblings);
    if (resolved.action === "claim") {
      await db
        .update(inventoryItem)
        .set({ ownerMembershipId: mid, updatedAt: new Date() })
        .where(eq(inventoryItem.id, resolved.target.id));
      return data({
        ok: true,
        message: `"${resolved.target.name}" was already on the list — you're down for it.`,
      });
    }
    await db.insert(inventoryItem).values({
      id: crypto.randomUUID(),
      campId,
      editionId,
      categoryId,
      name,
      quantity,
      ownerMembershipId: mid,
    });
    return data({ ok: true, message: `Added ${name}.` });
  }

  // --- Member self-service: refine a line you own. "Whiskey" on Monday can
  // become "2 handles of Bulleit rye" once you've actually bought it. ---
  if (intent === "updateMine") {
    const id = String(form.get("id"));
    const item = await ownItem(id);
    if (!item) return data({ error: "Item not found." }, { status: 404 });
    if (item.owner !== mid && !canManage) {
      return data({ error: "That isn't yours." }, { status: 403 });
    }
    const name = String(form.get("name") ?? "").trim();
    if (!name || name.length > 120) {
      return data({ error: "Give it a name." }, { status: 400 });
    }
    const qtyRaw = Number(form.get("quantity"));
    const notes = String(form.get("notes") ?? "").trim();
    await db
      .update(inventoryItem)
      .set({
        name,
        quantity:
          Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : 1,
        notes: notes || null,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItem.id, id));
    return data({ ok: true });
  }

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

type FetcherData = { ok?: boolean; error?: string; message?: string };
type LoaderData = Route.ComponentProps["loaderData"];
type Item = LoaderData["items"][number];

/**
 * "Which box is it in?" — a live lookup against the camp's bins instance,
 * shown beside the supply list so nobody buys a second roll of gaff tape when
 * there are four in storage. Read-only and best-effort: the panel simply isn't
 * there if bins isn't configured or can't be reached.
 */
function Warehouse({
  warehouse,
}: {
  warehouse: {
    baseUrl: string;
    bins: BinSummary[];
    locations: string[];
    fetchedAt: number;
  };
}) {
  const [query, setQuery] = useState("");
  const hits = useMemo(
    () => searchBins(warehouse.bins, query).slice(0, 8),
    [warehouse.bins, query],
  );
  return (
    <Card withBorder padding="md" radius="md">
      <Group justify="space-between" align="flex-start" gap="sm" mb="xs">
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Text fw={600} size="sm">
            In storage
          </Text>
          {/* Built as one string rather than interleaved JSX: SSR splits
              `{n}{" "}boxes` into separate text nodes, which reads the same but
              can't be asserted on (and copy-pastes with stray markers). */}
          <Text size="xs" c="dimmed">
            {`${warehouse.bins.length} ${
              warehouse.bins.length === 1 ? "box" : "boxes"
            }${
              warehouse.locations.length
                ? ` across ${warehouse.locations.length} ${
                    warehouse.locations.length === 1 ? "place" : "places"
                  }`
                : ""
            }. Search before you buy.`}
          </Text>
        </div>
      </Group>
      <TextInput
        size="xs"
        placeholder="e.g. gaff tape"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      {query.trim() ? (
        hits.length ? (
          <Stack gap={4} mt="xs">
            {hits.map((b) => (
              <Group key={b.id} justify="space-between" gap="sm" wrap="wrap">
                <Anchor
                  href={binHref(warehouse.baseUrl, b.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="sm"
                  style={{ flex: "1 1 160px", minWidth: 0 }}
                >
                  {binTitle(b)}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {b.locationName ?? "no location set"}
                </Text>
              </Group>
            ))}
          </Stack>
        ) : (
          <Text size="xs" c="dimmed" mt="xs">
            Nothing in storage matches "{query.trim()}".
          </Text>
        )
      ) : null}
    </Card>
  );
}

export default function Supplies({ loaderData }: Route.ComponentProps) {
  const {
    categories,
    items,
    canManage,
    locked,
    year,
    roster,
    myMembershipId,
    warehouse,
  } = loaderData;

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Camp supplies</Title>
          <Text c="dimmed" size="sm">
            Shared camp gear for {year}, by group — what we need and who's
            bringing it. Claim anything unclaimed, or add what you're bringing
            that isn't listed; you'll see what's already covered as you type, so
            we don't end up with six of one thing and none of another. (Your own
            tents and vehicles live under Bringing.)
          </Text>
        </div>

        {warehouse ? <Warehouse warehouse={warehouse} /> : null}

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
              allItems={items}
              categories={categories}
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
  allItems,
  categories,
  canManage,
  locked,
  roster,
  myMembershipId,
}: {
  category: { id: string; name: string };
  items: Item[];
  allItems: Item[];
  categories: { id: string; name: string }[];
  canManage: boolean;
  locked: boolean;
  roster: { value: string; label: string }[];
  myMembershipId: string;
}) {
  const fetcher = useFetcher<FetcherData>();
  useFetcherError(fetcher.data, fetcher.state);
  const claimed = items.filter((i) => i.ownerMembershipId).length;
  // Two lines in the same group that mean the same thing — worth an officer's
  // attention, but never merged automatically: they may be two real people.
  const dupes = canManage ? duplicateGroups(items, (i) => i.name) : [];

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

      {dupes.length > 0 ? (
        <Text size="xs" c="orange" mt="xs">
          Possible duplicates in this group:{" "}
          {dupes.map((g) => g.map((i) => i.name).join(" / ")).join("; ")}. Two
          people bringing the same thing is fine — merge only if it's one thing
          listed twice.
        </Text>
      ) : null}

      {!locked ? (
        <AddMine
          category={category}
          allItems={allItems}
          categories={categories}
          myMembershipId={myMembershipId}
        />
      ) : null}

      {canManage && !locked ? (
        <Button
          mt="xs"
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
          + Add a blank line for someone else to claim
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * "I'm bringing something" — the member-facing add box, and the whole point of
 * this pass. A camper told a meeting they'd bring liquor and had no way to see
 * what anyone else had claimed; there was also no way for them to record it.
 *
 * The dedupe happens WHILE THEY TYPE, not after they submit: matches from
 * every group, with who has already claimed each, appear under the field. That
 * is the difference between "you can look it up" and "you can't miss it".
 * Coarse names are explicitly welcome — refine the line later.
 */
function AddMine({
  category,
  allItems,
  categories,
  myMembershipId,
}: {
  category: { id: string; name: string };
  allItems: Item[];
  categories: { id: string; name: string }[];
  myMembershipId: string;
}) {
  const fetcher = useFetcher<FetcherData>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState<string | number>(1);
  useFetcherError(fetcher.data, fetcher.state);
  const done = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      fetcher.data === done.current
    )
      return;
    done.current = fetcher.data;
    if (fetcher.data.ok) {
      if (fetcher.data.message) {
        notifications.show({ color: "green", message: fetcher.data.message });
      }
      setName("");
      setQuantity(1);
      setOpen(false);
    }
  }, [fetcher.data, fetcher.state]);

  const matches = useMemo(
    () => findSimilarSupplies(name, allItems, (i) => i.name),
    [name, allItems],
  );
  const groupName = (id: string) =>
    categories.find((c) => c.id === id)?.name ?? "";
  // An exact match sitting unclaimed is what the submit will silently take
  // over, so say so before they press the button.
  const freeExact = matches.find(
    (m) => m.kind === "exact" && !m.item.ownerMembershipId,
  );

  if (!open) {
    return (
      <Button
        mt="sm"
        size="compact-xs"
        variant="light"
        w="fit-content"
        onClick={() => setOpen(true)}
      >
        + I'm bringing something for {category.name}
      </Button>
    );
  }

  return (
    <Card withBorder mt="sm" padding="sm" radius="sm">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <NumberInput
          size="xs"
          w={72}
          min={1}
          label="How many"
          value={quantity}
          onChange={setQuantity}
        />
        <TextInput
          size="xs"
          style={{ flex: 1, minWidth: 160 }}
          label="What are you bringing?"
          placeholder="e.g. whiskey — you can get specific later"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={120}
        />
        <Button
          size="xs"
          disabled={!name.trim()}
          loading={fetcher.state !== "idle"}
          onClick={() =>
            fetcher.submit(
              {
                intent: "addMine",
                categoryId: category.id,
                name,
                quantity: String(quantity || 1),
              },
              { method: "post" },
            )
          }
        >
          {freeExact ? "Claim it" : "Add"}
        </Button>
        <Button size="xs" variant="subtle" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Group>

      {matches.length > 0 ? (
        <Stack gap={2} mt="xs">
          <Text size="xs" c="dimmed">
            Already on the list:
          </Text>
          {matches.map((m) => (
            <Text key={m.item.id} size="xs" c="dimmed" pl="sm">
              ×{m.item.quantity} {m.item.name}
              {m.item.categoryId !== category.id
                ? ` (in ${groupName(m.item.categoryId)})`
                : ""}{" "}
              —{" "}
              {m.item.ownerMembershipId ? (
                <Text
                  span
                  c={
                    m.item.ownerMembershipId === myMembershipId
                      ? "green"
                      : "orange"
                  }
                >
                  {m.item.ownerMembershipId === myMembershipId
                    ? "you're already down for this"
                    : `${m.item.ownerName} is bringing it`}
                </Text>
              ) : (
                <Text span c="blue">
                  nobody's claimed it
                </Text>
              )}
            </Text>
          ))}
          {freeExact ? (
            <Text size="xs" c="dimmed" pl="sm">
              Adding this will put you down for the existing "
              {freeExact.item.name}" line rather than making a second one.
            </Text>
          ) : null}
        </Stack>
      ) : null}
      <Text size="xs" c="dimmed" mt="xs">
        Rough is fine — "whiskey" now, "2 handles of rye" once you've bought it.
        You can edit your own lines any time.
      </Text>
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
  const [editing, setEditing] = useState(false);
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
                <>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setEditing((v) => !v)}
                  >
                    {editing ? "Cancel" : "Edit"}
                  </Button>
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
                </>
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
          {editing ? (
            // A real form with named inputs: the browser owns the values, so a
            // re-render can't lose what's half-typed.
            <fetcher.Form
              method="post"
              style={{ width: "100%" }}
              onSubmit={() => setEditing(false)}
            >
              <input type="hidden" name="intent" value="updateMine" />
              <input type="hidden" name="id" value={item.id} />
              <Group gap="xs" align="flex-end" wrap="wrap">
                <NumberInput
                  size="xs"
                  w={72}
                  min={1}
                  name="quantity"
                  label="How many"
                  defaultValue={item.quantity}
                />
                <TextInput
                  size="xs"
                  style={{ flex: 1, minWidth: 140 }}
                  name="name"
                  label="What"
                  defaultValue={item.name}
                  maxLength={120}
                />
                <TextInput
                  size="xs"
                  w={160}
                  name="notes"
                  label="Notes"
                  defaultValue={item.notes ?? ""}
                />
                <Button
                  type="submit"
                  size="xs"
                  loading={fetcher.state !== "idle"}
                >
                  Save
                </Button>
              </Group>
            </fetcher.Form>
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
