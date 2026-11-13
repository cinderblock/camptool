import { describe, expect, it } from "bun:test";
import {
  campOrigin,
  campSlugFromHost,
  isValidCampSlug,
  safeNext,
} from "./camp-host";

const apex = new URL("https://camptool.org");
const devApex = new URL("http://localhost:17940");

describe("campSlugFromHost", () => {
  it("reads one label under the apex", () => {
    expect(campSlugFromHost("mathcamp.camptool.org", apex)).toBe("mathcamp");
    expect(campSlugFromHost("MathCamp.CampTool.org:443", apex)).toBe(
      "mathcamp",
    );
  });
  it("is null for the apex and anything else", () => {
    expect(campSlugFromHost("camptool.org", apex)).toBeNull();
    expect(campSlugFromHost("a.b.camptool.org", apex)).toBeNull();
    expect(campSlugFromHost("camptool.org.evil.com", apex)).toBeNull();
    expect(campSlugFromHost("notcamptool.org", apex)).toBeNull();
  });
  it("works under localhost for development", () => {
    expect(campSlugFromHost("mathcamp.localhost:17940", devApex)).toBe(
      "mathcamp",
    );
  });
});

describe("campOrigin", () => {
  it("builds the camp's address, keeping any port", () => {
    expect(campOrigin("mathcamp", apex)).toBe("https://mathcamp.camptool.org");
    expect(campOrigin("x", devApex)).toBe("http://x.localhost:17940");
  });
});

describe("isValidCampSlug", () => {
  it("accepts DNS labels", () => {
    expect(isValidCampSlug("mathcamp")).toBe(true);
    expect(isValidCampSlug("math-camp-2b9x")).toBe(true);
  });
  it("refuses reserved names and bad labels", () => {
    expect(isValidCampSlug("www")).toBe(false);
    expect(isValidCampSlug("-x")).toBe(false);
    expect(isValidCampSlug("x-")).toBe(false);
    expect(isValidCampSlug("Math")).toBe(false);
    expect(isValidCampSlug("a.b")).toBe(false);
    expect(isValidCampSlug("a".repeat(64))).toBe(false);
  });
});

describe("safeNext", () => {
  it("allows paths and our own hosts", () => {
    expect(safeNext("/map", apex)).toBe("/map");
    expect(safeNext("https://mathcamp.camptool.org/map", apex)).toBe(
      "https://mathcamp.camptool.org/map",
    );
    expect(safeNext("https://camptool.org/", apex)).toBe(
      "https://camptool.org/",
    );
  });
  it("refuses anywhere else", () => {
    expect(safeNext("//evil.com/x", apex)).toBeNull();
    expect(safeNext("https://evil.com/", apex)).toBeNull();
    expect(safeNext("https://camptool.org.evil.com/", apex)).toBeNull();
    expect(safeNext("http://mathcamp.camptool.org/", apex)).toBeNull();
    expect(safeNext("javascript:alert(1)", apex)).toBeNull();
    expect(safeNext(null, apex)).toBeNull();
  });
});
