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
4. **Crop is a rectangle in the photo's own frame, plus "Clip to the lot".**
   A photo is rarely square to the lot (the 2026 gigapan is ~11° off), so a
   rectangle alone can't crop to "the area we got"; the lot clip reuses the
   map's lot-outline clipPath. Off while aligning, so features just outside
   the lot stay clickable.
5. **Alignment = two-point fit** (click a feature in the photo, then where it
   is on the map, twice → similarity transform), plus numeric nudges.
   Rotation is seeded from the event's orientation ("12:00 up" for BRC, or
   "north up") and the lot address.
6. **Not part of map undo/snapshots/versions.** It's a reference layer, not
   the plan. Stripped from the Burning Man export.
7. **Officers manage it, even in a locked year** — the photo of what got
   built arrives after the event, which is exactly when years get locked. It
   doesn't change the plan, so the lock doesn't need to block it.
8. **Everyone who can see the map sees the photo** (camp-internal, private
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
8. [x] Commit, deploy, confirm `/_version` — f8b524d live 2026-11-05 3:12 PM PST (23:12Z)
       via ops Renovate (pin bump af9597a6).
9. [x] Upload the 2026 gigapan on live and align it (2026-11-05).
10. [x] Follow-up: "Clip to the lot" + the missing opaque photo layer for
        the photo-click steps; 3e77899 live 2026-11-05 ~3:45 PM PST (23:45Z)
        via ops pin ce24353b; clip turned on for 2026 (rect crop reset to full).

11. [x] Before/after **swiper** (Cameron, 2026-11-05: "needs a swiper…
        pure css… super efficient"). Native range input over the map, thumb =
        divider; its `input` event writes `--ct-swipe` on the host; an opaque
        photo copy wears `clip-path: inset(…) view-box` reading it. No React
        state while dragging. Underlay hidden while swiping so the plan side is
        the plain plan. Top/bottom = same input with `writing-mode:
        vertical-lr`.
12. [x] Swiper deployed: 1da9ffa live 2026-11-05 ~4:20 PM PST (00:20Z) via ops
        pin ce181ad5; checked on the live 2026 map.

## Findings / gotchas

- Swiper: pure CSS can't read a range input's value, so one native `input`
  handler writing a CSS variable is the minimum JS. The thumb's centre travels
  T/2…(size−T/2), so the clip position is corrected by the thumb size (32 px)
  or the line and the photo edge drift apart near the ends. The input lives in
  a wrapper sized exactly to the SVG, so its % and the clip's `view-box` %
  share a frame at every zoom. Pixel-checked in e2e (left strip at 50% ==
  all-photo, right strip == all-plan).
- `getByText("Off")` is ambiguous on the map page (another segmented control);
  scope e2e locators to the Aerial photo card.

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

- **Deploy path changed 2026-09-18**: camptool CI only builds
  `ghcr.io/cinderblock/camptool:<sha>`; ops Renovate (daily 4:00 AM PST /
  12:00Z, or `gh workflow run renovate.yml -f dry_run=false` on
  cinderblock/ops) bumps `servers/firefly/stacks/camptool/pin.json`, tests it
  on `renovate/**`, fast-forwards ops master, and that push deploys. A plain
  `workflow_dispatch` defaults to **dry run** and ships nothing.
- 2026 alignment, measured from the photo (not computed from the address):
  hypar shade corners ≈ (1010,471) (1338,533) (1273,848) (941,773) px →
  centre (1140,656), side ≈ 326 px for 40′ → **8.15 px/ft**; edges sit 10.7°
  off the photo axes → **turn 79.3°** (the address seed says 83°; the camp was
  built square to the lot, so the structures win). Hypar centre pinned to its
  planned centre (39.5′, 116′) → cx 46.08′, cy 97.28′. Cross-check: the photo's
  pyramid then lands at (41.9′, 25.6′) vs planned (38′, 25.3′) — within 4′.
  The pyramid itself is too 3D/off-nadir to measure scale from.
- An earlier eyeball estimate (≈10 px/ft, "pyramid→hypar 69′ vs 91′ planned")
  was wrong — the scale was off, not the layout.

## Progress log

- 2026-11-05: plan written; live lot + object data read.
- 2026-11-05: feature built + verified locally (typecheck, lint, unit, e2e).
- 2026-11-05: deployed (f8b524d); uploaded "Saturday gigapan (2026)" on live,
  aligned from the hypar (above), opacity 80%.
- 2026-11-05: clip-to-lot + opaque photo-step layer; e2e 9/9; deployed;
  2026 photo clipped to the lot on live. All steps done.

## Open questions for the user

(none yet)

## Things not to do

- Don't re-encode/rotate the original file to "bake" the alignment.
- Don't put the photo in map snapshots (restoring a version would move it).
