import {
  ActionIcon,
  Button,
  ColorSwatch,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { and, eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import { db } from "../../../db/client.server";
import { mapObject, placement } from "../../../db/schema";
import type { Route } from "./+types/map";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp map · CampTool" }];
}

// Structure palette: value → label + default color + default size (feet).
const KINDS = [
  { value: "tent", label: "Tent", color: "#12b886", w: 10, h: 10 },
  { value: "rv", label: "RV / trailer", color: "#228be6", w: 12, h: 30 },
  { value: "shade", label: "Shade", color: "#f59f00", w: 20, h: 20 },
  { value: "kitchen", label: "Kitchen", color: "#fd7e14", w: 16, h: 16 },
  { value: "art", label: "Art", color: "#ae3ec9", w: 15, h: 15 },
  { value: "power", label: "Generator / power", color: "#e03131", w: 6, h: 8 },
  { value: "container", label: "Container", color: "#868e96", w: 8, h: 20 },
  {
    value: "structure",
    label: "Other structure",
    color: "#4263eb",
    w: 10,
    h: 10,
  },
] as const;

const KIND_MAP: Record<string, (typeof KINDS)[number]> = Object.fromEntries(
  KINDS.map((k) => [k.value, k]),
);
const FALLBACK_KIND = KINDS.find((k) => k.value === "structure") ?? KINDS[0];
function kindDef(kind: string): (typeof KINDS)[number] {
  return KIND_MAP[kind] ?? FALLBACK_KIND;
}
function kindColor(kind: string) {
  return kindDef(kind).color;
}

type ObjRow = {
  id: string;
  name: string | null;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color: string | null;
  notes: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const { active } = await requireActiveCamp(request);
  const campId = active.camp.id;

  const [lot] = await db
    .select()
    .from(placement)
    .where(eq(placement.campId, campId))
    .limit(1);

  const objects = await db
    .select()
    .from(mapObject)
    .where(eq(mapObject.campId, campId));

  return {
    canEdit: hasAtLeast(active.membership.role, "member"),
    campName: active.camp.name,
    lot: lot
      ? {
          street: lot.street,
          address: lot.address,
          frontageFt: lot.frontageFt,
          depthFt: lot.depthFt,
          innerRadiusFt: lot.innerRadiusFt,
          notes: lot.notes,
        }
      : null,
    objects: objects.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.kind,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      rotation: o.rotation,
      color: o.color,
      notes: o.notes,
    })) satisfies ObjRow[],
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active } = await requireActiveCamp(request);
  const campId = active.camp.id;
  if (!hasAtLeast(active.membership.role, "member")) {
    return data(
      { error: "You don't have permission to edit the map." },
      {
        status: 403,
      },
    );
  }

  const form = await request.formData();
  const intent = String(form.get("intent"));
  const num = (k: string, fallback = 0) => {
    const v = form.get(k);
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (k: string) => {
    const v = form.get(k);
    return v == null || v === "" ? null : String(v);
  };

  if (intent === "savePlacement") {
    const values = {
      street: str("street"),
      address: str("address"),
      frontageFt: Math.max(1, num("frontageFt", 100)),
      depthFt: Math.max(1, num("depthFt", 100)),
      innerRadiusFt: form.get("innerRadiusFt") ? num("innerRadiusFt") : null,
      notes: str("notes"),
      updatedAt: new Date(),
    };
    const [existing] = await db
      .select({ id: placement.id })
      .from(placement)
      .where(eq(placement.campId, campId))
      .limit(1);
    if (existing) {
      await db
        .update(placement)
        .set(values)
        .where(eq(placement.id, existing.id));
    } else {
      await db
        .insert(placement)
        .values({ id: crypto.randomUUID(), campId, ...values });
    }
    return data({ ok: true });
  }

  if (intent === "addObject") {
    const kind = String(form.get("kind") ?? "structure");
    const def = kindDef(kind);
    const row = {
      id: crypto.randomUUID(),
      campId,
      name: str("name"),
      kind,
      x: num("x", 0),
      y: num("y", 0),
      width: Math.max(1, num("width", def.w)),
      height: Math.max(1, num("height", def.h)),
      rotation: num("rotation", 0),
      color: str("color"),
      notes: str("notes"),
      createdById: user.id,
    };
    await db.insert(mapObject).values(row);
    return data({
      created: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        rotation: row.rotation,
        color: row.color,
        notes: row.notes,
      } satisfies ObjRow,
    });
  }

  if (intent === "updateObject") {
    const id = String(form.get("id"));
    const [owned] = await db
      .select({ id: mapObject.id })
      .from(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.campId, campId)))
      .limit(1);
    if (!owned) return data({ error: "Object not found." }, { status: 404 });

    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ["x", "y", "width", "height", "rotation"] as const) {
      if (form.get(key) != null) set[key] = num(key);
    }
    if (form.has("name")) set.name = str("name");
    if (form.has("kind")) set.kind = String(form.get("kind"));
    if (form.has("color")) set.color = str("color");
    if (form.has("notes")) set.notes = str("notes");
    await db.update(mapObject).set(set).where(eq(mapObject.id, id));
    return data({ ok: true });
  }

  if (intent === "deleteObject") {
    const id = String(form.get("id"));
    await db
      .delete(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.campId, campId)));
    return data({ ok: true });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ---- Geometry helpers -------------------------------------------------------

const VIEW_W = 920;
const MARGIN = 28;

function rotatePoint(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number,
) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

type Lot = NonNullable<Route.ComponentProps["loaderData"]["lot"]>;

export default function CampMap({ loaderData }: Route.ComponentProps) {
  const { canEdit, lot } = loaderData;
  const fetcher = useFetcher();
  const [objects, setObjects] = useState<ObjRow[]>(loaderData.objects);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<string>("tent");

  // Append server-created objects (with their real id) once the add resolves.
  const lastCreated = useRef<string | null>(null);
  useEffect(() => {
    const created = (fetcher.data as { created?: ObjRow } | undefined)?.created;
    if (created && created.id !== lastCreated.current) {
      lastCreated.current = created.id;
      setObjects((prev) =>
        prev.some((o) => o.id === created.id) ? prev : [...prev, created],
      );
      setSelectedId(created.id);
    }
  }, [fetcher.data]);

  if (!lot) {
    return (
      <Stack gap="lg" maw={620}>
        <Title order={2}>Camp map</Title>
        <Text c="dimmed">
          Set your lot dimensions to start laying out camp. You can refine the
          street and city placement anytime.
        </Text>
        {canEdit ? (
          <PlacementForm lot={null} fetcher={fetcher} />
        ) : (
          <Text c="dimmed">No lot has been set up yet.</Text>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Camp map</Title>
          <Text c="dimmed" size="sm">
            {lot.frontageFt}′ frontage × {lot.depthFt}′ deep
            {lot.street ? ` · ${lot.street}` : ""}
            {lot.address ? ` @ ${lot.address}` : ""}
          </Text>
        </div>
      </Group>

      <Group align="flex-start" gap="lg" wrap="wrap">
        <Editor
          lot={lot}
          objects={objects}
          setObjects={setObjects}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          canEdit={canEdit}
          fetcher={fetcher}
          addKind={addKind}
          setAddKind={setAddKind}
        />
        <SidePanel
          lot={lot}
          objects={objects}
          setObjects={setObjects}
          selectedId={selectedId}
          canEdit={canEdit}
          fetcher={fetcher}
        />
      </Group>
    </Stack>
  );
}

type DragState = {
  mode: "move" | "resize" | "rotate";
  id: string;
  startFx: number;
  startFy: number;
  start: ObjRow;
};

function Editor({
  lot,
  objects,
  setObjects,
  selectedId,
  setSelectedId,
  canEdit,
  fetcher,
  addKind,
  setAddKind,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  canEdit: boolean;
  fetcher: ReturnType<typeof useFetcher>;
  addKind: string;
  setAddKind: (k: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragState | null>(null);

  // Trapezoid taper: rear edge widens with depth when the inner radius is known.
  const rear = lot.innerRadiusFt
    ? lot.frontageFt + (lot.frontageFt * lot.depthFt) / lot.innerRadiusFt
    : lot.frontageFt;
  const maxWidthFt = Math.max(lot.frontageFt, rear);
  const ppf = (VIEW_W - 2 * MARGIN) / maxWidthFt;
  const viewH = Math.round(MARGIN * 2 + lot.depthFt * ppf);
  // Plot-local (0,0) = front-left corner of the frontage edge, in screen px.
  const originX = MARGIN + ((maxWidthFt - lot.frontageFt) / 2) * ppf;
  const originY = MARGIN;

  const fx = (sx: number) => (sx - originX) / ppf;
  const fy = (sy: number) => (sy - originY) / ppf;

  function svgPoint(e: React.PointerEvent) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * VIEW_W) / rect.width,
      y: ((e.clientY - rect.top) * viewH) / rect.height,
    };
  }

  function commit(o: ObjRow) {
    fetcher.submit(
      {
        intent: "updateObject",
        id: o.id,
        x: round(o.x),
        y: round(o.y),
        width: round(o.width),
        height: round(o.height),
        rotation: Math.round(o.rotation),
      },
      { method: "post" },
    );
  }

  function startDrag(
    e: React.PointerEvent,
    o: ObjRow,
    mode: DragState["mode"],
  ) {
    if (!canEdit) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = svgPoint(e);
    drag.current = {
      mode,
      id: o.id,
      startFx: fx(p.x),
      startFy: fy(p.y),
      start: o,
    };
    setSelectedId(o.id);
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = svgPoint(e);
    const curFx = fx(p.x);
    const curFy = fy(p.y);
    setObjects((prev) =>
      prev.map((o) => {
        if (o.id !== d.id) return o;
        if (d.mode === "move") {
          return {
            ...o,
            x: clamp(d.start.x + (curFx - d.startFx), 0, lot.frontageFt),
            y: clamp(d.start.y + (curFy - d.startFy), 0, lot.depthFt),
          };
        }
        if (d.mode === "resize") {
          // Resize in the object's own (rotated) frame so the handle tracks.
          const cxFt = d.start.x + d.start.width / 2;
          const cyFt = d.start.y + d.start.height / 2;
          const local = rotatePoint(
            curFx,
            curFy,
            cxFt,
            cyFt,
            -d.start.rotation,
          );
          return {
            ...o,
            width: Math.max(2, local.x - d.start.x),
            height: Math.max(2, local.y - d.start.y),
          };
        }
        // rotate
        const cxFt = d.start.x + d.start.width / 2;
        const cyFt = d.start.y + d.start.height / 2;
        const ang = (Math.atan2(curFy - cyFt, curFx - cxFt) * 180) / Math.PI;
        return { ...o, rotation: ang + 90 };
      }),
    );
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const o = objects.find((x) => x.id === d.id);
    if (o) commit(o);
  }

  function addObject() {
    const def = kindDef(addKind);
    fetcher.submit(
      {
        intent: "addObject",
        kind: addKind,
        x: round(clamp(lot.frontageFt / 2 - def.w / 2, 0, lot.frontageFt)),
        y: round(Math.min(10, lot.depthFt / 4)),
        width: def.w,
        height: def.h,
      },
      { method: "post" },
    );
  }

  return (
    <Stack gap="xs" style={{ flex: "1 1 560px", minWidth: 320 }}>
      {canEdit ? (
        <Group gap="xs">
          <Select
            size="xs"
            value={addKind}
            onChange={(v) => v && setAddKind(v)}
            data={KINDS.map((k) => ({ value: k.value, label: k.label }))}
            w={190}
            allowDeselect={false}
          />
          <Button size="xs" onClick={addObject}>
            Add structure
          </Button>
          <Text size="xs" c="dimmed">
            Click to select · drag to move · corner = resize · top dot = rotate
          </Text>
        </Group>
      ) : null}

      <Paper withBorder radius="md" p={0} style={{ overflow: "hidden" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${viewH}`}
          style={{
            width: "100%",
            height: "auto",
            display: "block",
            touchAction: "none",
          }}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerDown={() => setSelectedId(null)}
          role="img"
          aria-label="Camp layout"
        >
          <Grid
            originY={originY}
            ppf={ppf}
            widthFt={maxWidthFt}
            depthFt={lot.depthFt}
          />
          <Lot
            lot={lot}
            originX={originX}
            originY={originY}
            ppf={ppf}
            rear={rear}
            maxWidthFt={maxWidthFt}
          />
          {objects.map((o) => (
            <MapObjectShape
              key={o.id}
              o={o}
              originX={originX}
              originY={originY}
              ppf={ppf}
              selected={o.id === selectedId}
              canEdit={canEdit}
              onBodyDown={(e) => startDrag(e, o, "move")}
              onResizeDown={(e) => startDrag(e, o, "resize")}
              onRotateDown={(e) => startDrag(e, o, "rotate")}
            />
          ))}
        </svg>
      </Paper>
      <Group gap="md">
        {KINDS.map((k) => (
          <Group key={k.value} gap={4} wrap="nowrap">
            <ColorSwatch color={k.color} size={12} />
            <Text size="xs" c="dimmed">
              {k.label}
            </Text>
          </Group>
        ))}
      </Group>
    </Stack>
  );
}

function Grid({
  originY,
  ppf,
  widthFt,
  depthFt,
}: {
  originY: number;
  ppf: number;
  widthFt: number;
  depthFt: number;
}) {
  const lines = [];
  const step = 10;
  for (let f = 0; f <= widthFt; f += step) {
    lines.push(
      <line
        key={`v${f}`}
        x1={MARGIN + f * ppf}
        y1={originY}
        x2={MARGIN + f * ppf}
        y2={originY + depthFt * ppf}
        stroke="#f1f3f5"
        strokeWidth={1}
      />,
    );
  }
  for (let f = 0; f <= depthFt; f += step) {
    lines.push(
      <line
        key={`h${f}`}
        x1={MARGIN}
        y1={originY + f * ppf}
        x2={MARGIN + widthFt * ppf}
        y2={originY + f * ppf}
        stroke="#f1f3f5"
        strokeWidth={1}
      />,
    );
  }
  return <g>{lines}</g>;
}

function Lot({
  lot,
  originX,
  originY,
  ppf,
  rear,
  maxWidthFt,
}: {
  lot: Lot;
  originX: number;
  originY: number;
  ppf: number;
  rear: number;
  maxWidthFt: number;
}) {
  const frontLeft = `${originX},${originY}`;
  const frontRight = `${originX + lot.frontageFt * ppf},${originY}`;
  const rearCenterX = MARGIN + (maxWidthFt / 2) * ppf;
  const rearLeft = `${rearCenterX - (rear / 2) * ppf},${originY + lot.depthFt * ppf}`;
  const rearRight = `${rearCenterX + (rear / 2) * ppf},${originY + lot.depthFt * ppf}`;
  return (
    <polygon
      points={`${frontLeft} ${frontRight} ${rearRight} ${rearLeft}`}
      fill="#ffffff"
      stroke="#adb5bd"
      strokeWidth={2}
      strokeDasharray="6 4"
    />
  );
}

function MapObjectShape({
  o,
  originX,
  originY,
  ppf,
  selected,
  canEdit,
  onBodyDown,
  onResizeDown,
  onRotateDown,
}: {
  o: ObjRow;
  originX: number;
  originY: number;
  ppf: number;
  selected: boolean;
  canEdit: boolean;
  onBodyDown: (e: React.PointerEvent) => void;
  onResizeDown: (e: React.PointerEvent) => void;
  onRotateDown: (e: React.PointerEvent) => void;
}) {
  const px = originX + o.x * ppf;
  const py = originY + o.y * ppf;
  const w = o.width * ppf;
  const h = o.height * ppf;
  const cx = px + w / 2;
  const cy = py + h / 2;
  const fill = o.color ?? kindColor(o.kind);
  return (
    <g transform={`rotate(${o.rotation} ${cx} ${cy})`}>
      <rect
        x={px}
        y={py}
        width={w}
        height={h}
        rx={3}
        fill={fill}
        fillOpacity={0.78}
        stroke={selected ? "#1c1c1c" : fill}
        strokeWidth={selected ? 2 : 1}
        style={{ cursor: canEdit ? "move" : "default" }}
        onPointerDown={onBodyDown}
      />
      {o.name && w > 28 ? (
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={11}
          fill="#1c1c1c"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {o.name}
        </text>
      ) : null}
      {selected && canEdit ? (
        <>
          <line
            x1={cx}
            y1={py}
            x2={cx}
            y2={py - 22}
            stroke="#1c1c1c"
            strokeWidth={1}
          />
          <circle
            cx={cx}
            cy={py - 22}
            r={6}
            fill="#fff"
            stroke="#1c1c1c"
            strokeWidth={1.5}
            style={{ cursor: "grab" }}
            onPointerDown={onRotateDown}
          />
          <rect
            x={px + w - 6}
            y={py + h - 6}
            width={12}
            height={12}
            fill="#fff"
            stroke="#1c1c1c"
            strokeWidth={1.5}
            style={{ cursor: "nwse-resize" }}
            onPointerDown={onResizeDown}
          />
        </>
      ) : null}
    </g>
  );
}

function SidePanel({
  lot,
  objects,
  setObjects,
  selectedId,
  canEdit,
  fetcher,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  canEdit: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const selected = objects.find((o) => o.id === selectedId) ?? null;

  function patch(id: string, fields: Partial<ObjRow>) {
    setObjects((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...fields } : o)),
    );
  }
  function commitField(id: string, key: string, value: string | number) {
    fetcher.submit(
      { intent: "updateObject", id, [key]: value },
      { method: "post" },
    );
  }

  return (
    <Stack gap="md" style={{ flex: "0 0 280px", width: 280 }}>
      {selected ? (
        <Paper withBorder p="md" radius="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600} size="sm">
                Selected structure
              </Text>
              {canEdit ? (
                <Tooltip label="Delete">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => {
                      setObjects((prev) =>
                        prev.filter((o) => o.id !== selected.id),
                      );
                      fetcher.submit(
                        { intent: "deleteObject", id: selected.id },
                        { method: "post" },
                      );
                    }}
                  >
                    ✕
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </Group>
            <TextInput
              size="xs"
              label="Name"
              value={selected.name ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                patch(selected.id, { name: e.currentTarget.value })
              }
              onBlur={(e) =>
                commitField(selected.id, "name", e.currentTarget.value)
              }
            />
            <Select
              size="xs"
              label="Kind"
              value={selected.kind}
              disabled={!canEdit}
              data={KINDS.map((k) => ({ value: k.value, label: k.label }))}
              allowDeselect={false}
              onChange={(v) => {
                if (!v) return;
                patch(selected.id, { kind: v });
                commitField(selected.id, "kind", v);
              }}
            />
            <Group grow>
              <NumberInput
                size="xs"
                label="Width (ft)"
                value={Math.round(selected.width)}
                min={2}
                disabled={!canEdit}
                onChange={(v) => patch(selected.id, { width: Number(v) || 2 })}
                onBlur={() =>
                  commitField(selected.id, "width", round(selected.width))
                }
              />
              <NumberInput
                size="xs"
                label="Depth (ft)"
                value={Math.round(selected.height)}
                min={2}
                disabled={!canEdit}
                onChange={(v) => patch(selected.id, { height: Number(v) || 2 })}
                onBlur={() =>
                  commitField(selected.id, "height", round(selected.height))
                }
              />
            </Group>
            <NumberInput
              size="xs"
              label="Rotation (°)"
              value={Math.round(selected.rotation)}
              disabled={!canEdit}
              onChange={(v) => patch(selected.id, { rotation: Number(v) || 0 })}
              onBlur={() =>
                commitField(
                  selected.id,
                  "rotation",
                  Math.round(selected.rotation),
                )
              }
            />
            <Textarea
              size="xs"
              label="Notes"
              autosize
              minRows={2}
              value={selected.notes ?? ""}
              disabled={!canEdit}
              onChange={(e) =>
                patch(selected.id, { notes: e.currentTarget.value })
              }
              onBlur={(e) =>
                commitField(selected.id, "notes", e.currentTarget.value)
              }
            />
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder p="md" radius="md">
          <Text size="sm" c="dimmed">
            {objects.length === 0
              ? "No structures yet. Add one to begin."
              : "Select a structure to edit it."}
          </Text>
        </Paper>
      )}

      {canEdit ? (
        <Paper withBorder p="md" radius="md">
          <Text fw={600} size="sm" mb="sm">
            Lot
          </Text>
          <PlacementForm lot={lot} fetcher={fetcher} />
        </Paper>
      ) : null}
    </Stack>
  );
}

function PlacementForm({
  lot,
  fetcher,
}: {
  lot: Lot | null;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="savePlacement" />
      <Stack gap="sm">
        <Group grow>
          <TextInput
            size="xs"
            label="Street"
            name="street"
            defaultValue={lot?.street ?? ""}
            placeholder="Ellison"
          />
          <TextInput
            size="xs"
            label="Address"
            name="address"
            defaultValue={lot?.address ?? ""}
            placeholder="3:00"
          />
        </Group>
        <Group grow>
          <NumberInput
            size="xs"
            label="Frontage (ft)"
            name="frontageFt"
            defaultValue={lot?.frontageFt ?? 100}
            min={1}
          />
          <NumberInput
            size="xs"
            label="Depth (ft)"
            name="depthFt"
            defaultValue={lot?.depthFt ?? 100}
            min={1}
          />
        </Group>
        <NumberInput
          size="xs"
          label="Inner radius (ft, optional)"
          description="Man→street distance; draws the wedge taper"
          name="innerRadiusFt"
          defaultValue={lot?.innerRadiusFt ?? undefined}
          min={1}
        />
        <Button size="xs" type="submit" loading={fetcher.state !== "idle"}>
          {lot ? "Save lot" : "Create lot"}
        </Button>
      </Stack>
    </fetcher.Form>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v: number) {
  return Math.round(v * 2) / 2;
}
