import { eq } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "../../db/client.server";
import { camp, membership } from "../../db/schema";
import { auth } from "./auth.server";

export type Camp = typeof camp.$inferSelect;
export type Membership = typeof membership.$inferSelect;
export type CampMembership = { camp: Camp; membership: Membership };

export async function getSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

/** Require a logged-in user, else redirect to /login. */
export async function requireUser(request: Request) {
  const session = await getSession(request);
  if (!session) throw redirect("/login");
  return session;
}

/** All camps the user belongs to, with their membership in each. */
export async function loadUserCamps(userId: string): Promise<CampMembership[]> {
  const rows = await db
    .select({ camp, membership })
    .from(membership)
    .innerJoin(camp, eq(membership.organizationId, camp.id))
    .where(eq(membership.userId, userId));
  return rows;
}

export type ActiveCampContext = {
  user: { id: string; name: string; email: string; image?: string | null };
  camps: CampMembership[];
  active: CampMembership | null;
};

/**
 * Resolve the user + their camps + the currently active camp (from the session's
 * activeOrganizationId, falling back to the first membership). Redirects to
 * /login if unauthenticated.
 */
export async function resolveActiveCamp(
  request: Request,
): Promise<ActiveCampContext> {
  const session = await requireUser(request);
  const camps = await loadUserCamps(session.user.id);
  const activeId = session.session.activeOrganizationId;
  const active = camps.find((c) => c.camp.id === activeId) ?? camps[0] ?? null;
  return { user: session.user, camps, active };
}

/** Like resolveActiveCamp but requires a camp; redirects to /dashboard if none. */
export async function requireActiveCamp(
  request: Request,
): Promise<ActiveCampContext & { active: CampMembership }> {
  const ctx = await resolveActiveCamp(request);
  if (!ctx.active) throw redirect("/dashboard");
  return { ...ctx, active: ctx.active };
}
