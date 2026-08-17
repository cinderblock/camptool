/**
 * Uploaded pictures (see plans/pictures-in-bodies.md).
 *
 * The row is METADATA ONLY — the bytes live on disk in the data dir beside the
 * SQLite file (`<UPLOADS_PATH>/<camp_id>/<id>`), because originals are kept at
 * full resolution and a whole camp's photo archive does not belong in a
 * database file that gets downloaded whole.
 *
 * Consequence, written down where it can't be missed: `/export-db` is
 * therefore NOT a complete backup any more. The uploads directory has to be
 * backed up alongside it (docs/firefly-deploy.md says so too).
 *
 * CAMP-scoped and deliberately not tied to a page or an answer: the same photo
 * belongs in a wiki page AND an FAQ answer, and it should outlive whichever
 * body first used it.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { camp } from "./camp";

const now = sql`(unixepoch() * 1000)`;

export const campImage = sqliteTable(
  "camp_image",
  {
    id: text("id").primaryKey(),
    campId: text("camp_id")
      .notNull()
      .references(() => camp.id, { onDelete: "cascade" }),
    /**
     * What the uploader called it. Metadata only — it names the download and
     * seeds the alt text. It NEVER becomes part of a path; the file is stored
     * under the camp id and this row's uuid, which is the path-traversal
     * defence.
     */
    filename: text("filename").notNull(),
    /** Sniffed from the file's magic bytes at upload, never the browser's claim. */
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    /**
     * The browser-made, max-1600px WebP stored alongside the original as
     * `<id>.display`. Null when the browser couldn't make one (or the original
     * was already small enough), in which case the original is served for
     * display too.
     */
    displayMimeType: text("display_mime_type"),
    displayByteSize: integer("display_byte_size"),
    uploadedById: text("uploaded_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => [index("camp_image_camp").on(t.campId, t.createdAt)],
);
