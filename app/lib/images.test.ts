import { describe, expect, test } from "bun:test";
import {
  formatBytes,
  imageRefs,
  resolveImageSrc,
  sniffImageType,
} from "./images";
import { loneImage, parseInline, parseWikiBody } from "./wiki";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("sniffImageType", () => {
  test("PNG", () => {
    expect(
      sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("image/png");
  });

  test("JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  test("GIF87a and GIF89a", () => {
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBe(
      "image/gif",
    );
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe(
      "image/gif",
    );
  });

  test("WebP needs both RIFF and WEBP", () => {
    const webp = bytes(
      0x52,
      0x49,
      0x46,
      0x46,
      0,
      0,
      0,
      0,
      0x57,
      0x45,
      0x42,
      0x50,
    );
    expect(sniffImageType(webp)).toBe("image/webp");
    const riffOnly = bytes(
      0x52,
      0x49,
      0x46,
      0x46,
      0,
      0,
      0,
      0,
      0x41,
      0x56,
      0x49,
      0x20,
    );
    expect(sniffImageType(riffOnly)).toBeNull();
  });

  test("rejects SVG, however it is dressed up", () => {
    // The exact thing a `startsWith("image/")` check on the declared type would
    // wave through — a scriptable document.
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(sniffImageType(svg)).toBeNull();
  });

  test("rejects an empty or truncated file", () => {
    expect(sniffImageType(bytes())).toBeNull();
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull();
  });

  test("rejects HTML that merely claims to be a picture", () => {
    expect(
      sniffImageType(new TextEncoder().encode("<!DOCTYPE html>")),
    ).toBeNull();
  });
});

describe("resolveImageSrc", () => {
  test("an uploaded picture resolves to its id", () => {
    const got = resolveImageSrc(`/media/${ID}`);
    expect(got).toEqual({ kind: "upload", id: ID, src: `/media/${ID}` });
  });

  test("an https URL is external", () => {
    expect(resolveImageSrc("https://example.com/a.png")?.kind).toBe("external");
  });

  test("javascript: and data: are refused", () => {
    expect(resolveImageSrc("javascript:alert(1)")).toBeNull();
    expect(resolveImageSrc("data:image/png;base64,AAAA")).toBeNull();
    // Whitespace tricks don't survive URL parsing either.
    expect(resolveImageSrc("java\tscript:alert(1)")).toBeNull();
    expect(resolveImageSrc(" JavaScript:alert(1) ")).toBeNull();
  });

  test("a path that only looks like /media is refused", () => {
    expect(resolveImageSrc("/media/../../etc/passwd")).toBeNull();
    expect(resolveImageSrc("/media/not-a-uuid")).toBeNull();
    expect(resolveImageSrc("/media/")).toBeNull();
  });

  test("an empty src is refused", () => {
    expect(resolveImageSrc("")).toBeNull();
    expect(resolveImageSrc("   ")).toBeNull();
  });
});

describe("imageRefs", () => {
  test("finds every uploaded picture a body uses, once each", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    const body = `![a](/media/${ID})\n\ntext\n\n![b](/media/${other})\n![again](/media/${ID})`;
    expect(imageRefs(body).sort()).toEqual([ID, other].sort());
  });

  test("ignores external pictures — they aren't ours to keep", () => {
    expect(imageRefs("![x](https://example.com/a.png)")).toEqual([]);
  });

  test("a body with no pictures has no refs", () => {
    expect(imageRefs("# Just words")).toEqual([]);
  });
});

describe("image parsing", () => {
  test("markdown image syntax becomes an image node", () => {
    expect(parseInline(`![Shade frame](/media/${ID})`)).toEqual([
      { type: "image", alt: "Shade frame", src: `/media/${ID}` },
    ]);
  });

  test("an empty alt is allowed", () => {
    const [node] = parseInline(`![](/media/${ID})`);
    expect(node).toEqual({ type: "image", alt: "", src: `/media/${ID}` });
  });

  test("an external image is not eaten by the bare-URL autolinker", () => {
    // Regression: the URL matcher would otherwise consume `https://…png)` and
    // leave `![alt](` behind as text.
    expect(parseInline("![Map](https://example.com/map.png)")).toEqual([
      { type: "image", alt: "Map", src: "https://example.com/map.png" },
    ]);
  });

  test("text either side of an inline image survives", () => {
    const nodes = parseInline(`see ![x](/media/${ID}) here`);
    expect(nodes[0]).toEqual({ type: "text", text: "see " });
    expect(nodes[1]?.type).toBe("image");
    expect(nodes[2]).toEqual({ type: "text", text: " here" });
  });

  test("a picture inside a code span stays literal", () => {
    expect(parseInline("`![x](/media/y)`")).toEqual([
      { type: "code", text: "![x](/media/y)" },
    ]);
  });
});

describe("loneImage", () => {
  test("a paragraph that is only a picture is a figure", () => {
    const [block] = parseWikiBody(`![Shade](/media/${ID})`);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(loneImage(block.children)?.alt).toBe("Shade");
  });

  test("a picture with words around it stays inline", () => {
    const [block] = parseWikiBody(`Here it is ![Shade](/media/${ID})`);
    if (block?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(loneImage(block.children)).toBeNull();
  });

  test("two pictures on one line stay inline", () => {
    const [block] = parseWikiBody(`![a](/media/${ID}) ![b](/media/${ID})`);
    if (block?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(loneImage(block.children)).toBeNull();
  });

  test("a paragraph with no picture has no lone image", () => {
    const [block] = parseWikiBody("Just words");
    if (block?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(loneImage(block.children)).toBeNull();
  });
});

describe("formatBytes", () => {
  test("scales the unit to the size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
