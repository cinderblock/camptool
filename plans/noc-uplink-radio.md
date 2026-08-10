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

## Research findings — where the NOC actually is

**The NOC tower is in Center Camp, next to the Café.** Burning Man IT's own
participant guide (`internet.burningman.org`) says, verbatim:

> "Aim the radio visually toward the tallest tower in Center Camp, near the Cafe.
> The sector antennas are mounted at about 40 ft (2/3 up the 60 ft tower)."

BMorg does **not** publish a clock/radius address or GPS fix for the tower, so
the only anchors are the Café and the Center Camp portal. From the **2025 BRC
Measurements** doc (`bm-innovate.s3.amazonaws.com/2025/2025 BRC Measurements.doc.pdf`):

> "Man to the center of The Canopy = 2,999′"
>
> "There are five plaza portals to the Esplanade: at 6:00 (Center Camp), 3:00,
> 4:30, 7:30, and 9:00."

**Locked by the user:** model the target as a **100′-diameter circle centred at
6:15 & Esplanade** — an area big enough to contain the tower wherever in Center
Camp it actually stands, rather than a false-precision point. That's what
`NOC_LANDMARK` encodes, and the aim cone is exactly the cone that covers that
circle.

**Precision is adequate for the purpose.** From Math Camp's lot (E @ 3:14) the
NOC is ~4,900 ft away, so the 100′ target subtends **~1.2°** — narrower than a
NanoBeam AC's beamwidth. The value here is "which side of camp does the link
leave from, and what's in the way", not survey-grade aiming; the fine alignment
is done on the radio itself (the guide points people at `https://172.16.0.1` →
Tools → Alignment).

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
- `Landmark` type + `NOC_LANDMARK` (6:15, esplanade radius, 100′ diameter, 40′
  antenna height, and a `note` that keeps the estimate's provenance visible).
- `landmarkRadiusFt`, `cityPointFt`, `citySightLine`, `landmarkSightLine` —
  city-plane (feet north/east of the Man) geometry.

**`app/lib/map-geometry.ts`**
- `cityPhi(lotHours, frontsToMan, hours)` — the wedge-space angle of any other
  clock position, so `wedgeFor(...).ptXY` can place a point the city knows the
  address of, however far outside the lot.

**`app/lib/structures.tsx`**
- `uplink` / "Uplink radio": 2×2′ fixed footprint, `shape: "custom"` dish glyph +
  legend icon, Services group, `KIND_HEIGHTS.uplink = 12` (the antenna height,
  meant to be edited), one `aim` toggle control ("Show aim path").

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

## Verification

`e2e/noc-uplink.ts` — drives the real editor (a genuine HTML5 drag carrying the
app's own `application/camptool-kind` payload) against Math Camp's real lot, then
reads back what the map draws. 7/7 pass, stable across repeated runs:

- the camp vector labels `NOC 4,872′ · 291°` (matches the hand-computed value);
- the compass dial carries a NOC ray;
- "Uplink radio" appears in the legend palette;
- a 12′ mast down-beam of the 9.5′ container → `Clear · 12′ mast`;
- lowering it to 6′ → `Blocked by Container`, container outlined orange;
- raising it to 14′ → clear again;
- unchecking "Uplink aim (NOC)" removes every uplink annotation.

Screenshots in `data/verify/noc-*.png`.

**Test gotcha:** the E2E must convert plot feet → client pixels through
`svg.getScreenCTM()`, not a viewBox ratio. (The app's own `svgPoint` uses the
ratio and is fine — the SVG's box and viewBox aspect match in practice — but the
CTM is the robust thing for a test to lean on.)

## Possible follow-ups (not built)

- **Neighbours aren't modelled.** Only your own lot's structures are tested; the
  camp across the street is the most likely real blocker. Would need neighbour
  height data we don't have.
- Officer-editable landmark override, if BMorg moves the tower (the guide's own
  history notes the link moved from a 40′ tower at the Box Office to the NOC).
- Warn when the mast is tall enough to sway (BMorg's own caution).
- A second landmark or two (Temple, airport) would now cost almost nothing — the
  `Landmark` machinery is generic.

## Things not to do

- Don't fabricate a clock/radius "address" for the NOC as if BMorg published one.
  They didn't; the 100′ target circle is the honest model and its provenance
  should stay visible in `NOC_LANDMARK.note`.
- Don't bake the NOC into core structures — it's event-layer data.
- Don't widen the aim cone to make it look better on screen.
