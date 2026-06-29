# Shared structures + shade/utility systems — living plan

> Plan path: `plans/shared-structures-and-shade-systems.md`
> Big multi-part batch requested 2026-06-28. Delivered as **incremental PRs**
> (user's locked choice). Read this first; keep it current.

## Goal

Add a wave of shared (all-event) map structures and four new map *systems*:
a per-edition "banned kinds" mechanism, water-pipe cable types + in-camp
lanes/roads/walkways, snap-to-structure shades, and a night mode (sun past
sunset, path lights, the pyramid's rainbow top). Most new *kinds* are core
(`app/lib/structures.tsx`), shared by every event; the pyramid effect is in
`@camptool/mathcamp-theme`.

## Locked decisions (from the user, 2026-06-28)

1. **Banned-kinds list is per-EDITION** (stored on `camp_edition`), not per-camp
   and not (yet) a new event entity. Rationale: an edition ≈ a camp's attendance
   at one event-year, so "popups banned at BM 2026 but fine at the small event"
   falls out naturally. When a real event layer lands it can supply defaults.
2. **Incremental PRs**, in the A→E order below. Each lands + deploys on its own.

## Increments

- **A — New shared kinds** (core palette). carport, popup (both `canopyShade`),
  shower, evap pond (black), OSS fresh + grey water tanks (round, 250-gal ≈ 3′
  dia × 5.5′), toy hauler (fold-down rear ramp), Airstream (length presets),
  trash/recycling. New legend groups: **Shade**, **Water**, **Services**.
- **B — Per-edition banned kinds.** `camp_edition.banned_kinds` (JSON array of
  kind `value`s). Officer UI (on /editions or a settings page) to toggle which
  kinds are disallowed this edition. Palette hides banned kinds; the map + bringing
  save-actions 403 a banned kind; existing placed objects of a now-banned kind get
  a flagged badge (don't silently delete). Read-only when the edition is locked.
- **C — Linear utilities.** Extend `map_cable` with a `kind`: power | water-fresh |
  water-grey (color + label per type; the existing amp/gauge fields apply only to
  power). Add in-camp **fire lane / service road / access walkway** — likely a
  `map_zone` subtype or a new linear-path feature; decide width-aware polygon vs.
  centerline+width when starting C.
- **D — Snap-to-structure shades.** While dragging/resizing a shade (carport,
  popup, shade, hypar-shade…), snap its corners/edges to the vertices and edges of
  nearby structures/vehicles. Reuse `footprintLocal` outlines for snap targets;
  add a snap toggle + visual snap guides. Editor-only (no schema).
- **E — Night mode.** Extend the sun sim past sunset: a day/night control; below
  the horizon the map renders a night palette. Add **path-light markers** (a kind
  or zone-edge lights) that glow at night. The Sierpinski pyramid's smallest top
  tetra animates a rainbow at night (`@camptool/mathcamp-theme`). Night lighting is
  a render effect; persisted data = the light markers + the sun/time already modeled.

## Environment / context

- Core kinds: `app/lib/structures.tsx` (`CORE_KINDS`, `KIND_HEIGHTS`,
  `KIND_GROUPS`, `KindIcon`). Map render + per-kind extras + shadow/shade:
  `app/routes/dashboard/map.tsx`. Custom round/odd footprints use
  `shape:"custom"` + `renderFootprint` + `footprint` (the path at map.tsx ~5032,
  same one camp-theme structures use). Vehicle = fixed width, length resize.
- Shade sim: `shadowPolygon` (cast) + `shadedFaces`/`coreShadedFaces` (self-shade)
  + `sunDirLocal`; sun model in `app/lib/sun.ts` (daytime only today → E extends it).
- Migrations apply on app startup (`db/client.server.ts`); `db:migrate` doesn't
  work here. Author with `db:generate`, restart to apply.

## Progress log

- [x] Plan written; two forks locked (per-edition bans, incremental PRs).
- [x] **A — new shared kinds** — LANDED + deployed (commit 8b5c99d, Deploy to
      firefly green 2026-06-28). carport, popup, shower, evap pond, fresh/grey
      water tanks (round), trash/recycling, toy hauler (ramp), Airstream. New
      Shade/Water/Services groups; canopy behavior generalized to any
      `canopyShade` kind. NOT yet browser-verified live (visual check pending).
- [x] **B — per-edition banned kinds** — built (migration 0033 adds
      `camp_edition.banned_kinds`). Officer toggle list on /editions for the active
      year; new editions seed from the event (BM → pop-ups banned, via
      `defaultBannedKinds`). Palette/picker hide banned kinds (map Legend + SidePanel
      Kind select, camper AddStructures on Bringing + wizard); addObject/addBlock +
      bringing addItem 403 a banned kind; already-placed banned objects get an amber
      "!" flag on the map (not deleted). Helpers in `app/lib/bans.ts`. NOT yet
      browser-verified; migration applies on the deploy restart. Existing editions
      keep NULL (nothing banned) until an officer sets the list.
- [x] **C — linear utilities (both parts done).**
  - [x] **C2: in-camp roads** — built (migration 0034 adds `map_road`). Fire lane /
        service road / access walkway, each a centerline polyline + predefined width
        (20/20/6 ft). Rendered as a width band with **45° corner cutbacks** baked into
        the outline: at ~90° turns the band is chamfered with legs of `cutback` feet
        on each edge (default 20 ft = BM's turn allowance), via `app/lib/roads.ts`
        `roadOutline` (verified: exact 20-ft legs both edges). New "+ Draw road" menu
        (per kind), draft band preview, RoadPanel (type/width/cutback/name/color/notes/
        delete), officer-managed, read-only when locked. Per-vertex drag editing
        DEFERRED (redraw to fix). NOT browser-verified yet.
  - [x] **C1: water-pipe cable types** — `map_cable.kind` (migration 0035):
        power / fresh water / grey water. "+ Draw line/pipe" menu picks the kind;
        CablePanel has a Type select (reseeds color; amps/gauge shown only for
        power). NOT browser-verified.
- [x] **D — snap-to-structure shades** — editor-only (no schema). Dragging a
      `canopyShade` object snaps its footprint corners onto nearby objects'
      vertices/edges within 4 ft (corner→vertex and corner→edge; closest wins), with
      a green ring marking the live snap target and a "Snap shades" toolbar toggle.
      Helpers `objWorldCorners`/`nearestOnSeg`/`snapToStructures` in map.tsx. NOT
      browser-verified.
- [ ] E — night mode + path lights + pyramid rainbow.

## Findings / gotchas

- 250-gal vertical poly water tanks run ~30–36″ dia × 62–89″ tall depending on
  model; using **36″ (3′) dia × 5.5′ tall** as a clean representative.
- `shape:"custom"` core kinds render via `def.renderFootprint` (map.tsx ~5032) and
  need a `renderIcon` too (KindIcon only branches on rect/hexagon/hypar/dome).
- Moving the existing `shade` kind into the new **Shade** group is a legend-only
  change (groups are derived from each kind's `group`).
