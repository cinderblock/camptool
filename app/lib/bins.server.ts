/**
 * bins integration — server helpers (see plans/bins-integration.md).
 *
 * The camp's bins instance is a separate app (offline-first QR inventory
 * tracker). We do not mirror its data; we hand the member a link that opens it
 * already signed in. bins joins a device by visiting `/join#<accessCode>`, the
 * code riding in the URL FRAGMENT so it never reaches bins' server logs.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { campBins } from "../../db/schema";

export type BinsLink = typeof campBins.$inferSelect;

export async function getBinsLink(campId: string): Promise<BinsLink | null> {
  const [row] = await db
    .select()
    .from(campBins)
    .where(eq(campBins.campId, campId))
    .limit(1);
  return row ?? null;
}

/**
 * What the top bar needs — deliberately WITHOUT the access code. The menu item
 * renders on every page, so the secret must not ride along in the loader
 * payload; it is only ever emitted in the redirect at click time.
 */
export async function getBinsMenu(
  campId: string,
): Promise<{ label: string } | null> {
  const link = await getBinsLink(campId);
  if (!link?.baseUrl) return null;
  return { label: link.label?.trim() || "Bins" };
}

/** Normalize an operator-typed origin: require http(s), drop any trailing path. */
export function normalizeBinsUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Only the origin matters; the paths we build are bins' own.
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Where a click should land. With a code, that's bins' join target, which
 * signs the device in; without one, just the app (bins will show its landing
 * page and ask for a code, which is a reasonable fallback rather than an error).
 */
export function binsEntryUrl(link: BinsLink): string {
  const code = link.accessCode?.trim();
  return code
    ? `${link.baseUrl}/join#${encodeURIComponent(code)}`
    : link.baseUrl;
}

export async function setBinsLink(opts: {
  campId: string;
  baseUrl: string;
  accessCode: string | null;
  label: string | null;
  updatedByMembershipId: string;
}): Promise<void> {
  const existing = await getBinsLink(opts.campId);
  if (existing) {
    await db
      .update(campBins)
      .set({
        baseUrl: opts.baseUrl,
        accessCode: opts.accessCode,
        label: opts.label,
        updatedByMembershipId: opts.updatedByMembershipId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(campBins.id, existing.id), eq(campBins.campId, opts.campId)),
      );
    return;
  }
  await db.insert(campBins).values({
    id: crypto.randomUUID(),
    campId: opts.campId,
    baseUrl: opts.baseUrl,
    accessCode: opts.accessCode,
    label: opts.label,
    updatedByMembershipId: opts.updatedByMembershipId,
  });
}

export async function clearBinsLink(campId: string): Promise<void> {
  await db.delete(campBins).where(eq(campBins.campId, campId));
}
