/**
 * Who may see and change an attendee's things.
 *
 * A **party** is one host member plus everyone attending as part of their
 * household — guests they brought, and (once linked) members with accounts of
 * their own. The host is *an officer scoped to that party*: Albert manages his
 * party's tickets and setup passes, and the people in it still manage their own.
 *
 * Authority is **directional**. Grace being in Albert's party gives Albert reach
 * over her things; it gives her none over his. `host_membership_id` points one
 * way and this module never walks it backwards.
 *
 * Pure — no database, no server-only imports — so loaders can decide once and
 * ship a boolean instead of shipping other people's membership ids to the
 * browser for the client to compare.
 */
import { hasAtLeast } from "./permissions";

/** The two attendee columns that decide party membership. */
export type AttendeeParty = {
  membershipId: string | null;
  hostMembershipId: string | null;
};

/** Shaped to accept an `active.membership` record as-is. */
export type PartyViewer = {
  id: string;
  role: string;
};

/**
 * Is this attendee me, or someone in the party I host?
 *
 * Drives **visibility** — the "Your tickets" / "Your passes" cards. Officers are
 * deliberately NOT folded in here: an officer's own party card would otherwise
 * swell to the entire camp, which is what the officer tables below it are for.
 */
export function inMyParty(att: AttendeeParty, myMembershipId: string): boolean {
  // A row with no assignee has both columns NULL; it belongs to nobody.
  if (att.membershipId === null && att.hostMembershipId === null) return false;
  return (
    att.membershipId === myMembershipId ||
    att.hostMembershipId === myMembershipId
  );
}

/**
 * May this viewer change something belonging to this attendee?
 *
 * `inMyParty` plus camp officers. Use for mutations; use `inMyParty` for the
 * "mine" flag a member's own card filters on.
 */
export function canManageAttendee(
  att: AttendeeParty,
  viewer: PartyViewer,
): boolean {
  return inMyParty(att, viewer.id) || hasAtLeast(viewer.role, "officer");
}

/**
 * Is this attendee *me personally* — not merely someone in my party?
 *
 * For things nobody may do on another's behalf, however delegated: requesting a
 * setup pass is a statement about your own arrival, so the request form keys off
 * this rather than `inMyParty`.
 */
export function isMe(
  att: Pick<AttendeeParty, "membershipId">,
  myMembershipId: string,
): boolean {
  return att.membershipId !== null && att.membershipId === myMembershipId;
}
