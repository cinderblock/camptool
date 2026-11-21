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
- **No prefetch and no pending feedback.** Nav links don't prefetch, and
  nothing on screen changes until the new page's data arrives.

## Plan / steps

1. [current] Measure: per-request `Server-Timing` (D1 query count + time,
   total) from the Worker, so every fix is checked against numbers.
2. Client: immediate feedback (pending bar) and prefetch nav links on intent.
3. Server: cut serial round trips — parallelize independent queries, share
   per-request lookups (session/camps/editions/features), batch where possible.
4. Placement: pin the Worker near D1 — **Cloudflare change, needs Cameron's
   explicit yes for that exact change.**
5. Re-measure live; record before/after here.

## Decisions already made (don't re-ask)

- "Best, not fastest" applies.

## Things not to do

- Don't change Cloudflare settings (placement, D1 replication) without a
  per-change yes. Stage the `wrangler.jsonc` diff and show it.

## Progress log

- [x] 2026-11-21: diagnosed D1 round-trip cost and serial loaders.
