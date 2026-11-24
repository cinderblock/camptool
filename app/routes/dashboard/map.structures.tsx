/**
 * Camp structures: the camp's own map structure kinds, defined by officers in
 * the app (plans/custom-structures.md). Each one joins this camp's map legend,
 * the camper palettes (if campers may bring their own) and the banned-kinds
 * list, and draws, shades and overlap-checks like the built-in kinds.
 */
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  ColorInput,
  Container,
  Group,
  Modal,
  NumberInput,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { and, count, eq, like } from "drizzle-orm";
import { useEffect, useMemo, useRef, useState } from "react";
import { data, Link, redirect, useFetcher } from "react-router";
import {
  CUSTOM_KIND_PREFIX,
  CUSTOM_SHAPE_LABELS,
  CUSTOM_SHAPES,
  type CustomKindData,
  type CustomShape,
  compileCustomKind,
  outlineProblem,
  parseOutline,
  parseTags,
  type UnitPt,
  unitOutline,
} from "~/lib/custom-kinds";
import { loadCustomKinds } from "~/lib/custom-kinds.server";
import { requireFeature } from "~/lib/features.server";
import { useKinds } from "~/lib/kinds-context";
import { hasAtLeast } from "~/lib/permissions";
import { redact } from "~/lib/privacy.server";
import { requireActiveCamp } from "~/lib/session.server";
import { KindIcon, type KindTag } from "~/lib/structures";
import { atomic, db } from "../../../db/client.server";
import { mapObject, structureKind, wikiLink } from "../../../db/schema";
import type { Route } from "./+types/map.structures";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp structures · CampTool" }];
}

const MAX_FT = 400;
const MAX_TALL_FT = 200;

async function requireOfficer(request: Request) {
  const ctx = await requireActiveCamp(request);
  await requireFeature(ctx.active, "map");
  if (!hasAtLeast(ctx.active.membership.role, "officer")) {
    throw redirect("/map");
  }
  return ctx;
}

/** How many map objects (any year) use each of the camp's kinds. */
async function usageCounts(campId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: mapObject.kind, n: count() })
    .from(mapObject)
    .where(
      and(
        eq(mapObject.campId, campId),
        like(mapObject.kind, `${CUSTOM_KIND_PREFIX}%`),
      ),
    )
    .groupBy(mapObject.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

export async function loader({ request }: Route.LoaderArgs) {
  const { active, privacy } = await requireOfficer(request);
  const campId = active.camp.id;
  return redact(privacy, {
    kinds: await loadCustomKinds(campId),
    usage: await usageCounts(campId),
  });
}

/** Parse + validate the editor's fields; an error string or the column values. */
function readKindForm(form: FormData) {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const num = (k: string) => Number(form.get(k));
  const bool = (k: string) => form.get(k) === "true";
  const label = str("label");
  if (!label) return { error: "Give the structure a name." };
  if (label.length > 60) return { error: "Keep the name under 60 characters." };
  const groupName = str("groupName") || "Camp";
  if (groupName.length > 40) {
    return { error: "Keep the legend group under 40 characters." };
  }
  const color = str("color").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    return { error: "Enter a hex color like #4dabf7." };
  }
  const shape = str("shape") as CustomShape;
  if (!CUSTOM_SHAPES.includes(shape)) return { error: "Pick a shape." };
  const width = num("width");
  const height = num("height");
  if (!(width >= 1 && width <= MAX_FT && height >= 1 && height <= MAX_FT)) {
    return { error: `Sizes are 1 to ${MAX_FT} feet.` };
  }
  const tallFt = num("tallFt");
  if (!(tallFt >= 0 && tallFt <= MAX_TALL_FT)) {
    return { error: `Height is 0 to ${MAX_TALL_FT} feet.` };
  }
  let outline: string | null = null;
  if (shape === "outline") {
    const pts = parseOutline(str("outline"));
    const problem = pts ? outlineProblem(pts) : "Draw an outline.";
    if (problem || !pts) return { error: problem ?? "Draw an outline." };
    if (pts.length > 64) return { error: "Keep the outline under 64 points." };
    outline = JSON.stringify(pts);
  }
  const tags = parseTags(str("tags"));
  const description = str("description").slice(0, 500) || null;
  return {
    values: {
      label,
      groupName,
      color,
      shape,
      width,
      height,
      outline,
      tallFt,
      canopyShade: bool("canopyShade"),
      tags: JSON.stringify(tags),
      personal: bool("personal"),
      rigid: bool("rigid"),
      fixedRotation: bool("fixedRotation"),
      description,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active } = await requireOfficer(request);
  const campId = active.camp.id;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id") ?? "");
  const mine = and(eq(structureKind.id, id), eq(structureKind.campId, campId));

  if (intent === "save") {
    const parsed = readKindForm(form);
    if ("error" in parsed) {
      return data({ error: parsed.error }, { status: 400 });
    }
    if (id) {
      const updated = await db
        .update(structureKind)
        .set({ ...parsed.values, updatedAt: new Date() })
        .where(mine)
        .returning({ id: structureKind.id });
      if (updated.length === 0) {
        return data({ error: "Structure not found." }, { status: 404 });
      }
      return data({ ok: true });
    }
    const newId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await db.insert(structureKind).values({
      id: newId,
      campId,
      value: `${CUSTOM_KIND_PREFIX}${newId}`,
      ...parsed.values,
      createdById: user.id,
    });
    return data({ ok: true });
  }

  if (intent === "archive" || intent === "restore") {
    await db
      .update(structureKind)
      .set({
        archivedAt: intent === "archive" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(mine);
    return data({ ok: true });
  }

  if (intent === "delete") {
    const [row] = await db
      .select({ value: structureKind.value })
      .from(structureKind)
      .where(mine)
      .limit(1);
    if (!row) return data({ error: "Structure not found." }, { status: 404 });
    const [used] = await db
      .select({ n: count() })
      .from(mapObject)
      .where(and(eq(mapObject.campId, campId), eq(mapObject.kind, row.value)));
    if ((used?.n ?? 0) > 0) {
      return data(
        { error: "Currently used on the map — archive it instead." },
        { status: 409 },
      );
    }
    await atomic([
      db
        .delete(wikiLink)
        .where(
          and(
            eq(wikiLink.campId, campId),
            eq(wikiLink.subjectType, "structure_kind"),
            eq(wikiLink.subjectId, row.value),
          ),
        ),
      db.delete(structureKind).where(mine),
    ]);
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

type Draft = Omit<CustomKindData, "id" | "value" | "sort" | "archived"> & {
  id: string | null;
};

const NEW_DRAFT: Draft = {
  id: null,
  label: "",
  groupName: "Camp",
  color: "#4dabf7",
  shape: "rect",
  width: 10,
  height: 10,
  outline: null,
  tallFt: 8,
  canopyShade: false,
  tags: ["structure"],
  personal: false,
  rigid: false,
  fixedRotation: false,
  description: null,
};

const TAG_LABELS: Record<KindTag, string> = {
  domicile: "Sleeping",
  vehicle: "Vehicle",
  structure: "Structure",
};

const SWATCHES = [
  "#fa5252",
  "#e64980",
  "#be4bdb",
  "#7950f2",
  "#4c6ef5",
  "#228be6",
  "#15aabf",
  "#12b886",
  "#40c057",
  "#82c91e",
  "#fab005",
  "#fd7e14",
  "#868e96",
  "#495057",
];

export default function CampStructures({ loaderData }: Route.ComponentProps) {
  const { kinds, usage } = loaderData;
  const registry = useKinds();
  const [draft, setDraft] = useState<Draft | null>(null);
  const live = kinds.filter((k) => !k.archived);
  const archived = kinds.filter((k) => k.archived);
  const byGroup = useMemo(() => {
    const m = new Map<string, CustomKindData[]>();
    for (const k of [...live].sort(
      (a, b) => a.sort - b.sort || a.label.localeCompare(b.label),
    )) {
      m.set(k.groupName, [...(m.get(k.groupName) ?? []), k]);
    }
    return [...m.entries()];
  }, [live]);
  const groupOptions = useMemo(
    () => [...new Set(registry.groups.map((g) => g.group))],
    [registry],
  );

  const edit = (k: CustomKindData) =>
    setDraft({
      id: k.id,
      label: k.label,
      groupName: k.groupName,
      color: k.color,
      shape: k.shape,
      width: k.width,
      height: k.height,
      outline: k.outline,
      tallFt: k.tallFt,
      canopyShade: k.canopyShade,
      tags: k.tags,
      personal: k.personal,
      rigid: k.rigid,
      fixedRotation: k.fixedRotation,
      description: k.description,
    });

  return (
    <Container size="md">
      <Stack gap="lg">
        <div>
          <Anchor component={Link} to="/map" size="sm">
            ← Map
          </Anchor>
          <Group justify="space-between" align="flex-end" mt={4}>
            <Title order={1} size="h2">
              Camp structures
            </Title>
            <Button onClick={() => setDraft({ ...NEW_DRAFT })}>
              New structure
            </Button>
          </Group>
          <Text c="dimmed" size="sm" mt={6}>
            Custom map structures for this camp. Officers place them from the
            map legend; items marked for campers also appear on the Bringing
            page.
          </Text>
        </div>

        {live.length === 0 ? (
          <Card withBorder>
            <Text c="dimmed" size="sm">
              No custom structures yet. Create one for anything the built-in
              types don't cover.
            </Text>
          </Card>
        ) : (
          byGroup.map(([group, list]) => (
            <Stack key={group} gap={6}>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                {group}
              </Text>
              {list.map((k) => (
                <KindRow
                  key={k.id}
                  kind={k}
                  used={usage[k.value] ?? 0}
                  onEdit={() => edit(k)}
                />
              ))}
            </Stack>
          ))
        )}

        {archived.length > 0 ? (
          <Stack gap={6}>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              Archived (hidden from palettes, still shown where placed)
            </Text>
            {archived.map((k) => (
              <KindRow
                key={k.id}
                kind={k}
                used={usage[k.value] ?? 0}
                onEdit={() => edit(k)}
              />
            ))}
          </Stack>
        ) : null}
      </Stack>

      {draft ? (
        <KindEditor
          draft={draft}
          groupOptions={groupOptions}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </Container>
  );
}

function KindRow({
  kind,
  used,
  onEdit,
}: {
  kind: CustomKindData;
  used: number;
  onEdit: () => void;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const compiled = useMemo(() => compileCustomKind(kind), [kind]);
  const busy = fetcher.state !== "idle";
  const post = (intent: string) =>
    fetcher.submit({ intent, id: kind.id }, { method: "post" });
  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" wrap="wrap" align="flex-start" gap="xs">
        <Group
          gap="sm"
          wrap="nowrap"
          align="flex-start"
          style={{ flex: "1 1 260px", minWidth: 0 }}
        >
          <KindIcon kind={compiled} size={36} />
          <div style={{ minWidth: 0 }}>
            <Group gap={6}>
              <Text fw={600}>{kind.label}</Text>
              {kind.personal ? (
                <Badge size="xs" variant="light">
                  Campers can bring
                </Badge>
              ) : null}
              {kind.canopyShade ? (
                <Badge size="xs" variant="light" color="gray">
                  Shade cloth
                </Badge>
              ) : null}
            </Group>
            <Text size="xs" c="dimmed">
              {CUSTOM_SHAPE_LABELS[kind.shape]} · {kind.width}′ × {kind.height}′
              · {kind.tallFt}′ tall ·{" "}
              {used === 0 ? "not on the map" : `${used} on the map`}
            </Text>
            {kind.description ? (
              <Text size="xs" mt={2}>
                {kind.description}
              </Text>
            ) : null}
            {fetcher.data?.error ? (
              <Text size="xs" c="red" mt={2}>
                {fetcher.data.error}
              </Text>
            ) : null}
          </div>
        </Group>
        <Group gap={6} wrap="nowrap">
          <Button size="xs" variant="default" onClick={onEdit}>
            Edit
          </Button>
          {kind.archived ? (
            <Button
              size="xs"
              variant="subtle"
              loading={busy}
              onClick={() => post("restore")}
            >
              Restore
            </Button>
          ) : (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              loading={busy}
              onClick={() => post("archive")}
            >
              Archive
            </Button>
          )}
          {used === 0 ? (
            <Popover withArrow position="bottom-end">
              <Popover.Target>
                <Button size="xs" variant="subtle" color="red">
                  Delete
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm">Delete {kind.label} permanently?</Text>
                  <Button
                    size="xs"
                    color="red"
                    loading={busy}
                    onClick={() => post("delete")}
                  >
                    Delete
                  </Button>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          ) : null}
        </Group>
      </Group>
    </Card>
  );
}

function KindEditor({
  draft: initial,
  groupOptions,
  onClose,
}: {
  draft: Draft;
  groupOptions: string[];
  onClose: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const narrow = useMediaQuery("(max-width: 47.99em)");
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setD((prev) => ({ ...prev, [k]: v }));

  // Close once the save lands.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) onClose();
  }, [fetcher.state, fetcher.data, onClose]);

  const outline =
    d.shape === "outline" ? (d.outline ?? PRESETS.Triangle) : null;
  const problem = outline ? outlineProblem(outline) : null;

  const save = () => {
    fetcher.submit(
      {
        intent: "save",
        id: d.id ?? "",
        label: d.label,
        groupName: d.groupName,
        color: d.color,
        shape: d.shape,
        width: String(d.width),
        height: String(d.height),
        outline: outline ? JSON.stringify(outline) : "",
        tallFt: String(d.tallFt),
        canopyShade: String(d.canopyShade),
        tags: JSON.stringify(d.tags),
        personal: String(d.personal),
        rigid: String(d.rigid),
        fixedRotation: String(d.fixedRotation),
        description: d.description ?? "",
      },
      { method: "post" },
    );
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={d.id ? `Edit ${initial.label}` : "New camp structure"}
      size="xl"
      fullScreen={narrow}
    >
      <Stack gap="sm">
        <Group grow align="flex-start" wrap={narrow ? "wrap" : "nowrap"}>
          <TextInput
            label="Name"
            required
            maxLength={60}
            value={d.label}
            onChange={(e) => set("label", e.currentTarget.value)}
            data-autofocus
          />
          <Autocomplete
            label="Legend group"
            description="Pick one or type a new one"
            data={groupOptions}
            maxLength={40}
            value={d.groupName}
            onChange={(v) => set("groupName", v)}
          />
        </Group>

        <div>
          <Text size="sm" fw={500} mb={4}>
            Shape
          </Text>
          <SegmentedControl
            fullWidth
            data={CUSTOM_SHAPES.map((s) => ({
              value: s,
              label: CUSTOM_SHAPE_LABELS[s],
            }))}
            value={d.shape}
            onChange={(v) => {
              const shape = v as CustomShape;
              setD((prev) => ({
                ...prev,
                shape,
                outline:
                  shape === "outline"
                    ? (prev.outline ?? PRESETS.Triangle)
                    : prev.outline,
              }));
            }}
          />
        </div>

        <ShapePreview
          draft={d}
          outline={outline}
          onOutline={(pts) => set("outline", pts)}
        />
        {problem ? (
          <Text size="sm" c="red">
            {problem}
          </Text>
        ) : null}

        <Group grow align="flex-start">
          <NumberInput
            label="Width (ft)"
            description="Along the street"
            min={1}
            max={MAX_FT}
            decimalScale={1}
            value={d.width}
            onChange={(v) => set("width", Number(v) || 1)}
          />
          <NumberInput
            label="Depth (ft)"
            description="Into the lot"
            min={1}
            max={MAX_FT}
            decimalScale={1}
            value={d.height}
            onChange={(v) => set("height", Number(v) || 1)}
          />
          <NumberInput
            label="Height (ft)"
            description="For shade and radio"
            min={0}
            max={MAX_TALL_FT}
            decimalScale={1}
            value={d.tallFt}
            onChange={(v) => set("tallFt", Number(v) || 0)}
          />
        </Group>

        <ColorInput
          label="Color"
          format="hex"
          swatches={SWATCHES}
          value={d.color}
          onChange={(v) => set("color", v)}
        />

        <div>
          <Text size="sm" fw={500} mb={4}>
            Counts as
          </Text>
          <Chip.Group
            multiple
            value={d.tags}
            onChange={(v) => set("tags", v as KindTag[])}
          >
            <Group gap="xs">
              {(Object.keys(TAG_LABELS) as KindTag[]).map((t) => (
                <Chip key={t} value={t} size="sm">
                  {TAG_LABELS[t]}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Text size="xs" c="dimmed" mt={4}>
            Used by map filters. Sleeping structures show their owner's name and
            hold occupants.
          </Text>
        </div>

        <Stack gap={6}>
          <Checkbox
            label="Shade cloth: blocks sun, not wind or radio"
            checked={d.canopyShade}
            onChange={(e) => set("canopyShade", e.currentTarget.checked)}
          />
          <Checkbox
            label="Campers can bring their own (Bringing page)"
            checked={d.personal}
            onChange={(e) => set("personal", e.currentTarget.checked)}
          />
          <Checkbox
            label="Fixed size (no resizing on the map)"
            checked={d.rigid}
            onChange={(e) => set("rigid", e.currentTarget.checked)}
          />
          <Checkbox
            label="No facing (no rotate handle)"
            checked={d.fixedRotation}
            onChange={(e) => set("fixedRotation", e.currentTarget.checked)}
          />
        </Stack>

        <Textarea
          label="Description"
          autosize
          minRows={2}
          maxLength={500}
          value={d.description ?? ""}
          onChange={(e) => set("description", e.currentTarget.value || null)}
        />

        {fetcher.data?.error ? (
          <Alert color="red" variant="light">
            {fetcher.data.error}
          </Alert>
        ) : null}
        {d.id ? (
          <Text size="xs" c="dimmed">
            Changes to size or color apply to newly placed items; existing items
            keep their current values.
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            loading={fetcher.state !== "idle"}
            disabled={!d.label.trim() || !!problem}
          >
            {d.id ? "Save" : "Create"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Starting outlines, 0..1 of the box. */
const PRESETS = {
  Triangle: [
    { x: 0.5, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  "L-shape": [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  Trapezoid: [
    { x: 0.25, y: 0 },
    { x: 0.75, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  Box: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
} satisfies Record<string, UnitPt[]>;

/** Snap step for outline points, feet. */
const SNAP_FT = 0.5;

/**
 * The structure at scale on a 1-foot grid. For a custom outline it's also the
 * editor: drag a corner to move it, click an edge or empty space to add one
 * there, select a corner and press Delete (or the button) to remove it.
 */
function ShapePreview({
  draft: d,
  outline,
  onOutline,
}: {
  draft: Draft;
  outline: UnitPt[] | null;
  onOutline: (pts: UnitPt[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const W = Math.max(1, d.width);
  const H = Math.max(1, d.height);
  const pad = Math.max(W, H) * 0.08;
  const r = Math.max(W, H) * 0.025;
  const step = Math.max(W, H) > 60 ? 5 : 1;
  const unit = outline ?? unitOutline({ shape: d.shape, outline: null });

  const toUnit = (e: { clientX: number; clientY: number }): UnitPt | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    const snap = (v: number, max: number) =>
      Math.min(max, Math.max(0, Math.round(v / SNAP_FT) * SNAP_FT)) / max;
    return { x: snap(p.x, W), y: snap(p.y, H) };
  };

  const editable = d.shape === "outline" && outline != null;

  const onBackgroundDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editable || !outline) return;
    const p = toUnit(e);
    if (!p) return;
    // Insert into the nearest edge, so the outline stays one loop.
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i] as UnitPt;
      const b = outline[(i + 1) % outline.length] as UnitPt;
      const dist = segDist({ x: p.x * W, y: p.y * H }, a, b, W, H);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    const next = [...outline];
    next.splice(best + 1, 0, p);
    onOutline(next);
    setSelected(best + 1);
    setDragging(best + 1);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const remove = () => {
    if (!outline || selected == null || outline.length <= 3) return;
    onOutline(outline.filter((_, i) => i !== selected));
    setSelected(null);
  };

  const fill = d.canopyShade ? 0.25 : 0.78;
  return (
    <Stack gap={6}>
      <svg
        ref={svgRef}
        viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`}
        style={{
          width: "100%",
          maxHeight: 320,
          background: "var(--mantine-color-default)",
          border: "1px solid var(--mantine-color-default-border)",
          borderRadius: 6,
          touchAction: editable ? "none" : undefined,
          cursor: editable ? "crosshair" : undefined,
        }}
        tabIndex={editable ? 0 : undefined}
        aria-label={`Preview of ${d.label || "the structure"}, ${W} by ${H} feet`}
        onPointerDown={onBackgroundDown}
        onPointerMove={(e) => {
          if (dragging == null || !outline) return;
          const p = toUnit(e);
          if (!p) return;
          onOutline(outline.map((q, i) => (i === dragging ? p : q)));
        }}
        onPointerUp={() => setDragging(null)}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            remove();
          }
        }}
      >
        {/* Foot grid over the box. */}
        <g stroke="var(--mantine-color-dimmed)" strokeOpacity={0.25}>
          {Array.from({ length: Math.floor(W / step) + 1 }, (_, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: grid lines are positional
              key={`v${i}`}
              x1={i * step}
              y1={0}
              x2={i * step}
              y2={H}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {Array.from({ length: Math.floor(H / step) + 1 }, (_, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: grid lines are positional
              key={`h${i}`}
              x1={0}
              y1={i * step}
              x2={W}
              y2={i * step}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {unit ? (
          <polygon
            points={unit.map((p) => `${p.x * W},${p.y * H}`).join(" ")}
            fill={d.color}
            fillOpacity={fill}
            stroke={d.color}
            strokeWidth={2}
            strokeDasharray={d.canopyShade ? "6 4" : undefined}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ) : (
          <rect
            x={0}
            y={0}
            width={W}
            height={H}
            rx={Math.min(W, H) * 0.03}
            fill={d.color}
            fillOpacity={fill}
            stroke={d.color}
            strokeWidth={2}
            strokeDasharray={d.canopyShade ? "6 4" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {editable && outline
          ? outline.map((p, i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: corners are positional
                key={i}
                cx={p.x * W}
                cy={p.y * H}
                r={r}
                fill={selected === i ? "#1c1c1c" : "#fff"}
                stroke="#1c1c1c"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "grab" }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setSelected(i);
                  setDragging(i);
                  svgRef.current?.setPointerCapture(e.pointerId);
                }}
              />
            ))
          : null}
        {/* Street side marker. */}
        <text
          x={W / 2}
          y={-pad * 0.3}
          fontSize={pad * 0.6}
          textAnchor="middle"
          fill="var(--mantine-color-dimmed)"
        >
          Street side
        </text>
      </svg>
      {editable ? (
        <Group gap="xs" justify="space-between">
          <Group gap={4}>
            <Text size="xs" c="dimmed">
              Start from:
            </Text>
            {Object.entries(PRESETS).map(([name, pts]) => (
              <Button
                key={name}
                size="compact-xs"
                variant="default"
                onClick={() => {
                  onOutline(pts);
                  setSelected(null);
                }}
              >
                {name}
              </Button>
            ))}
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            disabled={selected == null || (outline?.length ?? 0) <= 3}
            onClick={remove}
          >
            Remove corner
          </Button>
        </Group>
      ) : null}
      {editable ? (
        <Text size="xs" c="dimmed">
          Drag a corner to move it. Click anywhere else to add a corner on the
          nearest edge. Corners snap to half a foot.
        </Text>
      ) : null}
    </Stack>
  );
}

/** Distance (feet) from p to segment a→b, with a and b in 0..1 box units. */
function segDist(
  p: { x: number; y: number },
  a: UnitPt,
  b: UnitPt,
  W: number,
  H: number,
): number {
  const ax = a.x * W;
  const ay = a.y * H;
  const bx = b.x * W;
  const by = b.y * H;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2),
  );
  return Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
}
