# Fast page switches (mobile 2–3 s → instant)

> Task plan. Parent plan: `plans/camptool.md`. Plan path: `plans/fast-navigation.md`

## Goal

Switching pages in the app takes 2–3 seconds on a phone (reported 2026-11-21).
It should feel instant. Find where the time goes, then remove it.

## Environment / context

- Live: Cloudflare Worker `camptool` + D1 + R2 (`wrangler.jsonc`), deployed by
  Workers Builds from `origin/master`. Math Camp at
  `https://mathcamp.camptool.org`. `/_version` reports the deployed SHA.
- Work happens in the worktree `CampTool-nav-speed` (branch `nav-speed`, off
  `origin/master`). The main checkout's `master` is 70 commits behind origin
  and holds another thread's uncommitted work; leave it alone.
- React Router v7 framework mode, single fetch: a client navigation is one
  `GET /<path>.data?_routes=…` plus the route's JS chunk.

## Findings

- **Every D1 query is a long round trip.** Responses carry
  `Cf-Placement: local-SJC`: Smart Placement has *not* moved the Worker next to
  the database; it runs at the visitor's colo and each query crosses to D1.
  Timed from a desktop (2026-11-21 11:20 AM PST, 19:20Z):
  - `/_version` (no queries): ~100 ms
  - `/login`: ~230–300 ms
  - `/c/mathcamp` (~5 sequential queries): ~480 ms → roughly 70–80 ms per query.
- **Loaders query one after another.** A dashboard page runs
  `resolveActiveCamp` (session, user, camps, editions — sequential) plus
  `requireFeature`, then its own queries, all awaited in series. 15–25 serial
  round trips × ~75 ms ≈ 1–2 s of server time per page switch before the phone's
  own latency.
- **Live, with the header deployed** (`28c9bbb`, 11:35 AM PST, 19:35Z):
  `/c/mathcamp` = `db;dur=660;desc="6 queries, 6 round trips", total;dur=667`.
  ~75–110 ms per round trip, and D1 is 100% of server time.
- **Smart Placement won't help at our traffic.** Per the Workers docs it only
  moves a Worker with "consistent traffic … from multiple locations", and it
  doesn't place by D1 binding. `placement.region` (`{provider}:{region}`, e.g.
  `aws:us-east-1`) pins it explicitly. Which region D1 lives in isn't visible
  from here: this machine's wrangler login doesn't include the isozilla account.
- **Counted locally (wrangler preview, dev data, member account), sequential
  waits per request**, before → after the shell changes:
  - full load: `/members` 36 → 6, `/roster` 43 → 13, `/trip` 35 → 5,
    `/map` 43 → 10, `/` 55 → 12.
  - page switch (only the page's own loader runs): 7–16 waits, unchanged.
    Every route loader is serial; that long tail is what placement fixes in
    one move.
- Breakdown of a switch: root middleware's camp-move check (2, cached 30 s per
  isolate), better-auth session + user (2), camps ∥ editions (1, was 2),
  feature gate (1), then the page's own queries.
- **No prefetch and no pending feedback.** Nav links don't prefetch, and
  nothing on screen changes until the new page's data arrives.

## Plan / steps

1. [x] Measure: per-request `Server-Timing` (D1 query count + time,
   total) from the Worker, so every fix is checked against numbers.
2. [x] Client: immediate feedback (pending bar) and prefetch nav links on intent.
3. [x] Server, shell: ask snapshot (19 queries) and layout loader in parallel
   waves; camps ∥ editions in `resolveActiveCamp`.
   [ ] Later, only if still needed after placement: per-route loaders, and
   better-auth `session.cookieCache` (drops 2 waits per request; trade-off:
   a revoked session lingers up to its maxAge).
4. [x] **Move D1 + R2 west** (Cameron, 2026-11-21: "fix that now, while
   I don't have users"; pinning the Worker east was rejected, users are in
   California). Done 2026-11-21 1:19–1:45 PM PST (21:19–21:45Z):
   a. [x] ops `1e60e624`: D1/R2 `location`; created D1 `camptool-db`
      (`a3acbd48-…`, `running_in_region: WNAM`) and R2 `camptool-files`
      (`WNAM`).
   b. [x] Data copied. The raw `wrangler d1 export` would not load (see
      Findings); `scripts/order-d1-dump.ts` reordered it. Row counts match in
      all 84 tables (1,351 rows); the old database had no writes after the
      export. 3 R2 objects copied, sha256 verified. Backups (the export, the
      ordered copy, the R2 files) in the main checkout's
      `data/backups/` (git-ignored).
   c. [x] CampTool `c68a4d4`: binds `camptool-db` / `camptool-files`. Live as
      `7d047f8`.
   d. [x] Live: Server-Timing at SJC shows ~12 ms per wait warm (e.g. 4 waits
      in 48 ms, 2 in 38 ms) vs 75–110 ms before; `camptool-db` is serving the
      queries. Signed-in page switches not measured by me (no session); 7–16
      waits should now be ~100–200 ms.
   e. [ ] Tombstone `camptool` + `camptool-uploads` in ops (separate yes).
5. [x] Re-measured live (4d).
6. [x] ops `92534fbd` (pushed 2026-11-21): D1/R2 default to `wnam` when an
   entry names no location (Cameron, 2026-11-21: "our default locations
   should be us west/california/San Jose"). Dry run: 0 changes; CI
   green.

7. [x] **Fast far from the database too** (Cameron, 2026-11-21: "so
   that it's still faster for people on east coast/around the world").
   a. [x] Shell floor: feature states load with the camps
      (`loadUserFeatureStates`), so `requireFeature` needs no query. Floor
      4 → 3 waits on every page (`34a32c3`).
   b. [x] Per-route loaders parallelized (`eb15915`, `3f86b88`, `0ac74f8`).
      Officer page switch on a local copy of the live data, before → after:
      members 18 → 8 (the Discord sync's per-member writes stay serial),
      roster 16 → 4, passes 15 → 4, map 14 → 4; every other page 4–6.
      Verified: `.data` responses byte-identical to the old build for 35
      pages, as officer and member, on dev data and on the live-data copy;
      an independent review found no gating or data changes; headless
      Pixel 7 page switches through 19 pages, no errors.
      Left for later: `loadResponseMatrix` (questions/responses 6 → 4),
      `loadMySapState` (trip −1), batching `syncDiscordLinksForCamp`'s
      upserts (members −N), and an unused `partyRows` query in the passes
      action.
   c. [x] **Pin the Worker next to D1**: `placement: { region:
      "aws:us-west-1" }` (D1 primary answers from SJC: `served_by_colo:
      SJC`). Cameron said yes 2026-11-21; wrangler dry run accepts it. Effect: a far
      visitor pays one cross-country trip per request instead of one per
      wait.
   d. Not doing: better-auth `session.cookieCache` (would drop the last 2
      shell waits, but a revoked session, e.g. passkey recovery deleting
      sessions in `passkey-recovery.server.ts`, keeps working until the
      cache expires, and direct `session` writes like the subdomain's
      active-camp sync go stale; once the Worker sits next to D1 those 2
      waits cost a few ms). D1 read replication + Sessions API: worth it only
      if most traffic were far away; placement covers our case with no code.

## Decisions already made (don't re-ask)

- "Best, not fastest" applies.
- Default region for anything new is US West / California / San Jose
  (Cloudflare `wnam`), never a provider's default.

## Why the data was in the east

Ops created them as `- d1: camptool` / `- r2: camptool-uploads`, no location.
Cloudflare places a new database or bucket near the API caller, and the ops
sync runs on a GitHub runner in the eastern US. Confirmed: `wrangler r2
bucket info camptool-uploads` → `location: ENAM`; Cameron saw Eastern North
America on the D1. Ops now takes `location` on `d1:`/`r2:` entries.

## Restoring a `wrangler d1 export` into D1

Loading the export as is failed twice: `no such table: main.user`, then
`FOREIGN KEY constraint failed`. D1 checks foreign keys statement by
statement during an import, so the export's `PRAGMA defer_foreign_keys`
doesn't span it, and the export writes each table's rows right after its
CREATE, in creation order. A failed import rolled back cleanly (1 object in
`sqlite_master`). `scripts/order-d1-dump.ts` writes the tables first, then the
rows parent-first, and checks the result locally with foreign keys on. The
app's own backup likely has the same problem (ISSUES.md).

## Things not to do

- Don't change Cloudflare settings (placement, D1 replication) without a
  per-change yes. Stage the `wrangler.jsonc` diff and show it.

## Progress log

- [x] 2026-11-21: diagnosed D1 round-trip cost and serial loaders.
- [x] 2026-11-21: `Server-Timing` live (`28c9bbb`); now reports sequential
      waits.
- [x] 2026-11-21: shell loaders parallel; loading bar (`NavigationProgress`,
      shows after 120 ms); nav links `prefetch="intent"`. Verified in a
      headless Pixel 7 against the local Workers preview.
- [x] 2026-11-21: D1 is in Eastern North America (Cameron, from the
      dashboard). Most users are in California.
- [-] Pin the Worker east: dropped. Cameron chose moving the data west.
- [x] 2026-11-21: step 4a–d done (Cameron's yes); live `7d047f8`, ~12 ms
      per wait.
- [ ] Step 4e: tombstone the eastern pair (later, separate yes).
- [x] Step 6: ops default-`wnam` pushed (`92534fbd`, Cameron's yes); CI
      green, 0 changes.
- [x] 2026-11-21: step 7a, shell feature gate folded into the camps query.
- [x] 2026-11-21: step 7b, per-route loaders (most pages 4 waits).
- [x] Step 7c: placement pin (Cameron's yes).
