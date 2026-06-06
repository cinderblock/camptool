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

Still TODO: "highlight my spot", RV pop-outs (+ generator/cleanout markers),
off-center doors, premade/shared blocks, Borg outline import, fire-lane/marker
overlays, true radial placement of objects, 3D/sun-shade.

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
