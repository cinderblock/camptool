/**
 * Uploaded pictures — the disk half (see plans/pictures-in-bodies.md).
 *
 * Bytes live in the data dir beside the SQLite file; SQLite holds only the
 * metadata row. Every function is camp-scoped, and every path is built from a
 * camp id plus this row's uuid — never from anything a user typed.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campImage, faqEntry, wikiPage } from "../../db/schema";
import { type ImageMimeType, imageRefs } from "./images";

export type CampImageRow = typeof campImage.$inferSelect;

/**
 * Where the files go. Defaults to `uploads/` next to the database, which on
 * firefly is `/srv/camptool/data/uploads` — a directory that already exists and
 * survives deploys, so standing this up needed no ops change.
 */
export function uploadsRoot(): string {
  const explicit = process.env.UPLOADS_PATH?.trim();
  if (explicit) return explicit;
  const dbPath = process.env.DATABASE_PATH ?? "./data/camptool.db";
  return join(dirname(dbPath), "uploads");
}

/** `<root>/<camp>/<id>` — a camp's pictures are one directory, so they can be
 * archived or dropped as a unit and no single directory holds every camp. */
function filePath(campId: string, id: string, variant: "full" | "display") {
  return join(uploadsRoot(), campId, variant === "full" ? id : `${id}.display`);
}

export async function saveImage(opts: {
  campId: string;
  filename: string;
  mimeType: ImageMimeType;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
  /** The browser's downscaled WebP, when it managed to make one. */
  display: { bytes: Uint8Array; mimeType: ImageMimeType } | null;
  userId: string;
}): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await mkdir(join(uploadsRoot(), opts.campId), { recursive: true });
  // Files first: a metadata row pointing at bytes that failed to land would
  // render as a broken picture, whereas an orphaned file is merely wasted space.
  await Bun.write(filePath(opts.campId, id, "full"), opts.bytes);
  if (opts.display) {
    await Bun.write(filePath(opts.campId, id, "display"), opts.display.bytes);
  }
  await db.insert(campImage).values({
    id,
    campId: opts.campId,
    filename: opts.filename,
    mimeType: opts.mimeType,
    byteSize: opts.bytes.byteLength,
    width: opts.width,
    height: opts.height,
    displayMimeType: opts.display?.mimeType ?? null,
    displayByteSize: opts.display?.bytes.byteLength ?? null,
    uploadedById: opts.userId,
  });
  return { id };
}

export async function getImage(
  campId: string,
  id: string,
): Promise<CampImageRow | null> {
  const [row] = await db
    .select()
    .from(campImage)
    .where(and(eq(campImage.campId, campId), eq(campImage.id, id)))
    .limit(1);
  return row ?? null;
}

export function listImages(campId: string) {
  return db
    .select({
      id: campImage.id,
      filename: campImage.filename,
      byteSize: campImage.byteSize,
      width: campImage.width,
      height: campImage.height,
      createdAt: campImage.createdAt,
    })
    .from(campImage)
    .where(eq(campImage.campId, campId))
    .orderBy(desc(campImage.createdAt));
}

/**
 * The bytes, as a lazy handle. Returned to the route as a `Bun.file`, which a
 * `Response` streams — an original is full-resolution and must never be read
 * into memory just to be handed to the client.
 *
 * Falls back to the original when a display variant was never made.
 */
export function imageFile(
  row: CampImageRow,
  variant: "full" | "display",
): { file: ReturnType<typeof Bun.file>; mimeType: string } {
  const useDisplay = variant === "display" && !!row.displayMimeType;
  return {
    file: Bun.file(
      filePath(row.campId, row.id, useDisplay ? "display" : "full"),
    ),
    mimeType: useDisplay ? (row.displayMimeType as string) : row.mimeType,
  };
}

/**
 * The shared body of both /media routes: authorize, then stream.
 *
 * Camp scoping is the security boundary — an id from another camp must be
 * indistinguishable from one that doesn't exist, which is why this looks up
 * by (campId, id) rather than by id and then checking.
 */
export async function serveImage(
  campId: string,
  id: string,
  variant: "full" | "display",
): Promise<Response> {
  const row = await getImage(campId, id);
  if (!row) return new Response("Not found", { status: 404 });
  const { file, mimeType } = imageFile(row, variant);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "content-type": mimeType,
      "content-length": String(file.size),
      // Bytes at an id never change, so cache hard — but `private`, because a
      // shared cache has no business holding a camp's photos.
      "cache-control": "private, max-age=31536000, immutable",
      // Belt and braces around an uploaded file: never sniff it into something
      // executable, and give it no privileges if it is ever framed.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `inline; filename="${downloadName(row.filename)}"`,
    },
  });
}

/** Quotes and control characters would break out of the header; strip them. */
function downloadName(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  return filename.replace(/[\u0000-\u001f"\\]/g, "").slice(0, 100) || "picture";
}

export async function deleteImage(campId: string, id: string): Promise<void> {
  const row = await getImage(campId, id);
  if (!row) return;
  // Row first this time: a missing file behind a live row is a broken image on
  // a page, which is worse than a leftover file nothing points at.
  await db
    .delete(campImage)
    .where(and(eq(campImage.campId, campId), eq(campImage.id, id)));
  await rm(filePath(campId, id, "full"), { force: true });
  await rm(filePath(campId, id, "display"), { force: true });
}

/**
 * Pictures no body refers to any more. Editing a page to drop an image can't
 * delete it (another page may use the same one), so the only correct answer is
 * to ask every body at once — cheap, because a camp has dozens of pages and
 * answers, not millions.
 */
export async function unusedImageIds(campId: string): Promise<Set<string>> {
  const [images, pages, answers] = await Promise.all([
    db
      .select({ id: campImage.id })
      .from(campImage)
      .where(eq(campImage.campId, campId)),
    db
      .select({ body: wikiPage.body })
      .from(wikiPage)
      .where(eq(wikiPage.campId, campId)),
    db
      .select({ body: faqEntry.answer })
      .from(faqEntry)
      .where(eq(faqEntry.campId, campId)),
  ]);
  const used = new Set<string>();
  for (const { body } of [...pages, ...answers]) {
    for (const ref of imageRefs(body)) used.add(ref);
  }
  return new Set(
    images.map((i) => i.id).filter((id) => !used.has(id.toLowerCase())),
  );
}
