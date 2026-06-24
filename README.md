# CampTool

Self-hosted registration & management for event **theme camps**: member
management, a visual camp-map editor tied to the database, optional dues, camp
onboarding, shared documents, announcements, a public recruit page, and
Discord-based outreach. Built for one camp first; designed to be publishable for
other camps to self-host.

The core app is **event-agnostic**. Burning Man — its Black Rock City
map/addressing and ticket/pass flows — is one *event layer* on top, bundled in
this repo for now but designed to peel out; a single camp can attend multiple
events (see the four-layer architecture in the plan).

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
editor for laying out camp. The map/addressing is a pluggable **per-event
provider** (Black Rock City is the built-in one). Set your lot (street, address,
frontage × depth, and an optional Man→street radius that draws the real wedge
taper), then add
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
things. Next: RV pop-outs and group sub-maps.

The dashboard also tracks the camp's per-year ticket allocations (a Burning
Man–event feature today). A **Tickets** page manages the camp's Direct Group Sale
(guaranteed) allocation — individual
priced tickets (tier + price, any mix of free/cheap/expensive) that officers
assign to members and mark paid; members can request one. A **Passes** page
handles early-arrival **Setup Access Passes**: officers define entry dates with a
per-date quota (e.g. 2 Monday, 4 Tuesday, 8 Wednesday) and grant passes to
members; members request a date, and the quota is enforced. Both are scoped to
the active year and go read-only when that year is locked.

An officer-only **Finances** page tracks the camp's money for the year — donations
in and spends out (with optional member, category, and date) — and shows running
totals (in / out / net balance). It's deliberately not shared with all campers,
and goes read-only when the year is locked.

The deployment owner is a **super admin** (the first account to register; more
can be granted in-app) with a **Site admin** page that controls two
instance-wide lockdowns: turning off **new camp creation** (only super admins can
then create camps) and switching sign-ups to **invite-only** (new accounts can
then be created only by following a camp invite link or a camp's public apply
page — the bare login page won't offer signup). Super admins always bypass both.

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

- **Four layers (the app is not Burning-Man-specific):** (1) the **core app**
  framework — users, groups, the onboarding framework, post-event followups, the
  camp/edition/membership skeleton (this repo, event- and camp-agnostic); (2)
  **per-camp theming** — custom structures/questions/branding via the
  `camp-theme` contract; (3) **per-event theming + map/addressing** — events
  differ structurally (Burning Man's BRC annular-clock layout vs. others), so BRC
  geometry, BM ticket/pass flows, and the Burning Man disclaimer live here; (4)
  the **per-camp/event/year data** in the database. The Math Camp camp-theme and
  the Burning Man event layer are bundled in this repo for now but are designed to
  peel out into their own packages. One camp can attend multiple events.
- **Multi-camp aware from day one:** every tenant-scoped table carries a
  `camp_id`, even though we run a single deployment now. Avoids a painful
  migration when cross-camp map sharing / multi-camp hosting arrives.
- **Discord without a gateway bot:** DMs and reminders are sent over the Discord
  REST API and slash commands use the interactions webhook — both live inside
  this web server, so the deployment stays a single "little webserver." A
  separate gateway process is only added if a feature needs live events.
- **Per-deployment customization = a camp-theme package, not runtime config.** A
  self-hoster who wants bespoke map structures (or, later, UI overrides) adds a
  workspace package under `packages/` implementing the `@camptool/theme-contract`
  `CampTheme` and points `CAMP_THEME` at it (default → the built-in
  `@camptool/default-theme`). Core reads it through the single `~/theme` module;
  Vite swaps the active package in at build time. Custom map structures contribute
  a `CampStructure` (a palette kind with its own `renderFootprint`), so they slot
  into the map/legend/picker without ever bloating the shared open-source palette.
  `@camptool/mathcamp-theme` is the worked example (its **Sierpinski pyramid**
  landmark — a 3-level Sierpinski tetrahedron drawn as an honest 40′ top-down
  Sierpinski-triangle footprint).
- **Instance admin vs. camp admin:** super admin is the only deployment-wide
  role (stored in a `super_admin` side table, not on `user`, so per-camp identity
  stays clean). Its two toggles live in a singleton `instance_setting` row. The
  invite-only gate runs at better-auth's `user.create` hook so it covers every
  signup method; sanctioned pages (apply/invite) carry a short-lived signed
  cookie that the hook accepts. Note: because better-auth only runs its origin
  check on cookie-bearing requests, production must set `NODE_ENV=production` and
  a `PUBLIC_BASE_URL` matching the browser origin (the deploy env-file does).
