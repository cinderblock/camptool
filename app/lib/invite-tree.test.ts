import { describe, expect, test } from "bun:test";
import { buildInviteTree, flattenTree, subtreeIds } from "./invite-tree";

type M = {
  membershipId: string;
  invitedByMembershipId: string | null;
  name: string;
};
const m = (id: string, by: string | null, name = id): M => ({
  membershipId: id,
  invitedByMembershipId: by,
  name,
});
const byName = (a: M, b: M) => a.name.localeCompare(b.name);
const ids = (list: { item: M }[]) => list.map((n) => n.item.membershipId);

describe("buildInviteTree", () => {
  test("nests invitees under whoever invited them", () => {
    const forest = buildInviteTree(
      [m("a", null), m("b", "a"), m("c", "b"), m("d", null)],
      byName,
    );
    expect(ids(forest)).toEqual(["a", "d"]);
    expect(ids(forest[0]?.children ?? [])).toEqual(["b"]);
    expect(ids(forest[0]?.children[0]?.children ?? [])).toEqual(["c"]);
  });

  test("counts everyone below a node, however deep", () => {
    const forest = buildInviteTree(
      [m("a", null), m("b", "a"), m("c", "b"), m("d", "a")],
      byName,
    );
    expect(forest[0]?.descendants).toBe(3);
    expect(forest[0]?.children[0]?.descendants).toBe(1);
  });

  test("records depth so a table can indent", () => {
    const forest = buildInviteTree([m("a", null), m("b", "a"), m("c", "b")]);
    expect(flattenTree(forest).map((n) => n.depth)).toEqual([0, 1, 2]);
  });

  test("an inviter who has left the camp leaves their invitee a root", () => {
    // ON DELETE SET NULL covers removal, but a membership merge can leave an id
    // that is no longer in the queried set.
    const forest = buildInviteTree([m("b", "gone"), m("c", null)], byName);
    expect(ids(forest)).toEqual(["b", "c"]);
  });

  test("a self-edge is not a parent", () => {
    // A merge can fill invited_by with the survivor's own id; see
    // plans/merge-symmetric.md.
    const forest = buildInviteTree([m("a", "a")]);
    expect(ids(forest)).toEqual(["a"]);
    expect(forest[0]?.children).toHaveLength(0);
  });

  test("a cycle does not hang, and nobody is dropped", () => {
    const forest = buildInviteTree([m("a", "b"), m("b", "a"), m("c", null)]);
    const all = flattenTree(forest)
      .map((n) => n.item.membershipId)
      .sort();
    expect(all).toEqual(["a", "b", "c"]);
  });

  test("a longer cycle also terminates with everyone present", () => {
    const forest = buildInviteTree([m("a", "c"), m("b", "a"), m("c", "b")]);
    expect(flattenTree(forest)).toHaveLength(3);
  });

  test("every member appears exactly once", () => {
    const members = [m("a", null), m("b", "a"), m("c", "a"), m("d", "c")];
    const flat = flattenTree(buildInviteTree(members, byName));
    expect(flat).toHaveLength(members.length);
    expect(new Set(flat.map((n) => n.item.membershipId)).size).toBe(4);
  });
});

describe("subtreeIds", () => {
  test("returns the member and everyone below them", () => {
    const members = [m("a", null), m("b", "a"), m("c", "b"), m("d", null)];
    expect(subtreeIds(members, "a").sort()).toEqual(["a", "b", "c"]);
    expect(subtreeIds(members, "b").sort()).toEqual(["b", "c"]);
    expect(subtreeIds(members, "d")).toEqual(["d"]);
  });

  test("terminates on a cycle", () => {
    expect(subtreeIds([m("a", "b"), m("b", "a")], "a").sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
