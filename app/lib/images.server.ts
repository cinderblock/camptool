/**
 * Uploaded pictures — the disk half (see plans/pictures-in-bodies.md).
 *
 * Bytes live in the host's blob store (a directory beside the SQLite file, or
 * an R2 bucket on Cloudflare); the database holds only the metadata row.
 * Every function is camp-scoped, and every key is built from a camp id plus
 * this row's uuid — never from anything a user typed.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campImage, faqEntry, mapAerial, wikiPage } from "../../db/schema";
import { blobs, imageKey, type StoredBlob } from "./blobs.server";
import { type ImageMimeType, imageRefs } from "./images";

export type CampImageRow = typeof campImage.$inferSelect;

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
  // Files first: a metadata row pointing at bytes that failed to land would
  // render as a broken picture, whereas an orphaned file is merely wasted space.
  await blobs.put(imageKey(opts.campId, id, "full"), opts.bytes);
  if (opts.display) {
    await blobs.put(imageKey(opts.campId, id, "display"), opts.display.bytes);
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
 * The stored bytes, as a stream-able handle — an original is full-resolution
 * and must never be read into memory just to be handed to the client. Null
 * when the file is missing.
 *
 * Falls back to the original when a display variant was never made.
 */
export async function imageFile(
  row: CampImageRow,
  variant: "full" | "display",
): Promise<{ file: StoredBlob; mimeType: string } | null> {
  const useDisplay = variant === "display" && !!row.displayMimeType;
  const file = await blobs.get(
    imageKey(row.campId, row.id, useDisplay ? "display" : "full"),
  );
  if (!file) return null;
  return {
    file,
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
  const found = await imageFile(row, variant);
  if (!found) return new Response("Not found", { status: 404 });
  const { file, mimeType } = found;
  return new Response(file.stream(), {
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
  await blobs.delete(imageKey(campId, id, "full"));
  await blobs.delete(imageKey(campId, id, "display"));
}

/**
 * Pictures no body refers to any more. Editing a page to drop an image can't
 * delete it (another page may use the same one), so the only correct answer is
 * to ask every body at once — cheap, because a camp has dozens of pages and
 * answers, not millions.
 */
export async function unusedImageIds(campId: string): Promise<Set<string>> {
  const [images, pages, answers, aerials] = await Promise.all([
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
    // An aerial photo under the map is a use too, with no body to scan.
    db
      .select({ id: mapAerial.imageId })
      .from(mapAerial)
      .where(eq(mapAerial.campId, campId)),
  ]);
  const used = new Set<string>(aerials.map((a) => a.id.toLowerCase()));
  for (const { body } of [...pages, ...answers]) {
    for (const ref of imageRefs(body)) used.add(ref);
  }
  return new Set(
    images.map((i) => i.id).filter((id) => !used.has(id.toLowerCase())),
  );
}
