# Map status overlay · print styles · Burning Man export

> Living plan. Plan path: `plans/map-status-print-export.md`
> Parent plan: `plans/camptool.md` (see "Map versioning" + Phase 3).

## Goal

Three related map features so campers can tell how "done" a layout is, and so
officers can produce a submission-ready file:

1. **Status overlay** — a free-text label ("DRAFT", "NOT FINAL", "FINAL",
   "FINAL v2 REALLY v3.5…") shown over the map so viewers know it isn't final.
2. **Print** — dedicated print CSS: printing the map page prints *just the map*
   (plus the status overlay), not the whole app chrome.
3. **Export for Burning Man** — officer-only export following BMorg's file
   conventions (single-page portrait image, camp name + contact + dimensions,
   fuel/battery safety zones, strict filename rules). See spec at bottom.

## Environment / context

- Map lives in `app/routes/dashboard/map.tsx` (~7k lines). Loader returns
  `campName`, `lot` (frontageFt/depthFt/street/address/year/frontsToMan),
  `objects`, `zones`, `cables`, `roads`, `canManage`, `event`, `myMembershipId`.
- Per-year scope = `camp_edition` (`db/schema/camp.ts`). The status label belongs
  here (one map per edition). `event` on the edition gates BM-specific UI
  (`isBurningMan` in `app/lib/events.ts`).
- The map is a single root `<svg>` in the `Editor` component (good for
  serialize→canvas export and for print isolation).
- No `fuel`/`battery` structure kind exists today (only `power`/`generator`
  marker). No phone field on `user`. These gate parts of the BM export.

## Decisions already made (locked with the user)

- Status label scope = **per-edition free text** on `camp_edition.map_status`
  (nullable; empty/null = no overlay). Officer-editable. Quick presets
  (DRAFT / NOT FINAL / FINAL) + free text.
- Status is not the same as the edition `locked` flag — locked = read-only;
  status = a human label about doneness. Independent.

## Resolved questions (2026-07-02)

1. **Fuel/battery safety circles → MODEL NOW.** Add `fuel-storage` + `battery`
   structure kinds. Fuel-storage auto-draws the 10'/20'/50' rings; battery draws a
   safety zone when its capacity ≥100kWh (small personal batteries excluded). The
   export includes these automatically.
2. **Contact info → PERSIST.** Store a reusable placement-contact block
   (first/last name, playa name, email, phone) so it's remembered between exports.
   Camp-scoped (the camp's designated placement contact; persists across years).
   `version` = the map status label; `date` = export date.

## Plan / phases

**Phase A — Status overlay (start here; unblocked).**
- Migration: add `map_status text` to `camp_edition`.
- Loader returns it; officer control in the map right-rail (preset chips + free
  text input, save via fetcher; read-only when locked).
- Render a diagonal translucent watermark over the map SVG when non-empty.

**Phase B — Print CSS.**
- `@media print` styles: hide app chrome/rail/toolbar; show only the map + status
  overlay; force portrait; page-break-avoid. A "Print" button calls
  `window.print()`. Verify the overlay prints.

**Phase C — Export for Burning Man (officer + `isBurningMan` only).**
- Client-side: serialize the map `<svg>` → draw to a portrait canvas at print
  resolution → overlay required text (camp name, dimensions in feet, contact,
  date+version, status) → `canvas.toBlob('image/jpeg')` → download.
- Filename: `<=20 chars`, no spaces, underscores, `<campabbr>_<mm>_<dd>.jpg`.
- Safety rings + battery zone per Q1 answer.
- Validate: single page, portrait, ≤10MB, readable in B/W.

## BMorg file spec (verbatim requirements)

- Types: .jpg .jpeg .pjpeg .png; ≤~10 MB.
- Filename: `campname_mm_dd.jpg`; unique/abbrev camp name + day + month; NO spaces
  (underscores); ≤20 chars; include extension.
- 8.5×11 standard paper; color OK but must be readable in B/W; large text for camp
  name + dimensions; no satellite photos.
- Single page, **portrait**.
- Include: camp name, first + last name, playa name (optional), email, phone,
  date + version.
- Overhead/bird's-eye. Dimensions in **feet**.
- Fuel storage: mark it + draw 10' (no ignition sources), 20' (liquid↔propane),
  50' (to another fuel area) rings.
- Battery ≥100kWh: indicate a minimum safety zone. Small personal batteries: skip.

## Progress log

- [x] Phase A — status overlay. Migration 0037 (`camp_edition.map_status`);
      loader returns it; officer `MapStatusControl` in the rail (DRAFT/NOT FINAL/
      FINAL presets + free text, save via fetcher intent `setMapStatus`, capped 60
      chars, read-only when locked since the whole action 403s); diagonal
      translucent watermark (×3, top/mid/bottom) drawn inside the map SVG so it
      prints + exports. typecheck/build/lint green. NOT yet browser-verified.
- [x] Phase B — print CSS. `MAP_PRINT_CSS` injected on the map page; a Print
      button calls `window.print()`. Classic visibility-isolation reveals only the
      `.camp-map-print` column, forces a portrait `@page`, and shows a print-only
      caption (camp name · dims · address · status). Watermark prints via the SVG.
      NOT yet browser-verified (print preview).
- [x] Phase C — `fuel-storage` + `battery` kinds (Power group). Fuel draws
      10/20/50′ rings; battery draws a safety ring when its `kwh` control ≥100
      (radius = `safetyFt`, default 20′). Rings render in plot-local feet under
      the markers, so they print + export. Committed 8e33fe0.
- [x] Phase D — `camp.placement_contact_{name,playa,email,phone}` (migration
      0038); loader returns `contact` + `account` fallback; officer action
      `setPlacementContact`. Camp-scoped (persists across years).
- [x] Phase E — `BurningManExport` dialog (officer + isBurningMan). Persists the
      contact, then `exportMapJpeg` clones `#camp-map-svg`, inlines *computed*
      styles (so CSS-var fills resolve), rasterizes via an SVG data-URL Image onto
      an 8.5×11 @200dpi portrait canvas with a header (camp name, dims, contact,
      date+version), and downloads `<abbr>_mm_dd.jpg` (abbrev ≤10 → filename ≤20).
      typecheck/build/lint green. NOT yet browser-verified — the SVG→canvas
      color/quality path especially needs eyeballing.

## Live verification (2026-07-02, camptool.mathcamp.us/map)

BROWSER-VERIFIED as Cameron (Math Camp @ Group W, 2026): DRAFT watermark renders
over the map; Map status presets + free text work; object labels now align to each
object's long axis (upright). Export dialog opens with the **persisted** contact
(playa "Quadrangle", phone) + version from the status; filename preview
`mathcampgr_07_02.jpg` (20 chars). On Export JPEG the map **flips to light**, renders,
downloads, and **restores to dark** — no errors. (Did not open the downloaded JPEG
via automation; user to eyeball final header text + stripped camper names.)

### Post-review fixes (all deployed green)
- Export renders a LIGHT copy **off-screen** — clone the SVG under a hidden
  `data-mantine-color-scheme="light"` wrapper and read computed styles there, so
  the map's scheme vars resolve light in that subtree only. **Never touches the
  live page's theme.** (Superseded a first attempt that flipped the whole app's
  Mantine scheme via `setColorScheme` + restore — that mutated the live page and
  got **stuck cycling** light/dark, and persisted `mantine-color-scheme-value` to
  localStorage. Don't flip the live page to snapshot it.) Needed broadening the
  `MAP_SCHEME_CSS` selectors from `html[...]` to `[...]` so a wrapper can scope
  the vars. Residual: JS-derived shadow literals (#000/0.85) stay dark-tuned but
  read fine on white.
- Dates are ISO `YYYY-MM-DD` (user hates MM/DD/YY — see memory).
- Contact renders `First "Playa" Last`.
- Object labels run along the dominant axis, folded to never be upside down.
- BM export strips campers' personal (occupant) names (`data-personal-name`).

### Known limitation
- A locked edition hides officer tools, so you can't export a locked year (export
  just before locking). Relax later if needed.

## Findings / gotchas
- **SVG export loses CSS variables.** The map fills use `var(--mantine-color-*)`
  and the scheme vars; a naive serialize→`<img>` renders them wrong. Fix:
  `inlineComputedStyles` copies each element's *computed* fill/stroke/etc onto a
  clone before serializing, so colors resolve. Watch for `text-transform` (may not
  apply when rasterizing) and any future external-image refs (would taint canvas).
- Export uses the CURRENT map state (sun/night/highlight). Officers should set a
  clear day + no highlight before exporting — noted in the dialog copy.

## Things not to do
- Don't add an icon library import (`@tabler/...`) — this project has none; use
  text buttons or the custom `KindIcon`/inline SVGs.
- Don't commit the `db/migrations/meta/0011–0023_snapshot.json` churn — it's
  pre-existing working-tree noise from another thread, not part of this work.
