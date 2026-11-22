# CampTool — agent orientation

**Read `plans/camptool.md` first.** It is the living plan: vision, locked
decisions, schema sketch, phased roadmap, and progress log. Keep it current —
update it in the same turn you make a decision or hit a gotcha, and surface its
path in your responses.

## What this is

Self-hosted web app for managing an event **theme camp**. Built for one camp
first, open-sourced (MIT) so other camps can self-host. See `README.md`.

**Not Burning-Man-specific.** Four layers (see the plan's Architecture section):
(1) the **core app** framework — users, groups, onboarding framework, post-event
followups (this repo, event/camp-agnostic); (2) **per-camp** theming (the
`camp-theme` contract); (3) **per-event** theming + map/addressing — Burning Man
(BRC map, BM ticket/pass flows, the BM disclaimer) is one event layer here, others
(e.g. UnSCruz) differ structurally; (4) per-camp/event/year **data**. The Math
Camp camp-theme and the Burning Man event layer live in this repo for now but
should peel out later — keep these seams clean and don't bake BM into the core. A
camp can attend multiple events.

## Locked decisions (don't re-litigate — see plan for full reasoning)

- **Private first: nothing publishes directly from CampTool** (plan decision
  #0). Camp data is for the camp. A new feature gets no public surface: no
  "share publicly" toggle, no unauthenticated read path, and don't design one
  to offer. Every loader/action goes through `requireActiveCamp` +
  `requireFeature`. The two public pages, `/c/:slug` (apply) and
  `/c/:slug/schedule` (the programming lineup), are the complete list, and both
  are gated on their feature being fully `on`, never `preview`. Extending
  either, or adding a third, needs the maintainer to ask for it.
- **Multi-camp aware schema, single deploy.** Every tenant-scoped table carries
  `camp_id`. Never assume a single camp anywhere.
- **SQLite + Drizzle** over `bun:sqlite`. Keep schema portable to Postgres.
- **better-auth** for auth: Discord + email/password + magic link + passkeys,
  org/roles plugin → admin/officer/member/recruit (hierarchy, high→low).
- **Discord = REST + interaction webhooks inside the web server.** No persistent
  gateway bot process unless a feature truly needs live events.
- **Everything env-driven** (`PUBLIC_BASE_URL`). No hardcoded hosts. The live
  site is https://camptool.org (see README → Deploy).

## Stack & conventions

Bun · React Router v7 (framework mode, SSR) · React 19 · Mantine · Drizzle ·
better-auth · Biome. TypeScript strict. Scripts: `bun run dev | build | start |
typecheck | lint | format`.

## Deploying

Pushing `master` deploys https://camptool.org: Cloudflare Workers Builds runs
`bun run cf:build`, applies the D1 migrations, then deploys the Worker. Ship
finished work without asking: once it's committed and verified (typecheck,
lint, test, `db:verify`, and browser-tested if it has a UI), push, check the
Workers Builds run succeeded, and confirm `https://camptool.org/_version`
returns the pushed SHA. A push isn't a deploy until `/_version` says so.

Ask first when the deploy itself carries risk: a schema migration (they apply
before the new Worker goes live, so anything but adding tables or columns
breaks the code still running), a change to data rather than code, or a
half-finished feature campers would see. When `master` carries other threads'
commits, name them in your report.

Live telemetry: token-gated `GET /api/dev/errors`, `/api/dev/nav` and
`/api/dev/feedback` (plus `POST /api/dev/feedback` to triage) on the live site,
authorized with the `DEV_API_TOKEN` secret as `Authorization: Bearer …`; the
gitignored `.env` holds `DEV_API_BASE_URL` and `DEV_API_TOKEN` for querying it.
Unset token → the endpoints 404.

## Local dev

- `.env`'s `PUBLIC_BASE_URL=https://camptool.isozilla.com` is not stale: it's a
  local HTTPS rig (public DNS → 127.0.0.1, a machine-local Caddy with a real
  certificate proxying to the dev server on :17923). Passkeys, `Secure`
  cookies and `isLocalDev` need a real origin, so don't repoint `.env` at
  localhost. When the name stops answering, a Caddy restart wiped its
  runtime-only route: restore it with the `caddy-local-proxy` skill (a Caddy
  change, so it needs per-change approval).
- Driving the app as a signed-in user, and scripting it with curl:
  `e2e/README.md`.

## Migrations (`bun run db:generate`)

- drizzle-kit's "is X a rename of Y?" prompt crashes without a TTY
  (`Interactive prompts require a TTY`). Don't create and drop tables in the
  same generate: migration N creates the new table (hand-append any
  `INSERT … SELECT` backfill), migration N+1 drops the old one.
- `db/migrations/meta/_journal.json` is shared. In a shared working tree it can
  hold another thread's entry whose `.sql` you aren't committing; staging it
  then fails CI's `db:verify` (`journal references db/migrations/<tag>.sql but
  the file does not exist`) while local `db:verify` passes. Before committing,
  diff the staged journal against `HEAD` and check every added `tag` has a
  `.sql` in the same commit. To drop a peer's entry without touching their
  working copy, build the journal from `HEAD` plus your entries, `git
  hash-object -w` it, and stage it with `git update-index --cacheinfo`.

## Current state

Phase 0 (scaffold) done: runnable shell, typecheck + build green. Next is
Phase 1 — Drizzle multi-camp schema → better-auth wiring → member directory.
Discord setup for self-hosters is documented in `docs/discord-setup.md`.
