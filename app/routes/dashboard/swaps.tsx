/**
 * The spares board — "I have a spare ticket / vehicle pass" and "I need one",
 * with an asking price and a way to mark it taken. Asked for in consecutive
 * camp meetings because it currently happens across Discord, email and DMs,
 * where an offer scrolls away before the person who needed it sees it.
 *
 * Ticket and vehicle pass are separate kinds everywhere, never a merged
 * "spare": people routinely have one and need the other.
 *
 * The camp is not a party to any of this — no payment, no escrow, no
 * guarantee. The page says so, once, plainly, rather than pretending
 * otherwise. Gated by the `swaps` camp feature.
 */
import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq, inArray } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import {
  SWAP_DIRECTIONS,
  SWAP_KINDS,
  type SwapKind,
  compareListings,
  directionColor,
  isSwapDirection,
  isSwapKind,
  kindColor,
  listingSummary,
  parsePrice,
} from "~/lib/swaps";
import { db } from "../../../db/client.server";
import { membership, swapListing, user } from "../../../db/schema";
import type { Route } from "./+types/swaps";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Spares board · CampTool" }];
}

const MAX_NOTE = 500;
const MAX_QTY = 20;

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "swaps");

  const rows = await db
    .select({
      id: swapListing.id,
      kind: swapListing.kind,
      direction: swapListing.direction,
      quantity: swapListing.quantity,
      priceCents: swapListing.priceCents,
      note: swapListing.note,
      status: swapListing.status,
      membershipId: swapListing.membershipId,
      posterName: user.name,
      posterPlaya: membership.playaName,
      posterEmail: user.email,
      claimedByMembershipId: swapListing.claimedByMembershipId,
      createdAt: swapListing.createdAt,
    })
    .from(swapListing)
    .innerJoin(membership, eq(membership.id, swapListing.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(swapListing.editionId, activeEdition.id));

  // Who took each listing, resolved separately so the join above stays simple.
  const claimerIds = [
    ...new Set(
      rows.map((r) => r.claimedByMembershipId).filter((v): v is string => !!v),
    ),
  ];
  const claimers = claimerIds.length
    ? await db
        .select({
          id: membership.id,
          name: user.name,
          playaName: membership.playaName,
        })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(inArray(membership.id, claimerIds))
    : [];
  const claimerName = new Map(
    claimers.map((c) => [c.id, c.playaName || c.name]),
  );

  const listings = rows
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      direction: r.direction,
      quantity: r.quantity,
      priceCents: r.priceCents,
      note: r.note,
      status: r.status,
      mine: r.membershipId === active.membership.id,
      posterName: r.posterPlaya || r.posterName,
      // Contact details only travel with an OPEN listing — once it's settled
      // there's no reason to keep handing them out.
      posterEmail: r.status === "open" ? r.posterEmail : null,
      claimedByName: r.claimedByMembershipId
        ? (claimerName.get(r.claimedByMembershipId) ?? null)
        : null,
      claimedByMe: r.claimedByMembershipId === active.membership.id,
      createdAt: r.createdAt.getTime(),
    }))
    .sort(compareListings);

  return redact(privacy, {
    locked: activeEdition.locked,
    year: activeEdition.year,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    canPost: hasAtLeast(active.membership.role, "member"),
    listings,
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "swaps");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const mid = active.membership.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const form = await request.formData();
  const intent = String(form.get("intent"));

  /** Resolve a listing inside this camp+year. */
  const find = async (id: string) => {
    const [row] = await db
      .select({
        id: swapListing.id,
        membershipId: swapListing.membershipId,
        status: swapListing.status,
      })
      .from(swapListing)
      .where(
        and(
          eq(swapListing.id, id),
          eq(swapListing.campId, active.camp.id),
          eq(swapListing.editionId, activeEdition.id),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  if (intent === "post") {
    if (!hasAtLeast(active.membership.role, "member")) {
      return data({ error: "Members can post." }, { status: 403 });
    }
    const kind = String(form.get("kind") ?? "");
    const direction = String(form.get("direction") ?? "");
    if (!isSwapKind(kind) || !isSwapDirection(direction)) {
      return data({ error: "Pick what and which way." }, { status: 400 });
    }
    const qtyRaw = Number(form.get("quantity"));
    const quantity =
      Number.isInteger(qtyRaw) && qtyRaw > 0 && qtyRaw <= MAX_QTY ? qtyRaw : 1;
    const note = String(form.get("note") ?? "").trim();
    if (note.length > MAX_NOTE) {
      return data({ error: "That note is too long." }, { status: 400 });
    }
    await db.insert(swapListing).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      editionId: activeEdition.id,
      membershipId: mid,
      kind,
      direction,
      quantity,
      priceCents: parsePrice(String(form.get("price") ?? "")),
      note: note || null,
    });
    return data({ ok: true, message: "Posted to the board." });
  }

  const listing = await find(String(form.get("id") ?? ""));
  if (!listing) return data({ error: "Listing not found." }, { status: 404 });
  const isPoster = listing.membershipId === mid;

  /**
   * Somebody else says they'll take it. This is a handshake, not a
   * transaction: it marks the listing so nobody else chases it, and records
   * who, so the poster knows who to talk to. Either side can reopen it.
   */
  if (intent === "claim") {
    if (isPoster) {
      return data(
        { error: 'That\'s your own listing — use "Mark settled".' },
        { status: 400 },
      );
    }
    if (listing.status !== "open") {
      return data({ error: "Already taken." }, { status: 409 });
    }
    await db
      .update(swapListing)
      .set({
        status: "claimed",
        claimedByMembershipId: mid,
        claimedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(swapListing.id, listing.id));
    return data({
      ok: true,
      message: "Marked — sort out the details with them directly.",
    });
  }

  // Everything below belongs to the poster (or an officer moderating).
  if (!isPoster && !isOfficer) {
    return data({ error: "That isn't your listing." }, { status: 403 });
  }

  if (intent === "settle") {
    // The poster resolved it off-board (sold to a friend, found one elsewhere).
    await db
      .update(swapListing)
      .set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
      .where(eq(swapListing.id, listing.id));
    return data({ ok: true });
  }

  if (intent === "reopen") {
    await db
      .update(swapListing)
      .set({
        status: "open",
        claimedByMembershipId: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(swapListing.id, listing.id));
    return data({ ok: true });
  }

  if (intent === "withdraw") {
    await db
      .update(swapListing)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(eq(swapListing.id, listing.id));
    return data({ ok: true });
  }

  if (intent === "delete") {
    await db.delete(swapListing).where(eq(swapListing.id, listing.id));
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: boolean; error?: string; message?: string };
type Listing = Route.ComponentProps["loaderData"]["listings"][number];

export default function Swaps({ loaderData }: Route.ComponentProps) {
  const { listings, locked, year, canPost, isOfficer } = loaderData;
  const [filter, setFilter] = useState<"all" | SwapKind>("all");
  const shown =
    filter === "all" ? listings : listings.filter((l) => l.kind === filter);
  const open = shown.filter((l) => l.status === "open");
  const settled = shown.filter((l) => l.status !== "open");

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Spares board · {year}</Title>
          <Text c="dimmed" size="sm">
            Spare tickets and vehicle passes, and people looking for one. Post
            what you have or what you need instead of hoping the right person
            reads the right Discord thread.
          </Text>
          <Text c="dimmed" size="xs" mt={4}>
            The camp isn't part of these arrangements — no money passes through
            here and nothing is guaranteed. Sort out payment and handover
            directly with the other person.
          </Text>
        </div>

        {locked ? (
          <Text size="sm" c="dimmed">
            This year is locked — the board is read-only.
          </Text>
        ) : null}

        <Group justify="space-between" wrap="wrap" gap="sm">
          <SegmentedControl
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            data={[
              { value: "all", label: "Everything" },
              ...SWAP_KINDS.map((k) => ({
                value: k.value,
                label: `${k.label}s`,
              })),
            ]}
          />
          <Text size="xs" c="dimmed">
            {open.length} open · {settled.length} settled
          </Text>
        </Group>

        {canPost && !locked ? <PostForm /> : null}

        {open.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing open right now.
            {canPost && !locked
              ? " Post above if you have a spare or need one."
              : ""}
          </Text>
        ) : (
          <Stack gap="xs">
            {open.map((l) => (
              <ListingCard
                key={l.id}
                l={l}
                locked={locked}
                isOfficer={isOfficer}
              />
            ))}
          </Stack>
        )}

        {settled.length > 0 ? (
          <div>
            <Text size="sm" fw={600} c="dimmed" mb={4}>
              Settled
            </Text>
            <Stack gap="xs">
              {settled.map((l) => (
                <ListingCard
                  key={l.id}
                  l={l}
                  locked={locked}
                  isOfficer={isOfficer}
                />
              ))}
            </Stack>
          </div>
        ) : null}
      </Stack>
    </Container>
  );
}

function ListingCard({
  l,
  locked,
  isOfficer,
}: {
  l: Listing;
  locked: boolean;
  isOfficer: boolean;
}) {
  const fetcher = useFetcher<FetcherData>();
  useNotify(fetcher.data, fetcher.state);
  const post = (intent: string) =>
    fetcher.submit({ intent, id: l.id }, { method: "post" });
  const dir = SWAP_DIRECTIONS.find((d) => d.value === l.direction);
  const settled = l.status !== "open";

  return (
    <Card withBorder padding="sm" radius="md" opacity={settled ? 0.65 : 1}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs" wrap="wrap">
            <Badge
              size="sm"
              variant="light"
              color={directionColor(l.direction)}
            >
              {dir?.label ?? l.direction}
            </Badge>
            <Badge size="sm" variant="outline" color={kindColor(l.kind)}>
              {listingSummary(l)}
            </Badge>
            {l.status === "claimed" ? (
              <Badge size="sm" variant="light" color="gray">
                {l.claimedByName ? `taken by ${l.claimedByName}` : "settled"}
              </Badge>
            ) : null}
            {l.status === "withdrawn" ? (
              <Badge size="sm" variant="light" color="gray">
                withdrawn
              </Badge>
            ) : null}
          </Group>
          <Text size="sm" mt={4}>
            {l.posterName}
            {l.mine ? " (you)" : ""}
          </Text>
          {l.note ? (
            <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
              {l.note}
            </Text>
          ) : null}
          {/* Contact details inline: chasing someone down is the whole job
              this board exists to remove. */}
          {!settled && l.posterEmail ? (
            <Text size="xs" c="dimmed" mt={4}>
              Reach them at {l.posterEmail}
            </Text>
          ) : null}
        </div>

        {!locked ? (
          <Group gap="xs" wrap="wrap">
            {!l.mine && l.status === "open" ? (
              <Button
                size="compact-xs"
                variant="light"
                loading={fetcher.state !== "idle"}
                onClick={() => post("claim")}
              >
                {l.direction === "have" ? "I'll take it" : "I can help"}
              </Button>
            ) : null}
            {(l.mine || isOfficer) && l.status === "open" ? (
              <>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => post("settle")}
                >
                  Mark settled
                </Button>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => post("withdraw")}
                >
                  Withdraw
                </Button>
              </>
            ) : null}
            {(l.mine || l.claimedByMe || isOfficer) && settled ? (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => post("reopen")}
              >
                Reopen
              </Button>
            ) : null}
            {l.mine || isOfficer ? (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => post("delete")}
              >
                Delete
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Group>
    </Card>
  );
}

function PostForm() {
  const fetcher = useFetcher<FetcherData>();
  const [direction, setDirection] = useState("have");
  const [kind, setKind] = useState<string>("ticket");
  const [open, setOpen] = useState(false);
  useNotify(fetcher.data, fetcher.state, () => setOpen(false));

  if (!open) {
    return (
      <Button variant="light" w="fit-content" onClick={() => setOpen(true)}>
        + Post to the board
      </Button>
    );
  }

  return (
    <Paper withBorder p="md" radius="md">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="post" />
        <input type="hidden" name="direction" value={direction} />
        <input type="hidden" name="kind" value={kind} />
        <Stack gap="sm">
          <SegmentedControl
            value={direction}
            onChange={setDirection}
            data={SWAP_DIRECTIONS.map((d) => ({
              value: d.value,
              label: d.label,
            }))}
          />
          <Group grow align="flex-end">
            <Select
              label="What"
              value={kind}
              onChange={(v) => setKind(v ?? "ticket")}
              data={SWAP_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              allowDeselect={false}
            />
            <NumberInput
              name="quantity"
              label="How many"
              min={1}
              max={MAX_QTY}
              defaultValue={1}
            />
            <TextInput
              name="price"
              label={direction === "have" ? "Asking price" : "Willing to pay"}
              placeholder="e.g. 575 — or leave blank"
            />
          </Group>
          <Text size="xs" c="dimmed">
            Leave the price blank if you'd rather talk about it; enter 0 if
            you're giving it away.
          </Text>
          <Textarea
            name="note"
            label="Anything else"
            placeholder="e.g. tier 2, can meet in Reno on the way out"
            autosize
            minRows={2}
            maxLength={MAX_NOTE}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={fetcher.state !== "idle"}>
              Post
            </Button>
          </Group>
        </Stack>
      </fetcher.Form>
    </Paper>
  );
}

function useNotify(
  d: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  // Held in a ref because the caller passes a fresh closure every render;
  // depending on it directly would refire the effect on each one.
  const okRef = useRef(onOk);
  okRef.current = onOk;
  const seen = useRef<FetcherData | undefined>(undefined);
  useEffect(() => {
    if (state !== "idle" || !d || d === seen.current) return;
    seen.current = d;
    if (d.error) {
      notifications.show({ color: "red", message: d.error });
    } else if (d.ok) {
      if (d.message) notifications.show({ color: "green", message: d.message });
      okRef.current?.();
    }
  }, [d, state]);
}
