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

Phase 0 — scaffold. A runnable app shell (public landing + placeholder
dashboard). Auth, the multi-camp data model, and the member directory come next.

## Develop

```sh
bun install
cp .env.example .env   # fill in as phases require
bun run dev            # http://localhost:3000
```

Other scripts: `bun run typecheck`, `bun run build`, `bun run start`,
`bun run lint`, `bun run format`.

## Design notes

- **Multi-camp aware from day one:** every tenant-scoped table carries a
  `camp_id`, even though we run a single deployment now. Avoids a painful
  migration when cross-camp map sharing / multi-camp hosting arrives.
- **Discord without a gateway bot:** DMs and reminders are sent over the Discord
  REST API and slash commands use the interactions webhook — both live inside
  this web server, so the deployment stays a single "little webserver." A
  separate gateway process is only added if a feature needs live events.
