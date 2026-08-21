# SAP import, assignment, and controlled release

> Task plan. Parent living plan: `plans/camptool.md`.
> Related: `plans/arrival-sap-and-removal.md` (the entitlement half — requests,
> grants, "on or after" dates), `plans/party-member-links.md` (travel groups).

## Goal

Today a camp lead downloads a multi-page PDF of Setup Access Passes from
Burning Man, slices it by hand, and emails pages to people. Replace that with:

1. **Import** the vendor PDF into CampTool; parse each page into a pass record
   (on-or-after date, ticket ID, confirmation ID, security code, scan code).
2. **Assign** a pass to a camper **without giving them the codes**.
3. **Release** a pass — the codes go out — as a deliberate, hard-to-reverse act,
   because once the secrets have been sent they cannot be un-sent.
4. **Deliver** each released pass as a correctly-sliced single-page PDF, and
   additionally as **our own rendering** that puts a whole travel group's passes
   on ONE page so a group arriving together needs one sheet at the gate.

## Timing (matters)

Written 2026-08-21. Gates open **2026-08-30**; the setup window is **Aug 24–29**.
The first setup day is **three days out**. Sequence for "usable this week":
import → assign → release → per-person PDF. The combined group page is the
second landing, not a blocker for distributing this year's passes.

## What the vendor PDF actually contains (verified 2026-08-21)

Samples: `~/Downloads/Math Camp SAPs 2024 *.pdf` — last year's manual slices,
26 passes total (ticket IDs 385315574–385315599), one SAP per page, US Letter
(612×792pt).

Per page, from the **text layer** (extracts cleanly with `pdftotext -layout`;
no OCR needed):

| Field | Example | Notes |
|---|---|---|
| Holder name | `Cameron Tacklind` | The **purchaser**, identical on every page — NOT the assignee. Ignore it. |
| Ticket ID | `385315577` | Unique per pass. The stable import key. |
| Confirmation Id | `1DDGTGF159110514` | **Shared across the whole order**, not per pass. |
| On-or-after date | `Placement Setup Pass (SAP) 8/23 & Later` | `M/D`, **no year** — take the year from the event line. |
| Event | `Black Rock City: Access 2024` | Source of the year. |
| Security code | `1/Ca/9Tc3i2RM03ja1P5TswFKPQy0h4QJJFKqVbDSKIheyKU` | 48 chars, includes `/`. |
| Face value | `$0.00` | Ignore. |

Per page, from **images** (the part that needs real work):

- A **174×174 JPEG QR code** — decodes to a **10-digit scan code**, e.g.
  `7011757755`. This is the value the gate scans.
- A **30×79 JPEG Code128** strip, drawn rotated, encoding the same 10 digits.
  Too low-resolution to decode as an image (79px across ~10 digits) — don't try.
  **Decode the QR instead**; it carries the same value at usable resolution.
- The scan code is **not in the text layer** and is **not derived** from the
  ticket ID (verified: 385315582→`4666883273`, …583→`1162579105`,
  …584→`7009301048`, …585→`9599056047` — unrelated, random).
- Shared chrome: one big indexed background (2260×3143) + two 1801×1897 logos.

So a full parse needs text extraction **and** QR decoding. Both are done and
proven on the real files.

## FINDING: the current hand-sliced PDFs leak every other pass

Each per-person file drawn from the 2024 order **still embeds all 26 QR codes**.
`Math Camp SAPs 2024 Allen.pdf` is one page, draws XObjects `I1,I2,I3,I10,I11`
— and carries **55 image XObjects, containing 26 distinct QR codes**, one for
every SAP in the order. Verified by decoding all of them out of Allen's file.

Whoever slices this way hands each recipient every other camper's scan code;
recovering them is ~20 lines of Python. The 2024 codes are long expired, so
this is not a live incident — but it means:

- **Slicing must rebuild the page**, carrying only the resources that page
  draws — not `copyPages` of a page whose resource dict is the whole document.
- Every produced PDF gets an **automated leak assertion** in tests: extract all
  QR codes from the output and require exactly one, matching the intended pass.
  This is the single highest-value test in the feature.

## Design

### Two tables, deliberately separate

The existing `setup_pass` is the **entitlement** — "this person asked for / was
granted early access", already wired into requests, quotas, onboarding and the
officer queue (`plans/arrival-sap-and-removal.md`). It stays as-is.

New `setup_pass_stock` is the **physical pass** — a row per page of an imported
PDF, carrying the actual codes. Keeping them apart means: a grant can exist
before stock arrives (true today — the camp grants before BM sends passes), and
stock can sit unassigned in the pool. Assignment binds one to the other.

```
setup_pass_stock
  id, camp_id, edition_id
  pass_date_id        -> setup_pass_date (matched/created by parsed date)
  vendor_ticket_id    unique per edition — the import idempotency key
  confirmation_id     (order-level, repeated)
  security_code       48-char secret          ─┐ never leave the server
  scan_code           10-digit secret         ─┘ unless status = released
  source_document_id  -> sap_document (the uploaded PDF)
  source_page_index   0-based page in that PDF
  status              available | assigned | released | void
  assigned_attendee_id -> attendee (member OR host-managed guest)
  assigned_at, assigned_by_membership_id
  released_at, released_by_membership_id
  void_reason, void_at, void_by_membership_id
```

`sap_document` holds the uploaded original: metadata row + bytes on disk, using
the **exact `campImage` pattern** (`app/lib/images.server.ts` — bytes under
`<UPLOADS_PATH>/<camp_id>/...`, path built from uuids only, never user text).
Consequence already documented there: `/export-db` is not a complete backup.

### The state machine

```
available ──assign──> assigned ──release──> released
    ^                     │                     │
    └────unassign─────────┘                     │
                                                v
                     (admin + typed confirm) burned/void
```

- **assign** — reversible, silent, no codes revealed. The assignee sees only
  "a pass is set aside for you, valid on or after Mon Aug 24". Officers see the
  same. **Nobody sees the codes**, not even officers, until release.
- **release** — the irreversible one. Reveals codes to the assignee and makes
  the sliced PDF downloadable. Requires typed confirmation.
- **un-release is NOT a state transition back.** Once out, the secret is out.
  The only backward move is **void/burn** (admin-only, reason required), which
  marks the pass unusable and does **not** return it to the pool — it needs a
  replacement from BM. Anything else would be a lie about what's recoverable.
- Every transition writes an audit row (who, when, what). For a scarce
  transferable secret, "who released this" must be answerable later.

### Codes never reach a browser that isn't entitled

`security_code` / `scan_code` are excluded from every loader by default. They
are returned only to (a) the assignee, (b) their party host, (c) an officer —
and only when `status = released`. Privacy/demo mode (`redact`) strips them
unconditionally. The rule to hold: **a code in a loader payload is a code in the
browser's memory and in any screenshot** — so the sliced PDF and the combined
page are served as authenticated streaming downloads, not embedded data.

### Rendering

- **Sliced single-page PDF** — rebuild the page with `pdf-lib`, keeping only
  that page's resources. Leak-asserted (above).
- **Combined travel-group page** — our own layout, generated server-side: one
  row per pass with holder name, on-or-after date, a **freshly generated** QR
  (from the decoded scan code) and Code128, plus the security code in
  monospace. Because we hold the value, the regenerated QR is crisper than the
  original 174px JPEG. A "travel group" is the existing **party**
  (`app/lib/party.ts` — host + guests + linked members), with an officer
  override to build an ad-hoc set.
- Both carry the BM copy ("NOT A TICKET", the no-redistribution warning) — it
  is a condition of use, and the combined page must not drop it.

### Libraries (none present today)

- `pdf-lib` — slice + generate. Pure JS, Bun-clean.
- `unpdf` (pdf.js repack) — text layer extraction server-side.
- QR **decode**: `zxing-wasm` or `jsqr`. Needed at import.
- QR/Code128 **encode**: `bwip-js` — both symbologies, one dependency.

Bun + `bun.lock` per the global standard.

## Decisions (user, 2026-08-21 — don't re-ask)

1. **Secrets stored plain.** No encryption at rest; codes are plain columns and
   the source PDFs are plain files, protected by app authorization and file
   permissions. Chosen over an env-key scheme to avoid a lock-yourself-out
   failure mode days before setup.
   **Consequence, stated so it isn't a surprise:** anyone holding a
   `/export-db` dump or an `uploads/` backup holds usable passes. So — backups
   of this deployment are now secret-bearing and should be treated like the
   passes themselves. If that ever stops being acceptable, the migration path is
   an env-key wrap on the two code columns; nothing else in the design changes.
2. **Release delivers in-app now; email later.** Released ⇒ visible to the
   assignee and their party host, with the sliced PDF downloadable. No mail on
   the critical path this year. Email is a follow-up once the core is proven.
3. **Quota derives from imported stock** — `quota` for a date becomes the count
   of passes imported for it. Hand-editing stays available for dates with no
   stock yet, so grants against not-yet-delivered passes still work.
4. **Travel group = the existing party**, plus an officer-picked ad-hoc set as
   an escape hatch (shared vehicle, not a household).

## Steps

- [ ] Answers to the four questions above; fold into this plan.
- [ ] Deps + `packages`/lib scaffolding.
- [ ] `scripts/parse-sap-pdf.ts` — standalone CLI over a PDF → JSON rows. Proves
      parsing on the real 2024 files before any schema exists.
- [ ] Schema + migration (`sap_document`, `setup_pass_stock`, audit).
- [ ] Import UI: upload → preview parsed table → confirm → idempotent by
      `vendor_ticket_id` (re-importing the same PDF must not duplicate).
- [ ] Assign / unassign (officer), respecting arrival-date matching from the
      existing queue.
- [ ] Release (typed confirm) + void/burn (admin, reason).
- [ ] Camper view: assigned state (no codes) → released state (codes + PDF).
- [ ] Sliced-PDF generation **+ the leak assertion test**.
- [ ] Combined travel-group page.
- [ ] E2E covering the whole lifecycle; `e2e/passes.ts` for the existing
      entitlement flow, which currently has no committed coverage.

## Findings / gotchas

- Text layer is reliable — **no OCR anywhere in this feature**.
- The 30×79 Code128 image is undecodable; the QR is the only readable source of
  the scan code. Don't waste time on the barcode strip.
- "8/23 & Later" has no year. Parse the year from `Black Rock City: Access 2024`
  and cross-check against the edition — refuse to import a 2024 PDF into the
  2026 edition rather than silently mis-dating passes.
- Confirmation ID is order-level. Do not treat it as a per-pass identifier.
- The purchaser's name on every page is not the assignee. Never display it as
  one.

## Things not to do

- Don't slice with a naive `copyPages` — that is exactly the bug that leaked 26
  QR codes into every 2024 file.
- Don't let un-release exist as a quiet undo. It cannot be one.
- Don't ship codes in a loader payload "because the UI needs them".
