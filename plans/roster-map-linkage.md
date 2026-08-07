# Roster ↔ map linkage — "where is this person camped?"

> Task plan. Parent living plan: `plans/camptool.md`. Sibling:
> `plans/whos-coming-attendees.md` (the roster itself).

## Goal (user ask, 2026-08-07)

From `/roster` you can see *who* is coming and *when* they arrive, but not
*where* they are camped. Close that gap in two steps: a per-row link into the
map, then an embedded mini-map that highlights a person's structures in place.

## Decisions already made (don't re-ask)

- **Ship both, in order (user, 2026-08-07):** the per-row map link first as its
  own commit, then the embedded mini-map as a follow-up. The link is a
  prerequisite either way — both need "which map objects belong to this
  attendee".
- **Highlight the whole party (user, 2026-08-07):** a row lights up the member's
  own structures *plus* anything their guests occupy. Matches how the roster
  already groups people and answers "where is this household camped?".
- **Selection, not hover.** Hover must never be the only channel — the user is
  frequently on iOS, where a hover-only highlight simply does not exist. The
  interaction is: tap/click a row to select (tap again to clear), with hover as
  a progressive enhancement on pointer devices. Same rule that bans `title=`
  tooltips in this repo.

## Environment / findings from recon (2026-08-07)

- `/map` is **one 10,093-line file**, `app/routes/dashboard/map.tsx`, rendering
  **SVG**. There is no `<CampMapView>` component — the `<svg>`, lot, zoom/pan
  frame, gestures, zones/cables/roads all live inline in `Editor`
  (`map.tsx:4367`, ~3,200 lines, ~50 props). Only `MapObjectShape`
  (`map.tsx:8197`) is cleanly separable and pure: pass
  `editable/resizable/rotateArmed = false` and no-op handlers for a read-only
  draw. **This is what makes Phase 2 expensive, and why Phase 1 goes first.**
- **A person attaches to a map object two different ways.** Owner is
  `mapObject.ownerMembershipId` → `membership.id` (`db/schema/map.ts:87`, NULL =
  camp/shared). Occupants are `mapObjectOccupant.attendeeId` → `attendee.id`
  (`db/schema/map.ts:154-180`). So "this party's objects" is a union across two
  different key types, and guests can only ever appear via the occupant side.
  `RosterGuest.id` already **is** the `attendee.id`, so the roster has the right
  key in hand.
- Only `mapObject.placed` objects render (`db/schema/map.ts:93`); unplaced ones
  are the officer queue.
- **No URL param, hash, or `useSearchParams` exists in `map.tsx` at all** —
  nothing anywhere links to `/map` with any parameter. The deep link is new
  surface.
- There IS an existing dim-everything-else mechanism to build on: `highlight`
  state (`map.tsx:3544`, values `none|mine|domicile|vehicle|structure`), matched
  at `map.tsx:4635` and applied as `dim={...}` per shape (`map.tsx:6974`).
- Programmatic selection is already supported (`setSelectedId` +
  `setSelectedIds` on create, `map.tsx:3675`), but **there is no pan-to/center-on
  helper** — that has to be built. Reusable pieces: the selection centroid
  (`map.tsx:5270-5292`) and the `pendingScroll` write (`map.tsx:4467`).
- **The map loader does not load occupants at all** (`objSelect`,
  `map.tsx:693`, only joins `ownerName`). So "who sleeps where" is currently
  invisible on the map. Resolve the party server-side from the query param
  rather than loading occupants for every map render.
- The roster loader has nothing map-related today
  (`roster.tsx:52-72`, `attendee.server.ts` imports no map schema).

## Design (Phase 1)

- URL is `/map?party=<membershipId>` — human-meaningful, stable, shareable in
  Discord. NOT a list of object ids: those go stale and make an unreadable URL.
- The map loader resolves `party` server-side into a set of object ids (owner
  membership match ∪ occupant-attendee match over the member + their guests),
  only when the param is present — so the common map load pays nothing.
- The map shows an explicit "showing X's party / clear" affordance, so a dimmed
  map is never unexplained.
- The roster only renders the link for a party that actually has placed objects,
  so there are no dead links.

## Design (Phase 2) — the shared read-only view

User chose (2026-08-07) to **extract a shared view** rather than write a second
simplified renderer, so the mini-map can never drift from the real map.

**What gets shared is everything that decides how the map LOOKS; what stays in
`Editor` is everything that decides how it BEHAVES.** The mini-map has no
gestures, no zoom frame, no selection handles — copying that machinery in would
be the risky, low-value half. So:

- Shared: the geometry (`VIEW_W`/`MARGIN`/`PAD_FT`, the pixels-per-foot and
  origin math derived from the lot), the lot outline, and `MapObjectShape` —
  which is what actually determines that a shade structure looks like a shade
  structure. A new structure kind then looks right in both places for free.
- Not shared: the `<svg>` wrapper's interaction layers, zoom/pan frame, drag
  gestures, keyboard handling, zones/cables/roads/wind/shadow overlays. `Editor`
  keeps those and composes the shared pieces inside its own `<svg>`.

Done in behaviour-preserving stages, verifying the real map in a browser after
each — this is the feature the user touches most, so a silent regression here is
worse than not having a mini-map.

## Open questions for the user

*(none right now)*

## Progress log

- [x] Design fork settled with the user (scope + what lights up + no hover-only).
- [x] Recon — see Environment above.
- [x] **Phase 1 — per-row map link. DONE + browser-verified, 2026-08-07.**
  - `app/lib/party-map.server.ts` — `partyMapObjects(editionId)` returns every
    party's placed objects keyed by host membership, unioning the owner and
    occupant sides and rolling a guest's occupancy up to their host. Uses Sets,
    so someone who both owns a tent and is listed as its occupant counts once.
    One code path shared by both surfaces so they can't disagree.
  - Roster: a **Where** column — `N on map` linking to `/map?party=<id>`, or
    "not placed". Whole column hidden when the camp's `map` feature isn't
    visible to the viewer (`getFeatureState` + `featureVisibleTo`).
  - Map: loader resolves `?party=` via `resolveParty` (camp-scoped — a foreign
    or malformed id yields a normal map, not an error, and can't probe another
    camp's memberships). Adds a `party` highlight mode reusing the existing
    `highlight`/`dim` mechanism, a **Party** segment in the Highlight control,
    and an Alert naming whose party is shown with "Show everyone" + "Back to
    Who's coming".
  - **No pan-to was built, deliberately:** zoom 1 already fits the whole lot in
    the frame, so at the default view the highlight alone locates people and a
    scroll helper would be dead code. Revisit only if the map gains a default
    zoomed-in state.
  - Verified in-browser on a seeded copy of the live DB, with the counts chosen
    to catch the ways this can go wrong: Ada **3** (own tent + own shade + her
    guest's tent, which she does not own), Grace **1** (owner *and* occupant —
    deduped, not 2), Alan **1** (occupant of a tent nobody owns), Emmy **not
    placed** (her only object is unplaced). Then: the deep link dims everything
    else and preselects Party; "Show everyone" clears it; an empty party says
    "isn't on the map yet" instead of showing an unexplained all-dimmed map; a
    bogus id renders a normal map with no Party segment; and turning the map
    feature off removes the column entirely.
  - typecheck + build green; lint/tests clean for these files (the repo also had
    failures from a peer thread's unregistered `swaps.*` route at the time).
- [ ] Phase 2 — embedded mini-map with row selection.
  - [x] **Stage 1 — extract the object renderer. DONE, proven equivalent.**
        `app/lib/map-shapes.tsx` now owns `ObjRow`/`PendingPrev`, the door
        components, `KindGlyph`, `footprintOutline`, `MapObjectShape`, and a new
        `MapShapeDefs`; `app/lib/num.ts` owns `clamp`/`round`. `map.tsx` drops
        ~1,150 lines (10,192 → 9,046) and imports them back.
        **`MapShapeDefs` exists because of a trap the recon caught:**
        `MapObjectShape` fills hypar and hexayurt roofs with
        `url(#hypar-roof)`/`url(#hexayurt-roof)`, whose gradients lived in
        `Editor`'s `<defs>`. A mini-map that just rendered the shape would have
        shown those roofs flat, with no error. The defs now travel with the
        component that references them, and the module header says so.
        **Equivalence proof:** ran the pre-refactor code (HEAD, in a throwaway
        worktree on :17924) and the refactored code (:17923) against the SAME
        seeded database, fetched the SSR'd `/map` from both, and diffed the
        `#camp-map-svg` subtree — **byte-identical, 54,698 chars each**, on a
        map seeded with one of every drawable kind (hexayurt, hyparhut, RV,
        container, dome, shade, vehicles, tents) so doors, glyphs, hexagons and
        both gradient roofs were all exercised. Compared server-rendered rather
        than screenshots because the sun position (hence shadows) moves between
        two page loads and would swamp a pixel diff.
  - [x] **Stage 2 — extract the coordinate system. DONE, proven equivalent.**
        `app/lib/map-geometry.ts` owns `VIEW_W`/`MARGIN`/`PAD_FT`,
        `frontageRadiusOf`/`rearWidthOf`/`lotHalfWidthAt`, `layoutFor(lot)` (the
        pixels-per-foot and origin math) and `wedgeFor(lot, layout)`.
        `wedgeFor` returns the lot outline **and** the polar helpers
        (`ptXY`/`sector`), so the editor draws the street, service road and
        neighbour lots from the SAME wedge as the lot edges — no duplicated
        trigonometry, and the mini-map's lot can't drift from the real one.
        `straightLotPoints` is the no-radius fallback.
        **Equivalence proof:** same side-by-side harness against Stage 1
        (`a0b9c3b`), across all four lot geometries, all byte-identical:
        curved wedge from a derived street radius (54,698 chars), the
        straight-trapezoid fallback with no radius (34,975), a mountain-facing
        lot where the wedge direction flips (47,197), and a wide lot with an
        explicit `innerRadiusFt` override (52,234).
  - [ ] Stage 3 — `CampMapView` + the roster mini-map with row selection.

## Things not to do

- Don't make hover the only way to reveal the highlight (see Decisions).
- Don't add a `title=` attribute to the link or any map object.
