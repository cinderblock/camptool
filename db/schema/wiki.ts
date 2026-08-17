/**
 * Camp wiki — free-form pages any member can edit (see plans/camp-wiki.md).
 *
 * CAMP-scoped, not edition-scoped: wiki knowledge ("how the swamp cooler is
 * plumbed", "how we raise the Sierpinski pyramid") persists across years, like
 * `camp_document`. Gated by the `wiki` camp feature (off by default).
 *
 * Three tables:
 *  - `wiki_page`     the page itself (unique slug per camp)
 *  - `wiki_revision` a snapshot of the body BEFORE each save, so "any member
 *                    can edit" is non-destructive — history + restore
 *  - `wiki_link`     ties a page to a thing elsewhere in the app (a structure
 *                    kind, a placed map object, a gathering, …). Subject types
 *                    are an open text column with a code registry in
 *                    app/lib/wiki.ts, so a new subject kind costs no migration.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const wikiPage = sqliteTable(
  "wiki_page",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /** URL key, unique within the camp. Derived from the title on create. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Body in the app's markdown subset (see app/lib/wiki.ts). */
    body: text("body").notNull().default(""),
    // Nullable so deleting a user doesn't take the page with them (the FK is
    // ON DELETE SET NULL — a NOT NULL column would make that delete fail).
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedById: text("updated_by_id").references(() => user.id, {
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
    index("wiki_page_camp").on(t.campId),
    uniqueIndex("wiki_page_slug_unique").on(t.campId, t.slug),
  ],
);

export const wikiRevision = sqliteTable(
  "wiki_revision",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPage.id, { onDelete: "cascade" }),
    // Denormalized tenant key: lets history be queried/scoped without a join,
    // and keeps the multi-camp invariant visible on every row.
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /** The title + body as they were BEFORE the save that created this row. */
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Optional "what changed" note from the editor. */
    summary: text("summary"),
    editedById: text("edited_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    editedAt: integer("edited_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    index("wiki_revision_page").on(t.pageId, t.editedAt),
    index("wiki_revision_camp").on(t.campId),
  ],
);

export const wikiLink = sqliteTable(
  "wiki_link",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPage.id, { onDelete: "cascade" }),
    /** Registry key from app/lib/wiki.ts: structure_kind | map_object | … */
    subjectType: text("subject_type").notNull(),
    /**
     * The subject's identity in ITS OWN namespace — a `Kind.value` for
     * structure_kind, a row id for map_object/gathering/…. Deliberately not a
     * foreign key: subject types span many tables, and a link to a since-deleted
     * object should degrade to a dangling chip, not cascade the page away.
     */
    subjectId: text("subject_id").notNull(),
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [
    uniqueIndex("wiki_link_unique").on(t.pageId, t.subjectType, t.subjectId),
    // The reverse lookup: "does this structure/object have a page?"
    index("wiki_link_subject").on(t.campId, t.subjectType, t.subjectId),
  ],
);
