import {
  ActionIcon,
  Autocomplete,
  Button,
  Checkbox,
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
import { memo, useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
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
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveEdition } from "~/lib/session.server";
import {
  KINDS,
  KIND_GROUPS,
  KindIcon,
  hexPoints,
  hexVertices,
  isKind,
  kindColor,
  kindDef,
} from "~/lib/structures";
import { db } from "../../../db/client.server";
import { mapObject, membership, placement, user } from "../../../db/schema";
import type { Route } from "./+types/map";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Camp map · CampTool" }];
}

/** Door symbol: opening gap + leaf + swing arc, centered on an edge. Swings
 * OUT (away from the interior). (mx,my) = edge midpoint; (ex,ey) = unit along
 * the edge; (nx,ny) = inward normal; len = door width in px. Drawn in local
 * coords so it rotates with the object. */
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
        stroke="#1c1c1c"
        strokeWidth={1}
      />
      <path
        d={`M ${lx} ${ly} A ${len} ${len} 0 1 ${sweep} ${tipx} ${tipy}`}
        stroke="#1c1c1c"
        strokeWidth={0.75}
        strokeOpacity={0.5}
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
  color: string | null;
  notes: string | null;
  // The camper who brought this (NULL = shared/communal camp item).
  ownerMembershipId: string | null;
  ownerName: string | null;
  // Set when the owner has an unapproved move/resize/rotate (the live geometry
  // is the proposed state; `prev` is what Reject restores). Only the owner can
  // propose, so the proposer is always the owner.
  pending: { prev: PendingPrev } | null;
};

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
  color: mapObject.color,
  notes: mapObject.notes,
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
  color: string | null;
  notes: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  pendingAt: Date | null;
  pendingPrev: string | null;
};

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
    color: r.color,
    notes: r.notes,
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
  const { active, activeEdition } = await requireActiveEdition(request);
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
    "addObject",
    "placeObject",
    "deleteObject",
    "approveChange",
    "rejectChange",
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

  if (intent === "addObject") {
    const kind = String(form.get("kind") ?? "structure");
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
        color: row.color,
        notes: row.notes,
        ownerMembershipId: null,
        ownerName: null,
        pending: null,
      } satisfies ObjRow,
    });
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

    if (canManage) {
      // Officers edit anything directly; an officer edit accepts (clears) any
      // pending proposal on the item.
      if (form.has("name")) set.name = str("name");
      if (form.has("kind")) set.kind = String(form.get("kind"));
      if (form.has("color")) set.color = str("color");
      if (form.has("notes")) set.notes = str("notes");
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

  if (intent === "deleteObject") {
    const id = String(form.get("id"));
    await db
      .delete(mapObject)
      .where(and(eq(mapObject.id, id), eq(mapObject.editionId, editionId)));
    return data({ deletedId: id });
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

/** Is the feet-space point (fxp,fyp) inside the object's rotated footprint? */
function containsPoint(o: ObjRow, fxp: number, fyp: number) {
  const cx = o.x + o.width / 2;
  const cy = o.y + o.height / 2;
  const local = rotateVec(fxp - cx, fyp - cy, -o.rotation);
  return Math.abs(local.x) <= o.width / 2 && Math.abs(local.y) <= o.height / 2;
}

// Black Rock City orientation, anchored to ground truth: a 3:00 camp's frontage
// faces NE toward the Man. So the bearing the map's "up" (toward the Man, across
// the frontage) points to, for a clock address H, is (135 - 30·H) mod 360
// — 3:00 → 45° (NE), 4:30 → 0° (N), 6:00 → 315° (NW), 12:00 → 135° (SE).
// Sun azimuths are event-week approximations for ~40.8°N (late Aug / early Sep):
// sunrise ENE, sunset WNW.
const SUNRISE_AZ = 73;
const SUNSET_AZ = 287;

type Lot = NonNullable<Route.ComponentProps["loaderData"]["lot"]>;

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
          10′ grid · plot {delta > 0 ? "widens" : "narrows"} {feetInches(front)}{" "}
          → {feetInches(rear)} (rear {delta > 0 ? "+" : "−"}
          {feetInches(Math.abs(delta))}) · a 10′ column is 10′0″ at the front,{" "}
          {feetInches(cellRear)} at the rear · rows 10′0″ deep
        </>
      ) : (
        <>10′ grid · square cells, no skew</>
      )}
    </Text>
  );
}

export default function CampMap({ loaderData }: Route.ComponentProps) {
  const { canEdit, canManage, unplaced, lot, myMembershipId } = loaderData;
  const fetcher = useFetcher();
  const [objects, setObjects] = useState<ObjRow[]>(loaderData.objects);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reconcile the authoritative object the server returns after each mutation:
  // upsert it (a newly added/placed one gets appended + selected; an updated one
  // is replaced in place, picking up any pending-approval flag), and drop deleted
  // ones. Guarded so the same response is only applied once.
  const lastSynced = useRef<unknown>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to new fetcher.data
  useEffect(() => {
    const d = fetcher.data as
      | { object?: ObjRow; deletedId?: string }
      | undefined;
    if (!d || d === lastSynced.current) return;
    lastSynced.current = d;
    if (d.deletedId) {
      const gone = d.deletedId;
      setObjects((prev) => prev.filter((o) => o.id !== gone));
      setSelectedId((s) => (s === gone ? null : s));
      return;
    }
    if (d.object) {
      const obj = d.object;
      const isNew = !objects.some((o) => o.id === obj.id);
      setObjects((prev) =>
        isNew ? [...prev, obj] : prev.map((o) => (o.id === obj.id ? obj : o)),
      );
      if (isNew) setSelectedId(obj.id);
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
            {lot.street
              ? ` · ${lot.street}`
              : lot.streetLetter && lot.year
                ? ` · ${streetLabel(lot.year, lot.streetLetter)}`
                : ""}
            {lot.address ? ` @ ${lot.address}` : ""}
            {lot.frontsToMan ? "" : " · mountain-facing"}
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
            canManage={canManage}
            myMembershipId={myMembershipId}
            fetcher={fetcher}
          />
          <GridScaleNote lot={lot} />
        </div>
        <Stack
          gap="md"
          style={{ flex: "1 1 240px", minWidth: 240, maxWidth: 340 }}
        >
          <Compass
            mapUpBearing={mapUpBearingFor(lot.address, lot.frontsToMan)}
          />
          {canManage ? (
            <PendingPanel
              objects={objects}
              setSelectedId={setSelectedId}
              fetcher={fetcher}
            />
          ) : null}
          {canManage ? <UnplacedTray unplaced={unplaced} /> : null}
          {canManage ? <Legend /> : null}
          <SidePanel
            lot={lot}
            objects={objects}
            setObjects={setObjects}
            selectedId={selectedId}
            canEdit={canEdit}
            canManage={canManage}
            myMembershipId={myMembershipId}
            fetcher={fetcher}
          />
        </Stack>
      </Group>
    </Stack>
  );
}

type Unplaced = Route.ComponentProps["loaderData"]["unplaced"][number];

/** Officer queue of declared-but-unplaced items; drag one onto the lot to place. */
function UnplacedTray({ unplaced }: { unplaced: Unplaced[] }) {
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
                  border: "1px solid var(--mantine-color-gray-3)",
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
                  <Text size="xs" c="dimmed" truncate maw={90}>
                    {u.ownerName}
                  </Text>
                ) : null}
              </Group>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

/** Draggable palette — icons grouped by category; drag one onto the map to
 * place that kind. Names show as tooltips so the grid of icons stays compact. */
function Legend() {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="xs" fw={600} mb={8}>
        Legend — drag onto the map
      </Text>
      <Stack gap={8}>
        {KIND_GROUPS.map((grp) => (
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
                      border: "1px solid var(--mantine-color-gray-3)",
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
  canEdit,
  canManage,
  myMembershipId,
  fetcher,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  canEdit: boolean;
  canManage: boolean;
  myMembershipId: string;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const liveObj = useRef<ObjRow | null>(null);
  const [dragging, setDragging] = useState(false);

  // Officers edit anything; a member may move/resize/rotate only their own
  // items (those edits become pending approval, handled server-side).
  const editable = (o: ObjRow) =>
    canManage || (canEdit && o.ownerMembershipId === myMembershipId);

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
      if (e.key === "Escape") {
        setSelectedId(null);
        return;
      }
      // Delete is officer-only; geometry nudges require edit rights on the item.
      if (e.key === "Delete" || e.key === "Backspace") {
        if (!canManage) return;
        e.preventDefault();
        setObjects((prev) => prev.filter((o) => o.id !== selectedId));
        fetcher.submit(
          { intent: "deleteObject", id: selectedId },
          { method: "post" },
        );
        setSelectedId(null);
        return;
      }
      if (!editable(obj)) return;
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
  }, [canEdit, canManage, selectedId, objects, lot.frontageFt, lot.depthFt]);

  // Trapezoid taper: rear edge widens (Man-facing) or narrows (mountain-facing)
  // with depth, from the derived/overridden frontage radius.
  const rear = rearWidthOf(lot, frontageRadiusOf(lot));
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
    // A press always selects (so anyone can open read-only details); it only
    // starts a drag when the viewer may edit this item.
    e.stopPropagation();
    setSelectedId(o.id);
    if (!editable(o)) return;
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
      .find((o) => o.kind === "shade" && containsPoint(o, fxp, fyp));
    if (shade) {
      // startDrag selects it (and only drags if this viewer may edit it).
      startDrag(e, shade, "move");
      return;
    }
    setSelectedId(null);
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
    const p = svgPoint(e);
    // Dropping a declared (unplaced) item from the tray places it here.
    const placeId = e.dataTransfer.getData("application/camptool-place-id");
    if (placeId) {
      const iw = Number(e.dataTransfer.getData("application/camptool-w")) || 10;
      const ih = Number(e.dataTransfer.getData("application/camptool-h")) || 10;
      fetcher.submit(
        {
          intent: "placeObject",
          id: placeId,
          x: round(
            clamp(fx(p.x) - iw / 2, 0, Math.max(0, lot.frontageFt - iw)),
          ),
          y: round(clamp(fy(p.y) - ih / 2, 0, Math.max(0, lot.depthFt - ih))),
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
        onPointerDown={onCanvasDown}
        onDragOver={canManage ? (e) => e.preventDefault() : undefined}
        onDrop={canManage ? onDrop : undefined}
        role="img"
        aria-label="Camp layout"
      >
        <title>Camp layout</title>
        <defs>
          {/* Hypar roof: high corner light → low corner dark, tilted ~10° off
              the diagonal so the high point reads off-axis. */}
          <linearGradient id="hypar-roof" x1="0" y1="0" x2="0.72" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0.6} />
            <stop offset="1" stopColor="#000000" stopOpacity={0.38} />
          </linearGradient>
          {/* Hexayurt roof: bright apex at the center → dark at the eaves. */}
          <radialGradient id="hexayurt-roof" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffffff" stopOpacity={0.62} />
            <stop offset="1" stopColor="#000000" stopOpacity={0.32} />
          </radialGradient>
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
        {/* Shade is a canopy: render it last so it sits over the items beneath. */}
        {[...objects]
          .sort(
            (a, b) => Number(a.kind === "shade") - Number(b.kind === "shade"),
          )
          .map((o) => (
            <MapObjectShape
              key={o.id}
              o={o}
              originX={originX}
              originY={originY}
              ppf={ppf}
              selected={o.id === selectedId}
              editable={editable(o)}
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
    editable,
    onBodyDown,
    onResizeDown,
    onRotateDown,
  }: {
    o: ObjRow;
    originX: number;
    originY: number;
    ppf: number;
    selected: boolean;
    editable: boolean;
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
    // Shade is a translucent canopy drawn over the items beneath it. Its body is
    // click-through (pointer-events none) so clicking a block under it grabs the
    // block; clicking an empty part of the shade falls through to the canvas,
    // which hit-tests shades and selects this one (see onCanvasDown).
    const isShade = o.kind === "shade";
    // Show the owner's first name on sleeping structures (domiciles), drawn
    // upright outside the rotated group (the center cx,cy is rotation-invariant).
    const isDomicile = (def.tags as readonly string[]).includes("domicile");
    const ownerFirst = o.ownerName?.split(" ")[0] ?? null;
    const showOwner = isDomicile && ownerFirst && w > 22 && h > 16;
    return (
      <>
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
          {o.kind === "rv" ? (
            <Door
              mx={px + w}
              my={cy}
              ex={0}
              ey={1}
              nx={-1}
              ny={0}
              len={Math.min(3 * ppf, h * 0.4)}
            />
          ) : o.kind === "hexayurt" || o.kind === "hyparhut" ? (
            <Door
              mx={cx}
              my={py + h}
              ex={1}
              ey={0}
              nx={0}
              ny={-1}
              len={Math.min(3 * ppf, w * 0.5)}
            />
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
          {o.name && w > 28 && !showOwner ? (
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
          {selected && editable ? (
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
        {showOwner ? (
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10}
            fontWeight={600}
            fill="#1c1c1c"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {ownerFirst}
          </text>
        ) : null}
      </>
    );
  },
  (prev, next) =>
    prev.o === next.o &&
    prev.selected === next.selected &&
    prev.editable === next.editable &&
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
  fetcher,
}: {
  lot: Lot;
  objects: ObjRow[];
  setObjects: React.Dispatch<React.SetStateAction<ObjRow[]>>;
  selectedId: string | null;
  canEdit: boolean;
  canManage: boolean;
  myMembershipId: string;
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
            <Select
              size="xs"
              label="Kind"
              value={selected.kind}
              disabled={!canMeta}
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
            <NumberInput
              size="xs"
              label="Rotation (°)"
              value={Math.round(selected.rotation)}
              disabled={!canGeom}
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
