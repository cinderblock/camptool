/**
 * Starting, renaming and removing camps on a shared site
 * (plans/hosting-other-camps.md, step 9).
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db/client.server";
import { camp, campSetupLink, membership } from "../../db/schema";
import { blobs } from "./blobs.server";
import { isValidCampSlug, RESERVED_SLUGS } from "./camp-host";
import { newInviteToken } from "./invite.server";

/** How long a camp setup link stays good. */
export const SETUP_LINK_DAYS = 30;

/** Why a camp address can't be used, or null when it can. */
export async function slugProblem(
  slug: string,
  exceptCampId?: string,
): Promise<string | null> {
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved.";
  if (!isValidCampSlug(slug)) {
    return "Use lowercase letters, numbers and dashes (not at the start or end).";
  }
  const [taken] = await db
    .select({ id: camp.id })
    .from(camp)
    .where(
      exceptCampId
        ? and(eq(camp.slug, slug), ne(camp.id, exceptCampId))
        : eq(camp.slug, slug),
    )
    .limit(1);
  return taken ? "Another camp already has that address." : null;
}

/** Make a camp with `userId` as its first admin. Returns its id, or why not. */
export async function createCamp(opts: {
  userId: string;
  name: string;
  slug: string;
}): Promise<{ ok: true; campId: string } | { ok: false; error: string }> {
  const name = opts.name.trim();
  if (!name) return { ok: false, error: "Give the camp a name." };
  if (name.length > 100) return { ok: false, error: "That name is too long." };
  const problem = await slugProblem(opts.slug);
  if (problem) return { ok: false, error: problem };
  const campId = crypto.randomUUID();
  await db.insert(camp).values({ id: campId, name, slug: opts.slug });
  await db.insert(membership).values({
    id: crypto.randomUUID(),
    organizationId: campId,
    userId: opts.userId,
    role: "admin",
    status: "active",
  });
  return { ok: true, campId };
}

/** Give a camp a new address. */
export async function renameCampSlug(
  campId: string,
  slug: string,
): Promise<string | null> {
  const problem = await slugProblem(slug, campId);
  if (problem) return problem;
  await db.update(camp).set({ slug }).where(eq(camp.id, campId));
  return null;
}

/**
 * Remove a camp and everything in it. Every camp-scoped table cascades from
 * `camp` (telemetry keeps its rows with the camp cleared), so one delete takes
 * the data; its uploaded files go after, since a stray file is harmless and a
 * row pointing at a missing file is not.
 */
export async function deleteCamp(campId: string): Promise<void> {
  await db.delete(camp).where(eq(camp.id, campId));
  const prefix = `${campId}/`;
  for (const f of await blobs.list()) {
    if (f.key.startsWith(prefix)) await blobs.delete(f.key);
  }
}

/** A new camp setup link for `label`. Returns its token. */
export async function createSetupLink(opts: {
  label: string;
  createdByUserId: string;
}): Promise<string> {
  const token = newInviteToken();
  await db.insert(campSetupLink).values({
    id: crypto.randomUUID(),
    token,
    label: opts.label.trim().slice(0, 100) || "Camp lead",
    createdByUserId: opts.createdByUserId,
    expiresAt: new Date(Date.now() + SETUP_LINK_DAYS * 86_400_000),
  });
  return token;
}

export type SetupLinkState = "ok" | "used" | "revoked" | "expired";

export function setupLinkState(row: {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): SetupLinkState {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "ok";
}

export async function findSetupLink(token: string) {
  const [row] = await db
    .select()
    .from(campSetupLink)
    .where(eq(campSetupLink.token, token))
    .limit(1);
  return row ?? null;
}

/** Claim a link for `userId`, only if it's still unused. False when someone
 * beat us to it. Claimed before the camp is made, so two tabs can't make two
 * camps from one link; `releaseSetupLink` undoes it if making the camp fails. */
export async function claimSetupLink(
  id: string,
  userId: string,
): Promise<boolean> {
  const done = await db
    .update(campSetupLink)
    .set({ usedAt: new Date(), usedByUserId: userId })
    .where(and(eq(campSetupLink.id, id), isNull(campSetupLink.usedAt)))
    .returning({ id: campSetupLink.id });
  return done.length > 0;
}

export async function releaseSetupLink(id: string): Promise<void> {
  await db
    .update(campSetupLink)
    .set({ usedAt: null, usedByUserId: null })
    .where(eq(campSetupLink.id, id));
}

export async function recordSetupLinkCamp(
  id: string,
  campId: string,
): Promise<void> {
  await db
    .update(campSetupLink)
    .set({ campId })
    .where(eq(campSetupLink.id, id));
}
