/**
 * Tests for SAP import (`sap-pdf.server.ts`) and slicing (`sap-slice.server.ts`).
 *
 * Everything here runs against a **synthetic** SAP PDF built in-process. No real
 * pass ever enters this repository: a security code and a scan code are the
 * entire value of a pass, and this project is public. The fixture reproduces the
 * shape that matters — vendor field layout, a QR per page, and every page's
 * resource dictionary listing *every* QR in the document, which is exactly the
 * structure that made the camp's hand-sliced 2024 files carry all 26 codes.
 *
 * The load-bearing test is `does not carry other passes' QR codes`. If that ever
 * goes red, passes are leaking; nothing else here matters as much.
 */
import { describe, expect, test } from "bun:test";
import bwipjs from "bwip-js/node";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { parseSapPdf, parseTextFields } from "./sap-pdf.server";
import { scanCodesInEmbeddedImages, scanCodesInPdf } from "./sap-qr.server";
import { SapSliceError, sliceSapPage } from "./sap-slice.server";

/** Invented codes, in the vendor's shape but valid for nothing. */
const PASSES = [
  {
    ticket: "900000001",
    scan: "1111100001",
    date: "8/24",
    sec: "1/Zz/aaaAAA000+bbb/BBB111cccCCC222dddDDD333eee",
  },
  {
    ticket: "900000002",
    scan: "2222200002",
    date: "8/25",
    sec: "1/Zz/fffFFF444+ggg/GGG555hhhHHH666iiiIII777jjj",
  },
  {
    ticket: "900000003",
    scan: "3333300003",
    date: "8/26",
    sec: "1/Zz/kkkKKK888+lll/LLL999mmmMMM000nnnNNN111ooo",
  },
] as const;
const CONFIRMATION = "1ZZZZZZ000000000";

/**
 * A multi-page SAP PDF where **every page's resources list every QR** — the
 * vendor structure, and the reason a naive copy leaks. Only the page's own QR is
 * painted.
 */
async function buildFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const qrs = [];
  for (const p of PASSES) {
    const png = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: p.scan,
      scale: 3,
    });
    qrs.push(await doc.embedPng(new Uint8Array(png)));
  }

  for (const [i, p] of PASSES.entries()) {
    const page = doc.addPage([612, 792]);
    const line = (text: string, y: number, size = 10) =>
      page.drawText(text, { x: 55, y, size, font });
    line(`Ticket ID ${p.ticket}`, 700);
    line("Confirmation Id", 685);
    line(CONFIRMATION, 670);
    line(`Placement Setup Pass (SAP) ${p.date} & Later`, 655);
    line("Black Rock City: Access 2026", 640);
    line("This Setup Access Pass (SAP) is NOT A TICKET", 300);
    line(`Security code: ${p.sec}`, 50, 8);

    const own = qrs[i];
    if (own) page.drawImage(own, { x: 400, y: 600, width: 120, height: 120 });

    // The leak-shaped part: register the OTHER pages' QRs in this page's
    // resources without drawing them.
    for (const [j, other] of qrs.entries()) {
      if (j === i || !other) continue;
      page.node.setXObject(PDFName.of(`Unused${j}`), other.ref);
    }
  }
  return doc.save();
}

describe("parseTextFields", () => {
  const items = [
    "Cameron Tacklind",
    "Ticket ID 385315582",
    "Confirmation Id",
    "1DDGTGF159110514",
    "Placement Setup Pass (SAP) 8/22 & Later",
    "Black Rock City: Access 2024",
    "Security code: 1/Zz/notARealCode+with/slashes",
  ];

  test("reads every text-layer field", () => {
    const f = parseTextFields(items);
    expect(f.vendorTicketId).toBe("385315582");
    expect(f.confirmationId).toBe("1DDGTGF159110514");
    expect(f.onOrAfterDate).toBe("2024-08-22");
    expect(f.eventYear).toBe(2024);
    expect(f.securityCode).toBe("1/Zz/notARealCode+with/slashes");
  });

  test("takes the year from the event line, not the date", () => {
    // "8/22 & Later" carries no year at all — getting this wrong silently
    // mis-dates every pass in the order.
    const f = parseTextFields(
      items.map((s) => s.replace("Access 2024", "Access 2026")),
    );
    expect(f.onOrAfterDate).toBe("2026-08-22");
  });

  test("reads the date under every label the vendor has used", () => {
    // The label in front of the date is not stable. Anchoring on it cost a
    // whole import the first time it moved: the 2026 passes arrived saying
    // "Setup Access Pass 8/27 & Later" and every page came back unreadable,
    // because 2024 had said "Placement Setup Pass (SAP) 8/23 & Later".
    const labels = [
      "Placement Setup Pass (SAP) 8/23 & Later", // 2024
      "Placement Setup Pass 8/25 & Later", // 2026, the camp's allocation
      "Setup Access Pass 8/27 & Later", // 2026, a single pass
    ];
    const dates = labels.map(
      (label) =>
        parseTextFields([label, "Black Rock City: Access 2026"]).onOrAfterDate,
    );
    expect(dates).toEqual(["2026-08-23", "2026-08-25", "2026-08-27"]);
  });

  test("prefers the date on the line that mentions a pass", () => {
    // Falling back to the whole page is what keeps a fourth label working; the
    // "Pass" preference is what stops an unrelated "& Later" winning.
    const f = parseTextFields([
      "Gates close 9/1 & Later for exodus",
      "Placement Setup Pass 8/25 & Later",
      "Black Rock City: Access 2026",
    ]);
    expect(f.onOrAfterDate).toBe("2026-08-25");
  });

  test("keeps a security code containing / and +", () => {
    const f = parseTextFields(["Security code: 1/Ca/aa+bb/cc"]);
    expect(f.securityCode).toBe("1/Ca/aa+bb/cc");
  });

  test("reports nothing rather than guessing on an unrecognised page", () => {
    const f = parseTextFields(["Some other document entirely", "Page 1 of 4"]);
    expect(f.vendorTicketId).toBeUndefined();
    expect(f.onOrAfterDate).toBeUndefined();
    expect(f.securityCode).toBeUndefined();
  });

  test("ignores a nonsense date instead of building an invalid one", () => {
    const f = parseTextFields([
      "Placement Setup Pass (SAP) 13/45 & Later",
      "Black Rock City: Access 2026",
    ]);
    expect(f.onOrAfterDate).toBeUndefined();
  });
});

describe("parseSapPdf", () => {
  test("reads one pass per page, including the QR-only scan code", async () => {
    const pages = await parseSapPdf(await buildFixture());
    expect(pages).toHaveLength(3);
    for (const [i, got] of pages.entries()) {
      const want = PASSES[i];
      if (!got.ok || !want) throw new Error(`page ${i + 1} did not parse`);
      expect(got.vendorTicketId).toBe(want.ticket);
      expect(got.scanCode).toBe(want.scan);
      expect(got.securityCode).toBe(want.sec);
      expect(got.confirmationId).toBe(CONFIRMATION);
      expect(got.pageIndex).toBe(i);
    }
    expect(pages.map((p) => p.ok && p.onOrAfterDate)).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
  });

  test("a page it cannot read becomes a reported row, not a thrown import", async () => {
    // One unreadable page must not cost the camp the other 25.
    const doc = await PDFDocument.create();
    doc
      .addPage([612, 792])
      .drawText("Not a setup access pass", { x: 50, y: 700 });
    const [page] = await parseSapPdf(await doc.save());
    expect(page?.ok).toBe(false);
    if (page?.ok === false) expect(page.reason).toContain("ticket ID");
  });
});

describe("sliceSapPage", () => {
  test("does not carry other passes' QR codes", async () => {
    // THE test. A recipient must not be able to recover anyone else's pass from
    // the file we send them — including from images no page paints.
    const fixture = await buildFixture();
    expect(await scanCodesInEmbeddedImages(fixture)).toHaveLength(3);

    for (const [i, p] of PASSES.entries()) {
      const sliced = await sliceSapPage(fixture, i);
      expect(await scanCodesInPdf(sliced)).toEqual([p.scan]);
      expect(await scanCodesInEmbeddedImages(sliced)).toEqual([p.scan]);
    }
  });

  test("a naive copy leaks — which is why the prune exists", async () => {
    // Guards the reason for this module. If pdf-lib ever stops dragging the
    // whole resource dictionary along, this goes red and the prune can be
    // reconsidered on purpose rather than deleted as dead weight.
    const fixture = await buildFixture();
    const src = await PDFDocument.load(fixture);
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(src, [0]);
    if (copied) out.addPage(copied);
    const naive = await out.save();

    expect(await scanCodesInPdf(naive)).toHaveLength(1);
    expect((await scanCodesInEmbeddedImages(naive)).length).toBeGreaterThan(1);
  });

  test("produces a single-page document", async () => {
    const sliced = await sliceSapPage(await buildFixture(), 1);
    expect((await PDFDocument.load(sliced)).getPageCount()).toBe(1);
  });

  test("refuses when the page is not the pass we expected", async () => {
    const fixture = await buildFixture();
    // Cheap insurance that page N really is the pass the database says it is.
    await expect(sliceSapPage(fixture, 0, PASSES[1].scan)).rejects.toThrow(
      SapSliceError,
    );
    await expect(
      sliceSapPage(fixture, 0, PASSES[0].scan),
    ).resolves.toBeDefined();
  });

  test("rejects a page index outside the document", async () => {
    await expect(sliceSapPage(await buildFixture(), 9)).rejects.toThrow(
      SapSliceError,
    );
  });
});
