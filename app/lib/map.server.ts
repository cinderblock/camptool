/**
 * Reading map objects out of the database — the one query shape and row parser,
 * shared by the map editor and any read-only view (the roster's mini-map), so
 * both get identically-shaped `ObjRow`s. Pairs with `map-shapes.tsx` (how an
 * object is drawn) and `map-geometry.ts` (where it sits).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { mapObject, membership, placement, user } from "../../db/schema";
import type { MapLot } from "./map-geometry";
import type { ObjRow, PendingPrev } from "./map-shapes";
import type { StructureConfig } from "./structures";

/** Build the `pending` field from the raw columns. */
export function parsePending(
  pendingAt: Date | null,
  prevJson: string | null,
  pendingBy: string | null = null,
): { prev: PendingPrev; by: string | null } | null {
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
      by: pendingBy,
    };
  } catch {
    return null;
  }
}

/** Columns + joins to read a placed object with its owner name. */
export const objSelect = {
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
  pendingBy: mapObject.pendingByMembershipId,
} as const;

export type ObjSelectRow = {
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
  pendingBy: string | null;
};

/** Parse the stored config JSON into a clean Record<string, number> (bad → {}). */
export function parseConfig(json: string | null): StructureConfig {
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

export function toObjRow(r: ObjSelectRow): ObjRow {
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
    pending: parsePending(r.pendingAt, r.pendingPrev, r.pendingBy),
  };
}
/**
 * The lot and every PLACED object for an edition — exactly what it takes to
 * draw a read-only map. Unplaced objects are the officer's staging queue, not
 * a location, so they're excluded (same rule as `partyMapObjects`).
 */
export async function loadMapView(
  editionId: string,
): Promise<{ lot: MapLot | null; objects: ObjRow[] }> {
  const [lot] = await db
    .select()
    .from(placement)
    .where(eq(placement.editionId, editionId))
    .limit(1);
  if (!lot) return { lot: null, objects: [] };

  const rows = await db
    .select(objSelect)
    .from(mapObject)
    .leftJoin(membership, eq(mapObject.ownerMembershipId, membership.id))
    .leftJoin(user, eq(membership.userId, user.id))
    .where(and(eq(mapObject.editionId, editionId), eq(mapObject.placed, true)));

  return {
    lot: {
      frontageFt: lot.frontageFt,
      depthFt: lot.depthFt,
      innerRadiusFt: lot.innerRadiusFt,
      streetLetter: lot.streetLetter,
      year: lot.year,
      frontsToMan: lot.frontsToMan,
    },
    objects: rows.map(toObjRow),
  };
}
