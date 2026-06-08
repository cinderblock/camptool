/** Client-safe invite helpers (shared by routes and their UI components). */

export type InviteState = "ok" | "revoked" | "expired" | "used-up";

export function inviteState(invite: {
  revokedAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}): InviteState {
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    return "expired";
  }
  if (invite.maxUses != null && invite.useCount >= invite.maxUses) {
    return "used-up";
  }
  return "ok";
}

export const INVITE_STATE_MESSAGE: Record<
  Exclude<InviteState, "ok">,
  string
> = {
  revoked: "This invite link has been revoked.",
  expired: "This invite link has expired.",
  "used-up": "This invite link has reached its usage limit.",
};
