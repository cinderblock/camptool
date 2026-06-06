# CampTool

Self-hosted registration & management for Burning Man theme camps: member
management, a visual camp-map editor tied to the database, optional dues, camp
onboarding, shared documents, announcements, a public recruit page, and
Discord-based outreach. Built for one camp first; designed to be publishable for
other camps to self-host.

> Full vision, decisions, schema, and roadmap live in
> [`plans/camptool.md`](plans/camptool.md). Read it first.

## Stack

- **Runtime:** Bun
- **Framework:** React Router v7 (framework mode, SSR) + React 19
- **UI:** Mantine
- **Database:** SQLite via `bun:sqlite` + Drizzle ORM
- **Auth:** better-auth (Discord, email/password, magic link, passkeys)
- **Format/lint:** Biome

## Status

Phase 3 — camp map editor (in progress). On top of the Phase 1 foundation
(multi-camp data model; auth via email/password, magic link, passkeys, optional
Discord; member directory with role management) and Phase 2 recruiting (public
`/c/:slug` application page, officer review queue, per-member onboarding
checklists), the dashboard now has a **Map** tab: a visual, database-backed
editor for laying out camp. Set your lot (street, address, frontage × depth, and
an optional Man→street radius that draws the real wedge taper), then add
structures from a palette (tent, RV, shade, kitchen, art, generator, container)
and drag/resize/rotate them into place. Members and up can edit; recruits view.
Next in Phase 3: "highlight my spot", saved/shared block templates, Borg outline
import, and fire-lane/marker overlays.

## Develop

```sh
bun install
cp .env.example .env   # set PUBLIC_BASE_URL + BETTER_AUTH_SECRET; Discord optional
bun run dev            # http://localhost:3000
```

The SQLite database is created and migrated automatically on first start
(`DATABASE_PATH`, default `./data/camptool.db`). Auth works without Discord
credentials; setting `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` lights up the
Discord login and link features (see [`docs/discord-setup.md`](docs/discord-setup.md)).

Other scripts: `bun run typecheck`, `bun run build`, `bun run start`,
`bun run lint`, `bun run format`. Database: `bun run db:generate` (new
migration from schema changes), `bun run db:migrate`, `bun run db:studio`.

## Design notes

- **Multi-camp aware from day one:** every tenant-scoped table carries a
  `camp_id`, even though we run a single deployment now. Avoids a painful
  migration when cross-camp map sharing / multi-camp hosting arrives.
- **Discord without a gateway bot:** DMs and reminders are sent over the Discord
  REST API and slash commands use the interactions webhook — both live inside
  this web server, so the deployment stays a single "little webserver." A
  separate gateway process is only added if a feature needs live events.
