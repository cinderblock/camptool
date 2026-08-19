import { describe, expect, test } from "bun:test";
import { buildForest, flattenForest, subtreeOf, wouldCycle } from "./forest";

type G = { id: string; parentGroupId: string | null; name: string };
const g = (id: string, parent: string | null, name = id): G => ({
  id,
  parentGroupId: parent,
  name,
});
const OPTS = {
  idOf: (x: G) => x.id,
  parentOf: (x: G) => x.parentGroupId,
};
const sorted = {
  ...OPTS,
  compare: (a: G, b: G) => a.name.localeCompare(b.name),
};
const ids = (nodes: { item: G }[]) => nodes.map((n) => n.item.id);

describe("buildForest", () => {
  test("nests children under their parent", () => {
    const forest = buildForest(
      [g("infra", null), g("kitchen", "infra"), g("power", "infra")],
      sorted,
    );
    expect(ids(forest)).toEqual(["infra"]);
    expect(ids(forest[0]?.children ?? [])).toEqual(["kitchen", "power"]);
  });

  test("nests arbitrarily deep", () => {
    const forest = buildForest(
      [g("a", null), g("b", "a"), g("c", "b"), g("d", "c")],
      sorted,
    );
    expect(flattenForest(forest).map((n) => n.depth)).toEqual([0, 1, 2, 3]);
  });

  test("counts the whole subtree, not just direct children", () => {
    const forest = buildForest(
      [g("a", null), g("b", "a"), g("c", "b"), g("d", "a")],
      sorted,
    );
    expect(forest[0]?.descendants).toBe(3);
    expect(forest[0]?.children[0]?.descendants).toBe(1);
  });

  test("sorts siblings at every level, roots included", () => {
    const forest = buildForest(
      [g("z", null, "Zebra"), g("a", null, "Apple"), g("m", "a", "Mango")],
      sorted,
    );
    expect(ids(forest)).toEqual(["a", "z"]);
  });

  test("a missing parent makes the child a root rather than dropping it", () => {
    // ON DELETE SET NULL covers deletion, but a filtered query can still hand
    // us a parent id that isn't in the list.
    const forest = buildForest([g("orphan", "gone"), g("root", null)], sorted);
    expect(ids(forest).sort()).toEqual(["orphan", "root"]);
  });

  test("a self-parent is treated as no parent", () => {
    const forest = buildForest([g("a", "a")], sorted);
    expect(ids(forest)).toEqual(["a"]);
    expect(forest[0]?.children).toHaveLength(0);
  });

  test("a two-node cycle terminates and keeps both", () => {
    const forest = buildForest([g("a", "b"), g("b", "a")], sorted);
    expect(flattenForest(forest)).toHaveLength(2);
  });

  test("a longer cycle terminates and keeps everyone", () => {
    const forest = buildForest(
      [g("a", "c"), g("b", "a"), g("c", "b"), g("free", null)],
      sorted,
    );
    const all = flattenForest(forest)
      .map((n) => n.item.id)
      .sort();
    expect(all).toEqual(["a", "b", "c", "free"]);
  });

  test("every item appears exactly once", () => {
    const items = [g("a", null), g("b", "a"), g("c", "a"), g("d", "c")];
    const flat = flattenForest(buildForest(items, sorted));
    expect(new Set(flat.map((n) => n.item.id)).size).toBe(items.length);
    expect(flat).toHaveLength(items.length);
  });
});

describe("subtreeOf", () => {
  test("returns the node and everything below it", () => {
    const items = [g("a", null), g("b", "a"), g("c", "b"), g("d", null)];
    expect(subtreeOf(items, "a", OPTS).sort()).toEqual(["a", "b", "c"]);
    expect(subtreeOf(items, "d", OPTS)).toEqual(["d"]);
  });

  test("terminates on a cycle", () => {
    expect(subtreeOf([g("a", "b"), g("b", "a")], "a", OPTS).sort()).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("wouldCycle", () => {
  const items = [g("a", null), g("b", "a"), g("c", "b"), g("other", null)];

  test("a group cannot be its own parent", () => {
    expect(wouldCycle(items, "a", "a", OPTS)).toBe(true);
  });

  test("a group cannot move under its own descendant", () => {
    expect(wouldCycle(items, "a", "c", OPTS)).toBe(true);
    expect(wouldCycle(items, "b", "c", OPTS)).toBe(true);
  });

  test("moving under an unrelated group is fine", () => {
    expect(wouldCycle(items, "a", "other", OPTS)).toBe(false);
    expect(wouldCycle(items, "c", "other", OPTS)).toBe(false);
  });

  test("becoming a root is always fine", () => {
    expect(wouldCycle(items, "c", null, OPTS)).toBe(false);
  });
});
