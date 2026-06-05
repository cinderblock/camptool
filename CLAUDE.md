# CampTool — agent orientation

**Read `plans/camptool.md` first.** It is the living plan: vision, locked
decisions, schema sketch, phased roadmap, and progress log. Keep it current —
update it in the same turn you make a decision or hit a gotcha, and surface its
path in your responses.

## What this is

Self-hosted Burning Man theme-camp management web app. Built for one camp first,
open-sourced (MIT) so other camps can self-host. See `README.md`.

## Locked decisions (don't re-litigate — see plan for full reasoning)

- **Multi-camp aware schema, single deploy.** Every tenant-scoped table carries
  `camp_id`. Never assume a single camp anywhere.
- **SQLite + Drizzle** over `bun:sqlite`. Keep schema portable to Postgres.
- **better-auth** for auth: Discord + email/password + magic link + passkeys,
  org/roles plugin → admin/member/recruit.
- **Discord = REST + interaction webhooks inside the web server.** No persistent
  gateway bot process unless a feature truly needs live events.
- **Everything env-driven** (`PUBLIC_BASE_URL`). Localhost now;
  `tool.mathcamp.us` / `mathcamp.us` later. No hardcoded hosts.

## Stack & conventions

Bun · React Router v7 (framework mode, SSR) · React 19 · Mantine · Drizzle ·
better-auth · Biome. TypeScript strict. Scripts: `bun run dev | build | start |
typecheck | lint | format`. The `Gate Manager` project (sibling dir) is the
closest template for RR7+Bun+Mantine conventions.

## Current state

Phase 0 (scaffold) done: runnable shell, typecheck + build green. Next is
Phase 1 — Drizzle multi-camp schema → better-auth wiring → member directory.
Discord setup for self-hosters is documented in `docs/discord-setup.md`.
