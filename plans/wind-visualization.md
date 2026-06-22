# Prevailing-wind flow visualization (camp map)

## Goal
Show prevailing wind on the camp map as **animated particles that flow across the
lot and bend around buildings** — a cheap "basic fluid dynamics" feel, not full
Navier–Stokes. Helps officers place tents/shade out of dust streams and wind
shadows.

## Decisions already made (don't re-ask)
- **Visual style:** animated particles (streaks) advected through a computed flow
  field. (User picked this over static streamlines / arrow grid.)
- **Wind source:** BRC prevailing default (from the SW/S) + a manual draggable
  dial & strength control. **Not persisted** to the DB (client state only) — the
  user explicitly chose the non-stored option, so NO schema/migration.
- Reuse the map's existing direction machinery: `bearingToPlotDelta`,
  `mapUpBearing`, footprint polygons as obstacles, the shade-sim toggle pattern.
- Repo stays camp-agnostic — wind is a core map feature, not a Math-Camp thing.

## Approach (fidelity)
Coarse **incompressible flow solve** (Jos Stam "stable fluids" projection):
1. Grid over the visible ground (lot + PAD surroundings), cell ≈ domain/60.
2. Mark cells whose center is inside any object footprint polygon as **solid**.
3. Init every fluid cell's velocity = uniform wind vector (dir·speed); solids = 0.
4. Pressure-projection (Gauss–Seidel, ~40 iters) to make the field divergence-free
   with **no-penetration walls** (solid-neighbor pressure = own → Neumann). Domain
   border cells stay at the uniform inflow (open in/out).
5. Result: velocity field that wraps around buildings with slack wind-shadows
   behind them.

Particles: fixed pool (~140), each advected by a bilinear sample of the field;
respawn on exit / entering solid / max-age, biased to the inflow edge. Drawn as
short line streaks inside the map SVG (imperative rAF, no React re-render), so
they inherit the viewBox zoom/pan transform. Clipped to the ground view.
`prefers-reduced-motion` → static traced streamlines instead of animation.

## Files
- `app/lib/wind.ts` (NEW, client-safe): BRC default bearing, dir helper, `FlowField`
  type, `solveFlow()` solver, bilinear `sampleFlow()`.
- `app/routes/dashboard/map.tsx`: state (`showWind`, `windFromBearing`,
  `windStrength`); obstacle polygons + `solveFlow` in `useMemo`; `<WindLayer>`
  (imperative particle animation); `<WindControl>` panel (mini-dial + toggle +
  strength). Toggle off by default.

## Plan / steps
1. [x] `wind.ts`: types + solver + sampler. MAC/staggered grid (see gotcha).
2. [x] map: world obstacle polygons (center + footprintOffsets) + `windField` memo.
3. [x] `WindLayer` particle component (rAF streaks) + reduced-motion streamlines.
4. [x] `WindControl` UI (mini dial bound to mapUpBearing, toggle, strength slider).
5. [x] typecheck + build + numeric sanity (deflection/wake confirmed). Deployed.

## Findings / gotchas
- **A cell-centered projection with a "mirror solid neighbor" trick does NOT
  deflect flow** — the upstream cell's divergence cancels to zero (own velocity =
  inflow), so the solver does nothing. Fixed by switching to a **staggered (MAC)
  grid**: u on vertical faces, v on horizontal faces, wall faces pinned to 0, and
  the standard `s`-factor Gauss–Seidel redistribution. Verified numerically:
  stagnation at the front (u≈0.35), acceleration around the sides (u≈1.29), slack
  wake behind (u≈0.64), upward deflection at the top corner (v≈−0.76).
- `noUncheckedIndexedAccess` makes Float32Array reads `number | undefined` — guard
  every typed-array read with `?? 0`.
- The rAF loop must NOT depend on `field`/transform (it would restart every edit).
  It reads them through `stateRef` updated each render, so moving a building
  re-solves the field and the live particles adapt smoothly.

## Follow-up tweaks (round 2)
- [x] Shade structures are porous to wind — `kind === "shade"` excluded from
  obstacles (blocks sun, not wind).
- [x] Merged the wind dial INTO the orientation (sun) compass, so wind N matches
  map N. Dial radius = wind strength; angle = *from* bearing. Removed the separate
  WindControl + strength slider.
- [x] Particle-count slider (0–400) doubles as on/off (0 = off); `windParticles`
  replaces the boolean. WindLayer takes a `count` prop.
- [x] Fixed BRC orientation: `mapUpBearingFor` was mirrored E–W. New `225 + 30·h`
  is the exact negation of the old `135 − 30·h` (a pure sign flip — 4:30 stays N,
  the rest mirror). 6:00 (gate, SW of Man) → up NE; 12:00 → up SW.
- [x] Curved street/service-road now abut the lot edge (no gap), like neighbors.
- [x] Map page fills the dashboard area (`height: calc(100vh - 88px)`, flex
  column); the map frame + sidebar scroll internally, so zoom never adds a
  page-level scrollbar.

## Things not to do
- Don't persist wind to the DB (user chose client-only).
- Don't re-render React per animation frame — mutate SVG attrs via refs.
- Don't run the rAF loop when the wind layer is off or the lot isn't oriented
  (`mapUpBearing == null`).
