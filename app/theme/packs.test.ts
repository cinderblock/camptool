import { describe, expect, it } from "bun:test";
import type { CampStructure } from "@camptool/theme-contract";
import { blockedKinds } from "~/lib/bans";
import { packRegistry, serializeStructurePacks } from "./index";
import type { ThemePack } from "./pack-types";

const kind = (value: string) =>
  ({
    value,
    label: value,
    color: "#000",
    w: 10,
    h: 10,
    shape: "rect",
    vehicle: false,
    rigid: false,
    group: "Test",
    tags: ["structure"],
    personal: false,
  }) satisfies CampStructure;

// A build with one server-wide pack and two per-camp packs.
const PACKS: ThemePack[] = [
  { key: "@x/everyone", theme: { structures: [kind("dome-x")] }, global: true },
  {
    key: "@x/alpha",
    theme: { name: "Alpha", structures: [kind("alpha-1"), kind("alpha-2")] },
    global: false,
  },
  { key: "@x/beta", theme: { structures: [kind("beta-1")] }, global: false },
];
const reg = packRegistry(PACKS);

describe("structure packs", () => {
  it("registers every bundled structure, so any saved object renders", () => {
    expect(reg.structures.map((s) => s.value)).toEqual([
      "dome-x",
      "alpha-1",
      "alpha-2",
      "beta-1",
    ]);
  });

  it("refuses two packs defining the same kind", () => {
    expect(() =>
      packRegistry([
        ...PACKS,
        {
          key: "@x/dup",
          theme: { structures: [kind("beta-1")] },
          global: false,
        },
      ]),
    ).toThrow(/both @x\/beta and @x\/dup/);
  });

  it("offers super admins only the per-camp packs, by name", () => {
    expect(reg.perCamp).toEqual([
      { key: "@x/alpha", name: "Alpha" },
      { key: "@x/beta", name: "@x/beta" },
    ]);
  });

  it("blocks the per-camp packs a camp hasn't been given", () => {
    expect(reg.unavailableKinds(null)).toEqual([
      "alpha-1",
      "alpha-2",
      "beta-1",
    ]);
    expect(reg.unavailableKinds('["@x/alpha"]')).toEqual(["beta-1"]);
    expect(reg.unavailableKinds("not json")).toHaveLength(3);
  });

  it("round-trips a camp's pack list, deduped and sorted", () => {
    expect(serializeStructurePacks(["@x/beta", "@x/alpha", "@x/beta"])).toBe(
      '["@x/alpha","@x/beta"]',
    );
  });

  it("still applies the edition's banned kinds", () => {
    expect(
      blockedKinds({ bannedKinds: '["popup"]' }, { structurePacks: null }),
    ).toContain("popup");
  });
});
