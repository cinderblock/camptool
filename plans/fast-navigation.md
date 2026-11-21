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
4. [current] **Move D1 + R2 west** (Cameron, 2026-11-21: "fix that now, while
   I don't have users"; pinning the Worker east was rejected, users are in
   California). Each step needs Cameron's yes:
   a. ops `1e60e624` (worktree `ops-camptool-wnam`, not pushed): D1/R2
      `location` support + new D1 `camptool-db` and R2 `camptool-files` in
      `wnam`. Dry run: 2 creates, nothing else.
   b. Copy data: `wrangler d1 export camptool --remote` →
      `wrangler d1 execute camptool-db --remote --file` (the export carries
      `d1_migrations`, so the deploy's `migrations apply` is a no-op); copy
      R2 objects. Keep the export as a backup. Writes in between are lost
      (no users yet).
   c. CampTool: `wrangler.jsonc` binds `camptool-db` / `camptool-files`
      (staged, uncommitted). Wrangler rebinds by name: an inherited binding
      is only kept when its database's name matches.
   d. Verify live: per-wait time in `Server-Timing`, sign-in, pages.
   e. Then tombstone `camptool` + `camptool-uploads` in ops (separate yes).
5. Re-measure live; record before/after here.

## Decisions already made (don't re-ask)

- "Best, not fastest" applies.

## Why the data was in the east

Ops created them as `- d1: camptool` / `- r2: camptool-uploads`, no location.
Cloudflare places a new database or bucket near the API caller, and the ops
sync runs on a GitHub runner in the eastern US. Confirmed: `wrangler r2
bucket info camptool-uploads` → `location: ENAM`; Cameron saw Eastern North
America on the D1. Ops now takes `location` on `d1:`/`r2:` entries.

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
- [ ] Step 4a–d: waiting on Cameron's yes.
- [ ] Step 4e: tombstone the eastern pair (later, separate yes).
