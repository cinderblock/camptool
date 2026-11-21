/**
 * Every table and every structured text column has a stated place in a camp
 * move (plans/camp-portability.md). A new table fails here until it either
 * hangs off `camp` by a NOT NULL foreign key or is listed in `NEVER` /
 * `IDENTITY` with a reason.
 */
import { describe, expect, it } from "bun:test";
import {
  campTables,
  IDENTITY,
  JSON_COLUMNS,
  JSONISH,
  NEVER,
  PROSE,
  scrubIdentityRow,
  userKeysOf,
} from "./registry";
import { insertOrder, schemaGraph } from "./schema-graph";

const graph = schemaGraph();
const camp = campTables(graph);

describe("camp move registry", () => {
  it("places every table", () => {
    const unplaced = [...graph.keys()].filter(
      (t) =>
        !camp.has(t) &&
        !(t in NEVER) &&
        !(IDENTITY as readonly string[]).includes(t),
    );
    expect(unplaced).toEqual([]);
  });

  it("lists only real tables", () => {
    for (const t of [...Object.keys(NEVER), ...IDENTITY]) {
      expect(graph.has(t)).toBe(true);
    }
  });

  it("never carries instance or secret tables", () => {
    for (const t of [
      "super_admin",
      "session",
      "instance_setting",
      "camp_setup_link",
      "password_reset",
    ]) {
      expect(camp.has(t)).toBe(false);
      expect(t in NEVER).toBe(true);
    }
  });

  it("finds tables that reach the camp only through a parent", () => {
    expect(camp.get("setup_pass_stock_event")).toMatchObject({
      kind: "parent",
      parent: "setup_pass_stock",
    });
  });

  it("can order the camp's tables for insert", () => {
    const order = insertOrder(graph, [...camp.keys(), ...IDENTITY]);
    expect(order.indexOf("user")).toBeLessThan(order.indexOf("membership"));
    expect(order.indexOf("camp")).toBeLessThan(order.indexOf("membership"));
  });

  it("knows every structured text column", () => {
    const unknown: string[] = [];
    for (const t of graph.values()) {
      if (!camp.has(t.name)) continue;
      for (const c of t.columns) {
        const id = `${t.name}.${c.name}`;
        if (c.sqlType !== "text" || !JSONISH.test(c.name)) continue;
        if (t.foreignKeys.some((f) => f.column === c.name)) continue;
        if (!(id in JSON_COLUMNS) && !PROSE.has(id)) unknown.push(id);
      }
    }
    expect(unknown).toEqual([]);
    for (const id of Object.keys(JSON_COLUMNS)) {
      const [t, c] = id.split(".");
      expect(graph.get(t as string)?.columns.some((x) => x.name === c)).toBe(
        true,
      );
    }
  });

  it("rewrites user ids inside map snapshots", () => {
    expect(userKeysOf("map_object")).toContain("createdById");
    const rule = JSON_COLUMNS["map_snapshot.data"];
    if (!rule?.userIds) throw new Error("expected a rewriter");
    const text = JSON.stringify({
      placement: { id: "p" },
      objects: [
        { id: "o1", createdById: "u-member", ownerMembershipId: "m1" },
        { id: "o2", createdById: "u-gone" },
      ],
      zones: [],
    });
    const out = JSON.parse(
      rule.rewrite(text, (id) => (id === "u-member" ? "u-new" : null)),
    );
    expect(out.objects[0]).toEqual({
      id: "o1",
      createdById: "u-new",
      ownerMembershipId: "m1",
    });
    expect(out.objects[1].createdById).toBeNull();
  });

  it("drops passwords and OAuth tokens", () => {
    expect(
      scrubIdentityRow("account", { provider_id: "credential", password: "x" }),
    ).toBeNull();
    expect(
      scrubIdentityRow("account", {
        provider_id: "discord",
        account_id: "123",
        access_token: "t",
        refresh_token: "r",
        password: null,
      }),
    ).toEqual({
      provider_id: "discord",
      account_id: "123",
      access_token: null,
      refresh_token: null,
      password: null,
    });
  });
});
