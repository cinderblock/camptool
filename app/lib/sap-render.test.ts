/**
 * The combined travel-group sheet must survive a round trip: whatever we encode
 * into its QR codes has to come back out, or a group arrives at the gate with a
 * page of pretty squares that scan as nothing.
 *
 * Codes here are invented — see the note in `sap-pdf.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { scanCodesInPdf } from "./sap-qr.server";
import { type SheetPass, renderGroupSheet } from "./sap-render.server";

const pass = (n: number): SheetPass => ({
  holderName: `Camper ${n}`,
  onOrAfterDate: `2026-08-2${n % 7}`,
  scanCode: `${n}${n}${n}${n}${n}00000${n}`.slice(0, 10),
  securityCode: `1/Zz/code${n}notReal+slash/parts${n}`,
  vendorTicketId: `90000000${n}`,
});

describe("renderGroupSheet", () => {
  test("every pass's scan code survives into a scannable QR", async () => {
    const passes = [1, 2, 3].map(pass);
    const pdf = await renderGroupSheet({
      groupLabel: "Albert's party",
      year: 2026,
      passes,
    });
    // Decoding our own output is the only check that matters here: it proves a
    // scanner at the gate reads the value we meant to put there.
    expect(await scanCodesInPdf(pdf)).toEqual(passes.map((p) => p.scanCode));
  });

  test("a group larger than one page keeps every pass", async () => {
    const passes = Array.from({ length: 8 }, (_, i) => pass(i + 1));
    const pdf = await renderGroupSheet({
      groupLabel: "Grace Crew",
      year: 2026,
      passes,
    });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect((await scanCodesInPdf(pdf)).sort()).toEqual(
      passes.map((p) => p.scanCode).sort(),
    );
  });

  test("one pass still produces a sheet", async () => {
    const pdf = await renderGroupSheet({
      groupLabel: "Rob",
      year: 2026,
      passes: [pass(4)],
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    expect(await scanCodesInPdf(pdf)).toEqual([pass(4).scanCode]);
  });

  test("renders a name the built-in fonts can't encode", async () => {
    // pdf-lib's standard fonts throw on non-WinAnsi text, so one camper with a
    // CJK name would otherwise take down their whole group's sheet — at the
    // point of use, days before the event.
    const pdf = await renderGroupSheet({
      groupLabel: "Ünal's party",
      year: 2026,
      passes: [
        { ...pass(6), holderName: "李明 Ünal Þorsteinn Ōno" },
        { ...pass(7), holderName: "Zoë Ngô" },
      ],
    });
    const text = (await import("unpdf")).extractText;
    const { getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    const { text: got } = await text(doc, { mergePages: true });
    // WinAnsi letters survive as themselves; "Ō" degrades to its base letter;
    // only what has no Latin form at all becomes "?".
    expect(got).toContain("Ünal");
    expect(got).toContain("Þorsteinn");
    expect(got).toContain("Ono");
    expect(got).toContain("Zoë");
    expect(await scanCodesInPdf(pdf)).toHaveLength(2);
  });

  test("carries no code it wasn't given", async () => {
    // The sheet is built from values, not cropped from vendor artwork, so there
    // is nothing to leak — assert it stays that way.
    const pdf = await renderGroupSheet({
      groupLabel: "Solo",
      year: 2026,
      passes: [pass(5)],
    });
    const { scanCodesInEmbeddedImages } = await import("./sap-qr.server");
    expect(await scanCodesInEmbeddedImages(pdf)).toEqual([pass(5).scanCode]);
  });
});
