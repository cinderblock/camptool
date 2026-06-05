/**
 * Shared auth permissions — imported by BOTH the server (auth.server.ts) and
 * the browser client (auth-client.ts), so it must stay free of server-only
 * imports.
 *
 * Two layers live here:
 *  1. better-auth access control (`ac` + roles) — permission SETS gating
 *     specific actions, used by the organization plugin.
 *  2. ROLE_RANK — our ranked hierarchy (admin > officer > member > recruit).
 *     better-auth roles are not ordered, so "at least officer" style checks and
 *     the "can't grant a role above your own" ceiling are enforced via rank.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

// Extend better-auth's built-in org statements so the plugin's internal checks
// (invite, remove member, update org, …) keep working with our custom roles.
export const statement = {
  ...defaultStatements,
} as const;

export const ac = createAccessControl(statement);

/** Prospective member; can sign in but manages nothing. */
export const recruit = ac.newRole({});

/** Full camper; participates but doesn't administer the roster. */
export const member = ac.newRole({});

/** Elevated helper: runs onboarding/invites, manages members below admin. */
export const officer = ac.newRole({
  organization: ["update"],
  member: ["create", "update"],
  invitation: ["create", "cancel"],
});

/** Camp lead: full control of the camp and its roster. */
export const admin = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  ac: ["create", "read", "update", "delete"],
});

export const roles = { admin, officer, member, recruit };

/** Ranked low→high. Index/value order is the source of truth for hierarchy. */
export const ROLE_RANK = {
  recruit: 0,
  member: 1,
  officer: 2,
  admin: 3,
} as const;

export type Role = keyof typeof ROLE_RANK;

export const ROLES = Object.keys(ROLE_RANK) as Role[];

export function isRole(value: string): value is Role {
  return value in ROLE_RANK;
}

export function rankOf(role: string): number {
  return isRole(role) ? ROLE_RANK[role] : -1;
}

/** True if `role` is at least as high as `min` in the hierarchy. */
export function hasAtLeast(role: string, min: Role): boolean {
  return rankOf(role) >= ROLE_RANK[min];
}
