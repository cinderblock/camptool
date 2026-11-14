import { describe, expect, test } from "bun:test";
import { legacyHostOf, movedTarget, parseLegacyHosts } from "./legacy-host";

describe("parseLegacyHosts", () => {
  test("host=slug pairs, lowercased, bad ones skipped", () => {
    const m = parseLegacyHosts(
      " CampTool.MathCamp.us=mathcamp , junk, a b=c, old.test:8080=x ",
    );
    expect([...m]).toEqual([
      ["camptool.mathcamp.us", "mathcamp"],
      ["old.test:8080", "x"],
    ]);
  });
  test("unset is empty", () => {
    expect(parseLegacyHosts(undefined).size).toBe(0);
  });
});

describe("legacyHostOf", () => {
  const hosts = parseLegacyHosts("camptool.mathcamp.us=mathcamp");
  test("matches with or without a port", () => {
    expect(legacyHostOf("camptool.mathcamp.us", hosts)).toBe(
      "camptool.mathcamp.us",
    );
    expect(legacyHostOf("CAMPTOOL.mathcamp.us:443", hosts)).toBe(
      "camptool.mathcamp.us",
    );
  });
  test("anything else is not an old host", () => {
    expect(legacyHostOf("mathcamp.camptool.org", hosts)).toBeNull();
    expect(legacyHostOf("x.camptool.mathcamp.us", hosts)).toBeNull();
    expect(legacyHostOf(null, hosts)).toBeNull();
  });
});

describe("movedTarget", () => {
  const camp = "https://mathcamp.camptool.org";
  const apex = "https://camptool.org";
  const at = (p: string) =>
    movedTarget(
      new URL(`https://camptool.mathcamp.us${p}`),
      camp,
      apex,
      "mathcamp",
    );
  test("camp pages keep their path on the subdomain", () => {
    expect(at("/map?year=2026")).toBe(`${camp}/map?year=2026`);
    expect(at("/")).toBe(`${camp}/`);
    expect(at("/wiki/latrines")).toBe(`${camp}/wiki/latrines`);
  });
  test("sign-in, invites, recovery and public pages go to the apex", () => {
    expect(at("/login")).toBe(`${apex}/login`);
    expect(at("/i/abc")).toBe(`${apex}/i/abc`);
    expect(at("/reset/xyz")).toBe(`${apex}/reset/xyz`);
    expect(at("/c/mathcamp")).toBe(`${apex}/c/mathcamp`);
    expect(at("/loginx")).toBe(`${camp}/loginx`);
  });
  test("public pages under the old slug go to the camp's slug now", () => {
    expect(at("/c/math-camp-group-w-m0d3")).toBe(`${apex}/c/mathcamp`);
    expect(at("/c/math-camp-group-w-m0d3/schedule?day=2")).toBe(
      `${apex}/c/mathcamp/schedule?day=2`,
    );
    expect(at("/c/")).toBe(`${apex}/c/`);
  });
});
