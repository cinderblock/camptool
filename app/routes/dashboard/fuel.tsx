/**
 * Fuel inventory — who's bringing what fuel, how much, and in what containers.
 *
 * This is a safety page before it's an inventory page. Burning Man requires
 * fuel to have secondary containment and to be separated from living areas and
 * ignition sources; the map already draws those rings around a `fuel-storage`
 * object (10′ ignition, 20′ liquid↔propane, 50′ fuel↔fuel). What nobody could
 * answer was how much fuel is coming and in how many vessels — so the totals
 * are the point, and they sit at the top of the page rather than at the bottom.
 *
 * "I'm not bringing any" is a first-class answer here, not an empty list. The
 * review has to chase everyone it hasn't heard from, and someone who has
 * genuinely thought about it and has nothing to store should be able to say so
 * and stop being chased.
 *
 * Campers manage their own lines. Officers see everything plus the roll-up, and
 * can remove a line. Gated by the `fuel` camp feature.
 */
import {
  Badge,
  Button,
  Card,
  Container,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { and, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, data, useFetcher } from "react-router";
import { requireFeature } from "~/lib/features.server";
import {
  FUEL_TYPES,
  FUEL_UNITS,
  NO_FUEL,
  defaultUnitFor,
  fuelColor,
  fuelLabel,
  fuelTotals,
  isFuelType,
  isFuelUnit,
  isNoFuel,
  needsPhaseSeparation,
  noFuelCount,
  totalLabel,
} from "~/lib/fuel";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveEdition } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { fuelDeclaration, membership, user } from "../../../db/schema";
import type { Route } from "./+types/fuel";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Fuel · CampTool" }];
}

const MAX_AMOUNT = 10_000;
const MAX_CONTAINERS = 500;

export async function loader({ request }: Route.LoaderArgs) {
  const { active, activeEdition, privacy } =
    await requireActiveEdition(request);
  await requireFeature(active, "fuel");

  const rows = await db
    .select({
      id: fuelDeclaration.id,
      membershipId: fuelDeclaration.membershipId,
      fuelType: fuelDeclaration.fuelType,
      amount: fuelDeclaration.amount,
      unit: fuelDeclaration.unit,
      containerType: fuelDeclaration.containerType,
      containerCount: fuelDeclaration.containerCount,
      secondaryContainment: fuelDeclaration.secondaryContainment,
      notes: fuelDeclaration.notes,
      ownerName: user.name,
      ownerPlaya: membership.playaName,
    })
    .from(fuelDeclaration)
    .innerJoin(membership, eq(membership.id, fuelDeclaration.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(fuelDeclaration.editionId, activeEdition.id));

  const declarations = rows.map((r) => ({
    id: r.id,
    fuelType: r.fuelType,
    amount: r.amount,
    unit: r.unit,
    containerType: r.containerType,
    containerCount: r.containerCount,
    secondaryContainment: r.secondaryContainment,
    notes: r.notes,
    ownerName: r.ownerPlaya || r.ownerName,
    mine: r.membershipId === active.membership.id,
  }));

  return redact(privacy, {
    locked: activeEdition.locked,
    year: activeEdition.year,
    isOfficer: hasAtLeast(active.membership.role, "officer"),
    declarations,
    totals: fuelTotals(declarations),
    mixedPhases: needsPhaseSeparation(declarations),
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { active, activeEdition } = await requireActiveEdition(request);
  await requireFeature(active, "fuel");
  if (activeEdition.locked) {
    return data({ error: "This year is locked." }, { status: 403 });
  }
  const mid = active.membership.id;
  const isOfficer = hasAtLeast(active.membership.role, "officer");
  const form = await request.formData();
  const intent = String(form.get("intent"));

  /** Clamp a typed amount into something that can't be a typo disaster. */
  const amount = () => {
    const n = Number(form.get("amount"));
    return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_AMOUNT) : 0;
  };
  const containers = () => {
    const n = Number(form.get("containerCount"));
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_CONTAINERS) : 1;
  };
  /** Tri-state: "" = not answered, which the safety roll-up counts separately
   * from an explicit "no". */
  const containment = () => {
    const raw = String(form.get("secondaryContainment") ?? "");
    return raw === "yes" ? true : raw === "no" ? false : null;
  };

  /** This member's own lines this year — what "none" has to be exclusive of. */
  const myLines = () =>
    db
      .select({
        id: fuelDeclaration.id,
        fuelType: fuelDeclaration.fuelType,
      })
      .from(fuelDeclaration)
      .where(
        and(
          eq(fuelDeclaration.editionId, activeEdition.id),
          eq(fuelDeclaration.membershipId, mid),
        ),
      );

  // "I'm not bringing any fuel." A row, so the review can tell it from silence,
  // but one that carries no amount and no containers.
  if (intent === "none") {
    const existing = await myLines();
    if (existing.some((r) => !isNoFuel(r.fuelType))) {
      return data(
        { error: "You've already declared fuel — remove those lines first." },
        { status: 400 },
      );
    }
    // Already said it. Saying it twice is the same answer, not a second one.
    if (existing.length > 0) return data({ ok: true });
    await db.insert(fuelDeclaration).values({
      id: crypto.randomUUID(),
      campId: active.camp.id,
      editionId: activeEdition.id,
      membershipId: mid,
      fuelType: NO_FUEL,
      amount: 0,
      unit: "gal",
      containerType: null,
      containerCount: 0,
      secondaryContainment: null,
      notes: null,
    });
    return data({ ok: true, message: "Noted — no fuel from you." });
  }

  if (intent === "add" || intent === "update") {
    const fuelType = String(form.get("fuelType") ?? "");
    if (!isFuelType(fuelType)) {
      return data({ error: "Pick a fuel type." }, { status: 400 });
    }
    const unitRaw = String(form.get("unit") ?? "");
    const unit = isFuelUnit(unitRaw) ? unitRaw : defaultUnitFor(fuelType);
    const containerType =
      String(form.get("containerType") ?? "")
        .trim()
        .slice(0, 120) || null;
    const notes =
      String(form.get("notes") ?? "")
        .trim()
        .slice(0, 500) || null;

    if (intent === "add") {
      await db.insert(fuelDeclaration).values({
        id: crypto.randomUUID(),
        campId: active.camp.id,
        editionId: activeEdition.id,
        membershipId: mid,
        fuelType,
        amount: amount(),
        unit,
        containerType,
        containerCount: containers(),
        secondaryContainment: containment(),
        notes,
      });
      // Declaring actual fuel supersedes an earlier "none" — they changed their
      // mind, and leaving both would make the sheet say two things at once.
      // After the insert, so a failed insert can't quietly drop the old answer.
      const dropped = await db
        .delete(fuelDeclaration)
        .where(
          and(
            eq(fuelDeclaration.editionId, activeEdition.id),
            eq(fuelDeclaration.membershipId, mid),
            eq(fuelDeclaration.fuelType, NO_FUEL),
          ),
        )
        .returning({ id: fuelDeclaration.id });
      return data({
        ok: true,
        message:
          dropped.length > 0
            ? "Added — that replaces your “no fuel” declaration."
            : "Added.",
      });
    }

    const [row] = await db
      .select({
        id: fuelDeclaration.id,
        membershipId: fuelDeclaration.membershipId,
      })
      .from(fuelDeclaration)
      .where(
        and(
          eq(fuelDeclaration.id, String(form.get("id") ?? "")),
          eq(fuelDeclaration.editionId, activeEdition.id),
        ),
      )
      .limit(1);
    if (!row) return data({ error: "Not found." }, { status: 404 });
    if (row.membershipId !== mid && !isOfficer) {
      return data({ error: "That isn't yours." }, { status: 403 });
    }
    await db
      .update(fuelDeclaration)
      .set({
        fuelType,
        amount: amount(),
        unit,
        containerType,
        containerCount: containers(),
        secondaryContainment: containment(),
        notes,
        updatedAt: new Date(),
      })
      .where(eq(fuelDeclaration.id, row.id));
    return data({ ok: true });
  }

  if (intent === "delete") {
    const [row] = await db
      .select({
        id: fuelDeclaration.id,
        membershipId: fuelDeclaration.membershipId,
      })
      .from(fuelDeclaration)
      .where(
        and(
          eq(fuelDeclaration.id, String(form.get("id") ?? "")),
          eq(fuelDeclaration.editionId, activeEdition.id),
        ),
      )
      .limit(1);
    if (!row) return data({ error: "Not found." }, { status: 404 });
    if (row.membershipId !== mid && !isOfficer) {
      return data({ error: "That isn't yours." }, { status: 403 });
    }
    await db.delete(fuelDeclaration).where(eq(fuelDeclaration.id, row.id));
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type FetcherData = { ok?: boolean; error?: string; message?: string };
type LoaderData = Route.ComponentProps["loaderData"];
type Declaration = LoaderData["declarations"][number];

export default function Fuel({ loaderData }: Route.ComponentProps) {
  const { declarations, totals, mixedPhases, locked, year, isOfficer } =
    loaderData;
  const mine = declarations.filter((d) => d.mine);
  // Real fuel first — a list of "no fuel" cards shouldn't push the thing the
  // safety review came here to read below the fold.
  const others = declarations
    .filter((d) => !d.mine)
    .sort(
      (a, b) => Number(isNoFuel(a.fuelType)) - Number(isNoFuel(b.fuelType)),
    );

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Title order={2}>Fuel · {year}</Title>
          <Text c="dimmed" size="sm">
            What fuel the camp is bringing, how much of it, and what it arrives
            in. This feeds the fuel-storage area on the{" "}
            <Text span component={Link} to="/map" c="blue" inherit>
              map
            </Text>{" "}
            and the camp's fire-safety review, so the totals and the container
            counts are the part that matters.
          </Text>
        </div>

        {locked ? (
          <Text size="sm" c="dimmed">
            This year is locked — fuel declarations are read-only.
          </Text>
        ) : null}

        <Totals
          totals={totals}
          mixedPhases={mixedPhases}
          noFuel={noFuelCount(declarations)}
        />

        <div>
          <Text fw={600} mb="xs">
            What you're bringing
          </Text>
          {mine.length === 0 ? (
            <Text size="sm" c="dimmed" mb="xs">
              Nothing declared. If you're bringing fuel of any kind — generator
              gas, propane for a stove, diesel — add it here so it can be stored
              safely and separated properly. If you're bringing none, say that
              too: it's a real answer, and it's how you stop being counted as
              someone nobody has heard from.
            </Text>
          ) : (
            <Stack gap="xs" mb="xs">
              {mine.map((d) => (
                <Row key={d.id} d={d} locked={locked} canEdit />
              ))}
            </Stack>
          )}
          {!locked ? <AddForm canDeclareNone={mine.length === 0} /> : null}
        </div>

        {others.length > 0 ? (
          <div>
            <Text fw={600} mb="xs">
              Everyone else
            </Text>
            <Stack gap="xs">
              {others.map((d) => (
                <Row key={d.id} d={d} locked={locked} canEdit={isOfficer} />
              ))}
            </Stack>
          </div>
        ) : null}
      </Stack>
    </Container>
  );
}

/** The safety roll-up: per type, how much and in how many vessels. */
function Totals({
  totals,
  mixedPhases,
  noFuel,
}: {
  totals: LoaderData["totals"];
  mixedPhases: boolean;
  /** How many people have said, explicitly, that they're bringing none. */
  noFuel: number;
}) {
  const noFuelLine =
    noFuel > 0
      ? `${noFuel} ${noFuel === 1 ? "person has" : "people have"} declared no fuel`
      : null;

  if (totals.length === 0) {
    return (
      <Paper withBorder p="md" radius="md">
        <Text size="sm" c="dimmed">
          Nobody has declared any fuel yet.
          {noFuelLine ? ` ${noFuelLine} — that part is answered.` : ""}
        </Text>
      </Paper>
    );
  }
  return (
    <Paper withBorder p="md" radius="md">
      <Text fw={600} size="sm" mb="xs">
        Camp totals
      </Text>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        {totals.map((t) => (
          <div key={t.fuelType}>
            <Badge variant="light" color={fuelColor(t.fuelType)} size="sm">
              {fuelLabel(t.fuelType)}
            </Badge>
            <Text fw={700} size="lg" mt={4}>
              {totalLabel(t)}
            </Text>
            <Text size="xs" c="dimmed">
              {t.containers} container{t.containers === 1 ? "" : "s"} ·{" "}
              {t.lines} {t.lines === 1 ? "person" : "declarations"}
            </Text>
            {t.containmentMissing > 0 ? (
              <Text size="xs" c="orange">
                {t.containmentMissing} without secondary containment
              </Text>
            ) : null}
            {t.containmentUnknown > 0 ? (
              <Text size="xs" c="dimmed">
                {t.containmentUnknown} haven't said
              </Text>
            ) : null}
          </div>
        ))}
      </SimpleGrid>
      {mixedPhases ? (
        <Text size="xs" c="dimmed" mt="sm">
          The camp is bringing both liquid fuel and propane, so they need 20′
          between them — one storage area won't do. The map draws the rings once
          you place fuel-storage objects.
        </Text>
      ) : null}
      {noFuelLine ? (
        <Text size="xs" c="dimmed" mt="xs">
          {noFuelLine}.
        </Text>
      ) : null}
      <Text size="xs" c="dimmed" mt="xs">
        Gallons and pounds are kept apart on purpose; converting between them
        would invent precision nobody gave us.
      </Text>
    </Paper>
  );
}

function Row({
  d,
  locked,
  canEdit,
}: {
  d: Declaration;
  locked: boolean;
  canEdit: boolean;
}) {
  const fetcher = useFetcher<FetcherData>();
  const [editing, setEditing] = useState(false);
  useNotify(fetcher.data, fetcher.state, () => setEditing(false));
  const remove = () =>
    fetcher.submit({ intent: "delete", id: d.id }, { method: "post" });

  // "None" has nothing to edit — it's one bit, and the way to change it is to
  // declare fuel (which supersedes it) or take it back.
  if (isNoFuel(d.fuelType)) {
    return (
      <Card withBorder padding="sm" radius="sm">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <div style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="wrap">
              <Badge variant="light" color="gray" size="sm">
                No fuel
              </Badge>
              <Text size="sm">
                {d.mine
                  ? "You've said you're not bringing any fuel."
                  : "Not bringing any fuel."}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" mt={2}>
              {d.ownerName}
              {d.mine ? " (you)" : ""}
            </Text>
          </div>
          {canEdit && !locked ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={remove}
            >
              Remove
            </Button>
          ) : null}
        </Group>
      </Card>
    );
  }

  if (editing) {
    return (
      <Card withBorder padding="sm" radius="sm">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="id" value={d.id} />
          <Fields d={d} />
          <Group justify="flex-end" mt="sm" gap="xs">
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="xs" loading={fetcher.state !== "idle"}>
              Save
            </Button>
          </Group>
        </fetcher.Form>
      </Card>
    );
  }

  return (
    <Card withBorder padding="sm" radius="sm">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="wrap">
            <Badge variant="light" color={fuelColor(d.fuelType)} size="sm">
              {fuelLabel(d.fuelType)}
            </Badge>
            <Text size="sm" fw={600}>
              {d.amount} {d.unit}
            </Text>
            <Text size="sm" c="dimmed">
              in {d.containerCount} × {d.containerType || "container"}
            </Text>
            {d.secondaryContainment === true ? (
              <Badge size="xs" variant="light" color="green">
                contained
              </Badge>
            ) : d.secondaryContainment === false ? (
              <Badge size="xs" variant="light" color="orange">
                no containment
              </Badge>
            ) : (
              <Badge size="xs" variant="outline" color="gray">
                containment unanswered
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" mt={2}>
            {d.ownerName}
            {d.mine ? " (you)" : ""}
            {d.notes ? ` — ${d.notes}` : ""}
          </Text>
        </div>
        {canEdit && !locked ? (
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              onClick={remove}
            >
              Remove
            </Button>
          </Group>
        ) : null}
      </Group>
    </Card>
  );
}

/** The shared field set, so add and edit can't drift apart. */
function Fields({ d }: { d?: Declaration }) {
  const [fuelType, setFuelType] = useState(d?.fuelType ?? "gasoline");
  const [unit, setUnit] = useState(d?.unit ?? defaultUnitFor("gasoline"));
  const [contained, setContained] = useState(
    d?.secondaryContainment === true
      ? "yes"
      : d?.secondaryContainment === false
        ? "no"
        : "",
  );
  return (
    <Stack gap="sm">
      <input type="hidden" name="fuelType" value={fuelType} />
      <input type="hidden" name="unit" value={unit} />
      <input type="hidden" name="secondaryContainment" value={contained} />
      <Group grow align="flex-end">
        <Select
          label="Fuel"
          value={fuelType}
          onChange={(v) => {
            const next = v ?? "gasoline";
            setFuelType(next);
            // Follow the unit people actually buy that fuel in, so nobody has
            // to remember that propane is weighed and gasoline is measured.
            setUnit(defaultUnitFor(next));
          }}
          data={FUEL_TYPES.map((f) => ({ value: f.value, label: f.label }))}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
        <NumberInput
          name="amount"
          label="How much"
          min={0}
          max={MAX_AMOUNT}
          decimalScale={1}
          defaultValue={d?.amount ?? 0}
        />
        <Select
          label="Unit"
          value={unit}
          onChange={(v) => setUnit(v ?? "gal")}
          data={FUEL_UNITS.map((u) => ({ value: u.value, label: u.label }))}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>
      <Group grow align="flex-end">
        <NumberInput
          name="containerCount"
          label="How many containers"
          min={1}
          max={MAX_CONTAINERS}
          defaultValue={d?.containerCount ?? 1}
        />
        <TextInput
          name="containerType"
          label="What kind"
          placeholder="e.g. 5 gal jerry cans, 20 lb tanks"
          defaultValue={d?.containerType ?? ""}
          maxLength={120}
        />
      </Group>
      <Switch
        checked={contained === "yes"}
        onChange={(e) => setContained(e.currentTarget.checked ? "yes" : "no")}
        label="Sitting in secondary containment (a tray or tub that catches a leak)"
      />
      {contained === "" ? (
        <Text size="xs" c="dimmed">
          Not answered yet — the safety review counts that separately from a no.
        </Text>
      ) : null}
      <TextInput
        name="notes"
        label="Anything else"
        placeholder="e.g. for the generator, arriving Wednesday"
        defaultValue={d?.notes ?? ""}
        maxLength={500}
      />
    </Stack>
  );
}

function AddForm({ canDeclareNone }: { canDeclareNone: boolean }) {
  const fetcher = useFetcher<FetcherData>();
  const [open, setOpen] = useState(false);
  useNotify(fetcher.data, fetcher.state, () => setOpen(false));
  if (!open) {
    return (
      <Group gap="xs">
        <Button variant="light" size="xs" onClick={() => setOpen(true)}>
          + Add fuel
        </Button>
        {canDeclareNone ? (
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            loading={fetcher.state !== "idle"}
            onClick={() =>
              fetcher.submit({ intent: "none" }, { method: "post" })
            }
          >
            I'm not bringing any
          </Button>
        ) : null}
      </Group>
    );
  }
  return (
    <Paper withBorder p="md" radius="md">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="add" />
        <Fields />
        <Group justify="flex-end" mt="sm" gap="xs">
          <Button variant="subtle" size="xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" size="xs" loading={fetcher.state !== "idle"}>
            Add
          </Button>
        </Group>
      </fetcher.Form>
    </Paper>
  );
}

function useNotify(
  d: FetcherData | undefined,
  state: "idle" | "loading" | "submitting",
  onOk?: () => void,
) {
  // Held in a ref because the caller passes a fresh closure every render.
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
