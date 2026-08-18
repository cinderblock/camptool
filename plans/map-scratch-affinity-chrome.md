# Map: staging apron, "wants to be near" lines, and collapsible chrome

> Living plan. Plan path: `plans/map-scratch-affinity-chrome.md`
> Parent plan: `plans/camptool.md` (Phase 3 — camp map editor)
> Siblings: `plans/noc-uplink-radio.md`, `plans/mobile-support.md`,
> `plans/roster-map-linkage.md`, `plans/grouping-multiselect.md`

## Goal

Three independent asks from Cameron (2026-08-18), all on the map editor:

1. **Scratch space.** Let things be parked *outside* the lot border so their real
   size is visible next to the lot before they're sited. An object is either
   fully inside or fully outside — never straddling the border.
2. **Affinity lines.** A faint line between things a camper wants to be near
   (their vehicle, a friend), so whoever arranges the map can see the wishes.
3. **Collapsible chrome.** A skinny (not phone-narrow) browser window loses the
   map to the 220px nav + 320px side rail. Both need to be hideable at any width.

A fourth ask — "how do I add the NOC uplink to my trailer, it's on a deployable
mast?" — was a usage question, answered in-thread. Nothing to build; see
`plans/noc-uplink-radio.md`. The answer: drag **Uplink radio** (Network group in
the legend) onto the trailer, set **Height (ft)** to the *deployed* mast height
above ground, and 🔗 Link-as-block the radio to the trailer so it travels with it.
Two known model gaps to eyeball by hand: neighbours aren't modelled, and mast
sway isn't either.

## Environment / context

- Stack: Bun · React Router v7 (SSR) · React 19 · Mantine · Drizzle · Biome, TS strict.
- The editor is one big route: `app/routes/dashboard/map.tsx` (~9.3k lines).
  Geometry helpers are pure and shared with the read-only roster mini-map in
  `app/lib/map-geometry.ts` — changing them changes both.
- Coordinates: **plot-local feet**, origin at the lot's front-left corner, +y into
  the lot. See the header of `db/schema/map.ts`.
- The lot is a **trapezoid** in object space (`lotHalfWidthAt` interpolates
  frontage half-width → rear half-width), even though it's drawn as a true
  circular wedge. All hit/fit math uses the trapezoid; keep it that way.
- `PAD_FT = 50` already reserves an annotation apron on every side of the lot,
  used today by zones/cables and by the drawn surroundings (≈45′ street in front,
  ≈20′ rear service road, neighbour strips left/right).
- Dev port for this project is **17923** (never 3000/5173).

## Decisions already made (don't re-ask)

Cameron chose all three recommendations on 2026-08-18:

1. **Scratch = the apron all around the lot, auto-growing.** Objects may be
   dropped anywhere in the annotation margin on any side. The margin expands when
   things are parked out there. Not a single dedicated staging band — you want to
   park a thing next to *where it will go*.
2. **Affinity = existing prefs + a new "near this person" picker.** Lines derive
   from the existing `placeNearVehicle` flag (domicile → owner's vehicle) *and* a
   new per-item member picker on `/bringing`. A camper cannot express "near my
   friend" today at all, so this needs the schema addition.
3. **A staged item is still "not placed".** It keeps `placed = false`, so it stays
   on the officer's to-site queue and on the camper's Bringing page — it just
   gains a "staged" badge and real coordinates so it renders at true scale.
   Nothing silently falls off the queue.

Standing project decisions that bear on this: multi-camp schema (`camp_id`
everywhere), no `title=` tooltip attributes anywhere, ISO dates.

## Design

### 1. Staging apron

**Schema.** `map_object.staged` (boolean, default false). `placed=false,
staged=true` = parked in the apron with meaningful x/y. Loader selects
`placed OR staged` into the map's object list; the Unplaced tray keeps its
`placed = false` filter (so staged items appear in both, badged).

**Snap in-or-out.** Replace the single `fitCenterInsideLot` call path with a
decision:

- Object centre inside the lot → `fitCenterInsideLot` (today's behaviour).
- Centre outside → `fitCenterOutsideLot`: pick the lot edge that needs the
  smallest push, and translate the whole rotated footprint along that edge's
  **outward normal** until no vertex is on the inner side.

The lot is convex, so "every vertex on the outer side of one lot edge" is a
sound (sufficient) fully-outside test, and it generalises over the trapezoid's
two slanted sides without special cases. The four edges and their outward
normals, in plot-local feet (`mid = frontage/2`, `rear` = rear width):

| edge  | through                          | outward normal |
| ----- | -------------------------------- | -------------- |
| front | (0,0) → (frontage,0)             | (0,−1)         |
| rear  | (mid−rear/2,depth) → (mid+rear/2,depth) | (0,+1)  |
| left  | (0,0) → (mid−rear/2, depth)      | (−dy, dx) norm |
| right | (frontage,0) → (mid+rear/2,depth)| (dy, −dx) norm |

**Auto-grow.** `layoutFor(lot, padFt = PAD_FT)` gains an optional pad. The editor
computes the pad needed to contain the staged objects, quantised up to a 25′ step
so it doesn't creep, and **freezes it during a drag** — a mid-drag rescale would
both look awful and corrupt the pointer→feet math, which is derived from `ppf`.
The roster mini-map calls `layoutFor(lot)` and is unaffected.

**Visuals.** Staged objects render at true scale with a dashed outline and reduced
fill so they read as "not sited yet". `objectOverflowsLot` keeps flagging genuine
straddlers (legacy data can still be one; dragging can no longer create one).

### 2. Affinity lines

**Schema.** `map_object.near_membership_id` → `membership.id`, `on delete set null`.
"Put this next to <member>'s stuff." Nullable; null = no preference.

**Rendering.** A faint dashed line, object centre → target centre, under the
objects layer, behind a new "Wants to be near" checkbox in the Highlight panel:

- `placeNearVehicle` → line to the owner's own vehicle-kind object.
- `nearMembershipId` → line to that member's domicile (their vehicle if they have
  no domicile placed).
- Only drawn when **both** ends are on the map; a wish pointing at something
  nobody has placed yet is a dangling line, not information.

**Input.** `/bringing`, next to the existing "Place next to my vehicle" checkbox
on Domicile-group items: a member Select, "…and near this person".

### 3. Collapsible chrome

- `app/routes/dashboard/layout.tsx`: a second `Burger visibleFrom="sm"` so the
  navbar can be folded at any width, with the choice persisted in `localStorage`.
  The *movement* is an inline `transform` on `AppShell.Navbar` plus an inline
  `padding-inline-start` on `AppShell.Main`, NOT AppShell's `collapsed` prop —
  see the finding below; the prop is kept only for the first render. One
  `navHidden` boolean covers both burgers, which fixes the mobile one too.
- `app/routes/dashboard/map.tsx`: the 320px side rail gains a "Hide panels"
  toggle that works at any width (not only under the existing 768px `isNarrow`
  branch), also persisted. With the rail folded on a phone the map pane takes
  82vh instead of 70vh, since there's nothing below it to scroll to.

## Plan / steps

1. [x] Schema: `map_object.staged`, `map_object.near_membership_id` + migration
   `0075_fancy_talos.sql`.
2. [x] Geometry: `fitCenterOutsideLot` / `fitCenterToLot` / `polygonOutsideLot`,
   `layoutFor` pad arg, all in `app/lib/map-geometry.ts` with unit tests.
3. [x] Map editor: staging drag/drop/render, loader + actions.
4. [x] Affinity: loader data, lines layer, Highlight toggle, `/bringing` picker.
5. [x] Chrome: navbar collapse at any width, map rail collapse, both persisted.
6. [x] `typecheck` / `build` / `lint` / `bun test` green.
7. [x] Browser-verified the staged rendering, the wish lines and both collapses.
8. [ ] E2E script covering a real drag into the apron (not yet written).

## Findings / gotchas

- **Mantine AppShell's `collapsed` prop does not work under React 19.** Mantine
  renders the shell's sizing as a `<style dangerouslySetInnerHTML>` block
  recomputed from the `navbar` prop each render; React 19 treats `<style>` as a
  hoistable resource and will not update an inserted one's contents. The block is
  therefore frozen at the first render's value. Flipping `collapsed` re-renders
  everything else — the burger's own icon and label included — while the navbar
  never moves. Verified directly: set the stored preference and RELOAD and the
  navbar collapses correctly; toggle it live and the style block still carries
  the old transform. **This also means the pre-existing mobile burger never
  worked** — it was the same mechanism. Both are now driven by inline `style` on
  `AppShell.Navbar` / `AppShell.Main`, which React does update and which outrank
  any stylesheet rule. `collapsed` is still passed, because it's what makes a
  page LOAD in the right state and what hides the navbar on a phone before JS.
- **A CSS-class workaround for the same problem did NOT work** and was abandoned:
  a class on the AppShell root plus `@media` rules re-declaring
  `--app-shell-navbar-offset`. The rules parsed and the class applied, but the
  navbar didn't move. Inline styles are the reliable lever here; don't retry the
  class approach.
- **Mantine's `useLocalStorage` setter is unsafe with a functional updater.**
  `setValue(v => !v)` gets the hook's INTERNAL state, which is `undefined` until
  the read-from-storage effect has run, so `!undefined` is `true` and the first
  click appears to do nothing. Always pass the explicit next value. This cost
  real time twice — once on the map rail, once on the navbar.
- **`useMediaQuery(query, initialValue, options)` misbehaved with the 3-arg
  form.** `useMediaQuery("(min-width: 48em)", true, {getInitialValueInEffect:
  false})` evaluated falsy on a 3072px viewport. The plain one-arg form used
  elsewhere in the app (`useMediaQuery("(max-width: 47.99em)")`) is correct —
  match that pattern.
- **`membership`'s camp column is `organizationId`, not `campId`** (better-auth's
  org plugin named it; the SQL column is still `camp_id`).
- **Drizzle-kit omits `ON DELETE` actions on `ALTER TABLE ADD COLUMN`.** The
  generated FK for `near_membership_id` had no action; hand-edited to
  `ON DELETE SET NULL` to match the schema. Check this on any future add-column
  migration carrying a reference.
- A concurrent Claude session was editing `map.tsx` and `uplink-los.ts` in this
  same tree throughout. Its HMR reloads repeatedly blanked the page mid-
  verification. Worth checking `git status` for a peer before long browser runs.

## Things not to do

- Don't change `PAD_FT` itself or `layoutFor`'s default — the roster mini-map
  shares them and would silently rescale.
- Don't let the apron grow *during* a drag (pointer math is derived from `ppf`).
- Don't use `title=` attributes for any of the new affordances.
- Don't reach for AppShell's `collapsed` prop for anything dynamic (see above).
- Don't pass a function to a Mantine `useLocalStorage` setter.

## Progress log

- [x] Read the map editor, schema and sibling plans; answered the uplink question.
- [x] Design questions put to Cameron; all three recommendations accepted.
- [x] Implementation of all three features.
- [x] `bun test` 263 pass (12 new in `map-geometry.test.ts`, including a
      6,400-point lattice sweep asserting nothing ever lands half in the lot);
      typecheck, build and lint on the touched files all green.
- [x] Browser-verified against a throwaway copy of the dev DB: a staged RV
      renders outside the border at true scale, faded with a dashed outline; the
      apron widened to fit it (viewBox 1321 → 1242); it stayed in the Unplaced
      tray with a "staged" badge; three wish lines drew, including one to the
      staged RV; both the navbar and the map rail collapse and persist.
- [ ] E2E script for a real drag into the apron — the existing `e2e/noc-uplink.ts`
      is the model (Playwright under `node --experimental-strip-types`).
