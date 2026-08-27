# Putting the holder's name on the Setup Access Pass

> Task plan. Parent living plan: `plans/camptool.md`.
> Related: `plans/sap-import-and-distribution.md` (import, slicing, release).

## Goal

Cameron, 2026-08-27: *"on the SAP PDFs, they all say 'Cameron Tacklind' — can we
edit that text in the PDF to be the user's name?"*

Every page of a camp's SAP order carries the **purchaser's** name — one person,
repeated on all 26 pages, because one person bought the allocation. A camper
handed that file sees a stranger's name on their own pass. Replace it with the
assignee's.

## The concern, raised and answered

Editing the identity line on a vendor-issued access credential is a different
act from slicing a page out of the order, and the pass's own text threatens
cancelling **all of a group's SAPs** for misuse. If gate staff ever cross-check
the printed name against BM's record, a *changed* name is worse than the
original one.

That was put to Cameron with three options (add an "Issued to" line / replace
outright / replace but keep the purchaser visible). **Decision: replace
outright.** Not to be re-litigated; if it ever needs revisiting, the additive
"Issued to" variant is a ~20-line change to the same module.

## What the vendor's page actually is (verified on the real 2024 and 2026 files)

The name is **one isolated text block**, nothing else shares it:

```
BT 75.000 672.000 Td /F1 11.0 Tf 0.000 Tw ( C a m e r o n   T a c k l i n d) Tj ET
```

The spacing is an artefact of viewing UTF-16BE bytes as latin1 — every character
is two bytes with a NUL in front.

| Property | Value | Why it matters |
|---|---|---|
| Font | `/F1` `OpenSans-Regular`, **Type0 / Identity-H**, CIDFontType2 | Not a simple font; operands are 2-byte codes |
| CID | **equals the Unicode codepoint** | So a name encodes as plain UTF-16BE |
| Glyphs | embedded `FontFile2` + a **`CIDToGIDMap` stream** | GID 0 = no glyph ⇒ **checkable coverage** |
| Coverage | all 95 printable ASCII, plus accented Latin (`ë` ✓); **no CJK** | The one real limit |
| Position | `(75, 672)`, first block in stream order, both years | Two independent signals to identify it |
| Neighbour | "Face Value $0.00" at x≈243 | ~168pt of room before a collision |

## Design

- **Replace, don't paint over.** A white rectangle would leave the old name in
  the text layer for anyone running `pdftotext` — worse than not doing this.
  The string operand is rewritten, so the old name is gone from the file.
- **Written as a PDF hex string** (`<00200043…>`) rather than a literal `(…)`.
  A name containing `(`, `)` or `\` would otherwise need escaping and could
  corrupt the content stream; hex sidesteps the class entirely.
- **Identified structurally, never by coordinate.** The vendor's date label
  moved three times in two years (see `sap-pdf.server.ts`), so nothing here
  trusts a magic string or an `x`/`y`. The name is *the leftmost upright block
  on the topmost text line*, **and** must also be first in stream order — both
  signals must agree. Anything matching a known field, containing a digit, or
  over 60 characters is refused.
- **Glyph coverage is checked before writing.** Every character is looked up in
  the `CIDToGIDMap`; a missing glyph would print as nothing at all, so it
  refuses instead.
- **Long names shrink rather than collide.** The name is measured against the
  font's `/W` widths and the type shrinks (to a floor of 6pt) until it clears
  whatever sits to its right.
- **Verified after the fact, on the finished bytes.** `assertRename` re-reads
  the produced page the way any other tool would and requires: the old name is
  gone, the new name really comes back out, and the ticket ID, on-or-after date
  and security code all still parse. A pass whose *date* silently changed would
  be discovered at the gate.
- **Failure falls back to the untouched vendor page**, with a `console.warn`.
  A pass with the wrong name still opens the gate; a camper with no pass does
  not. This is the one place in the SAP feature that degrades rather than
  refuses, and it's deliberate — the alternative is losing every download the
  day the vendor changes their layout.
- **Self-assignment is a no-op.** The purchaser is a camper too; if the name is
  already right, nothing is rewritten.

## Files

- `app/lib/pdf-content.server.ts` — **new.** Read/write a page's content stream
  as latin1 text. Shared with the slicer, which previously had its own copy.
- `app/lib/sap-rename.server.ts` — **new.** Everything above.
- `app/lib/sap-rename.test.ts` — **new.** 14 tests over captured content-stream
  snippets (no PDF in the repo, same arrangement as `parseTextFields`).
- `app/lib/sap-slice.server.ts` — takes an optional `holderName`; renames before
  the page copy so every existing self-check covers the final bytes; adds
  `assertRename`.
- `app/lib/sap-pdf.server.ts` — exports `pageTextItems` (text only, no QR
  decode) for that verification.
- `app/lib/sap.server.ts` — `slicedPassPdf` takes the holder and owns the
  fallback.
- `app/routes/sap.pass.$stockId.tsx` — passes the assignee (member, guest, or
  external holder).

## Verified

Against the **real 2024 and 2026 orders** (never committed), and rendered in
Chrome to confirm it looks right rather than merely extracting right:

- 2024 and 2026 layouts both rename correctly, ~300–500ms.
- `"Allen Kim"` renders in the vendor's own font, in the right slot, with every
  other field untouched — confirmed visually.
- `"Bartholomew Fitzwilliam-Harrington III"` auto-shrinks and clears the "Face
  Value" column — confirmed visually.
- `"Cameron Tacklind"` (self-assignment) → no-op, no false failure.
- `"Cameron Tacklind Jr"` → works; the "old name is gone" check is correctly
  skipped when the new name contains the old.
- `"Jo (Jay) O'Neill\"` → parens and backslash survive intact.
- `"Zoë Ruiz-Nakamura"` → accented Latin fine.
- `"李明"` → refused cleanly ("no glyph … would print blank") → falls back.
- Full suite: 430 unit tests, 81 e2e assertions, typecheck + build + biome.
- E2E assertion **8e** covers the fallback: its synthetic order is drawn in a
  standard font, so the rename *cannot* apply — and the pass is still delivered,
  scannable, with one QR. The server log shows the warning firing.

## Findings / gotchas

- **The vendor escapes `(` in "Placement Setup Pass (SAP)".** A test fixture
  written without that escaping came out one block short — caught by the test
  asserting the block count, which is why that assertion is there.
- **Self-assignment nearly shipped broken.** `assertRename` originally required
  the old name to be absent, which fails when the purchaser is also the
  assignee — the single most likely case for the camp lead. Now skipped when
  the new name contains the old.
- Two nets catch a non-CID font: the name-block guards, and `loadCidFont`
  refusing anything that isn't a composite font. The e2e's synthetic pages hit
  the second.
- pdf.js text extraction returns the name as one item, so the "did it really
  come back out" check is a plain `includes`.

## Things not to do

- Don't paint a rectangle over the name. The text layer would still carry it.
- Don't anchor on `(75, 672)` or on any label text. Both have moved.
- Don't make a rename failure fatal. Delivering the vendor's page is the
  correct degradation; a camper at the gate with no pass is not.
- Don't skip `assertRename`. It is the only thing standing between a
  content-stream edit and a pass with a silently wrong date.
