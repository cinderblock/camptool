# NOC uplink radio — aiming a directional link from the camp map

> Living plan. Plan path: `plans/noc-uplink-radio.md`
> Parent plan: `plans/camptool.md` (Phase 3 — camp map editor)
> **Status: LANDED + browser-verified (2026-08-10).**

## Goal

Burning Man's IT team runs a **NOC** (Network Operations Center) in Black Rock
City with a tower carrying sector antennas. Any camp can get internet by mounting
a **directional microwave radio** (Ubiquiti NanoBeam-class), aiming it at that
tower, and keeping it powered. Aiming needs **line of sight** — so *which corner
of which structure* the radio goes on is a real planning decision, and today it's
made by squinting at the playa.

The map editor now answers it:

1. A faint **"→ NOC" bearing vector** across the lot, labelled with the distance
   and true-north bearing, plus a matching **NOC ray on the compass dial**.
2. A placeable **"Uplink radio"** structure — standalone, or parked on the
   corner/roof of an RV, container or shade frame — that auto-aims at the NOC,
   draws the cone it needs kept clear, and **flags anything of yours tall enough
   to block it**, using the antenna height vs. the obstruction's height.

## Layering (per `CLAUDE.md` — keep the seams clean)

- The **radio itself is generic** (a point-to-point link mast is not a
  Burning-Man idea) → `CORE_KINDS` in `app/lib/structures.tsx`.
- The **NOC landmark and its position are Burning-Man event data** → `Landmark`
  / `NOC_LANDMARK` in `app/lib/brc.ts`, next to the rest of the city geometry.
- The overlay is gated on `isBurningMan(event)`, so another event layer just
  supplies no landmark and the whole feature stays quiet.

## Where the NOC is

**6:15 & Esplanade, as a 100′-diameter target circle** (Cameron, who knows the
site). That's what `NOC_LANDMARK` encodes; the aim cone the map draws is exactly
the cone that covers that circle. Don't relitigate the position.

Supporting facts from Burning Man IT's participant guide
(`internet.burningman.org`), worth keeping because they drive the math:

> "Aim the radio visually toward the tallest tower in Center Camp, near the Cafe.
> The sector antennas are mounted at about 40 ft (2/3 up the 60 ft tower)."

The **40 ft antenna height** is what makes the sight line climb from the camp's
mast toward the tower, which is why a low structure well down the path doesn't
block it. From Math Camp's lot (E @ 3:14) the NOC is ~4,900 ft away, so the 100′
target subtends **~1.2°** — that's why the cone is a sliver near the radio.
Fine alignment is done on the radio itself (the guide points people at
`https://172.16.0.1` → Tools → Alignment).

Other facts worth keeping:

- **True north follows the 4:30 axis** (2025 measurements) — already modelled by
  `mapUpBearingFor`, and the NOC bearing is derived from the same constant, so
  compass and map can't drift apart.
- Compatible radios per BMorg: NanoBeam AC Gen2 (NBE-5AC-US, the recommendation),
  NanoStation Loco AC, NanoStation AC Gen2, LiteBeam AC Gen2, PowerBeam AC.
- BMorg guarantees no bandwidth, latency, uptime, or support.
- A too-tall pole that sways in the wind breaks the link — mast height is a real
  tradeoff, not "higher is always better". Worth surfacing if this grows.

Sources: https://internet.burningman.org/ (+ its FAQ),
https://bm-innovate.s3.amazonaws.com/2025/2025%20BRC%20Measurements.doc.pdf

## What landed

**`app/lib/brc.ts`**
- `bearingFromMan(hours)` — the one place the "12:00 is NE, clock runs clockwise"
  constant lives; `mapUpBearingFor` now derives from it instead of repeating it.
- `Landmark` type + `NOC_LANDMARK` (6:15, esplanade radius, 100′ target diameter,
  40′ antenna height).
- `landmarkRadiusFt`, `cityPointFt`, `citySightLine`, `landmarkSightLine` —
  city-plane (feet north/east of the Man) geometry.

**`app/lib/map-geometry.ts`**
- `cityPhi(lotHours, frontsToMan, hours)` — the wedge-space angle of any other
  clock position, so `wedgeFor(...).ptXY` can place a point the city knows the
  address of, however far outside the lot.

**`app/lib/structures.tsx`**
- `uplink` / "Uplink radio": 2×2′ fixed footprint, `shape: "custom"` dish glyph +
  legend icon, `KIND_HEIGHTS.uplink = 12` (the antenna height,
  meant to be edited), one `aim` toggle control ("Show aim path").
- `wifi-ap` / "Wi-Fi access point" — **generic, not Burning-Man-specific**: the
  local end of camp networking wherever the internet comes from. Omnidirectional,
  so what it contributes to the map is COVERAGE: a `rangeFt` control (25–400)
  draws a dashed reach ring, and overlapping rings are how you spot dead spots.
  `KIND_HEIGHTS["wifi-ap"] = 10` — up on a shade frame beats down in a tent, for
  the same line-of-sight reason.
- **Both live in a "Network" legend group** (Cameron's call), inserted between
  Water and Services in `KIND_GROUPS`'s heading order — it's where a future
  switch / router / cable-run kind belongs.
- **Default range is 100′** (Cameron's call), not a spec-sheet line-of-sight
  figure: on playa the signal fights dust, bodies and RV/container walls, and a
  ring that fits inside the lot is the one that actually shows dead spots. A
  150′ ring on a 100×200 lot just says "covered" and teaches you nothing.

**`app/routes/dashboard/map.tsx`**
- A `uplink` memo in `Editor` computing the target's pixel position, each radio's
  aim, and its blockers; a shapes layer under the objects (cone + beam + blocker
  outlines) and a labels layer over them; a "Uplink aim (NOC)" checkbox in the
  Highlight panel (default ON, draws nothing until a radio exists); a NOC ray on
  the compass dial.

**No migration.** `map_object.kind` is free text and `config` is an existing JSON
blob, so a new kind + its toggle need no schema change.

## Key insight — the wedge mapping does the hard work

`wedgeFor(...).ptXY(radiusFt, phi)` maps city polar coordinates to view pixels as
a **rotation about the Man plus a uniform scale**. That means:
- the NOC is just another point in the same SVG (a few thousand feet off-screen,
  trimmed by `ground-clip`), and a straight line in the city stays straight here;
- the tangent lines to the 100′ target circle are the real tangent lines;
- unit vectors and distance ratios are valid in plot-local **feet** too, since the
  object grid differs from the view only by `ppf`. No second coordinate system.

**Sign of `cityPhi`:** the map is drawn un-mirrored, and `wedgeFor` puts the Man
ABOVE a Man-facing lot, so from that lot a *later* clock is to the LEFT (negative
phi); a mountain-facing lot flips it. Verified numerically against the
independent `bearingToPlotDelta` + `mapUpBearingFor` path (which the compass and
shadows use) — the two agree to **0.002° and 0.3 ft** in both orientations.

## Findings / gotchas

- **`Landmark` positions are stored by street code, not radius.** The NOC's
  radius re-derives from `radiusForStreet(year, "esplanade")`, so if a year's
  measurements move Esplanade the landmark follows automatically.
- **The obstruction test is height-aware, and that matters.** The sight line
  *climbs* from the antenna (mast height) to the tower's 40′ sector antennas, so
  a low structure well down the path clears even if it out-tops the mast at its
  own base. Concretely: a 12′ mast clears a 9.5′ container in its path; drop the
  mast to 6′ and the same container blocks it.
- **Mounting on a structure needs no special case.** A radio parked on an RV's
  roof sits inside the RV's footprint, so the nearest in-path distance is ~0 and
  the test reduces to "is the mast above the RV" — which is the right answer.
  Only corners *in front of* the radio are considered, so behind-corners can't
  wrap the angular interval past ±π.
- **The cone really is a sliver near the radio.** ~1.2° at 4,900 ft means it
  spreads about 4 ft across a 200′ lot; it only reads as a visible wedge out
  toward the edge of the map. That's the geometry — don't widen it to look nicer.
- **Uplink labels must draw ABOVE the objects.** The aim path crosses the camp by
  definition, so a label in the under-objects layer ends up hidden behind exactly
  the structure it's warning about. Shapes stay under, labels go over, with a
  ground-coloured halo (`paintOrder="stroke"`).
- **`bun:sqlite` has `PRAGMA foreign_keys` OFF by default.** Deleting a membership
  directly did NOT fire `map_snapshot`'s `ON DELETE SET NULL`, leaving 26 dangling
  rows. Any hand-cleanup of the dev DB should `PRAGMA foreign_keys = ON` first and
  finish with `PRAGMA foreign_key_check`.
- **Editing the map auto-creates `map_snapshot` rows.** Driving the editor in a
  test leaves a snapshot trail; clean it up along with the objects.
- **An unfilled SVG shape is only hit-testable on its stroke.** The Wi-Fi AP's
  rings started as `fill="none"`, which made a 2ft marker nearly impossible to
  click or drag on the map — the hole in the middle isn't a target. Any custom
  `renderFootprint` needs at least one faintly-filled shape covering its body.
- **A coverage ring can dwarf the lot.** 150′ around an AP is bigger than a
  100×200 lot, so the ring label (drawn at the ring's apex) parked ~1,000px above
  the map. Ring labels are now clamped into the view.

### Two pre-existing bugs this shook out (fixed here)

Both live in the shared SidePanel `controls` renderer, so they affected every
slider control — RV pop-outs, door offset, fire-pit clearance, battery safety
zone — not just the new kinds:

1. **Keyboard slider changes silently reverted.** Mantine fires `onChangeEnd` on
   pointer-up but *not* on the arrow keys, and only `onChangeEnd` committed. The
   value looked applied (optimistic local patch) and was gone on next load. Fixed
   with an `onKeyUp` commit.
2. **Arrowing a slider also walked the selected structure across the lot.** The
   map's global arrow-key nudge handler bailed on `INPUT`/`TEXTAREA`/
   `contentEditable`, but Mantine builds sliders, selects and segmented controls
   from focusable DIVs with an ARIA role — so the guard missed them. Four
   ArrowRights on a range slider moved the structure 4 ft. Fixed by also bailing
   on `[role=slider|combobox|listbox|radiogroup]`. The E2E carries a regression
   guard asserting nothing moves.

## Verification

`e2e/noc-uplink.ts` — drives the real editor (a genuine HTML5 drag carrying the
app's own `application/camptool-kind` payload) against Math Camp's real lot, then
reads back what the map draws. 14/14 pass, stable across repeated runs:

- the camp vector labels `NOC 4,872′ · 291°` (matches the hand-computed value);
- the compass dial carries a NOC ray;
- "Uplink radio" appears in the legend palette;
- a 12′ mast down-beam of the 9.5′ container → `Clear · 12′ mast`;
- lowering it to 6′ → `Blocked by Container`, container outlined orange;
- raising it to 14′ → clear again;
- unchecking "Uplink aim (NOC)" removes every uplink annotation;
- a Wi-Fi AP draws a `100′ Wi-Fi` ring and gets no aim path of its own;
- arrowing its range slider moves the ring to 200′, does NOT move the structure,
  and the new value survives a reload.

Screenshots in `data/verify/noc-*.png`, `data/verify/wifi-*.png`.

**Two test gotchas worth keeping:**
- Convert plot feet → client pixels through `svg.getScreenCTM()`, not a viewBox
  ratio. (The app's own `svgPoint` uses the ratio and is fine — the SVG's box and
  viewBox aspect match in practice — but the CTM is what a test should lean on.)
- **Legend chips are icon-only**; the kind's label lives in a hover tooltip. A
  `text=Uplink radio` locator passes for the wrong reason — it matches the side
  panel's Kind select. Hover the `[draggable="true"]` chips and read
  `[role="tooltip"]` instead.

## 2026-08-18 — what the obstruction test actually models

Three corrections from Cameron, all landed:

1. **The radios have no facing.** A Wi-Fi AP is omnidirectional and the uplink's
   dish heading is *computed*, never stored — so a rotation control on either is
   a knob that changes nothing (or worse, disagrees with the aim path drawn
   through it). New `Kind.fixedRotation` flag on `uplink` + `wifi-ap`: no rotate
   handle, and the R/Space keys skip them (in a group rotate they still travel to
   their new position, they just don't spin).
2. **A tapering solid has to be compared level by level.** The Sierpinski pyramid
   is a *solid tetrahedron projecting vertically* — 40′ across at the ground, a
   point at 32.7′ — so extruding its ground triangle to 32.7′ blocks paths that
   in reality pass over the sloping face. New optional
   `CampStructure.crossSectionAt(z, …)` returns the horizontal slice at height
   `z`; the pyramid's is its base triangle scaled about the base **centroid** by
   `1 − z/height`. `crossSectionOutline` / `crossSectionLevels` (in
   `app/lib/map-shapes.tsx`) wrap that: a prism has one rung (its top, = the old
   test), a taper gets 16. The core `dome` taper (a half-ellipsoid,
   `√(1 − (z/tall)²)`) came free with the same machinery.
3. **Shade doesn't obscure the radio.** `canopyShade` kinds (Shade, Carport,
   Pop-up, the hypar shade) are skipped outright — cloth on legs stops sun, not
   a 5GHz link. The pyramid is NOT one of these: it's a solid, and its flying
   buttress (which *is* cloth) is deliberately left out of `crossSectionAt`.

**Where the test lives now.** It moved out of the map route into
`app/lib/uplink-los.ts` (`blocksSightLine`, `sightHeightAt`) so it can be
unit-tested without a browser: `app/lib/uplink-los.test.ts`, 16 cases including
the 6′/12′ container regression from above, shade passing the link through, and
the pyramid pair — **a 12′ mast now sees over the pyramid's sloping edge where a
6′ mast is still blocked**, and dead-centre the pyramid still blocks either way.
Testing the pyramid means mocking `~/theme` (the camp theme is a Vite build-time
alias, so `bun test` otherwise sees the empty default theme).

**The camp-wide vector starts at the camp's edge**, not its middle — the point
where a ray from the lot centre leaves the border, which is a corner when the
bearing points at one (`lotExitPoint` in `app/lib/map-geometry.ts`, convex
half-plane walk, unit-tested against the wedge's slanted sides). Drawing it from
the centre put a dashed line straight through everyone's stuff to say something
about a tower 4,900′ away. Starting 50–100′ out costs about a degree, and the
distance it's labelled with is recomputed from where the line actually begins.

**It's also a stand-in now, not a fixture.** It read as a second,
redundant dashed line once a radio was placed — over ~4,900′ a radio anywhere in
the lot aims within a degree or so of the lot centre, so the two lines lie on top
of each other and invite the question "whose radio is *that*?". It's drawn only
while `aims` is empty (no radio, or every radio's "Show aim path" off). The
`NOC 4,872′ · 291°` readout follows whichever path is drawn — the camp vector, or
otherwise the first radio's own beam — so no information is lost either way, and
the compass ray is untouched.

**One refinement while in there:** the height comparison now uses where the beam
*centre line crosses* the slice, not the slice's nearest corner. A corner well
off to the side is closer than the crossing, which reads the climbing sight line
lower than it is at the place that matters and over-reports blockage. The corner
remains the fallback for a slice the centre line misses but the beam's width
still clips.

## Possible follow-ups (not built)

- **Neighbours aren't modelled.** Only your own lot's structures are tested; the
  camp across the street is the most likely real blocker. Would need neighbour
  height data we don't have.
- **Browser check of the pyramid case.** The level-by-level test is covered by
  unit tests; nobody has yet watched the pyramid's blocker outline appear and
  disappear in the real editor as the mast height changes. Worth a case in
  `e2e/noc-uplink.ts` (drag the pyramid, drop a radio beside its edge, sweep the
  height slider).
- **Other tapers are still boxes.** Tipis, bell tents and the hypar roof all
  narrow with height; they'd each just need a `crossSectionAt`. Only the pyramid
  and the dome taper today.
- Warn when the mast is tall enough to sway (BMorg's own caution).
- A second landmark or two (Temple, airport) would now cost almost nothing — the
  `Landmark` machinery is generic.

## Things not to do

- **Don't move the NOC.** It's at 6:15 & Esplanade; that's settled.
- Don't bake the NOC into core structures — it's event-layer data.
- Don't widen the aim cone to make it look better on screen.
