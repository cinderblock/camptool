/**
 * Phase 3 — camp map editor. Tenant-scoped, so every row carries a `camp_id`
 * (the hard multi-camp invariant).
 *
 *   placement   the camp's assigned BRC lot (the outer trapezoid wedge).
 *               One current lot per camp (camp_id is unique).
 *   map_object  a structure the camp places inside its lot (tent, RV, shade,
 *               kitchen, art, generator, …).
 *
 * Coordinate model: map_object geometry is **plot-local feet**. Origin is the
 * lot's front-left corner; +x runs along the street frontage, +y runs into the
 * lot away from the street (toward the back / away from the Man). This keeps a
 * camp's internal layout independent of where its lot lands in the city each
 * year — only the `placement` row's city anchoring changes, not every object.
 * Floats are `real` (→ double precision on Postgres) to keep the door open.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp, membership } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const placement = sqliteTable(
  "placement",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    // City anchoring (free-text for now; the map editor reads `innerRadiusFt`
    // to draw the wedge taper). e.g. street "Ellison", address "3:00".
    street: text("street"),
    address: text("address"),
    frontageFt: real("frontage_ft").notNull().default(100),
    depthFt: real("depth_ft").notNull().default(100),
    // Distance from the Man to the frontage street center. Drives the trapezoid
    // taper (rear edge = frontage + frontage*depth/innerRadius). Null → render
    // the lot as a plain rectangle (no taper).
    innerRadiusFt: real("inner_radius_ft"),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [uniqueIndex("placement_camp").on(t.campId)],
);

export const mapObject = sqliteTable(
  "map_object",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    name: text("name"),
    kind: text("kind").notNull().default("structure"),
    // The camper bringing this item; NULL = a camp/shared/communal item.
    ownerMembershipId: text("owner_membership_id").references(
      () => membership.id,
      { onDelete: "set null" },
    ),
    // Declared-but-unplaced items sit in the officer queue (placed = false);
    // placed items have a position on the map.
    placed: integer("placed", { mode: "boolean" }).notNull().default(false),
    // Plot-local feet (see file header). Meaningful only when placed.
    x: real("x").notNull().default(0),
    y: real("y").notNull().default(0),
    width: real("width").notNull().default(10),
    height: real("height").notNull().default(10),
    rotation: real("rotation").notNull().default(0),
    color: text("color"),
    notes: text("notes"),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("map_object_camp").on(t.campId)],
);

/** Occupants of a structure/vehicle — lets a camper add a second+ person to
 * their tent / car / RV. The owner is also an occupant. */
export const mapObjectOccupant = sqliteTable(
  "map_object_occupant",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    objectId: text("object_id")
      .notNull()
      .references(() => mapObject.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("map_object_occupant_unique").on(t.objectId, t.membershipId),
    index("map_object_occupant_object").on(t.objectId),
  ],
);
