/**
 * Uploaded pictures — pure helpers (see plans/pictures-in-bodies.md).
 * Client-safe: imported by the editor, the renderer, and the server halves.
 */

/* ------------------------------------------------------------ what we take */

/**
 * The allowlist. **SVG is deliberately absent** — it is a scriptable document,
 * and this app serves uploaded bytes back to logged-in members of the same
 * camp. There is no safe way to inline an untrusted SVG without sanitising it,
 * so it simply isn't an image format here.
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** Generous, because full-resolution originals are the point — but not
 * unbounded. A 25 MP phone JPEG is ~10 MB; a big PNG screenshot far less. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Longest edge of the browser-generated display copy. */
export const DISPLAY_MAX_EDGE = 1600;

/**
 * Identify an image from its MAGIC BYTES, ignoring whatever the browser
 * claimed. The declared type is attacker-controlled and this file gets served
 * back with a Content-Type; sniffing is what makes that safe.
 *
 * Returns null for anything not on the allowlist — including SVG, which looks
 * like text and would otherwise sail through a `startsWith("image/")` check.
 */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  const at = (i: number) => bytes[i];
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" | "GIF89a"
  if (
    bytes.length >= 6 &&
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38 &&
    (at(4) === 0x37 || at(4) === 0x39) &&
    at(5) === 0x61
  ) {
    return "image/gif";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/* --------------------------------------------------------- src validation */

/** A `/media/<uuid>` reference, as written in a body. */
const MEDIA_PATH_RE =
  /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type ImageSrc =
  | { kind: "upload"; id: string; src: string }
  | { kind: "external"; src: string };

/**
 * Decide whether a body's `![alt](src)` may become an `<img src>` at all.
 *
 * Renderers must call this rather than passing the raw string through: the
 * body is member-authored, and `javascript:`/`data:` in a src is the same
 * class of hole as innerHTML. Anything unrecognised returns null and the
 * renderer falls back to showing the alt text.
 */
export function resolveImageSrc(raw: string): ImageSrc | null {
  const src = raw.trim();
  if (!src) return null;
  const media = MEDIA_PATH_RE.exec(src);
  if (media?.[1]) return { kind: "upload", id: media[1], src };
  // Parsed, not pattern-matched: `java\tscript:` and friends don't survive
  // URL parsing, and the protocol check is then exact.
  try {
    const url = new URL(src);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "external", src: url.toString() };
    }
  } catch {
    // Not an absolute URL, and not one of ours.
  }
  return null;
}

/** The full-resolution original behind a display image. */
export function fullSizeHref(id: string): string {
  return `/media/${id}/full`;
}

/* ------------------------------------------------------------- references */

const MEDIA_REF_RE =
  /\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * Every uploaded image a body refers to. Used to tell which pictures are still
 * in use — the cheap, correct way to find orphans, since a camp has dozens of
 * bodies rather than millions.
 */
export function imageRefs(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MEDIA_REF_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** `1.4 MB` — shown next to a picture in the editor's library. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
