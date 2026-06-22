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

- **Multi-camp aware schema, single deploy.** Every tenant-scoped table carries
  `camp_id`. Never assume a single camp anywhere.
- **SQLite + Drizzle** over `bun:sqlite`. Keep schema portable to Postgres.
- **better-auth** for auth: Discord + email/password + magic link + passkeys,
  org/roles plugin → admin/officer/member/recruit (hierarchy, high→low).
- **Discord = REST + interaction webhooks inside the web server.** No persistent
  gateway bot process unless a feature truly needs live events.
- **Everything env-driven** (`PUBLIC_BASE_URL`). Localhost now;
  `tool.mathcamp.us` / `mathcamp.us` later. No hardcoded hosts.

## Stack & conventions

Bun · React Router v7 (framework mode, SSR) · React 19 · Mantine · Drizzle ·
better-auth · Biome. TypeScript strict. Scripts: `bun run dev | build | start |
typecheck | lint | format`.

## Current state

Phase 0 (scaffold) done: runnable shell, typecheck + build green. Next is
Phase 1 — Drizzle multi-camp schema → better-auth wiring → member directory.
Discord setup for self-hosters is documented in `docs/discord-setup.md`.
