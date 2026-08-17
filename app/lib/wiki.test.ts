import { describe, expect, test } from "bun:test";
import {
  appLinkTargets,
  parseInline,
  parseWikiBody,
  resolveWikiTarget,
  wikiExcerpt,
  wikiLinkSlugs,
  wikiSlug,
} from "./wiki";

describe("appLinkTargets", () => {
  test("core surfaces are always offered", () => {
    const paths = appLinkTargets([]).map((t) => t.path);
    expect(paths).toEqual(["/", "/guide", "/members", "/editions"]);
  });

  test("never offers the same path twice", () => {
    // Regression: /wiki was in the core list AND generated from the registry,
    // which made Mantine's Select throw on duplicate option values.
    const paths = appLinkTargets([
      "wiki",
      "faq",
      "map",
      "bringing",
      "tickets",
    ]).map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("a gated feature only appears when the camp can see it", () => {
    expect(appLinkTargets([]).map((t) => t.path)).not.toContain("/wiki");
    expect(appLinkTargets(["wiki"]).map((t) => t.path)).toContain("/wiki");
  });

  test("features whose route differs from their key use the route", () => {
    const paths = appLinkTargets(["bringing", "recruiting", "roster"]).map(
      (t) => t.path,
    );
    expect(paths).toContain("/bringing");
    expect(paths).toContain("/recruits");
    expect(paths).toContain("/roster");
  });
});

describe("wikiSlug", () => {
  test("titles become addresses", () => {
    expect(wikiSlug("Raising the Sierpinski Pyramid")).toBe(
      "raising-the-sierpinski-pyramid",
    );
    expect(wikiSlug("  Fire   Safety!  ")).toBe("fire-safety");
    expect(wikiSlug("Cameron's plan")).toBe("camerons-plan");
  });

  test("never leaves a trailing or leading separator", () => {
    expect(wikiSlug("--weird--")).toBe("weird");
    expect(wikiSlug("!!!")).toBe("");
  });

  test("a long title truncates without a dangling hyphen", () => {
    const slug = wikiSlug(`${"word ".repeat(40)}end`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("resolveWikiTarget", () => {
  test("a plain name is another wiki page, by slug", () => {
    expect(resolveWikiTarget("Fire Safety")).toEqual({
      type: "link",
      target: "wiki",
      href: "fire-safety",
      label: "Fire Safety",
    });
  });

  test("a leading slash is an in-app route", () => {
    expect(resolveWikiTarget("/map", "the camp map")).toEqual({
      type: "link",
      target: "internal",
      href: "/map",
      label: "the camp map",
    });
  });

  test("http(s) is external", () => {
    expect(resolveWikiTarget("https://burningman.org").target).toBe("external");
  });
});

describe("parseInline", () => {
  test("bold, italic and code", () => {
    expect(parseInline("a **b** c")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " c" },
    ]);
    expect(parseInline("`x = 1`")).toEqual([{ type: "code", text: "x = 1" }]);
  });

  test("code wins over emphasis, so markup inside backticks stays literal", () => {
    const nodes = parseInline("`**not bold**`");
    expect(nodes).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  test("bare urls autolink", () => {
    const nodes = parseInline("see https://example.com/x for more");
    expect(nodes[1]).toEqual({
      type: "link",
      target: "external",
      href: "https://example.com/x",
      label: "https://example.com/x",
    });
  });

  test("a labelled wiki link", () => {
    expect(parseInline("[[Fire Safety|the fire page]]")).toEqual([
      {
        type: "link",
        target: "wiki",
        href: "fire-safety",
        label: "the fire page",
      },
    ]);
  });
});

describe("parseWikiBody", () => {
  test("headings, lists, quotes and rules", () => {
    const blocks = parseWikiBody(
      ["## Setup", "", "- one", "- two", "", "> careful", "", "---"].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "list",
      "quote",
      "hr",
    ]);
    const list = blocks[1];
    if (list?.type !== "list") throw new Error("expected a list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
  });

  test("numbered lists are ordered", () => {
    const [block] = parseWikiBody("1. first\n2. second");
    if (block?.type !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(true);
    expect(block.items).toHaveLength(2);
  });

  test("fenced code is verbatim — no inline parsing inside", () => {
    const [block] = parseWikiBody("```sh\nrm -rf **/*\n```");
    expect(block).toEqual({
      type: "code",
      text: "rm -rf **/*",
      lang: "sh",
    });
  });

  test("consecutive lines join into one paragraph", () => {
    const blocks = parseWikiBody("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: "one two" }],
    });
  });

  test("plain prose survives untouched", () => {
    const blocks = parseWikiBody("just a sentence.");
    expect(blocks[0]?.type).toBe("paragraph");
  });
});

describe("wikiLinkSlugs", () => {
  test("collects wiki targets only, deduped, ignoring app + external links", () => {
    const body = [
      "See [[Fire Safety]] and [[fire-safety|again]].",
      "Also [[/map|the map]] and https://example.com.",
    ].join("\n");
    expect(wikiLinkSlugs(body)).toEqual(["fire-safety"]);
  });

  test("finds links inside list items and bold text", () => {
    expect(wikiLinkSlugs("- **[[Shade Structures]]**")).toEqual([
      "shade-structures",
    ]);
  });
});

describe("wikiExcerpt", () => {
  test("skips headings and uses the first prose", () => {
    expect(wikiExcerpt("# Title\n\nThe body text.")).toBe("The body text.");
  });

  test("renders link labels, not their markup", () => {
    expect(wikiExcerpt("Ask [[Fire Safety|the fire lead]] first.")).toBe(
      "Ask the fire lead first.",
    );
  });

  test("truncates with an ellipsis", () => {
    expect(wikiExcerpt("x".repeat(300), 20)).toHaveLength(20);
  });
});
