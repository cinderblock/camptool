import { describe, expect, test } from "bun:test";
import {
  GENERAL_CATEGORY,
  faqMatches,
  faqSlug,
  groupFaqEntries,
  isFaqStatus,
} from "./faq";
import { type LinkTarget, linkSnippet } from "./wiki";

describe("faqSlug", () => {
  test("turns a question into an address", () => {
    expect(faqSlug("How do I get a ticket?")).toBe("how-do-i-get-a-ticket");
  });

  test("drops punctuation and apostrophes", () => {
    expect(faqSlug("What's the camp's dues policy?")).toBe(
      "whats-the-camps-dues-policy",
    );
  });

  test("is empty for a question with nothing sluggable", () => {
    expect(faqSlug("???")).toBe("");
  });
});

describe("isFaqStatus", () => {
  test("accepts the three lifecycle states", () => {
    expect(isFaqStatus("pending")).toBe(true);
    expect(isFaqStatus("published")).toBe(true);
    expect(isFaqStatus("archived")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isFaqStatus("draft")).toBe(false);
    expect(isFaqStatus("")).toBe(false);
  });
});

describe("faqMatches", () => {
  const entry = {
    question: "How do I get a ticket?",
    answer: "Ask on the Tickets page. Refunds are handled there too.",
  };

  test("an empty query matches everything", () => {
    expect(faqMatches(entry, "")).toBe(true);
    expect(faqMatches(entry, "   ")).toBe(true);
  });

  test("matches the question", () => {
    expect(faqMatches(entry, "ticket")).toBe(true);
  });

  test("matches the answer, not just the question", () => {
    expect(faqMatches(entry, "refund")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(faqMatches(entry, "TICKET")).toBe(true);
  });

  test("requires every term, but not adjacency", () => {
    expect(faqMatches(entry, "ticket refund")).toBe(true);
    expect(faqMatches(entry, "ticket llama")).toBe(false);
  });
});

describe("groupFaqEntries", () => {
  const categories = [
    { id: "c-money", name: "Money", slug: "money", position: 1 },
    {
      id: "c-travel",
      name: "Getting there",
      slug: "getting-there",
      position: 0,
    },
    { id: "c-empty", name: "Unused", slug: "unused", position: 2 },
  ];
  const entry = (
    id: string,
    categoryId: string | null,
    position: number,
    question = id,
  ) => ({ id, categoryId, position, question });

  test("orders categories by position, not by name", () => {
    const groups = groupFaqEntries(
      [entry("a", "c-money", 0), entry("b", "c-travel", 0)],
      categories,
    );
    expect(groups.map((g) => g.name)).toEqual(["Getting there", "Money"]);
  });

  test("drops categories with nothing in them", () => {
    const groups = groupFaqEntries([entry("a", "c-money", 0)], categories);
    expect(groups.map((g) => g.id)).toEqual(["c-money"]);
  });

  test("uncategorized entries land in General, last", () => {
    const groups = groupFaqEntries(
      [entry("loose", null, 0), entry("a", "c-money", 0)],
      categories,
    );
    expect(groups.map((g) => g.name)).toEqual(["Money", GENERAL_CATEGORY]);
    expect(groups[1]?.entries.map((e) => e.id)).toEqual(["loose"]);
  });

  test("an entry pointing at a category that no longer exists falls into General", () => {
    const groups = groupFaqEntries([entry("orphan", "c-gone", 0)], categories);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBeNull();
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(["orphan"]);
  });

  test("entries sort by position, ties broken by question text", () => {
    const groups = groupFaqEntries(
      [
        entry("z", "c-money", 5, "Zebra?"),
        entry("b", "c-money", 1, "Banana?"),
        entry("a", "c-money", 1, "Apple?"),
      ],
      categories,
    );
    expect(groups[0]?.entries.map((e) => e.id)).toEqual(["a", "b", "z"]);
  });

  test("no entries means no groups at all", () => {
    expect(groupFaqEntries([], categories)).toEqual([]);
  });
});

describe("linkSnippet", () => {
  const route: LinkTarget = {
    group: "CampTool",
    path: "/tickets",
    label: "Tickets",
    kind: "route",
  };
  const page: LinkTarget = {
    group: "Wiki pages",
    path: "Fire safety",
    label: "Fire safety",
    kind: "wiki",
  };

  test("a route links by path, labelled with its own name", () => {
    expect(linkSnippet(route)).toBe("[[/tickets|Tickets]]");
  });

  test("a wiki page links bare by title — that reads as prose", () => {
    expect(linkSnippet(page)).toBe("[[Fire safety]]");
  });

  test("selected text becomes the link label", () => {
    expect(linkSnippet(route, "request one here")).toBe(
      "[[/tickets|request one here]]",
    );
    expect(linkSnippet(page, "the burn plan")).toBe(
      "[[Fire safety|the burn plan]]",
    );
  });

  test("whitespace-only selection is treated as no selection", () => {
    expect(linkSnippet(page, "  \n ")).toBe("[[Fire safety]]");
  });
});
