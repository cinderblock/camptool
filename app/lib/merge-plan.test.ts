import { describe, expect, test } from "bun:test";
import { type MergeSide, planMerge } from "./merge-plan";

const side = (over: Partial<MergeSide> = {}): MergeSide => ({
  membershipId: "m1",
  userId: "u1",
  role: "member",
  status: "active",
  playaName: null,
  invitedByMembershipId: null,
  viaInviteId: null,
  wizardStep: 0,
  wizardCompletedAt: null,
  joinedAt: 1_000,
  createdAt: 1_000,
  userName: "Alex",
  userEmail: "alex@example.com",
  userImage: null,
  userEmailVerified: false,
  userCreatedAt: 1_000,
  hasPassword: false,
  passkeyCount: 0,
  socialProviders: [],
  ...over,
});

const older = side({
  membershipId: "m-old",
  userId: "u-old",
  role: "officer",
  playaName: "Sparkle",
  joinedAt: 1_000,
  createdAt: 1_000,
  userName: "Alex Rivera",
  userEmail: "alex@old.example.com",
  userCreatedAt: 1_000,
  hasPassword: true,
});

const newer = side({
  membershipId: "m-new",
  userId: "u-new",
  role: "member",
  playaName: null,
  joinedAt: 9_000,
  createdAt: 9_000,
  userName: "Alex R",
  userEmail: "alex@new.example.com",
  userCreatedAt: 9_000,
  passkeyCount: 1,
  socialProviders: ["discord"],
});

describe("planMerge is direction-agnostic", () => {
  test("the whole plan is identical whichever way round the pair is passed", () => {
    expect(planMerge(older, newer)).toEqual(planMerge(newer, older));
  });

  test("stays identical across a spread of shapes", () => {
    const variants: MergeSide[] = [
      side({ membershipId: "a", userId: "ua", role: "admin", joinedAt: 5 }),
      side({
        membershipId: "b",
        userId: "ub",
        role: "recruit",
        joinedAt: 5,
        playaName: "Doc",
      }),
      side({
        membershipId: "c",
        userId: "uc",
        status: "removed",
        wizardStep: 4,
        joinedAt: 7,
      }),
      side({
        membershipId: "d",
        userId: "ud",
        invitedByMembershipId: "inv-1",
        viaInviteId: "link-1",
        wizardCompletedAt: 42,
        joinedAt: 7,
        userCreatedAt: 3,
      }),
      side({
        membershipId: "e",
        userId: "ue",
        hasPassword: true,
        passkeyCount: 2,
        socialProviders: ["discord"],
        userEmailVerified: true,
        userImage: "https://example.com/a.png",
        joinedAt: 2,
      }),
    ];
    for (const a of variants) {
      for (const b of variants) {
        if (a.membershipId === b.membershipId) continue;
        expect(planMerge(a, b)).toEqual(planMerge(b, a));
      }
    }
  });

  test("a conflict pick is honoured the same way from either direction", () => {
    const picks = { playaName: "Sparkle" };
    const withPlaya = side({
      membershipId: "m-new",
      userId: "u-new",
      playaName: "Glitter",
      joinedAt: 9_000,
      userCreatedAt: 9_000,
    });
    expect(planMerge(older, withPlaya, picks)).toEqual(
      planMerge(withPlaya, older, picks),
    );
    expect(planMerge(withPlaya, older, picks).membership.playaName).toBe(
      "Sparkle",
    );
  });
});

describe("resolution rules", () => {
  test("the higher role wins, so a merge never demotes", () => {
    expect(planMerge(older, newer).membership.role).toBe("officer");
    expect(planMerge(newer, older).membership.role).toBe("officer");
  });

  test("the earliest join date and creation date win", () => {
    const plan = planMerge(older, newer);
    expect(plan.membership.joinedAt).toBe(1_000);
    expect(plan.membership.createdAt).toBe(1_000);
  });

  test("a blank playa name is filled from the other side", () => {
    expect(planMerge(older, newer).membership.playaName).toBe("Sparkle");
    // "Alex Rivera" vs "Alex R" is a real name disagreement and is reported,
    // but the playa name — blank on one side — needs no asking.
    expect(
      planMerge(older, newer).conflicts.filter((c) => c.field === "playaName"),
    ).toHaveLength(0);
  });

  test("two different playa names are reported, not silently picked", () => {
    const other = side({
      membershipId: "m-new",
      userId: "u-new",
      playaName: "Glitter",
      joinedAt: 9_000,
      userCreatedAt: 9_000,
    });
    const plan = planMerge(older, other);
    const conflict = plan.conflicts.find((c) => c.field === "playaName");
    expect(conflict?.options).toEqual(["Sparkle", "Glitter"]);
    // Defaults to the earliest-joined record's value rather than refusing.
    expect(plan.membership.playaName).toBe("Sparkle");
  });

  test("case and whitespace differences are not conflicts", () => {
    const other = side({
      membershipId: "m-new",
      userId: "u-new",
      playaName: "  sparkle ",
      joinedAt: 9_000,
      userCreatedAt: 9_000,
      userName: older.userName,
    });
    expect(planMerge(older, other).conflicts).toHaveLength(0);
  });

  test("an out-of-range pick is ignored rather than written through", () => {
    const other = side({
      membershipId: "m-new",
      userId: "u-new",
      playaName: "Glitter",
      joinedAt: 9_000,
      userCreatedAt: 9_000,
    });
    const plan = planMerge(older, other, { playaName: "Something Else" });
    expect(plan.membership.playaName).toBe("Sparkle");
  });

  test("invite provenance survives from whichever side has it", () => {
    const invited = side({
      membershipId: "m-new",
      userId: "u-new",
      invitedByMembershipId: "inviter-1",
      viaInviteId: "link-1",
      joinedAt: 9_000,
      userCreatedAt: 9_000,
    });
    const plan = planMerge(older, invited);
    expect(plan.membership.invitedByMembershipId).toBe("inviter-1");
    expect(plan.membership.viaInviteId).toBe("link-1");
  });

  test("the older account's address stays primary, the other becomes an alias", () => {
    const plan = planMerge(older, newer);
    expect(plan.user.email).toBe("alex@old.example.com");
    expect(plan.aliasEmail).toBe("alex@new.example.com");
  });

  test("every sign-in method from both accounts is reported as surviving", () => {
    expect(planMerge(older, newer).signInMethods).toEqual([
      "1 passkey",
      "password",
      "Discord",
    ]);
  });

  test("two passwords means one is dropped, and that is flagged", () => {
    const both = side({
      membershipId: "m-new",
      userId: "u-new",
      hasPassword: true,
      joinedAt: 9_000,
      userCreatedAt: 9_000,
    });
    expect(planMerge(older, both).droppedPassword).toBe(true);
    expect(planMerge(older, newer).droppedPassword).toBe(false);
  });

  test("two memberships on ONE account need no user fold", () => {
    const a = side({ membershipId: "m1", userId: "u1", joinedAt: 1 });
    const b = side({ membershipId: "m2", userId: "u1", joinedAt: 2 });
    const plan = planMerge(a, b);
    expect(plan.sameUser).toBe(true);
    expect(plan.aliasEmail).toBeNull();
    expect(plan.droppedPassword).toBe(false);
  });
});
