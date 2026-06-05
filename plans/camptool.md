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
- **Closest prior art in the user's repos:** `Gate Manager` (React Router 7 +
  Bun + Mantine) is the same shape as this app — use it as the reference template.
  `OpenSlate` shows the user's monorepo/workspace style.

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
   plugin to model admin/member/recruit. Reason: matches "lots of auth options"
   plus first-class Discord.
4. **First slice = Foundation:** auth + admin/member/recruit roles + member
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
- `membership` — (user_id, **camp_id**, role: admin|member|recruit, status,
  playa_name, joined_at). The join table that scopes a user into a camp with a
  role. This is the core of requirement #1.
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
- Member directory; admin role management (recruit→member→admin); recruit intake.
- "Are you in our Discord?" check + account link.

**Phase 2 — Public recruit page (#7, #4)**
- Public camp page + recruit application funnel feeding `recruit_application`.
- Onboarding checklist for accepted members.

**Phase 3 — Camp map editor (#2)** — the big one, sub-plan when we start
- 2D SVG/canvas editor tied to DB placements; "highlight my spot."
- Borg outline import; saved/premade blocks (shared + camp-private);
  service/flammable/solar/etc markers.
- Stretch: cross-camp neighborhood map sharing; 3D + sun/shade render.

**Phase 4 — Operations**
- Dues/financials with per-field view/edit permissions (#3).
- Shared documents (#5); announcements (#6).

**Phase 5 — Data lifecycle**
- Import last year's data (#8); exportable database (#10).
- Discord/email reminder campaigns + scheduled DMs (#9).

## Findings / gotchas

- (none yet — record negative results here as we hit them)

## Progress log

- [x] Decisions captured (tenancy, db, auth, first slice, stack).
- [ ] Phase 0 scaffold.
- [ ] Phase 1 foundation.

## Open questions for the user

1. Repo visibility/publishing: keep private until Phase 2, or public from the
   start (MIT like OpenSlate)? (Recommend: private now, decide license later.)
2. Where will this be hosted/deployed (the "little webserver")? Affects how we
   wire migrations + Discord redirect URLs. (Recommend: confirm domain + host
   before Phase 1 auth, since OAuth needs a callback URL.)
3. Discord: do you already have a registered Discord application/bot + guild ID
   we should target, or should I document how to create one?

## Things not to do

- Don't assume a single camp anywhere in the schema — always carry `camp_id` on
  tenant-scoped tables.
- Don't stand up a persistent gateway bot process unless a feature truly needs
  live events; default to REST + interaction webhooks.
- Don't use SQLite-only features without noting them here (keep Postgres door open).
