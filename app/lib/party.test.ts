import { describe, expect, test } from "bun:test";
import {
  type AttendeeParty,
  canManageAttendee,
  inMyParty,
  isMe,
} from "./party";

const ALBERT = "mem_albert";
const GRACE = "mem_grace";
const STRANGER = "mem_stranger";

/** Albert's own attendee row. */
const albert: AttendeeParty = {
  membershipId: ALBERT,
  hostMembershipId: null,
};
/** A guest Albert brought, with no account of their own. */
const albertsGuest: AttendeeParty = {
  membershipId: null,
  hostMembershipId: ALBERT,
};
/** Grace: her own account, attending as part of Albert's party. */
const graceLinked: AttendeeParty = {
  membershipId: GRACE,
  hostMembershipId: ALBERT,
};
/** Grace unlinked — a member in nobody's party. */
const graceAlone: AttendeeParty = {
  membershipId: GRACE,
  hostMembershipId: null,
};
/** A ticket nobody is assigned to: the left join yields two NULLs. */
const unassigned: AttendeeParty = {
  membershipId: null,
  hostMembershipId: null,
};

const asMember = (id: string) => ({ id, role: "member" });
const asOfficer = (id: string) => ({ id, role: "officer" });

describe("inMyParty", () => {
  test("my own row is mine", () => {
    expect(inMyParty(albert, ALBERT)).toBe(true);
  });

  test("a guest I brought is mine", () => {
    expect(inMyParty(albertsGuest, ALBERT)).toBe(true);
  });

  test("a member linked into my party is mine", () => {
    expect(inMyParty(graceLinked, ALBERT)).toBe(true);
  });

  test("a linked member's own row is still theirs too", () => {
    expect(inMyParty(graceLinked, GRACE)).toBe(true);
  });

  test("the link is directional — Grace does not get Albert", () => {
    expect(inMyParty(albert, GRACE)).toBe(false);
  });

  test("an unlinked member is nobody else's", () => {
    expect(inMyParty(graceAlone, ALBERT)).toBe(false);
  });

  test("a stranger gets nothing", () => {
    expect(inMyParty(albert, STRANGER)).toBe(false);
    expect(inMyParty(albertsGuest, STRANGER)).toBe(false);
    expect(inMyParty(graceLinked, STRANGER)).toBe(false);
  });

  // The regression that motivates the explicit NULL guard: an unassigned ticket
  // left-joins to all-NULL, and `null === null` would have made it everyone's.
  test("an unassigned row belongs to nobody", () => {
    expect(inMyParty(unassigned, ALBERT)).toBe(false);
    expect(inMyParty(unassigned, GRACE)).toBe(false);
  });
});

describe("canManageAttendee", () => {
  test("covers everything inMyParty does", () => {
    expect(canManageAttendee(albert, asMember(ALBERT))).toBe(true);
    expect(canManageAttendee(albertsGuest, asMember(ALBERT))).toBe(true);
    expect(canManageAttendee(graceLinked, asMember(ALBERT))).toBe(true);
  });

  test("a linked member still manages their own things", () => {
    expect(canManageAttendee(graceLinked, asMember(GRACE))).toBe(true);
  });

  test("stays directional for ordinary members", () => {
    expect(canManageAttendee(albert, asMember(GRACE))).toBe(false);
    expect(canManageAttendee(graceAlone, asMember(ALBERT))).toBe(false);
  });

  test("an officer manages anyone", () => {
    expect(canManageAttendee(albert, asOfficer(STRANGER))).toBe(true);
    expect(canManageAttendee(albertsGuest, asOfficer(STRANGER))).toBe(true);
    expect(canManageAttendee(graceAlone, asOfficer(STRANGER))).toBe(true);
  });

  test("admin outranks officer, recruit does not reach", () => {
    expect(canManageAttendee(albert, { id: STRANGER, role: "admin" })).toBe(
      true,
    );
    expect(canManageAttendee(albert, { id: STRANGER, role: "recruit" })).toBe(
      false,
    );
  });

  test("an unknown role grants nothing", () => {
    expect(canManageAttendee(albert, { id: STRANGER, role: "wat" })).toBe(
      false,
    );
  });

  // Officers get reach over people, not over rows belonging to nobody — but the
  // officer branch is role-only, so an unassigned ticket is manageable by them.
  // Callers scope those by edition; this documents the behavior rather than
  // asserting it is a permission over a person.
  test("an unassigned row is officer-manageable but member-untouchable", () => {
    expect(canManageAttendee(unassigned, asOfficer(STRANGER))).toBe(true);
    expect(canManageAttendee(unassigned, asMember(ALBERT))).toBe(false);
  });
});

describe("isMe", () => {
  test("only the person themselves", () => {
    expect(isMe(albert, ALBERT)).toBe(true);
    expect(isMe(graceLinked, GRACE)).toBe(true);
  });

  test("not someone I merely host", () => {
    expect(isMe(graceLinked, ALBERT)).toBe(false);
    expect(isMe(albertsGuest, ALBERT)).toBe(false);
  });

  test("a guest is never anyone", () => {
    expect(isMe(unassigned, ALBERT)).toBe(false);
  });
});
