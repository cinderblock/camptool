/**
 * Upload a picture (see plans/pictures-in-bodies.md).
 *
 * Takes two parts: `file`, the untouched full-resolution original, and an
 * optional `display`, the max-1600px WebP the browser made. Storing both is
 * what lets pages stay light without throwing away the original.
 *
 * The stored type comes from SNIFFING the bytes. A browser-declared MIME type
 * is attacker-controlled, and these bytes get served back with a Content-Type.
 */
import { data } from "react-router";
import { featureVisibleTo } from "~/lib/features";
import { loadFeatureStates } from "~/lib/features.server";
import { MAX_IMAGE_BYTES, sniffImageType } from "~/lib/images";
import { saveImage } from "~/lib/images.server";
import { hasAtLeast } from "~/lib/permissions";
import { requireActiveCamp } from "~/lib/session.server";
import type { Route } from "./+types/api.media";

/** Metadata only — it never becomes part of a path (the file is stored under
 * the camp id and a uuid), but it does name the download. */
function cleanFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  return base.replace(/\s+/g, " ").trim().slice(0, 120) || "picture";
}

/** Strip the extension for the default alt text: "shade-frame.jpg" reads
 * better in a caption as "shade-frame". */
function altFrom(filename: string): string {
  return filename.replace(/\.[a-z0-9]{1,5}$/i, "");
}

const num = (v: FormDataEntryValue | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

export async function action({ request }: Route.ActionArgs) {
  const { user: actor, active } = await requireActiveCamp(request);

  // Who may upload follows who may WRITE something that takes a picture, so
  // there is no way to use this route to get around either feature's gate.
  const states = await loadFeatureStates(active.camp.id);
  const role = active.membership.role;
  const canWiki =
    featureVisibleTo(states.get("wiki") ?? "off", role) &&
    hasAtLeast(role, "member");
  const canFaq =
    featureVisibleTo(states.get("faq") ?? "off", role) &&
    hasAtLeast(role, "officer");
  if (!canWiki && !canFaq) {
    return data({ error: "You can't add pictures here." }, { status: 403 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return data({ error: "No picture came through." }, { status: 400 });
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return data(
      { error: `That picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    return data(
      {
        error: "That isn't a picture CampTool can take (PNG, JPEG, GIF, WebP).",
      },
      { status: 415 },
    );
  }

  // The display copy is an optimization, never a requirement: if it's missing,
  // malformed, or somehow bigger than the original, drop it and serve the
  // original for display too.
  let display: { bytes: Uint8Array; mimeType: typeof mimeType } | null = null;
  const variant = form.get("display");
  if (variant instanceof File && variant.size > 0 && variant.size < file.size) {
    const variantBytes = new Uint8Array(await variant.arrayBuffer());
    const variantType = sniffImageType(variantBytes);
    if (variantType) display = { bytes: variantBytes, mimeType: variantType };
  }

  const filename = cleanFilename(file.name);
  const saved = await saveImage({
    campId: active.camp.id,
    filename,
    mimeType,
    bytes,
    width: num(form.get("width")),
    height: num(form.get("height")),
    display,
    userId: actor.id,
  });

  return data({
    ok: true,
    id: saved.id,
    src: `/media/${saved.id}`,
    alt: altFrom(filename),
  });
}
