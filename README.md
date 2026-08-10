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
Discord; member directory with role management, officer-gated removal, and
private member-to-officer issue flags) and Phase 2 recruiting (public
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

For Burning Man specifically, the map can plan a **directional internet uplink**:
BMorg's public Wi-Fi comes off sector antennas on the NOC tower in Center Camp,
and a camp radio needs line of sight to it. Drop an **Uplink radio** on the
corner of an RV, container or shade frame, set its antenna height, and the map
draws the aim path to the NOC and flags anything of yours tall enough to block
it — so "which corner does the dish go on" is answered before you're on playa.

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
handles early-arrival **Setup Access Passes**: officers define "on or after"
dates with a per-date quota (e.g. 2 valid from Monday, 4 from Wednesday);
members request a pass (onboarding files the request automatically for anyone
arriving before gates open) and an officer grants each one a date that covers
the requester's planned arrival, quota-enforced. Both are scoped to the active
year and go read-only when that year is locked.

A **Schedule** organizes what the camp does together — work parties, meetings,
and daily service — with sign-ups. Each day of a gathering is split into
**shifts**: one job, on one day, that needs people. A gathering that repeats
daily can be given a whole **role template** at once (a prep crew, cutters, a
serving push, cleanup — each with its own hours and headcount), stamped across
every day in one action instead of one form submission per role per day;
re-applying it later only fills gaps, and editing a shift in place never
disturbs the people already signed up. What a shift *is* is explained on the
page rather than assumed, and a schedule that's switched on but still empty
hides itself from campers until there's something in it.

A **Spares board** is where campers post a spare ticket or vehicle pass, or ask
for one — asking price optional, with a way to mark it taken so nobody chases
something already gone. Ticket and vehicle pass are separate kinds throughout,
since people routinely have one and need the other. It is deliberately separate
from the camp's own ticket allocation, and the camp is not a party to the
arrangements.

A **Fuel** page records who's bringing what fuel, how much, and in what
containers, and rolls it up per type with container counts and a secondary-
containment tally — the numbers a fire-safety review actually needs. Gallons and
pounds are never added together, and the page flags when the camp has both
liquid fuel and propane, which need separating. Relatedly, an RV can be marked
as needing **pump-out / cleanout access**, which whoever lays out the map sees
alongside the existing "near my car" preference.

On **Supplies**, campers claim what's listed *and* add what they're bringing
that isn't — with matches from every group shown as they type, so nobody
discovers at the gate that six people brought whiskey and nobody brought ice.

The roster shows **when everyone is actually here**: arrivals per day and how
many people are on site each day, which is the number you need to pick a night
for a camp dinner.

An officer-only **Finances** page tracks the camp's money for the year — donations
in and spends out (with optional member, category, and date) — and shows running
totals (in / out / net balance). It's deliberately not shared with all campers,
and goes read-only when the year is locked.

A **Programming** page organizes what the camp offers the wider event — talks,
workshops, classes, performances. It runs as an open call: any camper proposes
something (title, blurb, kind, rough length) without needing to know the
schedule; officers accept or decline with a note, then give accepted items dates
and times. Scheduling *is* publishing, so nothing goes public without a time and
place. Presenters and co-presenters can be campers, their guests, or an outside
speaker credited by name only (who never lands on the roster or headcount). The
resulting lineup is served at `/c/<camp-slug>/schedule` as a public,
no-login page — the thing to put on a flyer or a QR code — while offerings
marked *camp only* stay internal.

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
bun run dev            # http://localhost:17923 (set PORT to change)
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

- **How joining works** (apply page vs. invite links, the onboarding wizard,
  and the question axes — audience/scope/surface/placement) is documented in
  [`docs/camp-lifecycle.md`](docs/camp-lifecycle.md).
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
- **Privacy mode is a screen-share convenience, not an access control.** Camp
  admins can flip a per-browser toggle that replaces every name, email, phone
  and Discord handle with deterministic pseudonyms, so the live instance can be
  demoed without building a fake dataset. Pseudonyms are seeded per word on the
  real value, so the same person reads the same everywhere, and names mentioned
  inside free-text notes are swapped too. It is deliberately **read-only** —
  a form pre-filled from pseudonymized data would otherwise save the pseudonym
  over the real record. It is *not* a permission tier: everyone who can turn it
  on could already see the real data. See
  [`plans/privacy-and-demo-mode.md`](plans/privacy-and-demo-mode.md).
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
