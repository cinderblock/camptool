# Custom structures (per-camp, defined at runtime)

> Living plan. Read first. Keep current. Parents: `plans/camptool.md`,
> `plans/hosting-other-camps.md` ("Structure packs"). Predecessor:
> `plans/camp-theme-and-custom-structures.md` (the build-time pack seam).

## Goal

Let each camp on the shared site define its **own** map structure kinds in the
app, stored per camp in D1, with no code change or deploy. They place, render,
shade and get banned exactly like built-in and pack kinds. Other camps never
see them. Existing pack kinds (Math Camp's) and saved map objects keep working.

Why: CampTool hosts several camps now (Entheos next). Build-time packs need a
deploy per camp, and per-camp pack switches don't scale ("imagine the number of
columns"). A separate thread is removing the Site admin pack-toggle column;
this work must not rebuild it.

## Environment / context

- Kinds today: `app/lib/structures.tsx` (`CORE_KINDS` + `campStructures` from
  bundled packs → module-level `KINDS`, `kindDef`, `kindHeight`, `KIND_GROUPS`,
  `CAMPER_KINDS`, `isKind`, `hasTag`, `KindIcon`, `ShapeSwatch`).
- Kind contract: `packages/theme-contract/index.ts` (`Kind`, `CampStructure`
  with optional code hooks: `renderFootprint`, `footprint`, `shadowVolume`,
  `crossSectionAt`, `shadedFaces`, `controls`).
- `map_object.kind` is plain text (`db/schema/map.ts`); `camp_edition.banned_kinds`
  is a JSON array of kind values (`app/lib/bans.ts`). Wiki pages, bringing,
  start wizard, inventory, swaps, schedule, uplink LOS and map snapshots all key
  on kind strings.
- Consumers of the global registry: ~110 call sites. `map.tsx` (10.7k lines) 47,
  then bringing, start, map-shapes, editions, wiki, inventory, uplink-los,
  swaps, schedule.
- Unknown kind → `kindDef` falls back to the generic "structure" kind (renders,
  degraded). That is the safety net during the refactor.

## Design

### 1. Data: `camp_structure_kind` table (camp-scoped, not per edition)

| column | notes |
| --- | --- |
| `id` | text pk |
| `camp_id` | FK → camp, cascade. The tenant key. |
| `value` | unique. The kind string stored on `map_object.kind`: `x-<id>`. Never changes, so renames don't touch placed objects, banned lists or wiki links. The `x-` prefix can't collide with core/pack values (checked). |
| `label` | display name |
| `group_name` | legend group; default `"Camp"`. Free text, pick existing or new. |
| `color` | hex |
| `shape` | `rect` \| `hexagon` \| `round` \| `outline` |
| `width_ft`, `length_ft` | default size of a new object |
| `outline` | JSON `[{x,y}]`, normalized 0..1 of the box; only for `outline`. Scales with resize. |
| `tall_ft` | default height (shade sim, LOS) |
| `canopy_shade` | shade cloth: blocks sun, not wind/radio |
| `tags` | JSON subset of `domicile` / `vehicle` / `structure` |
| `personal` | campers may declare their own (Bringing / wizard) |
| `rigid`, `fixed_rotation` | no resize / no facing |
| `description` | shown in the editor and on hover |
| `sort` | order within its group |
| `archived_at` | hidden from palettes, still renders saved objects |
| `created_by`, `created_at`, `updated_at` | |

Kinds are camp-level, so they carry across years. Per-year control stays where
it is: the edition's banned kinds.

### 2. A per-camp `KindRegistry` replaces the module-level globals

- `makeKindRegistry({ core, packs, custom })` returns an object with today's
  helpers as members: `def`, `isKind`, `color`, `height`, `hasTag`, `all`,
  `palette` (non-archived), `groups`, `camperGroups`.
- Each custom row compiles to an ordinary `CampStructure`:
  - `rect` / `hexagon` / `round` map onto the core `rect` / `hexagon` / `dome`
    shapes, so they draw through exactly the same branch as built-ins.
  - `outline` becomes `shape: "custom"` with a generated `renderFootprint`
    (the polygon), `footprint` (overlap checks), `renderIcon`, and a
    `shadowVolume` (outline extruded to `tall_ft`).
  - So the map renders custom kinds with no new drawing paths.
- **Server:** `loadKindRegistry(db, campId)` (one small query). Every loader and
  action that validates or defaults a kind uses it: add/declare actions refuse a
  kind that isn't in *this camp's* registry, which is what keeps camps apart.
- **Client:** the dashboard layout loader returns the camp's custom rows; a
  `KindsProvider` builds the registry once (memoized) and `useKinds()` hands it
  out. Pure helpers (`map-shapes`, `uplink-los`, `swaps`, `schedule`) take the
  registry as a parameter.
- Once every consumer is moved, the old global exports are **deleted**, so the
  compiler finds any site that would silently miss custom kinds.
- Pack availability (`unavailableKinds` / whatever the toggle-removal thread
  leaves) still feeds `blockedKinds`; this design doesn't depend on
  `camp.structure_packs` either way.

### 3. Editor UI: Map → "Camp structures" (`/map/structures`, officer+)

- List grouped by legend group, with archived ones folded away.
- Form: name, legend group, shape (Rectangle / Hexagon / Round / Custom
  outline), default size W × L ft, height ft, colour, shade-cloth toggle, tags,
  "campers can bring their own", fixed size, no facing, description.
- Live preview drawn by the map's real shape renderer at scale on a 1 ft grid,
  with the cast shadow, so what you see is what the map draws.
- Custom outline: click the grid to add points, drag to move, snap to 1 ft,
  click a point to remove it.
- Linked from the map legend for officers. Changing a kind's default size or
  colour doesn't touch placed objects (they own their size and colour), same as
  packs today.
- Delete: archive always works; hard delete only when no map object uses it.

### 4. Math Camp's pack: keep it as code

The pack's structures need code: the Sierpinski pyramid's fractal footprint,
sun-aware face shading, tapering LOS cross-sections and buttress controls; the
hypar shade's per-corner heights. None of that fits a data row without
inventing a scripting language. So:

- Packs stay, but shrink to **code plugins for structures that need code**.
  Anything describable as a shape + size + height becomes runtime data.
- Both sources feed one registry, so no consumer can tell them apart.
- If Math Camp has (or later adds) a plain-shape pack kind, it can move to
  data then, with a one-off migration rewriting `map_object.kind`.

## Plan / steps

1. [x] Design sign-off (2026-11-20; all six recommendations accepted).
2. [ ] **Current step.** Schema + migration: `camp_structure_kind` via `bun run db:generate`
   (memory: no-TTY rename split; hide other threads' un-migrated tables), D1
   override if needed, `bun run db:verify`. Check backup + `import-to-d1.ts`
   pick the table up.
3. [ ] `KindRegistry` (pure, unit tests), compile custom rows, polygon
   footprint / icon / shadow (tests: shadow, overlap, resize scaling).
4. [ ] Move every consumer to the registry; delete the globals. No behaviour
   change for camps without custom kinds (typecheck + existing tests + e2e).
5. [ ] Server load, `KindsProvider`, action validation (cross-camp refusal test).
6. [ ] `/map/structures` editor with live preview and outline editor.
7. [ ] Wire-up: legend link, palettes, editions banned-kinds picker, wiki
   kind pages, bringing / wizard (for `personal` kinds).
8. [ ] Verify: e2e on Bun and `wrangler dev` (create kind → place → shade →
   ban → archive → still renders; camp B can't see or place it), screenshots.
9. [ ] Ship: commit per step, push to `master`, confirm Workers Builds deploy
   and `/_version`.

## Open questions for the user

None open.

## Decisions already made (don't re-ask)

- Runtime, per camp, in D1; no deploy per camp. (Cameron, 2026-11-20.)
- Don't rebuild the Site admin pack-toggle column; another thread removes it.
  (Cameron, 2026-11-20.)
- Custom outlines (polygons) are in v1. (Cameron, 2026-11-20.)
- Officer+ edits a camp's kinds. (Cameron, 2026-11-20.)
- Icons come from the shape in v1; uploaded images (R2) later. (Cameron.)
- Hiding built-in kinds per camp (decluttering a palette, not banning) is a
  separate follow-up; edition banned kinds cover it meanwhile. (Cameron.)
- No feature flag: part of the map feature, officer-only. (Cameron.)
- Math Camp's pack stays as code (section 4). (Cameron.)

## Findings / gotchas

- `kindDef` silently falls back for unknown kinds; that's why the globals must
  be deleted at the end rather than left beside the registry.

## Things not to do

- No module-level mutable "current camp kinds" on the server: Workers isolates
  serve many camps concurrently, so it would leak kinds across camps.
- Don't key custom kinds by label; renames would orphan placed objects.

## Progress log

- 2026-11-20: Read plans + registry code; wrote this design. Signed off.
