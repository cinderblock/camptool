# Aerial photo under the camp map

> Living plan. Plan path: `plans/map-aerial-photo.md`

## Goal

Let a camp put an overhead photo (drone shot, gigapan, satellite tile) of what
it actually built *under* its camp map, aligned to the lot, so the plan can be
compared with reality and next year's planning can start from what really
happened. First use: Math Camp's 2026 gigapan from Saturday of event week.

Cameron's three asks (2026-11-05):

1. A way to upload a "satellite" view for a camp.
2. A way to align it to the camp (that gigapan is shot with 12:00 vertical).
3. Upload that picture to mathcamp's live instance for 2026, cropped to the
   area we got and rotated to match our map.

## Environment / context

- Live: https://camptool.mathcamp.us/map — 2026 lot is **E @ 3:14, 100′ × 200′,
  fronts the Man**, not locked (as of 2026-11-05).
- Source image: the attachment `…/attachments/00f92c9e-…-aa10cd87-….png`,
  2000×1150, 12:00 up.
- Measured from it: the 40′ hypar shade is ~390 px across → **≈9.5–10 px/ft**.
  Seed rotation for 3:14 facing the Man from a 12:00-up photo = **+83°** (CW).
- The photo is reality, the map is the plan, and they disagree: pyramid→hypar
  centre is ~69′ in the photo vs 91′ on the plan. So alignment can't just be
  computed — it's a control-point fit the officer refines.

## Decisions (made in this thread; Cameron can overrule)

1. **Reuse `camp_image`** for the bytes (`/api/media` upload, `/media/:id`
   serving, camp-scoped, private). The aerial row only references it.
2. **New table `map_aerial`, per edition** — each year's photo is of that
   year's layout. Several per edition allowed (Tue vs Sat shots); each has its
   own transform and a `visible` default.
3. **Transform stored in plot-local feet**: image centre `(cx, cy)` ft,
   `ftPerPx`, `rotation` (deg, clockwise on screen), `opacity`, plus a
   **crop** rect in image fractions. The original file is never re-encoded
   (full-res originals are a locked decision) — crop/rotate are metadata.
4. **Alignment = two-point fit** (click a feature in the photo, then where it
   is on the map, twice → similarity transform), plus numeric nudges.
   Rotation is seeded from the event's orientation ("12:00 up" for BRC, or
   "north up") and the lot address.
5. **Not part of map undo/snapshots/versions.** It's a reference layer, not
   the plan. Stripped from the Burning Man export.
6. **Officers manage it, even in a locked year** — the photo of what got
   built arrives after the event, which is exactly when years get locked. It
   doesn't change the plan, so the lock doesn't need to block it.
7. **Everyone who can see the map sees the photo** (camp-internal, private
   first — no new public surface), with a per-viewer show/hide toggle.

## Plan / steps

1. [x] Schema + migration (`map_aerial`).
2. [x] Pure geometry `app/lib/aerial.ts` + tests (two-point fit, seed
       rotation, image↔plot mapping).
3. [x] `/api/media` accepts map-officer uploads; `unusedImageIds` counts
       aerial references.
4. [x] Map loader/action intents: addAerial / updateAerial / deleteAerial.
5. [x] Render layer in the editor SVG (under zones/objects), stripped in the
       BM export; full-res variant layered in when zoomed.
6. [x] Officer panel: upload, orientation seed, opacity, visible, crop,
       two-point align, nudge, delete. Viewer toggle.
7. [x] Verify locally (typecheck, lint, tests, drive it).
8. [ ] **(current)** Commit, deploy, confirm `/_version`.
9. [ ] Upload the 2026 gigapan on live and align it.

## Findings / gotchas

- `exportMapJpeg` clones `#camp-map-svg`; anything not tagged and stripped
  lands in the BM submission. The photo layer is `data-map-aerial` and is
  stripped there (verified: clone keeps 0 `/media` images).
- Clicks for the alignment are caught with `onPointerDownCapture` on the SVG,
  so objects' own drag handlers never see them while aligning.
- During the "click on the photo" steps the photo is drawn a second time on
  top of everything, opaque — otherwise you're clicking through tents.
- Local driving: ports 17923…18190 were all taken (other threads' dev
  servers); Vite walked up to 18191. The first page load after a fresh
  `bun install` reloads mid-test while Vite optimizes deps — rerun.
- 4 failures in `app/lib/sap-pdf.test.ts` on this machine (bun 1.4.2), in code
  this work didn't touch — logged in `plans/issues.md`.
- E2E (`e2e/map-aerial.ts`) passed 7/7 locally: upload, seeded 83°, bytes
  served, two-point fit lands both points (< 2.5 view units), persists across
  reload, viewer hide, no page errors.

## Progress log

- 2026-11-05: plan written; live lot + object data read.
- 2026-11-05: feature built + verified locally (typecheck, lint, unit, e2e).

## Open questions for the user

(none yet)

## Things not to do

- Don't re-encode/rotate the original file to "bake" the alignment.
- Don't put the photo in map snapshots (restoring a version would move it).
