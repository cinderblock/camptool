# Hosting CampTool for other camps (multi-camp, multi-host)

> Task plan. Parent plan: `plans/camptool.md`. Plan path:
> `plans/hosting-other-camps.md`. Work happens on branch `multi-host` in the
> worktree `C:\Users\camer\git\Personal Projects\CampTool-multi-host`.

## Goal

Run one open, multi-camp CampTool instance that other camps can join (first a
friend's camp), hosted on **Cloudflare** for about $5/month, without tying the
app to Cloudflare: the same code keeps running on Bun + SQLite (firefly,
jackson, any Docker host). Donations later; **no billing code**.

## Environment / context (2026-11-13)

- Live today: `camptool.mathcamp.us` on **firefly** (DigitalOcean, 8 GB,
  $48/mo). Image built on a GitHub-hosted runner, pushed to
  `ghcr.io/cinderblock/camptool`; ops `pin.json` picks the digest.
  `CAMP_THEME` is an ops-owned build variable, asserted by an image label.
- **jackson** (32 GB, $72/mo, LA) runs only Discourse. Fallback host.
- The app is already multi-camp in one deploy: every tenant table carries
  `camp_id`; per-camp roles admin/officer/member/recruit; instance **super
  admins** plus signup and camp-creation lockdowns (`db/schema/instance.ts`).
- Host coupling found: `bun:sqlite` only in `db/client.server.ts`;
  `Bun.file`/`Bun.write` in `images.server.ts`, `sap.server.ts`,
  `backup.server.ts`; raw SQLite handle in `merge.server.ts` (3 sync
  transactions) and `backup.server.ts` (`serialize()`); `db.transaction` twice in
  `faq.server.ts`; `server.ts` (`Bun.serve` on a unix socket). `node:crypto` and
  `node:zlib` run on Workers with `nodejs_compat`.
- No email is sent by the app today, so nothing to split there.
- Discord: login OAuth (`DISCORD_CLIENT_*`) and the bot token are naturally
  per-host (one bot app can join many guilds). Only `DISCORD_GUILD_ID` is
  camp-specific.

## Decisions already made (don't re-ask)

1. **Shared, multi-camp, open instance.** Camp admins run their camp; the
   hoster is super admin. (Cameron, 2026-11-13.)
2. **Cloudflare first, jackson as fallback.** $5/mo Workers Paid. (Cameron.)
3. **Stay portable across hosts.** Host-specific code sits behind small
   adapters; Bun + SQLite stays a first-class target. (Cameron.)
4. **Branding is per camp.** A host may also ship server-wide structure packs.
   (Cameron.)
5. **No billing code.** Donations via an outside service. (Cameron.)
6. **Domain: `camptool.org`** (bought by Cameron, 2026-11-13). Camps get their
   own subdomains: `<slug>.camptool.org`. (Cameron.)
7. **On Cloudflare: Workers + D1 + R2**, not Durable Objects. Reasons: D1 has
   Time Travel (point-in-time restore), a SQL console and `wrangler d1 export`;
   our only multi-statement atomic writes can be expressed as batches.
   (Claude, 2026-11-13; revisit only if latency proves bad.)
8. **Season rollover is soft.** No hard cutoff or forced lock; the "current
   event year" just moves on once an event is over. (Cameron.)
9. **Other events (UnSCruz etc.) wait.** General offering eventually; their
   maps are irregular. Tracked in `plans/season-2027.md`, not here.

## Design

### Structure packs (per-camp theme)

- Every camp-theme package named at build time is bundled (`CAMP_THEMES`,
  comma list). Its structures join one global registry, so any camp's saved
  objects always render. Kind values must be unique across packs (checked).
- Which packs a camp may **use** (palette, add actions) is data:
  - packs in the legacy `CAMP_THEME` variable are **server-wide** (every camp),
    which keeps today's single-camp Math Camp deploy unchanged;
  - otherwise a super admin enables a pack per camp.
- Unavailable kinds behave like an edition's banned kinds: hidden from
  palettes, rejected by add actions.

### Discord per camp

- `camp.discord_guild_id`, set by a camp admin. `DISCORD_GUILD_ID` env stays as
  the fallback for single-camp deploys.

### Camp subdomains

- Opt-in: `CAMP_SUBDOMAINS=1` with `PUBLIC_BASE_URL=https://camptool.org`.
  Off, the app behaves as today (one host, active camp from the session), so
  `camptool.mathcamp.us` is untouched.
- `<slug>.camptool.org` pins the active camp to that slug; a signed-in
  non-member sees that camp's public page (`/c/:slug` content) instead.
- **All auth on the apex.** Login, signup, passkeys and the Discord OAuth
  callback run on `camptool.org`; a subdomain sends you there with a `next`
  back. The session cookie is set for `.camptool.org` (better-auth
  `crossSubDomainCookies`), so one login covers every camp. Passkey RP ID is
  `camptool.org`, origin the apex only.
- Slugs must be DNS labels (a-z, 0-9, `-`, at most 63) and not reserved
  (`www`, `api`, `app`, `admin`, `mail`, `static`, `assets`, `auth`, …).
- Cloudflare side: proxied wildcard DNS `*.camptool.org` plus a Worker route
  `*.camptool.org/*`; Universal SSL covers one wildcard level for free.
- Later, maybe: a camp's own domain (e.g. `camptool.mathcamp.us`) mapped to
  its camp. Not now.

### Host adapters

Selected by package.json `imports` conditions, so each bundle carries only its
own host code (`workerd` condition on Cloudflare, `default` elsewhere):

- `#host/db`: the Drizzle database (bun:sqlite or D1), typed **async** so code
  can't rely on sync results; `atomic([...])` for multi-statement writes
  (transaction on Bun, `batch` on D1).
- `#host/blobs`: put/get/delete/list for uploads (disk or R2).
- `#host/snapshot`: whole-database backup bytes (SQLite file on Bun, SQL dump on
  D1).
- Entry points: `server.ts` (Bun) and `workers/app.ts` (Cloudflare), both thin.

### D1 migrations

- Apply with `wrangler d1 migrations apply` from a generated folder where
  drizzle's `PRAGMA foreign_keys=OFF/ON` become `PRAGMA defer_foreign_keys`.
- **Hazard:** on D1, foreign keys can't be switched off, and deferring them does
  **not** stop `ON DELETE CASCADE`. A drizzle table rebuild (`__new_x`, drop,
  rename) of a table other tables cascade from would delete their rows. Safe
  for the existing migrations on an empty database; dangerous for any future
  one. `db:verify` will refuse such a migration after the D1 baseline, so it
  gets hand-written in a D1-safe form.

## Plan / steps

1. [x] Season rollover: `currentEventYear()` moves on after exodus
   (`f08991d`).
2. [x] Structure packs per camp: `CAMP_THEME` server-wide, `CAMP_THEMES` per
   camp, `camp.structure_packs`, Site admin → Camps switches. Verified over
   HTTP (pyramid add 403 until switched on, then 200) and by screenshot.
3. [x] Discord server per camp: `camp.discord_guild_id`, set under Camp
   settings → Discord server (with a no-permission bot invite link);
   `DISCORD_GUILD_ID` is the fallback. Verified over HTTP and by screenshot.
   No email transport exists yet (`mailEnabled = false`), so nothing to split.
3b. [x] Camp subdomains (`app/lib/camp-host.ts`, `CAMP_SUBDOMAINS=1`): host
   pins the camp, apex camp pages redirect to the subdomain, signed-out →
   apex `/login?next=` (open-redirect safe), non-member → apex `/c/<slug>`,
   cookie on the apex domain, reserved/invalid slugs refused at creation,
   camp switcher jumps hosts, passkeys accept any of our origins (RP ID is the
   apex). Verified over HTTP against a Bun dev server: 11/11.
4. [x] Host adapters (`#host/db`, `#host/blobs` in package.json `imports`):
   `db/host/{bun-sqlite,d1}.ts`, `app/host/blobs-{disk,r2}.server.ts`. `Db` is
   typed async with no `transaction`; `atomic()` for all-or-nothing writes.
   Merges now read first and write one batch; their FK sweep comes from the
   Drizzle schema (test holds it equal to `PRAGMA foreign_key_list`). Backup
   uses `dbSnapshot()` (SQLite file on Bun, SQL dump on D1). Verified on Bun:
   unit tests, e2e merge 16/16, backup 13/13, pictures 17/17, FAQ 34/34,
   prospects 37/38 (9g is stale, logged in `plans/issues.md`), production
   build boots and serves.
5. [x] Cloudflare target: `wrangler.jsonc`, `workers/app.ts`, Vite's
   Cloudflare plugin when `CAMPTOOL_TARGET=cloudflare`, `cf:*` scripts,
   `scripts/d1-migrations.ts` (pragma rewrite + `db:verify` safety check),
   `db/migrations-d1/` overrides. Verified locally under `wrangler dev`: all
   90 migrations apply to a fresh D1; sign-up, camp creation, feature toggles,
   a prospect merge (atomic batch), R2 upload/download and the backup all
   pass (10/10). A D1 backup restores onto the Bun host and boots.
6. [~] Self-host docs: `docs/cloudflare-deploy.md` (walkthrough) and the
   Docker section of `docs/firefly-deploy.md` exist. A "Deploy to Cloudflare"
   button is NOT done: it runs Workers Builds (`npm run build`, then a deploy
   command) in the deployer's account, so it needs the build to detect
   `WORKERS_CI` and a real account to test it on. Do it after step 7.
7. [ ] **Current step.** Deploy to Cameron's Cloudflare account at
   `camptool.org`: **needs his yes for each change**. In order:
   a. Workers Paid plan on his account ($5/mo): his action.
   b. `wrangler login` (or an API token) on this machine: his action.
   c. `vars.PUBLIC_BASE_URL=https://camptool.org`, `CAMP_SUBDOMAINS=1`,
      `CAMP_THEMES` (which packs to bundle) in `wrangler.jsonc`.
   d. `wrangler secret put BETTER_AUTH_SECRET` (+ Discord, optional).
   e. `bun run cf:deploy`: creates D1 `camptool` + R2 `camptool-uploads`.
   f. DNS on camptool.org: apex + proxied wildcard `*`, Worker routes for
      `camptool.org/*` and `*.camptool.org/*`.
   g. Sign up first (becomes super admin), turn off open camp creation if
      wanted, create the friend's camp.

## Findings / gotchas

- Passkeys: `@better-auth/passkey` checks against its `origin` option, or the
  request's own `Origin` when that's null. With subdomains it's null; the RP
  ID (the apex) plus better-auth's trusted-origins wildcard keep it to our
  hosts.
- Vite's dev server rejects unknown `Host` headers; with subdomains on,
  `allowedHosts` adds `.<host>` (Vite's "and subdomains").
- Real browsers may refuse `Domain=localhost` cookies, so trying subdomains
  in a browser locally needs a real name (e.g. a hosts-file domain); curl
  with a `Host` header is fine.

- **D1 caps compound SELECTs** ("too many terms in compound SELECT"):
  migration 0060's 12-way `UNION ALL` failed; `db/migrations-d1/0060…` uses a
  `VALUES` list (exempt) and was checked to produce identical rows.
- **Drizzle 0.45's D1 `batch()` breaks on raw `db.run(sql)` items**
  ("Cannot read properties of undefined (reading 'bind')"). `atomic()` on D1
  renders each statement itself and calls D1's own `batch()`.
- React Router refuses an action whose `Origin` doesn't match the request URL;
  under `wrangler dev`, use `localhost` consistently (not `127.0.0.1`).
- A D1 dump needs a `__drizzle_migrations` record to boot on Bun (Drizzle
  only compares `created_at`); `dbSnapshot()` writes it from `d1_migrations`.
- `--since N` on `scripts/d1-migrations.ts --check` shows 0055 and 0065 would
  have destroyed data on a populated D1 (0065 rebuilt `membership`). They're
  safe only because a new D1 database applies them empty.

- Running several `bun run dev` at once in one checkout races on
  `.react-router/types` (ENOENT in typegen). Start them a few seconds apart.
- e2e scripts open the database directly, so give them the same
  `DATABASE_PATH` as their server; otherwise they read the checkout's `.env`
  database and fail with "no user row".

- D1 rejects `PRAGMA foreign_keys`, and deferral doesn't stop cascades (see
  Design). Sources: Cloudflare D1 foreign-keys docs; brachkow.com note
  (May 2026).

## Progress log

- [x] 2026-11-13: surveyed coupling, costed Cloudflare (Workers Paid $5/mo;
  D1 includes 25B row reads, 50M writes, 5 GB).
- [x] 2026-11-13: steps 1–5 and 3b built, verified and pushed to master
  (`f08991d`..`48181de`). Lint on master was already red before this
  (Biome 2 upgrade leftovers in map/passes/index/auth/e2e); not touched.

## Open questions for the user

1. Where is `camptool.org` registered, and is its DNS on Cloudflare yet?
   (Decides step 7f.)
2. Should the shared site bundle Math Camp's structure pack (`CAMP_THEMES`
   for per-camp use), or start with none?
3. Does Math Camp's own deploy (firefly) take this build? It's safe as-is
   (new columns only; `CAMP_THEME` keeps its packs server-wide), but bumping
   ops `pin.json` is an ops change that needs your yes.

## Things not to do

- Don't touch Cloudflare, DNS, Caddy or either server without Cameron's yes for
  that specific change. Stage it and show it.
- Don't put a second camp on a build whose packs aren't per camp.
- Don't merge or rebase the shared `master` checkout while another thread has
  uncommitted work there.
