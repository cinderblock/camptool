import {
  ActionIcon,
  Button,
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

// Structure palette. Each kind carries a footprint `shape`, default size (feet),
// and vehicle rules: `vehicle` = fixed width + length-only; `rigid` = no resize.
type ShapeKind = "rect" | "hexagon" | "diamond" | "hypar";
type Kind = {
  value: string;
  label: string;
  color: string;
  w: number;
  h: number;
  shape: ShapeKind;
  vehicle: boolean;
  rigid: boolean;
};
const KINDS = [
  {
    value: "tent",
    label: "Tent",
    color: "#12b886",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    // Regular hexagon, 8ft edges → 16ft point-to-point, 8√3 ≈ 13.86ft flat-to-flat.
    value: "hexayurt",
    label: "Hexayurt",
    color: "#0ca678",
    w: 16,
    h: 13.86,
    shape: "hexagon",
    vehicle: false,
    rigid: true,
  },
  {
    // 8ft square base; the roof is a hypar with one high corner (diagonal gradient).
    value: "hyparhut",
    label: "Hyparhut",
    color: "#15aabf",
    w: 8,
    h: 8,
    shape: "hypar",
    vehicle: false,
    rigid: true,
  },
  {
    value: "rv",
    label: "RV / trailer",
    color: "#228be6",
    w: 8,
    h: 24,
    shape: "rect",
    vehicle: true,
    rigid: false,
  },
  {
    value: "car",
    label: "Car",
    color: "#4263eb",
    w: 6,
    h: 14,
    shape: "rect",
    vehicle: true,
    rigid: true,
  },
  {
    value: "truck",
    label: "Truck",
    color: "#3b5bdb",
    w: 7,
    h: 19,
    shape: "rect",
    vehicle: true,
    rigid: true,
  },
  {
    value: "shade",
    label: "Shade",
    color: "#f59f00",
    w: 20,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    value: "kitchen",
    label: "Kitchen",
    color: "#fd7e14",
    w: 16,
    h: 16,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    value: "art",
    label: "Art",
    color: "#ae3ec9",
    w: 15,
    h: 15,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    value: "power",
    label: "Generator",
    color: "#e03131",
    w: 6,
    h: 8,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    value: "container",
    label: "Container",
    color: "#868e96",
    w: 8,
    h: 20,
    shape: "rect",
    vehicle: false,
    rigid: false,
  },
  {
    value: "structure",
    label: "Other",
    color: "#7048e8",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
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

/** Polygon points for a non-rect footprint inside the box (x,y,w,h). */
function footprintPoints(
  shape: ShapeKind,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  if (shape === "diamond") {
    return `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
  }
  // flat-top hexagon: corners inset horizontally by w/4
  const i = w / 4;
  return `${x + i},${y} ${x + w - i},${y} ${x + w},${y + h / 2} ${x + w - i},${y + h} ${x + i},${y + h} ${x},${y + h / 2}`;
}

/** Small legend/icon swatch showing a kind's footprint shape. */
function ShapeSwatch({ kind }: { kind: Kind }) {
  const s = 16;
  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    >
      {kind.shape === "hexagon" || kind.shape === "diamond" ? (
        <polygon
          points={footprintPoints(kind.shape, 1, 1, s - 2, s - 2)}
          fill={kind.color}
        />
      ) : kind.shape === "hypar" ? (
        <>
          <rect
            x={2}
            y={2}
            width={s - 4}
            height={s - 4}
            rx={2}
            fill={kind.color}
          />
          <line
            x1={2}
            y1={2}
            x2={s - 2}
            y2={s - 2}
            stroke="#1c1c1c"
            strokeOpacity={0.4}
          />
        </>
      ) : (
        <rect
          x={2}
          y={2}
          width={s - 4}
          height={s - 4}
          rx={2}
          fill={kind.color}
        />
      )}
    </svg>
  );
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

function rotateVec(vx: number, vy: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: vx * cos - vy * sin, y: vx * sin + vy * cos };
}

// Black Rock City orientation, anchored to ground truth: a 3:00 camp's frontage
// faces NE toward the Man. So the bearing the map's "up" (toward the Man, across
// the frontage) points to, for a clock address H, is (135 - 30·H) mod 360
// — 3:00 → 45° (NE), 4:30 → 0° (N), 6:00 → 315° (NW), 12:00 → 135° (SE).
// Sun azimuths are event-week approximations for ~40.8°N (late Aug / early Sep):
// sunrise ENE, sunset WNW.
const SUNRISE_AZ = 73;
const SUNSET_AZ = 287;

/** Parse a clock address like "3:00" or "4:30" to decimal hours (1–12), else null. */
function parseClock(addr: string | null): number | null {
  if (!addr) return null;
  const m = addr.match(/^\s*(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (h < 1 || h > 12 || mm > 59) return null;
  return h + mm / 60;
}

/** Compass bearing (deg from true north) the map's "up" points to, from the
 * clock address. Map-up faces the Man across the frontage. */
function mapUpBearingFor(addr: string | null): number | null {
  const h = parseClock(addr);
  if (h == null) return null;
  return (((135 - 30 * h) % 360) + 360) % 360;
}

type Lot = NonNullable<Route.ComponentProps["loaderData"]["lot"]>;

export default function CampMap({ loaderData }: Route.ComponentProps) {
  const { canEdit, lot } = loaderData;
  const fetcher = useFetcher();
  const [objects, setObjects] = useState<ObjRow[]>(loaderData.objects);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
        <div style={{ flex: "1 1 360px", minWidth: 300, maxWidth: 760 }}>
          <Editor
            lot={lot}
            objects={objects}
            setObjects={setObjects}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            canEdit={canEdit}
            fetcher={fetcher}
          />
        </div>
        <Stack
          gap="md"
          style={{ flex: "1 1 240px", minWidth: 240, maxWidth: 340 }}
        >
          <Compass mapUpBearing={mapUpBearingFor(lot.address)} />
          {canEdit ? <Legend /> : null}
          <SidePanel
            lot={lot}
            objects={objects}
            setObjects={setObjects}
            selectedId={selectedId}
            canEdit={canEdit}
            fetcher={fetcher}
          />
        </Stack>
      </Group>
    </Stack>
  );
}

/** Draggable palette — drag a chip onto the map to place that kind. */
function Legend() {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={6}>
        Legend — drag onto the map
      </Text>
      <Group gap="xs">
        {KINDS.map((k) => (
          <Group
            key={k.value}
            gap={6}
            wrap="nowrap"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/camptool-kind", k.value);
              e.dataTransfer.setData("text/plain", k.value);
              e.dataTransfer.effectAllowed = "copy";
            }}
            style={{
              cursor: "grab",
              border: "1px solid var(--mantine-color-gray-3)",
              borderRadius: 6,
              padding: "2px 8px",
              userSelect: "none",
            }}
          >
            <ShapeSwatch kind={k} />
            <Text size="xs">{k.label}</Text>
          </Group>
        ))}
      </Group>
    </Paper>
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
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  canEdit: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const liveObj = useRef<ObjRow | null>(null);
  const [dragging, setDragging] = useState(false);

  // While dragging, listen on window so the pointer can leave the SVG without
  // dropping the gesture. (Pointer capture + an svg `pointerleave` handler ends
  // the drag on the very first move, so we avoid both.)
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onMove(e);
    const up = () => endDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging]);

  // Keyboard shortcuts for the selected object: R rotates (Shift = the other
  // way), arrows nudge (Shift = 10ft), Delete removes, Escape deselects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commit/fetcher are stable
  useEffect(() => {
    if (!canEdit) return;
    function onKey(e: KeyboardEvent) {
      if (!selectedId) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.isContentEditable
      )
        return;
      const obj = objects.find((o) => o.id === selectedId);
      if (!obj) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        setObjects((prev) => prev.filter((o) => o.id !== selectedId));
        fetcher.submit(
          { intent: "deleteObject", id: selectedId },
          { method: "post" },
        );
        setSelectedId(null);
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      let next: ObjRow | null = null;
      if (e.key === "r" || e.key === "R") {
        next = {
          ...obj,
          rotation: Math.round(obj.rotation + (e.shiftKey ? -15 : 15)),
        };
      } else if (e.key === "ArrowLeft") {
        next = { ...obj, x: clamp(obj.x - step, 0, lot.frontageFt) };
      } else if (e.key === "ArrowRight") {
        next = { ...obj, x: clamp(obj.x + step, 0, lot.frontageFt) };
      } else if (e.key === "ArrowUp") {
        next = { ...obj, y: clamp(obj.y - step, 0, lot.depthFt) };
      } else if (e.key === "ArrowDown") {
        next = { ...obj, y: clamp(obj.y + step, 0, lot.depthFt) };
      }
      if (!next) return;
      e.preventDefault();
      const committed = next;
      setObjects((prev) =>
        prev.map((o) => (o.id === selectedId ? committed : o)),
      );
      commit(committed);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, selectedId, objects, lot.frontageFt, lot.depthFt]);

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
  const rearCenterX = MARGIN + (maxWidthFt / 2) * ppf;
  const yBot = originY + lot.depthFt * ppf;
  // Trapezoid outline (front edge, then rear edge wider when tapered).
  const lotPoints = `${originX},${originY} ${originX + lot.frontageFt * ppf},${originY} ${rearCenterX + (rear / 2) * ppf},${yBot} ${rearCenterX - (rear / 2) * ppf},${yBot}`;

  const fx = (sx: number) => (sx - originX) / ppf;
  const fy = (sy: number) => (sy - originY) / ppf;

  function svgPoint(e: { clientX: number; clientY: number }) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * VIEW_W) / rect.width,
      y: ((e.clientY - rect.top) * viewH) / rect.height,
    };
  }

  function applyDrag(d: DragState, curFx: number, curFy: number): ObjRow {
    const s = d.start;
    if (d.mode === "move") {
      return {
        ...s,
        x: clamp(s.x + (curFx - d.startFx), 0, lot.frontageFt),
        y: clamp(s.y + (curFy - d.startFy), 0, lot.depthFt),
      };
    }
    const cxFt = s.x + s.width / 2;
    const cyFt = s.y + s.height / 2;
    if (d.mode === "resize") {
      // Keep the opposite (top-left) corner pinned in world space while the
      // bottom-right handle follows the pointer — correct even when rotated.
      const tl = rotateVec(-s.width / 2, -s.height / 2, s.rotation);
      const ax = cxFt + tl.x;
      const ay = cyFt + tl.y;
      const loc = rotateVec(curFx - ax, curFy - ay, -s.rotation);
      const width = Math.max(2, loc.x);
      const height = Math.max(2, loc.y);
      const half = rotateVec(width / 2, height / 2, s.rotation);
      const cx = ax + half.x;
      const cy = ay + half.y;
      return { ...s, width, height, x: cx - width / 2, y: cy - height / 2 };
    }
    const ang = (Math.atan2(curFy - cyFt, curFx - cxFt) * 180) / Math.PI;
    return { ...s, rotation: ang + 90 };
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
    e.preventDefault();
    const p = svgPoint(e);
    drag.current = {
      mode,
      id: o.id,
      startFx: fx(p.x),
      startFy: fy(p.y),
      start: o,
    };
    liveObj.current = o;
    setSelectedId(o.id);
    setDragging(true);
  }

  function onMove(e: { clientX: number; clientY: number }) {
    const d = drag.current;
    if (!d) return;
    const p = svgPoint(e);
    const next = applyDrag(d, fx(p.x), fy(p.y));
    liveObj.current = next;
    setObjects((prev) => prev.map((o) => (o.id === d.id ? next : o)));
  }

  function endDrag() {
    const d = drag.current;
    const o = liveObj.current;
    drag.current = null;
    liveObj.current = null;
    setDragging(false);
    if (d && o) commit(o);
  }

  function addObjectAt(kind: string, fxFeet: number, fyFeet: number) {
    const def = kindDef(kind);
    fetcher.submit(
      {
        intent: "addObject",
        kind,
        x: round(
          clamp(fxFeet - def.w / 2, 0, Math.max(0, lot.frontageFt - def.w)),
        ),
        y: round(
          clamp(fyFeet - def.h / 2, 0, Math.max(0, lot.depthFt - def.h)),
        ),
        width: def.w,
        height: def.h,
      },
      { method: "post" },
    );
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const kind =
      e.dataTransfer.getData("application/camptool-kind") ||
      e.dataTransfer.getData("text/plain");
    if (!kind || !KIND_MAP[kind]) return;
    const p = svgPoint(e);
    addObjectAt(kind, fx(p.x), fy(p.y));
  }

  const clipId = "lot-clip";
  return (
    <Paper
      withBorder
      radius="md"
      p={0}
      style={{ overflow: "hidden", display: "inline-block", maxWidth: "100%" }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${viewH}`}
        width={VIEW_W}
        height={viewH}
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: "calc(100vh - 180px)",
          width: "auto",
          height: "auto",
          touchAction: "none",
        }}
        onPointerDown={() => setSelectedId(null)}
        onDragOver={canEdit ? (e) => e.preventDefault() : undefined}
        onDrop={canEdit ? onDrop : undefined}
        role="img"
        aria-label="Camp layout"
      >
        <title>Camp layout</title>
        <defs>
          <linearGradient id="hypar-roof" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0.55} />
            <stop offset="1" stopColor="#000000" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <clipPath id={clipId}>
          <polygon points={lotPoints} />
        </clipPath>
        <g clipPath={`url(#${clipId})`}>
          <Grid
            frontageFt={lot.frontageFt}
            depthFt={lot.depthFt}
            rear={rear}
            originX={originX}
            originY={originY}
            rearCenterX={rearCenterX}
            ppf={ppf}
          />
        </g>
        <polygon
          points={lotPoints}
          fill="none"
          stroke="#adb5bd"
          strokeWidth={2}
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
  );
}

function Grid({
  frontageFt,
  depthFt,
  rear,
  originX,
  originY,
  rearCenterX,
  ppf,
}: {
  frontageFt: number;
  depthFt: number;
  rear: number;
  originX: number;
  originY: number;
  rearCenterX: number;
  ppf: number;
}) {
  const lines = [];
  const yTop = originY;
  const yBot = originY + depthFt * ppf;
  // Radial lines every 10ft of frontage; they fan out to the wider rear edge.
  for (let f = 0; f <= frontageFt + 0.01; f += 10) {
    const p = frontageFt > 0 ? f / frontageFt : 0;
    const major = Math.round(f) % 50 === 0;
    lines.push(
      <line
        key={`v${f}`}
        x1={originX + f * ppf}
        y1={yTop}
        x2={rearCenterX + (p - 0.5) * rear * ppf}
        y2={yBot}
        stroke={major ? "#dee2e6" : "#f1f3f5"}
        strokeWidth={major ? 1.5 : 1}
      />,
    );
  }
  // Concentric lines every 10ft of depth; width grows with the taper.
  for (let d = 0; d <= depthFt + 0.01; d += 10) {
    const t = depthFt > 0 ? d / depthFt : 0;
    const w = frontageFt + (rear - frontageFt) * t;
    const y = originY + d * ppf;
    const major = Math.round(d) % 50 === 0;
    lines.push(
      <line
        key={`h${d}`}
        x1={rearCenterX - (w / 2) * ppf}
        y1={y}
        x2={rearCenterX + (w / 2) * ppf}
        y2={y}
        stroke={major ? "#dee2e6" : "#f1f3f5"}
        strokeWidth={major ? 1.5 : 1}
      />,
    );
  }
  return <g>{lines}</g>;
}

/** Standalone compass widget (its own SVG) so it never overlaps the map. */
function Compass({ mapUpBearing }: { mapUpBearing: number | null }) {
  const S = 168;
  const cx = S / 2;
  const cy = S / 2 + 4;
  const r = 60;
  const vec = (bearing: number) => {
    const phi = (((bearing - (mapUpBearing ?? 0)) % 360) * Math.PI) / 180;
    return { x: Math.sin(phi), y: -Math.cos(phi) };
  };
  const ray = (
    bearing: number,
    color: string,
    label: string,
    opts?: { lw?: number; weight?: number; len?: number },
  ) => {
    const u = vec(bearing);
    const len = opts?.len ?? r;
    return (
      <g key={label}>
        <line
          x1={cx}
          y1={cy}
          x2={cx + u.x * len}
          y2={cy + u.y * len}
          stroke={color}
          strokeWidth={opts?.lw ?? 1.25}
        />
        <text
          x={cx + u.x * (r + 9)}
          y={cy + u.y * (r + 9)}
          fontSize={10}
          fontWeight={opts?.weight ?? 400}
          fill={color}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {label}
        </text>
      </g>
    );
  };
  // Daylight wedge: from sunrise clockwise through the south to sunset.
  const dr = vec(SUNRISE_AZ);
  const ds = vec(SUNSET_AZ);
  const daylight = `M ${cx} ${cy} L ${cx + dr.x * r} ${cy + dr.y * r} A ${r} ${r} 0 1 1 ${cx + ds.x * r} ${cy + ds.y * r} Z`;
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={4}>
        Orientation
      </Text>
      <svg
        viewBox={`0 0 ${S} ${S}`}
        style={{
          width: "100%",
          maxWidth: 190,
          height: "auto",
          display: "block",
        }}
        role="img"
        aria-label="Compass"
      >
        <title>Compass</title>
        <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke="#dee2e6" />
        {mapUpBearing != null ? (
          <path d={daylight} fill="#ffe066" fillOpacity={0.4} stroke="none" />
        ) : null}
        <line x1={cx} y1={cy} x2={cx} y2={cy - r + 20} stroke="#1c1c1c" />
        <ManGlyph x={cx} y={cy - r + 12} size={22} />
        {mapUpBearing != null ? (
          <>
            {ray(0, "#e03131", "N", { lw: 2, weight: 700 })}
            {ray(90, "#adb5bd", "E", { lw: 0.6 })}
            {ray(180, "#adb5bd", "S", { lw: 0.6 })}
            {ray(270, "#adb5bd", "W", { lw: 0.6 })}
            {ray(SUNRISE_AZ, "#f08c00", "rise", { len: r - 10 })}
            {ray(SUNSET_AZ, "#5f3dc4", "set", { len: r - 10 })}
          </>
        ) : null}
      </svg>
      {mapUpBearing == null ? (
        <Text size="xs" c="dimmed" mt={4}>
          Set the lot address (e.g. 3:00) for true north & sun.
        </Text>
      ) : null}
    </Paper>
  );
}

/** Minimal "the Man" glyph — a stick figure with arms raised, centered at (x,y). */
function ManGlyph({ x, y, size }: { x: number; y: number; size: number }) {
  const s = size / 22;
  return (
    <g
      stroke="#1c1c1c"
      strokeWidth={1.6}
      strokeLinecap="round"
      fill="none"
      pointerEvents="none"
    >
      <circle cx={x} cy={y - 9 * s} r={2.4 * s} fill="#1c1c1c" stroke="none" />
      <line x1={x} y1={y - 6.5 * s} x2={x} y2={y + 3 * s} />
      <line x1={x} y1={y - 4.5 * s} x2={x - 6 * s} y2={y - 11 * s} />
      <line x1={x} y1={y - 4.5 * s} x2={x + 6 * s} y2={y - 11 * s} />
      <line x1={x} y1={y + 3 * s} x2={x - 4.5 * s} y2={y + 10 * s} />
      <line x1={x} y1={y + 3 * s} x2={x + 4.5 * s} y2={y + 10 * s} />
    </g>
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
  const def = kindDef(o.kind);
  const px = originX + o.x * ppf;
  const py = originY + o.y * ppf;
  const w = o.width * ppf;
  const h = o.height * ppf;
  const cx = px + w / 2;
  const cy = py + h / 2;
  const fill = o.color ?? def.color;
  const bodyStyle = { cursor: canEdit ? "move" : "default" } as const;
  return (
    <g transform={`rotate(${o.rotation} ${cx} ${cy})`}>
      {def.shape === "rect" ? (
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
          style={bodyStyle}
          onPointerDown={onBodyDown}
        />
      ) : def.shape === "hypar" ? (
        <>
          <rect
            x={px}
            y={py}
            width={w}
            height={h}
            rx={2}
            fill={fill}
            fillOpacity={0.78}
            stroke={selected ? "#1c1c1c" : fill}
            strokeWidth={selected ? 2 : 1}
            style={bodyStyle}
            onPointerDown={onBodyDown}
          />
          {/* Roof shading: high corner (top-left) light → low corner dark. */}
          <rect
            x={px}
            y={py}
            width={w}
            height={h}
            rx={2}
            fill="url(#hypar-roof)"
            pointerEvents="none"
          />
          <line
            x1={px}
            y1={py}
            x2={px + w}
            y2={py + h}
            stroke="#1c1c1c"
            strokeOpacity={0.3}
            pointerEvents="none"
          />
          <circle
            cx={px + 3}
            cy={py + 3}
            r={2}
            fill="#fff"
            stroke="#1c1c1c"
            strokeWidth={1}
            pointerEvents="none"
          />
        </>
      ) : (
        <polygon
          points={footprintPoints(def.shape, px, py, w, h)}
          fill={fill}
          fillOpacity={0.78}
          stroke={selected ? "#1c1c1c" : fill}
          strokeWidth={selected ? 2 : 1}
          style={bodyStyle}
          onPointerDown={onBodyDown}
        />
      )}
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
          {def.vehicle || def.rigid ? null : (
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
          )}
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
  function commitMany(id: string, fields: Record<string, string | number>) {
    fetcher.submit(
      { intent: "updateObject", id, ...fields },
      { method: "post" },
    );
  }

  return (
    <Stack gap="md">
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
                const d = kindDef(v);
                const fields: Partial<ObjRow> = { kind: v };
                const out: Record<string, string | number> = { kind: v };
                // Rigid kinds (hexayurt, hyparhut, car, truck) snap to a fixed
                // footprint; RVs snap only their fixed width.
                if (d.rigid || d.vehicle) {
                  fields.width = d.w;
                  out.width = d.w;
                }
                if (d.rigid) {
                  fields.height = d.h;
                  out.height = d.h;
                }
                patch(selected.id, fields);
                commitMany(selected.id, out);
              }}
            />
            {kindDef(selected.kind).rigid ? (
              <Text size="xs" c="dimmed">
                {fixedSizeLabel(selected.kind, selected.width, selected.height)}
              </Text>
            ) : kindDef(selected.kind).vehicle ? (
              <Group grow>
                <NumberInput
                  size="xs"
                  label="Width (ft)"
                  description="fixed"
                  value={Math.round(selected.width)}
                  disabled
                />
                <NumberInput
                  size="xs"
                  label="Length (ft)"
                  value={Math.round(selected.height)}
                  min={6}
                  disabled={!canEdit}
                  onChange={(v) =>
                    patch(selected.id, { height: Number(v) || 6 })
                  }
                  onBlur={() =>
                    commitField(selected.id, "height", round(selected.height))
                  }
                />
              </Group>
            ) : (
              <Group grow>
                <NumberInput
                  size="xs"
                  label="Width (ft)"
                  value={Math.round(selected.width)}
                  min={2}
                  disabled={!canEdit}
                  onChange={(v) =>
                    patch(selected.id, { width: Number(v) || 2 })
                  }
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
                  onChange={(v) =>
                    patch(selected.id, { height: Number(v) || 2 })
                  }
                  onBlur={() =>
                    commitField(selected.id, "height", round(selected.height))
                  }
                />
              </Group>
            )}
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
function fixedSizeLabel(kind: string, w: number, h: number): string {
  if (kind === "hexayurt") return "Fixed: 8′ edges (≈16′ across)";
  if (kind === "hyparhut") return "Fixed: 8′ square";
  return `Fixed footprint: ${round(w)}′ × ${round(h)}′`;
}
