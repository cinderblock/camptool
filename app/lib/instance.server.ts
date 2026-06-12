/**
 * Instance-level (deployment-wide) controls: super admins + the two lockdown
 * toggles, plus the signed "signup unlock" cookie that lets the invite-only
 * gate distinguish a sanctioned signup (from an invite link or a camp's public
 * apply page) from a drive-by signup on /login.
 *
 * Server-only. Must NOT import auth.server.ts — auth.server.ts imports THIS, and
 * a cycle would break module init.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client.server";
import { instanceSetting, superAdmin, user } from "../../db/schema";

const SETTINGS_ID = "singleton";

export type InstanceSettings = {
  allowCampCreation: boolean;
  allowOpenSignups: boolean;
};

const DEFAULT_SETTINGS: InstanceSettings = {
  allowCampCreation: true,
  allowOpenSignups: true,
};

/** The deployment toggles. Falls back to permissive defaults if the singleton
 * row is somehow absent (e.g. a DB predating the migration seed). */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const [row] = await db
    .select({
      allowCampCreation: instanceSetting.allowCampCreation,
      allowOpenSignups: instanceSetting.allowOpenSignups,
    })
    .from(instanceSetting)
    .where(eq(instanceSetting.id, SETTINGS_ID))
    .limit(1);
  return row ?? DEFAULT_SETTINGS;
}

/** Upsert the singleton settings row. */
export async function setInstanceSettings(
  patch: Partial<InstanceSettings>,
): Promise<void> {
  await db
    .insert(instanceSetting)
    .values({
      id: SETTINGS_ID,
      ...DEFAULT_SETTINGS,
      ...patch,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: instanceSetting.id,
      set: { ...patch, updatedAt: new Date() },
    });
}

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: superAdmin.userId })
    .from(superAdmin)
    .where(eq(superAdmin.userId, userId))
    .limit(1);
  return Boolean(row);
}

export async function countSuperAdmins(): Promise<number> {
  const rows = await db.select({ userId: superAdmin.userId }).from(superAdmin);
  return rows.length;
}

export type SuperAdminRow = {
  userId: string;
  name: string;
  email: string;
  createdAt: Date;
};

export async function listSuperAdmins(): Promise<SuperAdminRow[]> {
  return db
    .select({
      userId: superAdmin.userId,
      name: user.name,
      email: user.email,
      createdAt: superAdmin.createdAt,
    })
    .from(superAdmin)
    .innerJoin(user, eq(superAdmin.userId, user.id))
    .orderBy(asc(superAdmin.createdAt));
}

/** Grant super admin to an existing user, by email. Returns the granted user's
 * id, or an error reason. Idempotent. */
export async function grantSuperAdminByEmail(
  email: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { ok: false, reason: "Enter an email address." };
  const [u] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, normalized))
    .limit(1);
  if (!u) {
    return {
      ok: false,
      reason:
        "No account with that email. They must sign in here at least once first.",
    };
  }
  await db.insert(superAdmin).values({ userId: u.id }).onConflictDoNothing();
  return { ok: true, userId: u.id };
}

/** Revoke super admin. Refuses to remove the last one so a deployment is never
 * left with no owner. */
export async function revokeSuperAdmin(
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if ((await countSuperAdmins()) <= 1) {
    return { ok: false, reason: "Can't remove the last super admin." };
  }
  await db.delete(superAdmin).where(eq(superAdmin.userId, userId));
  return { ok: true };
}

/** Promote the very first account on a fresh deployment. No-op once any super
 * admin exists. Called from the better-auth user-create after-hook. */
export async function ensureFirstUserSuperAdmin(userId: string): Promise<void> {
  if ((await countSuperAdmins()) > 0) return;
  await db.insert(superAdmin).values({ userId }).onConflictDoNothing();
}

// --- Signup-unlock cookie: signed proof the visitor reached signup from a -----
// --- sanctioned entry point (invite link or a camp's public apply page). ------

const UNLOCK_COOKIE = "camptool_signup_ok";
const secret = process.env.BETTER_AUTH_SECRET ?? "camptool-dev-secret";
const cookieSecure = (process.env.PUBLIC_BASE_URL ?? "").startsWith("https:");
const cookieBase = `Path=/; HttpOnly; SameSite=Lax${cookieSecure ? "; Secure" : ""}`;
const UNLOCK_TTL_MS = 60 * 60 * 1000; // 1 hour — enough to finish an OAuth/magic-link round trip.

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** A Set-Cookie value granting signup for the next hour. */
export function setSignupUnlockCookie(): string {
  const exp = String(Date.now() + UNLOCK_TTL_MS);
  return `${UNLOCK_COOKIE}=${exp}.${sign(exp)}; ${cookieBase}; Max-Age=${UNLOCK_TTL_MS / 1000}`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True if the request carries a valid, unexpired signup-unlock cookie. */
export function hasSignupUnlock(headers: Headers | null | undefined): boolean {
  if (!headers) return false;
  const raw = readCookie(headers.get("cookie"), UNLOCK_COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return false;
  const expStr = raw.slice(0, dot);
  const got = Buffer.from(raw.slice(dot + 1));
  const want = Buffer.from(sign(expStr));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now();
}
