/**
 * Camp-defined structure kinds (see plans/custom-structures.md).
 *
 * A camp's officers define their own map structures in the app; each row is
 * one palette entry, alongside the built-in kinds and any build-time structure
 * packs. CAMP-scoped, not edition-scoped: a camp's kitchen shape carries from
 * year to year, and per-year control stays on the edition's banned kinds.
 *
 * `value` is what `map_object.kind` (and banned-kind lists, wiki kind links,
 * …) store. It is generated once (`x-<random>`) and never changes, so renaming
 * a kind touches nothing that references it. The `x-` prefix keeps it apart
 * from built-in and pack kind values.
 *
 * Sizes follow `map_object`: feet, `width` along the street frontage, `height`
 * into the lot, `tall_ft` above the ground.
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
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const structureKind = sqliteTable(
  "structure_kind",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /** The kind string objects store: `x-<random>`, unique site-wide. */
    value: text("value").notNull(),
    label: text("label").notNull(),
    /** Legend group heading. */
    groupName: text("group_name").notNull().default("Camp"),
    color: text("color").notNull().default("#868e96"),
    /** `rect` | `hexagon` | `round` | `outline` (see app/lib/custom-kinds.tsx). */
    shape: text("shape").notNull().default("rect"),
    /** Default footprint of a new object, feet. */
    width: real("width").notNull().default(10),
    height: real("height").notNull().default(10),
    /** For `outline`: JSON `[{x,y}, …]`, each 0..1 of the width/height box, so
     * the outline scales when an object is resized. NULL otherwise. */
    outline: text("outline"),
    /** Default height above the ground, feet (shade sim, radio line of sight). */
    tallFt: real("tall_ft").notNull().default(8),
    /** Shade cloth on legs: blocks sun, not wind or radio. */
    canopyShade: integer("canopy_shade", { mode: "boolean" })
      .notNull()
      .default(false),
    /** JSON array of highlight tags: `domicile` / `vehicle` / `structure`. */
    tags: text("tags").notNull().default('["structure"]'),
    /** Campers may declare their own (Bringing page, onboarding wizard). */
    personal: integer("personal", { mode: "boolean" }).notNull().default(false),
    /** Fixed size: no free resize on the map. */
    rigid: integer("rigid", { mode: "boolean" }).notNull().default(false),
    /** No meaningful facing: no rotate handle. */
    fixedRotation: integer("fixed_rotation", { mode: "boolean" })
      .notNull()
      .default(false),
    description: text("description"),
    /** Order within its legend group. */
    sort: integer("sort").notNull().default(0),
    /** Archived kinds leave the palettes but still draw saved objects. */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
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
  (t) => [
    index("structure_kind_camp").on(t.campId),
    uniqueIndex("structure_kind_value_unique").on(t.value),
  ],
);
