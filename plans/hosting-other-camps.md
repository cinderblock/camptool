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
10. **Host on Cameron's `isozilla` Cloudflare account** (Workers Paid is on
    there), at least for now. (Cameron, 2026-11-13.)
11. **Math Camp's structures stay Math Camp's.** The shared site bundles
    `@camptool/mathcamp-theme` in `CAMP_THEMES` and switches it on for Math
    Camp only. (Cameron.)
12. **Math Camp moves onto the shared site**: `camptool.mathcamp.us` →
    `mathcamp.camptool.org`. The old URL redirects automatically; user data
    and logins are imported; a bridge handles passkeys, and users with old
    passkeys are forced to make a new one for the new domain. (Cameron.)
13. **No "Deploy to Cloudflare" button for now.** Hosting our couple of camps
    on one account is enough. (Cameron, 2026-11-13.)

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

### Moving a camp onto the shared site

- `scripts/import-to-d1.ts <backup.tar.gz>`: migrates a copy of the old Bun
  database to this checkout's schema, moves `passkey` rows to
  `legacy_passkey` (with the old RP ID), applies `--packs` and
  `--discord-guild` per camp, writes `data.sql` (clears migration-seeded rows,
  then parents-first INSERTs; forward references deferred to UPDATEs, since
  D1 always enforces foreign keys), and with `--apply` loads it plus every
  upload into R2. Refuses a D1 database that already has users.
- `LEGACY_HOSTS=camptool.mathcamp.us=mathcamp`: the old host's DNS points at
  the Worker. Root middleware (`app/root.tsx` →
  `app/lib/legacy-host.server.ts`) redirects every request there to the same
  page at the new address (sign-in, invites, recovery, `/c/` to the apex). A
  GET carrying a still-valid old session cookie (same `BETTER_AUTH_SECRET`,
  imported `session` table) goes via a one-time hand-off code to apex
  `/handoff`, which sets a new session cookie for the whole domain.
- Passkeys are bound to their RP ID, so they can't move. `legacy_passkey`
  keeps them out of `passkey` (every "has a passkey" check stays honest). The
  old host keeps `/moved` + `/api/legacy-passkey`: a WebAuthn assertion with
  the old RP ID, checked with `@simplewebauthn/server`, then the same hand-off.
  The new login page links there.
- Forced new passkey: the dashboard layout sends anyone with a legacy passkey
  and no current one to `/new-passkey` (no skip; sign-out only) before
  anything else, except while impersonated.

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
7. [x] Moving a camp onto the shared site (Design above): import script,
   old-host redirects with sign-in hand-off, old-passkey bridge, forced new
   passkey, login-page pointer. Verified locally end to end: a Bun site
   standing in for the old one → backup → `import-to-d1.ts --apply local` →
   `wrangler dev` serving both hosts: `e2e/camp-move.ts` 18/18 (twice, and on
   a second fresh import), and in real headless Chrome with a virtual
   authenticator holding the old passkey, `e2e/camp-move-browser.ts` 3/3 (old
   passkey on the old host → signed in at the new address → forced to make a
   new passkey → signed out, the new passkey signs in and lands in the camp).
8. [ ] **Current step.** Deploy to the `isozilla` account and move Math Camp.
   **Each change needs Cameron's yes.** In order:
   a. `wrangler login` on this machine with the isozilla account (his action).
   b. Production config. Proposal: an ops-owned deploy script (ops repo, not
      CampTool's `wrangler.jsonc`, which stays a self-hoster default) that runs
      in the CampTool checkout: `CAMP_THEMES=@camptool/mathcamp-theme bun run
      cf:build`, `wrangler d1 migrations apply DB --remote`, then `wrangler
      deploy --var PUBLIC_BASE_URL:https://camptool.org --var
      CAMP_SUBDOMAINS:1 --var LEGACY_HOSTS:camptool.mathcamp.us=mathcamp`.
   c. Secrets via `wrangler secret put`: `BETTER_AUTH_SECRET` (**the same
      value as firefly's**), `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
      `DISCORD_BOT_TOKEN`, `DEV_API_TOKEN`.
   d. First deploy: creates D1 `camptool` + R2 `camptool-uploads` (empty).
   e. Discord developer portal: add redirect
      `https://camptool.org/api/auth/callback/discord` (his action).
   f. Ops Cloudflare config: `camptool.org` apex + proxied `*` records, Worker
      routes `camptool.org/*` and `*.camptool.org/*`. Smoke-test there.
   g. Cutover (a quiet hour; writes to firefly after the backup are lost):
      backup from firefly's Site admin → `import-to-d1.ts --legacy-rp-id
      camptool.mathcamp.us --packs mathcamp=@camptool/mathcamp-theme
      --discord-guild mathcamp=<firefly's DISCORD_GUILD_ID> --apply remote` →
      ops `mathcamp.yaml`: `camptool.mathcamp.us` from `proxy: firefly` to the
      Worker route.
   h. Later: retire firefly's camptool stack and Caddy site (ops change).
      Keep `LEGACY_HOSTS` for as long as old links and passkeys matter.
   The deploy button (old step 6) is dropped (decision 13).

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

- **Chrome won't use `localhost` as the RP ID for a `*.localhost` page**
  ("The RP ID "localhost" is invalid for this domain"). Local passkey tests
  on subdomains need real-looking names (`camptool.test` via
  `--host-resolver-rules`) plus `--unsafely-treat-insecure-origin-as-secure`,
  which only works in full Chromium (`channel: "chromium"`) with a profile
  directory (`launchPersistentContext`); the headless shell ignores it
  ("WebAuthn is not supported in this browser").
- **A loader sees `<page>.data` on client navigations** (`/_.data` for `/`).
  Redirecting one to another host must name the page (`pageUrl()` in
  `camp-host.ts`); before the fix, signing in with a passkey on the apex
  landed on `mathcamp.<apex>/_.data`. Covered by `e2e/camp-subdomains.ts`.
- A fresh D1 isn't empty: migration 0011 seeds `instance_setting`. The import
  clears every table first ("UNIQUE constraint failed: instance_setting.id").
- Git for Windows' `tar` reads `C:\...` as a remote host ("Cannot connect to
  C: resolve failed"); the import script runs it with relative paths.
- `CAMP_THEMES` and `--packs` take package names (`@camptool/mathcamp-theme`),
  not slugs.

## Progress log

- [x] 2026-11-13: surveyed coupling, costed Cloudflare (Workers Paid $5/mo;
  D1 includes 25B row reads, 50M writes, 5 GB).
- [x] 2026-11-13: steps 1–5 and 3b built, verified and pushed to master
  (`f08991d`..`48181de`). Lint on master was already red before this
  (Biome 2 upgrade leftovers in map/passes/index/auth/e2e); not touched.
- [x] 2026-11-13: step 7 (moving a camp) built and rehearsed locally.
- [ ] Step 8: deploy and Math Camp cutover, waiting on Cameron.

## Open questions for the user

1. Is `camptool.org`'s DNS on the isozilla account yet? (Step 8f.)
2. OK to put the production deploy in the ops repo as a script (step 8b)?
   Recommended: keeps camptool.org's settings out of the open-source repo.
3. Where should `BETTER_AUTH_SECRET` and the Discord secrets come from: read
   from firefly's env (needs a yes to read it), or will Cameron paste them?

## Things not to do

- Don't touch Cloudflare, DNS, Caddy or either server without Cameron's yes for
  that specific change. Stage it and show it.
- Don't put a second camp on a build whose packs aren't per camp.
- Don't merge or rebase the shared `master` checkout while another thread has
  uncommitted work there.
