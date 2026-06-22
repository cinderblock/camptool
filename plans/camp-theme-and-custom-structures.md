# Camp-theme package seam + custom structure registry (Phase 2.5 + custom structures)

> Living plan. Read first. Keep current. Parent plan: `plans/camptool.md`.
> Triggered by: "add a custom structure to our camp — a 3D Sierpinski Pyramid"
> (Math Camp only). User chose the **Full Phase 2.5 camp-package** path (most
> correct long-term), not a quick one-off kind.

## Goal

Build the locked-but-unbuilt **Phase 2.5 camp-theme seam** and the **custom
structure registry** that hangs off it, then register Math Camp's **Sierpinski
pyramid** as the first real custom structure — proving the seam end to end.

Two locked decisions this realizes (from `plans/camptool.md`):
- Phase 2.5: per-camp UI customization is **build-time, per-deployment** — a
  self-hoster adds a `camp-theme` workspace package and points `CAMP_THEME` at
  it (default → built-in `@camptool/default-theme`). Core imports through a
  single `~/theme` alias resolving to the active package. Contract:
  `{ mantineTheme, slots, routes?, rootProvider? }` (+ now `structures`).
- Phase 3 custom-structures: "Custom per-camp structures = camp package, NOT the
  shared app." The camp package contributes extra `kinds` into the palette
  registry the core reads. Needs: move `KINDS` behind a registry the package can
  extend.

## Environment / context

- Single RR7 app today (no workspaces yet). Bun 1.3, React 19, Mantine 7,
  Vite 6, `vite-tsconfig-paths`. `~/*` → `./app/*` (tsconfig + vite plugin).
- Structure palette: `app/lib/structures.tsx` — `KINDS` (`as const` array),
  `KIND_GROUPS`, `CAMPER_KINDS`, `kindDef/kindColor/kindHeight/hasTag`,
  `KindIcon`, `ShapeSwatch`, `hexVertices`. `ShapeKind = rect|hexagon|hypar|dome`.
- Consumers of structures: `app/routes/dashboard/map.tsx` (~2.9k lines; shape
  rendering is a hardcoded if/else on `def.shape` around L3304–3458; shadow sim
  L1166–1250; legend via `KIND_GROUPS`; unplaced tray), `app/components/
  AddStructures.tsx` (`CAMPER_KINDS`).
- Map coord model: plot-local **feet**, origin front-left, +x along frontage,
  +y into lot. Objects draw inside a transformed `<g>` in a 0,0→w,h feet box.
  `map_object` carries name/kind/x/y/width/height/rotation/tallFt/color/notes.

## The structure (geometry — how 3D Sierpinski tetra → honest 2D)

Regular **Sierpinski tetrahedron, 3 levels**: small 10′ edge → medium 20′ (4
smalls) → large 40′ (4 mediums). Rests on a **face**: 3 medium tetras on the
ground in a triangle, 4th medium elevated in the center pocket.

Honest top-down footprint (= its shadow): a **Sierpinski triangle**, equilateral
**40′ per edge** (bbox ≈ 40′ × 34.64′; tri height = 40·√3/2).
- 3 corner sub-triangles (20′ each) = the 3 base medium tetras → labels:
  **"Group W Bar"** (one) + **"lecture hall"** ×2.
- Center = open shaded ground; the 4th (top) medium tetra hovers above and
  projects onto the middle → central gathering space under shade.
- Tall: regular 40′-edge tetra ≈ **32.66′** (= edge·√(2/3)), apex over centroid.
  Feed `tallFt ≈ 32.7` to the solar/shade sim — the tall apex throws the long
  shadow the user cares about.
- **Pi stick:** 8′ pole + Pi glyph on the apex → ~40.7′ point. Capture as a
  center marker / optional apex glyph. Nice-to-have, not critical.
- Flying-buttress shades on the lower level: deferred (user said add later).

Render as a depth-2 Sierpinski triangle (3 tetra levels → 2 subdivisions).
Rotation handle spins it to match physical orientation on the lot.

## Architecture / design

### Workspace layout (introduce Bun workspaces)
```
CampTool/
  package.json              # + "workspaces": ["packages/*"]
  packages/
    theme-contract/         # @camptool/theme-contract — TYPES ONLY (+ tiny helpers)
      index.ts              #   CampTheme, CampStructure (custom-kind contract), render ctx types
    default-theme/          # @camptool/default-theme — built-in, ships with OSS
      index.ts              #   satisfies CampTheme; structures: [] (no bespoke kinds)
    mathcamp-theme/         # @camptool/mathcamp-theme — Math Camp's bespoke package
      index.ts              #   satisfies CampTheme; structures: [sierpinskiPyramid]
      structures/sierpinski.tsx
  app/
    theme/
      index.ts              # re-exports the ACTIVE theme (via ~/active-theme alias)
```
- **`~/active-theme` alias** resolves (Vite `resolve.alias` + tsconfig path) to
  the package named by `CAMP_THEME` env, default `@camptool/default-theme`.
  `app/theme/index.ts` imports it, validates `satisfies CampTheme`, re-exports.
- Contract lives in its own **types-only package** so both core and theme
  packages import it without an app↔package cycle.

### The structure-registry contract (the part the pyramid needs)
`CampStructure` extends the existing `Kind` shape with optional **render hooks**
so the package owns bespoke drawing and core never learns the word "sierpinski":
- data fields: `value/label/color/w/h/shape/vehicle/rigid/group/tags/personal`
  (+ `tallFt` default, `personal: false` — officer-placed).
- `renderFootprint(ctx) => ReactNode` — SVG drawn in the 0,0→w,h **feet** box,
  matching how core draws rect/hexagon. ctx = `{ w, h, color, selected, object }`.
- optional `renderIcon(size)` for legend/tray; falls back to a generic glyph.
- optional `renderShadow(...)` later for the shade sim (start: treat bbox as a
  filled triangle, good enough; refine to true tetra shadow later).
Core `map.tsx` shape branch gains a terminal `def.renderFootprint?.(ctx)` case;
`structures.tsx` merges `coreKinds ∪ theme.structures` into `KINDS`.

### Registry refactor (smallest change that unbloats the shared palette)
- Rename the current literal to `CORE_KINDS` in `structures.tsx`.
- `KINDS = [...CORE_KINDS, ...activeTheme.structures]` (import from `~/theme`).
- Keep `kindDef/KIND_GROUPS/CAMPER_KINDS/...` deriving from `KINDS` so all
  existing consumers work unchanged. Custom kinds carry `group: "Camp"` (new
  legend group appended) so they slot into the legend automatically.
- The Sierpinski labels ("Group W Bar"/"lecture hall") are **baked into the
  mathcamp renderer** (camp-specific data is allowed to be hardcoded there).

## Decisions already made (don't re-ask)
1. Full Phase 2.5 camp-package path (user-chosen), not a one-off shared kind.
2. Three packages: `theme-contract` (types), `default-theme`, `mathcamp-theme`.
3. Custom kinds extend `Kind` with optional `renderFootprint/renderIcon` hooks;
   core falls through to them. No ever-growing `ShapeKind` enum.
4. Pyramid = ONE `map_object`, new kind `sierpinski` (mathcamp-theme), labels
   baked into the renderer, `tallFt` default ≈ 32.7, center Pi marker.
6. **Self-shading (which face is in shade) — DONE (2026-06-18):** added a
   `shadedFaces?: (w,h, sun: SunDir) => polygons` hook + `SunDir` (toward-sun unit
   in object-local footprint coords) to the contract. Core computes the local sun
   (`sunDirLocal`: un-rotates the plot azimuth by the object's rotation, adds the
   altitude `up` component) and draws a sun-aware overlay layer over the structures
   (gated on Show shade) tinting the returned wedges. The pyramid computes its 3
   slant-face 3D normals and returns the corner→centroid wedge of each face turned
   away from the sun (normal·sun ≤ 0) → shows the shady/lee side; a high sun lights
   all faces. Done as a separate overlay layer (NOT threaded through the memoized
   `MapObjectShape`), so no memo/perf churn. Verified vs the cast-shadow direction.
7. **Footprint = 3 top faces, flattened (2026-06-20, user-chosen "Option B"):**
   renderFootprint now draws the 3 UPWARD faces as 3 Sierpinski wedges meeting at
   the apex (projected to the base centroid G): `sierpCells(G,A,B)`, `(G,B,C)`,
   `(G,C,A)`, each depth 2. Negative space is FILLED, not void: each level's middle
   "hole" = blue (`#4dabf7`), kept/solid triangles = tan (`#d2b48c`). (Per-face
   coloring, so blue is each face's holes, not globally down-pointing — user
   accepted this trade-off over the cleaner single-triangle Option A.) Corner labels
   (Group W Bar / lecture hall ×2) moved to lerp(corner→G, 0.42) with a white text
   halo for legibility over the busy fill; π apex marker stays at G; legend icon is
   the same 3-wedge look at depth 1. The `shadedFaces` self-shade wedges now ALIGN
   with these face-wedges (both are G-based), so a shaded face darkens its drawn
   wedge. Verified by-coordinates (couldn't screenshot — chrome ext de-authed).
5. Flying buttresses = deferred. ~~True tetra shadow = deferred~~ → **DONE
   (2026-06-18):** added a general `shadowVolume?: (w,h) => ShadowVertex[]` hook to
   the contract (3D silhouette = centered-local footprint pts + z as a fraction of
   tallFt). Core `map.tsx` `shadowPolygon` branches to a new `volumeShadow` (projects
   each vertex away from the sun by `z·tallFt/tan(alt)`, convex-hulls them) when a
   kind supplies it. The pyramid (solid, shade-covered) declares its 4 tetra
   vertices → casts the true triangle-tapering-to-apex shadow, not the extruded
   bounding box. Verified via a projection preview (new tetra hull vs old box). The
   generic bbox path still applies to custom kinds without `shadowVolume`.

## Plan / steps (incremental — keep typecheck+build green at each)
- [x] **A. Workspace + seam, no behavior change.** DONE. Root `workspaces` +
      declares `@camptool/default-theme`/`theme-contract` as `workspace:*` deps
      (required for Bun to symlink them). Created `packages/theme-contract`
      (CampTheme + CampStructure + Kind/ShapeKind/KindTag/FootprintCtx types),
      `packages/default-theme` (empty `structures`), `app/theme/index.ts`
      (imports `@camptool/default-theme`, re-exports `theme`/`campStructures`).
      Build switch = **Vite `resolve.alias` swaps `@camptool/default-theme` →
      `CAMP_THEME`** when set (NOT a `~/`-tsconfig path, to avoid the
      vite-tsconfig-paths plugin clobbering it). tsconfig `include` += packages;
      `.env.example` += `CAMP_THEME`. `bun install` → symlinks present; typecheck
      + build GREEN. Default theme contributes nothing → identical behavior.
      Gotcha confirmed: Bun only symlinks workspace pkgs that are depended upon —
      had to add them to root `dependencies`.
- [x] **B. Registry refactor.** DONE. `CORE_KINDS` (const tuple) →
      `KINDS: readonly CampStructure[] = [...CORE_KINDS, ...campStructures]`.
      Types now sourced from `@camptool/theme-contract` (re-exported from
      `structures.tsx` for back-compat). `kindDef`/`KIND_MAP` return
      `CampStructure`; `FALLBACK_KIND` derived from `CORE_KINDS` (always defined);
      `kindHeight` falls back to a structure's `tallFt`. `KindIcon` honors
      `renderIcon`. `map.tsx` gained a `def.shape === "custom" && def.renderFootprint`
      branch wrapping the footprint in `<g translate(px,py) scale(ppf)>` (renderer
      draws in feet). Default theme contributes nothing → zero visible change.
      typecheck green.
- [x] **C. mathcamp-theme + Sierpinski kind.** DONE. `packages/mathcamp-theme`
      with `structures/sierpinski.tsx`: depth-2 Sierpinski-triangle renderer (40′
      edge, 9 small-tetra fills, 3 medium-tetra corner outlines + labels
      "Group W Bar"/"lecture hall"×2, center π marker), `tallFt ≈ 32.7`, rigid,
      `personal: false`, `group: "Camp"`, plus a `renderIcon` legend glyph.
      `.env` → `CAMP_THEME=@camptool/mathcamp-theme`; added to root deps. Build
      confirms the alias swaps it in (server bundle contains "Sierpinski"/"Group W").
- [x] **D. Verify render.** DONE (rendered the footprint with the app's own React
      via react-dom/server → SVG → Chrome screenshot). Footprint is correct: 40′
      Sierpinski triangle, the 3 labeled corner mediums, central open space + π
      marker, clean legend icon. typecheck + build + biome all green; my files
      lint-clean (pre-existing migration-JSON lint noise is unrelated). Throwaway
      preview script removed.
- [x] **Deployed + live-palette verified (2026-06-18).** Pushed (commits 097b9c6
      + 51f05a4); "Deploy to firefly" GREEN in 43s (Build with CAMP_THEME, the
      packages/-aware staging, and the /_version health check all passed). On
      https://camptool.mathcamp.us/map (logged in as Cameron, 2026 edition, lot
      set up) the legend shows a new **CAMP** group with the **Sierpinski Pyramid**
      icon rendered correctly — the whole build-time theme seam works in prod.
      STILL TODO (manual): actually drag it onto the lot. Browser-automation
      `left_click_drag` can't place it — the legend uses dnd-kit, which needs real
      pointerdown/up (the documented map drag limitation); the tool only emits
      pointermove, so the drop is a no-op. Left for Cameron to drag (one drag from
      the CAMP legend onto the lot), since it's a 40′ centerpiece on real data he'll
      want to position/rotate intentionally. Rotation/shade-sim sanity check rides
      along with that manual placement.

## Deployment / ops (build-time theme — important)
`CAMP_THEME` is consumed by **Vite at `bun run build`** (bakes the theme into the
bundle), so it is a **build-time** var — NOT a runtime env-file key. Where it's set:
- **firefly:** set in the **ops-managed env-file** (`CAMP_THEME=@camptool/
  mathcamp-theme`). The deploy job inherits that env-file (same source as
  `BETTER_AUTH_SECRET`), so the build reads it — the repo is camp-AGNOSTIC, nothing
  hardcoded in CI. Unset → built-in default-theme. Caveat: build-time, so a change
  needs a redeploy, not a restart. (Earlier I wrongly hardcoded
  `@camptool/mathcamp-theme` into deploy.yml's Build step — reverted in `ecc774e`;
  the repo must stay generic.)
  **DEPLOYED + VERIFIED env-driven (2026-06-18):** ops wired `CAMP_THEME` into the
  runner container env (ops-comms msgs 14/15); pushed `ecc774e` → deploy green (49s);
  confirmed the live bundle contains the theme WITHOUT login — fetched the SSR route
  manifest from `/login`, walked the `/assets/*.js` chunks, found "Sierpinski"/
  "Group W" in `entry.client-*.js`. So the env-driven build picks up the theme.
  Flagged to ops (comms msg 16): `CAMP_THEME` is now a must-persist key — if it's
  ever dropped, the theme silently falls back to default (green CI, no error).
- **generic self-host:** Docker build-arg (`Dockerfile` `ARG CAMP_THEME`, default
  `@camptool/default-theme`; `compose.yaml` passes `${CAMP_THEME:-…}`).

Workspaces forced build/release-plumbing fixes (all landed):
- The three `@camptool/*` are **devDependencies** (build-time only; bundled into
  `build/`), so the runtime `--production` install doesn't pull them.
- BUT `packages/` MUST still ship to every dir that runs `bun install`, because
  the root `workspaces: ["packages/*"]` glob fails to resolve if the dir is
  missing — even under `--production`. Verified: `--production` with `packages/`
  present succeeds and skips the devDep themes; without `packages/` it errors
  `Workspace dependency … not found`.
- firefly staging `cp`s `packages` into the release dir, then prunes any
  `packages/*/node_modules` the build-step install created (release-dir install
  regenerates). Dockerfile copies `packages` before BOTH installs; `.dockerignore`
  gained `**/node_modules` so nested workspace node_modules don't leak into context.

## Follow-up batch (2026-06-20) — pyramid polish + map-editor geometry

Pyramid package (`packages/mathcamp-theme/structures/sierpinski.tsx`):
- [ ] **A1. Labels map-oriented, not pyramid-oriented.** Bar / lecture-hall / π text
      must stay upright to the map as the object rotates. Add `rotation` to
      `FootprintCtx`; counter-rotate each text by `-rotation` about its anchor.
- [ ] **A2. Pi casts a shadow.** The π sits ~6′ above the tetra apex (so height ≈
      tallFt + 6 ≈ 38.7′). Project it to the ground — add the π tip as an extra
      `shadowVolume` vertex (z = (tallFt+6)/tallFt ≈ 1.18) so the cast-shadow spike
      reaches it. (Reasonable convex-hull approximation; refine to a distinct glyph
      later if wanted.)
- [ ] **A3. Gradual face shading (no snap).** Replace the binary `shadedFaces`
      (face shaded or not) with a continuous Lambert tint: return per-wedge a
      `shade` ∈ [0,1] = `(1 − max(0, n̂·Ŝ))·k`, so each upward face darkens smoothly
      as it turns from the sun instead of snapping on. Contract: `shadedFaces` now
      returns `{ points, shade }[]`; core uses `fillOpacity = shade`.

Core map editor (`app/routes/dashboard/map.tsx`) — mostly VISUAL, and the chrome
ext is currently de-authed so these need the user (or re-auth) to eyeball:
- [x] **B4. Shape-aware bounds (bug) — DONE.** Added module helpers
      `lotHalfWidthAt`/`clampPointToLot`/`pointInLot`/`objectOverflowsLot` (lot =
      trapezoid: front width frontageFt, rear width `rear`, centered on
      frontageFt/2, depth depthFt). All 4 clamp sites (keyboard nudge, drag-move,
      add, drop-from-tray) now constrain the object's CENTER to the trapezoid (was
      clamping the top-left corner to a w/h-shrunk axis box → the asymmetry). New
      `overflow` prop on `MapObjectShape` (memoized) draws a red dashed box when any
      footprint corner crosses the lot border.
- [x] **B5. Shadows onto neighbors — DONE.** Added a `ground-clip` rect (whole
      inner view) and pointed the cast-shadow group at it instead of the lot clip,
      so shadows fall onto neighbors/roads. (Neighbor-cast shadows still deferred.)
- [ ] **B4-OLD. Shape-aware bounds (bug).** Current clamp is wrong/asymmetric (can't
      push the pyramid into the top-right corner, but can drag it far outside
      bottom-right). Change object clamping to constrain by the **centerpoint**
      within the camp area (the tapered wedge, not a w/h-shrunk axis box), and
      **highlight the object when its shape crosses the lot border**. Current clamp
      sites: keyboard nudge (~2007), drag (~2166), add/drop (~2416/2441) all use
      `clamp(.,0,frontageFt/depthFt)` minus w/h — that's the asymmetry.
- [ ] **B5. Shadows extend onto neighbors.** Shadows are currently clipped to the
      lot (`clipPath url(#lot-clip)`, ~2765). Let them spill onto neighbor areas
      (widen/replace the clip). "Eventually from them" = neighbor-cast shadows —
      defer.
- [ ] **B1. No gap between camp and neighbors/street/service lane.** Close the gap
      the lot drawing leaves around the wedge (~2067–2756 neighbor/service bands).
- [ ] **B2. Neighbors/roads curved/angled to the city clock grid.** Draw the
      adjacent streets/alley/neighbor lots as radial-wedge geometry (concentric
      arcs + radial sides), not axis-aligned bands.
- [ ] **B3. Avenue arrows + labels.** Arrows to the nearest radial avenues with
      clock labels (e.g. "3:30"). Uses `brc.ts` clock/bearing helpers.
- [ ] **B6. Cable follows its object on drag.** Dragging an object that has a
      power line (`map_cable`) endpoint on/near it should drag that endpoint along
      (stay connected), unless a modifier (Shift?) is held to detach. Need an
      endpoint↔object association (proximity at drag-start) + move the cable point
      with the object.

Order: A1–A3 (self-verifiable) → B4, B5 (logic) → B6 → B1, B2, B3 (visual; need eyeball).

## Later follow-ups (2026-06-20, batch 2) — status

Shipped this batch: A1/A2/A3 (4c4b0dc), B4/B5 (53f91bf), doors-dark-mode + fixed
pyramid height (b42a5d4). Remaining below.

- [x] **P2. Pyramid "mirror" option** — DONE. `mirrored` boolean column (mig
      0022); reflects geometry + shadow + the asymmetric buttress footprint.
- [x] **P3. Flying buttresses** — DONE. Hexagon of 6 equilateral triangles over
      the corner small-tetra centroid (8′2″ up), 5 flying outside + ground sticks,
      casting its own (separate) shade. **Extension is adjustable 0–4** via a live
      Slider in the side panel (continues the hexagon's triangular grid, straddling
      the front edge). Bounds now include the buttress reach (footprint() returns
      base triangle + buttress verts), so the buttress shades can't run off the
      camp. Per-object `config` JSON column (mig 0024) carries `buttressExt`.
      Commit 2bed56b.
  Original spec, for reference:
      - A point of interest ~8′ up (height of a 10′-edge tetra = 10·√(2/3) ≈ 8.16′)
        above the **bar corner**.
      - A horizontal **equilateral triangle** at that height, inside the pyramid.
      - A **hexagon** of 6 such triangles around that point: 1 inside + **5 flying
        OUTSIDE** the footprint (the start of the flying shade).
      - **Support sticks** (legs) from the flying hexagon's outer vertices to the
        ground.
      - Optionally **extend** the flying shade with more triangles (a strip) + more
        sticks.
      - Filled as shade; casts an ~8′-high shadow.
      Top-down: a hexagon (+ optional extension strip) centered on the bar corner,
      spilling past the footprint, with stick footpoints. Needs per-object config
      (extent/direction) → see config note. Intricate + visual → confirm via preview.
- [ ] **B1/B2. Curved surroundings.** Neighbors/street/service as radial-wedge
      geometry abutting the lot (no gap). Lot already draws a true wedge; redo the
      axis-aligned surrounding bands to follow it. Visual.
- [ ] **B3. Avenue arrows + labels** (e.g. "3:30"). Visual.
- [ ] **B6. Cable follows its object on drag** (unless Shift to detach). Logic.

**Per-object config (P2 + P3) — DONE.** `map_object` now has a nullable `config`
(JSON text) column (mig 0024). Threaded into `FootprintCtx.config` and the
`footprint(w,h,config)` / `shadowVolume(w,h,config)` hooks. A custom structure
declares `controls: [{key,label,min,max,step,default}]`; the side panel renders a
Slider per control and commits the config JSON via the `updateObject` action
(officer-only). `parseConfig` keeps only finite-number values. The pyramid uses
`buttressExt` (0–4, default 2).

**Verification blocker:** the Chrome extension is de-authed, so I can't screenshot.
The remaining items are visual; either re-auth the extension or I serve a localhost
preview for the user to open before deploy.

## Findings / gotchas
- typecheck uses the STATIC tsconfig path for `~/active-theme` (→ default-theme),
  so typecheck validates against the default; the active package is build-time.
  Ensure mathcamp-theme is ALSO covered by a typecheck (add to tsconfig include
  or a package-level check) so its bespoke code doesn't rot.
- map.tsx is huge; the shape if/else appears in MULTIPLE places (main render
  L3304+, plus icon/shadow). Find every `def.shape ===` site before adding the
  fallthrough so the custom kind renders everywhere (map, tray, legend, panel).
- Don't add deps to theme packages that pull a 2nd React instance (same class of
  bug as @mantine/dates). Theme packages should rely on the app's React.

## Progress log
- [x] Design captured (this file). Read current build setup (package.json /
      vite.config / tsconfig / structures.tsx / map.tsx shape sites / AddStructures).
- [ ] A → B → C → D (see steps).

## Open questions for the user
1. Package name for Math Camp's theme: `@camptool/mathcamp-theme` ok?
2. Is the central area genuinely open gathering space (top tetra elevated), or is
   there a 4th ground footprint to draw? (Assumed: open/shaded center.)
3. Pi-stick: just a center dot+π glyph, or do you want its separate long shadow
   modeled too? (Assumed: glyph now, shadow later.)
