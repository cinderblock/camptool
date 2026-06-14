# CampTool — Burning Man Camp Registration & Management

> Living plan. Read this first at the start of any session. Keep it current.
> Plan path: `plans/camptool.md`

## Goal

A self-hosted web app for running a Burning Man theme camp: member management,
a visual camp-map editor tied to the database, dues/financials, onboarding,
shared docs, announcements, a public recruit page, and Discord-based outreach.
Built first for Cameron's camp, designed so it can later be published for other
camps to self-host or (eventually) run as multi-camp SaaS.

## Environment / context

- **Machine:** Windows 11, PowerShell default shell. Repo at
  `C:\Users\camer\git\Personal Projects\CampTool` (its own git repo; the parent
  `Personal Projects` is NOT a git repo).
- **Toolchain:** Bun 1.3.0, Node 24.11, git 2.45. No Docker confirmed.
- **Deployment URL:** localhost for now (dev + testing). Real domain comes later
  — likely `tool.mathcamp.us` or the apex `mathcamp.us`. All URLs are env-driven
  (`PUBLIC_BASE_URL`) so the host is a one-line change, no code edits.
- **Repo visibility:** public / open-source (MIT). Keep secrets out of git;
  treat all docs/code as publishable.

## Decisions already made (don't re-ask)

1. **Tenancy = multi-camp aware, single deploy.** Every tenant-scoped table
   carries `camp_id` from day one. We run ONE instance for our camp now, but the
   schema must never assume a single camp. Reason: the cross-camp neighborhood/
   block map sharing and "publish for other camps" goals would otherwise force a
   painful migration. Cross-camp *identity* (a user belonging to multiple camps)
   is in scope at the schema level.
2. **Database = SQLite + Drizzle** over `bun:sqlite`. Single file, trivial to
   back up/export (requirement #10), fine for this scale. Keep the Drizzle schema
   reasonably portable so a later Postgres move (if we go SaaS / want PostGIS) is
   low-friction. Don't lean on SQLite-only quirks without noting it here.
3. **Auth = better-auth.** TS-native, clean React Router integration. Use:
   Discord social provider, email/password, magic link, passkeys; org + roles
   plugin to model admin/officer/member/recruit. Reason: matches "lots of auth options"
   plus first-class Discord.
4. **First slice = Foundation:** auth + admin/officer/member/recruit roles + member
   directory + Discord account link. Everything else hangs off member identity.
5. **Stack (from the user's other projects, not re-asked):** Bun runtime, React
   Router v7 framework mode (SSR), React 19, Mantine UI, Biome or oxfmt for
   format/lint, Playwright for E2E, TypeScript strict. lefthook for git hooks.
6. **Addressing/map layout is a pluggable per-event provider** (analogous to the
   `camp-theme` contract in Phase 2.5). BRC is the built-in default; the seam
   exists so other events with different addressing schemes can slot in later.
   **Build only BRC now, behind the interface — no speculative second scheme.**
   The provider owns: (a) the enumerable address components (BRC = ordered annular
   streets + radial-avenue clock positions) so the UI offers **dropdowns, never
   free-text street entry**; (b) geometry (address ↔ world coords, the wedge/
   trapezoid math); (c) canonical formatting/validation.
7. **Street names are Borg-defined and rotate every year — never typed by a user.**
   A **"BRC Year" selection** picks the correct per-year street-name set. Stored
   camp addresses use the **structural key** (ring index + clock position, e.g.
   `{ring: 5, clock: "7:30"}`), and the **display name is resolved from the
   selected year's street table at render time**. Reason: the letter/ring position
   is stable ("E" is always the 5th ring) but the name and exact radii change
   yearly; storing the name as text would break every saved placement on a rename.
   Switching BRC Year then re-labels all placements automatically.

## Discord architecture decision

A theme-camp bot mostly needs to **send DMs/reminders** (requirement #9) and
maybe handle a few slash commands — NOT react to live message streams. So:

- **No persistent gateway bot process to start.** Sending DMs and messages is
  REST-only (Discord HTTP API), callable from inside the web server.
- **Slash commands / buttons** use Discord's **interactions webhook** endpoint,
  which is plain HTTP and lives as a route in the web app.
- Only add a separate long-running gateway process later if we need to react to
  events we can't get via webhooks (e.g., presence, message reactions). Noted as
  a future "apps/bot" workspace if needed.

This keeps the deployment a single "little webserver," matching the ask.

## Proposed structure

Start as a single React Router 7 app (simplest deploy). Internal layout:

```
CampTool/
  app/                # React Router routes, components, UI
    routes/
    components/
    lib/              # server utilities (auth, discord, etc.)
  db/                 # Drizzle schema, client, migrations
    schema/
    migrations/
  public/
  plans/camptool.md   # this file
```

If the bot or a heavy 3D-render worker grows, split into Bun workspaces
(`apps/web`, `apps/bot`, `packages/db`, `packages/core`) — `db/` is already
isolated to make that extraction cheap. (Future step, not now.)

## Data model sketch (multi-camp from day one)

Foundation tables (better-auth owns several user/session tables; we add ours):

- `camp` — id, slug, name, settings, created_at. The tenant root.
- `user` — global identity (better-auth). One human, may belong to many camps.
- `account`, `session`, `verification` — better-auth managed.
- `membership` — (user_id, **camp_id**, role: admin|officer|member|recruit,
  status, playa_name, joined_at). The join table that scopes a user into a camp
  with a role. This is the core of requirement #1. Role hierarchy high→low is
  admin > officer > member > recruit; `officer` is an elevated-but-not-full-admin
  tier (e.g. can help run onboarding/dues/announcements) — model it so permission
  checks compare rank, not just equality.
- `discord_link` — user_id, discord_user_id, discord_username, guild_member?(per
  camp). Lets us DM them and verify they're in the server.

Later phases add (all `camp_id`-scoped): `placement`/`map_object`,
`block_template` (shared vs camp-owned), `dues_account`/`transaction`,
`document`, `announcement`, `recruit_application`, `onboarding_task`,
`import_batch`.

## Roadmap (phased)

**Phase 0 — Scaffold** (in progress)
- git init; React Router 7 + Bun + Mantine + Biome + lefthook; bun install +
  typecheck green. App shell with public landing + placeholder dashboard.

**Phase 1 — Foundation (first slice)**
- Drizzle SQLite schema: camp, membership, discord_link (+ better-auth tables).
- better-auth: Discord + email/password + magic link + passkeys; roles.
- Member directory; admin role management (recruit→member→officer→admin); recruit intake.
- "Are you in our Discord?" check + account link.

**Phase 2 — Public recruit page (#7, #4)**
- Public camp page (`/c/:slug`, no auth) + recruit application funnel feeding
  `recruit_application`.
- Admin/officer review queue: accept (→ recruit membership if the applicant has
  an account, else a better-auth invitation), reject, waitlist.
- Onboarding checklist: camp defines `onboarding_task` rows; accepted members
  tick them off (`onboarding_completion`, one row per membership×task).

**Phase 2.5 — Theming & extensibility (locked direction: self-host = deep code)**
- Per-camp UI customization is **build-time, per-deployment**, not templates and
  not runtime-loaded code (the latter is unsafe in a shared multi-tenant SSR
  process). A self-hoster adds a `camp-theme/` Bun workspace package (or git
  submodule) and points one config value at it (`CAMP_THEME`, default →
  built-in `@camptool/default-theme`).
- The theme package implements one typed contract:
  `{ mantineTheme, slots, routes?, rootProvider? }`. `slots` is a map of named
  React components overriding defaults; core UI renders customizable regions as
  `<Slot name="header">{<DefaultHeader/>}</Slot>` so a camp overrides only what
  it wants and upstream upgrades stay non-breaking. Core imports everything
  through a single `~/theme` alias resolving to the active package.
- Does NOT touch the multi-camp invariant: a single instance can still host many
  camps' *data*; the code-level theme is per-deployment. A shared/SaaS instance
  ships no `camp-theme` package and gets the data-driven default.

**Phase 3 — Camp map editor (#2)** — IN PROGRESS (built by a parallel thread;
not yet independently verified end-to-end by this thread). What exists:

- **BRC geometry/addressing layer** (`app/lib/brc.ts`) — realizes decisions
  #6/#7: per-year `CityGeometry`, stable street `code`s, dropdown options (no
  free text), clock parsing, derived frontage radius, map-up compass bearing.
  Geometry math validated against the BMorg checkpoints (see reference section).
  NOTE: the seam is BRC-specific in `brc.ts`, not yet a generalized
  EventLayoutProvider interface — the "other events" abstraction (decision #6) is
  still latent; extract the interface when a second event scheme actually lands.
- **Map schema** (`db/schema/map.ts`, all `camp_id`- and `edition_id`-scoped):
  - `placement` — the camp's lot wedge; one per edition. City anchoring via
    `streetLetter`(stable) + `placement_year` + `street`(per-year name) +
    `address`(free clock). `frontsToMan` flips taper + compass; `frontageFt`/
    `depthFt`; `innerRadiusFt` is a manual radius override for odd lots
    (null + no derivable street → plain rectangle, no taper).
  - `map_object` — structures placed in **plot-local feet** (origin = front-left
    of the lot, +x along frontage, +y into the lot), so internal layout is
    independent of where the lot lands each year. Carries `kind`,
    `ownerMembershipId` (null = communal), a `placed` flag (unplaced items sit in
    an officer queue), and a **pending-approval workflow** (`pendingAt`/
    `pendingByMembershipId`/`pendingPrev` JSON snapshot) so a member can move/
    resize their own item live-but-flagged until an officer approves/reverts.
  - `map_object_occupant` — second+ campers sharing a tent/RV/car.
  - `map_zone` — labeled polygons (fire/public/private/custom) as plot-local
    JSON point arrays.
- **Editor UI** (`app/routes/dashboard/map.tsx`, ~2.9k lines) + **structures
  palette** (`app/lib/structures.tsx`: `KINDS`/`KIND_GROUPS`, container sizes,
  hex helpers, kind colors/icons/tags).
- Still open / to verify: Borg outline import; saved/premade shared blocks;
  "highlight my spot" share link; solar/shade + 3D render (stretch); cross-camp
  neighborhood sharing (stretch). Confirm the editor runs + golden path works.

*MVP increment shipped:* `placement` (one BRC lot per camp) + `map_object`
(structures in plot-local feet) schema; `/dashboard/map` SVG editor — drag-drop
legend palette, drag to move, corner-handle resize, top-dot rotate, keyboard
shortcuts (R rotate, arrows nudge, Del, Esc), side panel for name/kind/size/
rotation/notes + delete, lot-setup form (street, address, frontage, depth,
optional inner-radius → wedge taper). Skewed 10ft grid (50ft emphasis). Side-rail
layout with size-capped map. Orientation compass (true north + daylight wedge +
Man glyph, from clock address). Predefined footprint shapes: tent, **hexayurt**
(fixed regular hexagon, 8ft edges), **hyparhut** (fixed 8ft square, hypar roof
gradient), car/truck (rigid), RV (fixed width + numeric length), shade, kitchen,
art, generator, container. Members+ edit; recruits view-only.

*Two locked design directions (not yet built):*
- **Custom per-camp structures = camp package, NOT the shared app.** A camp's
  bespoke footprints (their specific shade structure, art car, etc.) are
  registered by the per-deployment **camp package** from Phase 2.5 (`CAMP_THEME`/
  camp-theme workspace package), which contributes extra `kinds` (value/label/
  color/shape/size/rigid) into the palette registry the core reads. The open-
  source app ships only the generic palette; custom kinds live in the self-
  hoster's own package so they never bloat or fork the shared codebase. Needs a
  small refactor: move `KINDS` behind a registry the camp package can extend.
**Phase 3.5 — Inventory-driven placement (locked direction).** Supersedes the
earlier "assign campers to objects" / "relationship graph" idea.
- **Registration collects an inventory.** Each camper declares what they're
  *bringing* — car / tent (with door) / shade / RV / etc., each at real size, with
  **no location**. A camper can add a second+ person (occupant) to their
  tent/car/RV.
- **`map_object` is the unit for both states.** Add `ownerMembershipId` (NULL =
  camp/shared item) and `placed` (boolean). Declared items start *unplaced* (no
  position, in an officer queue); placed items have x/y/rotation on the map.
  Occupants → a `map_object_occupant` join (objectId × membershipId).
- **Officers place everything** — members' items + communal items (kitchen,
  communal shade, generators, fuel area, …) — and arrange orientations. Officers
  add shared items (ownerMembershipId NULL).
- **List/accounting view:** every declared item (owner, kind, size, occupants,
  placed-or-not) so nothing is missed.
- **Mini-maps = scoped views** of the one shared map; objects carry absolute lot
  coords, so group/sub-views compose for free (no separate coordinate systems).
- **Group membership = self-request + officer-confirm** (captures "who do you want
  to be near").

**City-geometry automation (landed).** The lot setup is now BRC-aware instead of
free-text. `app/lib/brc.ts` models city geometry **per year** (2025 seeded): a
street's *letter* is stable across years (Atwood = A …) while its *name* and exact
radii shift, so you pick **year + street letter** and the frontage radius is
derived (2025 table reconstructed parametrically from BMorg block depths + street
widths; reproduces every validated radius + the Kilgore checksum). Clock address
is an autocomplete that suggests 15-min marks but accepts off-grid values (3:14
for Math Camp). A **Man-vs-mountain frontage** checkbox flips the taper direction
(widen outward vs narrow inward) and the compass (+180°). `placement` gained
`street_letter` / `placement_year` / `fronts_to_man` (migration 0006);
`inner_radius_ft` is now a manual *override* of the derived radius. Add later
years' geometry to `CITY_GEOMETRY` as BMorg publishes each doc.

Still TODO: "highlight my spot", RV pop-outs (+ generator/cleanout markers),
off-center doors, premade/shared blocks, Borg outline import, fire-lane/marker
overlays, true radial placement of objects, 3D/sun-shade.

**Irregular / non-rectilinear plots (deferred sub-phase).** Camps near keyholes,
plazas, Center Camp, and other odd spots aren't a frontage×depth rectangle — they
need a real **polygon** lot model (an editable vertex list) instead of (frontage,
depth, taper). **Locked requirement: when drawing/editing an irregular plot's
outline, vertices snap to the 10ft grid** (same grid objects use). Not built yet;
the current rectangle+taper model stays the default.

**Per-year "edition" is a PRIMARY axis (locked direction; foundational, not a map
sub-feature).** Per the user: per-year configuration *permeates everything* — e.g.
a camper brings a van one year, a van + tent the next. So alongside `camp_id`,
most tenant-scoped data carries an **edition** scope = (camp, event year). The map
versioning notes below are just one instance of this larger axis. Model sketch
(forks still open — see below): a first-class `camp_edition` row (id, camp_id,
year, label, lock/status, optional theme/dates/dues, optional `forked_from_id`),
and edition-scoped tables (map/placement, the "bringing" inventory =
`map_object` + occupants, dues, onboarding, recruit applications) carry
`edition_id`. The "active edition" joins "active camp" in session context, with an
edition switcher + lock indicator in the UI. Import across editions/years =
**copy** rows (snapshot, never a live link). Lock = freeze read-only.

Open forks to settle before building (don't pre-lock):
1. **Year axis = global BRC year, or per-camp `camp_edition`?** Lean per-camp
   edition, since lock state / theme / dues / "who's coming" are per-camp-per-year;
   the BRC year is then just an attribute (and the key into `brc.ts` geometry).
2. **Does membership/role become year-scoped, or stay camp-stable with a separate
   per-year participation record?** Lean: identity+role stays camp-scoped (you're a
   Math Camp officer), and a per-year *participation* row carries attendance / dues
   / what-they're-bringing.
3. **First-cut scope:** which tables get editioned now vs later.

What stays global (NOT edition-scoped): `user` (a human), `camp` (the org + slug),
`brc.ts` city geometry (reference data, already per-year).

This is a foundational refactor (touches session context + the core map/inventory
tables + every loader/action that reads them), so it gets a dedicated design pass
before code. Best done NOW while there's almost no real data to migrate.

**Locked decisions (from the user):** (a) per-camp `camp_edition` entity, NOT a
global year; (b) membership/role stays camp-scoped, a separate per-year
*participation* row will carry attendance/dues/bringing (participation table
deferred until a feature needs it); (c) build incrementally now.

**Build status — foundation landed (NOT yet wired or applied):**
- [x] `camp_edition` table (camp_id, year, label, locked, forked_from_id, unique
      camp+year) in `db/schema/camp.ts`. Nullable `edition_id` FK added to
      `placement` / `map_object` / `map_object_occupant`; placement unique index
      moved camp_id → edition_id. **Migration 0007** + appended backfill DML (one
      edition per existing camp, year = its placement_year else **2026** — the
      current event year; links all existing map rows). Verified on a VACUUM copy
      of the live DB: 1 edition/camp @ 2026, every placement (2) + map_object (30)
      linked, zero dangling FKs.
- [x] `brc.ts` is now event-year aware: `CURRENT_EVENT_YEAR = 2026`, year pickers
      offer 2023–2027 (not just geometry years), and `radiusForStreet` /
      `streetLabel` **fall back to the latest year we have measurements for** (2025)
      when the selected year's BMorg doc isn't loaded — the lot form flags when it's
      using a fallback layout. Add real 2026 measurements to `CITY_GEOMETRY` when
      BMorg publishes them (or the user provides the doc).
- [x] Active-edition session context: `resolveActiveCamp` now also returns
      `editions` + `activeEdition` (from a `camptool_edition` cookie, default =
      newest; cookie validated against the active camp). Helpers
      `loadCampEditions`, `setEditionCookie`.
- [x] **Wiring (done).** `/dashboard/editions` page (loader + action) handles
      set-active (any member), create (+ optional copy-from = deep-copy lot +
      objects + occupants into the new year), and lock/unlock (officer+).
      `requireActiveEdition` helper redirects to the editions page when a camp has
      no edition. Dashboard header gained a **year switcher** (fetcher → setActive,
      revalidates in place) + a **locked** badge, and a "Years" nav link.
      `map.tsx` / `bringing.tsx` / `inventory.tsx` loaders + actions now filter and
      insert by `activeEdition.id`, and **a locked edition is read-only** (member
      edit + officer actions gated on `!locked`). typecheck + build + biome green.

**APPLIED + BROWSER-TESTED (2026-06-07).** Restarted the dev server → migration
0007 applied to the live DB (camp_edition populated, every camp backfilled @ 2026,
placements + map_objects linked, no dangling FKs). Full E2E on
`https://camptool.isozilla.com` as a fresh admin (Ed Admin / Edition Test Camp):
fresh camp had no edition → Years page; created 2026 (auto-active, header switcher
+ LOCKED badge appeared); added a Van to 2026; created 2027 **copy-from 2026** →
Van deep-copied in; added a Tent to 2027; switched header to 2026 → showed **only
the Van** (per-year independence + snapshot-not-link confirmed); locked 2026 →
add blocked server-side AND the Bringing page now shows a read-only notice with
controls hidden. Also confirmed: **6-char password** accepted (new minPasswordLength),
and the dynamic **current-year default** (2026).

Dev-server dep-optimizer error — FIXED. Root cause: kysely 0.29.2 dropped the
`DEFAULT_MIGRATION_LOCK_TABLE` / `DEFAULT_MIGRATION_TABLE` exports that the
optional `@better-auth/kysely-adapter` still imports; Vite tried to prebundle it
even though we use the Drizzle adapter and never touch Kysely. Fix:
`optimizeDeps.exclude: ["@better-auth/kysely-adapter", "kysely"]` in
`vite.config.ts`. After clearing `node_modules/.vite` and restarting, the error is
gone (verified: server log clean, login + dashboard render/hydrate with no console
errors). Note: clearing the dep cache causes a one-time transient React
"useContext null" on the very first cold load that self-heals on the auto-reload.

Test-data cleanup (2026-06-07) — DONE. Backed up the live DB to
`data/camptool.pre-cleanup.db` (VACUUM INTO), then deleted every camp except
**Math Camp @ Group W** and every user except **cameron@tacklind.com** (FK
cascades cleared their memberships/editions/map rows). End state: 1 camp, 1 user,
its 2026 edition, 0 placements/objects (Math Camp's map was never set up). The
pre-cleanup backup can be deleted once you're satisfied.

### Map versioning — year scope + tags + lock (an instance of the edition axis)

The map is not a single living document; it's a series of versions. **Naming:
the entity that landed is `camp_edition` (NOT a separate `map_version`) — there is
ONE versioning entity, the edition. Don't design a duplicate table.**

**LANDED — per-year scope.** A year's map is independent; editing the current year
does not mutate last year's. This shipped as `camp_edition` (`db/schema/camp.ts`)
with `edition_id` on every map table (`db/schema/map.ts`): `placement` carries
`edition_id` with `uniqueIndex("placement_edition").on(editionId)` (one lot per
edition, NOT per camp), and `map_object` / `map_object_occupant` / `map_zone` /
`map_cable` all carry `edition_id` alongside `camp_id`. Past editions can be
**locked** (read-only) and remain an **import source** — creating an edition
copy-from another deep-copies its lot + objects + occupants (snapshot, never a
live link). See "Per-year edition is a PRIMARY axis" above for the full landed
state. The earlier "`map_version` / `map_version_id`" proposal here is **superseded
by `camp_edition` / `edition_id`** — same idea, the name that won.

**STILL OPEN — tagged snapshots *within* one year.** The edition axis gives
per-year independence, but not yet multiple labeled snapshots inside a single year:
a *planned* version (laid out before playa) vs an *as-built* version (what actually
happened), plus mid-event moves. Options when built: a `label`/`tag` on a
finer-grained snapshot under an edition, or multiple editions per year distinguished
by label. **Open question:** does locking a snapshot happen automatically
(auto-snapshot "planned" on a departure date) or only manually? Design before building.

## Ticketing — Directed Group Sale tickets + Setup Access Passes (LANDED + browser-tested 2026-06-11)

Per-year allocations a camp distributes to members, scoped to `camp_edition`
(both `camp_id` + `edition_id`, read-only when the edition is locked). Task plan:
`C:\Users\camer\.claude\plans\cozy-singing-tulip.md`.

**User-locked decisions (Q&A):** (a) tickets are **individual priced rows** (tier
label + price-in-cents + assignee), bulk-added by officers — any mix of
free/cheap/expensive, each uniquely assignable; (b) flow is **member-request →
officer-approve** for both tickets and passes, and **recruits may request too**
(requesting/viewing is recruit+, management is officer+); (c) tickets carry a
status lifecycle `available → assigned → paid`; (d) passes use **real calendar
dates + a per-date quota** the camp received.

**Schema — `db/schema/ticket.ts`, migration 0013** (4 tables, all `camp_id` +
`edition_id`; money = integer `price_cents`, nullable):
- `ticket` — tier, priceCents, assignedMembershipId, status, notes. Index on edition.
- `ticket_request` — membershipId, note, status (`pending|approved|denied`),
  resolvedTicketId + resolvedBy/At. The member's ask, unbound to a specific ticket
  until an officer assigns one.
- `setup_pass_date` — date (`YYYY-MM-DD`) + optional label + quota cap. Unique
  (edition, date).
- `setup_pass` — passDateId + membershipId + status (`requested|granted|denied`);
  **request + grant unified in one row** (quota counts only `granted`). Unique
  (passDateId, membershipId) so a member can't double up on a date.
- Migration 0013 verified to apply on a VACUUM-free copy of the live DB (all four
  tables created); applied to the live DB on next dev-server restart (the migrator
  in `db/client.server.ts` runs on startup — `db:migrate` still doesn't work here).

**Routes/UI** (`app/routes/dashboard/tickets.tsx`, `passes.tsx`; wired in
`routes.ts`; nav links added to `layout.tsx`, visible recruit+). Each route is one
file split by role (member self-service card + officer management), matching
`bringing.tsx`/`inventory.tsx`. Gating via `requireActiveEdition` +
`hasAtLeast(role,"officer")`; every mutation 403s when `activeEdition.locked`.
- **Tickets:** members see their assigned tickets + can request (one pending at a
  time) / cancel. Officers: bulk-add (tier/price/count), inline edit price+tier,
  assign via member Select (auto-resolves that member's pending request),
  unassign, mark paid/unpay, delete; pending-requests queue (deny); summary
  counts + $ collected/outstanding.
- **Passes:** members request an open date / cancel; see their passes + status.
  Officers: add dates (`@mantine/dates` DateInput) with quota, inline-edit quota,
  grant to a member (quota-enforced), revoke, delete date (blocked while granted
  passes exist); pending-requests queue (grant/deny, quota-enforced).

typecheck + build + biome green.

**BROWSER-TESTED end-to-end (2026-06-11)** in Chrome as a fresh admin (Tess
Tickets / "Ticket Test Camp", 2026 edition). Tickets: bulk-added 3 Standard @
$575; requested as a member → pending queue; assigned one via the member Select →
**pending request auto-resolved**, "Your tickets" flipped to ASSIGNED, outstanding
$575.00; marked paid → PAID, collected $575.00. Passes: added Mon Jun 8 via the
DateInput calendar; requested it → pending; **set quota 0 then Grant → server 409
"That date is at its quota"** (enforcement confirmed); raised quota → granted
(remaining decremented); revoked → returned to pool. Locked 2026 on the Years page
→ both pages went **read-only** (notice shown, all inputs/forms/actions hidden,
table plain text); unlocked again. No console errors.

**Two fixes made during testing:**
1. Aggregate $ totals (collected/outstanding) used the per-ticket `usd()` which
   renders 0 as "Free" — wrong for a money total. Added a plain `dollars()`
   formatter for the summary stats (0 → "$0.00"); `usd()` still shows "Free" for an
   individual free ticket.
2. `@mantine/dates` DateInput crashed the first time its popover opened on a cold
   dev dep-cache (`useMantineTheme` → `useContext` null: Vite optimized the dep
   on-demand and briefly served it a second React instance). Fixed by adding
   `@mantine/dates` + `dayjs` to `optimizeDeps.include` in `vite.config.ts` so it's
   pre-bundled. Production builds were never affected (everything bundles together
   at build time). Verified: cold-restarted the dev server and the calendar opens
   with no crash. **Note:** editing `vite.config.ts` makes Vite restart the dev
   server (brief downtime + dep re-optimization).

Future: payment integration, reminder DMs for unpaid/upcoming (Phase 5), ticket
transfer, first-class tier definitions.

**Phase 4 — Operations**
- Dues/financials with per-field view/edit permissions (#3).
- Shared documents (#5); announcements (#6).

**Phase 5 — Data lifecycle**
- Import last year's data (#8); exportable database (#10).
- Discord/email reminder campaigns + scheduled DMs (#9).

## BRC city geometry reference (for the map editor, Phase 3)

Black Rock City is concentric arcs centered on the Man, so every camp is a
**radial wedge**, not a rectangle — the edge nearer the Man is shorter than the
edge farther out. The map editor will need real placement geometry, so capture
the canonical numbers here.

**Source — 2025 BRC Measurements** (BMorg, dated 3.5.2025):
`https://bm-innovate.s3.amazonaws.com/2025/2025%20BRC%20Measurements.doc.pdf`
A local copy of the page-1 text is the basis for the table below. These figures
are **per-year** — BMorg republishes a measurements doc each year and the layout
does shift (street count, block depths, plaza radii, mid-city double-block
placement). Before trusting these for a given year, pull that year's doc from
`bm-innovate.s3.amazonaws.com/<year>/` (or the placement page) and diff against
2025. Year-over-year comparison tells us whether our camp's trapezoid changes.

**Key 2025 constants:**
- Esplanade center = 2,500′ from the Man.
- Block depths (Man → outward): Esplanade→Atwood 400′; Atwood→Ishiguro 250′ each;
  Ishiguro→Kilgore 150′ each. **Mid-city double block Ellison→Farmer = 450′.**
- Annular (lettered) streets 30′ wide, except Esplanade & Ellison 40′, Kilgore 50′.
- Radial avenues 40′ wide. Outer road Kilgore = 11,510′ diameter.

**Derived street-center radii** (block depth + adjacent street half-widths;
validated against two independent doc data points):

| Street | Center radius from Man |
|---|---|
| Esplanade | 2,500′ |
| Atwood (A) | 2,935′ |
| Bradbury (B) | 3,215′ ✓ (doc: plazas "centered 3215′") |
| C | 3,495′ |
| D | 3,775′ |
| **Ellison (E)** | **≈ 4,060′** |
| Farmer (F) | 4,545′ |
| Gibson (G) | 4,825′ ✓ (doc: mid-city plazas "centered 4,825′") |

**Per-year dataset ("mini database" of street names) — IMPLEMENTED in
`app/lib/brc.ts`** (client-safe; the single source of truth — don't duplicate the
table here). It models geometry per year as `CityGeometry { year,
esplanadeCenterFt, streets: StreetDef[] }`, where `StreetDef` carries a **stable
`code`** ("esplanade" or letter "A".."K"/"L"), a per-year cosmetic `name` (""
when unknown), `widthFt`, and `blockBeforeFt`. Street-center radii are computed
parametrically (`centersOf`) from block depths + half street-widths, reproducing
every validated checkpoint (A 2935, B 3215, E 4060, F 4545, G 4825, K 5755 →
11,510′ dia). Helpers: `radiusForStreet`, `streetOptions`/`streetLabel` (dropdown
source, no free text), `clockOptions`/`parseClock`, `mapUpBearingFor`, plus
`geometryYearFor`/`hasGeometry` which fall back to the nearest year we have when a
given year's doc isn't loaded.

Only **2025** geometry is loaded (`CITY_2025`). **2026 street NAMES are now in**
`STREET_NAMES_BY_YEAR` (user-provided: Ararat, Bodhi, Chomolungma, Delphi,
Eternal, Fulcrum, Great Oak, Heiau, Iroko, Jiba, Kundalini = A–K). Names are
**per-year** and announced before the measurements doc, so they live in a map
**decoupled from `CITY_GEOMETRY`**: `streetLabel` prefers the requested year's
names, while radii for 2026 still **fall back to 2025** (`hasGeometry(2026)` =
false, so the lot form keeps flagging the provisional layout). When BMorg
publishes 2026 measurements, add a `CityGeometry` to `CITY_GEOMETRY`. The 2025
C/D/H/J names remain blank. Don't fabricate names/geometry we don't have.

**Trapezoid formula.** For a camp fronting a street at inner radius `r` with
frontage arc `f` and radial depth `d`, the far (service-alley) edge is longer by
`Δ = d × f / r = (f·d)/r`. Side walls are radial lines toward the Man.

**Our camp (Math Camp @ Group W, fronting E/Ellison, 100′ frontage × 200′ deep,
toward the Man = inner/short side):** Δ = (100 × 200)/4,060 ≈ **4.9′**. So the
frontage ≈ 100′ and the rear/service-alley edge ≈ **105′**; a ~1.4° wedge. The
200′ depth + 20′ shared service alley is the back-to-back arrangement inside the
450′ Ellison→Farmer mid-city double block.

## Fire-lane determination (current Borg outline)

Our 200′ depth trips the "depth > 125′ from frontage" fire-lane trigger, but the
rule is really about **reach**: a lane may dead-end as long as fire hose reaches
125′ to every camp border. We have access on two opposite edges — E-street
frontage (covers depth 0–125′) and the rear 20′ shared service alley (covers
75–200′) — which overlap and cover the whole depth, so **no internal fire lane is
required**. Caveats to confirm with Placement: the shared alley must count as
fire access (unobstructed, no sharp turns, 20′ curve on 90° turns, straight truck
path out), and interior structures must not block hose routing. Independent
triggers still apply if we join the BRC Fuel Program, need OSS water/pumpouts, or
place a generator/fuel tank >20′ from the street. (Source: BMorg camp-layouts
placement page.)

## Findings / gotchas

- **Second tenancy axis: `camp_edition` (per camp, per year).** Introduced with
  the map editor (`db/schema/camp.ts`). A camp has one edition per `(camp_id,
  year)`; editions are independently editable, **lockable** (read-only once a year
  is on playa / in the past), and carry a `copiedFromId` so a new edition can be
  seeded from a prior one (import = snapshot, not a live link). Map rows
  (`placement`, `map_object`, `map_zone`, occupants) scope to **both** `camp_id`
  (the hard multi-camp invariant) AND `edition_id` (the operative year scope).
  `requireActiveEdition` (session.server) resolves the working edition. Implication
  for future work: anything year-scoped (dues, inventory, rosters) likely wants an
  `edition_id`, not just `camp_id` — check before adding a new tenant table.
- **better-auth 1.6.14** is the version we built Phase 1 on. Pin awareness: the
  passkey plugin is a SEPARATE package (`@better-auth/passkey` +
  `@better-auth/passkey/client`) in 1.6.x — it is NOT in `better-auth/plugins`.
  `organization`, `magicLink` are in `better-auth/plugins`; `createAccessControl`
  is in `better-auth/plugins/access`; `drizzleAdapter` is in
  `better-auth/adapters/drizzle`.
- **Org plugin IS our camp/membership spine.** Resolved the apparent tension
  between "use the org/roles plugin" and the explicit `membership(user_id,
  camp_id, …)` column spec: the organization plugin is mapped via
  `schema: { organization: { modelName: "camp" }, member: { modelName:
  "membership", additionalFields: { playaName, status, joinedAt } } }`. So `camp`
  = better-auth organization, `membership` = better-auth member, `invitation` =
  org invitation. No redundant second membership table.
- **SQL column names are free; JS keys are load-bearing.** Verified by reading
  the drizzle-adapter source: it does `schema[model]` (export key = model name)
  and `schemaModel[fieldName]` (JS property key = better-auth field name). The
  string passed to the column builder (the SQL column name) is never used by the
  adapter. So we use **snake_case SQL columns** (Postgres-idiomatic, portable)
  while JS keys match better-auth's field names. This lets the membership tenant
  FK be the literal SQL column **`camp_id`** (honoring the hard invariant) while
  the better-auth field stays `organizationId` (so the plugin works unmodified).
- **db.query needs the schema.** The adapter uses `db.query[model]`, so the
  drizzle client must be created as `drizzle(client, { schema })` with export
  keys exactly: user, session, account, verification, passkey, camp, membership,
  invitation.
- **SQLite type modes the adapter expects:** booleans → `integer({mode:
  "boolean"})`, all timestamps → `integer({mode: "timestamp_ms"})` (epoch ms).
  Don't use text/seconds or the adapter reads garbage.
- **`creatorRole` must be one of our roles.** Org plugin defaults `creatorRole`
  to `"owner"`, which we don't have. Set it to `"admin"` so creating a camp
  assigns the creator the admin role.
- **Role hierarchy is ours, not better-auth's.** better-auth roles are
  permission sets, not ranked. We keep a `ROLE_RANK` map (admin 3 > officer 2 >
  member 1 > recruit 0) in `permissions.ts` and compare rank for "at least"
  checks; access-control statements gate specific actions.
- **The `invitation` table needs `created_at`.** better-auth's org plugin reads
  a `createdAt` field on the invitation model; without it, `createInvitation`
  throws at runtime (typecheck won't catch it). Latent since Phase 1 because the
  member-directory only used `addMember`. Phase 2 accept-by-invitation surfaced
  it. Migration 0002 adds it via a **table rebuild**, not `ALTER ADD COLUMN`,
  because SQLite refuses a NOT NULL add with a non-constant default
  (`(unixepoch()*1000)`). The expression default is only legal inside
  `CREATE TABLE`.
- **`bun run db:migrate` (drizzle-kit) does NOT work here.** drizzle-kit needs a
  node SQLite driver (`better-sqlite3`/`@libsql/client`) we don't install.
  Migrations apply on app startup via the `drizzle-orm/bun-sqlite` migrator in
  `db/client.server.ts`. Use `db:generate` to author migrations; restart the app
  (or the dev server) to apply them. Don't rely on `db:migrate`.
- **"/dashboard redirects to /login" was NOT a code bug.** Reproduced the full
  flow over HTTP (signup → `Set-Cookie better-auth.session_token` →
  `GET /dashboard` returns 200; `get-session` returns the session) — the loader
  chain (`requireUser`/`resolveActiveCamp`) honors the cookie correctly, even for
  a brand-new user with no camp (they get the "Create your camp" screen, not a
  redirect). The redirect happens only when the server sees no valid session
  cookie. Root cause is environmental: a **stale session cookie** in the browser
  from earlier dev-server churn (DB recreated / different process), or the user
  browsing a **different origin/port than the running server**. Fix for the user:
  ensure one dev server is up on the origin they're visiting, clear CampTool
  cookies, sign up fresh.
  **Resolved properly:** in `auth.server.ts`, set `advanced.cookiePrefix:
  "camptool"` **only on localhost dev** (gated by `isLocalDev`), so dev cookies are
  `camptool.session_token`. localhost cookies are host-scoped (not port-scoped), so
  the default name collides with every other better-auth app on the dev box; a
  unique prefix means a foreign/stale token can't be mistaken for ours. In
  production each deployment owns its domain, so the default `better-auth.*` name is
  already isolated — no prefix there. Old dev `better-auth.*` cookies are now
  ignored; a fresh login overwrites the namespaced one, no DevTools cleanup needed.
- **Concurrent dev servers + dual-stack localhost cause confusing 404s.** With
  another agent's `react-router dev` already on `[::1]:3000`, starting a second
  on `127.0.0.1:3000` makes `localhost` curls alternate between two servers
  (one warming up → 404, one serving → 200). Don't start a second dev server on
  an occupied port; check `netstat`/`Get-NetTCPConnection` first and match the
  PID's creation time to your own launch before killing anything.
- **better-auth state-changing API needs an `Origin` header.** Hitting
  `/api/auth/organization/create` (and friends) over curl returns 403
  `MISSING_OR_NULL_ORIGIN` without `-H "Origin: <baseURL>"`. The browser sends
  Origin automatically; smoke-test scripts must add it. The origin must be in
  `trustedOrigins` (we set it to `baseURL`). GET/session endpoints don't need it.
- **SVG drag must be window-driven, not pointer-capture + svg `pointerleave`.**
  First in-browser test: the map editor selected objects fine but drag/resize/
  rotate never moved them. Root cause: `setPointerCapture` on the shape retargets
  the pointer to it, so the `<svg onPointerLeave={endDrag}>` fired on the first
  move and killed the gesture before anything updated. Fix: drop capture + the svg
  pointer handlers; on pointerdown set a `dragging` state whose effect binds
  `pointermove`/`pointerup`/`pointercancel` on `window`, so the pointer can roam
  outside the svg without dropping the drag. Verified in Chrome: move, resize, and
  rotate all update and persist.
- **`left_click_drag` (claude-in-chrome) doesn't emit pointerdown/up.** During the
  above, the browser tool's drag fired only `pointermove` (instrumented: down 0,
  move 4, up 0), so a pointerdown-initiated gesture never starts and the object
  looks "stuck." A plain `left_click` does fire pointerdown/up. To test real drag
  logic, dispatch a synthetic `PointerEvent` sequence (pointerdown on the target →
  `await` a tick so React's effect attaches the window listeners → pointermove(s)
  on window → pointerup), then assert on DOM attrs + the DB. Don't conclude drag is
  broken from `left_click_drag` alone.
- **BRC compass orientation (map editor).** Anchored to user ground truth: a
  3:00 camp's frontage faces **NE toward the Man**. So the bearing the map's "up"
  (toward the Man, across the frontage) points to, for clock address H, is
  `(135 − 30·H) mod 360` — 3:00→45°(NE), 4:30→0°(N), 6:00→315°(NW), 12:00→135°(SE).
  Sun azimuths are event-week approximations (~40.8°N, late Aug): sunrise ENE ≈73°,
  sunset WNW ≈287°; the compass shades the daylight wedge (sunrise→south→sunset).
  Earlier I had this 180° flipped (added +180 for "inward"); the frontage *is* the
  Man side, so map-up = the toward-Man bearing directly, no +180.
- **Compass lives outside the map SVG.** It's a standalone widget in the right
  rail, not an overlay, so it never covers the lot. The map SVG is size-capped
  (`maxHeight: calc(100vh - 180px)`, intrinsic width/height + `maxWidth:100%`) so a
  wide window doesn't balloon it — the whole lot stays visible. Legend + selected-
  object properties + lot form sit in the rail beside the map.
- **Map coordinate model = plot-local feet.** `map_object.x/y/width/height` are
  feet with origin at the lot's front-left corner, +x along the frontage, +y into
  the lot. This keeps a camp's internal layout stable even if its city lot moves
  year to year — only the `placement` row's anchoring changes. **Taper caveat:**
  BRC lots are radial wedges (rear edge wider than frontage). The editor draws the
  true trapezoid outline from `inner_radius_ft`, but objects live on a rectangular
  frontage×depth grid (the ~5′/100′ taper is visually negligible). True radial
  object placement is a later refinement, not MVP.

## Progress log

- [x] Decisions captured (tenancy, db, auth, first slice, stack).
- [x] Phase 0 scaffold — runnable RR7+Mantine shell, typecheck+build green,
      committed (646fa9c). README, Biome, .env.example in place.
- [x] Resolved hosting/visibility/Discord questions (see above).
- [x] Discord setup guide written (`docs/discord-setup.md`).
- [x] MIT LICENSE + project CLAUDE.md added for open-source + agent handoff.
- [x] Phase 1 foundation — Drizzle multi-camp schema (10 tables, `camp_id` on
      every tenant table), auto-migrate on startup; better-auth wired (server +
      client: email/password, magic link, passkeys, optional Discord, org/roles
      plugin → admin/officer/member/recruit via `ROLE_RANK`); member directory +
      role management UI (add recruit, rank-checked promote/demote) + Discord
      link surfacing. typecheck + build + biome green. Golden path validated
      end-to-end over HTTP (signup → create camp → add recruit → promote →
      negative 403 for non-officer) and login UI verified in-browser.
- [x] Phase 2 recruiting & onboarding — public `/c/:slug` application funnel →
      `recruit_application`; officer+ review queue (accept → membership if the
      applicant has an account else a better-auth invitation; waitlist; reject)
      with a shareable apply link; per-member onboarding checklist that officers
      define and members tick off. Fixed the latent `invitation.created_at` gap.
      typecheck + build + biome green. Validated end-to-end over HTTP: apply →
      list → accept-as-invitation, apply-with-account → accept-as-membership,
      onboarding add/toggle on+off.
- [~] Phase 3 map editor — IN PROGRESS in a parallel thread. BRC geometry/
      addressing layer (`app/lib/brc.ts`), map schema (`db/schema/map.ts`:
      placement/map_object/occupant/zone) + the `camp_edition` per-year axis, and
      a large editor route (`app/routes/dashboard/map.tsx`) + structures palette
      (`app/lib/structures.tsx`) all exist. Geometry math validated against BMorg
      checkpoints by this thread; full editor golden-path run still to verify.
      Not yet committed (lives in the shared working tree).
- [x] Phase 3 (MVP increment) camp map editor — `placement` + `map_object`
      schema (migration 0003, plain CREATE TABLEs), `/dashboard/map` SVG editor
      with add/drag/resize/rotate/edit/delete + lot-setup form; members+ edit,
      recruits view-only; "Map" nav link. typecheck + build + biome green.
      Server actions validated end-to-end over HTTP (savePlacement → addObject →
      updateObject move/rotate → deleteObject all persist; SSR renders clean).
      Client-side pointer drag/resize/rotate implemented but not yet exercised in
      a real browser — needs in-browser testing.
- [x] Phase 3 map editor — many refinements landed and browser-verified:
      drag-drop legend, skewed 10ft grid (50ft emphasis), rotated-resize fix,
      keyboard shortcuts, orientation compass (true north + daylight wedge + Man
      glyph; 3:00 frontage faces NE), side-rail layout with size-capped map,
      footprint shapes (hexayurt hexagon w/ ridge gradient, hyparhut hypar roof,
      cars/trucks/RV vehicle sizing), doors (swing-out 180° on RV/huts) + tent
      porch, and memoized shapes for drag perf.
- [x] Phase 3.5 inventory-driven placement (declare → place → account):
      schema `map_object.owner_membership_id` + `placed` + `map_object_occupant`
      (migration 0004). `/dashboard/bringing` lets a camper declare items (unplaced,
      owned); officers get an "Unplaced" tray on the map to drag items onto the lot
      (placeObject) plus the legend for shared items; `/dashboard/inventory`
      (officer) accounts for every item (owner, size, placed/unplaced). Shared
      palette extracted to `~/lib/structures`. typecheck+build+biome green; declare
      → place → list validated over HTTP. TODO: occupants UI, RV pop-outs +
      generator/cleanout markers, custom-structure registry, groups, off-center doors.
- [x] Phase 3.6 map editor round (commits dfdac92 → a18c1fa, all browser-verified):
      - Recognizable top-down line-art icons per kind (wheels/windshields, tent &
        hexayurt ridges, hypar diagonal, kitchen burners, generator bolt, …) + a
        Van kind; legend grouped (Domiciles/Vehicles/Structures/Power) with name
        tooltips; same icons in the unplaced tray. Selected-structure panel hides
        when nothing is selected.
      - Translucent click-through **shade canopy** (drawn over the items beneath;
        empty-area click selects it, clicks over a block pass through).
      - **Ownership + approval workflow** (migration 0008: `map_object.pending_*`).
        Only officers add/place/delete and edit anything directly; a member may
        move/resize/rotate **their own** placed item, applied live but flagged
        **pending** until an officer **approves** (locks in) or **rejects**
        (reverts to `pending_prev`). Anyone can select any item for read-only
        details. Side-panel diff + Approve/Reject, a rail "Pending approvals"
        queue, and an amber dot on pending items.
      - Owner **first name shown on domiciles** (upright, rotation-invariant).
      - **Highlight filter** (All / Mine / Domiciles / Vehicles / Structures) dims
        non-matching objects — kinds carry `group` + `tags` in `~/lib/structures`.
      - **Grid scale/skew caption** with real feet-inches (front vs rear edge
        width + per-10′-column splay).
      - **Free-polygon zones** (migration 0009: `map_zone`) — fire lane / public /
        private / custom. Officers draw by clicking vertices (Finish/Enter close,
        Escape cancels); translucent dashed regions with a centroid label, drawn
        under structures; select to edit name/type/color or delete.
      Verified the approval loop end-to-end via admin impersonation (member move →
      pending; reject reverts; approve keeps; member add → 403) and zones (draw →
      render → rename → delete). TODO unchanged: RV pop-outs,
      custom-structure registry, groups, off-center doors, zone vertex-editing.
- [x] Map object names: a named structure/RV shows its name as the prominent
      center label, with the owner's first name smaller/dimmer beneath it
      (commit 178b809). Item name is now editable on the Bringing page too.
- [x] Camper onboarding wizard at `/start` (commit 56732e5, browser-verified via
      impersonation): a focused full-screen Mantine Stepper — profile (playa
      name) → bringing (declare items, with a name field) → sharing (add other
      members as `map_object_occupant` of your tent/RV — the first occupant UI) →
      camp checklist → done. Bringing/checklist steps reuse the existing
      `/dashboard/bringing` + `/dashboard/onboarding` actions via cross-route
      fetchers; profile/occupant/progress use the route's own actions. Migration
      0010 adds `membership.wizard_step` + `wizard_completed_at`. New non-officer
      members are auto-redirected to `/start` once (any step/skip bumps off step
      0; completion stops it; a "Finish setup" nav link offers re-entry until
      done). Verified: auto-redirect, per-step persistence + resume, occupant add,
      finish → dashboard with no loop. TODO: occupant who isn't yet a member
      (invite flow), richer profile questions.
- [x] Map editor tweaks (2026-06-12, code-complete, NOT browser-tested) — (a)
      **door visibility**: a global "Show doors" checkbox in the map's Highlight
      panel (client-only master switch) + a per-element "Show door" checkbox in the
      side panel (officer-only, kinds with a door = rv/hyparhut/hexayurt/container
      via `kindHasDoor`). New `map_object.show_door` boolean (migration 0016, default
      true); door render gated on `showDoors && o.showDoor`. (b) **default non-zero
      height**: Bringing's `addItem` now seeds `tallFt = kindHeight(kind)` (was
      falling to the DB default 0 → no shade); the map's `addObject` already did. (c)
      removed the "for shade · 0 = no shade" helper text on the side-panel Height
      input. typecheck + build green; migration 0016 verified on a DB copy. NOTE:
      these edits layer on the parallel thread's still-uncommitted `map.tsx` /
      `structures.tsx`.
- [x] Routing flattened — no `/dashboard` URL segment (2026-06-12). The app shell
      is now a **pathless layout** (`layout("routes/dashboard/layout.tsx", …)` in
      `routes.ts`) whose index serves `/`; former `/dashboard/X` pages are now `/X`
      (`/members`, `/map`, `/tickets`, …). The old `_index.tsx` landing page (with
      its "Enter dashboard" button) is **deleted** — `/` is the overview when logged
      in, and the layout loader's `requireUser` redirects to `/login` otherwise.
      Route files stay under `app/routes/dashboard/` (internal grouping under the
      shared shell); only URLs changed. All in-app links/redirects/`callbackURL`s and
      `session.server` redirects updated (`requireActiveCamp` → `/`,
      `requireActiveEdition` → `/editions`). typecheck + build green. (Historical
      `/dashboard/...` mentions elsewhere in this plan predate the flattening.)
- [x] Season-aware wizard (first slice, 2026-06-12) — `/start` now schedules asks
      by time-of-year + role instead of a fixed 5-step stepper. New `participation`
      (per-year RSVP) + `wizard_ask` (per-ask completion) tables (migration 0015);
      `eventStartFor`/`weeksUntilEvent` in `brc.ts`; pure ask catalog + scheduler in
      `app/lib/wizard.ts`; `wizard.server.ts` state/upserts. RSVP is the concrete
      new ask; tickets/questionnaire stubbed. Layout "Finish setup" nudge is now
      per-edition pending-asks. typecheck/build/biome green; migration + scheduler
      verified by script; NOT yet browser-tested. Details in the section below.
- [x] Questionnaire / question bank (code-complete, NOT browser-tested) — generic
      question-bank feature (the wizard's stubbed `questionnaire` ask). Schema
      `db/schema/question.ts` (`camp_question` camp-scoped config + `question_answer`
      edition-scoped) + migration 0017; `app/lib/questions.ts`/`.server.ts`;
      `app/components/QuestionField.tsx`; `/questions` route (officer CRUD + member
      answers) + nav link; `/start` questionnaire step wired to real questions.
      typecheck/build/biome green. Converts the Math Camp Airtable forms: most
      fields map to existing features (Bringing inventory, RSVP, passes, tickets);
      only the free-form remainder is the new bank. Camp's actual questions get
      entered as DATA via admin, not committed. See section below.

## Season-aware wizard (design direction — first slice landed)

**The ask (from the user).** `/start` should walk a camper through *whatever data
is missing and relevant right now* — and what's relevant depends on (a) the **time
of year** relative to the event and (b) the camper's **role/status**. The fixed
linear 5-step stepper doesn't fit: the right asks change as the season progresses.

Examples the user gave (BRC timeline; event = late Aug):
- **Early / off-season:** "are you coming back?" (general interest from returning
  campers) + **Directed Group Sale** ticket coordination (ties into the landed
  ticketing feature) + *some* of the questionnaire.
- **Recruits** get a **bigger questionnaire** than returning members.
- **Camp items / things** (the "bringing" inventory) are **optional** generally…
- **…but around now (June)** we **start collecting expected tents/vehicles/etc** —
  the bringing inventory becomes an active ask as the event nears.

**Proposed model (for discussion, not locked).** Replace the hardcoded
`STEP_COUNT` stepper with a **data-driven list of "asks"**, where each ask carries:
- an **audience** (returning member / recruit / everyone),
- a **season window** (when it opens / is due, relative to the event date),
- a **priority** (required vs optional).
A scheduler computes, for `today` + this camper's role, the ordered set of asks
that are *in season and relevant*, and the wizard walks only those. Each ask is a
reusable step component; most reuse existing per-feature actions (bringing,
tickets, onboarding) the way the current wizard already does via cross-route
fetchers — the wizard orchestrates, it doesn't duplicate storage.

**Key implications / forks to settle before building:**
1. **Per-ask completion replaces the integer `wizardStep`.** A single "furthest
   step" can't model a set that grows mid-season (new asks appear later and must
   re-prompt). Need per-ask, per-edition completion tracking instead. This is the
   main schema change. *(Leaning: this one's just correct, not really a fork.)*
2. **Where do the season dates live?** Hardcoded relative-to-event defaults, vs
   officer-configurable per-edition key dates (gate-open, DGS sale window, ticket
   deadlines). `camp_edition` already anticipated carrying optional dates; the
   ticketing feature already has real `setup_pass_date` calendar dates.
3. **"Are you coming back?" = the per-year participation record.** The plan already
   deferred a per-year *participation* row (decision under the edition axis) "until
   a feature needs it." **This feature needs it** — general-interest / RSVP is
   exactly that row. Likely the first concrete piece to build.
4. **The questionnaire is net-new.** No question/answer schema exists yet.
   "Returning members get part, recruits get a bigger one" implies a **question
   bank** with audience tagging + per-membership answers. Decide whether to build
   that now or stub it and ship the scheduling skeleton first.

**LOCKED decisions (user, 2026-06-11):**
- **Season dates = hardcoded relative-to-event defaults.** Asks open/close at fixed
  offsets from the edition's event date; no per-camp date config yet (revisit later).
  Need an `eventStartFor(year)` (BRC: ~the Sunday 8 days before Labor Day) so
  "weeks until event" is computable from `today`.
- **Build order = scheduling skeleton + RSVP first.** Smallest useful slice:
  per-ask/per-edition completion model + the season scheduler + the
  participation/"coming back?" row. Questionnaire is **stubbed** for now (net-new
  question-bank deferred to a later slice).

**First slice — LANDED (code-complete, NOT yet browser-tested), 2026-06-12.**
typecheck + build + biome green (on the new/changed files; the only remaining lint
errors are the pre-existing `map.tsx`/`entry.server.tsx` import-order + drizzle's
auto-generated migration-snapshot JSON, same as before). Migration verified to
apply on a VACUUM copy of the live DB (both tables + all 3 indexes created on top
of the 0000→0015 chain). Scheduler verified by script (see "verified" below).

- **Schema** `db/schema/season.ts`, **migration 0015** (both `camp_id` +
  `edition_id` scoped, lock-respecting):
  - `participation` — per (edition, membership) RSVP / general interest. `status`
    unknown|coming|maybe|not_coming + optional `note`. Unique (edition, membership).
    This is the long-deferred per-year **participation** row; "are you coming back?"
    is its first consumer.
  - `wizard_ask` — per (edition, membership, ask_key) completion: `status`
    done|skipped. Presence = the ask is resolved. **Replaces** the single
    `membership.wizard_step` integer for driving asks (the integer now only gates
    the layout's one-time forced redirect — see below; the columns are kept, not
    dropped).
- **`brc.ts`** — `eventStartFor(year)` (the Sunday 8 days before Labor Day; 2025→
  Aug 24, 2026→Aug 30, 2027→Aug 29) + `weeksUntilEvent(year, from?)`.
- **`app/lib/wizard.ts`** (pure, client-safe) — `AskDef` + the `ASKS` catalog
  (rsvp/profile/questionnaire/tickets always-open; bringing/sharing open 12 wks
  out; checklist 8 wks), `audienceForRole` (recruit role → "recruit", member+ →
  "returning"), `scheduleAsks({role, weeksUntilEvent})` → ordered in-season set.
- **`app/lib/wizard.server.ts`** — `loadWizardState` (scheduled + resolved +
  pending + participation), `resolveAsk` upsert, `setParticipation` upsert (also
  resolves the rsvp ask).
- **`/start`** rewritten from the fixed `STEP_COUNT` stepper to a **dynamic Stepper
  over the scheduled asks**. New **RSVP** step writes `participation`. profile/
  bringing/sharing/checklist are catalog entries reusing their existing actions;
  **tickets** = link to `/dashboard/tickets`, **questionnaire** = stub (copy differs
  for recruit vs returning; no inputs yet). Next/Finish mark the current ask `done`;
  "Skip this" marks it `skipped`; both advance. Loader bumps `wizard_step`→1 on
  first visit so the forced redirect fires once.
- **`dashboard/layout.tsx`** — the "Finish setup" nav now shows whenever the active
  edition has **pending** (scheduled-but-unresolved) asks — per-edition + dynamic,
  so a new season re-surfaces it. Forced redirect still fires at most once
  (`wizard_step === 0`). Officers exempt.

**Verified by script:** off-season (~33 wks out) schedules `rsvp, profile,
questionnaire, tickets` (general interest + DGS + part of questionnaire — matches
the user's "early on"); ~now (11 wks out) adds `bringing, sharing` (collect tents/
vehicles), checklist still closed; recruit vs member sets currently identical
(all asks are audience "all" so far — the audience axis is wired for when the real
questionnaire differs).

**Still open / next slices:** the real **questionnaire / question-bank** (net-new:
audience-tagged questions + per-membership answers; recruits get more); per-camp
**configurable season dates** (currently hardcoded offsets); officer view of who's
RSVP'd / pending (`participation` + `wizard_ask` already capture it); browser-test
the rewritten `/start` end-to-end; consider dropping the now-vestigial
`wizard_completed_at` column in a later cleanup migration.

## Questionnaire / question bank (LANDED, code-complete — NOT yet browser-tested)

The net-new piece the season wizard's `questionnaire` ask was stubbed for. Built
in response to "convert our Airtable forms into the new system." **Key framing
(user-locked):** the *capability* to ask arbitrary questions is generic and lives
in the shared app; a camp's *actual questions are DATA* an officer enters (never
baked into the open-source code). This resolves the "shouldn't be baked in, but
should let us ask these" tension.

**Airtable → CampTool mapping (the real insight).** The two 2024/2025 Airtable
forms are not one feature — most fields already had homes, so only a slice is the
new question bank:
- **Vehicles & Domiciles Census ≈ the existing Bringing inventory** (`map_object`):
  name→name, type→kind, W/L/H→width/height/tallFt, prefs/details→notes. No
  question bank needed.
- **Census fields routed to existing features** (user decision: route overlap to
  the real feature, don't duplicate as questions): names/playa→profile; "camping
  this year?"→`participation` RSVP; SAP + setup day→`setup_pass`/`setup_pass_date`;
  ticket/vehicle-pass ± counts→ticketing; "# in group"→occupants/participation.
- **Genuinely-new free-form fields → the question bank:** first-burn/first-Math-
  Camp, how-you-heard/who-invited, burner-profile email, phone, rideshare, strike
  day, bar-supplies / interactivity / shared-infra contributions, "what makes it
  special", and the Expectations agreement (a `consent` checkbox).

**Schema — `db/schema/question.ts`, migration 0017** (2 tables):
- `camp_question` — camp-scoped config (NOT edition-scoped; the question set
  persists across years, like `onboarding_task`). Columns: prompt, helpText, type,
  options (JSON string[] for selects), audience (all|returning|recruit, matches
  `AskAudience`), required, sortOrder, archivedAt (soft-retire so answers survive).
- `question_answer` — edition-scoped (per-year; contributions/consent are per-year)
  per (edition, membership, question). value is text for every type (number→digits,
  boolean/consent→"true"/"false", date→YYYY-MM-DD, single→option, multi→JSON array).
  Unique (edition, membership, question).

**Types/helpers.** `app/lib/questions.ts` (pure, client-safe): `QuestionType`
union (keep in sync with the schema's), `QUESTION_TYPES`/`QUESTION_AUDIENCES`,
`parseOptions`/`parseMultiValue`, label helpers. `app/lib/questions.server.ts`:
`loadCampQuestions` (active, ordered), `filterByAudience` (reuses
`audienceForRole` from wizard.ts), `loadAnswers`, `setAnswer` (upsert).

**UI.** `app/components/QuestionField.tsx` — one shared component renders an answer
field by type and saves via fetcher (optional `action` prop so the wizard can post
to `/questions`). `app/routes/dashboard/questions.tsx` — officer management
(add prompt/help/type/options/audience/required, delete, reorder ↑/↓) + member
answering for the active edition; locked edition = answers read-only (officer
config still editable since it's camp-scoped). Wired in `routes.ts` + a "Questions"
nav link (recruit+). `/start` wizard's `QuestionnaireStep` now renders the real
audience-filtered questions instead of the stub.

typecheck + build + biome green (on the new files). **Migration 0017 NOT yet
applied to any live DB; feature NOT yet deployed or browser-tested.**

**Next:** (1) browser-test `/questions` + the `/start` questionnaire step locally
(restart dev server → migration 0017 applies). (2) Deploy (push to master →
auto-deploy applies the migration). (3) Enter Math Camp's specific ~10 questions
as DATA via the `/questions` admin UI on `camptool.mathcamp.us` — they stay camp
data, never in the repo. **Still open:** edit-in-place for an existing question
(currently delete + re-add); per-camp recruit-vs-returning audience tuning;
answers in the officer inventory/roster view.

## Recruit funnel rework + invite tree (in progress)

Reworking how people enter a camp. The Phase 2 funnel (anonymous application →
account created only at accept time, via better-auth invitation/magic-link) is
being replaced. **None of this was ever a "locked decision" (those are items 1–5
above) — it was just the Phase 2 implementation, and it's being revised.**

New model, built in three shippable stages:

1. **Password-at-apply (this stage).** The public `/c/:slug` page (open, NO secret
   token — confirmed correct) now creates a real better-auth account as part of
   applying, so the applicant has a password and can log in to track status. An
   application is always tied to a `userId`; accept therefore always just
   `addMember` (no invitation/magic-link branch for applicants). Existing-account
   users sign in first, then apply.
2. **Tokenized friend-invites (this stage).** Members+ generate secret-bearing
   invite links (`camp_invite.token`). Redeeming joins the camp as a recruit and
   records who invited whom. (Secrets live ONLY here, never on the public apply
   URL.) The self-referential `membership.invited_by_membership_id` edge landed
   here too (migration 0005), since redemption is when the edge is first known.
3. **Invite tree (last).** Now just the *view* + backfill: the edge column already
   exists. Public applicants / existing members have null inviter (roots); invited
   campers hang off their inviter. **Backfill decision: root all existing campers
   at the camp founder/admin**, re-parentable later by officers.

### Progress

- [x] Stage 1 — password-at-apply. `/c/:slug` now: logged-out → account section
      (signup with password / sign in / magic-link / passkey / Discord) that
      revalidates into the apply form; logged-in → short apply form (playa name +
      message) tied to the account. Application always carries `userId`; name/email
      taken from the session (not spoofable). Dupe-guards for already-member /
      already-applied. Accept flow unchanged (addMember when account exists — now
      always true; legacy null-userId rows still handled). typecheck + build green;
      validated over HTTP (signup → apply → row persisted with userId; re-apply →
      "already applied").
- [x] Stage 2 — tokenized friend-invites. Schema: `camp_invite` (token/role/
      maxUses/useCount/expiresAt/revokedAt) + `membership.invited_by_membership_id`
      self-ref edge (migration 0005). `/dashboard/invite` (members+) creates/copies/
      revokes personal links; `/i/:token` redeems — logged-out → shared `AuthInline`
      account gate, logged-in → "Join {camp}". Redemption inserts the membership
      directly (bypassing `auth.api.addMember`, which checks the *caller's* perms —
      the token is the authorization), sets the inviter edge, bumps useCount.
      Invites grant **recruit only** (a leaked link must not self-grant elevation).
      Extracted the auth card to `app/components/AuthInline.tsx` (shared with
      `/c/:slug`). typecheck + build + biome green. Validated over HTTP: create →
      loader renders link; signup → redeem → membership(recruit) with invitedBy set
      + useCount++; bad token 404; expired/revoked/used-up states handled.
- [ ] Stage 3 — invite tree view + founder-rooted backfill (edge column already exists).

## Instance admin: super admin + signup/camp lockdowns (landed, browser-tested 2026-06-11)

The deployment owner needed two switches: **lock down new camp creation** and
**lock down new-account creation to invite-only**. There was no instance-level
concept before this (all roles are per-camp by design), so this introduces the
first deployment-wide layer. **User-locked decisions:** (a) super admin = the
**first account to register** (promoted automatically), with more grantable
in-app — NOT an env var, NOT a `user.role` column; (b) invite-only still lets new
accounts be created from **camp invite links AND a camp's public apply page**,
only the bare `/login` signup is blocked.

**Schema (`db/schema/instance.ts`, migration 0011).** Two instance-global tables
(the only non-`camp_id` tables, intentionally):
- `instance_setting` — singleton row (`id='singleton'`) with `allow_camp_creation`
  + `allow_open_signups` booleans (default true) + `updated_at`.
- `super_admin` — `user_id` PK FK→user (cascade). A side table, NOT a column on
  `user`, to keep identity free of global roles. Migration **seeds** the singleton
  row and **promotes the earliest existing account** (`ORDER BY created_at ASC
  LIMIT 1`) so an already-seeded deployment isn't left ownerless; fresh installs
  promote the first signup at runtime. Verified on a VACUUM copy of the live DB +
  after live apply: cameron@tacklind.com (earliest) became super admin.

**Helpers (`app/lib/instance.server.ts`, server-only).** `getInstanceSettings`/
`setInstanceSettings` (upsert), `isSuperAdmin`/`listSuperAdmins`/
`grantSuperAdminByEmail`/`revokeSuperAdmin` (refuses to remove the last one),
`ensureFirstUserSuperAdmin` (no-op once any exists), and the signed
**signup-unlock cookie** (`camptool_signup_ok`, HMAC over an expiry, 1h TTL,
HttpOnly). MUST NOT import auth.server.ts (auth.server imports this — cycle).

**Enforcement (`app/lib/auth.server.ts`).**
- *Camp creation:* organization plugin `allowUserToCreateOrganization` → super
  admin always true, else `allowCampCreation`. Server-side, so it holds even if
  the client tries directly. Dashboard index also hides the create form when not
  allowed (`canCreateCamp` from the loader).
- *Signups:* `databaseHooks.user.create.before` is the one choke point that
  covers EVERY method (email/pw, magic link, Discord) — passkey never creates a
  user so it's exempt. When `allowOpenSignups` is false it throws `APIError
  FORBIDDEN` unless the request carries a valid unlock cookie. `after` promotes
  the first user. `/login` hides the Create-account tab when open signups are off;
  the apply (`c.$slug`) and invite (`i.$token`) loaders set the unlock cookie
  **only in invite-only mode** (open mode is byte-identical to before — no cookie).

**GOTCHA that bit this (the big one).** better-auth runs its origin/CSRF check
**only on cookie-bearing requests** (`origin-check.mjs`: `useCookies =
headers.has("cookie")`; skips the check entirely otherwise). Logged-out signups
historically carried no cookie, so the check was always skipped — which is why it
"worked" even though dev's `PUBLIC_BASE_URL=https://camptool.isozilla.com` ≠ the
`localhost:3000` you actually browse, so `trustedOrigins` never matched the
browser Origin. The instant the unlock cookie rides along, the origin check
activates and **rejects with `INVALID_ORIGIN`** on localhost. Fix: (1) set the
cookie only in invite-only mode (zero change to the common path), and (2) add
`http://localhost:3000`/`127.0.0.1:3000`/`localhost:5173` to `trustedOrigins`
when `NODE_ENV !== "production"`. In production the browser Origin equals
`PUBLIC_BASE_URL` so the check passes naturally; the firefly env-file already sets
`NODE_ENV=production`. **Don't conclude signup is broken from a localhost test
where PUBLIC_BASE_URL points elsewhere** — confirm whether a cookie is present.

**UI.** New `/dashboard/admin` (super-admin only; redirects others) with two
Mantine `Switch`es + a super-admin list (add by email / remove, last-one
guarded). A "Site admin" nav link shows only for super admins.

**Verified end-to-end in Chrome (invite-only ON):** `/login` hid the
Create-account tab + showed the invite-only note; a bare POST to
`/api/auth/sign-up/email` returned 403 with our message and created no user;
signing up via `/c/:slug` (apply page) **succeeded** (page revalidated to
"Applying as …"); DB confirmed only that one user created, all blocked attempts
created nothing, and super_admin = only the earliest user. `/dashboard/admin`
redirects to `/login` when logged out. typecheck + build + biome green. NOT yet
click-tested: the admin page's own toggle/grant UI (no login credentials on hand
for the super-admin account) — the route loader/action are typed + the helpers
are exercised by the enforcement tests.

## Admin "Work as" (impersonation)

A per-camp impersonation feature so an officer+ can view/use the app as a
lower-ranked member (debugging "why can't this recruit see X", and a trivial
dev account-switcher). **Deliberately NOT better-auth's admin plugin** — that
gates impersonation on a *global* `user.role` super-admin and adds `role`/`banned`
columns to the `user` table, which contradicts the multi-camp / per-camp-role
model (decision #1, and a camp admin must never reach into other camps). Instead
a thin custom layer over better-auth:

- Signed, HttpOnly `camptool_actas` cookie (HMAC-SHA256 over `{u: targetUserId,
  c: campId}` with `BETTER_AUTH_SECRET`) — server-only pointer to who we're
  acting as. `app/lib/session.server.ts`.
- `getSession()` resolves the *real* better-auth session, then — only when the
  cookie is present — swaps in the target's identity (sets `activeOrganizationId
  = campId`) and attaches an `impersonatedBy` marker. Zero extra queries on
  normal requests. `getRealSession()` always returns the unimpersonated session.
- `canImpersonate(realUserId, targetUserId, campId)`: real user must be
  **officer+ in that camp and strictly out-rank** the target, and the target must
  belong to the camp. Re-checked on *every* request, so a demotion or removal ends
  impersonation immediately. De-escalation only — you can never gain privileges.
- `/impersonate` resource route (start/stop). Start authorizes via
  `getRealSession` (never the effective session, so an impersonated session can't
  re-escalate). UI: a "Work as" button on `/dashboard/members` for rows the viewer
  out-ranks, and a grape banner + Stop control in the dashboard layout while
  impersonating.
- Note: better-auth's own privileged API calls (`auth.api.*` with
  `request.headers`) still act as the *real* user — the act-as swap only affects
  our app's loaders/actions that route through `getSession`. Fine for the
  view/use-as-them use case; revisit if a flow needs better-auth to see the target.

typecheck + build + biome green. Not yet browser-tested end-to-end.

## Map lot: per-year BRC geometry (landed)

See the Phase 3 "City-geometry automation" note above for the feature. Files:
`app/lib/brc.ts` (geometry + clock/bearing helpers, client-safe), `db/schema/map.ts`
+ migration 0006 (`street_letter`, `placement_year`, `fronts_to_man`),
`app/routes/dashboard/map.tsx` (lot form rebuilt: street/year selects auto-fill
radius, clock autocomplete with off-grid entry, man/mountain toggle; render
taper + compass honor facing and derived radius). Also dropped this session: min
password length 6 (server + both client validators). typecheck + build + biome
green. Not yet browser-tested.

## Map editor: power planning + container/lot UX (code complete 2026-06-11, NOT yet browser-tested)

Three map-editor changes landed in `app/routes/dashboard/map.tsx` (+ supporting
files). typecheck + build green; **not yet exercised in a browser** (next step).

1. **Lot settings behind a gear.** The officer-only lot/PlacementForm in the map's
   right-rail `SidePanel` is now collapsed by default behind a ⚙ toggle (Mantine
   `Collapse` + `lotOpen` state) — it's a once-at-setup form, so it no longer takes
   up rail space after the lot is configured.
2. **Containers are a known size with doors.** `structures.tsx`: `container` is now
   `rigid` (fixed **8′ width**; length is **full 40′ or half 20′**) with exported
   `CONTAINER_WIDTH/FULL/HALF` + `AMP_OPTIONS`/`GAUGE_OPTIONS` consts. The
   SidePanel shows a **Full/Half SegmentedControl** for containers instead of free
   resize; the map draws **double cargo doors** on one short end (reuses the `Door`
   component). Default footprint changed 8×20 → 8×40 (existing 20′ rows read as
   "half").
3. **Power planning — power lines, spider boxes, run-length measurement.**
   - New **`spiderbox`** kind (Power group, fixed 3×3′, rigid) — a distribution
     node placed/dragged like any object.
   - New **`map_cable`** table (`db/schema/map.ts`, **migration 0012**) — an OPEN
     polyline (mirrors `map_zone` but unclosed), carries `camp_id` **and**
     `edition_id` (per the cross-cutting edition axis), `points` JSON, optional
     `amps` (real) + `gauge` (text), color, notes. Loader/action add
     `addCable`/`updateCable`/`deleteCable` (officer-only, in the `officerOnly` set).
   - Editor: draw state generalized `drawing:boolean → drawMode:"zone"|"cable"|null`;
     a **"+ Draw power line"** toolbar button; cable vertices **snap to nearby
     spider boxes / generators** (`snapToNode`, 6′ threshold) so runs connect the
     nodes. Cables render as a labeled overlay over structures; **run length** =
     `pathLengthFt(points)` (Σ segment lengths in plot-local feet, shown via
     `feetInches`), live while drawing and on the cable label + a new `CablePanel`.
   - **Amps + gauge are industry-standard presets** (dropdowns): amps 15/20/30/50/100;
     AWG 14(15A)/12(20A)/10(30A)/8(40A)/6(55A)/4(70A)/2(95A)/1-0(125A).

   **Next:** restart dev server (applies migration 0012) → browser-test: place a
   generator + two spider boxes, draw a power line snapping between them, confirm
   length label + CablePanel length match, set amps/gauge, reload-persist, delete;
   confirm zones still work and recruits stay read-only. Task plan:
   `C:\Users\camer\.claude\plans\curious-splashing-teapot.md`.

## Deployment — firefly + auto-deploy (landed)

Goal: build + auto-deploy to the **firefly** host (`firefly.isozilla.com`),
served at **https://camptool.mathcamp.us/**. Ops repo owns the runner, Caddy, DNS,
TLS; this repo only builds the app and makes it listen on a unix socket.

**Deployment contract (from ops):** the app MUST listen on the unix socket
`/run/camptool/camptool.sock`. Ops-managed Caddy reverse-proxies the public URL →
that socket (adds X-Real-IP / X-Forwarded-Proto: https / X-Forwarded-For). `/run`
is tmpfs and `/run/camptool` is bind-mounted into the Caddy container. A
self-hosted Actions runner (`firefly-camptool`, labels `firefly,self-hosted`,
root) is auto-provisioned by ops; deploy workflow targets `runs-on:
[self-hosted, firefly]`. Health: `GET /` must return 200 (502 until first deploy
is expected).

**What landed:**
- **`server.ts`** — custom Bun production server. The stock `react-router-serve`
  is **port-only** (`app.listen(port)`, no socket option), so it can't satisfy the
  contract; `server.ts` replaces it and binds `createRequestHandler(build)`
  DIRECTLY to `$SOCKET_PATH` via `Bun.serve({ unix })`. No port, no proxy/sidecar
  — it *is* the app's server. Serves `build/client` static assets (immutable cache
  for `/assets/*`), honors `x-forwarded-proto` so SSR/auth URLs resolve to https,
  mkdir+unlink stale socket on boot (tmpfs), chmod 0666 so root Caddy can connect.
  `package.json` `start` repointed to `bun server.ts`.
- **`app/entry.server.tsx`** — web-streams SSR entry using
  `renderToReadableStream`. **Gotcha that bit us:** the default RR entry uses
  Node's `renderToPipeableStream`, which Bun's `react-dom/server` (resolves to
  `server.bun.js`) does NOT export — so the built server crashed under Bun with
  `Export named 'renderToPipeableStream' not found`. The web-streams entry is the
  officially-supported Bun/web variant and fits the fetch-based socket server.
  (This means the OLD `bun run start` was already broken under `--bun`; only `dev`
  had ever been exercised.)
- **`Dockerfile`** (multi-stage oven/bun 1.3: build → prod-only runtime, ships
  `build/` + `db/` migrations + `server.ts`), **`compose.yaml`** (runs as root so
  the socket lands in the root-owned `/run/camptool` bind mount; `env_file:
  /etc/camptool/camptool.env`; `camptool-data` volume for the SQLite db;
  `SOCKET_PATH`/`DATABASE_PATH` set here), **`.dockerignore`**.
- **`.github/workflows/deploy.yml`** — on push to `master` (+ manual dispatch),
  `runs-on: [self-hosted, firefly]`: checkout → mkdir `/run/camptool` + rm stale
  sock → `docker compose up -d --build --remove-orphans` → wait for the socket →
  health-check 200 directly on the socket (`curl --unix-socket`). `concurrency`
  group serializes deploys.
- **`docs/firefly-deploy.md`** — how it works + the one-time host env-file setup
  (`/etc/camptool/camptool.env` with PUBLIC_BASE_URL + BETTER_AUTH_SECRET, Discord
  optional). README gained a Deploy section.

**Verified locally (Windows, Bun 1.3):** typecheck + build green; booted
`server.ts` on a temp socket and fetched via `fetch(..., {unix})` — `GET /` → 200
text/html (full `<html>`), a hashed asset → 200 with `immutable` cache header,
`/login` with `x-forwarded-proto: https` → 200. Biome clean on the new files (3
pre-existing import-order lint errors in dashboard routes are untouched + unrelated;
CI deploy doesn't run lint).

**Firefly model finalized with the ops agent (frozen contract).** After
coordinating (see `C:\Users\camer\AppData\Local\Temp\camptool-ops-comms.md`), the
firefly path is NOT my standalone docker-compose container. Instead the app runs
**inside** the isolated self-hosted-runner container; its PID1 **supervisor** owns
the app process (an Actions job can't, since Actions kills the job's process tree
at job end). Key correction that drove the design: ops first speced a **Node** app
(`node dist/server.js`); CampTool is **Bun** (`bun:sqlite`, `Bun.serve`), so the
runner image bakes **Bun 1.3.x** and the app entrypoint is `exec bun server.ts`.

Frozen contract my CI codes against:
- `runs-on: [self-hosted, firefly]`; build `bun install --frozen-lockfile` +
  `bun run build`.
- Stage a self-contained tree (build + `server.ts` + `run` + prod `node_modules` +
  **`db/migrations/`**) to `/srv/camptool/releases/$GITHUB_SHA/`.
- Ship executable **`run`** (`cd "$(dirname "$0")"; exec bun server.ts`).
- Activate atomically: `ln -sfn releases/$SHA /srv/camptool/current` then
  `touch /srv/camptool/restart` (sentinel the supervisor watches — CI never
  touches supervisord's socket).
- App binds `/run/camptool/camptool.sock` (default `SOCKET_PATH`), 200 at `/`.
- **CI writes no secrets**; ops injects an env-file: `PUBLIC_BASE_URL`,
  `BETTER_AUTH_SECRET`, `DATABASE_PATH=/srv/camptool/data/camptool.db`
  (persistent, OUTSIDE the per-SHA release dir), optional Discord, `NODE_ENV`.
- Caddy's `/run/camptool` switches from host-bind to a shared `camptool_sock`
  named volume; persistent `camptool_app` volume = `/srv/camptool`.

`deploy.yml` rewritten to this (release tree → symlink → sentinel → socket health
check + prune-old-releases), and a `run` entrypoint added. The `Dockerfile` +
`compose.yaml` are **repurposed as the generic self-host path** (any host with a
reverse proxy), documented separately in `docs/firefly-deploy.md`.

**LIVE (2026-06-11).** First successful deploy is up:
`https://camptool.mathcamp.us/` returns **200 via Caddy** serving the SSR app
(`<title>CampTool</title>` + hydration bundle). Deploy run went green in 46s
(checkout → bun build → stage release → flip `current` → touch restart →
supervisor starts app → socket health-checked 200). Every push to `master` now
auto-deploys.

Gotcha that bit the first run (resolved by ops): the container runner executes
**jobs as the non-root `runner` user** (uid 10001), not root. The first attempt
failed in 7s at `actions/checkout@v4` with `EACCES ... stat '/root/.gitconfig'`
because `HOME=/root` was unreadable. Ops fixed it by setting `HOME=/home/runner`;
the `runner` user already owns `/srv/camptool` + `/run/camptool` +
`/opt/actions-runner` via an entrypoint chown, so no root and no chowns were
needed on our side — the workflow was correct as written. Runtime user/paths for
future reference: job + app run as `runner`; socket `/run/camptool/camptool.sock`;
DB `/srv/camptool/data/camptool.db` (persistent, outside per-SHA releases).

Housekeeping left: ensure the ops env-file has a real `BETTER_AUTH_SECRET` (app
serves 200 without it but sessions won't persist across restarts). Left unused dep
`@react-router/serve` in `package.json` (harmless; optional cleanup).

## Resolved (formerly open) questions

1. **Repo visibility:** public, MIT-licensed. Work in the open from now.
2. **Hosting:** localhost for dev/testing now; real domain later
   (`tool.mathcamp.us` or apex `mathcamp.us`). Keep everything env-driven via
   `PUBLIC_BASE_URL` so switching the host is a config change only.
3. **Discord app:** user does not have one pre-made. We document the setup
   click-by-click in `docs/discord-setup.md` — written generically so any camp
   self-hosting CampTool can wire their own Discord integration.

## Things not to do

- Don't assume a single camp anywhere in the schema — always carry `camp_id` on
  tenant-scoped tables.
- Don't stand up a persistent gateway bot process unless a feature truly needs
  live events; default to REST + interaction webhooks.
- Don't use SQLite-only features without noting them here (keep Postgres door open).
