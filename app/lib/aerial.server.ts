/**
 * Aerial photos under the camp map — loading and the officer intents (see
 * plans/map-aerial-photo.md). Kept out of routes/dashboard/map.tsx, which is
 * long enough already; the map route calls into here.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campImage, mapAerial } from "../../db/schema";
import { type AerialRow, cleanCrop, normDeg } from "./aerial";

export type { AerialRow };
import { getImage } from "./images.server";

export async function loadAerials(
  campId: string,
  editionId: string,
): Promise<AerialRow[]> {
  const rows = await db
    .select({
      a: mapAerial,
      displayMimeType: campImage.displayMimeType,
    })
    .from(mapAerial)
    .innerJoin(
      campImage,
      and(eq(campImage.id, mapAerial.imageId), eq(campImage.campId, campId)),
    )
    .where(
      and(eq(mapAerial.campId, campId), eq(mapAerial.editionId, editionId)),
    )
    .orderBy(asc(mapAerial.createdAt));
  return rows.map(({ a, displayMimeType }) => ({
    id: a.id,
    imageId: a.imageId,
    label: a.label,
    pxWidth: a.pxWidth,
    pxHeight: a.pxHeight,
    cx: a.cx,
    cy: a.cy,
    ftPerPx: a.ftPerPx,
    rotation: a.rotation,
    opacity: a.opacity,
    cropX0: a.cropX0,
    cropY0: a.cropY0,
    cropX1: a.cropX1,
    cropY1: a.cropY1,
    visible: a.visible,
    clipToLot: a.clipToLot,
    hasDisplay: !!displayMimeType,
  }));
}

export const AERIAL_INTENTS = new Set([
  "addAerial",
  "updateAerial",
  "deleteAerial",
]);

// Generous bounds: a photo may be placed well off the lot (it shows the
// street and neighbours), but not at absurd numbers that would wreck the view.
const FT_LIMIT = 5000;
const finite = (v: FormDataEntryValue | null): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bounded = (n: number | null, lo: number, hi: number) =>
  n == null ? null : Math.min(hi, Math.max(lo, n));

/**
 * Handle one aerial intent. The caller has already checked the viewer is an
 * officer of this camp with the map feature on. Deliberately NOT blocked by a
 * locked year: the photo of what got built shows up after the event, which is
 * exactly when years get locked, and it doesn't change the plan.
 */
export async function aerialAction(opts: {
  intent: string;
  form: FormData;
  campId: string;
  editionId: string;
  userId: string;
}): Promise<{ ok: true; id?: string } | { error: string; status: number }> {
  const { intent, form, campId, editionId } = opts;

  if (intent === "addAerial") {
    const imageId = String(form.get("imageId") ?? "");
    const image = imageId ? await getImage(campId, imageId) : null;
    if (!image) return { error: "That picture isn't here.", status: 404 };
    const pxWidth = finite(form.get("pxWidth")) ?? image.width;
    const pxHeight = finite(form.get("pxHeight")) ?? image.height;
    if (!pxWidth || !pxHeight || pxWidth < 1 || pxHeight < 1) {
      return {
        error: "Couldn't read that picture's size — try a PNG or JPEG.",
        status: 400,
      };
    }
    const id = crypto.randomUUID();
    await db.insert(mapAerial).values({
      id,
      campId,
      editionId,
      imageId: image.id,
      label: cleanLabel(form.get("label")) ?? cleanLabel(image.filename),
      pxWidth: Math.round(pxWidth),
      pxHeight: Math.round(pxHeight),
      ...geometryFrom(form),
      createdById: opts.userId,
    });
    return { ok: true, id };
  }

  const id = String(form.get("aerialId") ?? "");
  const where = and(
    eq(mapAerial.id, id),
    eq(mapAerial.campId, campId),
    eq(mapAerial.editionId, editionId),
  );
  const [row] = await db.select().from(mapAerial).where(where).limit(1);
  if (!row) return { error: "That photo is gone.", status: 404 };

  if (intent === "deleteAerial") {
    // The picture itself stays in the camp's images: it may be used
    // elsewhere, and a mistaken delete here shouldn't lose the original.
    await db.delete(mapAerial).where(where);
    return { ok: true };
  }

  // updateAerial — only the fields that came in change.
  const set: Partial<typeof mapAerial.$inferInsert> = {
    ...geometryFrom(form),
    updatedAt: new Date(),
  };
  if (form.has("label")) set.label = cleanLabel(form.get("label"));
  if (form.has("visible")) set.visible = form.get("visible") === "true";
  if (form.has("clipToLot")) {
    set.clipToLot = form.get("clipToLot") === "true";
  }
  if (["cropX0", "cropY0", "cropX1", "cropY1"].some((k) => form.has(k))) {
    Object.assign(
      set,
      cleanCrop(
        finite(form.get("cropX0")) ?? row.cropX0,
        finite(form.get("cropY0")) ?? row.cropY0,
        finite(form.get("cropX1")) ?? row.cropX1,
        finite(form.get("cropY1")) ?? row.cropY1,
      ),
    );
  }
  await db.update(mapAerial).set(set).where(where);
  return { ok: true };
}

function cleanLabel(v: FormDataEntryValue | string | null): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim().slice(0, 80);
  return s || null;
}

/** The transform fields present in the form, clamped to sane ranges. */
function geometryFrom(form: FormData) {
  const out: {
    cx?: number;
    cy?: number;
    ftPerPx?: number;
    rotation?: number;
    opacity?: number;
  } = {};
  const cx = bounded(finite(form.get("cx")), -FT_LIMIT, FT_LIMIT);
  const cy = bounded(finite(form.get("cy")), -FT_LIMIT, FT_LIMIT);
  // 1 mm to 10 ft per pixel covers phone shots to satellite tiles.
  const ftPerPx = bounded(finite(form.get("ftPerPx")), 0.003, 10);
  const rotation = finite(form.get("rotation"));
  const opacity = bounded(finite(form.get("opacity")), 0.05, 1);
  if (cx != null) out.cx = cx;
  if (cy != null) out.cy = cy;
  if (ftPerPx != null) out.ftPerPx = ftPerPx;
  if (rotation != null) out.rotation = normDeg(rotation);
  if (opacity != null) out.opacity = opacity;
  return out;
}
