/**
 * Browser-side image preparation (see plans/pictures-in-bodies.md).
 *
 * The ORIGINAL is uploaded untouched — full resolution is a locked decision.
 * This only produces an EXTRA, smaller copy for on-page display, so a wiki page
 * full of 12 MP phone photos doesn't cost a member ten megabytes on a
 * playa-grade connection.
 *
 * Doing it here rather than on the server is what keeps `sharp` (a native
 * dependency) out of the repo — Bun has no built-in resizer. Every failure
 * path returns `display: null`, which is fine: the server then serves the
 * original for display too.
 */
import { DISPLAY_MAX_EDGE } from "./images";

export type PreparedUpload = {
  width: number | null;
  height: number | null;
  display: Blob | null;
};

const NOTHING: PreparedUpload = { width: null, height: null, display: null };

export async function prepareUpload(file: File): Promise<PreparedUpload> {
  if (typeof createImageBitmap !== "function") return NOTHING;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies EXIF orientation, so a photo taken sideways doesn't
    // become a sideways thumbnail.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return NOTHING;
  }

  const { width, height } = bitmap;
  const dimensions = { width, height };
  const longest = Math.max(width, height);

  // A GIF drawn to a canvas loses its animation — and an animated GIF is
  // usually the whole point of posting one. Keep the dimensions, skip the copy.
  if (file.type === "image/gif" || longest <= DISPLAY_MAX_EDGE) {
    bitmap.close();
    return { ...dimensions, display: null };
  }

  const scale = DISPLAY_MAX_EDGE / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return { ...dimensions, display: null };
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const display = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.82);
  });
  return { ...dimensions, display };
}
