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
5. Flying buttresses + true tetra shadow = deferred.

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
      preview script removed. STILL TODO: place it live in the map editor on Math
      Camp's lot (officer) + sanity-check rotation/shade-sim in the running app —
      deferred to a browser session; the rendering logic itself is proven.

## Deployment / ops (build-time theme — important)
`CAMP_THEME` is consumed by **Vite at `bun run build`** (bakes the theme into the
bundle), so it is a **build-time** var — NOT a runtime env-file key. Where it's set:
- **firefly:** `.github/workflows/deploy.yml` Build step `env: CAMP_THEME:
  "@camptool/mathcamp-theme"`. (The runtime ops env-file = PUBLIC_BASE_URL etc.
  is injected at process launch — too late for the build.)
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
