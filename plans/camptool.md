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

**Phase 3 — Camp map editor (#2)** — the big one, sub-plan when we start
- 2D SVG/canvas editor tied to DB placements; "highlight my spot."
- Borg outline import; saved/premade blocks (shared + camp-private);
  service/flammable/solar/etc markers.
- Stretch: cross-camp neighborhood map sharing; 3D + sun/shade render.

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

The map is not a single living document; it's a series of versions:
- **Per-year, with past years locked.** A year's map is independent — editing the
  current year must NOT mutate last year's. Past years are **read-only** but
  remain a **source to import from** (copy a previous version's objects/lot into a
  new working version as a starting point).
- **Tagged versions within a year.** At minimum a *planned* version (what we lay
  out before leaving for playa) and an *as-built* version (what actually happened
  on site), plus the reality that people move once there — so multiple snapshots
  over time, each labeled.
- **Unifying model:** introduce a `map_version` entity (camp_id, year, label, a
  lock/status flag, created_at, optional `forked_from_id`). `placement` and
  `map_object`/occupants move from camp-scoped to **version-scoped**
  (`map_version_id`). "The map you edit" = the camp's current *unlocked* version
  for the active year. **Import = copy** rows from a source version into a new one
  (never a live link). **Lock = freeze** a version read-only (e.g. lock "planned"
  once you leave, lock the whole year when it's over).
- **Schema impact is real:** today `placement` is one-row-per-camp
  (`uniqueIndex(camp_id)`) and `map_object` is camp-scoped with no year. This is a
  core map-table migration, so it's its own sub-phase — capture now, design before
  building. Open question for that sub-phase: does locking happen automatically
  (e.g. auto-snapshot "planned" on a date) or only manually?

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
