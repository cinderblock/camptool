import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "../../db/client.server";
import { attendee, camp, campEdition, membership, user } from "../../db/schema";
import { auth } from "./auth.server";
import { hasAtLeast, rankOf } from "./permissions";
import {
  PRIVACY_OFF,
  type PrivacyMode,
  parsePrivacyMode,
  serializePrivacyMode,
} from "./privacy";
import { type PrivacyLens, buildPrivacyLens } from "./privacy.server";

export type Camp = typeof camp.$inferSelect;
export type Membership = typeof membership.$inferSelect;
export type CampMembership = { camp: Camp; membership: Membership };
export type Edition = typeof campEdition.$inferSelect;

/** Who is really driving an impersonated session (the admin/officer). */
export type Impersonator = { id: string; name: string };

type RealSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * An app session. When an officer+ is "working as" a lower-ranked member, this
 * carries the *target's* identity plus an `impersonatedBy` marker. Authorization
 * is per-camp (see canImpersonate) — there is no global super-admin concept.
 */
export type AppSession = RealSession & { impersonatedBy?: Impersonator };

// --- "Act as" cookie: a signed, server-only pointer to who we're working as. ---

const ACTAS_COOKIE = "camptool_actas";
const actasSecret = process.env.BETTER_AUTH_SECRET ?? "camptool-dev-secret";
const cookieSecure = (process.env.PUBLIC_BASE_URL ?? "").startsWith("https:");
const cookieBase = `Path=/; HttpOnly; SameSite=Lax${cookieSecure ? "; Secure" : ""}`;

type ActAs = { u: string; c: string };

function sign(payload: string): string {
  return createHmac("sha256", actasSecret).update(payload).digest("base64url");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function readActAs(request: Request): ActAs | null {
  const raw = readCookie(request, ACTAS_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = raw.slice(0, dot);
  const got = Buffer.from(raw.slice(dot + 1));
  const want = Buffer.from(sign(payloadB64));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as ActAs;
    if (typeof parsed.u === "string" && typeof parsed.c === "string") {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

export function setActAsCookie(target: { userId: string; campId: string }) {
  const payloadB64 = Buffer.from(
    JSON.stringify({ u: target.userId, c: target.campId } satisfies ActAs),
  ).toString("base64url");
  return `${ACTAS_COOKIE}=${payloadB64}.${sign(payloadB64)}; ${cookieBase}`;
}

export function clearActAsCookie() {
  return `${ACTAS_COOKIE}=; ${cookieBase}; Max-Age=0`;
}

// --- Active edition: which (camp, year) edition the user is currently viewing. ---

const EDITION_COOKIE = "camptool_edition";

/** Set the active edition (validated against the active camp in resolveActiveCamp). */
export function setEditionCookie(editionId: string) {
  return `${EDITION_COOKIE}=${editionId}; ${cookieBase}`;
}

// --- Privacy mode: pseudonymize PII for demos/screen-shares. ---
//
// Admin-only, and re-checked on every request rather than trusted from the
// cookie, so demoting an admin ends their privacy session immediately. The
// cookie is unsigned on purpose: it grants no authority and defaults to off,
// so there is nothing worth forging. See `plans/privacy-and-demo-mode.md`.

const PRIVACY_COOKIE = "camptool_privacy";

export function setPrivacyCookie(mode: PrivacyMode) {
  return `${PRIVACY_COOKIE}=${serializePrivacyMode(mode)}; ${cookieBase}`;
}

/** Every real identity in the camp, so free text can have names swapped out of
 * it (and so the dev leak audit knows what a leak looks like). */
async function loadCampIdentities(campId: string) {
  const people = await db
    .select({
      name: user.name,
      email: user.email,
      playaName: membership.playaName,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.organizationId, campId));
  const guests = await db
    .select({ name: attendee.name, email: attendee.email })
    .from(attendee)
    .where(eq(attendee.campId, campId));
  return { people, guests };
}

/** All editions for a camp, newest year first. */
export async function loadCampEditions(campId: string): Promise<Edition[]> {
  return db
    .select()
    .from(campEdition)
    .where(eq(campEdition.campId, campId))
    .orderBy(desc(campEdition.year), desc(campEdition.createdAt));
}

/**
 * May `realUserId` act as `targetUserId` within camp `campId`? The real user
 * must be officer+ in that camp and strictly out-rank the target, and the target
 * must belong to the camp. Re-checked on every request so revoking access (or
 * demoting the actor) ends impersonation immediately.
 */
export async function canImpersonate(
  realUserId: string,
  targetUserId: string,
  campId: string,
): Promise<boolean> {
  if (realUserId === targetUserId) return false;
  const [realM] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(
        eq(membership.userId, realUserId),
        eq(membership.organizationId, campId),
      ),
    )
    .limit(1);
  if (!realM || !hasAtLeast(realM.role, "officer")) return false;
  const [targetM] = await db
    .select({ role: membership.role })
    .from(membership)
    .where(
      and(
        eq(membership.userId, targetUserId),
        eq(membership.organizationId, campId),
      ),
    )
    .limit(1);
  if (!targetM) return false;
  return rankOf(realM.role) > rankOf(targetM.role);
}

async function applyImpersonation(
  real: RealSession,
  actas: ActAs,
): Promise<AppSession | null> {
  if (!(await canImpersonate(real.user.id, actas.u, actas.c))) return null;
  const [targetUser] = await db
    .select()
    .from(user)
    .where(eq(user.id, actas.u))
    .limit(1);
  if (!targetUser) return null;
  return {
    ...real,
    user: {
      ...real.user,
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      emailVerified: targetUser.emailVerified,
      image: targetUser.image,
    },
    session: { ...real.session, activeOrganizationId: actas.c },
    impersonatedBy: { id: real.user.id, name: real.user.name },
  };
}

/** The real better-auth session, ignoring any impersonation cookie. Use this
 * to authorize starting/stopping impersonation itself. */
export async function getRealSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

/** The effective session: the real one, or the impersonated target when a valid
 * "act as" cookie is present and still authorized. */
export async function getSession(request: Request): Promise<AppSession | null> {
  const real = await auth.api.getSession({ headers: request.headers });
  if (!real) return null;
  const actas = readActAs(request);
  if (!actas) return real;
  return (await applyImpersonation(real, actas)) ?? real;
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
  impersonatedBy: Impersonator | null;
  // Per-year editions of the active camp + the one currently selected (from the
  // edition cookie, falling back to the newest). Null when the camp has none yet.
  editions: Edition[];
  activeEdition: Edition | null;
  // Privacy mode (admin-only). `privacy` is the built lens to hand to
  // `redact()`; null whenever the mode is off or the viewer isn't an admin, in
  // which case `redact()` is a pass-through and costs nothing.
  privacy: PrivacyLens | null;
  privacyMode: PrivacyMode;
  canUsePrivacy: boolean;
};

/**
 * Resolve the user + their camps + the currently active camp (from the session's
 * activeOrganizationId, falling back to the first membership), plus the active
 * per-year edition of that camp. Redirects to /login if unauthenticated.
 */
export async function resolveActiveCamp(
  request: Request,
): Promise<ActiveCampContext> {
  const session = await requireUser(request);
  const camps = await loadUserCamps(session.user.id);
  const activeId = session.session.activeOrganizationId;
  const active = camps.find((c) => c.camp.id === activeId) ?? camps[0] ?? null;

  let editions: Edition[] = [];
  let activeEdition: Edition | null = null;
  if (active) {
    editions = await loadCampEditions(active.camp.id);
    const wantId = readCookie(request, EDITION_COOKIE);
    // The cookie may point at another camp's edition; only honor it if it's one
    // of THIS camp's editions, else default to the newest.
    activeEdition =
      editions.find((e) => e.id === wantId) ?? editions[0] ?? null;
  }

  const canUsePrivacy = !!active && hasAtLeast(active.membership.role, "admin");
  const privacyMode = canUsePrivacy
    ? parsePrivacyMode(readCookie(request, PRIVACY_COOKIE))
    : PRIVACY_OFF;
  const privacy =
    active && privacyMode.on
      ? buildPrivacyLens({
          mode: privacyMode,
          ...(await loadCampIdentities(active.camp.id)),
          self: {
            name: session.user.name,
            email: session.user.email,
            playaName: active.membership.playaName,
          },
        })
      : null;

  return {
    user: session.user,
    camps,
    active,
    impersonatedBy: session.impersonatedBy ?? null,
    editions,
    activeEdition,
    privacy,
    privacyMode,
    canUsePrivacy,
  };
}

/** Like resolveActiveCamp but requires a camp; redirects to the root (which shows
 * the "create your camp" screen) if none. */
export async function requireActiveCamp(
  request: Request,
): Promise<ActiveCampContext & { active: CampMembership }> {
  const ctx = await resolveActiveCamp(request);
  if (!ctx.active) throw redirect("/");
  return { ...ctx, active: ctx.active };
}

/** Like requireActiveCamp but also requires a selected edition; redirects to the
 * editions page (to create one) if the camp has none yet. */
export async function requireActiveEdition(
  request: Request,
): Promise<
  ActiveCampContext & { active: CampMembership; activeEdition: Edition }
> {
  const ctx = await requireActiveCamp(request);
  if (!ctx.activeEdition) throw redirect("/editions");
  return { ...ctx, activeEdition: ctx.activeEdition };
}
