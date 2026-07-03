import {
  ActionIcon,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Collapse,
  ColorInput,
  Flex,
  Group,
  Menu,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { and, eq } from "drizzle-orm";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { data, useFetcher } from "react-router";
import { BurningManDisclaimer } from "~/components/BurningManDisclaimer";
import { isKindBanned, parseBannedKinds } from "~/lib/bans";
import { BLOCKS, blockById } from "~/lib/blocks";
import {
  CURRENT_EVENT_YEAR,
  clockOptions,
  eventYearOptions,
  hasGeometry,
  mapUpBearingFor,
  radiusForStreet,
  streetLabel,
  streetOptions,
} from "~/lib/brc";
import { isBurningMan } from "~/lib/events";
import { hasAtLeast } from "~/lib/permissions";
import {
  DEFAULT_ROAD_CUTBACK,
  ROAD_KINDS,
  roadKindDef,
  roadKindLabel,
  roadOutline,
} from "~/lib/roads";
import { requireActiveEdition } from "~/lib/session.server";
import {
  AMP_OPTIONS,
  CONTAINER_FULL,
  CONTAINER_HALF,
  CONTAINER_WIDTH,
  GAUGE_OPTIONS,
  KINDS,
  KIND_GROUPS,
  KindIcon,
  hasTag,
  hexPoints,
  hexVertices,
  isKind,
  kindColor,
  kindDef,
  kindHasDoor,
  kindHeight,
} from "~/lib/structures";
import type { StructureConfig } from "~/lib/structures";
import { dayArc, formatClock, minuteForAzimuth, sunAt } from "~/lib/sun";
import {
  BRC_WIND_FROM_BEARING,
  type FlowField,
  sampleFlow,
  solveFlow,
} from "~/lib/wind";
import { db } from "../../../db/client.server";
import {
  camp,
  campEdition,
  mapCable,
  mapObject,
  mapRoad,
  mapZone,
  membership,
  placement,
  user,
} from "../../../db/schema";
import type { Route } from "./+types/map";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp map · CampTool" }];
}

/** Print stylesheet for the map page. Classic isolation: hide all page ink, then
 * reveal only the map column (`.camp-map-print`) and lay it out as a single
 * portrait page. The status watermark is part of the SVG, so it prints for free.
 * A print-only caption (`.camp-map-print-caption`) identifies the sheet. */
const MAP_PRINT_CSS = `
@media print {
  @page { size: portrait; margin: 0.5in; }
  body { background: #fff !important; }
  body * { visibility: hidden !important; }
  .camp-map-print, .camp-map-print * { visibility: visible !important; }
  .camp-map-page { height: auto !important; min-height: 0 !important; }
  .camp-map-print {
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    width: 100% !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  .camp-map-print * {
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
  }
  .camp-map-print svg {
    width: 100% !important;
    height: auto !important;
    max-width: 100% !important;
    max-height: none !important;
  }
  .camp-map-print-caption {
    display: block !important;
    margin: 0 0 8px 0;
    font-size: 12pt;
    color: #000;
  }
}
.camp-map-print-caption { display: none; }
`;

/** Door symbol: opening gap + leaf + swing arc, centered on an edge. Swings
 * OUT (away from the interior). (mx,my) = edge midpoint; (ex,ey) = unit along
 * the edge; (nx,ny) = inward normal; len = door width in px. Drawn in local
 * coords so it rotates with the object. */
// Door linework color — theme-aware (near-black in light mode, near-white in
// dark mode) so doors stay visible on the dark-mode ground.
const DOOR_STROKE = "var(--mantine-color-text)";

function Door({
  mx,
  my,
  ex,
  ey,
  nx,
  ny,
  len,
}: {
  mx: number;
  my: number;
  ex: number;
  ey: number;
  nx: number;
  ny: number;
  len: number;
}) {
  const hx = mx - (ex * len) / 2;
  const hy = my - (ey * len) / 2;
  const lx = mx + (ex * len) / 2;
  const ly = my + (ey * len) / 2;
  // Open 180° outward: the leaf lies flat against the exterior wall, extending
  // from the hinge away from the opening; the swing arc is the outward semicircle.
  const ox = -nx;
  const oy = -ny;
  const off = 1.5;
  const tipx = hx - ex * len;
  const tipy = hy - ey * len;
  const sweep = ey * nx - ex * ny > 0 ? 1 : 0;
  return (
    <g pointerEvents="none">
      <line x1={hx} y1={hy} x2={lx} y2={ly} stroke="#fff" strokeWidth={2.5} />
      <line
        x1={hx + ox * off}
        y1={hy + oy * off}
        x2={tipx + ox * off}
        y2={tipy + oy * off}
        stroke={DOOR_STROKE}
        strokeWidth={1}
      />
      <path
        d={`M ${lx} ${ly} A ${len} ${len} 0 1 ${sweep} ${tipx} ${tipy}`}
        stroke={DOOR_STROKE}
        strokeWidth={0.75}
        strokeOpacity={0.5}
        fill="none"
      />
    </g>
  );
}

/** Shift (px) for a movable door along its wall: `offset` is a fraction of the
 * wall (−0.5…0.5, from the panel's "Door position" control), clamped so the door
 * (length `len`) stays fully on the wall (length `wall`). */
function doorShift(offset: number, len: number, wall: number): number {
  const maxFrac = Math.max(0, 0.5 - len / (2 * wall));
  return clamp(offset, -maxFrac, maxFrac) * wall;
}

/** Hyparhut door: an opening on the RIGHT of the front (+y) edge (right jamb by
 * the 6' corner) that swings OUT — the closed leaf along the edge plus an
 * outward (away from the hut) semicircle clearance, below the front edge.
 * Matches the camp drawing. px,py,w,h are the body's local pixel rect. */
function HyparDoor({
  px,
  py,
  w,
  h,
}: {
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  // Hut is a fixed 8' square, so width fractions are exact feet.
  const doorW = w * (2.5 / 8); // 30" opening
  const right = px + w * (7.5 / 8); // right jamb 6" from the corner
  const left = right - doorW;
  const y = py + h; // front edge
  const r = doorW / 2; // semicircle clearance: chord = opening = diameter
  return (
    <g pointerEvents="none">
      <line x1={left} y1={y} x2={right} y2={y} stroke="#fff" strokeWidth={2} />
      {/* Sweep 0 bulges the arc outward — below the front edge, away from the hut. */}
      <path
        d={`M ${left} ${y} A ${r} ${r} 0 0 0 ${right} ${y}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.5}
        strokeWidth={0.75}
        fill="none"
      />
    </g>
  );
}

/** Container cargo doors: two leaves on the short (+y) end, each half the 8' end,
 * that swing OUT and fold 270° back flat against the side walls. px,py,w,h are
 * the body's local pixel rect (doors on the bottom end). */
function ContainerDoors({
  px,
  py,
  w,
  h,
}: {
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  const L = w / 2; // each leaf spans half the 8' door end
  const yb = py + h; // door end
  return (
    <g pointerEvents="none">
      {/* Open leaves folded back along the side walls. */}
      <line
        x1={px}
        y1={yb}
        x2={px}
        y2={yb - L}
        stroke={DOOR_STROKE}
        strokeOpacity={0.6}
        strokeWidth={1.5}
      />
      <line
        x1={px + w}
        y1={yb}
        x2={px + w}
        y2={yb - L}
        stroke={DOOR_STROKE}
        strokeOpacity={0.6}
        strokeWidth={1.5}
      />
      {/* 270° swing arcs (large-arc): out, around, and back to the side wall. */}
      <path
        d={`M ${px + L} ${yb} A ${L} ${L} 0 1 1 ${px} ${yb - L}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.4}
        strokeWidth={0.75}
        fill="none"
      />
      <path
        d={`M ${px + w - L} ${yb} A ${L} ${L} 0 1 0 ${px + w} ${yb - L}`}
        stroke={DOOR_STROKE}
        strokeOpacity={0.4}
        strokeWidth={0.75}
        fill="none"
      />
    </g>
  );
}

/** Schematic top-down detailing drawn over a vehicle/tent footprint so kinds
 * read at a glance (front = top edge). Local coords — rotates with the object —
 * and never intercepts pointer events so the body underneath stays draggable. */
function KindGlyph({
  kind,
  px,
  py,
  w,
  h,
}: {
  kind: string;
  px: number;
  py: number;
  w: number;
  h: number;
}) {
  const dark = "#1c1c1c";
  const glass = "#cfe0ff";
  const X = (f: number) => px + w * f;
  const Y = (f: number) => py + h * f;
  const line = { stroke: dark, strokeOpacity: 0.55, fill: "none" } as const;
  const pane = { fill: glass, fillOpacity: 0.55, stroke: "none" } as const;

  // Two wheels (flush to each side) at each given length-fraction.
  const wheels = (fracs: number[]) => {
    const ww = Math.max(2, w * 0.12);
    const wl = Math.max(3, h * 0.1);
    return fracs.flatMap((f) =>
      [px, px + w - ww].map((wx) => (
        <rect
          key={`w${f}-${wx}`}
          x={wx}
          y={py + h * f - wl / 2}
          width={ww}
          height={wl}
          rx={Math.min(ww, wl) * 0.35}
          fill={dark}
          fillOpacity={0.6}
        />
      )),
    );
  };

  if (kind === "tent") {
    if (Math.min(w, h) < 8) return null;
    return (
      <g pointerEvents="none" stroke={dark} strokeOpacity={0.4} fill="none">
        <line x1={px} y1={py} x2={px + w} y2={py + h} />
        <line x1={px + w} y1={py} x2={px} y2={py + h} />
        <circle
          cx={px + w / 2}
          cy={py + h / 2}
          r={Math.min(w, h) * 0.08}
          fill={dark}
          fillOpacity={0.3}
          stroke="none"
        />
      </g>
    );
  }

  // Vehicles get cluttered when tiny; skip detailing below a threshold.
  if (w < 10 || h < 16) return null;

  if (kind === "car") {
    return (
      <g pointerEvents="none">
        {wheels([0.16, 0.8])}
        <polygon
          points={`${X(0.38)},${Y(0.16)} ${X(0.62)},${Y(0.16)} ${X(0.72)},${Y(0.3)} ${X(0.28)},${Y(0.3)}`}
          {...pane}
        />
        <rect
          x={X(0.2)}
          y={Y(0.3)}
          width={w * 0.6}
          height={h * 0.42}
          rx={Math.min(w, h) * 0.12}
          {...line}
        />
        <polygon
          points={`${X(0.3)},${Y(0.72)} ${X(0.7)},${Y(0.72)} ${X(0.6)},${Y(0.85)} ${X(0.4)},${Y(0.85)}`}
          {...pane}
          fillOpacity={0.4}
        />
      </g>
    );
  }

  if (kind === "truck") {
    return (
      <g pointerEvents="none">
        {wheels([0.18, 0.82])}
        <rect
          x={X(0.14)}
          y={Y(0.07)}
          width={w * 0.72}
          height={h * 0.27}
          rx={Math.min(w, h) * 0.08}
          {...line}
        />
        <line x1={X(0.2)} y1={Y(0.15)} x2={X(0.8)} y2={Y(0.15)} {...line} />
        <rect
          x={X(0.1)}
          y={Y(0.4)}
          width={w * 0.8}
          height={h * 0.52}
          rx={2}
          {...line}
        />
      </g>
    );
  }

  if (kind === "van") {
    return (
      <g pointerEvents="none">
        {wheels([0.16, 0.84])}
        <polygon
          points={`${X(0.26)},${Y(0.07)} ${X(0.74)},${Y(0.07)} ${X(0.84)},${Y(0.22)} ${X(0.16)},${Y(0.22)}`}
          {...pane}
        />
        <line x1={X(0.08)} y1={Y(0.28)} x2={X(0.92)} y2={Y(0.28)} {...line} />
        <line x1={X(0.62)} y1={Y(0.36)} x2={X(0.62)} y2={Y(0.74)} {...line} />
      </g>
    );
  }

  if (kind === "rv") {
    return (
      <g pointerEvents="none">
        {wheels([0.12, 0.72])}
        <polygon
          points={`${X(0.22)},${Y(0.02)} ${X(0.78)},${Y(0.02)} ${X(0.88)},${Y(0.13)} ${X(0.12)},${Y(0.13)}`}
          {...pane}
          fillOpacity={0.5}
        />
        <line x1={X(0.06)} y1={Y(0.16)} x2={X(0.94)} y2={Y(0.16)} {...line} />
        {[0.28, 0.42, 0.56].map((f) => (
          <rect
            key={f}
            x={X(0.04)}
            y={Y(f)}
            width={w * 0.06}
            height={h * 0.08}
            rx={1}
            {...pane}
            fillOpacity={0.5}
          />
        ))}
      </g>
    );
  }

  // Towed trailers (no cab): tandem axles + a hitch tongue at the front (-y).
  if (kind === "airstream" || kind === "toy-hauler") {
    return (
      <g pointerEvents="none">
        {wheels([0.6, 0.74])}
        <polygon
          points={`${X(0.42)},${py} ${X(0.58)},${py} ${X(0.5)},${py - h * 0.05}`}
          {...line}
          fill={dark}
          fillOpacity={0.3}
        />
        {kind === "airstream" ? (
          // Ribbed rounded shell hint.
          [0.2, 0.34, 0.48, 0.62].map((f) => (
            <line
              key={f}
              x1={X(0.1)}
              y1={Y(f)}
              x2={X(0.9)}
              y2={Y(f)}
              {...line}
            />
          ))
        ) : (
          // Toy hauler: garage line near the rear.
          <line x1={X(0.1)} y1={Y(0.5)} x2={X(0.9)} y2={Y(0.5)} {...line} />
        )}
      </g>
    );
  }

  return null;
}

/** Last-approved geometry an officer can revert a pending change back to. */
type PendingPrev = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

type ObjRow = {
  id: string;
  name: string | null;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  // Above-ground height (ft) for the shade sim; 0 = use the kind default.
  tallFt: number;
  // Draw this object's door on the map (kinds that have one).
  showDoor: boolean;
  // Mirror (left-right reflect) the structure — for chiral kinds.
  mirrored: boolean;
  // Per-object adjustable structure settings (keyed by a CampStructure `controls`
  // entry, e.g. the pyramid's flying-buttress extension). Missing keys fall back
  // to each control's default.
  config: StructureConfig;
  color: string | null;
  notes: string | null;
  // Linked-block id: objects sharing this are moved/rotated together. NULL = not
  // linked.
  groupId: string | null;
  // The camper who brought this (NULL = shared/communal camp item).
  ownerMembershipId: string | null;
  ownerName: string | null;
  // Set when the owner has an unapproved move/resize/rotate (the live geometry
  // is the proposed state; `prev` is what Reject restores). Only the owner can
  // propose, so the proposer is always the owner.
  pending: { prev: PendingPrev } | null;
};

type ZonePt = { x: number; y: number };
type ZoneRow = {
  id: string;
  name: string | null;
  kind: string;
  color: string;
  points: ZonePt[];
  notes: string | null;
};

type CableRow = {
  id: string;
  name: string | null;
  kind: string;
  color: string;
  points: ZonePt[];
  amps: number | null;
  gauge: string | null;
  notes: string | null;
};

/** Cable kinds: a power cable or a water pipe (fresh / grey). Amps/gauge apply
 * only to power; each kind seeds a default color. */
const CABLE_KINDS = [
  { value: "power", label: "Power", color: "#fab005" },
  { value: "water-fresh", label: "Fresh water", color: "#4dabf7" },
  { value: "water-grey", label: "Grey water", color: "#868e96" },
] as const;
function cableKindDef(kind: string): (typeof CABLE_KINDS)[number] {
  return CABLE_KINDS.find((k) => k.value === kind) ?? CABLE_KINDS[0];
}
function cableKindLabel(kind: string): string {
  return cableKindDef(kind).label;
}

type RoadRow = {
  id: string;
  name: string | null;
  kind: string;
  color: string;
  width: number;
  cutback: number;
  points: ZonePt[];
  notes: string | null;
};

/** Parse the stored points JSON into a clean {x,y}[] (bad data → []). */
function parseZonePoints(json: string): ZonePt[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({ x: Number(p?.x), y: Number(p?.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  } catch {
    return [];
  }
}

/** Build the `pending` field from the raw columns. */
function parsePending(
  pendingAt: Date | null,
  prevJson: string | null,
): { prev: PendingPrev } | null {
  if (!pendingAt || !prevJson) return null;
  try {
    const p = JSON.parse(prevJson);
    return {
      prev: {
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        width: Number(p.width) || 0,
        height: Number(p.height) || 0,
        rotation: Number(p.rotation) || 0,
      },
    };
  } catch {
    return null;
  }
}

/** Columns + joins to read a placed object with its owner name. */
const objSelect = {
  id: mapObject.id,
  name: mapObject.name,
  kind: mapObject.kind,
  x: mapObject.x,
  y: mapObject.y,
  width: mapObject.width,
  height: mapObject.height,
  rotation: mapObject.rotation,
  tallFt: mapObject.tallFt,
  showDoor: mapObject.showDoor,
  mirrored: mapObject.mirrored,
  config: mapObject.config,
  color: mapObject.color,
  notes: mapObject.notes,
  groupId: mapObject.groupId,
  ownerMembershipId: mapObject.ownerMembershipId,
  ownerName: user.name,
  pendingAt: mapObject.pendingAt,
  pendingPrev: mapObject.pendingPrev,
} as const;

type ObjSelectRow = {
  id: string;
  name: string | null;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  tallFt: number;
  showDoor: boolean;
  mirrored: boolean;
  config: string | null;
  color: string | null;
  notes: string | null;
  groupId: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  pendingAt: Date | null;
  pendingPrev: string | null;
};

/** Parse the stored config JSON into a clean Record<string, number> (bad → {}). */
function parseConfig(json: string | null): StructureConfig {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function toObjRow(r: ObjSelectRow): ObjRow {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    rotation: r.rotation,
    tallFt: r.tallFt,
    showDoor: r.showDoor,
    mirrored: r.mirrored,
    config: parseConfig(r.config),
    color: r.color,
    notes: r.notes,
    groupId: r.groupId,
    ownerMembershipId: r.ownerMembershipId,
    ownerName: r.ownerName,
    pending: parsePending(r.pendingAt, r.pendingPrev),
  };
}

/** Read one placed object (with owner name) as an ObjRow, scoped to the edition. */
async function loadObjRow(
  editionId: string,
  id: string,
): Promise<ObjRow | null> {
  const [r] = await db
    .select(objSelect)
    .from(mapObject)
    .leftJoin(membership, eq(mapObject.ownerMembershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
    .limit(1);
  return r ? toObjRow(r) : null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const {
    user: account,
    active,
    activeEdition,
  } = await requireActiveEdition(request);
  const editionId = activeEdition.id;

  const [lot] = await db
    .select()
    .from(placement)
    .where(eq(placement.editionId, editionId))
    .limit(1);

  const objectRows = await db
    .select(objSelect)
    .from(mapObject)
    .leftJoin(membership, eq(mapObject.ownerMembershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(and(eq(mapObject.editionId, editionId), eq(mapObject.placed, true)));

  const zoneRows = await db
    .select()
    .from(mapZone)
    .where(eq(mapZone.editionId, editionId));

  const cableRows = await db
    .select()
    .from(mapCable)
    .where(eq(mapCable.editionId, editionId));

  const roadRows = await db
    .select()
    .from(mapRoad)
    .where(eq(mapRoad.editionId, editionId));

  const canManage = hasAtLeast(active.membership.role, "officer");
  // Declared-but-unplaced items (the officer placement queue), with owner names.
  const unplacedRows = canManage
    ? await db
        .select({
          id: mapObject.id,
          kind: mapObject.kind,
          width: mapObject.width,
          height: mapObject.height,
          ownerName: user.name,
        })
        .from(mapObject)
        .leftJoin(membership, eq(mapObject.ownerMembershipId, membership.id))
        .leftJoin(user, eq(membership.userId, user.id))
        .where(
          and(eq(mapObject.editionId, editionId), eq(mapObject.placed, false)),
        )
    : [];

  return {
    canEdit:
      hasAtLeast(active.membership.role, "member") && !activeEdition.locked,
    locked: activeEdition.locked,
    // Free-text "doneness" label shown as a watermark over the map (officer-set).
    mapStatus: activeEdition.mapStatus,
    // The event this edition is for — gates Burning-Man-specific UI.
    event: activeEdition.event,
    // Structure kinds disallowed this edition: hidden from the palette/picker,
    // rejected on add, and flagged on any already-placed object.
    bannedKinds: parseBannedKinds(activeEdition.bannedKinds),
    canManage: canManage && !activeEdition.locked,
    // The viewer's own membership — used to decide which items they may adjust
    // (their own) and to drive the "My items" highlight.
    myMembershipId: active.membership.id,
    unplaced: unplacedRows.map((u) => ({
      id: u.id,
      kind: u.kind,
      width: u.width,
      height: u.height,
      ownerName: u.ownerName,
    })),
    campName: active.camp.name,
    // Placement/submission contact for the map export. Stored on the camp
    // (persists across years); `account` seeds a first-time export from the
    // signed-in officer's name/email.
    contact: {
      name: active.camp.placementContactName ?? "",
      playa: active.camp.placementContactPlaya ?? "",
      email: active.camp.placementContactEmail ?? "",
      phone: active.camp.placementContactPhone ?? "",
    },
    account: { name: account.name ?? "", email: account.email ?? "" },
    lot: lot
      ? {
          streetLetter: lot.streetLetter,
          year: lot.year,
          frontsToMan: lot.frontsToMan,
          street: lot.street,
          address: lot.address,
          frontageFt: lot.frontageFt,
          depthFt: lot.depthFt,
          innerRadiusFt: lot.innerRadiusFt,
          notes: lot.notes,
        }
      : null,
    objects: objectRows.map(toObjRow) satisfies ObjRow[],
    zones: zoneRows.map((z) => ({
      id: z.id,
      name: z.name,
      kind: z.kind,
      color: z.color,
      points: parseZonePoints(z.points),
      notes: z.notes,
    })) satisfies ZoneRow[],
    cables: cableRows.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      color: c.color,
      points: parseZonePoints(c.points),
      amps: c.amps,
      gauge: c.gauge,
      notes: c.notes,
    })) satisfies CableRow[],
    roads: roadRows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      color: r.color,
      width: r.width,
      cutback: r.cutback,
      points: parseZonePoints(r.points),
      notes: r.notes,
    })) satisfies RoadRow[],
  };
}

export async function action({ request }: Route.ActionArgs) {
  const { user, active, activeEdition } = await requireActiveEdition(request);
  const campId = active.camp.id;
  const editionId = activeEdition.id;
  if (!hasAtLeast(active.membership.role, "member")) {
    return data(
      { error: "You don't have permission to edit the map." },
      {
        status: 403,
      },
    );
  }
  if (activeEdition.locked) {
    return data(
      { error: "This year is locked. Unlock it to make changes." },
      { status: 403 },
    );
  }

  const canManage = hasAtLeast(active.membership.role, "officer");
  const myMembershipId = active.membership.id;
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
  const GEOM = ["x", "y", "width", "height", "rotation"] as const;

  // Adding/placing/removing objects and lot setup are officer-only; members may
  // only adjust their own already-placed items (handled in updateObject).
  const officerOnly = new Set([
    "savePlacement",
    "setMapStatus",
    "setPlacementContact",
    "addObject",
    "addBlock",
    "updateObjects",
    "unplaceObjects",
    "linkObjects",
    "unlinkObjects",
    "duplicateObject",
    "placeObject",
    "unplaceObject",
    "deleteObject",
    "approveChange",
    "rejectChange",
    "addZone",
    "updateZone",
    "deleteZone",
    "addCable",
    "updateCable",
    "deleteCable",
    "addRoad",
    "updateRoad",
    "deleteRoad",
  ]);
  if (officerOnly.has(intent) && !canManage) {
    return data({ error: "Officers manage the map." }, { status: 403 });
  }

  if (intent === "savePlacement") {
    const values = {
      streetLetter: str("streetLetter"),
      year: form.get("year") ? Math.round(num("year")) : null,
      frontsToMan: form.get("frontsToMan") === "on",
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
      .where(eq(placement.editionId, editionId))
      .limit(1);
    if (existing) {
      await db
        .update(placement)
        .set(values)
        .where(eq(placement.id, existing.id));
    } else {
      await db
        .insert(placement)
        .values({ id: crypto.randomUUID(), campId, editionId, ...values });
    }
    return data({ ok: true });
  }

  if (intent === "setMapStatus") {
    // Free-text doneness label ("DRAFT"/"FINAL v2"/…). Trim; empty clears it.
    const raw = String(form.get("mapStatus") ?? "").trim();
    await db
      .update(campEdition)
      .set({ mapStatus: raw === "" ? null : raw.slice(0, 60) })
      .where(eq(campEdition.id, editionId));
    return data({ ok: true });
  }

  if (intent === "setPlacementContact") {
    // Camp-scoped submission contact for the map export (persists across years).
    const clean = (k: string) => {
      const v = String(form.get(k) ?? "").trim();
      return v === "" ? null : v.slice(0, 120);
    };
    await db
      .update(camp)
      .set({
        placementContactName: clean("name"),
        placementContactPlaya: clean("playa"),
        placementContactEmail: clean("email"),
        placementContactPhone: clean("phone"),
      })
      .where(eq(camp.id, campId));
    return data({ ok: true });
  }

  if (intent === "addObject") {
    const kind = String(form.get("kind") ?? "structure");
    if (isKindBanned(activeEdition.bannedKinds, kind)) {
      return data(
        { error: `${kindDef(kind).label} isn't allowed this year.` },
        { status: 403 },
      );
    }
    const def = kindDef(kind);
    const row = {
      id: crypto.randomUUID(),
      campId,
      editionId,
      name: str("name"),
      kind,
      // Dropping from the legend = an officer placing a camp/shared item.
      placed: true,
      x: num("x", 0),
      y: num("y", 0),
      width: Math.max(1, num("width", def.w)),
      height: Math.max(1, num("height", def.h)),
      rotation: num("rotation", 0),
      tallFt: num("tallFt", kindHeight(kind)),
      showDoor: true,
      mirrored: false,
      color: str("color"),
      notes: str("notes"),
      createdById: user.id,
    };
    await db.insert(mapObject).values(row);
    return data({
      object: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        rotation: row.rotation,
        tallFt: row.tallFt,
        showDoor: row.showDoor,
        mirrored: row.mirrored,
        config: {},
        color: row.color,
        notes: row.notes,
        groupId: null,
        ownerMembershipId: null,
        ownerName: null,
        pending: null,
      } satisfies ObjRow,
    });
  }

  if (intent === "addBlock") {
    // Drop a premade cluster: the client sends pre-positioned items (absolute
    // plot-local feet); we persist them all as camp/shared objects and return
    // the rows so the client can append them.
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("items") ?? "[]"));
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      return data({ error: "Empty block." }, { status: 400 });
    }
    const rows = raw
      .slice(0, 20)
      .map((it) => {
        const kind = String((it as { kind?: unknown }).kind ?? "");
        if (!isKind(kind)) return null;
        if (isKindBanned(activeEdition.bannedKinds, kind)) return null;
        const def = kindDef(kind);
        const n = (v: unknown, d: number) => {
          const x = Number(v);
          return Number.isFinite(x) ? x : d;
        };
        const nm = (it as { name?: unknown }).name;
        return {
          id: crypto.randomUUID(),
          campId,
          editionId,
          name: nm ? String(nm) : null,
          kind,
          placed: true,
          x: n((it as { x?: unknown }).x, 0),
          y: n((it as { y?: unknown }).y, 0),
          width: Math.max(1, n((it as { width?: unknown }).width, def.w)),
          height: Math.max(1, n((it as { height?: unknown }).height, def.h)),
          rotation: n((it as { rotation?: unknown }).rotation, 0),
          tallFt: kindHeight(kind),
          showDoor: true,
          mirrored: false,
          color: null,
          notes: null,
          createdById: user.id,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) {
      return data({ error: "No valid items." }, { status: 400 });
    }
    await db.insert(mapObject).values(rows);
    return data({
      objects: rows.map(
        (row) =>
          ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
            rotation: row.rotation,
            tallFt: row.tallFt,
            showDoor: row.showDoor,
            mirrored: row.mirrored,
            config: {},
            color: row.color,
            notes: row.notes,
            groupId: null,
            ownerMembershipId: null,
            ownerName: null,
            pending: null,
          }) satisfies ObjRow,
      ),
    });
  }

  if (intent === "updateObjects") {
    // Batch geometry update for a multi-select group move/rotate (officer-only —
    // gated by the officerOnly set). One request so the single fetcher doesn't
    // cancel rapid per-object submits.
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("items") ?? "[]"));
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) {
      return data({ error: "Bad payload." }, { status: 400 });
    }
    for (const it of raw.slice(0, 300)) {
      const o = it as Record<string, unknown>;
      const id = String(o.id ?? "");
      if (!id) continue;
      await db
        .update(mapObject)
        .set({
          x: Number(o.x) || 0,
          y: Number(o.y) || 0,
          width: Math.max(1, Number(o.width) || 1),
          height: Math.max(1, Number(o.height) || 1),
          rotation: Number(o.rotation) || 0,
          updatedAt: new Date(),
        })
        .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    }
    return data({ ok: true });
  }

  if (intent === "linkObjects" || intent === "unlinkObjects") {
    // Link a multi-selection into one block (shared group_id, client-supplied so
    // its optimistic update matches) or unlink (clear it). Officer-only, batched.
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("ids") ?? "[]"));
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) {
      return data({ error: "Bad payload." }, { status: 400 });
    }
    const groupId =
      intent === "linkObjects"
        ? String(form.get("groupId") ?? "") || null
        : null;
    for (const v of raw.slice(0, 300)) {
      const id = String(v ?? "");
      if (!id) continue;
      await db
        .update(mapObject)
        .set({ groupId, updatedAt: new Date() })
        .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    }
    return data({ ok: true });
  }

  if (intent === "unplaceObjects") {
    // Batch unplace (send a multi-select group back to the tray) in one request.
    let raw: unknown;
    try {
      raw = JSON.parse(String(form.get("ids") ?? "[]"));
    } catch {
      raw = [];
    }
    if (!Array.isArray(raw)) {
      return data({ error: "Bad payload." }, { status: 400 });
    }
    for (const v of raw.slice(0, 300)) {
      const id = String(v ?? "");
      if (!id) continue;
      await db
        .update(mapObject)
        .set({ placed: false, updatedAt: new Date() })
        .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    }
    return data({ ok: true });
  }

  if (intent === "updateObject") {
    const id = String(form.get("id"));
    const [obj] = await db
      .select({
        ownerMembershipId: mapObject.ownerMembershipId,
        x: mapObject.x,
        y: mapObject.y,
        width: mapObject.width,
        height: mapObject.height,
        rotation: mapObject.rotation,
        pendingAt: mapObject.pendingAt,
      })
      .from(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
      .limit(1);
    if (!obj) return data({ error: "Object not found." }, { status: 404 });

    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of GEOM) {
      if (form.get(key) != null) set[key] = num(key);
    }
    if (form.has("tallFt")) set.tallFt = Math.max(0, num("tallFt"));

    if (canManage) {
      // Officers edit anything directly; an officer edit accepts (clears) any
      // pending proposal on the item.
      if (form.has("name")) set.name = str("name");
      if (form.has("kind")) set.kind = String(form.get("kind"));
      if (form.has("color")) set.color = str("color");
      if (form.has("notes")) set.notes = str("notes");
      if (form.has("showDoor")) set.showDoor = form.get("showDoor") === "true";
      if (form.has("mirrored")) set.mirrored = form.get("mirrored") === "true";
      if (form.has("config")) {
        // Re-serialize through parseConfig so only finite-number values persist.
        set.config = JSON.stringify(parseConfig(str("config")));
      }
      set.pendingByMembershipId = null;
      set.pendingAt = null;
      set.pendingPrev = null;
    } else {
      // Members may only move/resize/rotate their OWN item; the change applies
      // live but is flagged pending until an officer approves. Non-geometry
      // fields are ignored for members.
      if (obj.ownerMembershipId !== myMembershipId) {
        return data(
          { error: "You can only adjust your own items." },
          {
            status: 403,
          },
        );
      }
      if (!obj.pendingAt) {
        set.pendingByMembershipId = myMembershipId;
        set.pendingAt = new Date();
        set.pendingPrev = JSON.stringify({
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
          rotation: obj.rotation,
        });
      } else {
        set.pendingAt = new Date();
      }
    }
    await db.update(mapObject).set(set).where(eq(mapObject.id, id));
    const object = await loadObjRow(editionId, id);
    return data({ object });
  }

  if (intent === "approveChange") {
    const id = String(form.get("id"));
    await db
      .update(mapObject)
      .set({
        pendingByMembershipId: null,
        pendingAt: null,
        pendingPrev: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    const object = await loadObjRow(editionId, id);
    if (!object) return data({ error: "Item not found." }, { status: 404 });
    return data({ object });
  }

  if (intent === "rejectChange") {
    const id = String(form.get("id"));
    const [obj] = await db
      .select({ pendingPrev: mapObject.pendingPrev })
      .from(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
      .limit(1);
    if (!obj) return data({ error: "Item not found." }, { status: 404 });
    const prev = parsePending(new Date(), obj.pendingPrev)?.prev;
    await db
      .update(mapObject)
      .set({
        ...(prev ?? {}),
        pendingByMembershipId: null,
        pendingAt: null,
        pendingPrev: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    const object = await loadObjRow(editionId, id);
    return data({ object });
  }

  if (intent === "placeObject") {
    const id = String(form.get("id"));
    const [row] = await db
      .update(mapObject)
      .set({ placed: true, x: num("x"), y: num("y"), updatedAt: new Date() })
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
      .returning();
    if (!row) return data({ error: "Item not found." }, { status: 404 });
    const object = await loadObjRow(editionId, id);
    return data({ object });
  }

  if (intent === "unplaceObject") {
    // "Remove from map" doesn't destroy the item — it returns to the Unplaced
    // tray (placed = false), keeping its name/size/config so it can be dropped
    // back later. Any pending member change is cleared.
    const id = String(form.get("id"));
    const [row] = await db
      .update(mapObject)
      .set({
        placed: false,
        pendingByMembershipId: null,
        pendingAt: null,
        pendingPrev: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
      .returning();
    if (!row) return data({ error: "Item not found." }, { status: 404 });
    return data({ unplacedId: id });
  }

  if (intent === "duplicateObject") {
    // Copy a placed object (keeping size/rotation/mirror/config) as a new camp
    // item, offset slightly so it's visible; returns it like a fresh add.
    const id = String(form.get("id"));
    const [src] = await db
      .select()
      .from(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)))
      .limit(1);
    if (!src) return data({ error: "Item not found." }, { status: 404 });
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      pendingByMembershipId: _pb,
      pendingAt: _pa,
      pendingPrev: _pp,
      ...rest
    } = src;
    const newId = crypto.randomUUID();
    await db.insert(mapObject).values({
      ...rest,
      id: newId,
      placed: true,
      // A duplicate is an officer-placed camp/shared item.
      ownerMembershipId: null,
      x: src.x + 10,
      y: src.y + 10,
      createdById: user.id,
    });
    const object = await loadObjRow(editionId, newId);
    return data({ object });
  }

  if (intent === "deleteObject") {
    const id = String(form.get("id"));
    await db
      .delete(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    return data({ deletedId: id });
  }

  if (intent === "addZone") {
    const id = crypto.randomUUID();
    const row = {
      id,
      campId,
      editionId,
      name: str("name"),
      kind: String(form.get("kind") ?? "custom"),
      color: String(form.get("color") ?? "#fa5252"),
      points: String(form.get("points") ?? "[]"),
      notes: str("notes"),
      createdById: user.id,
    };
    await db.insert(mapZone).values(row);
    return data({
      zone: {
        id,
        name: row.name,
        kind: row.kind,
        color: row.color,
        points: parseZonePoints(row.points),
        notes: row.notes,
      } satisfies ZoneRow,
    });
  }

  if (intent === "updateZone") {
    const id = String(form.get("id"));
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("name")) set.name = str("name");
    if (form.has("kind")) set.kind = String(form.get("kind"));
    if (form.has("color")) set.color = String(form.get("color"));
    if (form.has("points")) set.points = String(form.get("points"));
    if (form.has("notes")) set.notes = str("notes");
    await db
      .update(mapZone)
      .set(set)
      .where(and(eq(mapZone.id, id), eq(mapZone.editionId, editionId)));
    const [z] = await db
      .select()
      .from(mapZone)
      .where(and(eq(mapZone.id, id), eq(mapZone.editionId, editionId)))
      .limit(1);
    if (!z) return data({ error: "Zone not found." }, { status: 404 });
    return data({
      zone: {
        id: z.id,
        name: z.name,
        kind: z.kind,
        color: z.color,
        points: parseZonePoints(z.points),
        notes: z.notes,
      } satisfies ZoneRow,
    });
  }

  if (intent === "deleteZone") {
    const id = String(form.get("id"));
    await db
      .delete(mapZone)
      .where(and(eq(mapZone.id, id), eq(mapZone.editionId, editionId)));
    return data({ deletedZoneId: id });
  }

  if (intent === "addCable") {
    const id = crypto.randomUUID();
    const kind = String(form.get("kind") ?? "power");
    const row = {
      id,
      campId,
      editionId,
      name: str("name"),
      kind,
      color: String(form.get("color") ?? cableKindDef(kind).color),
      points: String(form.get("points") ?? "[]"),
      amps: form.get("amps") ? num("amps") : null,
      gauge: str("gauge"),
      notes: str("notes"),
      createdById: user.id,
    };
    await db.insert(mapCable).values(row);
    return data({
      cable: {
        id,
        name: row.name,
        kind: row.kind,
        color: row.color,
        points: parseZonePoints(row.points),
        amps: row.amps,
        gauge: row.gauge,
        notes: row.notes,
      } satisfies CableRow,
    });
  }

  if (intent === "updateCable") {
    const id = String(form.get("id"));
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("name")) set.name = str("name");
    if (form.has("kind")) set.kind = String(form.get("kind"));
    if (form.has("color")) set.color = String(form.get("color"));
    if (form.has("points")) set.points = String(form.get("points"));
    if (form.has("amps")) set.amps = form.get("amps") ? num("amps") : null;
    if (form.has("gauge")) set.gauge = str("gauge");
    if (form.has("notes")) set.notes = str("notes");
    await db
      .update(mapCable)
      .set(set)
      .where(and(eq(mapCable.id, id), eq(mapCable.editionId, editionId)));
    const [c] = await db
      .select()
      .from(mapCable)
      .where(and(eq(mapCable.id, id), eq(mapCable.editionId, editionId)))
      .limit(1);
    if (!c) return data({ error: "Cable not found." }, { status: 404 });
    return data({
      cable: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        color: c.color,
        points: parseZonePoints(c.points),
        amps: c.amps,
        gauge: c.gauge,
        notes: c.notes,
      } satisfies CableRow,
    });
  }

  if (intent === "deleteCable") {
    const id = String(form.get("id"));
    await db
      .delete(mapCable)
      .where(and(eq(mapCable.id, id), eq(mapCable.editionId, editionId)));
    return data({ deletedCableId: id });
  }

  if (intent === "addRoad") {
    const id = crypto.randomUUID();
    const kind = String(form.get("kind") ?? "fire-lane");
    const def = roadKindDef(kind);
    const row = {
      id,
      campId,
      editionId,
      name: str("name"),
      kind,
      color: String(form.get("color") ?? def.color),
      width: form.get("width")
        ? Math.max(2, num("width", def.width))
        : def.width,
      cutback: form.get("cutback")
        ? Math.max(0, num("cutback"))
        : DEFAULT_ROAD_CUTBACK,
      points: String(form.get("points") ?? "[]"),
      notes: str("notes"),
      createdById: user.id,
    };
    await db.insert(mapRoad).values(row);
    return data({
      road: {
        id,
        name: row.name,
        kind: row.kind,
        color: row.color,
        width: row.width,
        cutback: row.cutback,
        points: parseZonePoints(row.points),
        notes: row.notes,
      } satisfies RoadRow,
    });
  }

  if (intent === "updateRoad") {
    const id = String(form.get("id"));
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (form.has("name")) set.name = str("name");
    if (form.has("kind")) set.kind = String(form.get("kind"));
    if (form.has("color")) set.color = String(form.get("color"));
    if (form.has("width")) set.width = Math.max(2, num("width", 20));
    if (form.has("cutback")) set.cutback = Math.max(0, num("cutback"));
    if (form.has("points")) set.points = String(form.get("points"));
    if (form.has("notes")) set.notes = str("notes");
    await db
      .update(mapRoad)
      .set(set)
      .where(and(eq(mapRoad.id, id), eq(mapRoad.editionId, editionId)));
    const [r] = await db
      .select()
      .from(mapRoad)
      .where(and(eq(mapRoad.id, id), eq(mapRoad.editionId, editionId)))
      .limit(1);
    if (!r) return data({ error: "Road not found." }, { status: 404 });
    return data({
      road: {
        id: r.id,
        name: r.name,
        kind: r.kind,
        color: r.color,
        width: r.width,
        cutback: r.cutback,
        points: parseZonePoints(r.points),
        notes: r.notes,
      } satisfies RoadRow,
    });
  }

  if (intent === "deleteRoad") {
    const id = String(form.get("id"));
    await db
      .delete(mapRoad)
      .where(and(eq(mapRoad.id, id), eq(mapRoad.editionId, editionId)));
    return data({ deletedRoadId: id });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ---- Geometry helpers -------------------------------------------------------

const VIEW_W = 920;
const MARGIN = 28;
// Annotation margin (feet) drawn around the lot so officers can mark things
// outside the border — and room for the surroundings swaths (the ~45ft street
// in front, the ~20ft rear service road, and neighbor lots on each side).
// Objects stay inside the lot; zones and power lines may extend into this area.
const PAD_FT = 50;
// Surroundings swath widths (feet): BRC annular streets run ~40–50ft, the shared
// rear service alley ~20ft.
const STREET_W_FT = 45;
const SERVICE_ROAD_W_FT = 20;
// BRC fire-hose reach: a lane may dead-end as long as hose reaches 125′ to every
// camp border (see the plan's fire-lane note).
const FIRE_REACH_FT = 125;
const SURROUND_GAP_FT = 3;
// Map zoom range (1 = fit the whole lot to the frame).
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

// The map's large ground/pavement/neighbor fills are scheme-dependent. If we
// switched them off a JS boolean (`useComputedColorScheme`) they'd render in the
// light values on the very first paint — Mantine only resolves the real scheme in
// an effect, after the server HTML (light) is already on screen — a visible white
// flash on a dark device. Instead we expose them as CSS variables keyed off the
// `data-mantine-color-scheme` attribute, which ColorSchemeScript sets
// synchronously before first paint (same technique as root.tsx's earlyColorScheme
// CSS). The media query is the no-JS / pre-script baseline; the attribute rules
// let Mantine's explicit choice override the system preference. The palette shades
// (`--mantine-color-dark-*`, `-gray-*`) are scheme-independent and defined by
// Mantine's stylesheet (render-blocking in <head>), so they resolve on first paint
// too. Keep these values in sync with the *Fill definitions below.
const MAP_GROUND = "var(--ct-map-ground)";
const MAP_PAVEMENT = "var(--ct-map-pavement)";
const MAP_NEIGHBOR = "var(--ct-map-neighbor)";
const mapSchemeVars = (dark: boolean) => ({
  "--ct-map-ground": dark
    ? "var(--mantine-color-dark-4)"
    : "var(--mantine-color-default)",
  "--ct-map-pavement": dark
    ? "var(--mantine-color-dark-5)"
    : "var(--mantine-color-gray-3)",
  "--ct-map-neighbor": dark
    ? "var(--mantine-color-dark-6)"
    : "var(--mantine-color-gray-1)",
});
const MAP_SCHEME_CSS = `
:root {
${Object.entries(mapSchemeVars(false))
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
}
@media (prefers-color-scheme: dark) {
  :root {
${Object.entries(mapSchemeVars(true))
  .map(([k, v]) => `    ${k}: ${v};`)
  .join("\n")}
  }
}
html[data-mantine-color-scheme="light"] {
${Object.entries(mapSchemeVars(false))
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
}
html[data-mantine-color-scheme="dark"] {
${Object.entries(mapSchemeVars(true))
  .map(([k, v]) => `  ${k}: ${v};`)
  .join("\n")}
}
`;

function rotateVec(vx: number, vy: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: vx * cos - vy * sin, y: vx * sin + vy * cos };
}

/** Total run length (feet) of an open polyline — Σ of segment lengths. Plot-local
 * coords are already feet, so the sum is feet directly. */
function pathLengthFt(pts: ZonePt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** Snap-grid steps (feet) for zone/cable vertices — cycled with the `g` key and
 * shown in the snap SegmentedControl. */
const SNAP_STEPS = [1, 10] as const;

/** A hyparhut's roof-AC connection point in feet-space: on the back (-y) edge at
 * ~0.69 of the width (by the high corner), rotated with the object. */
function hyparAcPointFeet(o: ObjRow): { x: number; y: number } {
  const v = rotateVec((0.69 - 0.5) * o.width, -0.5 * o.height, o.rotation);
  return { x: o.x + o.width / 2 + v.x, y: o.y + o.height / 2 + v.y };
}

/** Snap a feet-space point to the nearest power connection node within
 * `threshold` ft — a spider box / generator center, or a hyparhut's roof-AC — so
 * cable runs visibly connect them. `snapped` is true when one was found. */
function snapToNode(
  fxp: number,
  fyp: number,
  objects: ObjRow[],
  threshold = 8,
): { x: number; y: number; snapped: boolean } {
  let best: { x: number; y: number } | null = null;
  let bestD = threshold;
  for (const o of objects) {
    let nx: number;
    let ny: number;
    if (o.kind === "spiderbox" || o.kind === "power") {
      nx = o.x + o.width / 2;
      ny = o.y + o.height / 2;
    } else if (o.kind === "hyparhut") {
      const p = hyparAcPointFeet(o);
      nx = p.x;
      ny = p.y;
    } else {
      continue;
    }
    const d = Math.hypot(nx - fxp, ny - fyp);
    if (d <= bestD) {
      bestD = d;
      best = { x: nx, y: ny };
    }
  }
  if (best) return { x: best.x, y: best.y, snapped: true };
  return { x: fxp, y: fyp, snapped: false };
}

/** Is the feet-space point (fxp,fyp) inside the object's rotated footprint? */
function containsPoint(o: ObjRow, fxp: number, fyp: number) {
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const local = rotateVec(fxp - cx, fyp - cy, -o.rotation);
  return Math.abs(local.x) <= o.width / 2 && Math.abs(local.y) <= o.height / 2;
}

// Black Rock City orientation, anchored to ground truth: the open playa/Temple
// (12:00) is NE and the gate (6:00) is SW, so Man→12:00 ≈ 45°. The map's "up"
// (toward the Man) for a clock address H is (225 + 30·H) mod 360 — 3:00 → 315°
// (NW), 4:30 → 0° (N), 6:00 → 45° (NE), 12:00 → 225° (SW). See `mapUpBearingFor`.
// Sun azimuths come from the real solar model in `~/lib/sun` (see Compass).

type Lot = NonNullable<Route.ComponentProps["loaderData"]["lot"]>;

/** Convert a compass bearing + distance (ft) into a plot-local feet delta. The
 * plot's "up" (−y) points toward the Man = `mapUpBearing`, so a bearing B sits at
 * dial angle (B − mapUpBearing): dx = sinθ, dy = −cosθ. Used to cast shadows. */
function bearingToPlotDelta(
  bearingDeg: number,
  distFt: number,
  mapUpBearing: number,
): { dx: number; dy: number } {
  const theta = ((bearingDeg - mapUpBearing) * Math.PI) / 180;
  return { dx: Math.sin(theta) * distFt, dy: -Math.cos(theta) * distFt };
}

/** Convex hull (Andrew's monotone chain) of feet-space points → ordered polygon. */
function convexHull(pts: ZonePt[]): ZonePt[] {
  if (pts.length < 3) return pts;
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: ZonePt, a: ZonePt, b: ZonePt) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (src: ZonePt[]): ZonePt[] => {
    const h: ZonePt[] = [];
    for (const q of src) {
      while (h.length >= 2) {
        const a = h[h.length - 2];
        const b = h[h.length - 1];
        if (a && b && cross(a, b, q) <= 0) h.pop();
        else break;
      }
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(p).concat(half([...p].reverse()));
}

/** The footprint outline (object-local feet, centered on the object) for a KIND
 * at a given size — the real shape, so a hexayurt throws a hexagonal shadow (and
 * a triangle is tested as a triangle), not a box. */
function footprintOutline(
  kind: string,
  w: number,
  h: number,
  config: StructureConfig = {},
  mirror = false,
): Array<[number, number]> {
  const def = kindDef(kind);
  // A camp-theme structure can declare its true outline (e.g. the pyramid's
  // base triangle + buttress reach); use it instead of the bounding box. A
  // chiral structure's outline is reflected (x→−x) when the object is mirrored,
  // so the asymmetric part (the flying buttress) is bounded on the correct side.
  if (def.footprint) {
    return def
      .footprint(w, h, config)
      .map((p) => [mirror ? -p.x : p.x, p.y] as [number, number]);
  }
  if (def.shape === "hexagon") {
    return hexVertices(0, 0, w, h).map(
      (p) => [p.x - w / 2, p.y - h / 2] as [number, number],
    );
  }
  if (def.shape === "dome") {
    // Circle (ellipse if non-uniform) approximated as a 16-gon, so the dome
    // casts a round/elongated shadow rather than a box.
    const rx = w / 2;
    const ry = h / 2;
    const n = 16;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      return [Math.cos(a) * rx, Math.sin(a) * ry] as [number, number];
    });
  }
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/** The footprint outline for a placed object (centered local feet). */
function footprintLocal(o: ObjRow): Array<[number, number]> {
  return footprintOutline(o.kind, o.width, o.height, o.config, o.mirrored);
}

/** An object's footprint corners in WORLD plot-local feet, at a given center —
 * its real outline (rect / hexagon / custom), rotated + mirrored. */
function objWorldCorners(o: ObjRow, cx: number, cy: number): ZonePt[] {
  return footprintLocal(o).map(([lx, ly]) => {
    const v = rotateVec(lx, ly, o.rotation);
    return { x: cx + v.x, y: cy + v.y };
  });
}

/** Nearest point on segment a→b to p (feet). */
function nearestOnSeg(p: ZonePt, a: ZonePt, b: ZonePt): ZonePt {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2),
  );
  return { x: a.x + abx * t, y: a.y + aby * t };
}

/**
 * Snap a (shade) object's footprint to nearby structures: find the smallest shift
 * that lands one of its corners on another object's vertex or edge within
 * `threshold` feet, and return the shifted object plus the snap target (for a
 * visual hint), or the object unchanged when nothing is close. Corner→vertex and
 * corner→edge candidates are considered; the closest wins.
 */
function snapToStructures(
  o: ObjRow,
  others: ObjRow[],
  threshold: number,
): { obj: ObjRow; hint: ZonePt | null } {
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const corners = objWorldCorners(o, cx, cy);
  let best: { dx: number; dy: number; dist: number; target: ZonePt } | null =
    null;
  for (const other of others) {
    if (other.id === o.id) continue;
    const oc = objWorldCorners(
      other,
      other.x + other.width / 2,
      other.y + other.height / 2,
    );
    if (oc.length === 0) continue;
    for (const c of corners) {
      for (let i = 0; i < oc.length; i++) {
        const v = oc[i] as ZonePt;
        // Corner → vertex.
        const vdx = v.x - c.x;
        const vdy = v.y - c.y;
        const vd = Math.hypot(vdx, vdy);
        if (vd <= threshold && (!best || vd < best.dist)) {
          best = { dx: vdx, dy: vdy, dist: vd, target: v };
        }
        // Corner → edge (v → next).
        const b = oc[(i + 1) % oc.length] as ZonePt;
        const np = nearestOnSeg(c, v, b);
        const edx = np.x - c.x;
        const edy = np.y - c.y;
        const ed = Math.hypot(edx, edy);
        if (ed <= threshold && (!best || ed < best.dist)) {
          best = { dx: edx, dy: edy, dist: ed, target: np };
        }
      }
    }
  }
  if (!best) return { obj: o, hint: null };
  return {
    obj: { ...o, x: o.x + best.dx, y: o.y + best.dy },
    hint: best.target,
  };
}

/** Above-ground height (ft) at each footprint corner, aligned with
 * footprintLocal, so a sloped roof casts a warped shadow. The hyparhut's roof is
 * a hyperbolic paraboloid measured per corner; every other kind is a flat height. */
function cornerHeights(o: ObjRow): number[] {
  const tall = o.tallFt; // authoritative; 0 disables shade for this object
  if (kindDef(o.kind).shape === "hypar") {
    // footprintLocal order = [back-left, back-right, front-right, front-left];
    // the door is on the front (+y) edge by the front-right corner. Measured
    // corner heights 4' / 5' / 6' / 4' (front-right = 6' peak next to the door),
    // scaled so the 6' peak tracks `tall`.
    return [4, 5, 6, 4].map((h) => (h / 6) * tall);
  }
  return footprintLocal(o).map(() => tall);
}

/** A geodesic dome is a hemisphere, not a box/cylinder — so its shadow is an
 * ELLIPSE: the diameter is preserved across the sun, and the silhouette stretches
 * along the sun as it drops (the apex shadow reaches height/tan(altitude)). At a
 * high sun this collapses toward the round footprint; at a low sun it's a long
 * ellipse. Far truer than translating the whole footprint circle (a capsule). */
function domeShadow(
  o: ObjRow,
  sun: { altitude: number; azimuth: number },
  mapUpBearing: number,
): ZonePt[] | null {
  const r = o.width / 2; // domes are round, so width === height
  if (r <= 0) return null;
  // A geodesic dome is ~a hemisphere, so the apex height = the radius (it scales
  // with the dome's size, unlike the fixed tallFt — which made wide domes' apex
  // shadow land inside the footprint and vanish).
  const apexH = r;
  const altDeg = Math.max(sun.altitude, 3); // clamp so a low sun ≠ infinite shadow
  const reach = Math.min(apexH / Math.tan((altDeg * Math.PI) / 180), 300);
  const dir = bearingToPlotDelta(sun.azimuth + 180, 1, mapUpBearing); // away from sun
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  // Hull of the dome's circular footprint + the apex shadow tip: the silhouette is
  // full-width (2r) AT the dome — its midline lines up with the circle — and
  // tapers to the tip, instead of a symmetric ellipse whose widest point sat at
  // the midpoint (which is the misalignment you saw at a low sun).
  const n = 24;
  const circle: ZonePt[] = Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r };
  });
  const tip: ZonePt = { x: cx + dir.dx * reach, y: cy + dir.dy * reach };
  return convexHull([...circle, tip]);
}

/** Cast shadow for a structure that declares a 3D silhouette (a camp-theme
 * `shadowVolume`): project each vertex away from the sun by
 * (zFraction · tallFt)/tan(altitude) and take the convex hull. Lets a non-box
 * solid throw its true shadow — e.g. a tetrahedron's three ground corners plus
 * its apex (over the centroid, at full height) → a real triangular-with-apex
 * shadow, not an extruded bounding box. */
function volumeShadow(
  o: ObjRow,
  parts: ReadonlyArray<readonly { x: number; y: number; z: number }[]>,
  sun: { altitude: number; azimuth: number },
  mapUpBearing: number,
): ZonePt[][] {
  if (o.tallFt <= 0) return [];
  const altDeg = Math.max(sun.altitude, 3); // clamp so low sun ≠ infinite shadow
  const tan = Math.tan((altDeg * Math.PI) / 180);
  const dir = bearingToPlotDelta(sun.azimuth + 180, 1, mapUpBearing);
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  // Each part hulls + casts SEPARATELY (e.g. the tetra vs. the flying canopy), so
  // detached pieces aren't merged into one blob.
  return parts
    .map((part) =>
      convexHull(
        part.map((p) => {
          // Mirror reflects about the object's vertical axis (x→−x) before rotate.
          const v = rotateVec(o.mirrored ? -p.x : p.x, p.y, o.rotation);
          const len = Math.min((p.z * o.tallFt) / tan, 300);
          return { x: cx + v.x + dir.dx * len, y: cy + v.y + dir.dy * len };
        }),
      ),
    )
    .filter((poly) => poly.length >= 3);
}

/** Unit direction TOWARD the sun in an object's own footprint frame (x along +w,
 * y along +h/into the lot, `up` = out of the ground), or null at/below the
 * horizon. Un-rotates the sun's plot-local azimuth by the object's rotation so a
 * structure's faces are lit/shaded in their own frame. */
function sunDirLocal(
  o: ObjRow,
  sun: { altitude: number; azimuth: number },
  mapUpBearing: number,
): { x: number; y: number; up: number } | null {
  if (sun.altitude <= 0.5) return null;
  const altRad = (sun.altitude * Math.PI) / 180;
  const toward = bearingToPlotDelta(sun.azimuth, 1, mapUpBearing); // toward the sun
  const loc = rotateVec(toward.dx, toward.dy, -o.rotation); // into footprint-local
  const cos = Math.cos(altRad);
  return { x: loc.x * cos, y: loc.y * cos, up: Math.sin(altRad) };
}

// Minimal 3D helpers for core face-lighting (footprint x,y + up = z).
type Vec3 = [number, number, number];
const v3sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const v3dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Self-shading for a CORE kind whose roof is a set of facets meeting at a center
 * apex (currently the hexayurt's hexagonal-pyramid roof). Returns each facet as a
 * footprint wedge (edge → center) with a continuous Lambert `shade` — the same
 * treatment the Sierpinski pyramid gets via its `shadedFaces` hook. Empty for
 * kinds without facets. `tall` is the apex height (ft) above the footprint. */
function coreShadedFaces(
  kind: string,
  w: number,
  h: number,
  sun: { x: number; y: number; up: number },
  tall: number,
): Array<{ points: Array<{ x: number; y: number }>; shade: number }> {
  if (kind !== "hexayurt" || tall <= 0) return [];
  // Standard hexayurt: 4ft walls, a 2ft pyramidal roof → 6ft peak. The roof facets
  // (what self-shade) rise from the wall-top ring to the center peak, so compute
  // the normals from that real 2ft pitch, not from the ground.
  const WALL_H = 4;
  const PEAK_H = 6;
  const verts = hexVertices(0, 0, w, h); // 6 corners (local feet)
  const cx = w / 2;
  const cy = h / 2;
  const apex: Vec3 = [cx, cy, PEAK_H];
  const center: Vec3 = [cx, cy, WALL_H];
  const S: Vec3 = [sun.x, sun.y, sun.up];
  return verts.map((p, i) => {
    const q = verts[(i + 1) % verts.length] ?? p;
    const P: Vec3 = [p.x, p.y, WALL_H];
    const Q: Vec3 = [q.x, q.y, WALL_H];
    let n = v3cross(v3sub(Q, P), v3sub(apex, P));
    const m: Vec3 = [
      (P[0] + Q[0] + apex[0]) / 3,
      (P[1] + Q[1] + apex[1]) / 3,
      (P[2] + Q[2] + apex[2]) / 3,
    ];
    if (v3dot(n, v3sub(m, center)) < 0) n = [-n[0], -n[1], -n[2]];
    const nLen = Math.hypot(n[0], n[1], n[2]) || 1;
    const lambert = Math.max(0, v3dot(n, S) / nLen);
    const shade = (1 - lambert) * 0.5;
    return {
      points: [
        { x: p.x, y: p.y },
        { x: q.x, y: q.y },
        { x: cx, y: cy },
      ],
      shade,
    };
  });
}

/** The cast-shadow polygon (plot-local feet) for an object at a given sun
 * position, or null if it casts none (no height / sun at/below horizon). The
 * shadow = convex hull of the footprint outline + each corner pushed away from
 * the sun by its own height/tan(altitude). Footprint + per-corner height follow
 * the object's real shape (hexagon outline, hypar-warped heights, …); a dome is
 * special-cased to a hemisphere ellipse, and a camp-theme structure may supply a
 * full 3D silhouette via `shadowVolume`. */
function shadowPolygon(
  o: ObjRow,
  sun: { altitude: number; azimuth: number },
  mapUpBearing: number,
): ZonePt[][] {
  if (sun.altitude <= 0.5) return [];
  // A path light is a point luminaire (no real volume) → never casts shade, even
  // if an older row still carries a stored height.
  if (o.kind === "path-light") return [];
  const def = kindDef(o.kind);
  if (def.shape === "dome") {
    const d = domeShadow(o, sun, mapUpBearing);
    return d ? [d] : [];
  }
  if (def.shadowVolume)
    return volumeShadow(
      o,
      def.shadowVolume(o.width, o.height, o.config),
      sun,
      mapUpBearing,
    );
  const altDeg = Math.max(sun.altitude, 3); // clamp so low sun ≠ infinite shadow
  const tan = Math.tan((altDeg * Math.PI) / 180);
  const heights = cornerHeights(o);
  if (heights.every((h) => h <= 0)) return [];
  // Unit shadow direction in plot-local feet (pointing away from the sun).
  const dir = bearingToPlotDelta(sun.azimuth + 180, 1, mapUpBearing);
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const corners: ZonePt[] = footprintLocal(o).map(([lx, ly]) => {
    const v = rotateVec(lx, ly, o.rotation);
    return { x: cx + v.x, y: cy + v.y };
  });
  const tips = corners.map((c, i) => {
    const len = Math.min((heights[i] ?? 0) / tan, 300);
    return { x: c.x + dir.dx * len, y: c.y + dir.dy * len };
  });
  // An open canopy (shade cloth on legs) casts only its top layer projected to
  // the ground — a floating shadow, not a solid extrusion connected to the base.
  if (def.canopyShade) return [convexHull(tips)];
  return [convexHull(corners.concat(tips))];
}

/** Effective frontage radius (ft from the Man): the manual override if set,
 * else derived from the lot's street letter + year. Null → no taper. */
function frontageRadiusOf(lot: {
  innerRadiusFt: number | null;
  streetLetter: string | null;
  year: number | null;
}): number | null {
  return lot.innerRadiusFt ?? radiusForStreet(lot.year, lot.streetLetter);
}

/** Rear (service-alley) edge width in feet. A Man-facing lot widens outward;
 * a mountain-facing lot narrows toward the Man. */
function rearWidthOf(lot: Lot, radius: number | null): number {
  if (!radius) return lot.frontageFt;
  const rearRadius = lot.frontsToMan
    ? radius + lot.depthFt
    : radius - lot.depthFt;
  if (rearRadius <= 0) return lot.frontageFt;
  return (lot.frontageFt * rearRadius) / radius;
}

/** Half-width (ft) of the lot trapezoid at depth `y` — interpolates the frontage
 * half-width to the rear half-width. */
function lotHalfWidthAt(
  y: number,
  frontageFt: number,
  depthFt: number,
  rear: number,
): number {
  const t = depthFt > 0 ? clamp(y / depthFt, 0, 1) : 0;
  return (frontageFt / 2) * (1 - t) + (rear / 2) * t;
}

/** A kind's footprint vertices as offsets from the object center, rotated by
 * `rotation` — the real (polygon) outline, so containment uses the true shape. */
function footprintOffsets(
  kind: string,
  w: number,
  h: number,
  rotation: number,
  config: StructureConfig = {},
  mirror = false,
): Array<{ x: number; y: number }> {
  return footprintOutline(kind, w, h, config, mirror).map(([lx, ly]) =>
    rotateVec(lx, ly, rotation),
  );
}

/** Fit an object's CENTER so its whole ROTATED footprint polygon stays inside the
 * lot trapezoid (not a bounding circle/box). `offs` = the footprint vertices as
 * offsets from the center. Clamps the vertical span into [0, depthFt], then clamps
 * x using each vertex's own half-width at its depth (so the taper is respected).
 * If the shape is bigger than the lot in a dimension, it's centered there. */
function fitCenterInsideLot(
  cx: number,
  cy: number,
  offs: Array<{ x: number; y: number }>,
  frontageFt: number,
  depthFt: number,
  rear: number,
): { x: number; y: number } {
  if (!offs.length) return { x: cx, y: clamp(cy, 0, depthFt) };
  let minVy = Number.POSITIVE_INFINITY;
  let maxVy = Number.NEGATIVE_INFINITY;
  for (const o of offs) {
    minVy = Math.min(minVy, o.y);
    maxVy = Math.max(maxVy, o.y);
  }
  const yLo = -minVy;
  const yHi = depthFt - maxVy;
  const y = yLo <= yHi ? clamp(cy, yLo, yHi) : (yLo + yHi) / 2;
  const mid = frontageFt / 2;
  let xLo = Number.NEGATIVE_INFINITY;
  let xHi = Number.POSITIVE_INFINITY;
  for (const o of offs) {
    const ay = clamp(y + o.y, 0, depthFt);
    const hw = lotHalfWidthAt(ay, frontageFt, depthFt, rear);
    xLo = Math.max(xLo, mid - hw - o.x);
    xHi = Math.min(xHi, mid + hw - o.x);
  }
  const x = xLo <= xHi ? clamp(cx, xLo, xHi) : (xLo + xHi) / 2;
  return { x, y };
}

/** Is a point (plot-local feet) inside the lot trapezoid? */
function pointInLot(
  px: number,
  py: number,
  frontageFt: number,
  depthFt: number,
  rear: number,
): boolean {
  if (py < -1e-6 || py > depthFt + 1e-6) return false;
  const half = lotHalfWidthAt(py, frontageFt, depthFt, rear);
  return Math.abs(px - frontageFt / 2) <= half + 1e-6;
}

/** Does an object's (rotated) footprint cross the lot border? True if any of its
 * box corners lies outside the lot trapezoid — drives the overflow highlight. */
function objectOverflowsLot(
  o: ObjRow,
  frontageFt: number,
  depthFt: number,
  rear: number,
): boolean {
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  // Test the object's REAL footprint outline (triangle, hexagon, …), rotated —
  // not a bounding box, so a rotated non-rect shape isn't falsely flagged.
  for (const [lx, ly] of footprintLocal(o)) {
    const v = rotateVec(lx, ly, o.rotation);
    if (!pointInLot(cx + v.x, cy + v.y, frontageFt, depthFt, rear)) return true;
  }
  return false;
}

/** Format feet as feet-and-inches, e.g. 104.93 → 104′11″. */
function feetInches(ft: number): string {
  const neg = ft < 0;
  const a = Math.abs(ft);
  let whole = Math.floor(a);
  let inch = Math.round((a - whole) * 12);
  if (inch === 12) {
    whole += 1;
    inch = 0;
  }
  return `${neg ? "−" : ""}${whole}′${inch}″`;
}

/** Caption under the map: real measured grid scale + how much the wedge skews
 * the lot, in feet-and-inches (not a percentage). */
function GridScaleNote({ lot }: { lot: Lot }) {
  const radius = frontageRadiusOf(lot);
  const rear = rearWidthOf(lot, radius);
  const front = lot.frontageFt;
  const delta = rear - front;
  const tapered = Math.abs(delta) >= 0.05;
  const cellRear = front > 0 ? 10 * (rear / front) : 10;
  return (
    <Text size="xs" c="dimmed" mt={6}>
      {tapered ? (
        <>
          10′ grid · {delta > 0 ? "widens" : "narrows"} {feetInches(front)}→
          {feetInches(rear)} ({delta > 0 ? "+" : "−"}
          {feetInches(Math.abs(delta))}) · cols 10′0″→{feetInches(cellRear)} ·
          rows 10′0″
        </>
      ) : (
        <>10′ grid · square cells, no skew</>
      )}
    </Text>
  );
}

/** Copy every element's *computed* presentation styles onto a clone, so a
 * serialized copy of the map SVG rasterizes with the right colors even though the
 * live SVG relies on CSS variables (Mantine palette + the map scheme vars). */
function inlineComputedStyles(src: Element, dst: Element) {
  const cs = window.getComputedStyle(src);
  const PROPS = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "text-transform",
    "display",
  ];
  let style = "";
  for (const p of PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) style += `${p}:${v};`;
  }
  dst.setAttribute("style", style);
  const s = src.children;
  const d = dst.children;
  for (let i = 0; i < s.length; i++) {
    const si = s[i];
    const di = d[i];
    if (si && di) inlineComputedStyles(si, di);
  }
}

/** Render the live map SVG to a single-page portrait JPEG (8.5×11 @ 200dpi) with
 * a header block (camp name, dimensions, contact, date + version), then trigger a
 * download. Client-only. Follows Burning Man's layout-file conventions. */
async function exportMapJpeg(opts: {
  filename: string;
  campName: string;
  dims: string;
  contactLines: string[];
  dateVersion: string;
}) {
  const live = document.getElementById("camp-map-svg") as SVGSVGElement | null;
  if (!live) throw new Error("Map SVG not found on the page.");
  // NOTE: the caller forces the light color scheme + a re-render before calling
  // this, so BM layouts export on a light background (readable in B/W) regardless
  // of the viewer's theme — see BurningManExport.onExport.
  const clone = live.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(live, clone);
  // Strip campers' personal (occupant) names from the submission image — BM only
  // needs the camp + the single submission contact, not everyone's names. Done
  // after inlining so the live↔clone tree walk stays aligned.
  for (const el of Array.from(clone.querySelectorAll("[data-personal-name]"))) {
    el.remove();
  }
  clone.removeAttribute("style"); // root sizes from width/height attrs below
  const vb = live.viewBox.baseVal;
  const mw = vb.width || live.clientWidth || 1000;
  const mh = vb.height || live.clientHeight || 1000;
  clone.setAttribute("width", String(mw));
  clone.setAttribute("height", String(mh));
  const xml = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("Could not rasterize the map."));
    img.src = url;
  });

  // 8.5×11 inch portrait at 200dpi.
  const CW = 1700;
  const CH = 2200;
  const M = 80;
  const canvas = document.createElement("canvas");
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CW, CH);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";

  let y = M;
  ctx.font = "bold 72px system-ui, sans-serif";
  ctx.fillText(opts.campName, M, y);
  y += 90;
  ctx.font = "bold 40px system-ui, sans-serif";
  ctx.fillText(opts.dims, M, y);
  y += 54;
  ctx.font = "28px system-ui, sans-serif";
  for (const line of opts.contactLines) {
    if (line) {
      ctx.fillText(line, M, y);
      y += 40;
    }
  }
  ctx.fillText(opts.dateVersion, M, y);
  y += 56;

  // Fit the map into the remaining box, preserving aspect, centered horizontally.
  const boxY = y;
  const boxW = CW - 2 * M;
  const boxH = CH - M - boxY;
  const scale = Math.min(boxW / mw, boxH / mh);
  const dw = mw * scale;
  const dh = mh * scale;
  ctx.drawImage(img, M + (boxW - dw) / 2, boxY, dw, dh);

  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob((b) => res(b), "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Failed to encode the image.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = opts.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/** Sanitize a camp name into a filename-safe abbreviation (lowercase, no spaces,
 * ≤10 chars) so `<abbr>_mm_dd.jpg` stays within BM's 20-char filename limit. */
function deriveAbbrev(campName: string) {
  return campName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
}

/** Officer + Burning-Man export: a dialog that collects/persists the submission
 * contact, then renders the map to a BM-compliant portrait JPEG. */
function BurningManExport({
  campName,
  lotLocation,
  dims,
  mapStatus,
  contact,
  account,
  fetcher,
}: {
  campName: string;
  lotLocation: string;
  dims: string;
  mapStatus: string | null;
  contact: { name: string; playa: string; email: string; phone: string };
  account: { name: string; email: string };
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(contact.name || account.name);
  const [playa, setPlaya] = useState(contact.playa);
  const [email, setEmail] = useState(contact.email || account.email);
  const [phone, setPhone] = useState(contact.phone);
  const [version, setVersion] = useState(mapStatus ?? "");
  const [abbrev, setAbbrev] = useState(deriveAbbrev(campName));

  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const cleanAbbrev = deriveAbbrev(abbrev);
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  // ISO date only (YYYY-MM-DD) — never MM/DD/YY.
  const isoDate = `${now.getFullYear()}-${mm}-${dd}`;
  const filename = `${cleanAbbrev}_${mm}_${dd}.jpg`;
  const filenameOk = cleanAbbrev.length > 0 && filename.length <= 20;

  // "First «playa» Last": drop the playa name in between the first and last name.
  const displayName = (() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const first = parts[0] ?? "";
    const last = parts.slice(1).join(" ");
    return [first, playa ? `"${playa}"` : "", last].filter(Boolean).join(" ");
  })();

  const onExport = async () => {
    setBusy(true);
    setErr(null);
    // BM layouts must read on a light background (B/W-safe). Force light + let the
    // map re-render (some fills are theme-derived in JS, not just CSS vars), then
    // restore the viewer's scheme after.
    const prevScheme = colorScheme;
    try {
      // Persist the contact for next time (camp-scoped).
      fetcher.submit(
        { intent: "setPlacementContact", name, playa, email, phone },
        { method: "post" },
      );
      setColorScheme("light");
      // Wait for the re-render + paint to land before we snapshot the SVG.
      await new Promise<void>((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res())),
      );
      const contactLines = [
        `Contact: ${displayName}`,
        [email, phone].filter(Boolean).join("   ·   "),
      ];
      const dateVersion = `Date: ${isoDate}${
        version ? `      Version: ${version}` : ""
      }`;
      await exportMapJpeg({
        filename,
        campName,
        dims: `${dims}${lotLocation ? ` · ${lotLocation}` : ""}`,
        contactLines,
        dateVersion,
      });
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setColorScheme(prevScheme);
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="default" size="xs" onClick={() => setOpen(true)}>
        Export for BM
      </Button>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        title="Export layout for Burning Man"
        size="lg"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Renders the current map to a single-page portrait JPEG with your
            camp name, dimensions, and contact info — following BMorg's
            layout-file rules. Set a clear day (drag the sun) and a Map
            status/version first. Fuel and battery safety zones export
            automatically if placed.
          </Text>
          <Group grow>
            <TextInput
              label="First + last name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <TextInput
              label="Playa name (optional)"
              value={playa}
              onChange={(e) => setPlaya(e.currentTarget.value)}
            />
          </Group>
          <Group grow>
            <TextInput
              label="Email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
            <TextInput
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
            />
          </Group>
          <Group grow>
            <TextInput
              label="Version"
              placeholder="e.g. FINAL v2"
              value={version}
              onChange={(e) => setVersion(e.currentTarget.value)}
            />
            <TextInput
              label="Filename abbreviation"
              description={`Saves as ${filename}`}
              error={
                filenameOk
                  ? undefined
                  : "Needs 1–10 letters/numbers, no spaces."
              }
              value={abbrev}
              onChange={(e) => setAbbrev(e.currentTarget.value)}
            />
          </Group>
          {err ? (
            <Text size="sm" c="red">
              {err}
            </Text>
          ) : null}
          <Group justify="flex-end" mt="xs">
            <Button variant="default" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onExport} loading={busy} disabled={!filenameOk}>
              Export JPEG
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Officer control for the free-text map "doneness" label (the watermark shown
 * over the map + used as the export's version tag). Preset chips apply instantly;
 * the text field saves on Enter / the Save button. Empty clears the overlay. */
function MapStatusControl({
  status,
  fetcher,
}: {
  status: string;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [val, setVal] = useState(status);
  // Reconcile when the server value changes (e.g. after a save revalidates).
  useEffect(() => {
    setVal(status);
  }, [status]);
  const save = (next: string) =>
    fetcher.submit(
      { intent: "setMapStatus", mapStatus: next },
      { method: "post" },
    );
  const PRESETS = ["DRAFT", "NOT FINAL", "FINAL"];
  const dirty = val.trim() !== status.trim();
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={6}>
        Map status
      </Text>
      <Group gap={6} mb={8}>
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="compact-xs"
            variant={status.trim() === p ? "filled" : "light"}
            onClick={() => {
              setVal(p);
              save(p);
            }}
          >
            {p}
          </Button>
        ))}
      </Group>
      <TextInput
        size="xs"
        placeholder="e.g. FINAL v2 (or blank for none)"
        value={val}
        maxLength={60}
        onChange={(e) => setVal(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save(val);
          }
        }}
      />
      <Group justify="space-between" mt={8}>
        <Text size="xs" c="dimmed">
          Shown as a watermark over the map.
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          disabled={!dirty}
          onClick={() => save(val)}
        >
          Save
        </Button>
      </Group>
    </Paper>
  );
}

export default function CampMap({ loaderData }: Route.ComponentProps) {
  const { canEdit, canManage, unplaced, lot, myMembershipId, event } =
    loaderData;
  const bannedKinds = loaderData.bannedKinds;
  // Free-text "doneness" label overlaid on the map (officer-set, null = none).
  const mapStatus = loaderData.mapStatus?.trim() || null;
  // On phones the map + side rail stack vertically and the page scrolls
  // naturally instead of the desktop fixed-height, two-pane / inner-scroll model.
  const isNarrow = useMediaQuery("(max-width: 768px)");
  const fetcher = useFetcher();
  const [objects, setObjects] = useState<ObjRow[]>(loaderData.objects);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi-selection: all currently-selected object ids (includes the primary
  // `selectedId`, which drives the side panel). Drag/rotate act on the whole set.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [zones, setZones] = useState<ZoneRow[]>(loaderData.zones);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [cables, setCables] = useState<CableRow[]>(loaderData.cables);
  const [selectedCableId, setSelectedCableId] = useState<string | null>(null);
  const [roads, setRoads] = useState<RoadRow[]>(loaderData.roads);
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null);
  // Highlight filter: dims everything that doesn't match the chosen category.
  const [highlight, setHighlight] = useState<string>("none");
  // Global door visibility — master switch over each object's own showDoor flag.
  const [showDoors, setShowDoors] = useState(true);
  // Fire-access overlay: shade the lot by 125′ hose reach from the street/alley.
  const [showFire, setShowFire] = useState(false);
  // Lot config form: hidden by default, revealed by the toolbar gear (it's a
  // once-at-setup form). Lifted here so the gear (in the map toolbar) and the
  // form (in the side rail) share one flag.
  const [lotOpen, setLotOpen] = useState(false);

  // ---- Shade simulation: time of day drives the sun, which casts shadows. The
  // sim is always on (drag the sun to the day's ends to clear the shadows). ----
  const sunYear = lot?.year ?? CURRENT_EVENT_YEAR;
  const arc = useMemo(() => dayArc(sunYear), [sunYear]);
  // Animation is opt-in: the sun otherwise holds at a fixed time; turn this on to
  // auto-drift the sun across the day.
  const [animateShade, setAnimateShade] = useState(false);
  // Local minute-of-day; start mid-afternoon for a clear shade demo.
  const [timeMin, setTimeMin] = useState(() =>
    Math.round((arc.noonMin + arc.sunsetMin) / 2),
  );
  // True while the user is dragging the compass sun (pauses the auto-drift).
  const [sunDragging, setSunDragging] = useState(false);
  const sun = useMemo(() => sunAt(sunYear, timeMin), [sunYear, timeMin]);

  // ---- Prevailing-wind flow visualization (animated particles around buildings).
  // Density is picked from discrete Off/Low/Med/High levels (0 = off); direction
  // + strength live on the orientation dial (a *from* bearing seeded to BRC's
  // prevailing wind, distance-from-center = strength). Client-only (not persisted).
  const [windParticles, setWindParticles] = useState(0);
  const [windFromBearing, setWindFromBearing] = useState(BRC_WIND_FROM_BEARING);
  const [windStrength, setWindStrength] = useState(1);
  const showWind = windParticles > 0;
  // Auto-drift the sun while animation is on (and it isn't being dragged) across
  // the FULL day — through night too, so the night-lighting effects play — looping
  // back to midnight after a full 24h.
  useEffect(() => {
    if (!animateShade || sunDragging) return;
    const id = setInterval(() => {
      setTimeMin((t) => {
        const n = t + 6;
        return n >= 1440 ? 0 : n;
      });
    }, 120);
    return () => clearInterval(id);
  }, [animateShade, sunDragging]);

  // Reconcile the authoritative object the server returns after each mutation:
  // upsert it (a newly added/placed one gets appended + selected; an updated one
  // is replaced in place, picking up any pending-approval flag), and drop deleted
  // ones. Guarded so the same response is only applied once.
  const lastSynced = useRef<unknown>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to new fetcher.data
  useEffect(() => {
    const d = fetcher.data as
      | {
          object?: ObjRow;
          objects?: ObjRow[];
          deletedId?: string;
          unplacedId?: string;
          zone?: ZoneRow;
          deletedZoneId?: string;
          cable?: CableRow;
          deletedCableId?: string;
          road?: RoadRow;
          deletedRoadId?: string;
        }
      | undefined;
    if (!d || d === lastSynced.current) return;
    lastSynced.current = d;
    // A premade block returns several new objects at once — append them all.
    if (d.objects && d.objects.length > 0) {
      const fresh = d.objects;
      setObjects((prev) => {
        const have = new Set(prev.map((o) => o.id));
        return [...prev, ...fresh.filter((o) => !have.has(o.id))];
      });
      return;
    }
    // Deleted (gone for good) or unplaced (back to the tray) both leave the map.
    const removedId = d.deletedId ?? d.unplacedId;
    if (removedId) {
      setObjects((prev) => prev.filter((o) => o.id !== removedId));
      setSelectedId((s) => (s === removedId ? null : s));
      setSelectedIds((prev) => prev.filter((id) => id !== removedId));
      return;
    }
    if (d.object) {
      const obj = d.object;
      const isNew = !objects.some((o) => o.id === obj.id);
      setObjects((prev) =>
        isNew ? [...prev, obj] : prev.map((o) => (o.id === obj.id ? obj : o)),
      );
      if (isNew) {
        setSelectedId(obj.id);
        setSelectedIds([obj.id]);
      }
      return;
    }
    if (d.deletedZoneId) {
      const gone = d.deletedZoneId;
      setZones((prev) => prev.filter((z) => z.id !== gone));
      setSelectedZoneId((s) => (s === gone ? null : s));
      return;
    }
    if (d.zone) {
      const zone = d.zone;
      const isNew = !zones.some((z) => z.id === zone.id);
      setZones((prev) =>
        isNew
          ? [...prev, zone]
          : prev.map((z) => (z.id === zone.id ? zone : z)),
      );
      if (isNew) setSelectedZoneId(zone.id);
      return;
    }
    if (d.deletedCableId) {
      const gone = d.deletedCableId;
      setCables((prev) => prev.filter((c) => c.id !== gone));
      setSelectedCableId((s) => (s === gone ? null : s));
      return;
    }
    if (d.cable) {
      const cable = d.cable;
      const isNew = !cables.some((c) => c.id === cable.id);
      setCables((prev) =>
        isNew
          ? [...prev, cable]
          : prev.map((c) => (c.id === cable.id ? cable : c)),
      );
      if (isNew) setSelectedCableId(cable.id);
      return;
    }
    if (d.deletedRoadId) {
      const gone = d.deletedRoadId;
      setRoads((prev) => prev.filter((r) => r.id !== gone));
      setSelectedRoadId((s) => (s === gone ? null : s));
      return;
    }
    if (d.road) {
      const road = d.road;
      const isNew = !roads.some((r) => r.id === road.id);
      setRoads((prev) =>
        isNew
          ? [...prev, road]
          : prev.map((r) => (r.id === road.id ? road : r)),
      );
      if (isNew) setSelectedRoadId(road.id);
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
    // Fill the dashboard content area (viewport − header − Main padding) and keep
    // all scrolling INSIDE the map frame / sidebar, so zooming never adds a second
    // page-level scrollbar.
    <div
      className="camp-map-page"
      style={{
        display: "flex",
        flexDirection: "column",
        // Desktop: fill the viewport and keep scrolling inside the map/rail.
        // Mobile: let the stacked map + rail grow and the page scroll normally.
        height: isNarrow ? "auto" : "calc(100vh - 88px)",
        minHeight: isNarrow ? "calc(100vh - 88px)" : 0,
      }}
    >
      {/* Print isolation: hide everything, reveal only the map column, force a
      single portrait page. The status watermark lives inside the SVG, so it
      prints for free. See MAP_PRINT_CSS. */}
      {/** biome-ignore lint/security/noDangerouslySetInnerHtml: static, no user input */}
      <style dangerouslySetInnerHTML={{ __html: MAP_PRINT_CSS }} />
      <Group
        justify="space-between"
        align="flex-end"
        mb="sm"
        style={{ flex: "0 0 auto" }}
      >
        <div>
          <Title order={2}>Camp map</Title>
          <Text c="dimmed" size="sm">
            {lot.frontageFt}′ frontage × {lot.depthFt}′ deep
            {lot.street
              ? ` · ${lot.street}`
              : lot.streetLetter && lot.year
                ? ` · ${streetLabel(lot.year, lot.streetLetter)}`
                : ""}
            {lot.address ? ` @ ${lot.address}` : ""}
            {lot.frontsToMan ? "" : " · mountain-facing"}
          </Text>
        </div>
        <Group gap="xs" align="center" wrap="nowrap">
          {isBurningMan(event) ? <BurningManDisclaimer mt={0} /> : null}
          <Button variant="default" size="xs" onClick={() => window.print()}>
            Print
          </Button>
          {canManage && isBurningMan(event) ? (
            <BurningManExport
              campName={loaderData.campName}
              lotLocation={
                lot.street
                  ? lot.street
                  : lot.streetLetter && lot.year
                    ? streetLabel(lot.year, lot.streetLetter)
                    : ""
              }
              dims={`${lot.frontageFt}′ × ${lot.depthFt}′`}
              mapStatus={mapStatus}
              contact={loaderData.contact}
              account={loaderData.account}
              fetcher={fetcher}
            />
          ) : null}
        </Group>
      </Group>

      <Flex
        align="stretch"
        gap="lg"
        direction={{ base: "column", md: "row" }}
        style={{ flex: 1, minHeight: 0 }}
      >
        <div
          className="camp-map-print"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            height: isNarrow ? "70vh" : "100%",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          {/* Print-only caption: identifies the printout (screen-hidden). */}
          <div className="camp-map-print-caption">
            <strong>{loaderData.campName}</strong> — {lot.frontageFt}′ ×{" "}
            {lot.depthFt}′{lot.address ? ` @ ${lot.address}` : ""}
            {mapStatus ? ` · ${mapStatus}` : ""}
          </div>
          <Editor
            lot={lot}
            objects={objects}
            setObjects={setObjects}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            selectedIds={selectedIds}
            setSelectedIds={setSelectedIds}
            zones={zones}
            selectedZoneId={selectedZoneId}
            setSelectedZoneId={setSelectedZoneId}
            cables={cables}
            setCables={setCables}
            selectedCableId={selectedCableId}
            setSelectedCableId={setSelectedCableId}
            roads={roads}
            setRoads={setRoads}
            selectedRoadId={selectedRoadId}
            setSelectedRoadId={setSelectedRoadId}
            canEdit={canEdit}
            canManage={canManage}
            myMembershipId={myMembershipId}
            bannedKinds={bannedKinds}
            mapStatus={mapStatus}
            highlight={highlight}
            lotOpen={lotOpen}
            setLotOpen={setLotOpen}
            mapUpBearing={mapUpBearingFor(lot.address, lot.frontsToMan)}
            sun={sun}
            showDoors={showDoors}
            showFire={showFire}
            showWind={showWind}
            windFromBearing={windFromBearing}
            windStrength={windStrength}
            windParticles={windParticles}
            fetcher={fetcher}
          />
          <GridScaleNote lot={lot} />
        </div>
        <Stack
          gap="md"
          w={{ base: "100%", md: 320 }}
          style={{
            flex: isNarrow ? "0 0 auto" : "0 0 320px",
            height: isNarrow ? "auto" : "100%",
            overflowY: isNarrow ? "visible" : "auto",
            paddingRight: 4,
          }}
        >
          {canManage ? (
            <MapStatusControl
              status={loaderData.mapStatus ?? ""}
              fetcher={fetcher}
            />
          ) : null}
          <Paper withBorder p="sm" radius="md">
            <Text size="xs" fw={600} mb={6}>
              Highlight
            </Text>
            <SegmentedControl
              size="xs"
              fullWidth
              value={highlight}
              onChange={setHighlight}
              data={[
                { label: "All", value: "none" },
                { label: "Mine", value: "mine" },
                { label: "Homes", value: "domicile" },
                { label: "Vehicles", value: "vehicle" },
                { label: "Builds", value: "structure" },
              ]}
            />
            <Checkbox
              mt="sm"
              size="xs"
              label="Show doors"
              checked={showDoors}
              onChange={(e) => setShowDoors(e.currentTarget.checked)}
            />
            <Checkbox
              mt={6}
              size="xs"
              label="Fire access (125′)"
              checked={showFire}
              onChange={(e) => setShowFire(e.currentTarget.checked)}
            />
            {showFire ? (
              <Text size="xs" c="dimmed" mt={4}>
                Green = within 125′ hose reach of the street/alley. Red = beyond
                reach (needs an internal fire lane). Assumes rear-alley access.
              </Text>
            ) : null}
          </Paper>
          <Compass
            mapUpBearing={mapUpBearingFor(lot.address, lot.frontsToMan)}
            frontsToMan={lot.frontsToMan}
            sun={sun}
            year={sunYear}
            arc={arc}
            timeMin={timeMin}
            setTimeMin={setTimeMin}
            setSunDragging={setSunDragging}
            animateShade={animateShade}
            setAnimateShade={setAnimateShade}
            windFromBearing={windFromBearing}
            setWindFromBearing={setWindFromBearing}
            windStrength={windStrength}
            setWindStrength={setWindStrength}
            windParticles={windParticles}
            setWindParticles={setWindParticles}
            resetWind={() => {
              setWindFromBearing(BRC_WIND_FROM_BEARING);
              setWindStrength(1);
            }}
          />
          {canManage ? (
            <PendingPanel
              objects={objects}
              setSelectedId={setSelectedId}
              fetcher={fetcher}
            />
          ) : null}
          {canManage ? (
            <UnplacedTray unplaced={unplaced} fetcher={fetcher} />
          ) : null}
          {canManage ? <BlockPalette /> : null}
          {canManage ? <Legend bannedKinds={bannedKinds} /> : null}
          {selectedZoneId ? (
            <ZonePanel
              zones={zones}
              selectedZoneId={selectedZoneId}
              setZones={setZones}
              canManage={canManage}
              fetcher={fetcher}
            />
          ) : null}
          {selectedCableId ? (
            <CablePanel
              cables={cables}
              selectedCableId={selectedCableId}
              setCables={setCables}
              canManage={canManage}
              fetcher={fetcher}
            />
          ) : null}
          {selectedRoadId ? (
            <RoadPanel
              roads={roads}
              selectedRoadId={selectedRoadId}
              setRoads={setRoads}
              canManage={canManage}
              fetcher={fetcher}
            />
          ) : null}
          {selectedIds.length > 1 ? (
            <Paper withBorder p="sm" radius="md" bg="blue.0">
              <Text size="sm" fw={600}>
                {selectedIds.length} items selected
              </Text>
              <Text size="xs" c="dimmed">
                Drag any one to move them together; use the round handle above
                the box to rotate the group. Arrows nudge · Space/R rotate · Del
                unplaces. Shift-click or box-drag to change the selection.
              </Text>
              {canManage ? (
                <Group gap="xs" mt="xs">
                  <Button
                    size="compact-xs"
                    variant="light"
                    onClick={() => {
                      const groupId = crypto.randomUUID();
                      setObjects((prev) =>
                        prev.map((o) =>
                          selectedIds.includes(o.id) ? { ...o, groupId } : o,
                        ),
                      );
                      fetcher.submit(
                        {
                          intent: "linkObjects",
                          groupId,
                          ids: JSON.stringify(selectedIds),
                        },
                        { method: "post" },
                      );
                    }}
                  >
                    🔗 Link as block
                  </Button>
                  {objects.some(
                    (o) => selectedIds.includes(o.id) && o.groupId,
                  ) ? (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      onClick={() => {
                        setObjects((prev) =>
                          prev.map((o) =>
                            selectedIds.includes(o.id)
                              ? { ...o, groupId: null }
                              : o,
                          ),
                        );
                        fetcher.submit(
                          {
                            intent: "unlinkObjects",
                            ids: JSON.stringify(selectedIds),
                          },
                          { method: "post" },
                        );
                      }}
                    >
                      Unlink
                    </Button>
                  ) : null}
                </Group>
              ) : null}
            </Paper>
          ) : null}
          <SidePanel
            lot={lot}
            objects={objects}
            setObjects={setObjects}
            selectedId={selectedId}
            canEdit={canEdit}
            canManage={canManage}
            myMembershipId={myMembershipId}
            bannedKinds={bannedKinds}
            lotOpen={lotOpen}
            fetcher={fetcher}
          />
        </Stack>
      </Flex>
    </div>
  );
}

type Unplaced = Route.ComponentProps["loaderData"]["unplaced"][number];

/** Officer queue of declared-but-unplaced items; drag one onto the lot to place,
 * or permanently delete one with its ✕ (the only place items are truly removed —
 * the map's ✕ just returns them here). */
function UnplacedTray({
  unplaced,
  fetcher,
}: {
  unplaced: Unplaced[];
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={6}>
        Unplaced ({unplaced.length}) — drag onto the map
      </Text>
      {unplaced.length === 0 ? (
        <Text size="xs" c="dimmed">
          Everything declared has been placed.
        </Text>
      ) : (
        <Stack gap={6}>
          {unplaced.map((u) => {
            const def = kindDef(u.kind);
            return (
              <Group
                key={u.id}
                gap={6}
                wrap="nowrap"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/camptool-place-id", u.id);
                  e.dataTransfer.setData(
                    "application/camptool-w",
                    String(u.width),
                  );
                  e.dataTransfer.setData(
                    "application/camptool-h",
                    String(u.height),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                style={{
                  cursor: "grab",
                  border: "1px solid var(--mantine-color-default-border)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  userSelect: "none",
                }}
              >
                <Tooltip label={def.label} withArrow openDelay={150}>
                  <span style={{ display: "flex" }}>
                    <KindIcon kind={def} size={22} />
                  </span>
                </Tooltip>
                <Text size="xs" style={{ flex: 1 }}>
                  {round(u.width)}×{round(u.height)}′
                </Text>
                {u.ownerName ? (
                  <Text size="xs" c="dimmed" truncate maw={72}>
                    {u.ownerName}
                  </Text>
                ) : null}
                <Tooltip label="Delete permanently" withArrow openDelay={150}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      fetcher.submit(
                        { intent: "deleteObject", id: u.id },
                        { method: "post" },
                      )
                    }
                  >
                    ✕
                  </ActionIcon>
                </Tooltip>
              </Group>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

/** Premade blocks — drag one onto the map to drop a pre-arranged cluster of
 * objects (officer-only; the items can then be fine-tuned individually). */
function BlockPalette() {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={6}>
        Blocks — drag onto the map
      </Text>
      <Stack gap={6}>
        {BLOCKS.map((b) => (
          <Group
            key={b.id}
            gap={6}
            wrap="nowrap"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/camptool-block-id", b.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            style={{
              cursor: "grab",
              border: "1px solid var(--mantine-color-default-border)",
              borderRadius: 6,
              padding: "4px 8px",
              userSelect: "none",
            }}
          >
            <Text size="xs">{b.label}</Text>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}

/** Draggable palette — icons grouped by category; drag one onto the map to
 * place that kind. Names show as tooltips so the grid of icons stays compact.
 * Kinds disallowed this edition (`bannedKinds`) are dropped from the palette. */
function Legend({ bannedKinds }: { bannedKinds: string[] }) {
  const banned = new Set(bannedKinds);
  const groups = KIND_GROUPS.map((grp) => ({
    ...grp,
    kinds: grp.kinds.filter((k) => !banned.has(k.value)),
  })).filter((grp) => grp.kinds.length > 0);
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={8}>
        Legend — drag onto the map
      </Text>
      <Stack gap={8}>
        {groups.map((grp) => (
          <div key={grp.group}>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
              {grp.group}
            </Text>
            <Group gap={6}>
              {grp.kinds.map((k) => (
                <Tooltip
                  key={k.value}
                  label={k.label}
                  withArrow
                  openDelay={150}
                >
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        "application/camptool-kind",
                        k.value,
                      );
                      e.dataTransfer.setData("text/plain", k.value);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    style={{
                      cursor: "grab",
                      border: "1px solid var(--mantine-color-default-border)",
                      borderRadius: 6,
                      padding: 4,
                      userSelect: "none",
                      display: "flex",
                    }}
                  >
                    <KindIcon kind={k} size={30} />
                  </div>
                </Tooltip>
              ))}
            </Group>
          </div>
        ))}
      </Stack>
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
  selectedIds,
  setSelectedIds,
  zones,
  selectedZoneId,
  setSelectedZoneId,
  cables,
  setCables,
  selectedCableId,
  setSelectedCableId,
  roads,
  setRoads,
  selectedRoadId,
  setSelectedRoadId,
  canEdit,
  canManage,
  myMembershipId,
  bannedKinds,
  mapStatus,
  highlight,
  lotOpen,
  setLotOpen,
  mapUpBearing,
  sun,
  showDoors,
  showFire,
  showWind,
  windFromBearing,
  windStrength,
  windParticles,
  fetcher,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedIds: string[];
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  zones: ZoneRow[];
  selectedZoneId: string | null;
  setSelectedZoneId: (id: string | null) => void;
  cables: CableRow[];
  setCables: React.Dispatch<React.SetStateAction<CableRow[]>>;
  selectedCableId: string | null;
  setSelectedCableId: (id: string | null) => void;
  roads: RoadRow[];
  setRoads: React.Dispatch<React.SetStateAction<RoadRow[]>>;
  selectedRoadId: string | null;
  setSelectedRoadId: (id: string | null) => void;
  canEdit: boolean;
  canManage: boolean;
  myMembershipId: string;
  bannedKinds: string[];
  /** Free-text doneness label drawn as a watermark over the map (null = none). */
  mapStatus: string | null;
  highlight: string;
  lotOpen: boolean;
  setLotOpen: (v: boolean) => void;
  mapUpBearing: number | null;
  sun: { altitude: number; azimuth: number };
  showDoors: boolean;
  showFire: boolean;
  showWind: boolean;
  windFromBearing: number;
  windStrength: number;
  windParticles: number;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const dark = useComputedColorScheme("light") === "dark";
  // Night-lighting sim: how far the sun is below the horizon drives a dusk→night
  // overlay and turns on path lights / the pyramid's after-dark rainbow. 0 = sun
  // up; 1 = full night (sun ≥ 6° below the horizon).
  const nightFactor = Math.max(0, Math.min(1, -sun.altitude / 6));
  const isNight = nightFactor > 0.05;
  // Map zoom: 1 fits the whole lot in the frame, >1 scales it up (the frame
  // scrolls to pan). The buttons step it; the wheel zooms toward the cursor.
  const [zoom, setZoom] = useState(1);
  const zoomBy = (factor: number) =>
    setZoom((z) =>
      clamp(Math.round(z * factor * 100) / 100, ZOOM_MIN, ZOOM_MAX),
    );
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The scrollable frame around the svg, measured so zoom 1 = fit.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState({ w: VIEW_W, h: 600 });
  // Scroll offset to apply right after a cursor-anchored wheel zoom commits.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () =>
      setFrame({
        w: el.clientWidth,
        h: Math.max(240, el.clientHeight),
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel = zoom toward the cursor (non-passive so we can stop the page from
  // scrolling). The frame's scrollbars handle panning once zoomed in.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const contentX = el.scrollLeft + cursorX;
      const contentY = el.scrollTop + cursorY;
      setZoom((prev) => {
        const next = clamp(
          Math.round(prev * Math.exp(-e.deltaY * 0.0015) * 100) / 100,
          ZOOM_MIN,
          ZOOM_MAX,
        );
        if (next !== prev) {
          const ratio = next / prev;
          pendingScroll.current = {
            left: contentX * ratio - cursorX,
            top: contentY * ratio - cursorY,
          };
        }
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the point under the cursor stable across a wheel zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom is the trigger — apply the pending scroll once the resized svg commits
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [zoom]);
  const drag = useRef<DragState | null>(null);
  const liveObj = useRef<ObjRow | null>(null);
  const [dragging, setDragging] = useState(false);
  // Editing a selected cable's vertices: which point is being dragged, and a
  // live working copy committed on pointer-up.
  const cableDrag = useRef<{ cableId: string; index: number } | null>(null);
  const liveCable = useRef<CableRow | null>(null);
  const [cableDragging, setCableDragging] = useState(false);
  // Drawing collects plot-local feet vertices for a zone (closed polygon) or a
  // power line (open polyline). `drawMode` is which, or null when not drawing.
  const [drawMode, setDrawMode] = useState<"zone" | "cable" | "road" | null>(
    null,
  );
  // Which road kind the current road draw will create (chosen on the draw button).
  const [roadDraftKind, setRoadDraftKind] = useState<string>("fire-lane");
  // Which cable kind the current cable draw will create (power / water pipe).
  const [cableDraftKind, setCableDraftKind] = useState<string>("power");
  const [draftPoints, setDraftPoints] = useState<ZonePt[]>([]);
  // Grid snap (feet) for drawing/editing zone + cable vertices. Node snapping on
  // power lines still wins over the grid.
  const [gridSnap, setGridSnap] = useState<number>(1);
  const snapGrid = (v: number) => Math.round(v / gridSnap) * gridSnap;
  // Shade snapping: while dragging a canopy/shade, snap its corners to nearby
  // structures' vertices/edges. `snapHint` marks the live snap target (a ring).
  const [snapStructures, setSnapStructures] = useState(true);
  const [snapHint, setSnapHint] = useState<ZonePt | null>(null);
  // Multi-select group gesture: move or rotate every selected object at once
  // (rotation pivots about the selection centroid). Captured at gesture start.
  const groupDrag = useRef<{
    mode: "move" | "rotate";
    startFx: number;
    startFy: number;
    cx: number;
    cy: number;
    items: { id: string; x: number; y: number; rotation: number }[];
  } | null>(null);
  // Latest geometry of the group being dragged (committed on pointer-up).
  const liveGroup = useRef<
    | {
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
        rotation: number;
      }[]
    | null
  >(null);
  // Marquee (rubber-band) selection: drag on empty canvas to box-select. The ref
  // holds the live rect (read on pointer-up, avoiding a stale-state closure); the
  // `marqueeRect` state is just for rendering the box.
  const marquee = useRef<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    additive: boolean;
  } | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [marqueeing, setMarqueeing] = useState(false);

  // Select exactly one object (or clear), keeping the multi-selection in sync.
  const selectOnly = (id: string | null) => {
    setSelectedId(id);
    setSelectedIds(id ? [id] : []);
  };

  // Officers edit anything; a member may move/resize/rotate only their own
  // items (those edits become pending approval, handled server-side).
  const editable = (o: ObjRow) =>
    canManage || (canEdit && o.ownerMembershipId === myMembershipId);

  // Drag-resizing is narrower than editing. A person knows their own tent's
  // size, so you shouldn't casually drag someone else's to a wrong dimension —
  // even officers, who arrange the camp, shouldn't resize others' domiciles by
  // eye. The corner handle is therefore limited to your own items and
  // unowned/shared objects; an officer can still correct a size via the numeric
  // width/height inputs in the properties panel.
  const resizable = (o: ObjRow) =>
    editable(o) &&
    (o.ownerMembershipId === null || o.ownerMembershipId === myMembershipId);

  // Highlight filter: an object matches the active category (or all when "none").
  const matches = (o: ObjRow) => {
    if (highlight === "none") return true;
    if (highlight === "mine") return o.ownerMembershipId === myMembershipId;
    return hasTag(o.kind, highlight as "domicile" | "vehicle" | "structure");
  };

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

  // Window-driven marquee (rubber-band) selection gesture.
  useEffect(() => {
    if (!marqueeing) return;
    const move = (e: PointerEvent) => onMarqueeMove(e);
    const up = () => endMarquee();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [marqueeing]);

  // Same window-driven gesture, for dragging a selected cable's vertex handle.
  useEffect(() => {
    if (!cableDragging) return;
    const move = (e: PointerEvent) => onCableVertexMove(e);
    const up = () => endCableDrag();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [cableDragging]);

  // Keyboard shortcuts for the selected object: R rotates (Shift = the other
  // way), arrows nudge (Shift = 10ft), Delete removes, Escape deselects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commit/fetcher are stable
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA" ||
        t?.isContentEditable
      )
        return;
      // `g` cycles the active snap grid (no selection needed).
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        setGridSnap((g) => {
          const i = SNAP_STEPS.indexOf(g as 1 | 10);
          return SNAP_STEPS[(i + 1) % SNAP_STEPS.length] ?? SNAP_STEPS[0];
        });
        return;
      }
      if (e.key === "Escape") {
        selectOnly(null);
        return;
      }
      if (!selectedIds.length) return;
      const sel = objects.filter((o) => selectedIds.includes(o.id));
      if (sel.length === 0) return;

      // Delete/Backspace sends the selection back to the Unplaced tray (not
      // destroyed). Officer-only. Batched so all of a group persist.
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!canManage) return;
        e.preventDefault();
        const ids = sel.map((o) => o.id);
        setObjects((prev) => prev.filter((o) => !ids.includes(o.id)));
        fetcher.submit(
          { intent: "unplaceObjects", ids: JSON.stringify(ids) },
          { method: "post" },
        );
        selectOnly(null);
        return;
      }

      const isGroup = sel.length > 1;
      // Group transforms are an officer feature; a single item still follows the
      // member-own edit rule.
      if (isGroup ? !canManage : !editable(sel[0] as ObjRow)) return;

      const rearW = rearWidthOf(lot, frontageRadiusOf(lot));
      const step = e.shiftKey ? 10 : 1;
      const rotate =
        e.key === " " || e.code === "Space"
          ? e.shiftKey
            ? -90
            : 90
          : e.key === "r" || e.key === "R"
            ? e.shiftKey
              ? -15
              : 15
            : null;
      const dx =
        e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      if (rotate === null && dx === 0 && dy === 0) return;
      e.preventDefault();

      const fitInside = (o: ObjRow, nx: number, ny: number): ZonePt =>
        fitCenterInsideLot(
          nx,
          ny,
          footprintOffsets(
            o.kind,
            o.width,
            o.height,
            o.rotation,
            o.config,
            o.mirrored,
          ),
          lot.frontageFt,
          lot.depthFt,
          rearW,
        );

      if (rotate !== null && isGroup) {
        // Rotate the whole group about its centroid.
        const c = groupCentroid(sel);
        const rad = (rotate * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const next = sel.map((o) => {
          const ox = o.x + o.width / 2 - c.x;
          const oy = o.y + o.height / 2 - c.y;
          const ncx = c.x + ox * cos - oy * sin;
          const ncy = c.y + ox * sin + oy * cos;
          return {
            ...o,
            x: ncx - o.width / 2,
            y: ncy - o.height / 2,
            rotation: Math.round(o.rotation + rotate),
          };
        });
        const m = new Map(next.map((n) => [n.id, n]));
        setObjects((prev) => prev.map((o) => m.get(o.id) ?? o));
        commitGroup(next);
        return;
      }

      // Move/rotate each selected object (single or group), clamped to the lot.
      const next = sel.map((o) => {
        const rotation =
          rotate !== null ? Math.round(o.rotation + rotate) : o.rotation;
        const c = fitInside(
          { ...o, rotation },
          o.x + dx + o.width / 2,
          o.y + dy + o.height / 2,
        );
        return {
          ...o,
          rotation,
          x: c.x - o.width / 2,
          y: c.y - o.height / 2,
        };
      });
      const m = new Map(next.map((n) => [n.id, n]));
      setObjects((prev) => prev.map((o) => m.get(o.id) ?? o));
      if (isGroup) commitGroup(next);
      else if (next[0]) commit(next[0]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    canEdit,
    canManage,
    selectedId,
    selectedIds,
    objects,
    lot.frontageFt,
    lot.depthFt,
  ]);

  // While drawing: Enter finishes (zone ≥3 pts, cable ≥2 pts), Escape cancels.
  // biome-ignore lint/correctness/useExhaustiveDependencies: finish/cancel are stable closures
  useEffect(() => {
    if (!drawMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (drawMode === "cable") finishCable();
        else if (drawMode === "road") finishRoad();
        else finishZone();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelDraw();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawMode, draftPoints]);

  // Trapezoid taper: rear edge widens (Man-facing) or narrows (mountain-facing)
  // with depth, from the derived/overridden frontage radius.
  const rear = rearWidthOf(lot, frontageRadiusOf(lot));
  const maxWidthFt = Math.max(lot.frontageFt, rear);
  // Fit the lot plus a PAD_FT annotation margin on every side into the view.
  const ppf = (VIEW_W - 2 * MARGIN) / (maxWidthFt + 2 * PAD_FT);
  const padPx = PAD_FT * ppf;
  const viewH = Math.round(MARGIN * 2 + (lot.depthFt + 2 * PAD_FT) * ppf);
  // Plot-local (0,0) = front-left corner of the frontage edge, in screen px.
  const originX = MARGIN + padPx + ((maxWidthFt - lot.frontageFt) / 2) * ppf;
  const originY = MARGIN + padPx;
  const rearCenterX = MARGIN + padPx + (maxWidthFt / 2) * ppf;
  const yBot = originY + lot.depthFt * ppf;

  // Rendered svg size: fit the whole view into the frame at zoom 1, scale up
  // from there. Explicit px (not a CSS max) so zoom grows past the intrinsic
  // size, and getBoundingClientRect stays proportional for pointer math.
  const fitScale = Math.min(frame.w / VIEW_W, frame.h / viewH) || 1;
  const renderW = Math.max(1, VIEW_W * fitScale * zoom);
  const renderH = Math.max(1, viewH * fitScale * zoom);

  const hasMine = objects.some((o) => o.ownerMembershipId === myMembershipId);
  // Pan + zoom the frame so the viewer's own items fill ~80% of it.
  function focusMine() {
    const el = frameRef.current;
    const mine = objects.filter((o) => o.ownerMembershipId === myMembershipId);
    if (!el || mine.length === 0) return;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const o of mine) {
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.width);
      maxY = Math.max(maxY, o.y + o.height);
    }
    const pad = 10; // feet of breathing room around the items
    const bw = Math.max(1, maxX - minX + 2 * pad);
    const bh = Math.max(1, maxY - minY + 2 * pad);
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    // bbox px size at zoom Z = bw·ppf·fitScale·Z; fit it to ~80% of the frame.
    const target = clamp(
      Math.min(
        (cw * 0.8) / (bw * ppf * fitScale),
        (ch * 0.8) / (bh * ppf * fitScale),
      ),
      ZOOM_MIN,
      ZOOM_MAX,
    );
    const vbcx = originX + ((minX + maxX) / 2) * ppf;
    const vbcy = originY + ((minY + maxY) / 2) * ppf;
    const left = vbcx * fitScale * target - cw / 2;
    const top = vbcy * fitScale * target - ch / 2;
    if (target === zoom) {
      el.scrollLeft = left;
      el.scrollTop = top;
    } else {
      // Apply the scroll once the resized svg commits (see the zoom layout effect).
      pendingScroll.current = { left, top };
      setZoom(target);
    }
  }

  // Surroundings swaths (px), drawn in the annotation pad: the street the camp
  // fronts (a wide band, not a thin line), the rear service road, and neighbor
  // lots on either side. Axis-aligned bands (the wedge taper is visually small).
  const gapPx = SURROUND_GAP_FT * ppf;
  const viewL = MARGIN;
  const viewR = VIEW_W - MARGIN;
  const halfMaxPx = (maxWidthFt / 2) * ppf;
  const lotLeftPx = rearCenterX - halfMaxPx;
  const lotRightPx = rearCenterX + halfMaxPx;
  const streetBandBot = originY - gapPx;
  const streetBandTop = Math.max(MARGIN, streetBandBot - STREET_W_FT * ppf);
  const roadBandTop = yBot + gapPx;
  const roadBandBot = Math.min(
    viewH - MARGIN,
    roadBandTop + SERVICE_ROAD_W_FT * ppf,
  );
  // Scheme-aware via CSS (see MAP_SCHEME_CSS) so they don't flash light on the
  // first paint before Mantine's JS resolves the color scheme.
  const pavementFill = MAP_PAVEMENT;
  const neighborFill = MAP_NEIGHBOR;
  const neighbors = [
    { id: "L", x0: viewL, x1: lotLeftPx - gapPx },
    { id: "R", x0: lotRightPx + gapPx, x1: viewR },
  ];
  // Padded bounds (feet) for annotations that may sit outside the lot border.
  const clampPadX = (v: number) => clamp(v, -PAD_FT, lot.frontageFt + PAD_FT);
  const clampPadY = (v: number) => clamp(v, -PAD_FT, lot.depthFt + PAD_FT);
  // Lot outline. When we know the frontage radius, draw the TRUE wedge: the
  // frontage and rear are circular arcs centered on the Man (radius R and R±depth),
  // with straight radial sides — i.e., the actual curve of the BRC street. The
  // front corners stay pinned to (originX/originY ± frontage) so objects, which
  // live on the plot-local grid, don't shift. Falls back to a straight trapezoid
  // when no radius is derivable (innerRadius unset + no street).
  const rFront = frontageRadiusOf(lot);
  const halfFt = lot.frontageFt / 2;
  let lotPoints: string;
  // Curved surroundings (concentric annular sectors centered on the Man) that
  // share the lot wedge's geometry, so the street/service-road/neighbors follow
  // the SAME arc as the lot's front/rear edges instead of being flat bands. Null
  // → no derivable radius, so the straight-trapezoid fallback + rect bands run.
  let surround: {
    street: string;
    streetLabel: { x: number; y: number; angle: number };
    service: string;
    serviceLabel: { x: number; y: number; angle: number };
    neighborL: string;
    neighborR: string;
    neighborLLabel: { x: number; y: number; angle: number };
    neighborRLabel: { x: number; y: number; angle: number };
  } | null = null;
  if (rFront != null && rFront > halfFt) {
    const sDir = lot.frontsToMan ? 1 : -1; // +1: Man above (front at top); −1: below
    const h = ppf * Math.sqrt(rFront * rFront - halfFt * halfFt);
    const manY = originY - sDir * h; // Man on the frontage's perpendicular bisector
    const frontCx = originX + halfFt * ppf;
    const theta = Math.asin(halfFt / rFront); // half-angle subtended by the frontage
    const rRear = lot.frontsToMan
      ? rFront + lot.depthFt
      : Math.max(1, rFront - lot.depthFt);
    const SEG = 24;
    // Point on the circle of feet-radius r at polar angle phi (0 = toward the
    // frontage centerline), as an "x,y" px string; numeric variant for labels.
    const ptXY = (r: number, phi: number) => ({
      x: frontCx + r * ppf * Math.sin(phi),
      y: manY + sDir * r * ppf * Math.cos(phi),
    });
    const pt = (r: number, phi: number) => {
      const p = ptXY(r, phi);
      return `${p.x},${p.y}`;
    };
    const arcPts = (r: number, phi0: number, phi1: number) => {
      const out: string[] = [];
      for (let i = 0; i <= SEG; i++)
        out.push(pt(r, phi0 + ((phi1 - phi0) * i) / SEG));
      return out;
    };
    // Annular sector (rIn..rOut, phi0..phi1) as a closed polygon point list.
    const sector = (rIn: number, rOut: number, phi0: number, phi1: number) =>
      [...arcPts(rOut, phi0, phi1), ...arcPts(rIn, phi1, phi0)].join(" ");

    const front: string[] = [];
    const back: string[] = [];
    for (let i = 0; i <= SEG; i++) {
      const phi = -theta + (2 * theta * i) / SEG;
      front.push(pt(rFront, phi));
      back.push(pt(rRear, phi));
    }
    lotPoints = [...front, ...back.reverse()].join(" ");

    // Radial direction from the frontage into the lot (+1 if the rear is at a
    // larger radius, as for a Man-facing lot; −1 for a mountain-facing lot). The
    // street abuts the frontage edge directly; the service road abuts the rear —
    // no gap (the lot's border IS the curb), matching the neighbors.
    const outward = rRear > rFront ? 1 : -1;
    const streetA = rFront;
    const streetB = rFront - outward * STREET_W_FT;
    const streetIn = Math.max(1, Math.min(streetA, streetB));
    const streetOut = Math.max(streetA, streetB);
    const serviceA = rRear;
    const serviceB = rRear + outward * SERVICE_ROAD_W_FT;
    const serviceIn = Math.max(1, Math.min(serviceA, serviceB));
    const serviceOut = Math.max(serviceA, serviceB);
    const nIn = Math.min(rFront, rRear);
    const nOut = Math.max(rFront, rRear);

    // Angular half-span wide enough that even the innermost band reaches the view
    // edges (larger radii overshoot and are clipped to the viewport).
    const angTo = (r: number, x: number) =>
      Math.asin(clamp((x - frontCx) / (r * ppf), -1, 1));
    const rMin = Math.max(1, Math.min(streetIn, serviceIn, nIn));
    const phiMax = Math.max(
      theta + 0.02,
      Math.abs(angTo(rMin, viewL)),
      Math.abs(angTo(rMin, viewR)),
    );
    const midNbr = (theta + phiMax) / 2;
    const lbl = (r: number, phi: number) => {
      const p = ptXY(r, phi);
      return { x: p.x, y: p.y, angle: (phi * 180) / Math.PI };
    };
    surround = {
      street: sector(streetIn, streetOut, -phiMax, phiMax),
      streetLabel: lbl((streetIn + streetOut) / 2, 0),
      service: sector(serviceIn, serviceOut, -phiMax, phiMax),
      serviceLabel: lbl((serviceIn + serviceOut) / 2, 0),
      neighborL: sector(nIn, nOut, -phiMax, -theta),
      neighborR: sector(nIn, nOut, theta, phiMax),
      neighborLLabel: lbl((nIn + nOut) / 2, -midNbr),
      neighborRLabel: lbl((nIn + nOut) / 2, midNbr),
    };
  } else {
    lotPoints = `${originX},${originY} ${originX + lot.frontageFt * ppf},${originY} ${rearCenterX + (rear / 2) * ppf},${yBot} ${rearCenterX - (rear / 2) * ppf},${yBot}`;
  }
  // The lettered street the camp fronts (override → per-year name → letter).
  const frontageStreet =
    lot.street ??
    (lot.streetLetter && lot.year
      ? streetLabel(lot.year, lot.streetLetter)
      : lot.streetLetter);
  // Shade intensity tracks how strong the sun is (its altitude): faint near
  // sunrise/sunset, darkest around midday. In dark mode the ground is dark, so a
  // dark shadow barely reads — we lighten the ground AND push the shadow darker +
  // more opaque so the shaded area still stands out.
  const sunStrength = Math.sin((Math.max(sun.altitude, 0) * Math.PI) / 180);
  // Scales fully with the sun's strength (no constant floor) so shadows fade to
  // nothing at the sunrise/sunset extremes; dark mode runs darker for contrast.
  const shadeOpacity = (dark ? 0.85 : 0.36) * sunStrength;
  // In dark mode the lot ground is a lighter dark-surface (so a near-black shadow
  // clearly stands out against it); in light mode it stays the default white-ish.
  // Scheme-aware via CSS (see MAP_SCHEME_CSS) to avoid a first-paint white flash.
  const groundFill = MAP_GROUND;
  const shadowFill = dark ? "#000000" : "#1c1c1c";
  // Sun direction in the plot plane (toward the sun), used to offset the dome's
  // spherical-shading highlight toward the sun. Faint near the horizon.
  const toSun =
    mapUpBearing != null
      ? bearingToPlotDelta(sun.azimuth, 1, mapUpBearing)
      : { dx: 0, dy: 0 };
  const domeFx = 0.5 + toSun.dx * 0.32;
  const domeFy = 0.5 + toSun.dy * 0.32;
  const domeShadeOn = mapUpBearing != null && sun.altitude > 0.5;

  // ---- Wind flow field (plot-local feet). Solved when the wind layer is on and
  // the lot is oriented; buildings become solid obstacles the flow goes around.
  const windOn = showWind && mapUpBearing != null;
  const windField = useMemo<FlowField | null>(() => {
    if (!windOn || mapUpBearing == null) return null;
    // Direction the wind travels (a *from* bearing + 180°), in the plot frame.
    const flow = bearingToPlotDelta(windFromBearing + 180, 1, mapUpBearing);
    // Solve over the whole VISIBLE map (the ground-clip rect, converted to feet),
    // so particles can fade in/out at the edges you actually see rather than
    // popping at the lot boundary.
    const x0 = (viewL - originX) / ppf;
    const x1 = (viewR - originX) / ppf;
    const y0 = (MARGIN - originY) / ppf;
    const y1 = (viewH - MARGIN - originY) / ppf;
    const cell = Math.max(2, Math.max(x1 - x0, y1 - y0) / 60);
    // Open canopies (shade cloth) block sun, not wind — so they don't deflect the
    // flow. Solid builds (tents, RVs, containers, …) do.
    const obstacles = objects
      .filter((o) => !kindDef(o.kind).canopyShade)
      .map((o) => {
        const ox = o.x + o.width / 2;
        const oy = o.y + o.height / 2;
        return footprintOffsets(
          o.kind,
          o.width,
          o.height,
          o.rotation,
          o.config,
          o.mirrored,
        ).map((p) => [ox + p.x, oy + p.y] as [number, number]);
      });
    return solveFlow({
      x0,
      y0,
      x1,
      y1,
      cell,
      dir: { x: flow.dx, y: flow.dy },
      speed: windStrength,
      obstacles,
      iters: 40,
    });
  }, [
    windOn,
    mapUpBearing,
    windFromBearing,
    windStrength,
    objects,
    originX,
    originY,
    ppf,
    viewH,
    viewL,
    viewR,
  ]);

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
      // Force the whole footprint inside the lot trapezoid.
      const nx = s.x + (curFx - d.startFx);
      const ny = s.y + (curFy - d.startFy);
      const c = fitCenterInsideLot(
        nx + s.width / 2,
        ny + s.height / 2,
        footprintOffsets(
          s.kind,
          s.width,
          s.height,
          s.rotation,
          s.config,
          s.mirrored,
        ),
        lot.frontageFt,
        lot.depthFt,
        rear,
      );
      return { ...s, x: c.x - s.width / 2, y: c.y - s.height / 2 };
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

  // Persist a whole multi-select group in one request (so the single fetcher
  // doesn't cancel rapid per-object submits).
  function commitGroup(
    items: {
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
    }[],
  ) {
    fetcher.submit(
      {
        intent: "updateObjects",
        items: JSON.stringify(
          items.map((o) => ({
            id: o.id,
            x: round(o.x),
            y: round(o.y),
            width: round(o.width),
            height: round(o.height),
            rotation: Math.round(o.rotation),
          })),
        ),
      },
      { method: "post" },
    );
  }

  // Centroid (plot-local feet) of a set of objects, by their centers.
  function groupCentroid(items: ObjRow[]): ZonePt {
    let sx = 0;
    let sy = 0;
    for (const o of items) {
      sx += o.x + o.width / 2;
      sy += o.y + o.height / 2;
    }
    const n = Math.max(1, items.length);
    return { x: sx / n, y: sy / n };
  }

  // Begin a group rotate (about the selection centroid) from the group handle.
  function startGroupRotate(e: React.PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!canManage) return;
    const items = objects.filter((x) => selectedIds.includes(x.id));
    if (items.length < 2) return;
    const c = groupCentroid(items);
    const p = svgPoint(e);
    groupDrag.current = {
      mode: "rotate",
      startFx: fx(p.x),
      startFy: fy(p.y),
      cx: c.x,
      cy: c.y,
      items: items.map((x) => ({
        id: x.id,
        x: x.x,
        y: x.y,
        rotation: x.rotation,
      })),
    };
    setDragging(true);
  }

  // Expand a set of ids to include every member of any linked block touched, so
  // a "stuck" block always selects + moves as a whole.
  function expandGroups(ids: string[]): string[] {
    const groups = new Set<string>();
    for (const id of ids) {
      const o = objects.find((x) => x.id === id);
      if (o?.groupId) groups.add(o.groupId);
    }
    if (groups.size === 0) return ids;
    const set = new Set(ids);
    for (const o of objects)
      if (o.groupId && groups.has(o.groupId)) set.add(o.id);
    return [...set];
  }

  function startDrag(
    e: React.PointerEvent,
    o: ObjRow,
    mode: DragState["mode"],
  ) {
    // A press always selects (so anyone can open read-only details); it only
    // starts a drag when the viewer may edit this item.
    e.stopPropagation();
    setSelectedZoneId(null);
    setSelectedCableId(null);
    setSelectedRoadId(null);

    // Shift-click toggles this object (or its whole linked block) in the selection.
    if (mode === "move" && e.shiftKey) {
      const grp = expandGroups([o.id]);
      setSelectedIds((prev) =>
        prev.includes(o.id)
          ? prev.filter((id) => !grp.includes(id))
          : Array.from(new Set([...prev, ...grp])),
      );
      setSelectedId(o.id);
      return;
    }

    // The working selection: keep the current multi-selection if this object is in
    // it; otherwise select this object — expanded to its whole linked block.
    let workIds: string[];
    if (selectedIds.length > 1 && selectedIds.includes(o.id)) {
      workIds = selectedIds;
    } else {
      workIds = expandGroups([o.id]);
      setSelectedIds(workIds);
    }
    setSelectedId(o.id);
    if (!editable(o)) return;
    e.preventDefault();
    const p = svgPoint(e);

    // A multi-object working set (an explicit selection or a linked block) moves
    // together (officers only).
    if (workIds.length > 1 && mode === "move" && canManage) {
      const items = objects.filter((x) => workIds.includes(x.id));
      groupDrag.current = {
        mode: "move",
        startFx: fx(p.x),
        startFy: fy(p.y),
        cx: 0,
        cy: 0,
        items: items.map((x) => ({
          id: x.id,
          x: x.x,
          y: x.y,
          rotation: x.rotation,
        })),
      };
      setDragging(true);
      return;
    }

    drag.current = {
      mode,
      id: o.id,
      startFx: fx(p.x),
      startFy: fy(p.y),
      start: o,
    };
    liveObj.current = o;
    setDragging(true);
  }

  // Pointer-down on the bare canvas. Because shade bodies are click-through, a
  // press on an empty part of a shade lands here — hit-test shades (topmost
  // first) and select/drag that shade; otherwise it's a real empty click, so
  // deselect. (Presses on solid objects never reach here — they stop bubbling.)
  function onCanvasDown(e: React.PointerEvent) {
    const p = svgPoint(e);
    const fxp = fx(p.x);
    const fyp = fy(p.y);
    const shade = [...objects]
      .reverse()
      .find((o) => kindDef(o.kind).canopyShade && containsPoint(o, fxp, fyp));
    if (shade) {
      // startDrag selects it (and only drags if this viewer may edit it).
      startDrag(e, shade, "move");
      return;
    }
    // Empty-canvas press: begin a marquee (rubber-band) selection. A plain click
    // (no drag) clears the selection on pointer-up; Shift keeps the existing one
    // and adds the boxed objects.
    setSelectedZoneId(null);
    setSelectedCableId(null);
    setSelectedRoadId(null);
    marquee.current = {
      x0: fxp,
      y0: fyp,
      x1: fxp,
      y1: fyp,
      additive: e.shiftKey,
    };
    setMarqueeRect(null);
    setMarqueeing(true);
  }

  function onMarqueeMove(e: { clientX: number; clientY: number }) {
    const m = marquee.current;
    if (!m) return;
    const p = svgPoint(e);
    m.x1 = fx(p.x);
    m.y1 = fy(p.y);
    setMarqueeRect({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1 });
  }

  function endMarquee() {
    const m = marquee.current;
    marquee.current = null;
    setMarqueeing(false);
    setMarqueeRect(null);
    if (!m) return;
    const dragged = Math.abs(m.x1 - m.x0) > 1 || Math.abs(m.y1 - m.y0) > 1;
    if (!dragged) {
      // A plain click on empty space clears (Shift keeps the current selection).
      if (!m.additive) selectOnly(null);
      return;
    }
    const xLo = Math.min(m.x0, m.x1);
    const xHi = Math.max(m.x0, m.x1);
    const yLo = Math.min(m.y0, m.y1);
    const yHi = Math.max(m.y0, m.y1);
    const boxed = expandGroups(
      objects
        .filter((o) => {
          const cx = o.x + o.width / 2;
          const cy = o.y + o.height / 2;
          return cx >= xLo && cx <= xHi && cy >= yLo && cy <= yHi;
        })
        .map((o) => o.id),
    );
    setSelectedIds((prev) => {
      const ids = m.additive ? Array.from(new Set([...prev, ...boxed])) : boxed;
      setSelectedId(ids[ids.length - 1] ?? null);
      return ids;
    });
  }

  // ---- Zones & cables -----------------------------------------------------
  // Place a power-line vertex: snap to a nearby spider box / generator (exact
  // node center), else round to the 10ft grid. Always clamped to the lot.
  function placeCablePoint(fxp: number, fyp: number): ZonePt {
    const snap = snapToNode(fxp, fyp, objects);
    if (snap.snapped) {
      return { x: clampPadX(snap.x), y: clampPadY(snap.y) };
    }
    return { x: snapGrid(clampPadX(fxp)), y: snapGrid(clampPadY(fyp)) };
  }
  function addDraftPoint(e: React.PointerEvent) {
    const p = svgPoint(e);
    const pt =
      drawMode === "cable"
        ? placeCablePoint(fx(p.x), fy(p.y))
        : {
            x: snapGrid(clampPadX(fx(p.x))),
            y: snapGrid(clampPadY(fy(p.y))),
          };
    setDraftPoints((prev) => [...prev, pt]);
  }
  function cancelDraw() {
    setDrawMode(null);
    setDraftPoints([]);
  }
  function finishZone() {
    if (draftPoints.length < 3) return;
    fetcher.submit(
      {
        intent: "addZone",
        kind: "custom",
        color: "#fa5252",
        points: JSON.stringify(draftPoints),
      },
      { method: "post" },
    );
    setDrawMode(null);
    setDraftPoints([]);
  }
  function finishCable() {
    if (draftPoints.length < 2) return;
    fetcher.submit(
      {
        intent: "addCable",
        kind: cableDraftKind,
        color: cableKindDef(cableDraftKind).color,
        points: JSON.stringify(draftPoints),
      },
      { method: "post" },
    );
    setDrawMode(null);
    setDraftPoints([]);
  }
  function finishRoad() {
    if (draftPoints.length < 2) return;
    fetcher.submit(
      {
        intent: "addRoad",
        kind: roadDraftKind,
        points: JSON.stringify(draftPoints),
      },
      { method: "post" },
    );
    setDrawMode(null);
    setDraftPoints([]);
  }
  function selectZone(id: string) {
    selectOnly(null);
    setSelectedCableId(null);
    setSelectedRoadId(null);
    setSelectedZoneId(id);
  }
  function selectCable(id: string) {
    selectOnly(null);
    setSelectedZoneId(null);
    setSelectedRoadId(null);
    setSelectedCableId(id);
  }
  function selectRoad(id: string) {
    selectOnly(null);
    setSelectedZoneId(null);
    setSelectedCableId(null);
    setSelectedRoadId(id);
  }

  function commitCable(c: CableRow) {
    fetcher.submit(
      {
        intent: "updateCable",
        id: c.id,
        points: JSON.stringify(c.points),
      },
      { method: "post" },
    );
  }
  // Begin dragging an existing vertex of the selected cable.
  function startCableVertexDrag(
    e: React.PointerEvent,
    cable: CableRow,
    index: number,
  ) {
    e.stopPropagation();
    e.preventDefault();
    if (!canManage) return;
    selectCable(cable.id);
    cableDrag.current = { cableId: cable.id, index };
    liveCable.current = cable;
    setCableDragging(true);
  }
  // Insert a new vertex at a segment midpoint, then immediately drag it.
  function startCableInsertDrag(
    e: React.PointerEvent,
    cable: CableRow,
    segIndex: number,
  ) {
    e.stopPropagation();
    e.preventDefault();
    if (!canManage) return;
    const a = cable.points[segIndex];
    const b = cable.points[segIndex + 1];
    if (!a || !b) return;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const points = [
      ...cable.points.slice(0, segIndex + 1),
      mid,
      ...cable.points.slice(segIndex + 1),
    ];
    const next = { ...cable, points };
    selectCable(cable.id);
    cableDrag.current = { cableId: cable.id, index: segIndex + 1 };
    liveCable.current = next;
    setCables((prev) => prev.map((c) => (c.id === cable.id ? next : c)));
    setCableDragging(true);
  }
  function onCableVertexMove(e: { clientX: number; clientY: number }) {
    const d = cableDrag.current;
    const c = liveCable.current;
    if (!d || !c) return;
    const p = svgPoint(e);
    const pt = placeCablePoint(fx(p.x), fy(p.y));
    const points = c.points.map((q, i) => (i === d.index ? pt : q));
    const next = { ...c, points };
    liveCable.current = next;
    setCables((prev) => prev.map((x) => (x.id === d.cableId ? next : x)));
  }
  function endCableDrag() {
    const d = cableDrag.current;
    const c = liveCable.current;
    cableDrag.current = null;
    liveCable.current = null;
    setCableDragging(false);
    if (d && c) commitCable(c);
  }
  // Remove a vertex (keep at least the two endpoints).
  function deleteCableVertex(cable: CableRow, index: number) {
    if (!canManage || cable.points.length <= 2) return;
    const points = cable.points.filter((_, i) => i !== index);
    const next = { ...cable, points };
    setCables((prev) => prev.map((c) => (c.id === cable.id ? next : c)));
    commitCable(next);
  }

  function onMove(e: { clientX: number; clientY: number }) {
    // Group gesture (multi-select move/rotate) takes precedence.
    const g = groupDrag.current;
    if (g) {
      const p = svgPoint(e);
      const curx = fx(p.x);
      const cury = fy(p.y);
      const byId = new Map(objects.map((o) => [o.id, o]));
      const next: NonNullable<typeof liveGroup.current> = [];
      if (g.mode === "move") {
        const dx = curx - g.startFx;
        const dy = cury - g.startFy;
        for (const it of g.items) {
          const o = byId.get(it.id);
          if (!o) continue;
          next.push({
            id: it.id,
            x: it.x + dx,
            y: it.y + dy,
            width: o.width,
            height: o.height,
            rotation: it.rotation,
          });
        }
      } else {
        const a0 = Math.atan2(g.startFy - g.cy, g.startFx - g.cx);
        const a1 = Math.atan2(cury - g.cy, curx - g.cx);
        const rad = a1 - a0;
        const deg = (rad * 180) / Math.PI;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        for (const it of g.items) {
          const o = byId.get(it.id);
          if (!o) continue;
          const ox = it.x + o.width / 2 - g.cx;
          const oy = it.y + o.height / 2 - g.cy;
          const ncx = g.cx + ox * cos - oy * sin;
          const ncy = g.cy + ox * sin + oy * cos;
          next.push({
            id: it.id,
            x: ncx - o.width / 2,
            y: ncy - o.height / 2,
            width: o.width,
            height: o.height,
            rotation: it.rotation + deg,
          });
        }
      }
      liveGroup.current = next;
      const m = new Map(next.map((n) => [n.id, n]));
      setObjects((prev) =>
        prev.map((o) => {
          const n = m.get(o.id);
          return n ? { ...o, x: n.x, y: n.y, rotation: n.rotation } : o;
        }),
      );
      return;
    }
    const d = drag.current;
    if (!d) return;
    const p = svgPoint(e);
    let next = applyDrag(d, fx(p.x), fy(p.y));
    // Snap a dragged shade/canopy to nearby structures' vertices/edges.
    if (d.mode === "move" && snapStructures && kindDef(next.kind).canopyShade) {
      const snapped = snapToStructures(next, objects, 4);
      next = snapped.obj;
      setSnapHint(snapped.hint);
    } else if (snapHint) {
      setSnapHint(null);
    }
    liveObj.current = next;
    setObjects((prev) => prev.map((o) => (o.id === d.id ? next : o)));
  }

  function endDrag() {
    const g = groupDrag.current;
    if (g) {
      const items = liveGroup.current;
      groupDrag.current = null;
      liveGroup.current = null;
      setDragging(false);
      if (items && items.length > 0) commitGroup(items);
      return;
    }
    const d = drag.current;
    const o = liveObj.current;
    drag.current = null;
    liveObj.current = null;
    setDragging(false);
    setSnapHint(null);
    if (d && o) commit(o);
  }

  function addObjectAt(kind: string, fxFeet: number, fyFeet: number) {
    const def = kindDef(kind);
    // Drop point = the object's center; force the whole footprint inside the lot.
    const c = fitCenterInsideLot(
      fxFeet,
      fyFeet,
      footprintOffsets(kind, def.w, def.h, 0),
      lot.frontageFt,
      lot.depthFt,
      rear,
    );
    fetcher.submit(
      {
        intent: "addObject",
        kind,
        x: round(c.x - def.w / 2),
        y: round(c.y - def.h / 2),
        width: def.w,
        height: def.h,
      },
      { method: "post" },
    );
  }

  // Drop a premade block: position every item relative to the (clamped) drop
  // point so the whole cluster lands inside the lot, then persist them together.
  function placeBlock(blockId: string, fxFeet: number, fyFeet: number) {
    const block = blockById(blockId);
    if (!block) return;
    const items = block.items.map((it) => {
      const def = kindDef(it.kind);
      return {
        kind: it.kind,
        dx: it.dx,
        dy: it.dy,
        w: it.w ?? def.w,
        h: it.h ?? def.h,
        rotation: it.rotation ?? 0,
        name: it.name,
      };
    });
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const it of items) {
      minX = Math.min(minX, it.dx - it.w / 2);
      maxX = Math.max(maxX, it.dx + it.w / 2);
      minY = Math.min(minY, it.dy - it.h / 2);
      maxY = Math.max(maxY, it.dy + it.h / 2);
    }
    const c = fitCenterInsideLot(
      fxFeet,
      fyFeet,
      [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
      lot.frontageFt,
      lot.depthFt,
      rear,
    );
    const abs = items.map((it) => ({
      kind: it.kind,
      name: it.name,
      width: it.w,
      height: it.h,
      rotation: it.rotation,
      x: round(c.x + it.dx - it.w / 2),
      y: round(c.y + it.dy - it.h / 2),
    }));
    fetcher.submit(
      { intent: "addBlock", items: JSON.stringify(abs) },
      { method: "post" },
    );
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const p = svgPoint(e);
    // A premade block dropped from the Blocks palette.
    const blockId = e.dataTransfer.getData("application/camptool-block-id");
    if (blockId) {
      placeBlock(blockId, fx(p.x), fy(p.y));
      return;
    }
    // Dropping a declared (unplaced) item from the tray places it here.
    const placeId = e.dataTransfer.getData("application/camptool-place-id");
    if (placeId) {
      const iw = Number(e.dataTransfer.getData("application/camptool-w")) || 10;
      const ih = Number(e.dataTransfer.getData("application/camptool-h")) || 10;
      const c = fitCenterInsideLot(
        fx(p.x),
        fy(p.y),
        [
          { x: -iw / 2, y: -ih / 2 },
          { x: iw / 2, y: -ih / 2 },
          { x: iw / 2, y: ih / 2 },
          { x: -iw / 2, y: ih / 2 },
        ],
        lot.frontageFt,
        lot.depthFt,
        rear,
      );
      fetcher.submit(
        {
          intent: "placeObject",
          id: placeId,
          x: round(c.x - iw / 2),
          y: round(c.y - ih / 2),
        },
        { method: "post" },
      );
      return;
    }
    // Otherwise it's a new kind from the legend.
    const kind =
      e.dataTransfer.getData("application/camptool-kind") ||
      e.dataTransfer.getData("text/plain");
    if (!kind || !isKind(kind)) return;
    addObjectAt(kind, fx(p.x), fy(p.y));
  }

  const clipId = "lot-clip";
  return (
    <Paper
      withBorder
      radius="md"
      p={0}
      style={{
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        width: "100%",
      }}
    >
      {/* Scheme-dependent map fills as CSS vars, resolved before first paint to
      avoid a white flash on dark-mode initial load (see MAP_SCHEME_CSS). */}
      <style>{MAP_SCHEME_CSS}</style>
      {canManage ? (
        <Group
          gap="xs"
          p={6}
          justify="space-between"
          style={{
            borderBottom: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Group gap="xs">
            {drawMode === "cable" ? (
              <>
                <Text size="xs" c="dimmed">
                  Click near nodes to route the line
                  {draftPoints.length >= 2
                    ? ` · ${feetInches(pathLengthFt(draftPoints))}`
                    : ""}
                </Text>
                <Button
                  size="compact-xs"
                  color="yellow"
                  onClick={finishCable}
                  disabled={draftPoints.length < 2}
                >
                  Finish ({draftPoints.length})
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={cancelDraw}
                >
                  Cancel
                </Button>
              </>
            ) : drawMode === "zone" ? (
              <>
                <Text size="xs" c="dimmed">
                  Click to add points · outside the border is OK
                </Text>
                <Button
                  size="compact-xs"
                  onClick={finishZone}
                  disabled={draftPoints.length < 3}
                >
                  Finish ({draftPoints.length})
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={cancelDraw}
                >
                  Cancel
                </Button>
              </>
            ) : drawMode === "road" ? (
              <>
                <Text size="xs" c="dimmed">
                  Click to route the{" "}
                  {roadKindLabel(roadDraftKind).toLowerCase()} centerline ·
                  corners auto-cut back 45°
                  {draftPoints.length >= 2
                    ? ` · ${feetInches(pathLengthFt(draftPoints))}`
                    : ""}
                </Text>
                <Button
                  size="compact-xs"
                  color="gray"
                  onClick={finishRoad}
                  disabled={draftPoints.length < 2}
                >
                  Finish ({draftPoints.length})
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={cancelDraw}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => {
                    setSelectedId(null);
                    setSelectedZoneId(null);
                    setSelectedCableId(null);
                    setSelectedRoadId(null);
                    setDraftPoints([]);
                    setDrawMode("zone");
                  }}
                >
                  + Draw zone
                </Button>
                <Menu shadow="md" position="bottom-start">
                  <Menu.Target>
                    <Button size="compact-xs" variant="light" color="yellow">
                      + Draw line/pipe
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {CABLE_KINDS.map((ck) => (
                      <Menu.Item
                        key={ck.value}
                        onClick={() => {
                          setSelectedId(null);
                          setSelectedZoneId(null);
                          setSelectedCableId(null);
                          setSelectedRoadId(null);
                          setCableDraftKind(ck.value);
                          setDraftPoints([]);
                          setDrawMode("cable");
                        }}
                      >
                        {ck.label}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
                <Menu shadow="md" position="bottom-start">
                  <Menu.Target>
                    <Button size="compact-xs" variant="light" color="gray">
                      + Draw road
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {ROAD_KINDS.map((rk) => (
                      <Menu.Item
                        key={rk.value}
                        onClick={() => {
                          setSelectedId(null);
                          setSelectedZoneId(null);
                          setSelectedCableId(null);
                          setSelectedRoadId(null);
                          setRoadDraftKind(rk.value);
                          setDraftPoints([]);
                          setDrawMode("road");
                        }}
                      >
                        {rk.label} · {rk.width}′
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              </>
            )}
          </Group>
          <Group gap="xs" wrap="nowrap">
            {drawMode !== null || selectedCableId ? (
              <Tooltip label="Snap vertices to grid">
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    Snap
                  </Text>
                  <SegmentedControl
                    size="xs"
                    value={String(gridSnap)}
                    onChange={(v) => setGridSnap(Number(v))}
                    data={SNAP_STEPS.map((s) => ({
                      label: `${s}′`,
                      value: String(s),
                    }))}
                  />
                </Group>
              </Tooltip>
            ) : null}
            <Tooltip label="Snap a dragged shade onto nearby structures">
              <Checkbox
                size="xs"
                label="Snap shades"
                checked={snapStructures}
                onChange={(e) => setSnapStructures(e.currentTarget.checked)}
              />
            </Tooltip>
            <Tooltip label={lotOpen ? "Hide lot settings" : "Lot settings"}>
              <ActionIcon
                variant={lotOpen ? "light" : "subtle"}
                color="gray"
                aria-label="Toggle lot settings"
                aria-expanded={lotOpen}
                onClick={() => setLotOpen(!lotOpen)}
              >
                ⚙
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      ) : null}
      <Box
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Group
          gap={2}
          wrap="nowrap"
          style={{ position: "absolute", top: 8, right: 8, zIndex: 5 }}
        >
          <Tooltip
            label={hasMine ? "Find my spot" : "You have no items placed"}
          >
            <ActionIcon
              variant="default"
              aria-label="Find my spot"
              disabled={!hasMine}
              onClick={focusMine}
            >
              ◎
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Zoom out">
            <ActionIcon
              variant="default"
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_MIN}
              onClick={() => zoomBy(1 / 1.3)}
            >
              −
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Reset zoom (fit)">
            <ActionIcon
              variant="default"
              aria-label="Reset zoom"
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
            >
              ⤢
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Zoom in">
            <ActionIcon
              variant="default"
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_MAX}
              onClick={() => zoomBy(1.3)}
            >
              +
            </ActionIcon>
          </Tooltip>
        </Group>
        <Box ref={frameRef} style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          <svg
            ref={svgRef}
            id="camp-map-svg"
            viewBox={`0 0 ${VIEW_W} ${viewH}`}
            width={renderW}
            height={renderH}
            style={{
              display: "block",
              width: `${renderW}px`,
              height: `${renderH}px`,
              touchAction: "none",
            }}
            onPointerDown={onCanvasDown}
            onDragOver={canManage ? (e) => e.preventDefault() : undefined}
            onDrop={canManage ? onDrop : undefined}
            role="img"
            aria-label="Camp layout"
          >
            <title>Camp layout</title>
            <defs>
              {/* Path-light glow: warm pool of light fading out, for the night sim. */}
              <radialGradient id="path-glow" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="#fff3bf" stopOpacity={0.4} />
                <stop offset="0.4" stopColor="#ffe066" stopOpacity={0.14} />
                <stop offset="1" stopColor="#ffe066" stopOpacity={0} />
              </radialGradient>
              {/* Hypar roof: bright at the high front-right corner (by the door) →
              dark toward the low back-left, matching the per-corner heights. */}
              <linearGradient
                id="hypar-roof"
                x1="1"
                y1="0.9"
                x2="0.05"
                y2="0.25"
              >
                <stop offset="0" stopColor="#ffffff" stopOpacity={0.6} />
                <stop offset="1" stopColor="#000000" stopOpacity={0.38} />
              </linearGradient>
              {/* Hexayurt roof: bright apex at the center → dark at the eaves. */}
              <radialGradient id="hexayurt-roof" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="#ffffff" stopOpacity={0.62} />
                <stop offset="1" stopColor="#000000" stopOpacity={0.32} />
              </radialGradient>
              {/* Geodesic dome: a sphere highlight offset TOWARD the sun (fx,fy),
              fading to a dark far side — so the dome reads as round and the lit
              side tracks the sun. */}
              <radialGradient
                id="dome-sphere"
                cx="0.5"
                cy="0.5"
                r="0.62"
                fx={domeFx}
                fy={domeFy}
              >
                <stop offset="0" stopColor="#ffffff" stopOpacity={0.55} />
                <stop offset="0.45" stopColor="#ffffff" stopOpacity={0} />
                <stop offset="1" stopColor="#000000" stopOpacity={0.5} />
              </radialGradient>
            </defs>
            <clipPath id={clipId}>
              <polygon points={lotPoints} />
            </clipPath>
            {/* Shadows may fall past the lot onto the neighbors / roads, so clip
            them to the whole ground view rather than the lot. */}
            <clipPath id="ground-clip">
              <rect
                x={viewL}
                y={MARGIN}
                width={viewR - viewL}
                height={viewH - 2 * MARGIN}
              />
            </clipPath>
            {/* Ground surface for the lot — a theme-aware fill (lighter than the page
            in both schemes) so cast shadows read against it in dark mode too,
            instead of vanishing on the transparent dark page. */}
            <polygon points={lotPoints} fill={groundFill} />
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
            {/* Surroundings: the street the camp fronts (a wide swath, not a thin
            line), the rear shared service road, and neighbor lots on each side —
            so the lot reads in its real context. The clock address marks the
            radial avenue along the street. */}
            <g pointerEvents="none" clipPath="url(#ground-clip)">
              {surround ? (
                // Curved context: concentric annular sectors that follow the lot
                // wedge's arc (clipped to the view), so the street/service road
                // and neighbor lots match the BRC clock-section curvature.
                <>
                  <polygon
                    points={surround.neighborL}
                    fill={neighborFill}
                    opacity={0.7}
                  />
                  <polygon
                    points={surround.neighborR}
                    fill={neighborFill}
                    opacity={0.7}
                  />
                  <text
                    x={surround.neighborLLabel.x}
                    y={surround.neighborLLabel.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    Neighbor
                  </text>
                  <text
                    x={surround.neighborRLabel.x}
                    y={surround.neighborRLabel.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    Neighbor
                  </text>
                  <polygon points={surround.street} fill={pavementFill} />
                  <text
                    x={surround.streetLabel.x}
                    y={surround.streetLabel.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={14}
                    fontWeight={700}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    {frontageStreet || "Street"}
                    {lot.address ? ` · ${lot.address}` : ""}
                  </text>
                  <polygon points={surround.service} fill={pavementFill} />
                  <text
                    x={surround.serviceLabel.x}
                    y={surround.serviceLabel.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    Service road
                  </text>
                </>
              ) : (
                <>
                  {neighbors.map((n) =>
                    n.x1 - n.x0 > 8 ? (
                      <g key={n.id}>
                        <rect
                          x={n.x0}
                          y={originY}
                          width={n.x1 - n.x0}
                          height={yBot - originY}
                          fill={neighborFill}
                          opacity={0.7}
                          rx={3}
                        />
                        <text
                          x={(n.x0 + n.x1) / 2}
                          y={(originY + yBot) / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={12}
                          fill="var(--mantine-color-dimmed)"
                          style={{ userSelect: "none" }}
                        >
                          Neighbor
                        </text>
                      </g>
                    ) : null,
                  )}
                  <rect
                    x={viewL}
                    y={streetBandTop}
                    width={viewR - viewL}
                    height={streetBandBot - streetBandTop}
                    fill={pavementFill}
                    rx={3}
                  />
                  <text
                    x={(viewL + viewR) / 2}
                    y={(streetBandTop + streetBandBot) / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={14}
                    fontWeight={700}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    {frontageStreet || "Street"}
                    {lot.address ? ` · ${lot.address}` : ""}
                  </text>
                  <rect
                    x={viewL}
                    y={roadBandTop}
                    width={viewR - viewL}
                    height={roadBandBot - roadBandTop}
                    fill={pavementFill}
                    rx={3}
                  />
                  <text
                    x={(viewL + viewR) / 2}
                    y={(roadBandTop + roadBandBot) / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={12}
                    fill="var(--mantine-color-dimmed)"
                    style={{ userSelect: "none" }}
                  >
                    Service road
                  </text>
                </>
              )}
            </g>
            {/* Fire-access overlay (clipped to the lot): green = within 125′ hose
            reach of the street frontage or the rear alley; red = beyond both
            (an internal fire lane would be required). Measured by depth. */}
            {showFire ? (
              <g clipPath={`url(#${clipId})`} pointerEvents="none">
                <rect
                  x={viewL}
                  y={originY}
                  width={viewR - viewL}
                  height={Math.min(FIRE_REACH_FT, lot.depthFt) * ppf}
                  fill="#2f9e44"
                  opacity={0.1}
                />
                {lot.depthFt > FIRE_REACH_FT ? (
                  <rect
                    x={viewL}
                    y={originY + (lot.depthFt - FIRE_REACH_FT) * ppf}
                    width={viewR - viewL}
                    height={FIRE_REACH_FT * ppf}
                    fill="#2f9e44"
                    opacity={0.1}
                  />
                ) : null}
                {lot.depthFt > 2 * FIRE_REACH_FT ? (
                  <rect
                    x={viewL}
                    y={originY + FIRE_REACH_FT * ppf}
                    width={viewR - viewL}
                    height={(lot.depthFt - 2 * FIRE_REACH_FT) * ppf}
                    fill="#e03131"
                    opacity={0.18}
                  />
                ) : null}
                <line
                  x1={viewL}
                  y1={originY + FIRE_REACH_FT * ppf}
                  x2={viewR}
                  y2={originY + FIRE_REACH_FT * ppf}
                  stroke="#e8590c"
                  strokeWidth={1}
                  strokeDasharray="5 4"
                  opacity={0.7}
                />
                {lot.depthFt > FIRE_REACH_FT ? (
                  <line
                    x1={viewL}
                    y1={originY + (lot.depthFt - FIRE_REACH_FT) * ppf}
                    x2={viewR}
                    y2={originY + (lot.depthFt - FIRE_REACH_FT) * ppf}
                    stroke="#e8590c"
                    strokeWidth={1}
                    strokeDasharray="5 4"
                    opacity={0.7}
                  />
                ) : null}
              </g>
            ) : null}
            {/* In-camp roads / lanes: a width band around the centerline with 45°
            corner cutbacks (BM's turn allowance). Ground features drawn under the
            structures + shadows; the dashed centerline shows the route. */}
            {roads.map((r) => {
              if (r.points.length < 2) return null;
              const band = roadOutline(r.points, r.width, r.cutback);
              if (band.length < 3) return null;
              const pts = band
                .map((p) => `${originX + p.x * ppf},${originY + p.y * ppf}`)
                .join(" ");
              const center = r.points
                .map((p) => `${originX + p.x * ppf},${originY + p.y * ppf}`)
                .join(" ");
              const sel = r.id === selectedRoadId;
              return (
                <g key={`road-${r.id}`}>
                  <polygon
                    points={pts}
                    fill={r.color}
                    fillOpacity={sel ? 0.4 : 0.24}
                    stroke={r.color}
                    strokeWidth={sel ? 2 : 1.2}
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      selectRoad(r.id);
                    }}
                  />
                  <polyline
                    points={center}
                    fill="none"
                    stroke={r.color}
                    strokeWidth={1}
                    strokeDasharray="7 6"
                    opacity={0.7}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
            {/* Shade simulation: each object casts a shadow away from the sun,
            clipped to the whole ground view so it can fall onto neighbors/roads.
            Overlaps UNION (OR) at one opacity rather than adding up — the polygons
            are opaque inside a single group whose opacity flattens them, so two
            overlapping shadows look the same as one. */}
            {mapUpBearing != null && sun.altitude > 0.5 ? (
              <g
                clipPath="url(#ground-clip)"
                pointerEvents="none"
                opacity={shadeOpacity}
              >
                {objects.flatMap((o) =>
                  shadowPolygon(o, sun, mapUpBearing).map((poly, i) => (
                    <polygon
                      key={`sh-${o.id}-${i}`}
                      points={poly
                        .map(
                          (p) =>
                            `${originX + p.x * ppf},${originY + p.y * ppf}`,
                        )
                        .join(" ")}
                      fill={shadowFill}
                    />
                  )),
                )}
              </g>
            ) : null}
            {/* Prevailing-wind flow: animated particles streaming around the
            buildings, clipped to the ground view. */}
            {windOn && windField ? (
              <WindLayer
                field={windField}
                originX={originX}
                originY={originY}
                ppf={ppf}
                dark={dark}
                clipId="ground-clip"
                count={windParticles}
              />
            ) : null}
            {/* Zones: labeled regions drawn under the structures. */}
            {zones.map((z) => {
              if (z.points.length < 2) return null;
              const pts = z.points
                .map((p) => `${originX + p.x * ppf},${originY + p.y * ppf}`)
                .join(" ");
              const cxFt =
                z.points.reduce((s, p) => s + p.x, 0) / z.points.length;
              const cyFt =
                z.points.reduce((s, p) => s + p.y, 0) / z.points.length;
              const sel = z.id === selectedZoneId;
              return (
                <g key={z.id}>
                  <polygon
                    points={pts}
                    fill={z.color}
                    fillOpacity={sel ? 0.22 : 0.12}
                    stroke={z.color}
                    strokeWidth={sel ? 2.5 : 1.5}
                    strokeDasharray="6 4"
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      selectZone(z.id);
                    }}
                  />
                  <text
                    x={originX + cxFt * ppf}
                    y={originY + cyFt * ppf}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={15}
                    fontWeight={600}
                    fill={z.color}
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {z.name ?? zoneKindLabel(z.kind)}
                  </text>
                </g>
              );
            })}
            {/* Fuel & battery safety zones. Burning Man requires separation rings
            around fuel storage (10′ no ignition sources, 20′ liquid↔propane, 50′
            to another fuel area) and a minimum safety zone around a ≥100 kWh
            battery bank. Drawn under the object markers, in plot-local feet, so
            they print + export with the map. */}
            {objects.flatMap((o) => {
              const ccx = originX + (o.x + o.width / 2) * ppf;
              const ccy = originY + (o.y + o.height / 2) * ppf;
              const ring = (
                rFt: number,
                color: string,
                label: string,
                key: string,
              ) =>
                rFt > 0 ? (
                  <g key={key} pointerEvents="none">
                    <circle
                      cx={ccx}
                      cy={ccy}
                      r={rFt * ppf}
                      fill="none"
                      stroke={color}
                      strokeOpacity={0.55}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                    <text
                      x={ccx}
                      y={ccy - rFt * ppf + 11}
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={600}
                      fill={color}
                      style={{ userSelect: "none" }}
                    >
                      {label}
                    </text>
                  </g>
                ) : null;
              if (o.kind === "fuel-storage") {
                return [
                  ring(10, "#e8590c", "10′ no ignition", `${o.id}-f10`),
                  ring(20, "#e8590c", "20′ liquid↔propane", `${o.id}-f20`),
                  ring(50, "#e8590c", "50′ to other fuel", `${o.id}-f50`),
                ];
              }
              if (o.kind === "battery" && (o.config.kwh ?? 0) >= 100) {
                return [
                  ring(
                    o.config.safetyFt ?? 20,
                    "#2f9e44",
                    `${Math.round(o.config.safetyFt ?? 20)}′ battery safety zone`,
                    `${o.id}-bat`,
                  ),
                ];
              }
              return [];
            })}
            {/* Canopies (shade/carport/popup/…) render last so they sit over the
            items beneath them. */}
            {[...objects]
              .sort(
                (a, b) =>
                  Number(!!kindDef(a.kind).canopyShade) -
                  Number(!!kindDef(b.kind).canopyShade),
              )
              .map((o) => (
                <MapObjectShape
                  key={o.id}
                  o={o}
                  originX={originX}
                  originY={originY}
                  ppf={ppf}
                  selected={selectedIds.includes(o.id)}
                  soleSelected={
                    selectedIds.length === 1 && selectedIds[0] === o.id
                  }
                  editable={editable(o)}
                  resizable={resizable(o)}
                  dim={highlight !== "none" && !matches(o)}
                  showDoors={showDoors}
                  overflow={objectOverflowsLot(
                    o,
                    lot.frontageFt,
                    lot.depthFt,
                    rear,
                  )}
                  night={isNight}
                  onBodyDown={(e) => startDrag(e, o, "move")}
                  onResizeDown={(e) => startDrag(e, o, "resize")}
                  onRotateDown={(e) => startDrag(e, o, "rotate")}
                />
              ))}
            {/* Flag any placed object whose kind is disallowed this year (banned
            after it was placed): a small amber "!" badge so an officer can resolve
            it, rather than silently deleting the object. */}
            {bannedKinds.length > 0
              ? objects
                  .filter((o) => bannedKinds.includes(o.kind))
                  .map((o) => {
                    const bx = originX + (o.x + o.width / 2) * ppf;
                    const by = originY + o.y * ppf;
                    return (
                      <g key={`ban-${o.id}`} pointerEvents="none">
                        <title>{`${kindDef(o.kind).label} isn't allowed this year`}</title>
                        <circle
                          cx={bx}
                          cy={by}
                          r={7}
                          fill="#e8590c"
                          stroke="#fff"
                          strokeWidth={1.5}
                        />
                        <text
                          x={bx}
                          y={by}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={10}
                          fontWeight={800}
                          fill="#fff"
                        >
                          !
                        </text>
                      </g>
                    );
                  })
              : null}
            {/* Self-shading: tint the faces of a 3D structure that are turned away
            from the sun (its shady/lee side), drawn over the structure. Only kinds
            that declare `shadedFaces` (e.g. the Sierpinski pyramid) participate. */}
            {mapUpBearing != null && sun.altitude > 0.5
              ? objects.flatMap((o) => {
                  const def = kindDef(o.kind);
                  const sd = sunDirLocal(o, sun, mapUpBearing);
                  if (!sd) return [];
                  // Mirror reflects the structure about its vertical axis; that's
                  // equivalent to lighting it with an x-reflected sun and drawing
                  // each face at its mirrored position (see toPx).
                  const lit = o.mirrored ? { ...sd, x: -sd.x } : sd;
                  // A camp-theme structure supplies its own faces; otherwise core
                  // handles facet-roofed core kinds (the hexayurt).
                  const faces = def.shadedFaces
                    ? def.shadedFaces(o.width, o.height, lit)
                    : coreShadedFaces(
                        o.kind,
                        o.width,
                        o.height,
                        lit,
                        o.tallFt || kindHeight(o.kind),
                      );
                  if (!faces.length) return [];
                  const cx = o.x + o.width / 2;
                  const cy = o.y + o.height / 2;
                  const toPx = (p: { x: number; y: number }) => {
                    const lx = o.mirrored
                      ? o.width / 2 - p.x
                      : p.x - o.width / 2;
                    const v = rotateVec(lx, p.y - o.height / 2, o.rotation);
                    return `${originX + (cx + v.x) * ppf},${originY + (cy + v.y) * ppf}`;
                  };
                  return faces.map((face, i) => (
                    <polygon
                      key={`sf-${o.id}-${i}`}
                      points={face.points.map(toPx).join(" ")}
                      fill="#1c1c1c"
                      fillOpacity={face.shade}
                      pointerEvents="none"
                    />
                  ));
                })
              : null}
            {/* Geodesic domes: a spherical shading overlay whose lit side tracks
            the sun, so a dome reads as a 3D sphere. */}
            {domeShadeOn
              ? objects.flatMap((o) =>
                  kindDef(o.kind).shape === "dome"
                    ? [
                        <ellipse
                          key={`sphere-${o.id}`}
                          cx={originX + (o.x + o.width / 2) * ppf}
                          cy={originY + (o.y + o.height / 2) * ppf}
                          rx={(o.width / 2) * ppf}
                          ry={(o.height / 2) * ppf}
                          fill="url(#dome-sphere)"
                          pointerEvents="none"
                        />,
                      ]
                    : [],
                )
              : null}
            {/* Power lines: open polylines drawn over the structures (a planning
            overlay), each labeled with its total run length. */}
            {cables.map((c) => {
              if (c.points.length < 2) return null;
              const pts = c.points
                .map((p) => `${originX + p.x * ppf},${originY + p.y * ppf}`)
                .join(" ");
              const mid =
                c.points[Math.floor((c.points.length - 1) / 2)] ?? c.points[0];
              if (!mid) return null;
              const ends = [c.points[0], c.points[c.points.length - 1]].filter(
                (p): p is ZonePt => p != null,
              );
              const sel = c.id === selectedCableId;
              const lenFt = pathLengthFt(c.points);
              return (
                <g key={c.id}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={c.color}
                    strokeWidth={sel ? 4 : 2.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      selectCable(c.id);
                    }}
                  />
                  {/* Endpoint dots mark the connected nodes. */}
                  {ends.map((p, i) => (
                    <circle
                      key={`${c.id}-end-${i}`}
                      cx={originX + p.x * ppf}
                      cy={originY + p.y * ppf}
                      r={sel ? 4 : 3}
                      fill={c.color}
                      stroke="#fff"
                      strokeWidth={1}
                      pointerEvents="none"
                    />
                  ))}
                  <text
                    x={originX + mid.x * ppf}
                    y={originY + mid.y * ppf - 6}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={14}
                    fontWeight={600}
                    fill={c.color}
                    stroke="#fff"
                    strokeWidth={2.5}
                    paintOrder="stroke"
                    style={{ pointerEvents: "none", userSelect: "none" }}
                  >
                    {c.name ? `${c.name} · ` : ""}
                    {feetInches(lenFt)}
                    {c.amps ? ` · ${c.amps}A` : ""}
                  </text>
                  {/* Edit handles on the selected cable: midpoint "+" adds a point,
                  vertex handles drag (snapping to nodes); double-click removes. */}
                  {sel && canManage && drawMode === null ? (
                    <>
                      {c.points.slice(0, -1).map((p, i) => {
                        const q = c.points[i + 1];
                        if (!q) return null;
                        return (
                          <circle
                            key={`${c.id}-add-${i}`}
                            cx={originX + ((p.x + q.x) / 2) * ppf}
                            cy={originY + ((p.y + q.y) / 2) * ppf}
                            r={4}
                            fill="#fff"
                            stroke={c.color}
                            strokeWidth={1.5}
                            strokeDasharray="2 2"
                            style={{ cursor: "copy" }}
                            onPointerDown={(e) => startCableInsertDrag(e, c, i)}
                          >
                            <title>Drag to add a point</title>
                          </circle>
                        );
                      })}
                      {c.points.map((p, i) => (
                        <circle
                          key={`${c.id}-vtx-${i}`}
                          cx={originX + p.x * ppf}
                          cy={originY + p.y * ppf}
                          r={5}
                          fill="#fff"
                          stroke={c.color}
                          strokeWidth={2.5}
                          style={{ cursor: "grab" }}
                          onPointerDown={(e) => startCableVertexDrag(e, c, i)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            deleteCableVertex(c, i);
                          }}
                        >
                          <title>
                            Drag to move (snaps to power nodes) · double-click
                            to remove
                          </title>
                        </circle>
                      ))}
                    </>
                  ) : null}
                </g>
              );
            })}
            {/* Night-lighting sim: a dusk→night wash over the whole map, then path
            lights glow warmly on top of it (and the pyramid's apex rainbow, drawn
            inside the structure, shows through). */}
            {isNight ? (
              <>
                <rect
                  x={0}
                  y={0}
                  width={VIEW_W}
                  height={viewH}
                  fill="#0a1230"
                  opacity={nightFactor * 0.6}
                  pointerEvents="none"
                />
                {objects
                  .filter((o) => o.kind === "path-light")
                  .map((o) => {
                    const gx = originX + (o.x + o.width / 2) * ppf;
                    const gy = originY + (o.y + o.height / 2) * ppf;
                    const rad = Math.max(7, 4 * ppf); // ~4ft dim pool
                    return (
                      <g key={`glow-${o.id}`} pointerEvents="none">
                        <circle
                          cx={gx}
                          cy={gy}
                          r={rad}
                          fill="url(#path-glow)"
                          opacity={nightFactor * 0.65}
                        />
                        <circle
                          cx={gx}
                          cy={gy}
                          r={1.4}
                          fill="#fff9db"
                          opacity={0.8}
                        />
                      </g>
                    );
                  })}
              </>
            ) : null}
            {/* Linked blocks: a faint dashed hull around each set of "stuck"
            objects, so the blocks read even when nothing is selected. */}
            {(() => {
              const groups = new Map<string, ObjRow[]>();
              for (const o of objects) {
                if (!o.groupId) continue;
                const arr = groups.get(o.groupId);
                if (arr) arr.push(o);
                else groups.set(o.groupId, [o]);
              }
              const out = [];
              for (const [gid, members] of groups) {
                if (members.length < 2) continue;
                let xLo = Number.POSITIVE_INFINITY;
                let xHi = Number.NEGATIVE_INFINITY;
                let yLo = Number.POSITIVE_INFINITY;
                let yHi = Number.NEGATIVE_INFINITY;
                for (const o of members) {
                  for (const p of objWorldCorners(
                    o,
                    o.x + o.width / 2,
                    o.y + o.height / 2,
                  )) {
                    if (p.x < xLo) xLo = p.x;
                    if (p.x > xHi) xHi = p.x;
                    if (p.y < yLo) yLo = p.y;
                    if (p.y > yHi) yHi = p.y;
                  }
                }
                const pad = 1.5;
                out.push(
                  <rect
                    key={`grp-${gid}`}
                    x={originX + (xLo - pad) * ppf}
                    y={originY + (yLo - pad) * ppf}
                    width={(xHi - xLo + 2 * pad) * ppf}
                    height={(yHi - yLo + 2 * pad) * ppf}
                    rx={6}
                    fill="none"
                    stroke="#7048e8"
                    strokeOpacity={0.5}
                    strokeWidth={1}
                    strokeDasharray="2 4"
                    pointerEvents="none"
                  />,
                );
              }
              return out;
            })()}
            {/* Multi-select group box + a single rotate handle (rotates the whole
            selection about its centroid). Per-object handles are hidden while >1
            is selected (see soleSelected). */}
            {selectedIds.length > 1
              ? (() => {
                  const sel = objects.filter((o) => selectedIds.includes(o.id));
                  if (sel.length < 2) return null;
                  let xLo = Number.POSITIVE_INFINITY;
                  let xHi = Number.NEGATIVE_INFINITY;
                  let yLo = Number.POSITIVE_INFINITY;
                  let yHi = Number.NEGATIVE_INFINITY;
                  for (const o of sel) {
                    for (const p of objWorldCorners(
                      o,
                      o.x + o.width / 2,
                      o.y + o.height / 2,
                    )) {
                      if (p.x < xLo) xLo = p.x;
                      if (p.x > xHi) xHi = p.x;
                      if (p.y < yLo) yLo = p.y;
                      if (p.y > yHi) yHi = p.y;
                    }
                  }
                  const bx = originX + xLo * ppf;
                  const by = originY + yLo * ppf;
                  const bw = (xHi - xLo) * ppf;
                  const bh = (yHi - yLo) * ppf;
                  const hx = bx + bw / 2;
                  return (
                    <g>
                      <rect
                        x={bx}
                        y={by}
                        width={bw}
                        height={bh}
                        fill="none"
                        stroke="#1971c2"
                        strokeWidth={1.5}
                        strokeDasharray="6 4"
                        pointerEvents="none"
                      />
                      {canManage ? (
                        <>
                          <line
                            x1={hx}
                            y1={by}
                            x2={hx}
                            y2={by - 22}
                            stroke="#1971c2"
                            strokeWidth={1}
                            pointerEvents="none"
                          />
                          <circle
                            cx={hx}
                            cy={by - 22}
                            r={6}
                            fill="#fff"
                            stroke="#1971c2"
                            strokeWidth={1.5}
                            style={{ cursor: "grab" }}
                            onPointerDown={startGroupRotate}
                          />
                        </>
                      ) : null}
                    </g>
                  );
                })()
              : null}
            {/* Marquee (rubber-band) selection box. */}
            {marqueeRect ? (
              <rect
                x={originX + Math.min(marqueeRect.x0, marqueeRect.x1) * ppf}
                y={originY + Math.min(marqueeRect.y0, marqueeRect.y1) * ppf}
                width={Math.abs(marqueeRect.x1 - marqueeRect.x0) * ppf}
                height={Math.abs(marqueeRect.y1 - marqueeRect.y0) * ppf}
                fill="#1971c2"
                fillOpacity={0.1}
                stroke="#1971c2"
                strokeWidth={1}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            ) : null}
            {/* Shade-snap hint: a ring on the structure vertex/edge the dragged
            shade is snapping to. */}
            {snapHint ? (
              <g pointerEvents="none">
                <circle
                  cx={originX + snapHint.x * ppf}
                  cy={originY + snapHint.y * ppf}
                  r={6}
                  fill="none"
                  stroke="#2f9e44"
                  strokeWidth={2}
                />
                <circle
                  cx={originX + snapHint.x * ppf}
                  cy={originY + snapHint.y * ppf}
                  r={2}
                  fill="#2f9e44"
                />
              </g>
            ) : null}
            {/* Draw mode: a full overlay captures every click as a vertex. */}
            {drawMode ? (
              <>
                <rect
                  x={0}
                  y={0}
                  width={VIEW_W}
                  height={viewH}
                  fill="transparent"
                  style={{ cursor: "crosshair" }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    addDraftPoint(e);
                  }}
                />
                {/* Road draft: preview the width band with its 45° corner cutbacks
                so the officer sees the real footprint as they route it. */}
                {drawMode === "road" && draftPoints.length > 1
                  ? (() => {
                      const rk = roadKindDef(roadDraftKind);
                      const band = roadOutline(
                        draftPoints,
                        rk.width,
                        DEFAULT_ROAD_CUTBACK,
                      );
                      if (band.length < 3) return null;
                      return (
                        <polygon
                          points={band
                            .map(
                              (p) =>
                                `${originX + p.x * ppf},${originY + p.y * ppf}`,
                            )
                            .join(" ")}
                          fill={rk.color}
                          fillOpacity={0.18}
                          stroke={rk.color}
                          strokeWidth={1}
                          pointerEvents="none"
                        />
                      );
                    })()
                  : null}
                {draftPoints.length > 1 ? (
                  <polyline
                    points={draftPoints
                      .map(
                        (p) => `${originX + p.x * ppf},${originY + p.y * ppf}`,
                      )
                      .join(" ")}
                    fill={
                      drawMode === "cable" || drawMode === "road"
                        ? "none"
                        : "#fa5252"
                    }
                    fillOpacity={0.1}
                    stroke={
                      drawMode === "cable"
                        ? "#fab005"
                        : drawMode === "road"
                          ? "#495057"
                          : "#fa5252"
                    }
                    strokeWidth={drawMode === "cable" ? 2.5 : 2}
                    strokeDasharray="4 3"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                ) : null}
                {draftPoints.map((p, i) => (
                  <circle
                    key={`${p.x}-${p.y}-${i}`}
                    cx={originX + p.x * ppf}
                    cy={originY + p.y * ppf}
                    r={3}
                    fill={
                      drawMode === "cable"
                        ? "#fab005"
                        : drawMode === "road"
                          ? "#495057"
                          : "#fa5252"
                    }
                    pointerEvents="none"
                  />
                ))}
              </>
            ) : null}
            {/* Doneness watermark (officer-set): a big translucent diagonal label
            so a viewer instantly reads the map's status. Drawn last (on top) but
            click-through, and repeated top/center/bottom so it reads even when the
            middle is busy. Part of the SVG so it prints AND exports. */}
            {mapStatus ? (
              <g pointerEvents="none">
                {[0.22, 0.5, 0.78].map((fy) => (
                  <text
                    key={fy}
                    x={VIEW_W / 2}
                    y={viewH * fy}
                    transform={`rotate(-28 ${VIEW_W / 2} ${viewH * fy})`}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={Math.max(28, Math.min(VIEW_W, viewH) * 0.11)}
                    fontWeight={800}
                    fill="#e03131"
                    fillOpacity={0.14}
                    stroke="#e03131"
                    strokeOpacity={0.1}
                    strokeWidth={1}
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      userSelect: "none",
                    }}
                  >
                    {mapStatus}
                  </text>
                ))}
              </g>
            ) : null}
          </svg>
        </Box>
      </Box>
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

/** Standalone compass widget (its own SVG) so it never overlaps the map. Carries
 * the draggable sun that scrubs time of day for the shade simulation. */
function Compass({
  mapUpBearing,
  frontsToMan,
  sun,
  year,
  arc,
  timeMin,
  setTimeMin,
  setSunDragging,
  animateShade,
  setAnimateShade,
  windFromBearing,
  setWindFromBearing,
  windStrength,
  setWindStrength,
  windParticles,
  setWindParticles,
  resetWind,
}: {
  mapUpBearing: number | null;
  frontsToMan: boolean;
  sun: { altitude: number; azimuth: number };
  year: number;
  arc: { sunriseMin: number; sunsetMin: number; noonMin: number };
  timeMin: number;
  setTimeMin: (n: number) => void;
  setSunDragging: (v: boolean) => void;
  animateShade: boolean;
  setAnimateShade: (v: boolean) => void;
  windFromBearing: number;
  setWindFromBearing: (n: number) => void;
  windStrength: number;
  setWindStrength: (n: number) => void;
  windParticles: number;
  setWindParticles: (n: number) => void;
  resetWind: () => void;
}) {
  const S = 168;
  const cx = S / 2;
  const cy = S / 2 + 4;
  const r = 60;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [draggingSun, setDraggingSun] = useState(false);
  const [draggingWind, setDraggingWind] = useState(false);
  const oriented = mapUpBearing != null;
  // Wind speed maps to the wind handle's distance from the dial center.
  const WIND_MIN = 0.4;
  const WIND_MAX = 2;
  // Particle count is picked from a few discrete levels rather than a slider.
  const WIND_OFF = { label: "Off", count: 0 };
  const WIND_LEVELS: { label: string; count: number }[] = [
    WIND_OFF,
    { label: "Low", count: 100 },
    { label: "Med", count: 250 },
    { label: "High", count: 400 },
  ];
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
          fontSize={12}
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

  // Pointer → compass bearing (inverse of vec) + distance from center (dial units).
  function pointerPolar(
    clientX: number,
    clientY: number,
  ): { bearing: number; dist: number } {
    const svg = svgRef.current;
    if (!svg) return { bearing: 0, dist: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) * S) / rect.width - cx;
    const y = ((clientY - rect.top) * S) / rect.height - cy;
    const theta = (Math.atan2(x, -y) * 180) / Math.PI;
    return {
      bearing: (((theta + (mapUpBearing ?? 0)) % 360) + 360) % 360,
      dist: Math.hypot(x, y),
    };
  }
  function bearingFromPointer(clientX: number, clientY: number): number {
    return pointerPolar(clientX, clientY).bearing;
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: setters/arc/year are stable enough
  useEffect(() => {
    if (!draggingSun) return;
    const move = (e: PointerEvent) => {
      const b = bearingFromPointer(e.clientX, e.clientY);
      setTimeMin(minuteForAzimuth(year, b));
    };
    const up = () => {
      setDraggingSun(false);
      setSunDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [draggingSun]);

  // Wind handle drag: angle sets the *from* bearing, distance from center sets
  // the strength (clamped to [WIND_MIN, WIND_MAX]).
  // biome-ignore lint/correctness/useExhaustiveDependencies: setters are stable
  useEffect(() => {
    if (!draggingWind) return;
    const move = (e: PointerEvent) => {
      const { bearing, dist } = pointerPolar(e.clientX, e.clientY);
      setWindFromBearing(Math.round(bearing));
      setWindStrength(clamp((dist / r) * WIND_MAX, WIND_MIN, WIND_MAX));
    };
    const up = () => setDraggingWind(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [draggingWind]);

  // Daylight wedge from the real sunrise/sunset azimuths.
  const riseAz = sunAt(year, arc.sunriseMin).azimuth;
  const setAz = sunAt(year, arc.sunsetMin).azimuth;
  const dr = vec(riseAz);
  const ds = vec(setAz);
  const daylight = `M ${cx} ${cy} L ${cx + dr.x * r} ${cy + dr.y * r} A ${r} ${r} 0 1 1 ${cx + ds.x * r} ${cy + ds.y * r} Z`;
  const su = vec(sun.azimuth);
  const sx = cx + su.x * (r - 6);
  const sy = cy + su.y * (r - 6);
  // Wind handle: at the *from* direction, distance from center ∝ strength. The
  // arrow points downstream (the way the wind blows). Drag it to aim + speed up.
  const windOn = windParticles > 0;
  const wFrom = vec(windFromBearing);
  const wRad = clamp((windStrength / WIND_MAX) * r, 12, r);
  const whx = cx + wFrom.x * wRad; // handle (upstream)
  const why = cy + wFrom.y * wRad;
  const wtx = cx - wFrom.x * wRad; // downstream tip
  const wty = cy - wFrom.y * wRad;
  const wAng = Math.atan2(wty - why, wtx - whx);
  const wHead = (d: number) => ({
    x: wtx - Math.cos(wAng - d) * 9,
    y: wty - Math.sin(wAng - d) * 9,
  });
  const wh1 = wHead(0.5);
  const wh2 = wHead(-0.5);
  const windColor = windOn ? "#1971c2" : "var(--mantine-color-dimmed)";
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={4}>
        Orientation
      </Text>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${S} ${S}`}
        style={{
          width: "100%",
          maxWidth: 190,
          height: "auto",
          display: "block",
          touchAction: "none",
        }}
        role="img"
        aria-label="Compass"
      >
        <title>Compass</title>
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="var(--mantine-color-default)"
          stroke="var(--mantine-color-default-border)"
        />
        {oriented ? (
          <path d={daylight} fill="#ffe066" fillOpacity={0.4} stroke="none" />
        ) : null}
        {/* The Man sits where it really is relative to the map's "up": at the
        top for a Man-facing lot, at the bottom for a mountain-facing one (whose
        frontage — and the map's up — points away from the Man). */}
        <line
          x1={cx}
          y1={cy}
          x2={cx}
          y2={cy + (frontsToMan ? -1 : 1) * (r - 20)}
          stroke="var(--mantine-color-text)"
        />
        <ManGlyph x={cx} y={cy + (frontsToMan ? -1 : 1) * (r - 12)} size={22} />
        {oriented ? (
          <>
            {ray(0, "#e03131", "N", { lw: 2, weight: 700 })}
            {ray(90, "var(--mantine-color-dimmed)", "E", { lw: 0.6 })}
            {ray(180, "var(--mantine-color-dimmed)", "S", { lw: 0.6 })}
            {ray(270, "var(--mantine-color-dimmed)", "W", { lw: 0.6 })}
          </>
        ) : null}
        {oriented ? (
          <g
            style={{ cursor: "grab" }}
            onPointerDown={(e) => {
              e.preventDefault();
              setDraggingSun(true);
              setSunDragging(true);
            }}
          >
            <line
              x1={cx}
              y1={cy}
              x2={sx}
              y2={sy}
              stroke="#f59f00"
              strokeWidth={1.5}
              strokeOpacity={0.6}
            />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
              const a = (deg * Math.PI) / 180;
              return (
                <line
                  key={deg}
                  x1={sx + Math.cos(a) * 8}
                  y1={sy + Math.sin(a) * 8}
                  x2={sx + Math.cos(a) * 12}
                  y2={sy + Math.sin(a) * 12}
                  stroke="#f08c00"
                  strokeWidth={1.5}
                />
              );
            })}
            <circle
              cx={sx}
              cy={sy}
              r={7}
              fill="#ffd43b"
              stroke="#f08c00"
              strokeWidth={1.5}
            />
          </g>
        ) : null}
        {oriented ? (
          // Wind: arrow points the way the wind blows; grab the round handle
          // (upstream) to aim, drag toward/away from center to change strength.
          <g
            style={{ cursor: "grab" }}
            onPointerDown={(e) => {
              e.preventDefault();
              setDraggingWind(true);
            }}
            opacity={windOn ? 1 : 0.55}
          >
            <line
              x1={whx}
              y1={why}
              x2={wtx}
              y2={wty}
              stroke={windColor}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <polygon
              points={`${wtx},${wty} ${wh1.x},${wh1.y} ${wh2.x},${wh2.y}`}
              fill={windColor}
            />
            <circle
              cx={whx}
              cy={why}
              r={5.5}
              fill={windOn ? "#74c0fc" : "var(--mantine-color-default)"}
              stroke={windColor}
              strokeWidth={1.5}
            />
          </g>
        ) : null}
      </svg>
      {oriented ? (
        <>
          <Switch
            size="xs"
            mt={8}
            checked={animateShade}
            onChange={(e) => setAnimateShade(e.currentTarget.checked)}
            label="Animate sun"
          />
          <Text size="xs" c="dimmed" mt={4}>
            {formatClock(timeMin)} ·{" "}
            {sun.altitude > 0
              ? `sun ${Math.round(sun.altitude)}° up`
              : "night — lights on"}{" "}
            · drag the sun around the dial
          </Text>
          <Group justify="space-between" align="center" mt={10} mb={2}>
            <Text size="xs" fw={600}>
              Prevailing wind
            </Text>
            <Button
              variant="subtle"
              size="compact-xs"
              onClick={resetWind}
              disabled={
                windFromBearing === BRC_WIND_FROM_BEARING && windStrength === 1
              }
            >
              Reset
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mb={4}>
            {windOn
              ? `${windParticles} particles · from ${Math.round(windFromBearing)}°`
              : "Off — pick a level to show the flow"}
          </Text>
          <SegmentedControl
            size="xs"
            fullWidth
            value={
              (WIND_LEVELS.find((l) => l.count === windParticles) ?? WIND_OFF)
                .label
            }
            onChange={(label) =>
              setWindParticles(
                (WIND_LEVELS.find((l) => l.label === label) ?? WIND_OFF).count,
              )
            }
            data={WIND_LEVELS.map((l) => l.label)}
          />
        </>
      ) : (
        <Text size="xs" c="dimmed" mt={4}>
          Set the lot address (e.g. 3:00) for true north & sun.
        </Text>
      )}
    </Paper>
  );
}

const WIND_SPEED_FT_S = 26; // visual feet/sec per unit wind speed

// Each particle is a head dot plus a short trail of `WIND_TRAIL` fading dots at
// its recent positions (head brightest/largest, tail faint/small) — a soft "dot
// with a fading tail" rather than a hard vector.
const WIND_TRAIL = 6;
const WIND_DOT_R = (k: number) => 2.2 * (1 - k * 0.12); // radius per trail index
const WIND_DOT_FADE = (k: number) => 1 - k / WIND_TRAIL; // opacity ramp per index

/** Animated prevailing-wind layer: a fixed pool of particles advected through the
 * flow field, each drawn as a head dot with a fading trail. Animation runs
 * imperatively in a requestAnimationFrame loop (mutating SVG attributes via refs)
 * so it never re-renders React; it reads the latest field/transform through a
 * ref, so moving a building updates the flow without restarting the animation.
 * Drawn inside the map SVG, so it inherits the viewBox zoom/pan transform. */
function WindLayer({
  field,
  originX,
  originY,
  ppf,
  dark,
  clipId,
  count,
}: {
  field: FlowField;
  originX: number;
  originY: number;
  ppf: number;
  dark: boolean;
  clipId: string;
  count: number;
}) {
  const color = dark ? "#a5d8ff" : "#1971c2";
  // Latest props for the rAF loop (which doesn't depend on them, so it persists).
  const stateRef = useRef({ field, originX, originY, ppf });
  stateRef.current = { field, originX, originY, ppf };
  // One ref per trail dot: index = particle*WIND_TRAIL + trailPosition.
  const dotRefs = useRef<Array<SVGCircleElement | null>>([]);

  useEffect(() => {
    // hx/hy = recent feet positions (0 = head, newest). age/life drive fade in/out.
    type P = {
      fx: number;
      fy: number;
      age: number;
      life: number;
      hx: number[];
      hy: number[];
    };
    const parts: P[] = Array.from({ length: count }, () => ({
      fx: 0,
      fy: 0,
      age: 0,
      life: 0,
      hx: new Array(WIND_TRAIL).fill(0),
      hy: new Array(WIND_TRAIL).fill(0),
    }));
    const bounds = () => {
      const f = stateRef.current.field;
      return {
        x0: f.x0,
        y0: f.y0,
        x1: f.x0 + (f.nx - 1) * f.cell,
        y1: f.y0 + (f.ny - 1) * f.cell,
      };
    };
    const respawn = (p: P, fresh: boolean) => {
      const f = stateRef.current.field;
      const b = bounds();
      for (let t = 0; t < 8; t++) {
        const fx = b.x0 + Math.random() * (b.x1 - b.x0);
        const fy = b.y0 + Math.random() * (b.y1 - b.y0);
        if (!sampleFlow(f, fx, fy).solid) {
          p.fx = fx;
          p.fy = fy;
          p.age = 0;
          p.life = (fresh ? Math.random() : 1) * 2.5 + 0.8;
          p.hx.fill(fx); // collapse the trail onto the spawn point (no streak)
          p.hy.fill(fy);
          return;
        }
      }
      p.life = 0.0001;
    };
    for (const p of parts) respawn(p, true);

    let raf = 0;
    let last = 0;
    const step = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
      last = t;
      const { field: f, originX: ox, originY: oy, ppf: pf } = stateRef.current;
      const b = bounds();
      // Fade band (feet) near the domain edges, so particles ease out as they
      // reach the edge of the visible map instead of vanishing abruptly.
      const margin = Math.max(
        f.cell * 4,
        Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.07,
      );
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p) continue;
        p.life -= dt;
        p.age += dt;
        const s = sampleFlow(f, p.fx, p.fy);
        const spd = Math.hypot(s.x, s.y);
        const out = p.fx < b.x0 || p.fx > b.x1 || p.fy < b.y0 || p.fy > b.y1;
        if (p.life <= 0 || s.solid || out) {
          respawn(p, false);
        } else {
          // Shift the trail history back one slot, record the new head.
          for (let k = WIND_TRAIL - 1; k > 0; k--) {
            p.hx[k] = p.hx[k - 1] ?? p.fx;
            p.hy[k] = p.hy[k - 1] ?? p.fy;
          }
          p.hx[0] = p.fx;
          p.hy[0] = p.fy;
          p.fx += s.x * dt * WIND_SPEED_FT_S;
          p.fy += s.y * dt * WIND_SPEED_FT_S;
        }
        const edge = clamp(
          Math.min(p.fx - b.x0, b.x1 - p.fx, p.fy - b.y0, b.y1 - p.fy) / margin,
          0,
          1,
        );
        // Envelope: fade in on birth, fade out near death + near the edges.
        const op =
          clamp(0.15 + spd * 0.5, 0, 0.85) *
          Math.min(1, p.age * 3) *
          Math.min(1, p.life * 2) *
          edge;
        for (let k = 0; k < WIND_TRAIL; k++) {
          const dot = dotRefs.current[i * WIND_TRAIL + k];
          if (!dot) continue;
          dot.setAttribute("cx", String(ox + (p.hx[k] ?? p.fx) * pf));
          dot.setAttribute("cy", String(oy + (p.hy[k] ?? p.fy) * pf));
          dot.setAttribute("opacity", String(op * WIND_DOT_FADE(k)));
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [count]);

  return (
    <g clipPath={`url(#${clipId})`} pointerEvents="none">
      {/* particle*WIND_TRAIL dots; positions/opacity set imperatively per frame. */}
      {Array.from({ length: count * WIND_TRAIL }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size particle pool — index is the stable identity
          key={`wd-${i}`}
          ref={(el) => {
            dotRefs.current[i] = el;
          }}
          r={WIND_DOT_R(i % WIND_TRAIL)}
          fill={color}
          opacity={0}
        />
      ))}
    </g>
  );
}

/** Minimal "the Man" glyph — a stick figure with arms raised, centered at (x,y). */
function ManGlyph({ x, y, size }: { x: number; y: number; size: number }) {
  const s = size / 22;
  return (
    <g
      stroke="var(--mantine-color-text)"
      strokeWidth={1.6}
      strokeLinecap="round"
      fill="none"
      pointerEvents="none"
    >
      <circle
        cx={x}
        cy={y - 9 * s}
        r={2.4 * s}
        fill="var(--mantine-color-text)"
        stroke="none"
      />
      <line x1={x} y1={y - 6.5 * s} x2={x} y2={y + 3 * s} />
      <line x1={x} y1={y - 4.5 * s} x2={x - 6 * s} y2={y - 11 * s} />
      <line x1={x} y1={y - 4.5 * s} x2={x + 6 * s} y2={y - 11 * s} />
      <line x1={x} y1={y + 3 * s} x2={x - 4.5 * s} y2={y + 10 * s} />
      <line x1={x} y1={y + 3 * s} x2={x + 4.5 * s} y2={y + 10 * s} />
    </g>
  );
}

// Memoized so a drag only re-renders the moved object. setObjects maps
// unchanged objects to the same reference, so their `o` prop stays ===; the
// inline handler props change identity each render but behave identically (they
// close over the same `o`), so the comparator ignores them.
const MapObjectShape = memo(
  function MapObjectShape({
    o,
    originX,
    originY,
    ppf,
    selected,
    soleSelected,
    editable,
    resizable,
    dim,
    showDoors,
    overflow,
    night,
    onBodyDown,
    onResizeDown,
    onRotateDown,
  }: {
    o: ObjRow;
    originX: number;
    originY: number;
    ppf: number;
    selected: boolean;
    /** This is the ONLY selected object (so it shows resize/rotate handles; a
     * multi-selection shows a single group handle instead). */
    soleSelected: boolean;
    editable: boolean;
    /** Whether the corner drag-resize handle is offered (owner-only; see the
     * `resizable` helper). Move/rotate follow `editable` instead. */
    resizable: boolean;
    dim: boolean;
    showDoors: boolean;
    /** The object's footprint crosses the lot border (center is still inside). */
    overflow: boolean;
    /** The night-lighting sim is active (sun below the horizon). */
    night: boolean;
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
    // Editable items drag (move cursor); everything else is still selectable for
    // read-only details (pointer cursor).
    const bodyStyle = { cursor: editable ? "move" : "pointer" } as const;
    // A canopy (shade/carport/popup/…) is a translucent overhead drawn over the
    // items beneath it. Its body is click-through (pointer-events none) so clicking
    // a block under it grabs the block; clicking an empty part falls through to the
    // canvas, which hit-tests canopies and selects this one (see onCanvasDown).
    const isShade = def.canopyShade === true;
    // Show the owner's first name on sleeping structures (domiciles), drawn
    // upright outside the rotated group (the center cx,cy is rotation-invariant).
    const isDomicile = hasTag(o.kind, "domicile");
    const ownerFirst = o.ownerName?.split(" ")[0] ?? null;
    const bigEnough = w > 22 && h > 16;
    // A given name (e.g. a named RV) is the prominent label; the owner's first
    // name (domiciles) is shown secondarily beneath it.
    const showName = !!o.name && bigEnough;
    const showOwner = isDomicile && !!ownerFirst && bigEnough;
    // Label orientation: align with the object's dominant (longer) axis — a
    // length-dominant (taller-than-wide) object reads along its length (+90°) —
    // then rotate with the object and fold into (−90°, 90°] so the text is never
    // upside down (readable from the bottom, or the right when vertical).
    let labelAngle = (((o.rotation + (h > w ? 90 : 0)) % 360) + 360) % 360;
    if (labelAngle > 90 && labelAngle <= 270) labelAngle -= 180;
    return (
      <g opacity={dim ? 0.28 : undefined}>
        <g transform={`rotate(${o.rotation} ${cx} ${cy})`}>
          {isShade ? (
            <rect
              x={px}
              y={py}
              width={w}
              height={h}
              rx={3}
              fill={fill}
              fillOpacity={0.18}
              stroke={selected ? "#1c1c1c" : fill}
              strokeWidth={selected ? 2.5 : 2}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          ) : def.shape === "rect" ? (
            <>
              {/* RV slide-out pop-outs (drawn under the body, attached to a side). */}
              {o.kind === "rv" && (o.config.popoutL ?? 0) > 0 ? (
                <rect
                  x={px - clamp(o.config.popoutL ?? 0, 0, 4) * ppf}
                  y={py + h * 0.2}
                  width={clamp(o.config.popoutL ?? 0, 0, 4) * ppf}
                  height={h * 0.6}
                  fill={fill}
                  fillOpacity={0.7}
                  stroke={selected ? "#1c1c1c" : fill}
                  strokeWidth={selected ? 2 : 1}
                  style={bodyStyle}
                  onPointerDown={onBodyDown}
                />
              ) : null}
              {o.kind === "rv" && (o.config.popoutR ?? 0) > 0 ? (
                <rect
                  x={px + w}
                  y={py + h * 0.2}
                  width={clamp(o.config.popoutR ?? 0, 0, 4) * ppf}
                  height={h * 0.6}
                  fill={fill}
                  fillOpacity={0.7}
                  stroke={selected ? "#1c1c1c" : fill}
                  strokeWidth={selected ? 2 : 1}
                  style={bodyStyle}
                  onPointerDown={onBodyDown}
                />
              ) : null}
              {/* Toy-hauler fold-down rear ramp (apron off the +y/rear edge), with
              tread slats. Drawn under the body so the body sits over the hinge. */}
              {o.kind === "toy-hauler" && (o.config.ramp ?? 0) > 0
                ? (() => {
                    const rampPx = Math.min(o.width, 8) * ppf;
                    return (
                      <g pointerEvents="none">
                        <rect
                          x={px}
                          y={py + h}
                          width={w}
                          height={rampPx}
                          fill={fill}
                          fillOpacity={0.45}
                          stroke={selected ? "#1c1c1c" : fill}
                          strokeWidth={selected ? 1.5 : 0.75}
                        />
                        {[0.25, 0.5, 0.75].map((f) => (
                          <line
                            key={f}
                            x1={px}
                            y1={py + h + rampPx * f}
                            x2={px + w}
                            y2={py + h + rampPx * f}
                            stroke="#1c1c1c"
                            strokeOpacity={0.3}
                            strokeWidth={0.6}
                          />
                        ))}
                      </g>
                    );
                  })()
                : null}
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
              {/* Generator marker (noise/exhaust) at the front end. */}
              {o.kind === "rv" && (o.config.generator ?? 0) > 0
                ? (() => {
                    const s = Math.min(2.6 * ppf, w * 0.55);
                    const gy = py + h * 0.05;
                    return (
                      <g pointerEvents="none">
                        <rect
                          x={cx - s / 2}
                          y={gy}
                          width={s}
                          height={s * 0.72}
                          rx={1}
                          fill="#e03131"
                          stroke="#fff"
                          strokeWidth={0.6}
                        />
                        <text
                          x={cx}
                          y={gy + s * 0.36}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={s * 0.55}
                          fontWeight={700}
                          fill="#fff"
                        >
                          G
                        </text>
                      </g>
                    );
                  })()
                : null}
              {/* Sewer cleanout marker (dump access) at the rear end. */}
              {o.kind === "rv" && (o.config.cleanout ?? 0) > 0
                ? (() => {
                    const r = Math.min(1.3 * ppf, w * 0.22);
                    const ccy = py + h - h * 0.05 - r;
                    return (
                      <g pointerEvents="none">
                        <circle
                          cx={cx}
                          cy={ccy}
                          r={r}
                          fill="#495057"
                          stroke="#fff"
                          strokeWidth={0.6}
                        />
                        <circle cx={cx} cy={ccy} r={r * 0.45} fill="#ced4da" />
                      </g>
                    );
                  })()
                : null}
            </>
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
              {/* Roof shading: high corner light → low corner dark (tilted). */}
              <rect
                x={px}
                y={py}
                width={w}
                height={h}
                rx={2}
                fill="url(#hypar-roof)"
                pointerEvents="none"
              />
              {/* A pair of roof solar panels. */}
              {[0.17, 0.53].map((fy) => (
                <rect
                  key={fy}
                  x={px + w * 0.24}
                  y={py + h * fy}
                  width={w * 0.52}
                  height={h * 0.3}
                  rx={0.5}
                  fill="#4dabf7"
                  fillOpacity={0.55}
                  stroke="#1971c2"
                  strokeWidth={0.7}
                  pointerEvents="none"
                />
              ))}
              {/* Roof fold (hypar ridge) down the middle, over the panels. */}
              <line
                x1={cx}
                y1={py}
                x2={cx}
                y2={py + h}
                stroke="#1c1c1c"
                strokeOpacity={0.45}
                strokeWidth={0.75}
                pointerEvents="none"
              />
              {/* Roof AC unit on the back edge by the high corner — a power
                  connection point cables snap to. */}
              <rect
                x={px + w * 0.58}
                y={py - h * 0.16}
                width={w * 0.22}
                height={h * 0.18}
                rx={0.5}
                fill="#ced4da"
                stroke="#868e96"
                strokeWidth={0.6}
                pointerEvents="none"
              />
            </>
          ) : def.shape === "hexagon" ? (
            <>
              <polygon
                points={hexPoints(px, py, w, h)}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Pyramidal roof: bright apex at center → dark eaves. */}
              <polygon
                points={hexPoints(px, py, w, h)}
                fill="url(#hexayurt-roof)"
                pointerEvents="none"
              />
              {/* Ridge lines from each vertex to the center apex. */}
              {hexVertices(px, py, w, h).map((v) => (
                <line
                  key={`${v.x},${v.y}`}
                  x1={cx}
                  y1={cy}
                  x2={v.x}
                  y2={v.y}
                  stroke="#1c1c1c"
                  strokeOpacity={0.35}
                  strokeWidth={0.75}
                  pointerEvents="none"
                />
              ))}
            </>
          ) : def.shape === "dome" ? (
            <>
              <ellipse
                cx={cx}
                cy={cy}
                rx={w / 2}
                ry={h / 2}
                fill={fill}
                fillOpacity={0.78}
                stroke={selected ? "#1c1c1c" : fill}
                strokeWidth={selected ? 2 : 1}
                style={bodyStyle}
                onPointerDown={onBodyDown}
              />
              {/* Geodesic facets: an inner ring + radial struts. */}
              <ellipse
                cx={cx}
                cy={cy}
                rx={w * 0.28}
                ry={h * 0.28}
                fill="none"
                stroke="#1c1c1c"
                strokeOpacity={0.3}
                strokeWidth={0.75}
                pointerEvents="none"
              />
              {[0, 60, 120, 180, 240, 300].map((a) => {
                const r = (a * Math.PI) / 180;
                return (
                  <line
                    key={a}
                    x1={cx}
                    y1={cy}
                    x2={cx + Math.cos(r) * (w / 2)}
                    y2={cy + Math.sin(r) * (h / 2)}
                    stroke="#1c1c1c"
                    strokeOpacity={0.25}
                    strokeWidth={0.6}
                    pointerEvents="none"
                  />
                );
              })}
            </>
          ) : def.shape === "custom" && def.renderFootprint ? (
            // A camp-theme structure draws its own footprint in plot-local FEET
            // (0,0→w,h); the wrapper translates+scales it into pixel space so it
            // composes with drag/resize/rotate like a built-in shape.
            <g
              style={bodyStyle}
              onPointerDown={onBodyDown}
              transform={`translate(${px} ${py}) scale(${ppf})`}
            >
              {def.renderFootprint({
                w: o.width,
                h: o.height,
                color: fill,
                selected,
                rotation: o.rotation,
                mirror: o.mirrored,
                config: o.config,
                night,
              })}
            </g>
          ) : (
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
          )}
          <KindGlyph kind={o.kind} px={px} py={py} w={w} h={h} />
          {showDoors && o.showDoor && o.kind === "rv" ? (
            <Door
              mx={px + w}
              my={
                cy +
                doorShift(
                  o.config.doorOffset ?? 0,
                  Math.min(3 * ppf, h * 0.4),
                  h,
                )
              }
              ex={0}
              ey={1}
              nx={-1}
              ny={0}
              len={Math.min(3 * ppf, h * 0.4)}
            />
          ) : showDoors && o.showDoor && o.kind === "hyparhut" ? (
            <HyparDoor px={px} py={py} w={w} h={h} />
          ) : showDoors && o.showDoor && o.kind === "hexayurt" ? (
            <Door
              mx={
                cx +
                doorShift(
                  o.config.doorOffset ?? 0,
                  Math.min(3 * ppf, w * 0.5),
                  w,
                )
              }
              my={py + h}
              ex={1}
              ey={0}
              nx={0}
              ny={-1}
              len={Math.min(3 * ppf, w * 0.5)}
            />
          ) : showDoors && o.showDoor && o.kind === "container" ? (
            <ContainerDoors px={px} py={py} w={w} h={h} />
          ) : null}
          {o.kind === "tent" ? (
            <rect
              x={cx - Math.min(6 * ppf, w * 0.7) / 2}
              y={py + h}
              width={Math.min(6 * ppf, w * 0.7)}
              height={3 * ppf}
              rx={1}
              fill={fill}
              fillOpacity={0.28}
              stroke={fill}
              strokeWidth={1}
              pointerEvents="none"
            />
          ) : null}
          {o.pending ? (
            <circle
              cx={px + w}
              cy={py}
              r={4}
              fill="#f08c00"
              stroke="#fff"
              strokeWidth={1}
              pointerEvents="none"
            />
          ) : null}
          {overflow ? (
            // The footprint crosses the lot border — flag it tracing the REAL
            // outline (triangle/hexagon/…), not a bounding box.
            <polygon
              points={footprintOutline(
                o.kind,
                o.width,
                o.height,
                o.config,
                o.mirrored,
              )
                .map(([lx, ly]) => `${cx + lx * ppf},${cy + ly * ppf}`)
                .join(" ")}
              fill="none"
              stroke="#fa5252"
              strokeWidth={2.5}
              strokeDasharray="5 3"
              pointerEvents="none"
            />
          ) : null}
          {soleSelected && editable ? (
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
              {resizable &&
              !(def.vehicle || def.rigid || def.shape === "dome") ? (
                // Domes stay round: no corner-drag (which would skew w≠h); the
                // diameter is set in the properties panel instead. The handle is
                // owner-only — you don't drag-resize someone else's tent.
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
              ) : null}
            </>
          ) : null}
        </g>
        {showName || showOwner ? (
          <g
            style={{ pointerEvents: "none", userSelect: "none" }}
            textAnchor="middle"
            // Run the label along the object's dominant (longer) axis, rotated
            // with it — then fold the angle so it's never upside down: always
            // readable from the bottom, or from the right for a length-dominant
            // (taller-than-wide) object.
            transform={`rotate(${labelAngle} ${cx} ${cy})`}
          >
            {showName ? (
              <text
                x={cx}
                y={showOwner ? cy - 7 : cy}
                dominantBaseline="central"
                fontSize={16}
                fontWeight={700}
                fill="#1c1c1c"
              >
                {o.name}
              </text>
            ) : null}
            {showOwner ? (
              <text
                x={cx}
                y={showName ? cy + 10 : cy}
                dominantBaseline="central"
                fontSize={showName ? 13 : 15}
                fontWeight={showName ? 400 : 600}
                fill={showName ? "#868e96" : "#1c1c1c"}
                // Personal (occupant) name — stripped from the BM export for privacy.
                data-personal-name="1"
              >
                {ownerFirst}
              </text>
            ) : null}
          </g>
        ) : null}
      </g>
    );
  },
  (prev, next) =>
    prev.o === next.o &&
    prev.selected === next.selected &&
    prev.soleSelected === next.soleSelected &&
    prev.editable === next.editable &&
    prev.resizable === next.resizable &&
    prev.dim === next.dim &&
    prev.overflow === next.overflow &&
    prev.showDoors === next.showDoors &&
    prev.night === next.night &&
    prev.originX === next.originX &&
    prev.originY === next.originY &&
    prev.ppf === next.ppf,
);

/** Human-readable lines describing how the live geometry differs from `prev`. */
function describeChange(o: ObjRow, prev: PendingPrev): string[] {
  const out: string[] = [];
  if (round(prev.x) !== round(o.x) || round(prev.y) !== round(o.y)) {
    out.push(
      `Moved (${round(prev.x)},${round(prev.y)}) → (${round(o.x)},${round(o.y)})`,
    );
  }
  if (
    round(prev.width) !== round(o.width) ||
    round(prev.height) !== round(o.height)
  ) {
    out.push(
      `Resized ${round(prev.width)}×${round(prev.height)} → ${round(o.width)}×${round(o.height)}′`,
    );
  }
  if (Math.round(prev.rotation) !== Math.round(o.rotation)) {
    out.push(
      `Rotated ${Math.round(prev.rotation)}° → ${Math.round(o.rotation)}°`,
    );
  }
  return out;
}

function SidePanel({
  lot,
  objects,
  setObjects,
  selectedId,
  canEdit,
  canManage,
  myMembershipId,
  bannedKinds,
  lotOpen,
  fetcher,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  canEdit: boolean;
  canManage: boolean;
  myMembershipId: string;
  // Structure kinds disallowed this edition (filtered out of the Kind picker).
  bannedKinds: string[];
  // Lot config visibility — toggled by the map toolbar gear (lifted to CampMap).
  lotOpen: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const selected = objects.find((o) => o.id === selectedId) ?? null;
  // Officers edit anything (incl. name/kind/notes + delete). An owner-member may
  // adjust their own item's geometry (those edits become pending). Anyone else
  // sees read-only details.
  const isOfficer = canManage;
  const isOwnerMember =
    !canManage && canEdit && selected?.ownerMembershipId === myMembershipId;
  const canGeom = isOfficer || isOwnerMember;
  const canMeta = isOfficer;

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
              <div>
                <Text fw={600} size="sm">
                  Selected structure
                </Text>
                <Text size="xs" c="dimmed">
                  {selected.ownerName ?? "Camp / shared"}
                </Text>
              </div>
              {canMeta ? (
                <Group gap={4} wrap="nowrap">
                  <Tooltip label="Duplicate">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Duplicate"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "duplicateObject", id: selected.id },
                          { method: "post" },
                        )
                      }
                    >
                      ⧉
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove from map (keeps it in Unplaced)">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label="Remove from map"
                      onClick={() => {
                        setObjects((prev) =>
                          prev.filter((o) => o.id !== selected.id),
                        );
                        fetcher.submit(
                          { intent: "unplaceObject", id: selected.id },
                          { method: "post" },
                        );
                      }}
                    >
                      ✕
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ) : null}
            </Group>

            {selected.pending ? (
              isOfficer ? (
                <Paper bg="orange.0" p="xs" radius="sm">
                  <Text size="xs" fw={600} mb={2}>
                    Pending change{" "}
                    {selected.ownerName ? `by ${selected.ownerName}` : ""}
                  </Text>
                  {describeChange(selected, selected.pending.prev).map((l) => (
                    <Text key={l} size="xs" c="dimmed">
                      {l}
                    </Text>
                  ))}
                  <Group gap="xs" mt={6}>
                    <Button
                      size="compact-xs"
                      color="green"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "approveChange", id: selected.id },
                          { method: "post" },
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "rejectChange", id: selected.id },
                          { method: "post" },
                        )
                      }
                    >
                      Reject
                    </Button>
                  </Group>
                </Paper>
              ) : (
                <Text size="xs" c="orange.7">
                  Your change is pending officer approval.
                </Text>
              )
            ) : null}

            {kindDef(selected.kind).fixedName ? null : (
              <TextInput
                size="xs"
                label="Name"
                value={selected.name ?? ""}
                disabled={!canMeta}
                onChange={(e) =>
                  patch(selected.id, { name: e.currentTarget.value })
                }
                onBlur={(e) =>
                  commitField(selected.id, "name", e.currentTarget.value)
                }
              />
            )}
            <Select
              size="xs"
              label="Kind"
              value={selected.kind}
              disabled={!canMeta}
              // Hide kinds disallowed this year, but keep the selected one visible
              // even if it's now banned (so a flagged object still shows its kind).
              data={KINDS.filter(
                (k) =>
                  !bannedKinds.includes(k.value) || k.value === selected.kind,
              ).map((k) => ({
                value: k.value,
                label: bannedKinds.includes(k.value)
                  ? `${k.label} (not allowed)`
                  : k.label,
              }))}
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
                // A dome must stay round: match height to width (its diameter).
                if (d.shape === "dome") {
                  const dia = fields.width ?? selected.width;
                  fields.width = dia;
                  fields.height = dia;
                  out.width = dia;
                  out.height = dia;
                }
                patch(selected.id, fields);
                commitMany(selected.id, out);
              }}
            />
            {selected.kind === "container" ? (
              <div>
                <Text size="xs" fw={500} mb={4}>
                  Size — {CONTAINER_WIDTH}′ wide × {Math.round(selected.height)}
                  ′
                </Text>
                <SegmentedControl
                  size="xs"
                  fullWidth
                  disabled={!canGeom}
                  value={
                    Math.round(selected.height) <= CONTAINER_HALF
                      ? "half"
                      : "full"
                  }
                  onChange={(v) => {
                    const height =
                      v === "half" ? CONTAINER_HALF : CONTAINER_FULL;
                    patch(selected.id, { width: CONTAINER_WIDTH, height });
                    commitMany(selected.id, { width: CONTAINER_WIDTH, height });
                  }}
                  data={[
                    { label: `Half (${CONTAINER_HALF}′)`, value: "half" },
                    { label: `Full (${CONTAINER_FULL}′)`, value: "full" },
                  ]}
                />
              </div>
            ) : kindDef(selected.kind).shape === "dome" ? (
              <NumberInput
                size="xs"
                label="Diameter (ft)"
                value={Math.round(selected.width)}
                min={4}
                disabled={!canGeom}
                onChange={(v) => {
                  const d = Math.max(4, Number(v) || 4);
                  patch(selected.id, { width: d, height: d });
                }}
                onBlur={() => {
                  const d = round(selected.width);
                  commitMany(selected.id, { width: d, height: d });
                }}
              />
            ) : kindDef(selected.kind).rigid ? (
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
                  disabled={!canGeom}
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
                  disabled={!canGeom}
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
                  disabled={!canGeom}
                  onChange={(v) =>
                    patch(selected.id, { height: Number(v) || 2 })
                  }
                  onBlur={() =>
                    commitField(selected.id, "height", round(selected.height))
                  }
                />
              </Group>
            )}
            <Group grow>
              <NumberInput
                size="xs"
                label="Rotation (°)"
                value={Math.round(selected.rotation)}
                disabled={!canGeom}
                onChange={(v) =>
                  patch(selected.id, { rotation: Number(v) || 0 })
                }
                onBlur={() =>
                  commitField(
                    selected.id,
                    "rotation",
                    Math.round(selected.rotation),
                  )
                }
              />
              {kindDef(selected.kind).fixedTall ? null : (
                <NumberInput
                  size="xs"
                  label="Height (ft)"
                  value={selected.tallFt}
                  min={0}
                  disabled={!canGeom}
                  onChange={(v) =>
                    patch(selected.id, { tallFt: Number(v) || 0 })
                  }
                  // Commit the live input value (not a possibly-stale `selected`
                  // closure, which could re-save the old height and revert it).
                  onBlur={(e) =>
                    commitField(
                      selected.id,
                      "tallFt",
                      Math.max(0, round(Number(e.currentTarget.value) || 0)),
                    )
                  }
                />
              )}
            </Group>
            {canMeta && kindHasDoor(selected.kind) ? (
              <Checkbox
                size="xs"
                label="Show door"
                checked={selected.showDoor}
                onChange={(e) => {
                  const showDoor = e.currentTarget.checked;
                  patch(selected.id, { showDoor });
                  commitField(
                    selected.id,
                    "showDoor",
                    showDoor ? "true" : "false",
                  );
                }}
              />
            ) : null}
            {canMeta && kindDef(selected.kind).mirrorable ? (
              <Checkbox
                size="xs"
                label="Mirror (flip left–right)"
                checked={selected.mirrored}
                onChange={(e) => {
                  const mirrored = e.currentTarget.checked;
                  patch(selected.id, { mirrored });
                  commitField(
                    selected.id,
                    "mirrored",
                    mirrored ? "true" : "false",
                  );
                }}
              />
            ) : null}
            {canMeta
              ? (kindDef(selected.kind).controls ?? []).map((c) => {
                  const val = selected.config[c.key] ?? c.default;
                  const apply = (v: number, commit: boolean) => {
                    const config = { ...selected.config, [c.key]: v };
                    patch(selected.id, { config });
                    if (commit)
                      commitField(
                        selected.id,
                        "config",
                        JSON.stringify(config),
                      );
                  };
                  if (c.toggle) {
                    return (
                      <Checkbox
                        key={c.key}
                        size="xs"
                        label={c.label}
                        checked={val > 0}
                        onChange={(e) =>
                          apply(e.currentTarget.checked ? 1 : 0, true)
                        }
                      />
                    );
                  }
                  return (
                    <div key={c.key}>
                      <Text size="xs" fw={500} mb={2}>
                        {c.label}: {val}
                      </Text>
                      <Slider
                        size="sm"
                        min={c.min}
                        max={c.max}
                        step={c.step ?? 1}
                        value={val}
                        marks={Array.from(
                          {
                            length:
                              Math.floor((c.max - c.min) / (c.step ?? 1)) + 1,
                          },
                          (_, i) => {
                            const m = c.min + i * (c.step ?? 1);
                            return { value: m, label: String(m) };
                          },
                        )}
                        onChange={(v) => apply(v, false)}
                        onChangeEnd={(v) => apply(v, true)}
                        mb="sm"
                      />
                    </div>
                  );
                })
              : null}
            <Textarea
              size="xs"
              label="Notes"
              autosize
              minRows={2}
              value={selected.notes ?? ""}
              disabled={!canMeta}
              onChange={(e) =>
                patch(selected.id, { notes: e.currentTarget.value })
              }
              onBlur={(e) =>
                commitField(selected.id, "notes", e.currentTarget.value)
              }
            />
          </Stack>
        </Paper>
      ) : null}

      {canManage ? (
        <Collapse in={lotOpen}>
          <Paper withBorder p="md" radius="md">
            <Text fw={600} size="sm" mb="sm">
              Lot settings
            </Text>
            <PlacementForm lot={lot} fetcher={fetcher} />
          </Paper>
        </Collapse>
      ) : null}
    </Stack>
  );
}

/** Officer queue of items with an unapproved member change — click to select,
 * or approve/reject inline. */
function PendingPanel({
  objects,
  setSelectedId,
  fetcher,
}: {
  objects: ObjRow[];
  setSelectedId: (id: string | null) => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const pending = objects.filter((o) => o.pending);
  if (pending.length === 0) return null;
  return (
    <Paper withBorder p="sm" radius="md" bg="orange.0">
      <Text size="xs" fw={600} mb={6}>
        Pending approvals ({pending.length})
      </Text>
      <Stack gap={6}>
        {pending.map((o) => (
          <div key={o.id}>
            <Group gap={6} wrap="nowrap" justify="space-between">
              <button
                type="button"
                onClick={() => setSelectedId(o.id)}
                style={{
                  flex: 1,
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Text size="xs" fw={500}>
                  {kindDef(o.kind).label}
                  {o.ownerName ? (
                    <Text span c="dimmed">
                      {" "}
                      · {o.ownerName}
                    </Text>
                  ) : null}
                </Text>
              </button>
              <Group gap={4} wrap="nowrap">
                <Button
                  size="compact-xs"
                  color="green"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "approveChange", id: o.id },
                      { method: "post" },
                    )
                  }
                >
                  ✓
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "rejectChange", id: o.id },
                      { method: "post" },
                    )
                  }
                >
                  ✕
                </Button>
              </Group>
            </Group>
            {o.pending
              ? describeChange(o, o.pending.prev).map((l) => (
                  <Text key={l} size="xs" c="dimmed" ml={2}>
                    {l}
                  </Text>
                ))
              : null}
          </div>
        ))}
      </Stack>
    </Paper>
  );
}

const ZONE_KINDS = [
  { value: "fire", label: "Fire lane" },
  { value: "public", label: "Public area" },
  { value: "private", label: "Private area" },
  { value: "custom", label: "Custom" },
] as const;

function zoneKindLabel(kind: string): string {
  return ZONE_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** Edit a selected zone's name / type / color (officers), else read-only. */
function ZonePanel({
  zones,
  selectedZoneId,
  setZones,
  canManage,
  fetcher,
}: {
  zones: ZoneRow[];
  selectedZoneId: string;
  setZones: React.Dispatch<React.SetStateAction<ZoneRow[]>>;
  canManage: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const zone = zones.find((z) => z.id === selectedZoneId) ?? null;
  if (!zone) return null;
  const patch = (fields: Partial<ZoneRow>) =>
    setZones((prev) =>
      prev.map((z) => (z.id === zone.id ? { ...z, ...fields } : z)),
    );
  const commit = (fields: Record<string, string>) =>
    fetcher.submit(
      { intent: "updateZone", id: zone.id, ...fields },
      { method: "post" },
    );
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Zone
        </Text>
        {canManage ? (
          <Tooltip label="Delete">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => {
                setZones((prev) => prev.filter((z) => z.id !== zone.id));
                fetcher.submit(
                  { intent: "deleteZone", id: zone.id },
                  { method: "post" },
                );
              }}
            >
              ✕
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      <Stack gap="sm">
        <TextInput
          size="xs"
          label="Name"
          value={zone.name ?? ""}
          disabled={!canManage}
          onChange={(e) => patch({ name: e.currentTarget.value })}
          onBlur={(e) => commit({ name: e.currentTarget.value })}
        />
        <Select
          size="xs"
          label="Type"
          value={zone.kind}
          disabled={!canManage}
          data={ZONE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          allowDeselect={false}
          onChange={(v) => {
            if (!v) return;
            patch({ kind: v });
            commit({ kind: v });
          }}
        />
        <ColorInput
          size="xs"
          label="Color"
          value={zone.color}
          disabled={!canManage}
          onChange={(v) => patch({ color: v })}
          onChangeEnd={(v) => commit({ color: v })}
        />
        <Text size="xs" c="dimmed">
          {zone.points.length} points
        </Text>
      </Stack>
    </Paper>
  );
}

/** Edit a selected power line's name / rating / color + show its run length. */
function CablePanel({
  cables,
  selectedCableId,
  setCables,
  canManage,
  fetcher,
}: {
  cables: CableRow[];
  selectedCableId: string;
  setCables: React.Dispatch<React.SetStateAction<CableRow[]>>;
  canManage: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const cable = cables.find((c) => c.id === selectedCableId) ?? null;
  if (!cable) return null;
  const patch = (fields: Partial<CableRow>) =>
    setCables((prev) =>
      prev.map((c) => (c.id === cable.id ? { ...c, ...fields } : c)),
    );
  const commit = (fields: Record<string, string>) =>
    fetcher.submit(
      { intent: "updateCable", id: cable.id, ...fields },
      { method: "post" },
    );
  const lenFt = pathLengthFt(cable.points);
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          {cable.kind === "power" ? "Power line" : cableKindLabel(cable.kind)}
          {cable.kind === "power" ? "" : " pipe"}
        </Text>
        {canManage ? (
          <Tooltip label="Delete">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => {
                setCables((prev) => prev.filter((c) => c.id !== cable.id));
                fetcher.submit(
                  { intent: "deleteCable", id: cable.id },
                  { method: "post" },
                );
              }}
            >
              ✕
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      <Stack gap="sm">
        <Paper bg="yellow.0" p="xs" radius="sm">
          <Text size="xs" c="dimmed">
            Run length
          </Text>
          <Text fw={700} size="lg">
            {feetInches(lenFt)}
          </Text>
          <Text size="xs" c="dimmed">
            {cable.points.length} points
          </Text>
        </Paper>
        {canManage ? (
          <Text size="xs" c="dimmed">
            Drag a handle to move a point (snaps to spider boxes / generators),
            drag a dashed + to add one, double-click a handle to remove it.
          </Text>
        ) : null}
        <Select
          size="xs"
          label="Type"
          value={cable.kind}
          disabled={!canManage}
          allowDeselect={false}
          data={CABLE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          onChange={(v) => {
            if (!v) return;
            // Switching type reseeds the color; clear amps/gauge for water pipes.
            const def = cableKindDef(v);
            const fields: Partial<CableRow> = { kind: v, color: def.color };
            const out: Record<string, string> = { kind: v, color: def.color };
            if (v !== "power") {
              fields.amps = null;
              fields.gauge = null;
              out.amps = "";
              out.gauge = "";
            }
            patch(fields);
            commit(out);
          }}
        />
        <TextInput
          size="xs"
          label="Name"
          placeholder="e.g. Gen → Kitchen box"
          value={cable.name ?? ""}
          disabled={!canManage}
          onChange={(e) => patch({ name: e.currentTarget.value })}
          onBlur={(e) => commit({ name: e.currentTarget.value })}
        />
        {cable.kind === "power" ? (
          <Group grow>
            <Select
              size="xs"
              label="Amps"
              placeholder="—"
              value={cable.amps != null ? String(cable.amps) : null}
              disabled={!canManage}
              data={AMP_OPTIONS.map((a) => ({ value: a, label: `${a} A` }))}
              clearable
              onChange={(v) => {
                patch({ amps: v ? Number(v) : null });
                commit({ amps: v ?? "" });
              }}
            />
            <Select
              size="xs"
              label="Gauge"
              placeholder="—"
              value={cable.gauge}
              disabled={!canManage}
              data={GAUGE_OPTIONS.map((g) => ({
                value: g.value,
                label: g.label,
              }))}
              clearable
              onChange={(v) => {
                patch({ gauge: v });
                commit({ gauge: v ?? "" });
              }}
            />
          </Group>
        ) : null}
        <ColorInput
          size="xs"
          label="Color"
          value={cable.color}
          disabled={!canManage}
          onChange={(v) => patch({ color: v })}
          onChangeEnd={(v) => commit({ color: v })}
        />
        <Textarea
          size="xs"
          label="Notes"
          autosize
          minRows={2}
          value={cable.notes ?? ""}
          disabled={!canManage}
          onChange={(e) => patch({ notes: e.currentTarget.value })}
          onBlur={(e) => commit({ notes: e.currentTarget.value })}
        />
      </Stack>
    </Paper>
  );
}

function RoadPanel({
  roads,
  selectedRoadId,
  setRoads,
  canManage,
  fetcher,
}: {
  roads: RoadRow[];
  selectedRoadId: string;
  setRoads: React.Dispatch<React.SetStateAction<RoadRow[]>>;
  canManage: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const road = roads.find((r) => r.id === selectedRoadId) ?? null;
  if (!road) return null;
  const patch = (fields: Partial<RoadRow>) =>
    setRoads((prev) =>
      prev.map((r) => (r.id === road.id ? { ...r, ...fields } : r)),
    );
  const commit = (fields: Record<string, string>) =>
    fetcher.submit(
      { intent: "updateRoad", id: road.id, ...fields },
      { method: "post" },
    );
  const lenFt = pathLengthFt(road.points);
  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          {roadKindLabel(road.kind)}
        </Text>
        {canManage ? (
          <Tooltip label="Delete">
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => {
                setRoads((prev) => prev.filter((r) => r.id !== road.id));
                fetcher.submit(
                  { intent: "deleteRoad", id: road.id },
                  { method: "post" },
                );
              }}
            >
              ✕
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      <Stack gap="sm">
        <Paper bg="gray.0" p="xs" radius="sm">
          <Text size="xs" c="dimmed">
            Centerline length
          </Text>
          <Text fw={700} size="lg">
            {feetInches(lenFt)}
          </Text>
          <Text size="xs" c="dimmed">
            {road.width}′ wide · 45° cutback {road.cutback}′ at square corners
          </Text>
        </Paper>
        <Select
          size="xs"
          label="Type"
          value={road.kind}
          disabled={!canManage}
          allowDeselect={false}
          data={ROAD_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          onChange={(v) => {
            if (!v) return;
            // Switching type resets width + color to that type's defaults.
            const def = roadKindDef(v);
            patch({ kind: v, width: def.width, color: def.color });
            commit({
              kind: v,
              width: String(def.width),
              color: def.color,
            });
          }}
        />
        <Group grow>
          <NumberInput
            size="xs"
            label="Width (ft)"
            min={2}
            value={road.width}
            disabled={!canManage}
            onChange={(v) => patch({ width: Number(v) || road.width })}
            onBlur={(e) =>
              commit({
                width: String(Number(e.currentTarget.value) || road.width),
              })
            }
          />
          <NumberInput
            size="xs"
            label="Corner cutback (ft)"
            min={0}
            value={road.cutback}
            disabled={!canManage}
            onChange={(v) => patch({ cutback: Number(v) || 0 })}
            onBlur={(e) =>
              commit({ cutback: String(Number(e.currentTarget.value) || 0) })
            }
          />
        </Group>
        <Text size="xs" c="dimmed">
          BM's turn allowance for a 90° corner is a triangle with 20-ft legs.
        </Text>
        <TextInput
          size="xs"
          label="Name"
          placeholder="e.g. main fire lane"
          value={road.name ?? ""}
          disabled={!canManage}
          onChange={(e) => patch({ name: e.currentTarget.value })}
          onBlur={(e) => commit({ name: e.currentTarget.value })}
        />
        <ColorInput
          size="xs"
          label="Color"
          value={road.color}
          disabled={!canManage}
          onChange={(v) => patch({ color: v })}
          onChangeEnd={(v) => commit({ color: v })}
        />
        <Textarea
          size="xs"
          label="Notes"
          autosize
          minRows={2}
          value={road.notes ?? ""}
          disabled={!canManage}
          onChange={(e) => patch({ notes: e.currentTarget.value })}
          onBlur={(e) => commit({ notes: e.currentTarget.value })}
        />
      </Stack>
    </Paper>
  );
}

function PlacementForm({
  lot,
  fetcher,
}: {
  lot: Lot | null;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const [year, setYear] = useState<string>(
    lot?.year ? String(lot.year) : String(CURRENT_EVENT_YEAR),
  );
  const [streetLetter, setStreetLetter] = useState<string | null>(
    lot?.streetLetter ?? null,
  );
  const derivedRadius = radiusForStreet(Number(year), streetLetter);
  const usingFallbackGeometry = !hasGeometry(Number(year));

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="savePlacement" />
      {/* Mantine Select isn't a native form control, so mirror it into hidden
          inputs the action can read. */}
      <input type="hidden" name="streetLetter" value={streetLetter ?? ""} />
      <input type="hidden" name="year" value={year} />
      <Stack gap="sm">
        <Group grow>
          <Select
            size="xs"
            label="BRC year"
            data={eventYearOptions}
            value={year}
            onChange={(v) => v && setYear(v)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            size="xs"
            label="Street"
            placeholder="Pick a street"
            data={streetOptions(Number(year))}
            value={streetLetter}
            onChange={setStreetLetter}
            clearable
            comboboxProps={{ withinPortal: true }}
          />
        </Group>
        <Group grow>
          <Autocomplete
            size="xs"
            label="Address (clock)"
            name="address"
            defaultValue={lot?.address ?? ""}
            data={clockOptions()}
            placeholder="3:00 (or 3:14)"
          />
          <TextInput
            size="xs"
            label="Street name (optional)"
            name="street"
            defaultValue={lot?.street ?? ""}
            placeholder="overrides the year's name"
          />
        </Group>
        <Checkbox
          size="xs"
          name="frontsToMan"
          defaultChecked={lot?.frontsToMan ?? true}
          label="Frontage faces the Man (uncheck for mountain-facing)"
        />
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
          label="Frontage radius override (ft, optional)"
          description={
            derivedRadius
              ? `Auto from street: ${Math.round(derivedRadius)}′ from the Man${usingFallbackGeometry ? " (latest BRC layout — this year's measurements not loaded)" : ""}. Set only to override.`
              : "Man→frontage distance; draws the wedge taper. Set if no street is picked."
          }
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
