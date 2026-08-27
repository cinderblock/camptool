/**
 * Finding the purchaser's name in a SAP page, so it can be replaced with the
 * assignee's (`plans/sap-holder-name-on-pass.md`).
 *
 * Run against captured content-stream snippets rather than PDFs — a real vendor
 * pass can never live in this repo, and the interesting logic is all in the
 * text anyway. The snippets below are the genuine block structure from the 2024
 * and 2026 orders, reproduced byte-for-byte apart from the codes.
 *
 * The thing these tests are really protecting: this module *overwrites* part of
 * a document people take to a gate. Picking the wrong block would silently
 * destroy a field nobody checks until it matters.
 */
import { describe, expect, test } from "bun:test";
import {
  SapRenameError,
  hexString,
  purchaserNameBlock,
  textBlocks,
} from "./sap-rename.server";

/**
 * `Cameron` → `\0C\0a\0m…`, the way an Identity-H operand really sits in the
 * stream: two bytes per character, high byte first.
 *
 * The escaping matters and is not decoration — the real 2024 page contains
 * `\( S A P \)`, because "Placement Setup Pass (SAP)" has parentheses in it and
 * a literal string operand must escape them. Writing fixtures without that
 * produced a stream one block short, which is exactly the bug it protects
 * against.
 */
const operand = (s: string) =>
  [...s]
    .map((c) => {
      const two = String.fromCharCode(0) + c;
      return /[()\\]/.test(c) ? `${String.fromCharCode(0)}\\${c}` : two;
    })
    .join("");

/** A page's worth of blocks, in the vendor's real order and placement. */
function page(opts: { name: string; year?: number; label?: string }): string {
  const year = opts.year ?? 2024;
  const label = opts.label ?? "Placement Setup Pass (SAP) 8/21 & Later";
  const bt = (x: number, y: number, size: number, text: string) =>
    `BT ${x.toFixed(3)} ${y.toFixed(3)} Td /F1 ${size.toFixed(1)} Tf 0.000 Tw (${operand(text)}) Tj ET\n`;
  const rotated = (y: number, size: number, text: string) =>
    `BT -0.000 1.000 -1.000 -0.000 ${y.toFixed(3)} 580.000 Tm /F1 ${size.toFixed(1)} Tf 0.000 Tw (${operand(text)}) Tj ET\n`;
  return (
    bt(75, 672, 11, ` ${opts.name}`) +
    bt(242.968, 672, 8, " Face Value $0.00") +
    bt(75, 622, 12, ` Black Rock City: Access ${year}`) +
    bt(75, 609, 8, " Burning Man, Black Rock Desert, NV") +
    bt(75, 656.83, 10, ` ${label}`) +
    bt(66, 561, 7, " Powered by Burning Man") +
    rotated(329, 9, " Ticket ID 385315577") +
    rotated(341, 12, " Confirmation Id") +
    bt(383.888, 50, 8, ` Copyright ${year} Burning Man All rights reserved.`) +
    bt(50, 50, 7, " Security code: 1/Zz/not-a-real-code")
  );
}

describe("finding the purchaser's name", () => {
  test("reads every text block, decoding the UTF-16BE operands", () => {
    const blocks = textBlocks(page({ name: "Cameron Tacklind" }));
    expect(blocks).toHaveLength(10);
    expect(blocks[0]?.text).toBe("Cameron Tacklind");
    expect(blocks[0]?.x).toBe(75);
    expect(blocks[0]?.y).toBe(672);
    expect(blocks[0]?.fontSize).toBe(11);
    expect(blocks[0]?.fontKey).toBe("F1");
  });

  test("the sideways ticket-ID column is marked rotated, not treated as a line", () => {
    const blocks = textBlocks(page({ name: "Cameron Tacklind" }));
    const ticket = blocks.find((b) => b.text.startsWith("Ticket ID"));
    expect(ticket?.rotated).toBe(true);
    expect(blocks[0]?.rotated).toBe(false);
  });

  test("picks the name out of a 2024 page", () => {
    const found = purchaserNameBlock(
      textBlocks(page({ name: "Cameron Tacklind" })),
    );
    expect(found.text).toBe("Cameron Tacklind");
  });

  test("picks it out of a 2026 page, whose date label is different", () => {
    // The label moved twice between 2024 and 2026; the name field did not.
    const found = purchaserNameBlock(
      textBlocks(
        page({
          name: "Cameron Tacklind",
          year: 2026,
          label: "Setup Access Pass 8/27 & Later",
        }),
      ),
    );
    expect(found.text).toBe("Cameron Tacklind");
  });

  test("is not fooled by 'Face Value' sharing the top line", () => {
    // Same y, further right. Leftmost wins.
    const found = purchaserNameBlock(
      textBlocks(page({ name: "Cameron Tacklind" })),
    );
    expect(found.x).toBe(75);
    expect(found.text).not.toContain("Face Value");
  });
});

describe("refusing rather than overwriting the wrong thing", () => {
  /** One upright text block, for pages built a line at a time. */
  const block = (y: number, text: string) =>
    `BT 75.000 ${y.toFixed(3)} Td /F1 11.0 Tf 0.000 Tw (${operand(text)}) Tj ET\n`;

  test("a recognisable field in the name slot is refused", () => {
    const noName =
      block(672, " Black Rock City: Access 2026") +
      block(622, " Burning Man, Black Rock Desert, NV");
    expect(() => purchaserNameBlock(textBlocks(noName))).toThrow(
      SapRenameError,
    );
  });

  test("anything containing a digit is refused", () => {
    expect(() =>
      purchaserNameBlock(textBlocks(block(672, " 385315577"))),
    ).toThrow(SapRenameError);
  });

  test("a page with no text at all is refused", () => {
    expect(() => purchaserNameBlock(textBlocks(""))).toThrow(SapRenameError);
  });

  test("refuses when the top-left block isn't also first in stream order", () => {
    // Both signals have to agree: a layout change that moves the name without
    // reordering the stream (or vice versa) must stop us, not be guessed at.
    const reordered =
      block(600, " Somebody Else") + block(672, " Cameron Tacklind");
    expect(() => purchaserNameBlock(textBlocks(reordered))).toThrow(
      SapRenameError,
    );
  });

  test("an implausibly long 'name' is refused", () => {
    expect(() =>
      purchaserNameBlock(textBlocks(block(672, ` ${"x".repeat(80)}`))),
    ).toThrow(SapRenameError);
  });
});

describe("writing the replacement", () => {
  test("encodes as UTF-16BE hex, which needs no escaping", () => {
    expect(hexString("Al")).toBe("<0041006c>");
    expect(hexString(" A")).toBe("<00200041>");
  });

  test("a name containing PDF delimiters can't corrupt the stream", () => {
    // `(`, `)` and `\` are what a literal string operand would have to escape.
    // Hex sidesteps the whole class: the output is only ever 0-9a-f.
    const out = hexString("Jo (Jay) O'Neill\\");
    expect(out).toMatch(/^<[0-9a-f]+>$/);
    expect(out.length).toBe(2 + "Jo (Jay) O'Neill\\".length * 4);
  });

  test("accented Latin survives the round trip", () => {
    expect(hexString("ë")).toBe("<00eb>");
  });

  test("astral characters encode as their codepoint, not a surrogate pair", () => {
    // Iterating a string with for..of yields whole codepoints. The SAP font has
    // no glyph for these, so `renameHolderOnPage` refuses long before here —
    // this just pins down that we don't silently emit half a character.
    expect(hexString("😀")).toBe("<1f600>");
  });
});
