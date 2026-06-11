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
and drag/resize/rotate them into place, with an orientation compass (true north,
sun, the Man) and footprint shapes for tents, hexayurts, hyparhuts, cars/RVs.

It's also **inventory-driven**: campers declare what they're *bringing* on a
**Bringing** page (each item sized, unplaced); officers drag those items from an
**Unplaced** tray onto the lot to place them and add shared camp items; an
**Inventory** view accounts for everything (owner, size, placed-or-not).

The map carries a few more touches: recognizable top-down icons per kind, an
owner's first name on each domicile, a highlight filter (mine / domiciles /
vehicles / structures), a grid scale-and-skew caption in real feet-and-inches,
and **free-polygon zones** (fire lane, public/private areas). Editing is
ownership-aware: officers arrange the lot, while a camper can move/resize their
own item — those changes apply live but stay **pending** until an officer
approves or rejects them.

New campers get a guided, resumable **onboarding wizard** at `/start`: a
full-screen walkthrough to set a playa name, declare what they're bringing, add
who's sharing their tent/RV, and tick the camp's checklist — one step at a time,
with the regular dashboard pages remaining the "advanced" way to do the same
things. Next: RV pop-outs, custom per-camp structures, and group sub-maps.

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

## Deploy

Production runs under Bun and serves over a **unix socket** (no TCP port) so a
reverse proxy can terminate TLS in front of it. `bun run start` boots
`server.ts`, which binds the React Router handler to `$SOCKET_PATH` (default
`/run/camptool/camptool.sock`). The canonical deployment auto-deploys to firefly
on push to `master` (a self-hosted runner stages a release tree that an
in-container supervisor launches; Caddy proxies the public URL to the socket);
for self-hosting elsewhere, a `Dockerfile` + `compose.yaml` build the same socket
server into a container. Both are documented in
[`docs/firefly-deploy.md`](docs/firefly-deploy.md).

## Design notes

- **Multi-camp aware from day one:** every tenant-scoped table carries a
  `camp_id`, even though we run a single deployment now. Avoids a painful
  migration when cross-camp map sharing / multi-camp hosting arrives.
- **Discord without a gateway bot:** DMs and reminders are sent over the Discord
  REST API and slash commands use the interactions webhook — both live inside
  this web server, so the deployment stays a single "little webserver." A
  separate gateway process is only added if a feature needs live events.
